#!/usr/bin/env node
/**
 * 打一个可分发的发布包。
 *
 * 产物：dist/command-center-<version>.zip（Windows）或 .tar.gz（其它平台）。
 * 只打包运行所需文件——`data/`、`runtime/`、`secrets.json`、`.git` 一律不进包，
 * 用户解压后是**干净的空工作台**：没有成员、没有对话、没有密钥。
 *
 * 为什么自己写而不是 `npm pack`：npm 的 tar 包对普通用户不友好（文件名带
 * scope、Windows 双击不能解压）；一个普通 zip 更适合"下载 → 解压 → 双击"。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const NAME = `${pkg.name}-v${pkg.version}`;
const DIST = join(ROOT, "dist");
const STAGE = join(DIST, NAME);

const INCLUDE = [
  "bin",
  "server",
  "public",
  "scripts",
  "seeds",
  "docs",
  "README.md",
  "README.zh-CN.md",
  "LICENSE",
  "cc.config.example.json",
  "package.json",
  "启动指挥室.cmd",
  "Login-Claude.ps1",
  "Login-Codex.ps1",
  "Test-ClaudeCodeEndpoint.ps1",
];

/** 打包时永远排除的路径（运行期数据、密钥、缓存、测试产物）。 */
const EXCLUDE_DIRS = new Set(["data", "runtime", "node_modules", ".git", ".shots", "dist", ".github"]);

const START_HERE = `指挥室 / Command Center v${pkg.version}
${"-".repeat(52)}

一、需要什么
  Node.js 20 或更高版本：https://nodejs.org/

二、怎么启动
  1) 解压到任意目录（路径不要包含特殊字符）
  2) 打开终端，进入这个目录，执行：

       npm start

     浏览器会自动打开一个带 token 的网址。
     Windows 用户也可以直接双击  启动指挥室.cmd

三、第一次打开会看到什么
  名册是空的 —— 这是有意的。你需要自己添加成员：
    · API 成员：填 OpenAI / Anthropic 兼容的 baseUrl、模型名、API Key
    · CLI 成员：本机已安装并登录的 dsh / claude / codex（能真正读写文件、执行命令）
  添加后成员会自动加入「指挥部」，并拥有自己的私人频道。

四、安全提醒
  · 服务默认只监听 127.0.0.1，并带共享 token 鉴权（data/.token）
  · CLI 成员以你的系统权限执行命令，任务要想清楚再发
  · 不要把 data/ 或 secrets.json 提交到任何仓库

五、文档
  README.md            功能、配置、架构、排错（英文）
  README.zh-CN.md      中文快速开始
  docs/OPERATIONS.zh-CN.md  运维细节与实测记录
  cc.config.example.json    所有配置项的注释示例
`;

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

rmSync(DIST, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });

let copied = 0;
for (const entry of INCLUDE) {
  const from = join(ROOT, entry);
  if (!existsSync(from)) {
    console.warn(`  ! 跳过不存在的文件：${entry}`);
    continue;
  }
  const to = join(STAGE, entry);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      const parts = src.replace(ROOT, "").split(/[\\/]/).filter(Boolean);
      return !parts.some((part) => EXCLUDE_DIRS.has(part));
    },
  });
  copied += 1;
}

writeFileSync(join(STAGE, "START-HERE.txt"), START_HERE, "utf8");

// 包内自检：绝不能带上运行期数据或密钥。
for (const forbidden of ["data", "runtime", "secrets.json", ".git"]) {
  if (existsSync(join(STAGE, forbidden))) fail(`发布包里出现了不该有的路径：${forbidden}`);
}

const version = pkg.version;
const isWindows = process.platform === "win32";
const archive = join(DIST, isWindows ? `${NAME}.zip` : `${NAME}.tar.gz`);

// 沙箱环境禁止管道 stdio，这里统一用 stdio: "ignore"。
const result = isWindows
  ? spawnSync(
      "powershell",
      ["-NoProfile", "-Command", `Compress-Archive -Path '${STAGE}\\*' -DestinationPath '${archive}' -Force`],
      { stdio: "ignore" },
    )
  : spawnSync("tar", ["-czf", archive, "-C", DIST, NAME], { stdio: "ignore" });

console.log(`\n  打包完成：${copied} 个条目`);
console.log(`  目录：${STAGE}`);
if (result.status === 0 && existsSync(archive)) {
  console.log(`  压缩包：${archive}`);
  console.log("\n  提示：把压缩包上传到 GitHub Releases 即可；仓库本身用 git push。\n");
} else {
  console.log(`\n  ! 自动压缩失败（缺少 ${isWindows ? "PowerShell" : "tar"}），请手动压缩上面的目录。\n`);
}
