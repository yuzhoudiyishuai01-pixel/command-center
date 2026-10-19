#!/usr/bin/env node
/**
 * 语法自检：把 server/、public/、scripts/、bin/ 下所有 .mjs/.js 过一遍 `node --check`。
 *
 * 为什么不用 ESLint：项目坚持零依赖，克隆下来就能跑。语法检查覆盖了最容易
 * 被引入的那类低级错误（括号、私有字段、可选链），足够作为 CI 的第一道闸。
 */
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DIRS = ["server", "public", "scripts", "bin"];
const SKIP = new Set(["node_modules", "runtime", "data", ".git", ".shots"]);

function walk(dir, files = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const name of entries) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) walk(full, files);
    else if (/\.(mjs|cjs|js)$/.test(name)) files.push(full);
  }
  return files;
}

const files = DIRS.flatMap((dir) => walk(resolve(ROOT, dir)));
let failures = 0;

for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (error) {
    failures += 1;
    console.error(`\n✗ ${file.replace(ROOT, ".")}`);
    console.error(String(error.stderr ?? error.message).trim());
  }
}

console.log(`语法检查：${files.length - failures}/${files.length} 通过`);
process.exit(failures === 0 ? 0 : 1);
