/**
 * 跨平台的可执行文件查找。
 *
 * 开源版本要能在 macOS / Linux / Windows 上跑，所以不能像早期那样把
 * `C:\Users\...\dsh.cmd` 写进配置。这里按 PATH + 常见安装位置探测命令，
 * Windows 上补 .cmd/.exe 扩展名（注意 .cmd 不能直接 spawn，见 launcher.mjs）。
 */
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

export const IS_WINDOWS = process.platform === "win32";

/** Windows 上要试的可执行扩展名；其他平台直接用原文件名。 */
const EXEC_EXTENSIONS = IS_WINDOWS ? [".exe", ".cmd", ".bat", ".com", ""] : [""];

/** PATH 里的目录（去空、去重）。 */
export function pathDirs() {
  const raw = process.env.PATH ?? process.env.Path ?? "";
  const seen = new Set();
  const dirs = [];
  for (const item of raw.split(delimiter)) {
    const dir = item.trim().replace(/^"|"$/g, "");
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }
  return dirs;
}

/** npm 全局 bin 目录：用户用 `npm i -g` 装的 CLI 常常不在这里的 PATH 中。 */
export function npmGlobalDirs() {
  const dirs = [];
  if (IS_WINDOWS) {
    if (process.env.APPDATA) dirs.push(join(process.env.APPDATA, "npm"));
    if (process.env.LOCALAPPDATA) dirs.push(join(process.env.LOCALAPPDATA, "npm"));
  } else {
    dirs.push("/usr/local/bin", "/opt/homebrew/bin", join(homedir(), ".npm-global", "bin"));
    if (process.env.NVM_BIN) dirs.push(process.env.NVM_BIN);
  }
  return dirs;
}

function isExecutableFile(path) {
  try {
    if (!statSync(path).isFile()) return false;
    if (!IS_WINDOWS) accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 在 PATH 与常见目录里找一个可执行文件。
 *
 * @param {string|string[]} names 候选文件名（不含扩展名也可以）
 * @param {{extraDirs?: string[]}} [options]
 * @returns {string|null} 绝对路径
 */
export function findExecutable(names, { extraDirs = [] } = {}) {
  const wanted = Array.isArray(names) ? names : [names];
  const dirs = [...pathDirs(), ...npmGlobalDirs(), ...extraDirs];

  for (const name of wanted) {
    if (!name) continue;
    // 显式给了绝对路径：只用它，不再猜。
    if (isAbsolute(name) || /[\\/]/.test(name)) {
      const direct = resolve(name);
      if (isExecutableFile(direct)) return direct;
      continue;
    }
    for (const dir of dirs) {
      for (const ext of EXEC_EXTENSIONS) {
        const candidate = join(dir, name + ext);
        if (isExecutableFile(candidate)) return candidate;
      }
    }
  }
  return null;
}

/** 文件存在且非空（用于 asar 内部路径这类"看得见但 stat 不到"的检查）。 */
export function nonEmptyPathString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function existsOrAsar(path) {
  return nonEmptyPathString(path) && (existsSync(path) || path.includes(".asar"));
}
