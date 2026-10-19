#!/usr/bin/env node
/**
 * 指挥室启动入口。
 *
 * 启动过程：自检 → 生成成员 profile（仅 DSH）→ 拉起 HTTP 服务 → 打印带 token 的网址。
 * 直接运行：node server/index.mjs
 */
import { mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { config, dshAvailable, missingPrerequisites, startupWarnings } from "./config.mjs";
import { installServiceLog } from "./logging.mjs";
import { ensureProfiles, profileSignature, syncCredentials } from "./profiles.mjs";
import { launcherProblems, resolveLauncher } from "./launcher.mjs";
import { agents } from "./agents.mjs";
import { startServer } from "./http.mjs";
import { getState, resetSessionsIfProfileChanged, runHousekeeping, sweepInterruptedTurns } from "./store.mjs";
import { startProxyWatch, proxyStatus } from "./backends.mjs";
import { ensureToken, tokenPath, tokenizedUrl } from "./auth.mjs";
import { logEvent } from "./metrics.mjs";

async function main() {
  // 第一件事：把控制台输出接管进 data/server.log。隐藏启动时服务没有控制台，
  // 没有这一步，启动横幅、退出码、崩溃原因全部无处可查（见 logging.mjs 注释）。
  installServiceLog(config.dataDir);

  const missing = [...missingPrerequisites(), ...launcherProblems()];
  if (missing.length > 0) {
    console.error("\n无法启动指挥室：");
    for (const line of missing) console.error(`  · ${line}`);
    console.error("\n请修正 cc.config.json 后重试。\n");
    process.exit(1);
  }

  mkdirSync(config.dataDir, { recursive: true });

  const dshOk = dshAvailable();
  if (dshOk) {
    mkdirSync(config.dshHome, { recursive: true });
    ensureProfiles();
  }

  getState(); // 触发存档加载/迁移，尽早暴露损坏问题

  // 上次进程若被强杀，会有成员回话永久停在 working，界面就会一直显示
  // "作业中"，看起来像半个指挥室死了。启动时清扫一次即可自愈。
  const swept = sweepInterruptedTurns();

  // 人格或运行环境事实变了，就让对应成员重新开始会话——system prompt 一旦
  // 注入历史就固化了，不清会话的话它会继续按旧提示作答。
  const resetAgents = [];
  for (const agent of agents()) {
    if (resetSessionsIfProfileChanged(agent.id, profileSignature(agent))) resetAgents.push(agent.name);
  }

  let synced = [];
  let missingCredentials = [];
  if (dshOk) {
    // 登录态必须跟随到我们的 dshHome，否则所有 DSH 成员都无法访问模型。
    ({ synced, missing: missingCredentials } = syncCredentials());
  }
  const hasCredentials = existsSync(resolve(config.dshHome, ".credentials.yaml"));

  // 代理存活监控：代理关着的时候不注入，避免成员连死端口导致联网全挂。
  startProxyWatch();
  // 给它一点时间完成首次探测，让启动横幅显示真实状态。
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 600));

  // 体量维护：清孤儿 tmp、轮转日志、把超期轮次归档后降级为摘要。
  // 启动时强制跑一次，让长期使用后的膨胀在上线前就被削掉。
  const housekeeping = await runHousekeeping({ force: true });

  const server = await startServer();

  // 运行期也定期维护：一次会话可能连续跑几小时，只在启动时整理不够。
  const housekeepingTimer = setInterval(() => {
    void runHousekeeping().then((report) => {
      if (report?.error) console.log(`  ▸ 体量维护告警  ${report.error}`);
    });
  }, 5 * 60 * 1000);
  housekeepingTimer.unref();

  const plainUrl = `http://${config.host}:${config.port}`;
  const url = config.auth ? tokenizedUrl(config.host, config.port) : plainUrl;
  const launcher = resolveLauncher();
  const warnings = startupWarnings();

  console.log("");
  console.log("  指挥室已就绪");
  console.log(`  ▸ 界面      ${url}`);
  if (config.auth) console.log(`  ▸ 访问令牌  ${tokenPath()}（首次打开上面的网址即可，之后浏览器会记住）`);
  console.log(`  ▸ 工作区    ${config.workspace}`);
  console.log(`  ▸ 权限模式  ${config.permissionMode}`);
  console.log(`  ▸ 名册      ${agents().length > 0 ? agents().map((a) => a.name).join(" · ") : "（空）—— 在界面里添加成员"}`);
  if (dshOk) {
    console.log(`  ▸ 凭据      ${synced.length > 0 ? `已同步 ${synced.join("、")}` : "使用已有登录态"}`);
    console.log(`  ▸ 成员启动  ${launcher.how}`);
    // 代理状态如实上报：关着就意味着成员访问维基这类站点会失败。
    console.log(
      `  ▸ 代理      ${
        proxyStatus.target
          ? proxyStatus.alive
            ? `可用（${proxyStatus.target}）`
            : `不可用（${proxyStatus.target}，成员将直连）`
          : "未配置"
      }`,
    );
  }
  if (swept > 0) console.log(`  ▸ 已清扫    ${swept} 条上次中断的作业（状态改为"已中断"）`);

  // 体量维护结果如实上报：让"臃肿"的变化看得见。
  if (housekeeping) {
    const pruned = housekeeping.prunedTemps.length;
    const compressed = housekeeping.rooms;
    if (pruned > 0) console.log(`  ▸ 残留清理  ${pruned} 个孤儿临时文件`);
    if (compressed.length > 0) {
      const saved = compressed.reduce((sum, item) => sum + Math.max(0, item.charsBefore - item.charsAfter), 0);
      console.log(
        `  ▸ 体量维护  ${compressed.length} 个房间已压缩，释放约 ${(saved / 1024).toFixed(0)} KB` +
          `${compressed.some((item) => item.stubbed > 0) ? "（超期轮次已归档到 data/archive）" : ""}`,
      );
    }
    if (housekeeping.error) console.log(`  ▸ 维护告警  ${housekeeping.error}`);
  }
  if (resetAgents.length > 0) {
    console.log(`  ▸ 配置变更  ${resetAgents.join("、")} 的会话已重置（人格/环境事实已更新）`);
  }
  if (dshOk && !hasCredentials) {
    console.log("");
    console.log("  ⚠ 未找到 DeepSeek 登录凭据，DSH 成员将无法访问模型。");
    console.log("    请先打开 DeepSeek Harness 桌面版完成登录，或把凭据文件放到：");
    console.log(`      ${resolve(config.dshHome, ".credentials.yaml")}`);
    if (missingCredentials.length > 0) console.log(`    （缺失项：${missingCredentials.join("、")}）`);
  }
  for (const warning of warnings) console.log(`  ⚠ ${warning}`);
  console.log("");
  console.log("  在浏览器打开上面的界面即可下达指令。按 Ctrl+C 停止。");
  console.log("");

  ensureToken();
  logEvent("server_start", { host: config.host, port: config.port, agents: agents().length, dsh: dshOk });

  const close = () => server.close(() => process.exit(0));
  process.on("SIGINT", close);
}

main().catch((error) => {
  console.error("指挥室启动失败：", error);
  process.exitCode = 1;
});
