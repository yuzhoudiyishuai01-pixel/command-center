/**
 * 观测性：结构化事件日志 + 运行时统计。
 *
 * 早期版本只有 data/server.log 一段文本，出问题只能翻聊天记录。开源之后
 * 别人报 bug 时，你需要能回答"哪一轮、哪个成员、多久、花了多少 token、失败
 * 原因是什么"。所以这里做两件事：
 *
 *   1. 每轮作业写一行 JSONL 到 data/logs/events-YYYY-MM-DD.jsonl（按天滚动，
 *      保留 14 天）。机器可读，直接 grep/jq 就能复盘。
 *   2. 进程内累计计数，通过 GET /api/stats 暴露给界面/脚本。
 *
 * 不引入任何依赖：JSONL 比数据库更适合这个体量，而且用户能直接看。
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "./config.mjs";

const LOG_DIR = resolve(config.dataDir, "logs");
const KEEP_DAYS = 14;
const startedAt = Date.now();

/** 进程内统计。结构对 /api/stats 友好，别再嵌套太深。 */
const counters = {
  commands: 0,
  turns: { total: 0, done: 0, failed: 0, aborted: 0, timeout: 0 },
  tokens: { input: 0, output: 0, cacheRead: 0, total: 0 },
  byAgent: new Map(), // agentId -> { name, turns, failures, totalMs, maxMs, tokens }
  byDay: new Map(), // YYYY-MM-DD -> { turns, failures, tokens }
  lastTurn: null,
  errors: 0,
};

let logDirReady = false;
let lastPruned = 0;

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function ensureLogDir() {
  if (logDirReady) return;
  mkdirSync(LOG_DIR, { recursive: true });
  logDirReady = true;
}

/**
 * 写一条结构化事件。失败绝不影响主流程（磁盘满 / 权限问题不该让作业挂掉）。
 *
 * @param {string} kind 事件类型，例如 turn_start / turn_end / command / server
 * @param {object} [data]
 */
export function logEvent(kind, data = {}) {
  try {
    ensureLogDir();
    const line = JSON.stringify({ at: new Date().toISOString(), kind, ...data });
    appendFileSync(resolve(LOG_DIR, `events-${dayKey()}.jsonl`), `${line}\n`, "utf8");
  } catch {
    /* 观测失败不阻断业务 */
  }
}

function agentStats(agentId, name) {
  let entry = counters.byAgent.get(agentId);
  if (!entry) {
    entry = { name: name ?? agentId, turns: 0, failures: 0, totalMs: 0, maxMs: 0, tokens: 0 };
    counters.byAgent.set(agentId, entry);
  }
  if (name) entry.name = name;
  return entry;
}

function dayStats() {
  const key = dayKey();
  let entry = counters.byDay.get(key);
  if (!entry) {
    entry = { turns: 0, failures: 0, tokens: 0 };
    counters.byDay.set(key, entry);
  }
  return entry;
}

export function recordCommand({ roomId, text, targets }) {
  counters.commands += 1;
  logEvent("command", {
    roomId,
    chars: typeof text === "string" ? text.length : 0,
    targets,
  });
}

/**
 * 记录一轮作业结束。
 *
 * @param {{roomId: string, agentId: string, agentName?: string, outcome: string,
 *          durationMs?: number, usage?: object|null, error?: string|null}} info
 */
export function recordTurn(info) {
  const { roomId, agentId, agentName, outcome, durationMs = 0, usage = null, error = null } = info;

  counters.turns.total += 1;
  const bucket = counters.turns;
  if (outcome in bucket && outcome !== "total") bucket[outcome] += 1;
  else if (outcome === "error" || outcome === "failed") bucket.failed += 1;
  if (error) counters.errors += 1;

  const agent = agentStats(agentId, agentName);
  agent.turns += 1;
  agent.totalMs += durationMs;
  agent.maxMs = Math.max(agent.maxMs, durationMs);
  if (outcome === "failed" || outcome === "error" || outcome === "timeout") agent.failures += 1;

  const day = dayStats();
  day.turns += 1;
  if (outcome === "failed" || outcome === "error" || outcome === "timeout") day.failures += 1;

  if (usage) {
    const input = usage.inputTokens ?? 0;
    const output = usage.outputTokens ?? 0;
    const cacheRead = usage.cacheReadTokens ?? 0;
    const total = usage.totalTokens ?? input + output;
    counters.tokens.input += input;
    counters.tokens.output += output;
    counters.tokens.cacheRead += cacheRead;
    counters.tokens.total += total;
    agent.tokens += total;
    day.tokens += total;
  }

  counters.lastTurn = {
    roomId,
    agentId,
    agentName: agentName ?? agentId,
    outcome,
    durationMs,
    at: new Date().toISOString(),
  };

  logEvent("turn_end", {
    roomId,
    agentId,
    agentName: agentName ?? agentId,
    outcome,
    durationMs,
    tokens: usage
      ? { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0, total: usage.totalTokens ?? 0 }
      : null,
    error: error ? String(error).slice(0, 500) : null,
  });

  pruneLogs();
}

/** 日志按天滚动，保留 14 天；每 6 小时最多扫一次目录。 */
export function pruneLogs() {
  const now = Date.now();
  if (now - lastPruned < 6 * 60 * 60 * 1000) return;
  lastPruned = now;
  try {
    if (!existsSync(LOG_DIR)) return;
    for (const name of readdirSync(LOG_DIR)) {
      if (!name.endsWith(".jsonl")) continue;
      const path = resolve(LOG_DIR, name);
      const ageDays = (now - statSync(path).mtimeMs) / 86_400_000;
      if (ageDays > KEEP_DAYS) rmSync(path, { force: true });
    }
  } catch {
    /* 清理失败不影响主流程 */
  }
}

/**
 * 返回可序列化的统计快照。
 *
 * @param {{queue?: object, running?: string[]}} [extra]
 */
export function statsSnapshot(extra = {}) {
  const agents = [...counters.byAgent.entries()].map(([id, entry]) => ({
    id,
    name: entry.name,
    turns: entry.turns,
    failures: entry.failures,
    avgMs: entry.turns > 0 ? Math.round(entry.totalMs / entry.turns) : 0,
    maxMs: entry.maxMs,
    tokens: entry.tokens,
  }));
  agents.sort((a, b) => b.turns - a.turns);
  return {
    uptimeMs: Date.now() - startedAt,
    startedAt: new Date(startedAt).toISOString(),
    commands: counters.commands,
    turns: { ...counters.turns },
    tokens: { ...counters.tokens },
    errors: counters.errors,
    lastTurn: counters.lastTurn,
    agents,
    byDay: Object.fromEntries(counters.byDay),
    ...extra,
  };
}

/** 只给测试/重启用。 */
export function resetStats() {
  counters.commands = 0;
  counters.turns = { total: 0, done: 0, failed: 0, aborted: 0, timeout: 0 };
  counters.tokens = { input: 0, output: 0, cacheRead: 0, total: 0 };
  counters.byAgent.clear();
  counters.byDay.clear();
  counters.lastTurn = null;
  counters.errors = 0;
}
