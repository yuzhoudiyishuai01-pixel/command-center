/**
 * 解析"如何启动一个成员进程"。
 *
 * 这里集中处理两个 Windows 特有的现实问题，都是实测得出的结论：
 *
 * 1) `dsh` 是 `dsh.cmd` 批处理外壳。Node 从 v20 起（CVE-2024-27980 的修复）拒绝
 *    直接 spawn `.cmd`/`.bat`（报 EINVAL）；而 `shell: true` 会把参数拼成命令行
 *    字符串，让带空格与换行的任务文本失去保护。因此改为复刻 `.cmd` 的行为：
 *    用 ELECTRON_RUN_AS_NODE=1 把 Electron 启动器当作 Node，去运行 CLI 脚本。
 *    注意必须同时给出 CLI 脚本路径——只设 ELECTRON_RUN_AS_NODE 而不给脚本，
 *    Node 会把 profile 名当成模块路径去找（MODULE_NOT_FOUND）。
 *
 * 2) 当前沙箱禁止子进程使用管道 stdio（连 spawn node 自身都会 EPERM），但允许
 *    文件描述符重定向。因此调用方必须用文件收集输出，见 runner.mjs 的 openLogFiles。
 *
 * dsh.cmd 的实际内容形如：
 *   set "ELECTRON_RUN_AS_NODE=1"
 *   "%~dp0..\..\..\..\DeepSeek Harness.exe" --expose-internals "%~dp0..\..\..\app.asar\...\cli.js" %*
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { config } from "./config.mjs";

const usable = (path) => typeof path === "string" && path.length > 0 && existsSync(path);

/**
 * asar 归档内部的路径不能用 existsSync 判断。
 *
 * CLI 脚本位于 `resources/app.asar/...` 里——对文件系统 API 而言它"不存在"，
 * 但 Electron 自己能把 asar 当目录读，所以这条路径对启动器是完全有效的。
 * 之前用 existsSync 预检它，导致解析结果被判无效并退回批处理外壳。
 * 因此这里只要求它是个非空字符串。
 */
const asarPathOk = (path) => typeof path === "string" && path.trim().length > 0;

/**
 * @returns {{command: string, prefixArgs: string[], env: Record<string,string>, how: string, available: boolean}}
 */
export function resolveLauncher() {
  const cli = config.dshCli;

  // 0) 没有 DSH CLI：不是错误。API 成员照样能用，只是 DSH 成员不可用。
  if (!cli) {
    return {
      command: "",
      prefixArgs: [],
      env: {},
      how: "未配置（DSH 成员不可用）",
      available: false,
    };
  }

  // 1) 完全显式配置：启动器 + CLI 脚本都给了。
  if (usable(config.dshExecutable)) {
    const prefixArgs = asarPathOk(config.dshCliJs) ? [config.dshCliJs] : [];
    return {
      command: config.dshExecutable,
      prefixArgs,
      env: prefixArgs.length > 0 ? { ELECTRON_RUN_AS_NODE: "1" } : {},
      how: "cc.config.json 显式指定",
      available: true,
    };
  }

  // 2) 从 .cmd 内容里解析出启动器与 CLI 脚本这两条路径。
  //    这正是批处理外壳自己执行的那两条路径，因此优先级高于任何猜测。
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(cli)) {
    try {
      const text = readFileSync(cli, "latin1");
      const exeMatch = text.match(/%~dp0([^"\r\n]*?\.exe)/i);
      const jsMatch = text.match(/%~dp0([^"\r\n]*?\.(?:js|cjs|mjs))/i);
      const exe = exeMatch ? resolve(dirname(cli), exeMatch[1]) : null;
      // CLI 脚本在 asar 内，故只做非空校验。
      const js = jsMatch ? resolve(dirname(cli), jsMatch[1]) : null;
      if (usable(exe) && asarPathOk(js)) {
        return {
          command: exe,
          prefixArgs: [js],
          env: { ELECTRON_RUN_AS_NODE: "1" },
          how: "从 dsh.cmd 内容解析",
          available: true,
        };
      }
    } catch {
      /* 读不到就退回逐级查找 */
    }

    // 3) 兜底：向上逐级找启动器，再按标准布局拼出 CLI 脚本路径。
    let dir = resolve(dirname(cli));
    for (let depth = 0; depth < 6; depth += 1) {
      const exe = join(dir, "DeepSeek Harness.exe");
      if (existsSync(exe)) {
        const cliJs = join(
          dir,
          "resources",
          "app.asar",
          "dsh",
          "node_modules",
          "@deepseek-ai",
          "dsh-desktop-host",
          "lib",
          "cli.js",
        );
        return {
          command: exe,
          prefixArgs: [cliJs],
          env: { ELECTRON_RUN_AS_NODE: "1" },
          how: `从 dshCli 向上 ${depth} 级定位启动器`,
          available: true,
        };
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  // 4) 非 Windows，或推导失败：直接按原路径执行。
  const directPath = /\.(cmd|bat)$/i.test(cli) && process.platform === "win32" ? null : cli;
  if (directPath) {
    return { command: directPath, prefixArgs: [], env: {}, how: "原路径直接执行", available: true };
  }
  return {
    command: "",
    prefixArgs: [],
    env: {},
    how: "无法解析 dsh 启动器（Windows 上 .cmd 不能直接执行）",
    available: false,
  };
}

/** 启动前自检：把不可用的启动配置变成清晰的报错，而不是运行时的 EINVAL/EPERM。 */
export function launcherProblems() {
  const problems = [];
  // 没有配置 DSH CLI 不算问题——用户可能只用 API 成员。
  if (!config.dshCli) return problems;

  const launcher = resolveLauncher();
  if (!launcher.available) {
    problems.push(
      [
        `无法启动 DSH 成员进程：${launcher.how}`,
        `  dshCli = ${config.dshCli}`,
        "  请检查 dshCli 是否指向 DeepSeek Harness 自带的 dsh 命令行入口，",
        "  或在 cc.config.json 里显式填写 dshExecutable 与 dshCliJs。",
      ].join("\n"),
    );
    return problems;
  }
  if (!existsSync(launcher.command)) {
    problems.push(`成员进程的启动器不存在：${launcher.command}`);
    return problems;
  }
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(launcher.command)) {
    problems.push(
      [
        `成员进程启动器仍指向批处理外壳，无法被直接执行：${launcher.command}`,
        "  请检查 dshCli 是否指向 DeepSeek Harness 自带的 dsh.cmd，",
        "  或在 cc.config.json 里显式填写 dshExecutable 与 dshCliJs。",
      ].join("\n"),
    );
  }
  // 注意：prefixArgs 里的 CLI 脚本位于 app.asar 归档内，文件系统看不到它，
  // 因此这里刻意不做存在性校验（详见 asarPathOk 的说明）。
  return problems;
}

