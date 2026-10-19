#!/usr/bin/env node
/**
 * 队列测试：串行、并发上限、超时、排队中取消。
 *
 * 这一层没有模型参与，纯逻辑，所以能快速断言"全员开工不会把机器拖死"。
 */
import { TurnQueue, AbortedError, TimeoutError } from "../server/queue.mjs";

let passed = 0;
let failed = 0;
function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${detail ? `（${detail}）` : ""}`);
  }
}

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

console.log("[1] 同一成员串行");
{
  const queue = new TurnQueue({ maxConcurrent: 8, perMemberSerial: true });
  const order = [];
  let active = 0;
  let peak = 0;
  await Promise.all(
    [1, 2, 3].map((index) =>
      queue.schedule({
        key: "room:a",
        task: async () => {
          active += 1;
          peak = Math.max(peak, active);
          order.push(`start-${index}`);
          await sleep(30);
          order.push(`end-${index}`);
          active -= 1;
        },
      }),
    ),
  );
  check("同一成员不会被并发执行", peak === 1, `peak=${peak}`);
  check(
    "执行顺序严格串行",
    JSON.stringify(order) === JSON.stringify(["start-1", "end-1", "start-2", "end-2", "start-3", "end-3"]),
    order.join(","),
  );
}

console.log("[2] 全局并发上限");
{
  const queue = new TurnQueue({ maxConcurrent: 2, perMemberSerial: false });
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      queue.schedule({
        key: `room:${index}`,
        task: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await sleep(20);
          active -= 1;
        },
      }),
    ),
  );
  check("并发不超过上限", peak === 2, `peak=${peak}`);
  check("全部任务都执行完", queue.snapshot().startedTotal === 6);
}

console.log("[3] 超时");
{
  const queue = new TurnQueue({ maxConcurrent: 2 });
  let error = null;
  try {
    await queue.schedule({
      key: "room:slow",
      timeoutMs: 60,
      task: async (signal) => {
        await new Promise((resolvePromise) => {
          const timer = setTimeout(resolvePromise, 5000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolvePromise();
          });
        });
      },
    });
  } catch (caught) {
    error = caught;
  }
  check("超时抛出 TimeoutError", error instanceof TimeoutError, error?.name ?? "无错误");
  check("超时后并发位被释放", queue.snapshot().active === 0);
}

console.log("[4] 排队中取消");
{
  const queue = new TurnQueue({ maxConcurrent: 1 });
  const blocker = queue.schedule({ key: "room:blocker", task: () => sleep(120) });
  const controller = new AbortController();
  const queued = queue.schedule({
    key: "room:queued",
    signal: controller.signal,
    task: () => sleep(10),
  });
  await sleep(20);
  check("任务确实在排队", queue.snapshot().pending >= 1, `pending=${queue.snapshot().pending}`);
  controller.abort();
  let waived = null;
  try {
    await queued;
  } catch (caught) {
    waived = caught;
  }
  await blocker;
  check("排队中被取消会抛 AbortedError", waived instanceof AbortedError, waived?.name ?? "未抛出");
  check("取消的队列位不泄漏", queue.snapshot().active === 0);
}

console.log("[5] 任务失败不阻塞后续");
{
  const queue = new TurnQueue({ maxConcurrent: 1 });
  await queue.schedule({
    key: "room:fail",
    task: async () => {
      throw new Error("boom");
    },
  }).catch(() => {});
  const result = await queue.schedule({ key: "room:fail", task: async () => "ok" });
  check("失败后的下一轮仍能执行", result === "ok");
}

console.log(`\n${failed === 0 ? "全部通过" : "有失败"}：${passed} 项通过，${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
