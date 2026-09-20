/**
 * Cloudflare Workers 入口。
 *
 * 和 Node 版共用 src/app.js（路由 + 业务）、src/views.js（模板）、src/qr.js（二维码编码器），
 * 这里只负责三件平台相关的事：
 *   1. env.DB（D1）→ store
 *   2. env.ADMIN_PASSWORD → auth
 *   3. Request/Response ↔ 共享层要的请求描述对象
 *
 * 注意：共享模块是 CommonJS，这里是 ESM，所以只能用默认导入（esbuild 会做转换）。
 * 不需要 nodejs_compat —— 整条链路没有用到任何 node: 内置模块。
 */

import core from './core.js';
import appModule from './app.js';
import d1Module from './d1.js';

const { createApp, pageResponse } = appModule;
const { createStore } = d1Module;

/**
 * 每个 isolate 只组装一次 app。
 * 除了省掉重复的建对象开销，更重要的是让 app 内部的二维码缓存能跨请求生效。
 * env 在一次部署内是稳定的，所以这样缓存是安全的。
 */
let appPromise = null;

function getApp(env) {
  if (!appPromise) {
    appPromise = buildApp(env).catch((error) => {
      appPromise = null; // 失败不要污染缓存，下次请求重试
      throw error;
    });
  }
  return appPromise;
}

async function buildApp(env) {
  core.setTimeZoneOffset(env.TZ_OFFSET_HOURS);

  const store = createStore(env.DB);

  let sessionSecret;
  try {
    sessionSecret = await core.resolveSessionSecret(store, env.SESSION_SECRET);
  } catch (error) {
    // 第一次部署最常见的坑就是忘了建表，这里把话说清楚
    throw new Error(
      '读取 D1 失败。请确认已执行：\n' +
        '  npx wrangler d1 execute chezai-qrcode --remote --file=./schema.sql\n' +
        `原始错误：${error && error.message ? error.message : error}`
    );
  }

  // Worker 上不需要 KDF：密码存在平台 secret 里，数据库里没有可离线爆破的哈希。
  // 防的是在线猜测，那个由 store.bumpRateLimit 的登录限流负责。
  const adminPassword = env.ADMIN_PASSWORD || '';
  const publicBaseUrl = core.normalizeBaseUrl(env.PUBLIC_BASE_URL || '');

  return createApp({
    store,
    auth: {
      isConfigured: Boolean(adminPassword),
      hint: adminPassword
        ? ''
        : '尚未配置管理密码。请在项目目录执行：npx wrangler secret put ADMIN_PASSWORD，然后重新部署。',
      verify: async (submitted) => core.timingSafeEqualStr(submitted, adminPassword),
    },
    publicBaseUrl,
    sessionSecret,
    // 不需要配 isHttps：Worker 拿得到请求的真实 origin（生产环境就是 https），
    // 会话 Cookie 的 Secure 标志按它来判断，本地 wrangler dev 是 http 自然就不带。
  });
}

function toResponse(result) {
  return new Response(result.body || '', {
    status: result.status,
    headers: result.headers,
  });
}

function clientIp(request) {
  const direct = request.headers.get('CF-Connecting-IP');
  if (direct) return direct;
  const forwarded = request.headers.get('X-Forwarded-For');
  if (forwarded) return forwarded.split(',')[0].trim();
  return 'unknown';
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const app = await getApp(env);

  const req = {
    method: request.method,
    pathname: url.pathname,
    url,
    cookie: request.headers.get('cookie') || '',
    ip: clientIp(request),
    origin: url.origin,
    readText: () => request.text(),
  };

  const result = await app.handle(req);
  if (result) return toResponse(result);

  // 没命中路由：交给静态资源（public/ 由 wrangler.toml 的 [assets] 托管）
  if (env.ASSETS && (request.method === 'GET' || request.method === 'HEAD')) {
    const asset = await env.ASSETS.fetch(request);
    if (asset.status === 200) return asset;
  }

  return toResponse(pageResponse(404, '页面不存在', '请检查链接是否正确。'));
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      // 细节只进日志（npx wrangler tail 可见），回给用户一句人话
      console.error('[worker]', error && error.stack ? error.stack : error);
      return toResponse(
        pageResponse(500, '服务暂时不可用', '请稍后重试。部署者可用 npx wrangler tail 查看具体错误。')
      );
    }
  },
};
