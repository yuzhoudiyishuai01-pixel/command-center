/**
 * 密钥的读写。
 *
 * 为什么单独一个模块：密钥不该混进主配置（那是可分享的），也不该进 members.json
 * （那是成员定义）。统一放在 secrets.json，并在写回时**保留文件里已有的其它字段**，
 * 避免因为一次写入把手工配置的代理/其它密钥覆盖掉。
 *
 * 写入用「临时文件 + 原子改名」，避免进程被杀时留下半个文件导致密钥全丢。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

import { config } from "./config.mjs";

/** secrets.json 的路径。 */
export function secretsPath() {
  return resolve(config.projectRoot ?? process.cwd(), "secrets.json");
}

/** 读整个文件（读不到就当空对象，不抛错）。 */
export function readSecrets() {
  try {
    return JSON.parse(readFileSync(secretsPath(), "utf8"));
  } catch {
    return {};
  }
}

/** 原子写回整个文件。 */
function writeSecrets(data) {
  const path = secretsPath();
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(temp, JSON.stringify(data, null, 2), "utf8");
  renameSync(temp, path);
}

/**
 * 保存某个 API 成员的密钥。
 *
 * @param {string} memberId
 * @param {string} apiKey
 * @returns {{ok: true}}
 */
export function persistApiKey(memberId, apiKey) {
  const data = readSecrets();
  data.apiKeys ??= {};
  data.apiKeys[memberId] = apiKey;
  writeSecrets(data);
  return { ok: true };
}

/** 删除某成员的密钥（删成员时调用，避免留下孤儿密钥）。 */
export function removeApiKey(memberId) {
  const data = readSecrets();
  if (!data.apiKeys || !Object.hasOwn(data.apiKeys, memberId)) return { ok: true, removed: false };
  delete data.apiKeys[memberId];
  writeSecrets(data);
  return { ok: true, removed: true };
}

/** secrets.json 是否存在（启动自检用）。 */
export function secretsExists() {
  return existsSync(secretsPath());
}
