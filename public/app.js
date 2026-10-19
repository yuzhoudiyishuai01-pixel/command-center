/**
 * 指挥室前端。
 *
 * 无框架、无构建步骤：原生 ES module 直接跑。整体是"状态 -> 渲染"的单向流：
 *   fetch /api/state 拿初始快照 → EventSource 订阅增量事件 → 合并进本地状态 → 重绘受影响的片段
 *
 * 重绘粒度刻意做到消息级：只重画内容变了的成员回话，避免整个对话流闪烁，
 * 也让流式输出时的滚动位置保持稳定。
 */

// ══ 状态 ═══════════════════════════════════════════════════════════════════
const state = {
  agents: new Map(),
  /**
   * 侧栏各区块上次渲染的内容签名。数据没变就跳过重建——重建会让动画重播
   * （频道高亮的 sheen、成员作业呼吸光条），一轮作业里被触发好几次就成了"闪"。
   */
  renderCache: { rooms: null, members: null },
  /** /api/state 下发的运行态摘要与告警 */
  queue: null,
  warnings: [],
  /** 正在编辑的成员 id（编辑对话框用） */
  editingMemberId: null,
  /** 能力开关名录（由服务端下发），与成员正交。 */
  capabilities: [],
  /** 可用的接入方式（后端类型），新建成员对话框用。 */
  backendKinds: [],
  rooms: [],
  activeRoomId: null,
  /** roomId -> { id, kind, title, members, messages: [] } */
  roomData: new Map(),
  /** roomId -> Set<messageId> 正在流式输出、需要增量重绘的消息 */
  streaming: new Map(),
  /** roomId -> EventSource */
  sources: new Map(),
  running: new Set(),
  /** 当前正在作业的成员 id，用于左栏状态显示 */
  workingAgents: new Set(),
  connected: false,
};

const $ = (id) => document.getElementById(id);

// ══ Markdown 渲染 ═════════════════════════════════════════════════════════
/**
 * 一个刻意做小的 Markdown 渲染器。
 *
 * 为什么自己写：引入 marked 需要构建步骤或 CDN，而指挥室要求离线可用、零依赖。
 * 安全性：先把原文整体 HTML 转义，再做结构化替换，因此模型输出里的 <script>
 * 之类只会作为纯文本显示，不会被执行。
 */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderInline(text) {
  let out = text;
  // 行内代码优先抽出，避免其中的 * _ ` 被当成强调标记。
  const codes = [];
  out = out.replace(/`([^`\n]+)`/g, (_match, code) => {
    codes.push(code);
    return `\u0000CODE${codes.length - 1}\u0000`;
  });

  out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  // 裸链接（跳过已经在 href 里的情况由顺序保证：上一步已把 markdown 链接消费掉）
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_m, lead, url) => {
    return `${lead}<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });

  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, "$1<em>$2</em>");
  out = out.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");

  out = out.replace(/\u0000CODE(\d+)\u0000/g, (_m, index) => `<code>${codes[Number(index)]}</code>`);
  return out;
}

function renderMarkdown(source) {
  if (!source) return "";
  const escaped = escapeHtml(source.replace(/\r\n/g, "\n"));
  const lines = escaped.split("\n");
  const html = [];

  let listType = null; // "ul" | "ol"
  let inCode = false;
  let codeLang = "";
  let codeLines = [];
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    html.push(`<p>${renderInline(paragraph.join("<br />"))}</p>`);
    paragraph = [];
  };

  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };

  const flushCode = () => {
    const lang = codeLang ? ` class="language-${codeLang}"` : "";
    html.push(`<pre><code${lang}>${codeLines.join("\n")}</code></pre>`);
    codeLines = [];
    codeLang = "";
  };

  for (const line of lines) {
    const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
    if (fence) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        flushParagraph();
        closeList();
        inCode = true;
        codeLang = fence[1] ?? "";
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (/^\s*$/.test(line)) {
      flushParagraph();
      closeList();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      continue;
    }

    if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(line)) {
      flushParagraph();
      closeList();
      html.push("<hr />");
      continue;
    }

    const quote = line.match(/^\s*&gt;\s?(.*)$/);
    if (quote) {
      flushParagraph();
      closeList();
      html.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
      continue;
    }

    const ordered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ordered || bullet) {
      flushParagraph();
      const wanted = ordered ? "ol" : "ul";
      if (listType !== wanted) {
        closeList();
        html.push(`<${wanted}>`);
        listType = wanted;
      }
      html.push(`<li>${renderInline((ordered ? ordered[2] : bullet[1]).trim())}</li>`);
      continue;
    }

    closeList();
    paragraph.push(line);
  }

  if (inCode) flushCode();
  flushParagraph();
  closeList();
  return html.join("");
}

// ══ 小工具 ═════════════════════════════════════════════════════════════════
function agentOf(id) {
  return state.agents.get(id) ?? { id, name: id, role: "", accent: "#63707f", avatar: "??" };
}

function fmtTime(iso) {
  if (!iso) return "--:--";
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function fmtTokens(count) {
  if (!Number.isFinite(count)) return "0";
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
}

/** 字符数 → 人类可读体量（中文按字符数近似字节量级）。 */
function fmtBytes(chars) {
  if (!Number.isFinite(chars)) return "0";
  if (chars >= 1024 * 1024) return `${(chars / 1024 / 1024).toFixed(1)} MB`;
  if (chars >= 1024) return `${(chars / 1024).toFixed(0)} KB`;
  return `${chars} 字`;
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return "";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/** 从设置里取该成员的强调色，作为 CSS 变量注入。 */
function accentStyle(agent) {
  return `--accent:${agent.accent}`;
}

function toast(message, kind = "info") {
  const el = document.createElement("div");
  el.className = `toast ${kind === "error" ? "error" : ""}`;
  el.textContent = message;
  $("toast-stack").append(el);
  setTimeout(() => {
    el.style.transition = "opacity .3s, transform .3s";
    el.style.opacity = "0";
    el.style.transform = "translateY(6px)";
    setTimeout(() => el.remove(), 320);
  }, 4200);
}

// ══ 渲染：左栏 ═════════════════════════════════════════════════════════════
/**
 * 侧栏房间列表。
 *
 * 这里也做了"没变就不重建"的短路：.room-item.active 上有 room-sheen 动画，
 * 每次重建节点都会让它重新掠一遍——一轮作业里 busy/agent_end 会触发好几次，
 * 用户看到的就是频道高亮在闪。数据没变就原地不动，动画自然也不会重播。
 */
function renderRooms() {
  const signature = `${state.activeRoomId}|${state.rooms
    .map(
      (room) =>
        `${room.id}:${room.title}:${room.lastText ?? ""}:${room.messageCount}:${state.running.has(room.id) ? 1 : 0}`,
    )
    .join("|")}`;
  if (signature === state.renderCache.rooms) return;
  state.renderCache.rooms = signature;

  const host = $("room-list");
  host.textContent = "";
  for (const room of state.rooms) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `room-item${room.id === state.activeRoomId ? " active" : ""}`;
    button.dataset.roomId = room.id;

    const icon = document.createElement("span");
    icon.className = "room-icon";
    icon.textContent = room.kind === "private" ? "◦" : "#";

    const body = document.createElement("span");
    body.className = "room-body";
    const name = document.createElement("span");
    name.className = "room-name";
    name.textContent = room.title;
    const preview = document.createElement("span");
    preview.className = "room-preview";
    preview.textContent = room.lastText || (room.messageCount > 0 ? `${room.messageCount} 条消息` : "尚无对话");
    body.append(name, preview);

    button.append(icon, body);

    if (state.running.has(room.id)) {
      const spinner = document.createElement("span");
      spinner.className = "room-spinner";
      button.append(spinner);
    }

    button.addEventListener("click", () => selectRoom(room.id));
    host.append(button);
  }
}

/** 成员名册。同上：成员没变、作业状态没变就不重建（.member.working 的呼吸光条会重播）。 */
function renderMembers() {
  const signature = [...state.agents.values()]
    .map(
      (agent) =>
        `${agent.id}:${agent.name}:${agent.role}:${agent.avatar}:${agent.accent}:${isAgentWorking(agent.id) ? 1 : 0}`,
    )
    .join("|");
  if (signature === state.renderCache.members) return;
  state.renderCache.members = signature;

  const host = $("member-list");
  host.textContent = "";
  $("member-count").textContent = String(state.agents.size);

  for (const agent of state.agents.values()) {
    const li = document.createElement("li");
    li.className = `member${isAgentWorking(agent.id) ? " working" : ""}`;
    li.style.cssText = accentStyle(agent);

    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.textContent = agent.avatar;

    const info = document.createElement("span");
    info.className = "member-info";
    const name = document.createElement("span");
    name.className = "member-name";
    name.textContent = agent.name;
    const role = document.createElement("span");
    role.className = "member-role";
    role.textContent = agent.role;
    info.append(name, role);

    const capability = document.createElement("span");
    capability.className = "member-state";
    capability.textContent = agent.capabilities.some((c) => c.key === "web") ? "NET" : "LOCAL";

    li.append(avatar, info, capability);

    // 成员由用户掌控：每一位都可以编辑/删除（包括默认那四位）。
    const actions = document.createElement("span");
    actions.className = "member-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "icon-btn";
    edit.title = `编辑 ${agent.name}`;
    edit.textContent = "✎";
    edit.addEventListener("click", (event) => {
      event.stopPropagation();
      openEditMember(agent);
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-btn danger";
    remove.title = `删除 ${agent.name}`;
    remove.textContent = "✕";
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      void deleteMember(agent);
    });
    actions.append(edit, remove);
    li.append(actions);

    li.title = `${agent.name} · ${agent.role}\n后端：${agent.backendLabel ?? agent.backend}\n能力：${agent.capabilities
      .map((c) => c.label)
      .join("、")}`;
    host.append(li);
  }

  if (state.agents.size === 0) renderMembersEmptyState();
}

/** 打开编辑成员对话框（名称/职责/人格）。 */
function openEditMember(agent) {
  state.editingMemberId = agent.id;
  $("em-name").value = agent.name ?? "";
  $("em-role").value = agent.role ?? "";
  $("em-persona").value = "";
  $("um-hint")?.remove();
  $("em-hint").textContent = `后端：${agent.backendLabel ?? agent.backend}（后端类型暂不支持在这里切换，如需更换请新建成员）`;
  const dialog = $("edit-member-dialog");
  if (typeof dialog.showModal === "function") dialog.showModal();
  $("em-name").focus();
  void fetchMemberPersona(agent.id);
}

/** 人格正文不在公开接口里（避免把提示词发到浏览器），编辑时按需单独取。 */
async function fetchMemberPersona(memberId) {
  try {
    const response = await fetch(`/api/members/${encodeURIComponent(memberId)}/persona`);
    if (!response.ok) return;
    const payload = await response.json();
    if (state.editingMemberId === memberId) $("em-persona").value = payload.persona ?? "";
  } catch {
    /* 取不到就留空，用户可重写 */
  }
}

async function saveMemberEdits() {
  const memberId = state.editingMemberId;
  if (!memberId) return;
  const body = {
    name: $("em-name").value.trim(),
    role: $("em-role").value.trim(),
    persona: $("em-persona").value.trim() || undefined,
  };
  const response = await fetch(`/api/members/${encodeURIComponent(memberId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    toast(payload.error ?? "保存失败", "error");
    return;
  }
  toast("成员已更新");
  await fetchState(state.activeRoomId).then(applySnapshot);
  renderMembers();
}

/** 删除成员（带确认，删除后不可恢复）。 */
async function deleteMember(agent) {
  if (!window.confirm(`删除成员「${agent.name}」？\n\n这会同时把它从所有频道移除。此操作不可撤销。`)) return;
  const response = await fetch(`/api/members/${encodeURIComponent(agent.id)}`, { method: "DELETE" });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    toast(payload.error ?? "删除失败", "error");
    return;
  }
  toast(`已删除 ${agent.name}`);
  await fetchState(state.activeRoomId).then(applySnapshot);
  renderMembers();
  renderStageHeader();
  renderComposerTargets();
}

function renderStageHeader() {
  const room = currentRoom();
  if (!room) return;
  $("room-title").textContent = room.title;
  $("room-kind").textContent = room.kind === "private" ? "私人频道" : "群聊";

  const stack = $("room-avatars");
  stack.textContent = "";
  for (const id of room.members) {
    const agent = agentOf(id);
    const avatar = document.createElement("span");
    avatar.className = "avatar sm";
    avatar.style.cssText = accentStyle(agent);
    avatar.textContent = agent.avatar;
    avatar.title = agent.name;
    stack.append(avatar);
  }

  const busy = state.running.has(room.id);
  $("workload").hidden = !busy;
  $("abort-btn").hidden = !busy;
  $("workload-text").textContent = busy ? "成员作业中" : "待命";

  // 体量摘要：显示这个房间一共有多少条消息 / 多少字。
  // 只在偏大时提示，避免日常小房间也被数字噪音打扰。
  const footprint = room.footprint;
  const footprintEl = $("room-footprint");
  if (footprint && footprint.chars > 100_000) {
    footprintEl.hidden = false;
    footprintEl.textContent = `${footprint.messages} 条 · ${fmtBytes(footprint.chars)}`;
    footprintEl.title =
      `本房间共 ${footprint.messages} 条消息、${footprint.blocks} 个内容块、约 ${fmtBytes(footprint.chars)} 文本。\n` +
      "界面只加载最近消息；更早的已归档到 data/archive/";
  } else {
    footprintEl.hidden = true;
  }

  const members = room.members.map((id) => agentOf(id).name).join("、");
  $("input").placeholder =
    room.kind === "private"
      ? `对 ${members} 下达指令…`
      : "下达指令…  用 @ 点名成员，不点名则全员开工";
}

// ══ 渲染：对话流 ═══════════════════════════════════════════════════════════
function currentRoom() {
  if (!state.activeRoomId) return null;
  return state.roomData.get(state.activeRoomId) ?? null;
}

/**
 * 某位成员是否正在作业。
 *
 * workingAgents 记录的是 `${roomId}:${agentId}`：同一位成员可能同时在群聊和
 * 自己的私人频道里干活，只用 agentId 会互相干扰。
 */
function isAgentWorking(agentId) {
  for (const key of state.workingAgents) {
    if (key.endsWith(`:${agentId}`)) return true;
  }
  return false;
}

/** 按服务端的权威状态重置某房间的作业标记，清掉中断残留。 */
function reconcileWorkingState(roomId, isRoomRunning) {
  const prefix = `${roomId}:`;
  for (const key of [...state.workingAgents]) {
    if (key.startsWith(prefix)) state.workingAgents.delete(key);
  }
  // 服务端若说该房间没在跑，就不该有成员处于作业中。
  if (!isRoomRunning) {
    const room = state.roomData.get(roomId);
    for (const message of room?.messages ?? []) {
      if (message.role === "agent" && message.status === "working") {
        message.status = "interrupted";
        message.error = message.error ?? "服务在本次作业中途重启，该任务未完成。";
      }
    }
  }
}

/** 把扁平消息列表组装成"指令 + 其回复"的回合序列。 */
function buildTurns(messages) {
  const repliesByTurn = new Map();
  for (const message of messages) {
    if (message.role !== "agent") continue;
    if (!repliesByTurn.has(message.turnId)) repliesByTurn.set(message.turnId, []);
    repliesByTurn.get(message.turnId).push(message);
  }
  const turns = [];
  for (const message of messages) {
    if (message.role !== "commander") continue;
    turns.push({ commander: message, replies: repliesByTurn.get(message.turnId) ?? [] });
  }
  return turns;
}

/** 只渲染该房间里"有回话"的成员，避免群聊里出现别的频道的成员。 */
/**
 * 画一条成员回话。
 *
 * `enter` 控制入场动画：只有**真正新出现**的回话才播，流式刷新和整段重绘都不播。
 * 这是修"闪烁"的关键——之前每次 SSE 增量都把这个节点整个换掉，`.reply` 上的
 * rise 动画（淡入 + 上移 0.36s）就跟着重播一次；一轮作业 60+ 个事件，屏幕就在
 * 不停淡入，看起来就是闪。
 */
function renderReply(message, room, { enter = false } = {}) {
  const agent = agentOf(message.agentId);
  const el = document.createElement("article");
  el.className = "reply";
  if (enter) el.classList.add("enter");
  el.dataset.messageId = message.id;
  el.style.cssText = accentStyle(agent);

  const rail = document.createElement("div");
  rail.className = "reply-rail";
  const avatar = document.createElement("span");
  avatar.className = "avatar lg";
  avatar.textContent = agent.avatar;
  const line = document.createElement("span");
  line.className = "reply-line";
  rail.append(avatar, line);

  const main = document.createElement("div");
  main.className = "reply-main";

  const head = document.createElement("div");
  head.className = "reply-head";
  const name = document.createElement("span");
  name.className = "reply-name";
  name.textContent = agent.name;
  const role = document.createElement("span");
  role.className = "reply-role";
  role.textContent = agent.role;
  head.append(name, role);

  const status = document.createElement("span");
  const statusKind = message.status ?? "working";
  const STATUS_LABEL = {
    working: "作业中…",
    done: `完成${message.durationMs ? ` · ${fmtDuration(message.durationMs)}` : ""}`,
    failed: "失败",
    aborted: "已中止",
    // 服务在成员作业中途被杀：既不是失败也不是用户中止，单独标出来，
    // 否则界面会一直显示"作业中"，看起来像这位成员死了。
    interrupted: "已中断",
  };
  status.className = `reply-status ${statusKind}`;
  status.textContent = STATUS_LABEL[statusKind] ?? statusKind;
  if (statusKind === "interrupted") {
    status.title = "服务在本次作业中途重启，该任务未完成。可以再派一次。";
  }
  head.append(status);
  main.append(head);

  const card = document.createElement("div");
  card.className = `reply-card${statusKind === "working" ? " is-working" : ""}${
    statusKind === "failed" ? " is-failed" : ""
  }${statusKind === "interrupted" ? " is-interrupted" : ""}`;

  const blocks = message.blocks ?? [];
  const thinking = blocks.filter((block) => block.kind === "thinking");
  const tools = blocks.filter((block) => block.kind === "tool");
  const texts = blocks.filter((block) => block.kind === "text");

  // ── 过程区：思考与工具调用合并成一个可折叠区，默认收起 ──────────────────
  // 目的是让指挥官不展开时只看到「结果」。摘要行给出足够判断依据：
  // 思考字数、工具次数、失败次数、耗时——需要核实再展开看细节。
  const hasProcess = thinking.length > 0 || tools.length > 0;
  if (hasProcess) {
    const details = document.createElement("details");
    details.className = "process";
    // 作业中默认展开，让指挥官能看到实时动作；收工后收起，回到"只看结果"。
    if (statusKind === "working") details.open = true;

    const thinkingChars = thinking.reduce((sum, block) => sum + block.text.length, 0);
    const failed = tools.filter((block) => block.status && block.status !== "completed" && block.status !== "running");
    const running = tools.filter((block) => block.status === "running");

    const summary = document.createElement("summary");
    const bits = [];
    if (thinkingChars > 0) bits.push(`思考 ${thinkingChars} 字`);
    if (tools.length > 0) bits.push(`动作 ${tools.length} 次`);
    if (failed.length > 0) bits.push(`⚠ 失败 ${failed.length}`);
    if (running.length > 0) bits.push(`进行中 ${running.length}`);
    if (message.durationMs) bits.push(fmtDuration(message.durationMs));
    summary.textContent = bits.join(" · ") || "过程";

    const body = document.createElement("div");
    body.className = "process-body";

    if (thinking.length > 0) {
      const thinkBlock = document.createElement("div");
      thinkBlock.className = "thinking-body";
      thinkBlock.textContent = thinking.map((block) => block.text).join("\n");
      body.append(thinkBlock);
    }

    if (tools.length > 0) {
      const wrap = document.createElement("div");
      wrap.className = "actions";
      for (const block of tools) {
        const item = document.createElement("div");
        item.className = `action ${block.status ?? "running"}`;

        const glyph = document.createElement("span");
        glyph.className = "action-glyph";
        glyph.textContent = block.status === "completed" ? "▣" : block.status === "running" ? "▸" : "▴";

        const label = document.createElement("span");
        label.className = "action-label";
        label.textContent = block.label ?? block.tool;

        const detail = document.createElement("span");
        detail.className = "action-detail";
        detail.textContent = block.detail ?? "";
        detail.title = block.detail ?? "";

        const stat = document.createElement("span");
        stat.className = "action-status";
        stat.textContent =
          block.status === "completed"
            ? "OK"
            : block.status === "running"
              ? "RUN"
              : (block.status ?? "").toUpperCase();

        item.append(glyph, label, detail, stat);

        // 每次工具的完整输出再嵌一层折叠：即使展开了过程区，日志也不默认铺开。
        if (block.result) {
          const outputWrap = document.createElement("details");
          outputWrap.className = "action-output-wrap";
          const outputSummary = document.createElement("summary");
          outputSummary.textContent = "输出";
          const output = document.createElement("pre");
          output.className = "action-output";
          output.textContent = block.result;
          outputWrap.append(outputSummary, output);
          item.append(outputWrap);
        }
        wrap.append(item);
      }
      body.append(wrap);
    }

    details.append(summary, body);
    card.append(details);
  }

  const prose = document.createElement("div");
  prose.className = "prose";
  if (texts.length > 0) {
    prose.innerHTML = renderMarkdown(texts.map((block) => block.text).join("\n\n"));
    if (statusKind === "working") {
      const caret = document.createElement("span");
      caret.className = "caret";
      prose.append(caret);
    }
  } else if (statusKind === "working") {
    const waiting = document.createElement("span");
    waiting.className = "reply-role";
    waiting.textContent = tools.length > 0 ? "正在执行…" : "正在思考…";
    prose.append(waiting);
  }
  if (prose.childNodes.length > 0) card.append(prose);

  if (message.error) {
    const error = document.createElement("div");
    error.className = "reply-error";
    error.textContent = `⚠ ${message.error}`;
    card.append(error);
  }

  if (message.usage) {
    const usage = document.createElement("div");
    usage.className = "usage";
    usage.innerHTML = [
      `输入 <b>${fmtTokens(message.usage.inputTokens)}</b>`,
      `输出 <b>${fmtTokens(message.usage.outputTokens)}</b>`,
      `缓存命中 <b>${fmtTokens(message.usage.cacheReadTokens)}</b>`,
      `合计 <b>${fmtTokens(message.usage.totalTokens)}</b>`,
    ].join("");
    card.append(usage);
  }

  main.append(card);
  el.append(rail, main);
  return el;
}

function renderTranscript() {
  const room = currentRoom();
  const host = $("transcript");
  if (!room) return;

  const turns = buildTurns(room.messages);

  if (turns.length === 0) {
    host.textContent = "";
    const empty = document.createElement("div");
    empty.className = "transcript-empty";
    const title = document.createElement("h3");
    title.textContent = "AWAITING ORDERS";

    if (state.agents.size === 0) {
      // 开源版的第一次启动：名册是空的，先引导用户把成员加进来，
      // 否则指挥官会面对一个能打字但没人接活的界面。
      title.textContent = "NO MEMBERS YET";
      const hint = document.createElement("p");
      hint.textContent =
        "这个指挥室还没有成员。成员由你自己定义：可以接 OpenAI/Anthropic 兼容的 API，也可以接本机已登录的 CLI（DSH / Claude Code / Codex）。";
      const cta = document.createElement("button");
      cta.type = "button";
      cta.className = "primary-btn";
      cta.textContent = "＋ 添加第一个成员";
      cta.addEventListener("click", openNewMemberDialog);
      empty.append(title, hint, cta);
      host.append(empty);
      return;
    }

    const hint = document.createElement("p");
    hint.textContent =
      room.kind === "private"
        ? `这里是 ${room.members.map((id) => agentOf(id).name).join("、")} 的私人频道。直接下达指令，它会动手去做。`
        : "这是全员频道。直接下达指令会让所有成员并行开工；用 @ 点名可以只派给特定成员。成员会真的读写文件、执行命令、联网检索。";
    empty.append(title, hint);

    if (room.members.length === 0) {
      const cta = document.createElement("button");
      cta.type = "button";
      cta.className = "primary-btn";
      cta.textContent = "把成员拉进这个频道";
      cta.addEventListener("click", openRoomMembersDialog);
      empty.append(cta);
    }

    host.append(empty);
    return;
  }

  // 整段重绘前记下"屏幕上已经有谁"，重绘后只让真正新出现的回话播入场动画。
  // 否则每来一条指令，整屏历史回话都会重新淡入一次（这也是之前闪的原因之一）。
  // 首次铺满（切换房间 / 打开页面）时 alreadyShown 为空：不播动画，直接静态呈现——
  // 几十条回话同时跑 rise（带 blur 滤镜）反而会让首屏顿一下。
  const alreadyShown = new Set(
    [...host.querySelectorAll("[data-message-id]")].map((node) => node.dataset.messageId),
  );
  const isFirstPaint = alreadyShown.size === 0;

  host.textContent = "";

  // 历史入口：服务端只回了最近一窗口，更早的按需拉。
  if (room.hasMoreHistory) {
    const earlier = document.createElement("button");
    earlier.className = "load-earlier ghost-btn";
    earlier.type = "button";
    earlier.textContent = "加载更早的消息";
    earlier.addEventListener("click", async () => {
      earlier.disabled = true;
      earlier.textContent = "加载中…";
      try {
        await loadEarlierMessages(room.id);
      } catch (error) {
        earlier.disabled = false;
        earlier.textContent = "加载更早的消息";
        toast(error.message, "error");
      }
    });
    host.append(earlier);
  }

  for (const turn of turns) {
    const section = document.createElement("section");
    section.className = "turn";
    section.dataset.turnId = turn.commander.turnId;

    const cmd = document.createElement("div");
    cmd.className = "cmd";
    const bubble = document.createElement("div");
    bubble.className = "cmd-bubble";

    const label = document.createElement("div");
    label.className = "cmd-label";
    label.textContent = `指挥官 · ${fmtTime(turn.commander.at)}`;

    const text = document.createElement("p");
    text.className = "cmd-text";
    text.textContent = turn.commander.cleaned ?? turn.commander.text;

    bubble.append(label, text);

    if (turn.commander.targets?.length > 0 || turn.commander.capabilities?.length > 0) {
      const chips = document.createElement("div");
      chips.className = "cmd-targets";

      for (const id of turn.commander.targets ?? []) {
        const agent = agentOf(id);
        const chip = document.createElement("span");
        chip.className = "target-chip";
        chip.style.cssText = accentStyle(agent);
        const mini = document.createElement("span");
        mini.className = "avatar";
        mini.textContent = agent.avatar;
        const labelText = document.createElement("span");
        labelText.textContent = agent.name;
        chip.append(mini, labelText);
        chips.append(chip);
      }

      // 能力开关也标出来，便于事后看清"这一轮到底用了什么数据来源"。
      for (const id of turn.commander.capabilities ?? []) {
        const capability = state.capabilities.find((item) => item.id === id);
        if (!capability) continue;
        const chip = document.createElement("span");
        chip.className = "target-chip capability";
        chip.style.cssText = `--accent:${capability.accent}`;
        chip.title = capability.blurb;
        const glyph = document.createElement("span");
        glyph.className = "capability-glyph";
        glyph.textContent = capability.icon;
        const labelText = document.createElement("span");
        labelText.textContent = capability.label;
        chip.append(glyph, labelText);
        chips.append(chip);
      }

      bubble.append(chips);
    }

    cmd.append(bubble);
    section.append(cmd);

    // 只显示本房间成员的回复（成员名单变化后旧消息可能来自已移出的成员）。
    for (const reply of turn.replies) {
      if (!room.members.includes(reply.agentId)) continue;
      section.append(
        renderReply(reply, room, { enter: !isFirstPaint && !alreadyShown.has(reply.id) }),
      );
    }

    host.append(section);
  }
}

/**
 * 只重绘某条消息的正文区，用于流式更新。
 *
 * 关键点是**保留 `.reply` 外壳**，只替换里面的 `.reply-main`：
 * 外壳留在 DOM 里，入场动画不会重播，合成层也不用重建——之前整节点
 * `replaceWith` 时每次事件都会闪一下。另外把用户手动展开/收起的折叠状态
 * 一起搬过去，否则流式刷新会把展开的过程区强行折回去。
 */
function refreshMessage(messageId) {
  const node = document.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
  if (!node) {
    renderTranscript();
    return;
  }
  const room = currentRoom();
  if (!room) return;
  const message = room.messages.find((item) => item.id === messageId);
  if (!message) return;

  const fresh = renderReply(message, room, { enter: false });
  const oldMain = node.querySelector(".reply-main");
  const newMain = fresh.querySelector(".reply-main");
  if (!oldMain || !newMain) {
    const wasNearBottom = isNearBottom();
    node.replaceWith(fresh);
    if (wasNearBottom) scrollToBottom();
    return;
  }

  // 折叠状态跟着走：details 的顺序在两次渲染之间是稳定的（过程区 + 每个工具输出）。
  const openStates = [...node.querySelectorAll("details")].map((detail) => detail.open);
  oldMain.replaceWith(newMain);
  if (openStates.length > 0) {
    [...node.querySelectorAll("details")].forEach((detail, index) => {
      if (openStates[index] !== undefined) detail.open = openStates[index];
    });
  }

  if (isNearBottom() || state.followOutput) scrollToBottom();
}

/** 内容签名：没变就别重绘，省掉一次 Markdown 解析和 DOM 替换。 */
function messageSignature(message) {
  const blocks = message.blocks ?? [];
  const tail = blocks[blocks.length - 1];
  return [
    message.status,
    blocks.length,
    (message.text ?? "").length,
    (tail?.text ?? "").length,
    (tail?.detail ?? "").length,
    (tail?.result ?? "").length,
    message.usage?.totalTokens ?? 0,
    message.error ?? "",
  ].join("|");
}

/**
 * 流式事件合并到下一帧再画。
 *
 * 一轮作业里 SSE 事件能到 60+ 个，逐个重绘没有意义——屏幕一帧只显示一次。
 * 按 messageId 去重后每帧最多重绘一次，既不掉信息又把主线程让出来。
 */
const pendingRefreshes = new Set();
const lastSignatures = new Map();
let refreshFrame = 0;

function scheduleMessageRefresh(messageId) {
  pendingRefreshes.add(messageId);
  if (refreshFrame) return;
  refreshFrame = requestAnimationFrame(() => {
    refreshFrame = 0;
    const ids = [...pendingRefreshes];
    pendingRefreshes.clear();
    for (const id of ids) {
      const message = currentRoom()?.messages.find((item) => item.id === id);
      if (!message) continue;
      const signature = messageSignature(message);
      if (lastSignatures.get(id) === signature) continue;
      lastSignatures.set(id, signature);
      refreshMessage(id);
    }
  });
}

function isNearBottom() {
  const host = $("transcript");
  return host.scrollHeight - host.scrollTop - host.clientHeight < 140;
}

function scrollToBottom() {
  const host = $("transcript");
  host.scrollTop = host.scrollHeight;
}

// ══ 渲染：右栏实时动态 ═════════════════════════════════════════════════════
const liveFeed = [];

function buildFeedItem(entry) {
  const li = document.createElement("li");
  li.className = `feed-item kind-${entry.kind}`;
  if (entry.accent) li.style.cssText = `--accent:${entry.accent}`;

  const time = document.createElement("span");
  time.className = "feed-time";
  time.textContent = fmtTime(entry.at);

  const body = document.createElement("span");
  body.className = "feed-body";
  const who = document.createElement("span");
  who.className = "feed-who";
  who.textContent = entry.who ? `${entry.who} ` : "";
  const what = document.createElement("span");
  what.className = "feed-what";
  what.textContent = entry.what;
  body.append(who, what);

  li.append(time, body);
  return li;
}

/**
 * 追加一条实时动态。
 *
 * 只把新条目插到最上面，**不再清空整列重建**——重建会让每个条目都重播一次
 * rise 淡入动画，一轮作业里几十条消息滚动时整列都在闪（用户反馈的"闪烁"）。
 * 只有新条目带 `.enter`，其余节点原地不动，动画也就不会重播。
 */
function pushLive({ who, what, accent, kind = "info" }) {
  const entry = { who, what, accent, kind, at: new Date().toISOString() };
  liveFeed.push(entry);
  while (liveFeed.length > 90) liveFeed.shift();

  const host = $("live-feed");
  if (!host) return;
  host.querySelector(".feed-empty")?.remove();
  const li = buildFeedItem(entry);
  li.classList.add("enter");
  host.prepend(li);
  while (host.children.length > 90) host.lastElementChild.remove();
}

/** 整列重建：只在初始化/切换房间时用，所以不播入场动画。 */
function renderLiveFeed() {
  const host = $("live-feed");
  host.textContent = "";
  if (liveFeed.length === 0) {
    const empty = document.createElement("li");
    empty.className = "feed-empty";
    empty.textContent = "成员一动工，这里会实时显示他们在做什么。";
    host.append(empty);
    return;
  }
  for (const entry of [...liveFeed].reverse()) {
    host.append(buildFeedItem(entry));
  }
}

// ══ 数据流 ═════════════════════════════════════════════════════════════════
async function fetchState(roomId) {
  const query = roomId ? `?room=${encodeURIComponent(roomId)}` : "";
  const response = await fetch(`/api/state${query}`);
  if (!response.ok) throw new Error(`加载状态失败：${response.status}`);
  return response.json();
}

function applySnapshot(snapshot) {
  state.agents = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
  state.capabilities = Array.isArray(snapshot.capabilities) ? snapshot.capabilities : [];
  state.backendKinds = Array.isArray(snapshot.backendKinds) ? snapshot.backendKinds : [];
  state.rooms = snapshot.rooms;
  if (snapshot.activeRoom) {
    state.roomData.set(snapshot.activeRoom.id, snapshot.activeRoom);
    state.activeRoomId = snapshot.activeRoom.id;
  }
  state.running = new Set(snapshot.rooms.filter((room) => room.running).map((room) => room.id));

  // 快照是权威状态：据此重置作业标记，清掉上次进程被强杀留下的"作业中"残留。
  // 不做这一步的话，成员会永远显示在作业中，看起来像半个指挥室死了。
  state.workingAgents = new Set();
  for (const room of snapshot.rooms) reconcileWorkingState(room.id, room.running);

  // 快照会整体替换消息内容，之前记的"渲染签名"全部作废
  lastSignatures.clear();

  state.workspace = snapshot.workspace;
  state.permissionMode = snapshot.permissionMode;
  state.queue = snapshot.queue ?? null;
  state.warnings = Array.isArray(snapshot.warnings) ? snapshot.warnings : [];

  $("foot-workspace").textContent = snapshot.workspace ?? "—";
  $("foot-workspace").title = snapshot.workspace ?? "";
  $("foot-sandbox").textContent = snapshot.permissionMode ?? "—";
  const routes = [...new Set(snapshot.agents.map((agent) => agent.backendLabel).filter(Boolean))];
  $("foot-route").textContent = routes.length > 0 ? routes.slice(0, 2).join(" · ") : "—";

  renderNoticeStrip();
  updateQueueBadge();
  renderMembersEmptyState();
  void refreshStats();
}

/** 环境告警条：没装 CLI、没登录、鉴权关闭之类，直接摆在对话区上方。 */
function renderNoticeStrip() {
  const host = $("notice-strip");
  const warnings = state.warnings ?? [];
  if (warnings.length === 0) {
    host.hidden = true;
    host.textContent = "";
    return;
  }
  host.hidden = false;
  host.textContent = "";
  for (const warning of warnings) {
    const line = document.createElement("p");
    line.textContent = warning;
    host.append(line);
  }
}

/** 队列徽标：显示排队等待中的作业数，打满并发时用户能看见"为什么还没开始"。 */
function updateQueueBadge() {
  const badge = $("queue-badge");
  const queue = state.queue;
  const pending = queue?.pending ?? 0;
  if (!pending) {
    badge.hidden = true;
    return;
  }
  badge.hidden = false;
  badge.textContent = `排队 ${pending}`;
  badge.title = `并发上限 ${queue.maxConcurrent}，正在运行 ${queue.active}，等待 ${pending}`;
}

/** 侧栏底部的运行统计（取自 /api/stats，30 秒刷新一次即可）。 */
async function refreshStats() {
  try {
    const response = await fetch("/api/stats");
    if (!response.ok) return;
    const stats = await response.json();
    const turns = stats.turns ?? {};
    const tokens = stats.tokens ?? {};
    $("foot-turns").textContent = `${turns.total ?? 0} 轮 · ${fmtTokens(tokens.total ?? 0)}`;
  } catch {
    /* 统计拿不到不影响主流程 */
  }
}

/** 没有任何成员时，对话区给出明确的下一步，而不是一片空白。 */
function renderMembersEmptyState() {
  $("member-count").textContent = String(state.agents.size);
  const host = $("member-list");
  if (state.agents.size > 0) return;
  host.textContent = "";
  const li = document.createElement("li");
  li.className = "member-empty";
  li.textContent = "还没有成员。点上面的 ＋ 添加第一个（API 或 CLI 都行）。";
  host.append(li);
}

/** 确保该房间的数据已加载，并订阅其事件流。 */
async function ensureRoom(roomId) {
  if (!state.roomData.has(roomId)) {
    const snapshot = await fetchState(roomId);
    const room = snapshot.activeRoom;
    if (room) state.roomData.set(room.id, room);
    if (!state.agents.size) applySnapshot(snapshot);
  }
  subscribe(roomId);
}

/**
 * 往前翻一页历史。
 *
 * /api/state 只带最近窗口（实测整间房能到 2.5 MB），更早的消息按游标分页取，
 * 取到后拼到现有消息前面再整体重绘。
 */
async function loadEarlierMessages(roomId) {
  const room = state.roomData.get(roomId);
  if (!room) return;
  const first = room.messages[0];
  const query = new URLSearchParams({ limit: "40" });
  if (first) query.set("before", first.id);

  const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/messages?${query}`);
  if (!response.ok) throw new Error(`加载历史失败：${response.status}`);
  const page = await response.json();

  room.messages = [...page.messages, ...room.messages];
  room.hasMoreHistory = page.hasMore;
  renderTranscript();
  renderStageHeader();
}

function subscribe(roomId) {
  state.sources.get(roomId)?.close();
  const source = new EventSource(`/api/rooms/${encodeURIComponent(roomId)}/events`);
  state.sources.set(roomId, source);

  source.onopen = () => {
    state.connected = true;
    $("conn-pulse").className = "brand-pulse online";
  };

  source.onerror = () => {
    state.connected = false;
    $("conn-pulse").className = "brand-pulse offline";
  };

  source.onmessage = (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    handleEvent(roomId, payload);
  };
}

async function selectRoom(roomId) {
  state.activeRoomId = roomId;
  renderRooms();
  await ensureRoom(roomId);
  renderStageHeader();
  renderTranscript();
  renderComposerTargets();
  scrollToBottom();
  $("input").focus();
}

// ══ 事件处理 ═══════════════════════════════════════════════════════════════
function roomOf(roomId) {
  return state.roomData.get(roomId);
}

function handleEvent(roomId, event) {
  const room = roomOf(roomId);
  if (!room) return;
  const isActive = roomId === state.activeRoomId;

  switch (event.type) {
    case "hello":
      break;

    case "room_updated": {
      // 频道成员被改动（拉人 / 移除）：同步本地房间与侧栏。
      if (event.room) {
        const local = roomOf(event.room.id);
        if (local) {
          local.members = event.room.members;
          local.kind = event.room.kind;
        }
        state.rooms = state.rooms.map((item) =>
          item.id === event.room.id ? { ...item, members: event.room.members, kind: event.room.kind } : item,
        );
        if (event.room.id === state.activeRoomId) {
          renderStageHeader();
          renderComposerTargets();
        }
        renderRooms();
      }
      break;
    }

    case "busy": {
      if (event.busy) state.running.add(roomId);
      else state.running.delete(roomId);
      renderRooms();
      if (isActive) renderStageHeader();
      break;
    }

    case "commander": {
      // 按 id 去重：SSE 断线重连或与快照刷新交错时，同一条指令可能被投递多次。
      // 直接 push 会让它在界面上重复出现——这是实测到的真实问题。
      if (!room.messages.some((item) => item.id === event.message.id)) {
        room.messages.push(event.message);
      }
      if (isActive) {
        renderTranscript();
        scrollToBottom();
      }
      renderRooms();
      break;
    }

    case "agent_start": {
      // 服务端此时已经落库了这位成员的回话消息，并给出了 messageId。
      // 本地先建出同一条占位消息，后续增量事件就能直接合并，而不必整段重绘。
      const agent = agentOf(event.agentId);
      state.workingAgents.add(`${roomId}:${event.agentId}`);
      if (event.messageId && !room.messages.some((item) => item.id === event.messageId)) {
        room.messages.push({
          id: event.messageId,
          role: "agent",
          agentId: event.agentId,
          turnId: event.turnId ?? null,
          at: new Date().toISOString(),
          status: "working",
          blocks: [],
          text: "",
          usage: null,
          error: null,
          durationMs: null,
        });
        if (isActive) {
          renderTranscript();
          scrollToBottom();
        }
      }
      renderMembers();
      pushLive({ who: agent.name, what: "开始作业", accent: agent.accent, kind: "info" });
      break;
    }

    case "thinking":
    case "text":
    case "tool_call":
    case "tool_result":
    case "usage":
    case "error":
    case "final": {
      const message = room.messages.find((item) => item.id === event.messageId);
      if (!message) {
        // 服务端已新增成员回话，但这条增量事件先到了：拉一次快照补齐。
        void refreshRoomFromServer(roomId);
        break;
      }
      applyAgentEvent(message, event);
      if (isActive) scheduleMessageRefresh(message.id);
      if (event.type === "tool_call") {
        pushLive({
          who: agentOf(message.agentId).name,
          what: `${event.label}${event.detail ? ` · ${event.detail}` : ""}`,
          accent: agentOf(message.agentId).accent,
          kind: "tool",
        });
      } else if (event.type === "error") {
        pushLive({
          who: agentOf(message.agentId).name,
          what: event.message ?? "出错",
          accent: agentOf(message.agentId).accent,
          kind: "error",
        });
      }
      break;
    }

    case "agent_end": {
      const message = room.messages.find((item) => item.id === event.messageId);
      const agent = agentOf(event.agentId);
      state.workingAgents.delete(`${roomId}:${event.agentId}`);
      if (message) {
        message.status = event.status;
        message.durationMs = event.durationMs ?? null;
      }
      pushLive({
        who: agent.name,
        what: event.status === "done" ? "完成" : event.status === "aborted" ? "已中止" : "失败",
        accent: agent.accent,
        kind: event.status === "done" ? "done" : "error",
      });
      if (isActive) {
        if (message) scheduleMessageRefresh(message.id);
        else renderTranscript();
      }
      renderMembers();
      renderRooms();
      break;
    }

    case "agent_error": {
      const agent = agentOf(event.agentId);
      pushLive({ who: agent.name, what: event.message, accent: agent.accent, kind: "error" });
      toast(`${agent.name}：${event.message}`, "error");
      break;
    }

    case "queue_wait": {
      // 并发打满：有新作业在排队，让用户知道"还没开始"不是卡死了。
      state.queue = { ...(state.queue ?? {}), pending: event.pending ?? 0 };
      updateQueueBadge();
      break;
    }

    case "queue_start": {
      if ((event.waitMs ?? 0) > 400) {
        const agent = agentOf(event.agentId);
        pushLive({
          who: agent.name,
          what: `排队 ${Math.max(1, Math.round(event.waitMs / 1000))}s 后开始执行`,
          accent: agent.accent,
          kind: "info",
        });
      }
      break;
    }

    case "fatal": {
      toast(event.message, "error");
      break;
    }

    default:
      break;
  }
}

/** 把事件合并进本地消息，规则与后端 orchestrator 保持一致。 */
function applyAgentEvent(message, event) {
  message.blocks ??= [];
  switch (event.type) {
    case "thinking": {
      const last = message.blocks.at(-1);
      if (last?.kind === "thinking") last.text += event.text;
      else message.blocks.push({ kind: "thinking", text: event.text });
      break;
    }
    case "text": {
      const last = message.blocks.at(-1);
      if (last?.kind === "text") last.text += event.text;
      else message.blocks.push({ kind: "text", text: event.text });
      break;
    }
    case "tool_call": {
      message.blocks.push({
        kind: "tool",
        callId: event.callId,
        tool: event.tool,
        label: event.label,
        detail: event.detail,
        status: "running",
        result: null,
      });
      break;
    }
    case "tool_result": {
      const block = message.blocks.find((item) => item.kind === "tool" && item.callId === event.callId);
      if (block) {
        block.status = event.status;
        block.result = event.result;
      }
      break;
    }
    case "usage":
      message.usage = event.usage;
      break;
    case "error":
      message.error = event.message;
      break;
    case "final":
      if (event.text) message.text = event.text;
      break;
    default:
      break;
  }
  const texts = message.blocks.filter((block) => block.kind === "text");
  if (texts.length > 0) message.text = texts.map((block) => block.text).join("\n\n");
}

async function refreshRoomFromServer(roomId) {
  try {
    const snapshot = await fetchState(roomId);
    const fresh = snapshot.activeRoom;
    if (!fresh) return;
    // 服务端是权威：整体替换消息列表，避免本地与后端分叉。
    state.roomData.set(roomId, fresh);
    state.rooms = snapshot.rooms;
    if (roomId === state.activeRoomId) {
      renderTranscript();
      renderRooms();
    }
  } catch {
    /* 拉取失败时保留本地状态，等下一次事件 */
  }
}

// ══ 输入区 ═════════════════════════════════════════════════════════════════
/** 当前输入框里通过 @ 选中的成员；为空表示按房间默认规则派发。 */
let selectedMentions = new Set();
/** 点选的能力开关（GitHub / 维基百科…）。与成员正交，可组合。 */
let selectedCapabilities = new Set();

function renderComposerTargets() {
  const host = $("composer-targets");
  host.textContent = "";
  const room = currentRoom();
  if (!room) return;

  // 私人频道只有一个对象，无需选择成员；但能力开关仍然有用。
  if (room.kind !== "private") {
    for (const id of room.members) {
      const agent = agentOf(id);
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.style.cssText = accentStyle(agent);
      chip.setAttribute("aria-pressed", selectedMentions.has(id) ? "true" : "false");

      const avatar = document.createElement("span");
      avatar.className = "avatar sm";
      avatar.textContent = agent.avatar;
      const label = document.createElement("span");
      label.textContent = agent.name;
      chip.append(avatar, label);

      chip.addEventListener("click", () => {
        if (selectedMentions.has(id)) selectedMentions.delete(id);
        else selectedMentions.add(id);
        renderComposerTargets();
      });

      host.append(chip);
    }

    const hint = document.createElement("span");
    hint.className = "pane-count";
    hint.textContent = selectedMentions.size === 0 ? "（未选 = 全员）" : "";
    host.append(hint);
  }

  // 能力开关单独一组：分隔线 + 标签，避免和成员 chip 混淆。
  if (state.capabilities.length > 0) {
    const divider = document.createElement("span");
    divider.className = "chip-divider";
    divider.title = "能力开关：选中后本次优先用这条数据来源";
    divider.textContent = "＋";
    host.append(divider);

    for (const capability of state.capabilities) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = `chip capability${selectedCapabilities.has(capability.id) ? " on" : ""}`;
      chip.style.cssText = `--accent:${capability.accent}`;
      chip.setAttribute("aria-pressed", selectedCapabilities.has(capability.id) ? "true" : "false");
      chip.title = capability.blurb;

      const glyph = document.createElement("span");
      glyph.className = "capability-glyph";
      glyph.textContent = capability.icon;
      const label = document.createElement("span");
      label.textContent = capability.label;
      chip.append(glyph, label);

      chip.addEventListener("click", () => {
        if (selectedCapabilities.has(capability.id)) selectedCapabilities.delete(capability.id);
        else selectedCapabilities.add(capability.id);
        renderComposerTargets();
      });

      host.append(chip);
    }
  }
}

/** @ 提示条：输入 @ 时同时弹出成员与能力候选。 */
function updateMentionBar() {
  const bar = $("mention-bar");
  const input = $("input");
  const value = input.value;
  const match = value.match(/@([^\s@]*)$/);
  const room = currentRoom();

  if (!match || !room) {
    bar.hidden = true;
    bar.textContent = "";
    return;
  }

  const query = match[1].toLowerCase();
  const agents = room.members
    .map((id) => agentOf(id))
    .filter((agent) => !query || agent.name.toLowerCase().includes(query) || agent.id.includes(query));

  // 能力名支持中英文，所以中英都要参与匹配。
  const capabilities = state.capabilities.filter((capability) => {
    if (!query) return true;
    const names = [capability.label, capability.id, ...(capability.aliases ?? [])];
    return names.some((name) => String(name).toLowerCase().includes(query));
  });

  bar.hidden = false;
  bar.textContent = "";

  if (agents.length === 0 && capabilities.length === 0) {
    const none = document.createElement("span");
    none.className = "reply-role";
    none.textContent = "没有匹配的成员或能力";
    bar.append(none);
    return;
  }

  const insert = (token) => {
    input.value = `${value.slice(0, match.index)}@${token} `;
    bar.hidden = true;
    input.focus();
  };

  for (const agent of agents) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "mention-item";
    item.style.cssText = accentStyle(agent);
    const avatar = document.createElement("span");
    avatar.className = "avatar sm";
    avatar.textContent = agent.avatar;
    const label = document.createElement("span");
    label.textContent = agent.name;
    item.append(avatar, label);
    item.addEventListener("click", () => insert(agent.name));
    bar.append(item);
  }

  for (const capability of capabilities) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "mention-item capability";
    item.style.cssText = `--accent:${capability.accent}`;
    item.title = capability.blurb;
    const glyph = document.createElement("span");
    glyph.className = "capability-glyph";
    glyph.textContent = capability.icon;
    const label = document.createElement("span");
    label.textContent = capability.label;
    item.append(glyph, label);
    item.addEventListener("click", () => insert(capability.label));
    bar.append(item);
  }
}

function autoGrow(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, 190)}px`;
}

async function dispatch() {
  const input = $("input");
  const room = currentRoom();
  if (!room) return;
  if (state.agents.size === 0) {
    toast("还没有成员：先添加一个成员再接活", "error");
    openNewMemberDialog();
    return;
  }
  let text = input.value.trim();
  if (!text) return;

  // 用成员选择器补上 @点名，与手写 @ 等价。若用户已经手写了 @，则尊重手写内容。
  if (room.kind !== "private" && selectedMentions.size > 0 && !text.includes("@")) {
    const mentions = [...selectedMentions].map((id) => `@${agentOf(id).name}`).join(" ");
    text = `${mentions} ${text}`;
  }

  const button = $("send-btn");
  button.disabled = true;
  try {
    const response = await fetch(`/api/rooms/${encodeURIComponent(room.id)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // 能力开关走结构化字段，不走正文——这样界面显示的是用户真正打的字，
      // 不会看到一大段被塞进去的指令模板。
      body: JSON.stringify({ text, capabilities: [...selectedCapabilities] }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error ?? `派发失败：${response.status}`);
    }
    input.value = "";
    autoGrow(input);
    selectedMentions.clear();
    // 能力开关一次性生效，派发后复位——避免下一次无意间继续沿用。
    selectedCapabilities.clear();
    renderComposerTargets();
    // 指令消息由 SSE 的 commander 事件回传，这里不用本地插入，避免重复。
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

// ══ 新建频道 ═══════════════════════════════════════════════════════════════
function openNewRoomDialog() {
  const dialog = $("new-room-dialog");
  const grid = $("new-room-members");
  const title = $("new-room-title");
  title.value = "";
  grid.textContent = "";
  const chosen = new Set();

  for (const agent of state.agents.values()) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.style.cssText = accentStyle(agent);
    chip.setAttribute("aria-pressed", "false");
    const avatar = document.createElement("span");
    avatar.className = "avatar sm";
    avatar.textContent = agent.avatar;
    const label = document.createElement("span");
    label.textContent = agent.name;
    chip.append(avatar, label);
    chip.addEventListener("click", () => {
      if (chosen.has(agent.id)) chosen.delete(agent.id);
      else chosen.add(agent.id);
      chip.setAttribute("aria-pressed", chosen.has(agent.id) ? "true" : "false");
    });
    grid.append(chip);
  }

  dialog.showModal();

  $("new-room-form").onsubmit = async (event) => {
    if (event.submitter?.value === "cancel") return;
    if (chosen.size === 0) {
      event.preventDefault();
      toast("至少选择一位成员", "error");
      return;
    }
    event.preventDefault();
    try {
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: title.value.trim() || undefined, members: [...chosen] }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error ?? "创建失败");
      }
      const { room } = await response.json();
      const snapshot = await fetchState(room.id);
      applySnapshot(snapshot);
      dialog.close();
      await selectRoom(room.id);
      toast(`频道「${room.title}」已创建`);
    } catch (error) {
      toast(error.message, "error");
    }
  };

  $("new-room-cancel").onclick = () => dialog.close();
}

// ══ 新建成员 ═══════════════════════════════════════════════════════════════
const BACKEND_LABEL_FALLBACK = {
  dsh: "DSH 内置（有工具能力）",
  "claude-cli": "Claude Code CLI（有工具能力）",
  "codex-cli": "Codex CLI（有工具能力）",
  "openai-api": "OpenAI 兼容 API（纯对话）",
  "anthropic-api": "Anthropic API（纯对话）",
};

function openNewMemberDialog() {
  const dialog = $("new-member-dialog");
  const select = $("nm-backend");
  const apiFields = $("nm-api-fields");
  const hint = $("nm-backend-hint");

  // 用后端类型清单填下拉框；服务端没下发时用本地兜底。
  select.textContent = "";
  const kinds = state.backendKinds.length > 0
    ? state.backendKinds
    : Object.entries(BACKEND_LABEL_FALLBACK).map(([id, label]) => ({ id, label, kind: id.includes("api") ? "api" : "cli" }));

  for (const kind of kinds) {
    const option = document.createElement("option");
    option.value = kind.id;
    option.textContent = kind.label + (kind.toolCapable ? " · 能动手" : " · 纯对话");
    select.append(option);
  }

  const syncBackendUi = () => {
    const chosen = kinds.find((kind) => kind.id === select.value);
    const isApi = chosen?.kind === "api";
    apiFields.hidden = !isApi;
    // 每种接入方式的"代价"不一样，不能一句 CLI 文案套所有：
    // DSH 内置不用装任何东西，CLI 成员则依赖本机已登录的对应命令行工具。
    const toolHints = {
      dsh: "DSH 内置成员：跑在本机的 DeepSeek Harness 里，能读写文件、执行命令、联网检索，不需要额外安装或登录。",
      "claude-cli": "Claude Code CLI：复用本机已登录的 Claude Code，能读写文件、执行命令。需要本机装好并登录过 claude。",
      "codex-cli": "Codex CLI：复用本机已登录的 Codex CLI，能读写文件、执行命令。需要本机装好并登录过 codex。",
    };
    hint.textContent = isApi
      ? "纯对话成员：能回答、能推理，但不会读写你的文件、不会执行命令。"
      : (toolHints[chosen?.id] ?? "CLI 成员：自带工具能力（读写文件、执行命令），但需要本机已安装并登录对应 CLI。");
    // API 成员的密钥/地址是必填，标出来
    $("nm-baseurl").required = isApi;
    $("nm-model").required = isApi;
    $("nm-apikey").required = isApi;
  };
  select.onchange = syncBackendUi;
  syncBackendUi();

  // 清空上次填写
  for (const id of ["nm-name", "nm-role", "nm-baseurl", "nm-model", "nm-apikey"]) $(id).value = "";
  $("nm-persona").value = "";

  dialog.showModal();
  setTimeout(() => $("nm-name").focus(), 60);

  $("nm-cancel").onclick = () => dialog.close();

  $("new-member-form").onsubmit = async (event) => {
    event.preventDefault();
    const payload = {
      name: $("nm-name").value.trim(),
      role: $("nm-role").value.trim(),
      backend: select.value,
      persona: $("nm-persona").value.trim(),
      baseUrl: $("nm-baseurl").value.trim(),
      model: $("nm-model").value.trim(),
      apiKey: $("nm-apikey").value.trim(),
    };
    if (!payload.name) {
      toast("请填写成员名称", "error");
      return;
    }

    const submit = event.submitter;
    if (submit) submit.disabled = true;
    try {
      const response = await fetch("/api/members", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `创建失败：${response.status}`);

      // 重新拉快照，成员列表与后端清单一起刷新
      const snapshot = await fetchState(state.activeRoomId);
      applySnapshot(snapshot);
      renderMembers();
      renderComposerTargets();
      renderStageHeader();
      dialog.close();
      toast(`成员「${body.member?.name ?? payload.name}」已创建`);
    } catch (error) {
      toast(error.message, "error");
    } finally {
      if (submit) submit.disabled = false;
    }
  };
}

// ══ 频道成员管理（拉人 / 移除）═════════════════════════════════════════════
function openRoomMembersDialog() {
  const room = currentRoom();
  if (!room) return;
  const dialog = $("room-members-dialog");
  const currentHost = $("rm-current");
  const addableHost = $("rm-addable");
  const resetHost = $("rm-reset");
  currentHost.textContent = "";
  addableHost.textContent = "";
  resetHost.textContent = "";

  const renderLists = () => {
    currentHost.textContent = "";
    addableHost.textContent = "";
    resetHost.textContent = "";

    for (const id of room.members) {
      const agent = agentOf(id);
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip on";
      chip.style.cssText = accentStyle(agent);
      const avatar = document.createElement("span");
      avatar.className = "avatar sm";
      avatar.textContent = agent.avatar;
      const label = document.createElement("span");
      label.textContent = agent.name;
      const cross = document.createElement("span");
      cross.className = "chip-remove";
      cross.textContent = "×";
      cross.title = room.members.length === 1 ? "至少要保留一位成员" : "移出本频道";
      chip.append(avatar, label, cross);
      chip.disabled = room.members.length === 1;
      chip.addEventListener("click", async () => {
        if (room.members.length === 1) return;
        try {
          const response = await fetch(
            `/api/rooms/${encodeURIComponent(room.id)}/members/${encodeURIComponent(id)}`,
            { method: "DELETE" },
          );
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error ?? "移除失败");
          room.members = body.room.members;
          room.kind = body.room.kind;
          renderStageHeader();
          renderComposerTargets();
          renderLists();
          renderRooms();
          toast(`${agent.name} 已移出本频道`);
        } catch (error) {
          toast(error.message, "error");
        }
      });
      currentHost.append(chip);
    }

    for (const id of room.members) {
      const agent = agentOf(id);
      const resetBtn = document.createElement("button");
      resetBtn.type = "button";
      resetBtn.className = "chip";
      resetBtn.style.cssText = accentStyle(agent);
      resetBtn.title = `清空 ${agent.name} 的会话记忆，下次回复从零开始`;
      const resetAvatar = document.createElement("span");
      resetAvatar.className = "avatar sm";
      resetAvatar.textContent = "↺";
      const resetLabel = document.createElement("span");
      resetLabel.textContent = agent.name;
      resetBtn.append(resetAvatar, resetLabel);
      resetBtn.addEventListener("click", async () => {
        try {
          const response = await fetch(
            `/api/agents/${encodeURIComponent(id)}/session/reset`,
            { method: "POST" },
          );
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error ?? "重置失败");
          toast(
            body.cleared > 0
              ? `${agent.name} 的会话已清空（${body.cleared} 处），下次回复从零开始`
              : `${agent.name} 本来就没有进行中的会话`,
          );
        } catch (error) {
          toast(error.message, "error");
        }
      });
      resetHost.append(resetBtn);
    }

    const outsiders = [...state.agents.values()].filter((agent) => !room.members.includes(agent.id));
    if (outsiders.length === 0) {
      const none = document.createElement("span");
      none.className = "field-hint";
      none.textContent = "所有成员都已在本频道内。";
      addableHost.append(none);
      return;
    }

    for (const agent of outsiders) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.style.cssText = accentStyle(agent);
      const avatar = document.createElement("span");
      avatar.className = "avatar sm";
      avatar.textContent = agent.avatar;
      const label = document.createElement("span");
      label.textContent = agent.name;
      const plus = document.createElement("span");
      plus.className = "chip-add";
      plus.textContent = "＋";
      chip.append(avatar, label, plus);
      chip.addEventListener("click", async () => {
        try {
          const response = await fetch(`/api/rooms/${encodeURIComponent(room.id)}/members`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ members: [agent.id] }),
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error ?? "拉入失败");
          room.members = body.room.members;
          room.kind = body.room.kind;
          renderStageHeader();
          renderComposerTargets();
          renderLists();
          renderRooms();
          toast(`${agent.name} 已加入本频道`);
        } catch (error) {
          toast(error.message, "error");
        }
      });
      addableHost.append(chip);
    }
  };

  renderLists();
  dialog.showModal();
  $("rm-close").onclick = () => dialog.close();
}

// ══ 历史搜索（Ctrl+K）══════════════════════════════════════════════════════
function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function openSearchDialog() {
  const dialog = $("search-dialog");
  if (typeof dialog.showModal === "function") dialog.showModal();
  const input = $("search-input");
  input.focus();
  input.select();
}

/**
 * 搜索跨房间历史。
 *
 * 结果渲染成可点击的列表：点一条就切到那个房间、并滚动/高亮到那条消息。
 * 体量维护降级过的历史会标注"原文在归档里"，避免用户以为内容丢了。
 */
async function runSearch(rawQuery) {
  const query = String(rawQuery ?? "").trim();
  const status = $("search-status");
  const host = $("search-results");
  host.textContent = "";

  if (query.length < 2) {
    status.textContent = "输入至少 2 个字符开始搜索。";
    return;
  }

  status.textContent = "搜索中…";
  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=40`);
    if (!response.ok) throw new Error(`搜索失败：${response.status}`);
    const payload = await response.json();
    status.textContent = `找到 ${payload.total} 条${payload.total > payload.results.length ? `（显示前 ${payload.results.length} 条）` : ""}`;

    for (const hit of payload.results) {
      const item = document.createElement("li");
      item.className = "search-hit";

      const meta = document.createElement("div");
      meta.className = "search-hit-meta";
      const room = document.createElement("span");
      room.textContent = `#${hit.roomTitle ?? hit.roomId}`;
      const who = document.createElement("span");
      who.textContent = hit.agentName ?? (hit.role === "commander" ? "指挥官" : "成员");
      const when = document.createElement("span");
      when.textContent = hit.at ? fmtTime(hit.at) : "";
      meta.append(room, who, when);
      if (hit.stubbed) {
        const stub = document.createElement("span");
        stub.className = "search-hit-stub";
        stub.textContent = "归档";
        meta.append(stub);
      }

      const snippet = document.createElement("p");
      snippet.className = "search-hit-snippet";
      snippet.textContent = hit.snippet ?? "";

      item.append(meta, snippet);
      item.addEventListener("click", () => {
        void jumpToMessage(hit);
        $("search-dialog").close();
      });
      host.append(item);
    }
  } catch (error) {
    status.textContent = error.message;
  }
}

/** 跳转到某条历史消息：切房间 → 拉历史窗口 → 滚动并高亮。 */
async function jumpToMessage(hit) {
  try {
    if (hit.roomId !== state.activeRoomId) {
      if (!state.rooms.some((room) => room.id === hit.roomId)) {
        toast("这个频道已经不存在了", "error");
        return;
      }
      await selectRoom(hit.roomId);
    }
    const room = state.roomData.get(hit.roomId);
    if (!room) return;

    // 目标不在当前窗口里：先按历史分页往前找几页（最多 5 页，避免拖死）。
    let guard = 0;
    while (!room.messages.some((message) => message.id === hit.messageId) && room.hasMoreHistory && guard < 5) {
      guard += 1;
      await loadEarlierMessages(hit.roomId);
    }

    const target = document.querySelector(`[data-message-id="${CSS.escape(hit.messageId)}"]`);
    if (!target) {
      toast("这条消息在更早的历史里，可用「加载更早的消息」继续翻", "info");
      return;
    }
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    target.classList.add("search-flash");
    setTimeout(() => target.classList.remove("search-flash"), 1800);
  } catch (error) {
    toast(error.message, "error");
  }
}

// ══ 启动 ═══════════════════════════════════════════════════════════════════
async function init() {
  renderLiveFeed();

  try {
    const snapshot = await fetchState();
    applySnapshot(snapshot);
  } catch (error) {
    toast(`无法连接到指挥室服务：${error.message}`, "error");
    return;
  }

  renderRooms();
  renderMembers();
  renderStageHeader();
  renderTranscript();
  renderComposerTargets();

  if (state.activeRoomId) await ensureRoom(state.activeRoomId);
  renderRooms();
  scrollToBottom();

  // 输入区
  const input = $("input");
  input.addEventListener("input", () => {
    autoGrow(input);
    updateMentionBar();
  });
  input.addEventListener("blur", () => setTimeout(() => ($("mention-bar").hidden = true), 180));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void dispatch();
    }
  });

  $("composer").addEventListener("submit", (event) => {
    event.preventDefault();
    void dispatch();
  });

  $("abort-btn").addEventListener("click", async () => {
    const room = currentRoom();
    if (!room) return;
    await fetch(`/api/rooms/${encodeURIComponent(room.id)}/abort`, { method: "POST" }).catch(() => {});
    toast("已请求中止");
  });

  $("new-room-btn").addEventListener("click", openNewRoomDialog);
  $("new-member-btn").addEventListener("click", openNewMemberDialog);
  $("room-members-btn").addEventListener("click", openRoomMembersDialog);

  // 编辑成员
  $("edit-member-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveMemberEdits();
    $("edit-member-dialog").close();
  });
  $("em-cancel").addEventListener("click", () => $("edit-member-dialog").close());

  // 历史搜索
  $("search-btn").addEventListener("click", openSearchDialog);
  $("search-close").addEventListener("click", () => $("search-dialog").close());
  $("search-input").addEventListener("input", debounce(() => void runSearch($("search-input").value), 220));

  // Ctrl/Cmd+K 打开搜索
  window.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openSearchDialog();
    }
  });

  // 统计与队列：30 秒刷新一次，避免持续轮询
  setInterval(() => {
    void refreshStats();
    if (!state.activeRoomId) return;
    void fetch(`/api/state?room=${encodeURIComponent(state.activeRoomId)}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((snapshot) => {
        if (!snapshot) return;
        state.queue = snapshot.queue ?? null;
        state.warnings = snapshot.warnings ?? [];
        renderNoticeStrip();
        updateQueueBadge();
      })
      .catch(() => {});
  }, 30_000);

  $("live-toggle").addEventListener("click", () => {
    const panel = $("live-panel");
    panel.classList.toggle("collapsed");
    $("live-toggle").textContent = panel.classList.contains("collapsed") ? "+" : "−";
  });

  // 流式输出时若用户已在底部，就跟随；用户往上翻阅时不打扰。
  $("transcript").addEventListener("scroll", () => {
    state.followOutput = isNearBottom();
  });
  state.followOutput = true;

  // 窗口重新获得焦点时对账一次，防止长连接断过之后状态陈旧。
  window.addEventListener("focus", () => {
    if (!state.activeRoomId) return;
    void refreshRoomFromServer(state.activeRoomId);
  });

  // 周期性确认连接状态。
  setInterval(() => {
    const anyOpen = [...state.sources.values()].some((source) => source.readyState === EventSource.OPEN);
    $("conn-pulse").className = `brand-pulse ${anyOpen ? "online" : "offline"}`;
  }, 5000);
}

void init();
