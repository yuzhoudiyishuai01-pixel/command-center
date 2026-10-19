# Command Center

A local, **zero-dependency** chat room where you dispatch work to several AI agents at once.
Members are **yours to define**: connect any OpenAI-compatible or Anthropic-compatible chat API,
or a CLI you already have installed and logged in (DeepSeek Harness, Claude Code, Codex).

You type an instruction, they actually do the work — reading and writing files, running commands,
searching the web — and the room shows every thinking step, tool call and token count live.

```
你 (commander)                     ┌─ DeepSeek  (CLI, has tools)
   │  "@Claude review the diff"     ├─ Claude    (CLI, has tools)
   ▼                                ├─ Researcher (OpenAI-compatible API)
┌──────────────────────────────┐    └─ Analyst   (Anthropic-compatible API)
│  room  #command  (SSE live)  │ ◄────────── each agent streams its own reply
│  transcript · live feed      │
└──────────────────────────────┘
```

## Highlights

- **Chat-room UX, real execution.** Group rooms broadcast to every member in parallel;
  `@name` targets specific members. Private rooms are 1:1.
- **Any backend you can reach.** `dsh` / `claude-cli` / `codex-cli` for tool-capable agents,
  `openai-api` / `anthropic-api` for plain chat models.
- **No build step, no npm dependencies.** Node's built-in `http`, SSE, and plain ES modules.
  Clone → `npm start`.
- **Shared-token auth on by default**, bound to `127.0.0.1`. Never exposed by accident.
- **Built to survive long use**: per-room append-only journal storage, context budgets,
  ageing/archiving of old turns, a per-member turn queue with timeouts, structured event logs,
  `GET /api/stats`, full-text search across rooms, and SSE resume after reconnect.

## Requirements

- **Node.js 20+** (tested on 20, 22 and 24; Windows, macOS, Linux).
- One or more of, optionally:
  - [DeepSeek Harness](https://github.com/) desktop app (`dsh` CLI) — or leave it out and use API members only;
  - `claude` (Claude Code CLI), `codex` (Codex CLI) — if you want them as members;
  - an API key for any OpenAI- or Anthropic-compatible endpoint.

## Quick start

```bash
git clone https://github.com/your-name/command-center.git
cd command-center
npm start          # starts the server and opens the browser
```

The first start creates `data/` with an **empty member roster** (by design) and prints a URL like:

```
界面      http://127.0.0.1:8787/?token=Q8t...   ← open this
访问令牌  data/.token
```

Open that URL once — the browser keeps a cookie, so bookmarks without the token also work
afterwards. Then **add your first member**: an OpenAI/Anthropic-compatible API, or a CLI you
already have installed and logged in. Nothing is pre-configured; you bring the members.

> `npm start` uses `bin/command-center.mjs`, which opens the browser for you.
> In a container or over SSH use `npm run serve` (no browser) — the URL is printed at startup.

### Windows

Double-click `启动指挥室.cmd`: it starts the service if needed and opens an app-mode window
with the token already in the URL.

## Adding members

Click **＋** next to *成员 / Members*, or `POST /api/members`:

```jsonc
// OpenAI-compatible endpoint
{
  "name": "Researcher",
  "role": "情报官 · 联网检索",
  "backend": "openai-api",
  "baseUrl": "https://api.deepseek.com/v1",
  "model": "deepseek-chat",
  "apiKey": "sk-...",          // stored in secrets.json, never in members.json
  "persona": "You are the research officer..."
}
```

```jsonc
// CLI member that can actually run tools (needs the CLI installed + logged in)
{ "name": "Claude", "role": "审阅官", "backend": "claude-cli", "persona": "You review code..." }
```

Behaviour:

| backend | tools | needs |
| --- | --- | --- |
| `dsh` | read/write files, shell, web | `dsh` CLI (DeepSeek Harness) |
| `claude-cli` | read/write files, shell, web | `claude` CLI logged in |
| `codex-cli` | read/write files, shell | `codex` CLI logged in |
| `openai-api` | none (pure chat) | `baseUrl` + `model` + API key |
| `anthropic-api` | none (pure chat) | `baseUrl` + `model` + API key |

Every member — including the seeded ones — can be renamed, re-persona'd or deleted.
The member list lives in `data/members.json`; delete that file to get an empty roster again.
[`seeds/members.example.json`](seeds/members.example.json) is an optional template you can copy
over `data/members.json` if you prefer editing JSON to clicking.

## Configuration

Everything is optional. Precedence: **environment variable > `cc.config.json` > built-in default**.
Start from [`cc.config.example.json`](cc.config.example.json) and `cp cc.config.example.json cc.config.json`.

| Key | Env | Default | Meaning |
| --- | --- | --- | --- |
| `host` | `CC_HOST` | `127.0.0.1` | listen address |
| `port` | `CC_PORT` | `8787` | listen port |
| `workspace` | `CC_WORKSPACE` | process cwd | directory agents are told to work in |
| `auth` | `CC_AUTH` | `true` | shared-token auth |
| `token` | `CC_TOKEN` | generated → `data/.token` | fixed token instead of a generated one |
| `dshCli` | `CC_DSH_CLI` | auto-detected | path to the `dsh` CLI (`none` disables DSH members) |
| `dshHome` | `CC_DSH_HOME` | `runtime/dsh-home` | DSH home for member profiles/sessions |
| `permissionMode` | `CC_PERMISSION_MODE` | `danger-full-access` | sandbox handed to DSH members |
| `turnTimeoutMs` | `CC_TURN_TIMEOUT_MS` | 30 min | hard cap per member turn |
| `maxConcurrentTurns` | `CC_MAX_CONCURRENT_TURNS` | `4` | global parallel turns |
| `perMemberQueue` | `CC_PER_MEMBER_QUEUE` | `true` | one turn at a time per member |
| `historyCharBudget` | `CC_HISTORY_CHAR_BUDGET` | `24000` | how much of an agent's own history is replayed |
| `backends.proxy` | `CC_PROXY` | none | proxy injected into CLI agents (they ignore system proxy settings) |

Data directory: `data/` by default (`CC_DATA_DIR` to move it). It holds conversations,
members, secrets and logs — back it up, and never commit it.

## Security — read this before exposing the port

- The service **can run commands and modify files** through CLI members. Treat it like a shell.
- Auth is a single shared token (`data/.token`, 0600, also accepted as
  `Authorization: Bearer <token>`). Keep it secret; rotate by deleting the file and restarting.
- Default bind is `127.0.0.1`. If you bind `0.0.0.0`, put it behind a reverse proxy with TLS and
  keep auth on — or use an SSH tunnel. `auth=false` is only for a fully trusted single-user machine.
- CLI agents run with the permissions of the CLI and the OS user; scope them with their own
  configuration (e.g. Claude Code permission rules, DSH `permissionMode`) if you need limits.
- API keys live in `secrets.json` (gitignored) and are never sent back to the browser.

## How it works

```
server/
  index.mjs        startup: config checks, profiles, housekeeping, HTTP server
  http.mjs         routing, SSE, auth, static files
  orchestrator.mjs parse @mentions → dispatch turns → merge events into messages
  dispatcher.mjs   route a turn to the right backend
  queue.mjs        per-member serial queue, global concurrency cap, timeouts
  store.mjs        in-memory state + persistence facade
  storage.mjs      per-room snapshot + append-only journal (WAL), legacy migration
  retention.mjs    ageing: archive old turns, then downgrade to summaries
  metrics.mjs      JSONL event log (data/logs) + /api/stats counters
  search.mjs       cross-room full-text search (+ /api/search)
  auth.mjs         shared token, cookie bootstrap, constant-time compare
  members.mjs      member registry (data/members.json, seeded on first run)
  api-backend.mjs  OpenAI/Anthropic-compatible chat backends
  runner.mjs        DSH one-shot runner (spawn + event parsing)
  claude-cli.mjs / codex-cli.mjs  vendor CLI backends
public/            no-build frontend: index.html, app.js, styles.css, bg.js, fonts
```

Design notes worth knowing:

- **Storage is a per-room WAL.** Each message appends one line to
  `data/rooms/<id>.journal.jsonl`; snapshots are written on maintenance/shutdown.
  A crashed process loses at most an incomplete last line, and replay is idempotent.
  The old single-file `data/store.json` is migrated automatically on first start
  (kept as `store.json.migrated-<timestamp>`).
- **A turn is queued, not spawned blindly.** Per-member serial + global cap prevents
  "everyone works at once" from melting the machine; a hard timeout stops zombies.
- **SSE events carry ids**, so `Last-Event-ID` replay fills the gap after a reconnect
  instead of silently dropping tool-call events.
- **Old turns are archived, never deleted.** `data/archive/*.jsonl.gz` keeps the full
  transcript while the live room shrinks to summaries.

## Packaging a release

```bash
npm run package
```

Produces `dist/command-center-v<version>.zip` (or `.tar.gz` on macOS/Linux) containing only what
is needed to run: `bin/ server/ public/ scripts/ seeds/ docs/`, docs, launcher and
`cc.config.example.json`. **`data/`, `runtime/`, `secrets.json` and `.git` are never included** —
the downloaded copy starts as a clean, memberless workspace with a `START-HERE.txt`.

Upload the archive to GitHub Releases; the repository itself is just `git push`.

## Tests

```bash
npm test            # syntax + storage + retention + auth/e2e (no model needed)
npm run check       # syntax only
npm run selfcheck   # end-to-end against a running server (uses a real model)
npm run test:members# member CRUD flow against a running server
npm run test:retention
```

`npm test` needs no network, no API key and no CLI — it starts a throwaway instance on a
random port with a temporary data directory.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| 401 / "需要访问 token" | Open the startup URL with `?token=...`, or `curl -H "Authorization: Bearer $(cat data/.token)"` |
| "未检测到 DeepSeek Harness CLI" | Install the app, or set `CC_DSH_CLI`, or switch those members to an API backend |
| Agent replies "not logged in" | Log the corresponding CLI in a terminal first (`claude`, `codex`) |
| Agent can't reach the network | Set `backends.proxy` / `CC_PROXY`; vendor CLIs ignore system proxy settings |
| Edits to members don't stick | Check `data/members.json` permissions; the file is atomically rewritten |
| Everything is slow after months | Check `GET /api/stats` and `data/server.log`; housekeeping runs 5-minutely, retention archives old turns |

More operational notes (in Chinese): [`docs/OPERATIONS.zh-CN.md`](docs/OPERATIONS.zh-CN.md).

## License

MIT — see [LICENSE](LICENSE).
