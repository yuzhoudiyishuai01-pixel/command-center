/**
 * 访问鉴权。
 *
 * 指挥室能派活、能执行命令，把这样的服务暴露在局域网上而没有任何凭据，
 * 等于给整台机器开了后门。所以默认启用一个共享 token：
 *
 *   - 首次启动生成 data/.token（0600），并在启动横幅里打印带 token 的网址
 *   - 浏览器打开一次 `/?token=xxx` 后种下 HttpOnly cookie，之后正常访问
 *   - API 也接受 `Authorization: Bearer <token>`，方便脚本/curl
 *   - EventSource 不能自定义 header，所以 cookie 是必须的那条通道
 *
 * 想关掉（仅限完全可信的本机环境）：cc.config.json 里 `"auth": false`，
 * 或设置环境变量 CC_AUTH=0。启动时会额外警告。
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "./config.mjs";

const TOKEN_PATH = resolve(config.dataDir, ".token");
const COOKIE_NAME = "cc_token";
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 天

let cachedToken = null;

export function tokenPath() {
  return TOKEN_PATH;
}

/** 取当前 token：环境变量 > 配置文件 > data/.token（不存在则生成）。 */
export function ensureToken() {
  if (!config.auth) return "";
  if (cachedToken) return cachedToken;
  if (config.token) {
    cachedToken = config.token;
    return cachedToken;
  }
  if (existsSync(TOKEN_PATH)) {
    const fromFile = readFileSync(TOKEN_PATH, "utf8").trim();
    if (fromFile) {
      cachedToken = fromFile;
      return cachedToken;
    }
  }
  const token = randomBytes(24).toString("base64url");
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(TOKEN_PATH, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(TOKEN_PATH, 0o600);
  } catch {
    /* Windows 上 chmod 基本无效，忽略 */
  }
  cachedToken = token;
  return token;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function parseCookies(header) {
  const out = new Map();
  if (!header) return out;
  for (const part of String(header).split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) out.set(name, decodeURIComponent(value));
  }
  return out;
}

/** 从请求的三个可能位置取出 token。 */
export function extractToken(req, url) {
  const query = url?.searchParams?.get("token");
  if (query) return query.trim();

  const header = req.headers?.authorization;
  if (header && /^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, "").trim();

  const cookies = parseCookies(req.headers?.cookie);
  return cookies.get(COOKIE_NAME) ?? "";
}

export function isAuthorized(req, url) {
  if (!config.auth) return true;
  const expected = ensureToken();
  if (!expected) return true;
  const provided = extractToken(req, url);
  return provided.length > 0 && safeEqual(provided, expected);
}

/** 请求带的是 `?token=` 且正确时，需要顺手种 cookie 并重定向掉明文 token。 */
export function shouldBootstrapCookie(req, url) {
  if (!config.auth) return false;
  if (!url?.searchParams?.get("token")) return false;
  return isAuthorized(req, url);
}

export function cookieFor(token) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${COOKIE_MAX_AGE}`,
  ];
  return parts.join("; ");
}

/** 带 token 的访问网址，启动横幅打印用。 */
export function tokenizedUrl(host, port) {
  const token = ensureToken();
  const base = `http://${host}:${port}/`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}
