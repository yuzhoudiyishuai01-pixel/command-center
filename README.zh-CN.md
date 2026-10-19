# 指挥室 / Command Center

一个跑在本机的**多智能体聊天室**：你把指令发进频道，几个 AI 成员同时开工——真的读写文件、
执行命令、联网检索，过程在界面上实时可见。

**成员由你自己定义**：接 OpenAI / Anthropic 兼容的聊天 API，或接本机已登录的 CLI
（DeepSeek Harness / Claude Code / Codex）。零依赖、无构建步骤，克隆下来 `npm start` 就能用。

> English README: [README.md](README.md)

## 快速开始

```powershell
git clone <repo> command-center
cd command-center
npm start
```

首次启动会：

1. 把 [`seeds/members.seed.json`](seeds/members.seed.json) 播种成 `data/members.json`（四个示例成员）；
2. 生成访问 token 到 `data/.token`；
3. 打印一个带 token 的网址，并在浏览器里打开。

打开那个网址即可（之后浏览器会记住 cookie，普通书签也能进）。然后就可以改名、改人格，
或者直接删掉示例成员，换成你自己的。

Windows 也可以双击 `启动指挥室.cmd`：它会启动服务并开一个带 token 的独立窗口。

## 成员

| 接入方式 | 能动手 | 需要什么 |
| --- | --- | --- |
| `dsh` | 读写文件 / 命令 / 联网 | 装 DeepSeek Harness（`dsh` CLI） |
| `claude-cli` | 读写文件 / 命令 / 联网 | 已登录的 `claude` |
| `codex-cli` | 读写文件 / 命令 | 已登录的 `codex` |
| `openai-api` | 纯对话 | baseUrl + model + API key |
| `anthropic-api` | 纯对话 | baseUrl + model + API key |

界面上点成员旁边的 ✎ 可改人格，✕ 可删除（示例成员同样可删）。
名册存在 `data/members.json`，删掉该文件重启即重新播种。

API 密钥存在 `secrets.json`（已 gitignore），不会进成员定义，也不会回显到浏览器。

## 安全

- 服务默认只监听 `127.0.0.1`，并启用共享 token 鉴权。
- CLI 成员**以你的操作系统权限执行命令**，先想清楚再给它任务；需要限制就用 CLI 自己的权限配置。
- 想对外暴露：务必保留鉴权，并放在带 TLS 的反向代理后面。`"auth": false` 只适合完全可信的单机。

配置项、环境变量、架构说明、测试命令和排错表都在英文 [README.md](README.md) 里；
本项目演进过程中的实测记录与运维细节见 [`docs/OPERATIONS.zh-CN.md`](docs/OPERATIONS.zh-CN.md)。

## 许可

MIT，见 [LICENSE](LICENSE)。
