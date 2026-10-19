# 指挥室 · Command Center

一个聊天软件形态的多智能体指挥室。你在群里下达指令，**DeepSeek、Claude、ChatGPT、Perplexity**
四位成员是你真实的执行者——他们会真的读写你的文件、改代码、联网检索，并把每一步动作实时汇报出来。

不是角色扮演，不是界面原型。

---

## 它是什么

```
        你（指挥官）
             │  下达指令
             ▼
   ┌──────────────────────┐
   │      指挥室服务       │  零依赖 Node，本地 HTTP + SSE
   └──┬────────┬────────┬─┘
      │        │        │      每位成员一个独立子进程
      ▼        ▼        ▼
  DeepSeek  Claude  ChatGPT  Perplexity
      │        │        │        │
      └────────┴───┬────┴────────┘
                   ▼
        你的工作区（真实文件、真实命令、真实检索）
```

- **私人聊天**：每位成员一个专属频道，一对一指挥。
- **群聊**：指令默认全员并行开工；用 `@名字` 点名则只派给指定成员。
- **结果优先的审阅视图**：思考过程与工具调用默认折叠成一行摘要
  （`思考 4188 字 · 动作 4 次 · ⚠ 失败 2 · 23.9s`），
  不展开就只看到结论；需要核实证据时点开即可看到完整思考与每次工具调用的输出。
  作业进行中该区域自动展开，方便盯进度；收工后自动收起，回到只看结果。
- **真实工具**：成员通过 DeepSeek Harness 的完整工具链工作——读写文件、改代码、
  检索文件内容、联网检索与抓取网页。
- **全程可见**：每一次工具调用及其输出、token 用量、耗时，都可在对话流里按需展开。
- **多轮记忆**：每位成员在每个频道里维护自己的会话，第二轮起能记住之前说过的事。

---

## 快速开始

### 桌面版（推荐）

双击桌面上的 **启动指挥室** 快捷方式（或项目里的 `启动指挥室.cmd`）。它会：

1. 若服务未运行，在后台静默拉起（进程完全脱离启动器，关掉启动窗口不影响）
2. 等端口就绪
3. 用 Chrome/Edge 的 app 模式打开**独立窗口**——无地址栏、无标签页，任务栏独立图标

浏览器配置是独立的（`runtime/browser-profile`），不会干扰你日常用的 Chrome。

排错时用 `启动指挥室.cmd --console`，会以可见窗口启动服务，日志直接可读。

### 浏览器版

服务在跑的前提下，直接用浏览器打开 <http://127.0.0.1:8787> 即可。

### 命令行

```powershell
node server/index.mjs
```

> **在 DSH 会话内运行指挥室时，请先把该会话切到「完全权限」**，否则成员无法执行命令、
> 也无法用全文搜索。切换方式：输入框里打 `/permission`。
> 原因见下方「前置条件」，这是 DSH 沙箱的嵌套限制，不是权限损坏。

从 DSH 会话内启动时，建议脱离会话以免继承沙箱限制：

```powershell
Start-Process node -ArgumentList "server\index.mjs" -WorkingDirectory . -WindowStyle Hidden
```

### 重新生成图标与快捷方式

```powershell
python scripts/make-icon.py                                          # 从调色板重建 icon.ico / icon.png
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/make-shortcut.ps1   # 重建桌面快捷方式
```

`make-shortcut.ps1` 刻意不接收中文参数——中文经 `-File` 传入时会被 Windows PowerShell 5.1
按 ANSI 解码而乱码。它改为自行发现项目根目录里唯一的 `.cmd` 作为启动器并据此命名。

图标是脚本画出来的（不是手搓 PNG）：深空紫底 + 霓虹六边形 + 三根均衡条，
1024 超采样后缩到 512 出 `public/icon.png`，再打包 256/128/64/48/32/24/16 七档成
`public/icon.ico`（浏览器标签页用），同时复制一份 `public/app-icon.ico` 给桌面快捷方式。
重跑两个脚本即换图标。

**图标这里有两个坑，改脚本前务必先读：**

1. **小尺寸帧必须是 BMP(DIB)，不能是 PNG。** `PIL.Image.save(format="ICO")` 会把每一帧都压成 PNG，
   而资源管理器只可靠支持 256×256 的 PNG 帧；更小的 PNG 帧会让**整个 ICO 解析失败**，
   桌面显示成"未知文件 + 快捷箭头"。所以 `scripts/make-icon.py` 里是手写的
   `write_ico()`：16–128 用 32 位 DIB 帧（BITMAPINFOHEADER + 自下而上 BGRA + AND 掩码），
   256 用 PNG 帧。改完用 `scripts/check-ico.ps1 -Ico public/icon.ico` 验证
   （`ExtractIconEx` 能取到图标才算 Windows 认这个文件）。
2. **快捷方式的 IconLocation 不能指向项目目录。** 项目在 Agent 沙箱里，目录被打上了
   低完整性标签和 `Everyone:(DC) DENY`，资源管理器**拒绝**从这里解析图标（实测同一个
   .ico 放在桌面能显示、放回项目里就退回通用图标）。所以 `make-shortcut.ps1` 会把图标
   复制到 `%LOCALAPPDATA%\CommandCenter\app-icon.ico` 再引用它。
   验证方法：`scripts\check-lnk-icon.ps1 -Lnk <快捷方式> -Out 图标.png` 取 shell 实际画的图标
   （走的是资源管理器同一条路径，比肉眼看桌面可靠）。

---

## 界面主题：赛博霓虹（NEON GRID）

整套皮肤是手写的，没有 UI 框架、没有构建步骤，改 `public/styles.css` 刷新即生效。

| 层 | 文件 | 作用 |
| --- | --- | --- |
| 背景动画 | [`public/bg.js`](public/bg.js) | canvas 实时绘制：6 团漂移等离子雾 + 上下浮动的光斑粒子 + 横向数据流 + 透视网格（地平线在 74% 高度，16 圈光环朝观察者涌来） |
| 静态质感 | [`public/styles.css`](public/styles.css) | 3px 扫描线、暗角、颗粒噪点、15s 斜向掠过光带——CRT 味道来自这几层 |
| 玻璃面板 | 同上（`--glass-*`） | 半透明 + `backdrop-filter`，让背景色团透上来，界面才是"活的" |
| 字体 | [`public/fonts/`](public/fonts/) | Orbitron（标题，几何科幻）与 Rajdhani（UI 数字/拉丁）已自托管，离线可用；中文回落微软雅黑 |

**颜色即语义**，不是随便发光：

| 变量 | 色值 | 含义 |
| --- | --- | --- |
| `--pink` | `#ff2ea6` | 指挥官 / 主操作 / 品牌 |
| `--cyan` | `#22e9ff` | 系统 / 运行中 / 焦点 |
| `--violet` | `#a382ff` | 过程 / 思考 / 次要信息 |
| `--lime` | `#9dff5b` | 成功 |
| `--rose` | `#ff3b6b` | 失败 / 中止 |

动效只挂在"正在发生的事"上：成员作业时头像/左光条呼吸、`@` 选中的 chip 发光、
输入框聚焦时一圈霓虹光沿着边框流动、标题栏下沿的渐变分界线缓慢流动、控制台标题的偶发色散抖动。
静态内容一律不动，避免长文阅读时晕。

> **输入框那圈光怎么做的**：用 `@property --ring-angle` 注册一个 `<angle>` 自定义属性，
> `conic-gradient(from var(--ring-angle), …)` 画渐变，再 `@keyframes` 只动这个角度。
> **千万别用 `transform: rotate()` 转伪元素**——那会把"输入框大小的圆角矩形"整个转起来，
> 聚焦时在对话区划出一个巨大的斜框（这个 bug 真出现过，见 `.composer::before` 的注释）。

### 想改配色

只改 `:root` 里的 5 个语义色即可，其余全部通过 `color-mix()` / `rgb(... / …%)` 派生。
面板的"薄"由 `--glass-1/2/3` 决定：调不透明显得更空灵，但正文对比度会下降。

### 视觉回归：怎么截图

指挥室挂着一条永不结束的 SSE 连接，`msedge --headless --screenshot` 会一直等"加载完成"而挂死。
用自带脚本走 DevTools 协议：

```powershell
node scripts/screenshot.mjs .shots/ui.png --width 1600 --height 1000 --wait 3000
node scripts/screenshot.mjs .shots/modal.png --click "#room-members-btn"      # 打开对话框再截
node scripts/screenshot.mjs --eval "document.title"                            # 只取值，不出图
node scripts/screenshot.mjs .shots/hi.png --scale 2                            # HiDPI 细节检查
```

截图产物放 `.shots/`（临时目录，不进版本库）。

### 为什么作业时曾经"闪烁"，现在怎么保证不复发

用户反馈过「作业时聊天界面和实时动态一直在闪」。根因不是 CSS 动画本身，而是**动画被反复重播**：

| 症状 | 根因 | 修法 |
| --- | --- | --- |
| 成员回话整块淡入又淡入 | `refreshMessage()` 每个 SSE 增量都 `node.replaceWith(renderReply(...))`，`.reply` 上的 `rise` 动画跟着重播（一轮 60+ 次） | `refreshMessage()` 只替换 `.reply-main`，保留外壳；`.reply` 的动画移到 `.reply.enter`，只有真正新消息才挂 `enter` |
| 实时动态整列闪 | `pushLive()` 每次清空 `<ul>` 重建，每条的 `rise` 全部重播 | 抽出 `buildFeedItem()`，新条目 `prepend` 并只给它加 `.enter`，超过 90 条删尾部 |
| 整屏历史一起淡入 | `renderTranscript()` 每条指令都重建所有回话 | 重建前记下 `alreadyShown` 的 `data-message-id`，只给不在其中的回话加 `enter` |
| 流式刷新过密 | 每个事件一次重绘（含 Markdown 解析） | `scheduleMessageRefresh()`：按帧合并 + `messageSignature()` 签名不变就跳过 |
| 频道高亮/成员行偶尔闪一下 | 每次 busy、`agent_start`/`agent_end` 都重建整个侧栏，`.room-item.active` 的 sheen、`.member.working` 的呼吸条跟着重播 | `renderRooms()` / `renderMembers()` 先算内容签名，和 `state.renderCache` 一样就直接返回，不碰 DOM |
| 主线程被背景吃掉 | 6 团雾每帧各铺满一次全屏 + `backdrop-filter` 压在动画 canvas 上 | 雾层画在 1/2 分辨率离屏画布再一次性放大合成；dpr 上限 1.35、目标 32fps；玻璃模糊半径减半 |

改动前后用同一段脚本量的数字（headless Edge，同一条 `@DeepSeek` 指令，26–33s 窗口）：

| 指标 | 修复前 | 修复后 |
| --- | --- | --- |
| `rise` 动画次数 | 60 | 4–11（只等于新出现的条目数） |
| `#live-feed` DOM 变更 | 42 | 4–11 |
| 一轮作业里的长任务（>50ms） | ~150 条，每条 90–200ms | 2–68 条（关掉背景动画后只剩 2 条，说明剩余开销是软件光栅化整页重绘，真实 GPU 上更轻） |

想复测就重新量一遍，别靠肉眼判断：

```powershell
node scripts/measure-flicker.mjs                 # 一轮真实作业：动画次数 / DOM 变更 / 长任务
$env:KEEP_BG_PAUSED=1; node scripts/measure-flicker.mjs   # 整轮关掉背景，分离"canvas 重绘"与"DOM 更新"
node scripts/probe-paint.mjs                     # 逐层关掉 blend / backdrop-filter / sweep，看谁最贵
```

> 这些脚本会**真的发一条指令**给成员，跑完记得清掉测试话术留下的消息：
> `node scripts/prune-test-turns.mjs --dry` 先看要删哪些（整句精确匹配，不会误删你自己的指令），
> 确认后停服务再 `--apply`（store 是单文件，运行中改会被下次存档覆盖）。

---

## 成员名册

| 成员 | 定位 | 特长 |
| --- | --- | --- |
| **DeepSeek** | 总执行 · 快反 | 动手快，直接落地任务，汇报固定为「做了什么 / 产出在哪 / 风险」 |
| **Claude** | 审阅官 · 深度分析 | 先想清楚再动手，按严重程度列问题，是最后一道防线 |
| **ChatGPT** | 工程实现 · 方案设计 | 把模糊需求变成可执行方案，讲清技术取舍 |
| **Perplexity** | 情报官 · 联网检索 | 必先检索、每条事实附真实链接、绝不编造来源 |

人格与职责定义在 [`server/agents.mjs`](server/agents.mjs)。改这个文件就能调整成员行为，
服务重启时会把新人格重新编译进各自的 DSH profile。

### 命令写法

```
修一下登录接口的空指针                     → 群里默认全员并行开工
@Claude 审一下刚才的改动                   → 只派给 Claude
@Perplexity @ChatGPT 查一下这个库的现状     → 同时派给两位
```

---

## 成员管理（新建 / 拉入群聊 / 删除）

成员不再是写死在代码里的常量，而是**可持久化的数据**：

- **内置成员**（DeepSeek / Claude / ChatGPT / Perplexity）：随项目发布，带完整人格，**不可删除**。
  定义在 [`server/members.mjs`](server/members.mjs) 的 `BUILTIN_MEMBERS`。
- **自定义成员**：在界面上新建，存进 `data/members.json`，可增可删可改。

### 界面上怎么用

| 操作 | 入口 |
| --- | --- |
| 新建成员 | 左栏「成员」标题旁的 **＋** |
| 拉人进群聊 / 把人移出 | 对话区右上角的 **成员** 按钮 |
| 删除自定义成员 | 通过 `DELETE /api/members/:id`（内置成员会拒绝） |

新建时选**接入方式**，共 5 种：

| 接入方式 | 能动手？ | 说明 |
| --- | --- | --- |
| `dsh` | ✅ | 内置 DeepSeek 路由，零配置 |
| `claude-cli` | ✅ | 真实 Claude Code CLI |
| `codex-cli` | ✅ | 真实 Codex CLI |
| `openai-api` | ❌ 纯对话 | 任何 OpenAI 兼容端点（DeepSeek/GLM/Kimi/通义/Ollama…） |
| `anthropic-api` | ❌ 纯对话 | Anthropic Messages 格式 |

**纯对话是刻意的能力边界**：API 只回文本，不会读写文件、不会执行命令。
需要动手的成员请选前三种。

### API 成员的密钥怎么存

密钥**不进** `members.json`（那是成员定义，可能被分享），而是写进 `secrets.json`：

```json
{
  "apiKeys": { "<成员id>": "sk-..." },
  "apiKeysByHost": { "api.deepseek.com": "sk-..." }
}
```

按 `apiKeysByHost` 可以给同一域名的多个成员复用一把密钥。
`secrets.json` 已被 `.gitignore` 忽略。界面上只显示 `hasApiKey: true/false`，**永远不回显密钥**。

### 新建成员后不用重启

- **DSH 后端**：派活前会按需补生成该成员的 profile（不补会 `exit 1`，实测确认过）。
- **API 后端**：无状态，每次请求从房间历史重建上下文（只重放它自己的回答，不重放别人的，
  否则它会开始扮演其他成员）。
- **成员 id** 一律转成 **ASCII 安全** 形式：中文名会变成 `member-<短哈希>`，
  因为它要进 URL、文件名和 profile 目录名。

### REST 接口

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/members` | 成员列表 + 可用接入方式 |
| `POST` | `/api/members` | 新建成员 |
| `PATCH` | `/api/members/:id` | 修改自定义成员（名字/职责/人格/API 参数/密钥） |
| `DELETE` | `/api/members/:id` | 删除自定义成员（内置受保护） |
| `POST` | `/api/rooms/:id/members` | 把成员拉进频道 |
| `DELETE` | `/api/rooms/:id/members/:agentId` | 把成员移出频道 |

回归测试：`node scripts/test-member-flow.mjs`
（覆盖 新建 → 拉群 → 派活 → 失败可读 → 移出 → 删除 → 内置受保护）。

---

## 能力开关（GitHub / 维基百科）

成员是「谁来做」，**能力是「这次优先查哪里」**，两者正交、可组合：

```
@GitHub 看看 react 是怎么实现调度的          → 全员，且优先查真实代码
@维基 介绍一下量子纠缠                       → 全员，且优先查维基条目
@Claude @GitHub 帮我看这个库的实现           → Claude，且优先查代码
```

界面上它们和成员 chip 并列显示（虚线框区分），`@` 提示条里也一并补全。
派发后开关自动复位，避免下一句无意间继续沿用。

### 它到底做了什么

不是给成员加外挂工具，而是**前置一段指令**，要求成员换一条数据来源，并附上
**实测可用的接口地址**——这样成员用已有的联网工具就能真取到数据，而不是靠
训练记忆猜。指令正文里还写了两条实测教训：

- GitHub 的 `/search/code` **无令牌返回 401**，不要反复重试，改用「取文件树 + 抓原始文件」
- 维基百科**国内直连不通（实测 000），必须经代理**；所以指挥室给成员进程统一注入了
  `HTTPS_PROXY`。成员若取不到，应报告「网络/代理问题」，**不得断言「维基上没有这个条目」**

### Claude 成员的出网权限（已解决）

`Claude` 成员走真 Claude Code，而它的权限优先级是
`deny > allow > ask > 默认模式`，并且**同一条规则同时出现在 allow 和 ask 时取更严格的 ask**。
本机原先把下面 5 条放在 `permissions.ask` 里，headless 模式没有交互通道，于是联网工具**一律被拒**：

```
WebFetch(domain:*)   Bash(curl *)   Bash(wget *)   PowerShell(curl *)   PowerShell(wget *)
```

实测过的无效手段（都失败，别再试）：`--permission-mode bypassPermissions`、
`--allowedTools`、`--dangerously-skip-permissions`、`--settings` 追加 allow。

**解决办法**：把这 5 条从 `ask` 移到 `allow`。已用
[`scripts/fix-claude-permissions.mjs`](scripts/fix-claude-permissions.mjs) 完成：

```powershell
node scripts/fix-claude-permissions.mjs           # 干跑，只看计划
node scripts/fix-claude-permissions.mjs --apply    # 真正写入（自动备份 + 逐条校验）
```

脚本会先备份带时间戳的副本，只移动这 5 条，然后**逐条证实**其余 483 条与
`deny`、以及 `permissions` 之外的所有顶层字段一字未动；任何一项对不上就自动回滚。

修复后实测：Claude 成员通过指挥室的 GitHub 能力开关取到 `facebook/react` 的真实
`stargazers_count` 与 `default_branch`，`permission_denials = 0`。

> 副作用（如实说明）：你自己在 Claude Code 里访问任意网页、跑 `curl`/`wget` 也不再逐次询问。
> 危险操作的 `deny` 列表（`.env`、密钥文件、`rm -rf /` 等 71 条）**完全不受影响**。

### 代理：活着才注入

Claude Code / Codex 不读系统代理，只认环境变量。但**注入一个已经关掉的代理比不注入更糟**——
成员的联网请求会去连死端口，连本来能直连的站点也一起失败（实测：代理关掉后维基与 DeepSeek 双双 000）。

所以 [`server/backends.mjs`](server/backends.mjs) 的 `startProxyWatch()` 每 20 秒探测一次代理端口，
只在真的在监听时才注入 `HTTPS_PROXY`。启动横幅会如实显示：

```
▸ 代理      可用（http://127.0.0.1:7897）
▸ 代理      不可用（http://127.0.0.1:7897，成员将直连）
```

**含义**：代理关着时，GitHub（直连可用）照常；维基百科这类必须走代理的站点会失败——
这是网络事实，不是配置错误。

---

## 配置

改 [`cc.config.json`](cc.config.json)，重启服务生效。关键项：

| 字段 | 说明 |
| --- | --- |
| `host` / `port` | 监听地址，默认 `127.0.0.1:8787`（仅本机可访问） |
| `workspace` | 成员动手的根目录，也是沙箱允许写入的范围 |
| `dshHome` | 成员进程的 `$DSH_HOME`。**必须位于工作区内**，见下方「设计取舍」 |
| `dshCli` | `dsh` 命令行入口，通常无需改动 |
| `credentialsSource` | DeepSeek Harness 的登录凭据目录，启动时自动同步 |
| `permissionMode` | `workspace-write`（默认，只能在 workspace 内写）或 `danger-full-access` |
| `defaultModel` | 成员使用的模型，默认 `deepseek-flash` |
| `optionalBackends` | 可选：填入厂商 API Key 即可切换真实厂商后端 |

### 关于权限模式

默认 `workspace-write`：成员只能在你指定的 `workspace` 目录内写入，越界操作会被沙箱拒绝并在界面上标红。

改成 `danger-full-access` 会让成员可以写整台机器的文件，**请自行评估风险**。

### 关于模型来源

成员默认走**本机已登录的 DeepSeek 账号路由**，因此开箱即用、无需任何 API Key。

DSH 的 `dsh-base` 同时挂载了两个 DeepSeek 适配器，默认指向需要 `DEEPSEEK_API_KEY` 的那个，
而指挥室生成的 profile 会把它改指到账号版适配器——这是四位成员能零配置跑起来的原因。

想接真实厂商后端，在 `optionalBackends` 里填 Key 即可（`openai` / `anthropic` / `perplexity`）。

---

## 自检

内置自检会真的派活给成员、让它创建文件、读取文件内容做比对，以此证明「指令 → 真实动手 → 产出落地」这条链路是通的。

```powershell
node scripts/selfcheck.mjs            # 检查 DeepSeek
node scripts/selfcheck.mjs claude     # 检查指定成员
```

通过时会输出成员的真实最终回复与工具调用轨迹。**失败即说明链路有问题，不是「大概能用」。**

其他诊断脚本：

| 脚本 | 用途 |
| --- | --- |
| `scripts/probe-events.mjs` | 订阅事件流，逐帧打印服务端推送，排查界面不更新 |
| `scripts/probe-concurrency.mjs` | 并行/错峰启动多位成员，复现沙箱临时授权失败 |
| `scripts/probe-spawn.mjs` | 探测当前环境允许哪些子进程启动方式 |
| `scripts/probe-launch-modes.mjs` | 对比成员进程的两种启动方式 |
| `scripts/probe-file-stdio.mjs` | 验证「输出重定向到文件」这一取流策略 |
| `scripts/test-retention.mjs` | 体量控制回归：归档无损、降级不丢消息、窗口/分页/历史预算 |

---

## 长期使用的体量控制

聊天记录会一直长，而**每条工具调用的完整输出**是最占地方的部分。实测过一个只用了几天的
库：194 条消息占 254 万字、`store.json` 3.5 MB、1860 个内容块、最大单条消息 152 KB。
不治理的话，"越用越慢"是必然的。

现在分四层处理（参数集中在 `server/retention.mjs` 的 `RETENTION`）：

| 层 | 做什么 | 位置 |
| --- | --- | --- |
| 写入 | 单个工具输出超 600 字就截断并标注被截了多少 | `server/orchestrator.mjs` |
| 落盘 | 超过 30 轮的旧消息**先 gzip 归档再降级**为正文摘要 | `server/retention.mjs` |
| 传输 | `/api/state` 只发最近 40 条；更早的走分页接口 | `server/http.mjs` |
| 会话 | API 成员重放历史按 24000 字预算从近往远装 | `server/api-backend.mjs` |

几个必须知道的点：

- **归档在 `data/archive/<房间>-<时间>.jsonl.gz`**，是完整的原始消息。降级只改变内存/存档里的
  展示形态，原文永远能从这里找回。
- **归档失败就不降级**。宁可继续占空间，也不会在归档没写成功的时候丢掉历史。
- 界面只在最近 40 条里翻，超出后会显示「加载更早的消息」按钮，按需分页拉取。
- 房间体量偏大时，频道标题旁会显示 `N 条 · X MB`，点开能看到具体块数。
- 启动时和运行中每 5 分钟各跑一次维护，自动清孤儿 `.tmp`、轮转日志。
- 上面治的是**存档与传输**。成员的 DSH 会话历史也会越滚越长（每轮都要重放旧上下文，
  这是 token 变多的另一半原因）。界面上「本频道成员」对话框里有「清空上下文」——
  点一下该成员所有房间的会话清零，它下次回复从零开始，代价是不记得之前聊过什么。
  接口：`POST /api/agents/:id/session/reset`。
- 想验证策略没写坏（比如别再出现"压缩时误删数据"）：`node scripts/test-retention.mjs`。

实测效果（同一个真实库）：

| 指标 | 之前 | 之后 |
| --- | --- | --- |
| `store.json` | 3.62 MB | 1.58 MB |
| `/api/state` 单次传输 | 2.5 MB | 85 KB |
| 孤儿 `.tmp` | 3 个 / 9.3 MB | 0 |

---

## 设计取舍

这些不是随手的选择，都是在本机实测后定下的。

### 为什么要自己写 Markdown 渲染

界面要求离线可用、零依赖。引入 `marked` 要么上 CDN、要么加构建步骤。自写的渲染器
**先把原文整体 HTML 转义、再做结构化替换**，因此模型输出里的 `<script>` 只会作为纯文本显示。

### 为什么 `$DSH_HOME` 必须放在工作区内

成员进程由指挥室启动，而 DSH 的文件沙箱只允许写工作区。若把 `$DSH_HOME` 指向 `~/.dsh`，
成员进程启动时就会因 `mkdir` 被拒而直接崩溃（`EPERM: operation not permitted`）。
因此指挥室在工作区内自建 `$DSH_HOME`，并在启动时把登录凭据同步进去。

### 为什么输出走文件而不是管道

本机环境的沙箱**禁止子进程使用管道**：任何 `stdio: 'pipe'` 的 `spawn` 都会 `EPERM`，
连 spawn `node` 自身都不例外（见 `scripts/probe-spawn.mjs` 的实测结果）。
但文件描述符重定向可用，所以改成「子进程写日志文件、父进程增量读取」——
成员的 JSON 事件流本来就是只追加的，天然适合这种读法。

### 为什么不能直接 spawn `dsh.cmd`

两个叠加的原因：

1. Node 从 v20 起（CVE-2024-27980 的修复）拒绝直接 spawn `.cmd`/`.bat`（报 `EINVAL`）；
   而 `shell: true` 会把参数拼成命令行字符串，让带空格和换行的任务文本失去保护。
2. `dsh.cmd` 内部引用的 CLI 脚本位于 `app.asar` **归档内部**，文件系统 API 看不到它，
   不能用 `existsSync` 做预检——但 Electron 自己能把 asar 当目录读。

因此 `server/launcher.mjs` 解析 `.cmd` 内容，取出启动器与 CLI 脚本两条路径，
再以 `ELECTRON_RUN_AS_NODE=1` 直接运行它们，参数原样传递、不经过 shell。

### 前置条件：DSH 会话不能处于受限沙箱内

成员的进程类工具（`pwsh`、`glob`、`grep`）能否工作，取决于**指挥室服务所在的 DSH 会话是否启用沙箱**。

| 指挥室服务的运行位置 | 文件读写 | 联网检索 | 执行命令 / 全文搜索 |
| --- | --- | --- | --- |
| DSH 会话内，会话为「工作区内修改」 | ✓ | ✓ | ✗ 授权物化失败 |
| DSH 会话内，会话为「完全权限」 | ✓ | ✓ | ✓ |
| DSH 之外（双击 `启动指挥室.cmd`） | ✓ | ✓ | 未完整验证 |

失败时的报错是：

```
sandbox-local windows-acl temp grant materialization failed and its cleanup also failed
```

**这不是工作区的文件权限损坏。** 用 `diagnose-windows-sandbox-acl` 技能对工作区做过一次完整诊断，
结论是 `NOT_THIS_CLASS`：路径上 `WRITE_DAC` / `WRITE_OWNER` 均可用、没有任何 AppContainer
包允许项（`FIXED=0 GRANTED=0`）。真正的原因是 **DSH 的沙箱无法为自己的子进程物化临时文件授权**——
指挥室服务是 DSH 的子进程，它拉起的成员是"孙进程"，嵌套后授权链路断开。

#### 决定因素是会话，不是 cc.config.json

这一点做过变量分离实验，结论明确：

- 会话为「工作区内修改」时，无论 `cc.config.json` 怎么设，成员的 `pwsh`/`glob` 都失败。
- 会话为「完全权限」时，**即使强制成员用 `workspace-write`，四位成员也全部正常**。

所以 `cc.config.json` 里的 `permissionMode` **不是**这里的开关（它只管成员进程自己的沙箱宽严，
用于指挥室脱离 DSH 运行的场景）；**真正的开关是 DSH 会话的权限模式**。

#### 成员如何得知自己的权限边界

成员**无法自行查询**沙箱模式：DSH 会消费掉 `DSH_PERMISSION_MODE`，不透传给它启动的 shell。
早期版本因此出过一次事故——环境修好后成员仍拿着过期的能力自评说话。

现在的做法是双保险：

1. **注入事实**：指挥室在生成 profile 时，把当前沙箱模式与工作区写进成员的 system prompt
   （见 `server/agents.mjs` 的 `runtimeFacts()`），并明确要求它不要沿用此前的自评。
2. **可自查**：同时传入不带 `DSH_` 前缀的 `CC_PERMISSION_MODE` / `CC_WORKSPACE`，
   成员读得到、能当场核实。

另外，profile 内容有变化时启动会**自动重置该成员的会话**——system prompt 一旦注入历史就固化了，
不清会话它会继续按旧提示作答。日志里会打印 `▸ 配置变更  Claude 的会话已重置`。

#### 让每个新会话默认就是完全权限

这是唯一需要你手动做一次的设置：

> 在 DSH 里打开 **设置 → 通用**，把「**新会话默认权限**」选为 **完全权限**。

改完之后新建的会话都默认带完整权限，不必每次打 `/permission`。两点注意：

- **设置 → 通用**影响的是**新会话**；`/permission` 影响**当前会话**。改错了地方就会出现
  "明明切了却还报错"。
- `desktop` profile 由 Electron 应用独占管理，**不能**直接编辑
  `~/.dsh/profiles/desktop/cordis.patch.yml` 来达成这件事（命令行会拒绝加载该 profile）。

#### 其他

- **成员之间不直接对话**：目前由你显式派发。规划中的「成员互评」需要额外的编排语义。
- **单用户本机服务**：没有鉴权，默认只绑定 `127.0.0.1`。请勿暴露到公网。

---

## 目录结构

```
command-center/
├── cc.config.json          运行时配置
├── 启动指挥室.cmd           一键启动
├── server/
│   ├── index.mjs           入口：自检 → 生成 profile → 启动服务
│   ├── config.mjs          配置加载与路径解析
│   ├── agents.mjs          成员名册（人格 / 职责 / 能力边界）
│   ├── profiles.mjs        把名册编译成 DSH profile
│   ├── launcher.mjs        解析成员进程的启动方式
│   ├── runner.mjs          派发一次任务，把事件流翻译成归一化事件
│   ├── orchestrator.mjs    指令解析（@点名 / 全员）、并行派发
│   ├── store.mjs           房间与消息的持久化
│   └── http.mjs            HTTP 服务 + SSE 事件总线
├── public/                 前端（原生 ES module，无构建步骤）
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── scripts/                自检与诊断脚本
├── data/                   运行时数据（房间、消息、运行日志）
└── runtime/dsh-home/       成员进程的 $DSH_HOME（含生成的 profile 与会话）
```

---

## 排错

**界面显示「无法连接」** — 服务没起来。双击 `启动指挥室.cmd` 看报错。

**成员一动手就报 `ACCOUNT_SIGN_IN_REQUIRED`** — 登录态没同步过去。打开 DeepSeek Harness
桌面版确认已登录，然后重启指挥室（启动时会自动同步凭据）。

**成员卡在「作业中」不动** — 先用 `node scripts/probe-events.mjs` 看事件流是否正常。
若事件正常但界面不动，刷新页面。

**改了 `server/agents.mjs` 没生效** — profile 在启动时生成，需要重启服务。

**`grep` 搜整个 `command-center` 目录时直接报 `exit 2`** — 这不是权限故障，也不是沙箱问题。
`runtime/browser-profile/` 是界面用的 Chrome 配置目录，浏览器运行期间会独占
`Cookies` / `LOCK` / `Sessions_*` 等文件，ripgrep 读不到就整条命令失败（`os error 32/33`），
**不会返回任何命中**。最小侵入的解法已经在仓库里落地：`command-center/.ignore`
里写了一条 `runtime/browser-profile/`，ripgrep 会自动跳过该目录。
若你换了检索工具（或用了 `--no-ignore`），需要自行排除该目录。

**想清空所有对话** — 停掉服务，删除 `data/store.json`。

**桌面快捷方式图标没变 / 显示成未知文件** — 按顺序查：
1. 重新生成 ICO：`python scripts/make-icon.py`，再用 `scripts\check-ico.ps1 -Ico public\icon.ico -Out x.png`
   确认 Windows 能解析（小尺寸帧写成 PNG 时会整包失败）；
2. 重跑 `scripts\make-shortcut.ps1`（它会把图标复制到 `%LOCALAPPDATA%`，并调用 `ie4uinit.exe -show` 刷缓存）；
3. 还不行就用 `scripts\check-lnk-icon.ps1 -Lnk "<快捷方式>" -Out x.png` 看 shell 实际画的是什么，
   通用图标说明 IconLocation 没被解析（最常见是图标又指回了项目目录）。

**输入框下方冒出白色建议条** — 那是 Edge 的表单历史/自动填充气泡，不是界面元素。
`#input` 上已加 `autocomplete="new-password"`（`off` 会被 Edge 忽略，`new-password` 是通用强抑制写法）
与 `spellcheck="false"`。若仍然出现，是浏览器设置里的「自动填充」开着，与本项目无关。
