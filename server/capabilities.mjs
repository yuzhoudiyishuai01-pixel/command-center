/**
 * 能力开关（Capability toggles）。
 *
 * 与「成员」的区别：成员是"谁来做"，能力是"这次优先用什么手段做"。
 * 两者正交，可以组合：`@Claude @GitHub 帮我看这个库怎么实现的`。
 *
 * 设计要点：每个能力不只是给成员一句"请你优先查 X"——那样成员可能根本没有
 * 可用的数据入口，只能靠训练记忆瞎猜。所以每个能力都附带**实测可用的接口**，
 * 让成员用自己已有的工具（联网抓取 / 执行命令）真正拿到数据。
 */

export const CAPABILITIES = [
  {
    id: "github",
    label: "GitHub",
    icon: "GH",
    accent: "#8b949e",
    // 触发词：用户可以直接手打 @GitHub
    aliases: ["github", "gh"],
    blurb: "优先查真实代码、issue、PR 与仓库元数据",
    instruction: `本轮优先使用 GitHub 获取**真实代码与仓库事实**，不要凭记忆描述第三方库的实现。

可用的公开接口（用你的联网抓取或命令工具直接调）：
- 仓库元数据 / 默认分支：https://api.github.com/repos/OWNER/REPO
  （**必须跟随 301 跳转**，否则 React 这类仓库会返回 301 而不是内容）
- 目录列表：https://api.github.com/repos/OWNER/REPO/contents/PATH
- 单个文件内容：https://api.github.com/repos/OWNER/REPO/contents/PATH
- 读取整个文件树：https://api.github.com/repos/OWNER/REPO/git/trees/BRANCH?recursive=1
- 取原始文件：https://raw.githubusercontent.com/OWNER/REPO/BRANCH/PATH
- 仓库搜索：https://api.github.com/search/repositories?q=TERM
- issue / PR：https://api.github.com/repos/OWNER/REPO/issues?state=all
- 提交历史：https://api.github.com/repos/OWNER/REPO/commits?per_page=20

**代码搜索不可用**（实测）：https://api.github.com/search/code 无令牌时返回 401。
不要反复重试它——改用「取文件树 + 抓原始文件」的办法定位实现。

纪律：
- **没有取到原文件，就不要描述它的实现**。凭印象说"它内部大概是用 X 实现的"是禁止的。
- 引用代码时给出**可点开的链接**与**文件路径 + 行号**，便于复核。
- 未认证的 GitHub API 限流较低，取到需要的内容就停，不要无脑遍历。`,
  },
  {
    id: "wikipedia",
    label: "维基百科",
    icon: "W",
    accent: "#c8ccd1",
    aliases: ["wikipedia", "wiki", "维基", "维基百科"],
    blurb: "优先查维基百科条目，带条目链接与版本信息",
    instruction: `本轮优先使用维基百科获取**可引用的背景事实**，并明确区分"条目原文"与"你的推断"。

可用的公开接口（无需密钥，用你的联网抓取工具直接调）：
- 中文搜索：https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=TERM&format=json&utf8=1
- 英文搜索：https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=TERM&format=json&utf8=1
- 取摘要（含直达链接）：https://zh.wikipedia.org/api/rest_v1/page/summary/TITLE
- 取正文纯文本：https://zh.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&titles=TITLE&format=json&utf8=1
- 取页面链接与元数据：https://zh.wikipedia.org/w/api.php?action=query&prop=info&inprop=url&titles=TITLE&format=json&utf8=1

**关于代理（实测，务必知道）**：zh.wikipedia.org / en.wikipedia.org 在本机**直连不通**，
必须经代理才返回 200。指挥室已经给成员进程注入了 HTTPS_PROXY，所以正常情况下直接抓即可；
若你偏偏遇到连接失败，**不要断言"维基百科上没有这个条目"**——那是网络问题，
如实报告"取不到，疑似网络/代理问题"。

纪律：
- 每条关键事实后面给出**具体条目链接**（形如 https://zh.wikipedia.org/wiki/條目名）。
- 维基百科是**二次来源**：涉及争议话题时，如实说明条目本身存在争议或标注了"来源请求"。
- 检索不到条目时直接说"维基百科没有这个条目"，不要用推测填空。
- 中文站点会做简繁转换：查询用简体可能返回繁体条目名，**按返回原样报告**，不要擅自"纠正"。`,
  },
];

/** 按 id 取能力定义。 */
export function capabilityById(id) {
  return CAPABILITIES.find((capability) => capability.id === id);
}

/** 给界面用的公开信息（含提示词正文会被剥掉，避免把指令发到浏览器）。 */
export function publicCapabilities() {
  return CAPABILITIES.map(({ id, label, icon, accent, blurb, aliases }) => ({
    id,
    label,
    icon,
    accent,
    blurb,
    aliases,
  }));
}
