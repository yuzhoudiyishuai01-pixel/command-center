/**
 * 验证：真实 Claude Code CLI 在「指挥室会用的那组参数」下，是否真的能出网取数。
 *
 * 背景：此前成员报 "requested permissions to use Bash, but you haven't granted it
 * yet"。排查发现用户 ~/.claude/settings.json 的 permissions.ask 里列了
 * `Bash(curl *)` 与 `WebFetch(domain:*)`，它的优先级高于 --permission-mode
 * 与 --allowedTools，于是联网工具全被拦。
 *
 * 本脚本对比三组参数，找出真正能放行的那组。用 Node 收流，避开 PowerShell
 * 重定向在 UTF-8 下的乱码问题。
 *
 * 用法：node scripts/probe-claude-permissions.mjs
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "../server/config.mjs";

const PROJECT = config.projectRoot;
const NATIVE = `${process.env.APPDATA}\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;

const secrets = JSON.parse(readFileSync(resolve(PROJECT, "secrets.json"), "utf8"));
const env = {
  ...process.env,
  ANTHROPIC_BASE_URL: secrets.claudeEnv.ANTHROPIC_BASE_URL,
  ANTHROPIC_AUTH_TOKEN: secrets.claudeEnv.ANTHROPIC_AUTH_TOKEN,
  ANTHROPIC_MODEL: secrets.claudeEnv.ANTHROPIC_MODEL,
  ANTHROPIC_SMALL_FAST_MODEL: secrets.claudeEnv.ANTHROPIC_SMALL_FAST_MODEL,
  // 走国内端点，不要代理
  HTTPS_PROXY: "",
  HTTP_PROXY: "",
  https_proxy: "",
  http_proxy: "",
};

const PROMPT = "用 Bash 执行 curl -sSL https://api.github.com/repos/facebook/react，只报告 stargazers_count 与 default_branch 两个数值。";

const variants = [
  { key: "A-mode-only", label: "A. --permission-mode bypassPermissions", args: ["--permission-mode", "bypassPermissions"] },
  {
    key: "B-allowed-tools",
    label: "B. --permission-mode + --allowedTools",
    args: ["--permission-mode", "bypassPermissions", "--allowedTools", "Bash,WebFetch,WebSearch,Read,Write,Edit,Glob,Grep"],
  },
  { key: "C-dangerous", label: "C. --dangerously-skip-permissions", args: ["--dangerously-skip-permissions"] },
];

function run(variant) {
  return new Promise((resolvePromise) => {
    const child = spawn(NATIVE, ["-p", PROMPT, "--output-format", "json", ...variant.args], {
      cwd: config.workspace,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      err += chunk;
    });

    const timer = setTimeout(() => child.kill(), 300_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      // 输出可能有多行 JSON（警告行 + 结果行），取能解析出 result 的那一行。
      let parsed = null;
      for (const line of out.split("\n")) {
        const text = line.trim();
        if (!text.startsWith("{")) continue;
        try {
          const candidate = JSON.parse(text);
          if (candidate && typeof candidate === "object" && "result" in candidate) parsed = candidate;
        } catch {
          /* 不是完整 JSON 行 */
        }
      }
      resolvePromise({ variant, code, parsed, err });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ variant, code: null, parsed: null, err: error.message });
    });
  });
}

console.log(`\nClaude Code 权限放行验证（端点：${env.ANTHROPIC_BASE_URL}）\n`);

for (const variant of variants) {
  process.stdout.write(`  ${variant.label} … `);
  const result = await run(variant);
  const denials = result.parsed?.permission_denials?.length ?? "?";
  const ok = result.parsed && !result.parsed.is_error && denials === 0;
  console.log(ok ? "✓ 放行" : `✗ 被拦（denials=${denials}）`);
  if (result.parsed?.result) {
    const text = String(result.parsed.result).replace(/\s+/g, " ").slice(0, 160);
    console.log(`      结果: ${text}`);
  }
  if (denials !== 0 && denials !== "?") {
    const names = (result.parsed.permission_denials ?? []).map((d) => d.tool_name).join(", ");
    console.log(`      被拒工具: ${names}`);
  }
}

console.log("");
