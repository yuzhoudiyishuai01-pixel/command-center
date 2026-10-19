#!/usr/bin/env node
/**
 * 在 DSH 的 app.asar 里做全文搜索。
 *
 * 用途：DSH 的界面文案（比如权限模式叫什么、入口在哪）打包在 asar 里，
 * 这里直接按关键词扫描，把命中的文件与上下文打印出来。
 *
 * 用法：node scripts/scan-asar.mjs <关键词正则> [文件路径过滤正则]
 */
import { openSync, readSync, closeSync } from "node:fs";

const ARCHIVE = "C:\\Users\\sexyboy\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar";
const pattern = process.argv[2];
const pathFilter = process.argv[3];

if (!pattern) {
  console.error("用法: node scripts/scan-asar.mjs <关键词正则> [路径过滤正则]");
  process.exit(2);
}

const needle = new RegExp(pattern, "i");
const pathNeedle = pathFilter ? new RegExp(pathFilter, "i") : null;

const fd = openSync(ARCHIVE, "r");
const head = Buffer.alloc(16);
readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(12);
const headerBuf = Buffer.alloc(headerSize);
readSync(fd, headerBuf, 0, headerSize, 16);
const header = JSON.parse(headerBuf.toString("utf8"));
const contentBase = 16 + headerSize;

const entries = [];
(function walk(node, prefix) {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const path = `${prefix}/${name}`;
    if (value.files) walk(value, path);
    else entries.push({ path, offset: value.offset, size: value.size, unpacked: value.unpacked });
  }
})(header, "");

console.log(`\n扫描 ${entries.length} 个文件，关键词 /${pattern}/${pathFilter ? ` 路径过滤 /${pathFilter}/` : ""}\n`);

let hits = 0;
for (const entry of entries) {
  if (entry.unpacked) continue;
  if (entry.size > 1_500_000) continue;
  if (pathNeedle && !pathNeedle.test(entry.path)) continue;
  if (!/\.(js|mjs|cjs|json|css|html)$/i.test(entry.path)) continue;

  const buf = Buffer.alloc(entry.size);
  readSync(fd, buf, 0, entry.size, contentBase + Number(entry.offset));
  const text = buf.toString("utf8");
  if (!needle.test(text)) continue;

  hits += 1;
  console.log(`── ${entry.path}  (${entry.size} bytes)`);
  const lines = text.split("\n");
  let shown = 0;
  for (let i = 0; i < lines.length && shown < 5; i += 1) {
    if (!needle.test(lines[i])) continue;
    shown += 1;
    const snippet = lines[i].trim().slice(0, 240);
    console.log(`   ${i + 1}: ${snippet}`);
  }
  if (shown === 0) console.log("   （命中但不在单行内，可能是多行文本）");
  console.log("");
}

closeSync(fd);
console.log(`共命中 ${hits} 个文件\n`);
