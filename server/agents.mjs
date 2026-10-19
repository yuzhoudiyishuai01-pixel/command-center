/**
 * 成员的系统提示构建 + 成员查询的统一入口。
 *
 * 成员数据本身已经搬到 `members.mjs`（可持久化、可增删）；这里保留的是
 * **提示词构建**与几个便捷查询，并把旧名字重新导出，避免调用方大改。
 *
 * 兼容说明：以前 `AGENTS` 是一个写死的常量数组，现在它是"当前全部成员"的
 * 快照式查询。新增/删除成员后，`allMembers()` 立刻反映最新状态。
 */
import { allMembers, memberById } from "./members.mjs";

/** 允许的工具分组标签，用于界面徽标。 */
export const CAPABILITY_LABELS = {
  files: "读写文件",
  shell: "执行命令",
  web: "联网检索",
};

/** 当前全部成员（内置 + 自定义）。 */
export function agents() {
  return allMembers();
}

/** 按 id 取成员。 */
export function agentById(id) {
  return memberById(id);
}

/** 该成员的 DSH profile 名称。 */
export function profileNameFor(agentId) {
  return `cc-${agentId}`;
}

const COMMAND_CENTER_CONTEXT = `你是一个多智能体指挥室中的一名成员。人类指挥官在同一间指挥室里同时指挥多位 AI 成员：你可以看到他们，他们也能看到你。

协作纪律：
- 指挥官用中文交流时，你也用中文回复。
- 只做指挥官真正要你做的事，不要越界去替其他成员完成他们的部分。
- 任务真正完成时，明确汇报结果；没完成时，不要假装完成。
- 你的工作目录是指挥部指定的工作区，产出请落到真实文件上，而不是只在对话里描述。
- 你拥有真实工具权限。需要查证或落地时就用工具，不要凭空猜测。`;

export { COMMAND_CENTER_CONTEXT };

/**
 * 注入"署名纪律"。
 *
 * 为什么需要：指挥室里多位成员共用一个工作区，产出若无主名，就无法区分
 * "谁写的、哪一轮写的"——曾因此发生过归属误判与两次定向追查。
 * 规范全文见工作区 `AGENT-CONVENTIONS.md`（DeepSeek 起草，v1）。
 */
export function signatureDiscipline(agent) {
  const id = agent.id;
  return [
    "## 署名纪律（指挥室规范 AGENT-CONVENTIONS.md v1，强制）",
    "",
    "你的一切落盘痕迹必须自带标识，避免与他人产出冲突：",
    `- **文件名带你的成员标识**：\`<用途>-${id}[-轮次][-HHMM].<ext>\`；禁止 \`readiness.md\`、\`notes.md\`、\`test.txt\` 这类无主名。`,
    `- **每份产出必带文件头署名块**：\`author: ${id}\` / \`turn: <本轮的 turnId>\` / \`created: <时间>\` / \`scope: 本文件由 ${agent.name} 维护；他人需要修改请追加，勿覆写\`。`,
    `- **行动痕迹用只追加台账** \`trace-${id}.tsv\`，每行都带时间与你的标识。`,
    `- **探针命名** \`_${id}-tmp-<用途>.<ext>\`，完工即自删；**删除动作必须在回复中声明**。`,
    "- **不改名、不移动、不删除他人的任何文件**；发现异常只登记并上报，交归属人处置。",
    "- 归属以 `command-center/data/store.json` 的工具调用留痕为准，文件名本身不足以定案。",
  ].join("\n");
}

/**
 * 注入"运行环境事实"。
 *
 * 为什么需要：成员无法自行查询自己的沙箱模式——DSH 会消费掉
 * DSH_PERMISSION_MODE，不透传给成员启动的 shell。成员只能靠推测，曾因此
 * 留下一份过期的能力自评。这里由指挥室把权威事实写进它的提示。
 */
export function runtimeFacts(runtime = {}) {
  const mode = runtime.permissionMode;
  if (!mode) return "";

  const EXPLAIN = {
    "danger-full-access":
      "完全权限：你可以读写工作区之外的任意路径，也可以执行任意命令。**但请按需行事**——能越界不等于该越界，越界改动前应说明理由。",
    "workspace-write":
      "工作区内修改：你只能在指定工作区内写入，工作区之外的写入会被沙箱拒绝。执行命令与全文搜索可用。",
    "read-only": "仅可查看：你只能读取，任何写入都会被沙箱拒绝。",
  };

  return [
    "## 运行环境事实（由指挥室在启动时注入，属既定事实）",
    "",
    `- 沙箱模式：\`${mode}\` —— ${EXPLAIN[mode] ?? "未知模式，遇到权限问题时如实上报，不要假定。"}`,
    runtime.workspace ? `- 工作区：\`${runtime.workspace}\`` : null,
    `- 自查方式：环境变量 \`CC_PERMISSION_MODE\` 与 \`CC_WORKSPACE\` 的值即为上述模式与工作区。需要确认自己的权限边界时直接读它们。`,
    "  补充：`DSH_PERMISSION_MODE` 不会透传给你启动的 shell，读不到它属于既定行为，不是故障；其余 `DSH_*` 变量（如 `DSH_HOME`、`DSH_PROFILE`）是可见的。",
    "",
    "依据本段事实作答：不要把你此前的能力自评当成仍然有效——若指挥室改过配置，以本段为准。",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

/** 拼出注入该成员的系统提示。 */
export function systemPromptFor(agent, runtime = {}) {
  const facts = runtimeFacts(runtime);
  const factBlock = facts ? `\n\n---\n\n${facts}` : "";
  const persona = agent.persona ?? `你是指挥室成员 ${agent.name}。`;
  return `${COMMAND_CENTER_CONTEXT}\n\n---\n\n${persona}\n\n---\n\n你的成员标识：${agent.name}（${agent.role}）。${factBlock}\n\n---\n\n${signatureDiscipline(agent)}`;
}

/**
 * 兼容旧调用：`AGENTS` 现在是函数而非常量。
 *
 * 保留这个名字是为了让尚未改到的模块能继续跑；新代码请直接用 `agents()`。
 */
export function AGENTS() {
  return allMembers();
}
