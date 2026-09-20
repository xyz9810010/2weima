'use strict';

/**
 * 共享应用层：路由 + 业务逻辑。
 *
 * 设计要点：**完全不碰平台 API**。
 *   - 输入是适配层整理好的请求描述对象（见 src/server.js / src/worker.js）
 *   - 输出是纯对象 { status, headers, body }，由适配层自己变成 http.ServerResponse 或 Response
 *
 * 这样 Node 与 Cloudflare Workers 共用同一套路由、模板和二维码编码器，
 * 平台差异只剩「怎么读请求、怎么连数据库」两件事。
 */

const core = require('./core');
const qr = require('./qr');
const views = require('./views');

const SESSION_COOKIE = 'chezai_admin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** 拨号打点的限流（只影响记录的写入，不影响用户能不能拨出去） */
const CALL_WINDOW_MS = 10 * 60 * 1000;
const CALL_LOG_LIMIT = 30;
/** 后台登录限流 */
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_LIMIT = 10;

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

const NOTICES = {
  created: { text: '已生成挪车码，下面可以直接下载或打印贴纸。', kind: 'info' },
  updated: { text: '已保存修改。', kind: 'info' },
  deleted: { text: '已删除该车辆及其拨号记录。', kind: 'info' },
};

/* ---------------------------- 响应构造 ---------------------------- */

function response(status, headers, body) {
  return { status, headers: Object.assign({}, headers), body };
}

function htmlResponse(status, body, extraHeaders) {
  return response(
    status,
    Object.assign(
      { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
      SECURITY_HEADERS,
      extraHeaders || {}
    ),
    body
  );
}

function jsonResponse(status, payload) {
  return response(
    status,
    Object.assign(
      { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      SECURITY_HEADERS
    ),
    JSON.stringify(payload)
  );
}

function redirectResponse(location, extraHeaders) {
  return response(
    302,
    Object.assign({ Location: location, 'Cache-Control': 'no-store' }, extraHeaders || {}),
    ''
  );
}

function pageResponse(status, title, text) {
  return htmlResponse(status, views.messagePage({ title, text }));
}

/* ------------------------------------------------------------------ */

function createApp(options) {
  const store = options.store;
  const auth = options.auth;
  const publicBaseUrl = core.normalizeBaseUrl(options.publicBaseUrl || '');
  const sessionSecret = options.sessionSecret;
  // 只在适配层给不出 origin 时兜底，正常情况下以请求本身的协议为准
  const httpsFallback = Boolean(options.isHttps);

  // 二维码内容只取决于「域名 + 编号」，所以它本身就是完美的缓存键。
  // 多辆车的后台页面不必每次重算矩阵（对 Worker 的 CPU 限额也友好）。
  const qrCache = new Map();

  function qrSvgFor(car, base) {
    const content = `${base}/c/${car.id}`;
    let svg = qrCache.get(content);
    if (!svg) {
      svg = qr.toSvg(content, { scale: 8, quiet: 3 });
      if (qrCache.size > 500) qrCache.clear();
      qrCache.set(content, svg);
    }
    return svg;
  }

  const baseUrlOf = (req) => publicBaseUrl || req.origin;

  /* ----------------------------- 会话 ----------------------------- */

  async function isAuthed(req) {
    const cookies = core.parseCookies(req.cookie);
    const payload = await core.unsignValue(cookies[SESSION_COOKIE], sessionSecret);
    if (!payload) return false;
    const index = payload.indexOf(':');
    if (index < 0) return false;
    const expiresAt = Number(payload.slice(0, index));
    if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
    return payload.slice(index + 1) === 'admin';
  }

  async function sessionCookieHeader(req) {
    const token = await core.signValue(`${Date.now() + SESSION_TTL_MS}:admin`, sessionSecret);
    const maxAge = Math.floor(SESSION_TTL_MS / 1000);
    return (
      `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` +
      (requestIsHttps(req) ? '; Secure' : '')
    );
  }

  /**
   * 会话 Cookie 要不要带 Secure：以**请求本身的协议**为准。
   *
   * 不能用 PUBLIC_BASE_URL 判断 —— 本地开发常常复制一份线上 .env，
   * 那时请求其实是 http，带上 Secure 浏览器根本不会回传，直接登不进去。
   * 适配层在 TLS 由反向代理终止时会通过 X-Forwarded-Proto（需 TRUST_PROXY=1）
   * 给出真实的协议，所以这里读 origin 就是对的。
   */
  function requestIsHttps(req) {
    const origin = String((req && req.origin) || '');
    if (origin.startsWith('https://')) return true;
    if (origin.startsWith('http://')) return false;
    return httpsFallback;
  }

  const CLEAR_COOKIE_HEADER = `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

  /* --------------------------- 扫码方 ----------------------------- */

  /**
   * 扫码页上「一键拨号」拨哪个号：
   *   优先用「拨号号码」（隐私号 / 虚拟号），
   *   没填就退回车主留的真实手机号 —— 没有隐私号服务的普通车主也能扫码即拨。
   *   两个都没填才会没有按钮。
   */
  function dialNumberOf(car) {
    return core.sanitizePhone(car.call_number) || core.sanitizePhone(car.phone);
  }

  async function handleScan(req, url, params) {
    const car = await store.getCar(params[0]);
    if (!car) {
      return pageResponse(404, '挪车码不存在', '请确认二维码是否扫描完整，或联系车主索取新的贴纸。');
    }
    if (!car.enabled) {
      return pageResponse(403, '该挪车码已停用', '车主已关闭这个挪车码，暂时无法通过它联系车主。');
    }
    return htmlResponse(200, views.scanPage(car, { dialNumber: dialNumberOf(car) }));
  }

  /**
   * 拨号打点的限流放在内存里：既不落库，也不记录任何能指向扫码人的东西。
   * 键是车辆编号而不是 IP —— 连「处理一下扫码人的 IP」这一步都省掉。
   * isolate 重启即清空；宁可少限一点，也不留数据。
   */
  const callLogThrottle = new Map();

  function allowCallLog(carId) {
    const now = Date.now();
    const state = callLogThrottle.get(carId);
    if (!state || now >= state.resetAt) {
      if (callLogThrottle.size > 1000) callLogThrottle.clear();
      callLogThrottle.set(carId, { count: 1, resetAt: now + CALL_WINDOW_MS });
      return true;
    }
    state.count += 1;
    return state.count <= CALL_LOG_LIMIT;
  }

  async function handlePostCall(req, url, params) {
    // sendBeacon 会带一个很小的 body，顺手读完，避免连接被重置
    try {
      await req.readText();
    } catch {
      /* 读失败也不影响记录 */
    }

    const car = await store.getCar(params[0]);
    if (!car || !car.enabled || !dialNumberOf(car)) {
      return jsonResponse(404, { ok: false });
    }
    if (!allowCallLog(car.id)) return jsonResponse(429, { ok: false });

    // 只落一行「哪辆车、什么时候」，不写 IP、不写 UA、不写号码
    await store.addCallLog(car.id);
    return jsonResponse(200, { ok: true });
  }

  /* --------------------------- 车主后台 --------------------------- */

  async function handleLoginForm(req) {
    if (await isAuthed(req)) return redirectResponse('/admin');
    return htmlResponse(
      200,
      views.loginPage({ error: '', configured: auth.isConfigured, hint: auth.hint || '' })
    );
  }

  async function handleLoginSubmit(req) {
    if (!auth.isConfigured) {
      return htmlResponse(
        503,
        views.loginPage({ error: '', configured: false, hint: auth.hint || '' })
      );
    }

    const form = core.parseForm(await req.readText());
    const password = String(form.password || '');

    const allowed = await store.bumpRateLimit(`login:${req.ip}`, LOGIN_WINDOW_MS, LOGIN_LIMIT);
    if (!allowed) {
      return htmlResponse(
        429,
        views.loginPage({
          error: '尝试过于频繁，请稍后再试。',
          configured: true,
          hint: '',
        })
      );
    }

    if (!(await auth.verify(password))) {
      return htmlResponse(
        401,
        views.loginPage({ error: '密码不正确。', configured: true, hint: '' })
      );
    }

    return redirectResponse('/admin', { 'Set-Cookie': await sessionCookieHeader(req) });
  }

  function handleLogout() {
    return redirectResponse('/admin/login', { 'Set-Cookie': CLEAR_COOKIE_HEADER });
  }

  async function renderAdmin(req, url) {
    const base = baseUrlOf(req);
    const cars = (await store.listCars()).map((car) => {
      const item = Object.assign({}, car);
      item.qrSvg = qrSvgFor(car, base);
      return item;
    });
    const noticeKey = url.searchParams.get('notice');
    return htmlResponse(
      200,
      views.adminPage({
        cars,
        messages: await store.listMessages(100),
        baseUrl: base,
        unread: await store.countUnread(),
        notice: noticeKey && NOTICES[noticeKey] ? NOTICES[noticeKey] : null,
      })
    );
  }

  async function handleAdminHome(req, url) {
    if (!(await isAuthed(req))) return redirectResponse('/admin/login');
    return renderAdmin(req, url);
  }

  function collectCarFields(form) {
    return {
      plate: core.truncate(String(form.plate || '').trim(), 20),
      owner_name: core.truncate(String(form.owner_name || '').trim(), 20),
      phone: core.truncate(String(form.phone || '').trim(), 20),
      call_number: core.sanitizePhone(core.truncate(String(form.call_number || '').trim(), 20)),
      note: core.truncate(String(form.note || '').trim(), 200),
      enabled: form.enabled ? 1 : 0,
    };
  }

  async function uniqueCarId() {
    for (let i = 0; i < 5; i++) {
      const id = core.randomCode(10);
      if (!(await store.getCar(id))) return id;
    }
    throw new Error('无法生成唯一编号');
  }

  async function handleCreateCar(req) {
    if (!(await isAuthed(req))) return redirectResponse('/admin/login');
    const fields = collectCarFields(core.parseForm(await req.readText()));
    await store.createCar(Object.assign({ id: await uniqueCarId() }, fields));
    return redirectResponse('/admin?notice=created');
  }

  async function handleUpdateCar(req, url, params) {
    if (!(await isAuthed(req))) return redirectResponse('/admin/login');
    const car = await store.getCar(params[0]);
    if (!car) return pageResponse(404, '车辆不存在', '它可能已经被删除了。');
    const fields = collectCarFields(core.parseForm(await req.readText()));
    await store.updateCar(car.id, fields);
    return redirectResponse('/admin?notice=updated');
  }

  async function handleDeleteCar(req, url, params) {
    if (!(await isAuthed(req))) return redirectResponse('/admin/login');
    await store.deleteCar(params[0]);
    return redirectResponse('/admin?notice=deleted');
  }

  async function handleQrSvg(req, url, params) {
    if (!(await isAuthed(req))) return redirectResponse('/admin/login');
    const car = await store.getCar(params[0]);
    if (!car) return pageResponse(404, '车辆不存在', '它可能已经被删除了。');

    const disposition = url.searchParams.get('download') === '1' ? 'attachment' : 'inline';
    return response(
      200,
      Object.assign(
        {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Disposition': `${disposition}; filename="chezai-${car.id}.svg"`,
        },
        SECURITY_HEADERS
      ),
      qrSvgFor(car, baseUrlOf(req))
    );
  }

  async function handlePrint(req, url, params) {
    if (!(await isAuthed(req))) return redirectResponse('/admin/login');
    const car = await store.getCar(params[0]);
    if (!car) return pageResponse(404, '车辆不存在', '它可能已经被删除了。');
    const base = baseUrlOf(req);
    return htmlResponse(200, views.printPage(car, { baseUrl: base, qrSvg: qrSvgFor(car, base) }));
  }

  async function handleMarkRead(req, url, params) {
    if (!(await isAuthed(req))) return redirectResponse('/admin/login');
    await store.markRead(params[0]);
    return redirectResponse('/admin');
  }

  async function handleMarkAllRead(req) {
    if (!(await isAuthed(req))) return redirectResponse('/admin/login');
    await store.markAllRead();
    return redirectResponse('/admin');
  }

  /* ----------------------------- 路由表 ---------------------------- */

  const ID = '([A-Za-z0-9_-]{1,40})';

  const routes = [
    ['GET', /^\/healthz$/, async () => jsonResponse(200, { ok: true })],
    [
      'GET',
      /^\/$/,
      async (req) => redirectResponse((await isAuthed(req)) ? '/admin' : '/admin/login'),
    ],
    ['GET', new RegExp(`^/c/${ID}$`), handleScan],
    ['POST', new RegExp(`^/c/${ID}/call$`), handlePostCall],

    ['GET', /^\/admin\/login$/, handleLoginForm],
    ['POST', /^\/admin\/login$/, handleLoginSubmit],
    ['POST', /^\/admin\/logout$/, handleLogout],
    ['GET', /^\/admin$/, handleAdminHome],
    ['POST', /^\/admin\/cars$/, handleCreateCar],
    ['POST', new RegExp(`^/admin/cars/${ID}$`), handleUpdateCar],
    ['POST', new RegExp(`^/admin/cars/${ID}/delete$`), handleDeleteCar],
    ['GET', new RegExp(`^/admin/cars/${ID}/qr\\.svg$`), handleQrSvg],
    ['GET', new RegExp(`^/admin/cars/${ID}/print$`), handlePrint],
    ['POST', /^\/admin\/messages\/(\d{1,12})\/read$/, handleMarkRead],
    ['POST', /^\/admin\/messages\/read-all$/, handleMarkAllRead],
  ];

  /**
   * @returns {Promise<{status:number,headers:object,body:string}|null>} null 表示没有路由命中，
   *          由适配层决定去查静态资源还是回 404。
   */
  async function handle(req) {
    for (const [method, pattern, handler] of routes) {
      if (method !== req.method) continue;
      const match = pattern.exec(req.pathname);
      if (!match) continue;
      return handler(req, req.url, match.slice(1));
    }
    return null;
  }

  return { handle };
}

module.exports = { createApp, pageResponse, SECURITY_HEADERS, SESSION_COOKIE };
