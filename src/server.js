'use strict';

/**
 * Node 入口 + HTTP 适配层。
 *
 * 职责只有三件：
 *   1. 组装依赖（store = node:sqlite，auth = scrypt，共享 app）
 *   2. 把 http.IncomingMessage 翻译成 src/app.js 要的请求描述
 *   3. 把 app 返回的描述写回 http.ServerResponse
 * 业务逻辑一律在 src/app.js 里，和 Cloudflare Workers 共用。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const core = require('./core');
const util = require('./util');
const { createStore } = require('./db');
const { createApp, pageResponse } = require('./app');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_BASE_URL = core.normalizeBaseUrl(process.env.PUBLIC_BASE_URL || '');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const BODY_LIMIT = 16 * 1024;

/**
 * 公开入口的协议。
 *
 * 请求的 Host 与 PUBLIC_BASE_URL 一致时，就以配置里的协议为准：
 * TLS 在 Nginx / 负载均衡上终止时 node 只看得到 http，靠这一步才能把
 * 会话 Cookie 的 Secure 标志标对。本地用 http://localhost:3000 调试时
 * Host 对不上，不会把线上的 https 误套到自己头上（那会导致登录直接失效）。
 */
const PUBLIC_ORIGIN = (() => {
  if (!PUBLIC_BASE_URL) return null;
  try {
    const parsed = new URL(PUBLIC_BASE_URL);
    return { host: parsed.host, origin: parsed.origin };
  } catch {
    console.warn('[警告] PUBLIC_BASE_URL 不是合法 URL，已忽略：', PUBLIC_BASE_URL);
    return null;
  }
})();

// CSS 与 JS 走同一份文件，Worker 那边由 [assets] 直接托管 public/
const STATIC_FILES = {
  '/style.css': { name: 'style.css', type: 'text/css; charset=utf-8' },
  '/app.js': { name: 'app.js', type: 'application/javascript; charset=utf-8' },
};

/* ------------------------------------------------------------------ */

function serveStatic(res, pathname) {
  const entry = STATIC_FILES[pathname];
  if (!entry) return false;

  const file = path.join(__dirname, '..', 'public', entry.name);
  let content;
  try {
    content = fs.readFileSync(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return true;
  }

  res.writeHead(200, {
    'Content-Type': entry.type,
    'Cache-Control': 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(content);
  return true;
}

function buildRequest(req, headers, url) {
  let proto = 'http';
  if (TRUST_PROXY && headers['x-forwarded-proto']) {
    proto = String(headers['x-forwarded-proto']).split(',')[0].trim();
  }

  const host = headers.host || `localhost:${PORT}`;
  const origin = PUBLIC_ORIGIN && PUBLIC_ORIGIN.host === host ? PUBLIC_ORIGIN.origin : `${proto}://${host}`;

  return {
    method: req.method,
    pathname: url.pathname,
    url,
    headers,
    cookie: headers.cookie || '',
    ip: util.clientIp(req, headers, TRUST_PROXY),
    origin,
    readText: () => util.readBody(req, BODY_LIMIT),
  };
}

async function bootstrapAdminPassword(store) {
  const fromEnv = process.env.ADMIN_PASSWORD;
  if (fromEnv) {
    const stored = await store.getSetting('admin_password');
    if (!(await core.verifyPassword(fromEnv, stored || ''))) {
      await store.setSetting('admin_password', await core.hashPassword(fromEnv));
      console.log('[初始化] 已按 ADMIN_PASSWORD 环境变量写入管理密码。');
    }
    return { hint: '' };
  }

  const stored = await store.getSetting('admin_password');
  // 旧版本用 scrypt 存过哈希，格式已经不认了 —— 当作没有，重新生成并打印
  if (stored && core.isSupportedHash(stored)) return { hint: '' };

  const generated = core.randomHex(8); // 16 位十六进制，方便照抄
  await store.setSetting('admin_password', await core.hashPassword(generated));
  console.log('');
  console.log('=========================================================');
  console.log('  首次启动，已生成平台后台管理密码：');
  console.log(`      ${generated}`);
  console.log('  请立刻登录并妥善保存；想固定密码就设置 ADMIN_PASSWORD 后重启。');
  console.log('=========================================================');
  console.log('');
  return { hint: '首次启动已自动生成管理密码，已打印在服务端启动日志中。也可设置 ADMIN_PASSWORD 环境变量固定密码。' };
}

/* ------------------------------------------------------------------ */

async function main() {
  core.setTimeZoneOffset(process.env.TZ_OFFSET_HOURS);
  core.setPasswordIterations(process.env.PBKDF2_ITERATIONS);

  const store = createStore(process.env.DATA_DIR);
  const sessionSecret = await core.resolveSessionSecret(store, process.env.SESSION_SECRET);
  const admin = await bootstrapAdminPassword(store);

  const app = createApp({
    store,
    auth: {
      isConfigured: true,
      hint: admin.hint,
      verify: async (password) =>
        core.verifyPassword(password, (await store.getSetting('admin_password')) || ''),
    },
    publicBaseUrl: PUBLIC_BASE_URL,
    sessionSecret,
    isHttps: PUBLIC_BASE_URL.startsWith('https://'),
  });

  const server = http.createServer((req, res) => {
    handle(req, res, app).catch((error) => {
      console.error('[请求处理失败]', req.method, req.url, error);
      if (res.headersSent) {
        res.end();
        return;
      }
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('internal error');
    });
  });

  server.listen(PORT, HOST, () => {
    const shown = PUBLIC_BASE_URL || `http://localhost:${PORT}`;
    console.log('');
    console.log('  挪车二维码服务已启动（Node 版）');
    console.log(`  车主后台：${shown}/admin`);
    console.log(`  扫码地址：${shown}/c/<编号>`);
    console.log(`  数据文件：${store.dataDir}`);
    if (!PUBLIC_BASE_URL) {
      console.log('');
      console.log('  ! 尚未设置 PUBLIC_BASE_URL，二维码会按访问时的 Host 生成。');
      console.log('    正式使用请设置成固定域名，例如：');
      console.log('    PUBLIC_BASE_URL=https://move.example.com');
    }
    console.log('');
  });

  return server;
}

async function handle(req, res, app) {
  const headers = util.normalizeHeaders(req.headers);

  let url;
  try {
    url = new URL(req.url, `http://${headers.host || `localhost:${PORT}`}`);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('bad request');
    return;
  }

  if (req.method === 'GET' && serveStatic(res, url.pathname)) return;

  const result = await app.handle(buildRequest(req, headers, url));
  const final = result || pageResponse(404, '页面不存在', '请检查链接是否正确。');

  res.writeHead(final.status, final.headers);
  res.end(final.body || '');
}

main().catch((error) => {
  console.error('[启动失败]', error);
  process.exit(1);
});

module.exports = { main };
