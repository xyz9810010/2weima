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
/** 注册限流（同一 IP） */
const SIGNUP_LIMIT = 5;

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
  read: { text: '已标记为已读。', kind: 'info' },
  readAll: { text: '已全部标记为已读。', kind: 'info' },
  cleaned: { text: '已清理掉空白车辆。', kind: 'info' },
  codes: { text: '已生成空白贴纸编号，打印出来谁拿到谁绑定。', kind: 'info' },
  bound: { text: '已绑定：这张贴纸现在指向那辆车了。', kind: 'info' },
  unbound: { text: '已解绑：这张贴纸变回空白，可以绑到别的车上。', kind: 'info' },
  codedeleted: { text: '已删除该编号，这张贴纸作废。', kind: 'info' },
  codefixed: {
    text: '这个编号就是某辆车的编号，删不掉 —— 车还在，它就永远有效。想让它失效就解绑，或者停用那辆车。',
    kind: 'error',
  },
  needinfo: {
    text: '还没建成：至少要填「车牌」或一个号码，否则这张贴纸扫开什么都没有。',
    kind: 'error',
  },
};

/** 一条车辆记录有没有意义：车牌、真实号、拨号码总得有一个 */
function carHasIdentity(fields) {
  return Boolean(fields.plate || fields.call_number || fields.phone);
}

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

  // 二维码内容就是缓存键；后台一页好几张二维码时不必重复算矩阵（对 Worker 的 CPU 也友好）
  const qrCache = new Map();

  function qrSvgForContent(content) {
    let svg = qrCache.get(content);
    if (!svg) {
      svg = qr.toSvg(content, { scale: 8, quiet: 3 });
      if (qrCache.size > 500) qrCache.clear();
      qrCache.set(content, svg);
    }
    return svg;
  }

  /** 每辆车自己的码 */
  const carUrl = (car, base) => `${base}/c/${car.id}`;
  /**
   * 通用码：独立路径，**不占用域名根路径**。
   *
   * 根路径是车主输域名进来的地方，应该直达后台/登录；
   * 通用码是印在贴纸上给陌生人扫的，两者混在一起会让人找不到入口。
   *
   * 因为它不带车辆编号，同一个码无法区分是哪辆车 —— 扫码页再让扫码人选。
   */
  const universalUrl = (base) => `${base}/m`;

  const baseUrlOf = (req) => publicBaseUrl || req.origin;

  /** 贴纸尺寸：square = 5×5cm 方形（默认），square6 = 6×6cm 方形，rect = 10×5cm 长方形 */
  function stickerSize(url) {
    return views.stickerSizeOf(url && url.searchParams.get('size'));
  }

  /* ----------------------------- 会话 ----------------------------- */

  /**
   * 会话载荷：`<过期时间>:admin`（平台方）或 `<过期时间>:u:<用户id>`（车主）。
   * 两种身份共用一个签名 Cookie，权限在下面按 kind 区分。
   */
  async function currentSession(req) {
    const cookies = core.parseCookies(req.cookie);
    const payload = await core.unsignValue(cookies[SESSION_COOKIE], sessionSecret);
    if (!payload) return null;

    const index = payload.indexOf(':');
    if (index < 0) return null;
    const expiresAt = Number(payload.slice(0, index));
    if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;

    const subject = payload.slice(index + 1);
    if (subject === 'admin') return { kind: 'admin' };
    if (subject.startsWith('u:')) return { kind: 'user', userId: subject.slice(2) };
    return null;
  }

  async function sessionCookieHeader(req, subject) {
    const token = await core.signValue(`${Date.now() + SESSION_TTL_MS}:${subject}`, sessionSecret);
    const maxAge = Math.floor(SESSION_TTL_MS / 1000);
    return (
      `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}` +
      (requestIsHttps(req) ? '; Secure' : '')
    );
  }

  /** 登录后各自回自己的首页 */
  function homeFor(session) {
    if (!session) return '/login';
    return session.kind === 'admin' ? '/admin' : '/me';
  }

  /**
   * 这辆车当前这个人能动吗。
   * 管理员能动全部；车主只能动自己的（owner_id 为空的属于平台方自己录的车）。
   * 不属于自己的一律按「不存在」处理，避免泄露别人有哪些编号。
   */
  async function loadCarFor(session, carId) {
    if (!session) return { error: redirectResponse('/login') };
    const car = await store.getCar(carId);
    if (!car) return { error: pageResponse(404, '车辆不存在', '它可能已经被删除了。') };
    if (session.kind === 'admin') return { car };
    if (car.owner_id && car.owner_id === session.userId) return { car };
    return { error: pageResponse(404, '车辆不存在', '它可能已经被删除了。') };
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

  /* ------------------------- 单辆车的管理链接 ------------------------- */

  /**
   * 每辆车一条「管理链接」：`/edit/<编号>.<签名>`
   *
   * 用途：把某个码给别人时，对方要能自己改那一辆车的车牌和号码，
   * 但绝不应该拿到后台总密码（那等于交出所有车）。
   *
   * 实现：签名 = HMAC(SESSION_SECRET, "edit:" + 编号)，
   * 所以不需要额外的表字段、也不需要迁移；令牌不可伪造、不可枚举。
   * 换 SESSION_SECRET 会让所有管理链接立刻失效（相当于一键收回全部授权）。
   */
  async function editTokenFor(carId) {
    return `${carId}.${await core.hmacBase64Url(`edit:${carId}`, sessionSecret)}`;
  }

  /** 从令牌还原车辆；签名不对就当作不存在 */
  async function carByEditToken(token) {
    const raw = String(token || '');
    const index = raw.lastIndexOf('.');
    if (index <= 0) return null;
    const carId = raw.slice(0, index);
    const expected = await editTokenFor(carId);
    if (!core.timingSafeEqualStr(raw, expected)) return null;
    return store.getCar(carId);
  }

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

  /**
   * 编号 → 车辆。
   *
   * 贴纸上印的是**编号**，不是车牌：编号先印出来，之后才绑定到某辆车。
   * 所以这里返回三态：
   *   - 编号存在且已绑定 → { code, car }
   *   - 编号存在但没绑定 → { code, car: null }（页面提示「先去绑定」）
   *   - 查不到           → null
   *
   * **回落**：编号表里查不到时，退一步把编号当作车辆编号查。
   * 早期版本的贴纸印的就是车辆编号，这样已经贴出去的老贴纸永远有效，
   * 不需要先把迁移跑完（D1 上更是不想为了兼容在请求里写库）。
   */
  async function resolveCode(code) {
    const id = String(code || '');
    if (!id) return null;

    const entry = await store.getCode(id);
    if (entry) {
      if (!entry.car_id) return { code: entry.code, entry, car: null };
      const car = await store.getCar(entry.car_id);
      return { code: entry.code, entry, car };
    }

    const car = await store.getCar(id);
    if (car) {
      return {
        code: id,
        entry: { code: id, car_id: car.id, owner_id: car.owner_id, note: '', legacy: true },
        car,
      };
    }
    return null;
  }

  async function handleScan(req, url, params) {
    const found = await resolveCode(params[0]);
    if (!found) {
      return pageResponse(404, '挪车码不存在', '请确认二维码是否扫描完整，或联系车主索取新的贴纸。');
    }

    // 还没绑定到任何车辆的空白贴纸：让车主就地绑定，别给扫码人一个 404
    if (!found.car) {
      const session = await currentSession(req);
      const cars =
        session && session.kind === 'user'
          ? await store.listCarsByOwner(session.userId)
          : [];
      return htmlResponse(
        200,
        views.bindCodePage({
          code: found.code,
          cars,
          loggedIn: Boolean(session),
          home: homeFor(session),
        })
      );
    }

    const car = found.car;
    if (!car.enabled) {
      return pageResponse(403, '该挪车码已停用', '车主已关闭这个挪车码，暂时无法通过它联系车主。');
    }
    return htmlResponse(200, views.scanPage(car, { dialNumber: dialNumberOf(car) }));
  }

  /**
   * 扫到空白贴纸后，车主当场把它绑到自己的车上。
   * 权限：只能绑自己的车；贴纸本身也得是属于他的（或还没主）。
   */
  async function handleBindFromScan(req, url, params) {
    const session = await currentSession(req);
    if (!session) return redirectResponse('/login');

    const found = await resolveCode(params[0]);
    if (!found) return pageResponse(404, '编号不存在', '请确认二维码是否扫描完整。');
    if (found.car) return redirectResponse(`/c/${found.code}`);

    const raw = core.parseForm(await req.readText());
    const carId = String(raw.car_id || '');
    const cars = session.kind === 'user' ? await store.listCarsByOwner(session.userId) : await store.listCars();
    const car = cars.find((item) => item.id === carId);
    if (!car) return pageResponse(403, '绑定失败', '这辆车不属于当前账号，或者已经被删除了。');

    await store.createCode({
      code: found.code,
      car_id: car.id,
      owner_id: session.kind === 'user' ? session.userId : car.owner_id || null,
      note: '扫码绑定',
    });
    await store.bindCode(found.code, car.id, session.kind === 'user' ? session.userId : car.owner_id || null);
    return redirectResponse(`/c/${found.code}`);
  }

  /**
   * 域名根路径 = 车主入口。
   *
   * 车主输域名进来，期望的是后台（没登录就先去登录页），而不是看到给陌生人看的扫码页。
   * 通用码是印在贴纸上的，走 /m，见 handleUniversalScan。
   */
  async function handleRoot(req) {
    const session = await currentSession(req);
    return redirectResponse(homeFor(session));
  }

  /**
   * 通用码（/m）。
   *
   * 同一个二维码贴在所有车上，所以这里必须回答「扫的是哪辆车」：
   *   - 只启用了一辆 → 直接进那辆车，扫码人无感
   *   - 启用多辆     → 列出车牌让扫码人点（人就站在车前，照着车牌点一下）
   * 只认平台方自己录的车（owner_id 为空），绝不能把车主的车列出来。
   */
  async function handleUniversalScan(req) {
    // 只认平台方自己录的车（owner_id 为空）。
    // 多租户下这里绝不能把车主的车列出来 —— 那等于把所有人的车牌公开。
    const cars = (await store.listCars()).filter((car) => car.enabled && !car.owner_id);

    if (cars.length === 0) {
      // 用 200：这是一张内容正常的说明页，不是「资源不存在」。
      // 404 会让浏览器控制台报错，也让监控误判。
      return pageResponse(
        200,
        '暂时无法联系车主',
        '车主还没有启用挪车码，或者所有车辆都已停用。'
      );
    }
    if (cars.length === 1) {
      return htmlResponse(
        200,
        views.scanPage(cars[0], { dialNumber: dialNumberOf(cars[0]) })
      );
    }
    return htmlResponse(
      200,
      views.pickCarPage(
        cars.map((car) => ({
          id: car.id,
          plate: car.plate || '未填写车牌',
          owner_name: car.owner_name || '',
          // 列表里不显示号码，点进去才有
          hasNumber: Boolean(dialNumberOf(car)),
        }))
      )
    );
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

    const found = await resolveCode(params[0]);
    const car = found && found.car;
    if (!car || !car.enabled || !dialNumberOf(car)) {
      return jsonResponse(404, { ok: false });
    }
    if (!allowCallLog(car.id)) return jsonResponse(429, { ok: false });

    // 只落一行「哪辆车、什么时候」，不写 IP、不写 UA、不写号码
    await store.addCallLog(car.id);
    return jsonResponse(200, { ok: true });
  }

  /* --------------------- 单辆车的管理页（给别人用） -------------------- */

  /**
   * 持有链接的人可以改这一辆车的资料，但看不到其他任何车辆，
   * 也不需要（拿不到）后台总密码。
   */
  async function handleCarEditPage(req, url, params) {
    const car = await carByEditToken(params[0]);
    if (!car) {
      return pageResponse(404, '链接无效', '这个管理链接不对或已失效。请向给你链接的人索取新的链接。');
    }
    const noticeKey = url.searchParams.get('notice');
    return htmlResponse(
      200,
      views.carEditPage({
        car,
        token: params[0],
        dialNumber: dialNumberOf(car),
        notice: noticeKey === 'saved' ? '已保存。扫码页立刻生效，贴纸不用重印。' : '',
      })
    );
  }

  async function handleCarEditSubmit(req, url, params) {
    const car = await carByEditToken(params[0]);
    if (!car) {
      return pageResponse(404, '链接无效', '这个管理链接不对或已失效。请向给你链接的人索取新的链接。');
    }
    const raw = core.parseForm(await req.readText());
    const unparsable = unparsableResponse(req, raw);
    if (unparsable) return unparsable;
    const fields = collectCarFields(raw);
    await store.updateCar(car.id, fields);
    return redirectResponse(`/edit/${params[0]}?notice=saved`);
  }

  async function handleCarEditPrint(req, url, params) {
    const car = await carByEditToken(params[0]);
    if (!car) return pageResponse(404, '链接无效', '这个管理链接不对或已失效。');
    const base = baseUrlOf(req);
    return htmlResponse(
      200,
      views.printPage(car, { baseUrl: base, qrSvg: qrSvgForContent(carUrl(car, base)) })
    );
  }

  /* --------------------------- 登录与注册 --------------------------- */

  /** 手机号去空格/横线，邮箱统一小写，避免「同一人注册两次」 */
  function normalizeContact(value) {
    const raw = String(value || '').trim().replace(/[\s-]/g, '');
    return raw.includes('@') ? raw.toLowerCase() : raw;
  }

  function contactLooksValid(contact) {
    if (!contact) return false;
    if (contact.includes('@')) return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact);
    return /^\+?\d{6,20}$/.test(contact);
  }

  async function verifyPlatformPassword(password) {
    if (!auth.isConfigured) return false;
    return auth.verify(password);
  }

  async function handleLoginForm(req) {
    const session = await currentSession(req);
    if (session) return redirectResponse(homeFor(session));
    return htmlResponse(
      200,
      views.loginPage({
        mode: 'login',
        error: '',
        platformReady: auth.isConfigured,
        hint: auth.hint || '',
      })
    );
  }

  async function handleSignupForm(req) {
    const session = await currentSession(req);
    if (session) return redirectResponse(homeFor(session));
    return htmlResponse(200, views.loginPage({ mode: 'signup', error: '', platformReady: true, hint: '' }));
  }

  async function handleLoginSubmit(req) {
    const form = core.parseForm(await req.readText());
    const unparsable = unparsableResponse(req, form);
    if (unparsable) return unparsable;
    const contact = normalizeContact(form.contact);
    const password = String(form.password || '');

    const allowed = await store.bumpRateLimit(`login:${req.ip}`, LOGIN_WINDOW_MS, LOGIN_LIMIT);
    if (!allowed) {
      return htmlResponse(
        429,
        views.loginPage({
          mode: 'login',
          error: '尝试过于频繁，请稍后再试。',
          platformReady: auth.isConfigured,
          hint: '',
        })
      );
    }

    // 不填账号 = 平台方，用后台密码登录
    if (!contact) {
      if (await verifyPlatformPassword(password)) {
        return redirectResponse('/admin', { 'Set-Cookie': await sessionCookieHeader(req, 'admin') });
      }
      return htmlResponse(
        401,
        views.loginPage({
          mode: 'login',
          error: auth.isConfigured ? '密码不正确。' : '后台还没配置管理密码。',
          platformReady: auth.isConfigured,
          hint: auth.hint || '',
        })
      );
    }

    const user = await store.getUserByContact(contact);
    // 账号不存在和密码错误回同一句话，避免被用来探测谁注册过
    if (!user || user.disabled || !(await core.verifyPassword(password, user.password_hash))) {
      return htmlResponse(
        401,
        views.loginPage({ mode: 'login', error: '账号或密码不正确。', platformReady: auth.isConfigured, hint: '' })
      );
    }

    return redirectResponse('/me', { 'Set-Cookie': await sessionCookieHeader(req, `u:${user.id}`) });
  }

  async function handleSignupSubmit(req) {
    const form = core.parseForm(await req.readText());
    const unparsable = unparsableResponse(req, form);
    if (unparsable) return unparsable;
    const contact = normalizeContact(form.contact);
    const name = core.truncate(String(form.name || '').trim(), 20);
    const password = String(form.password || '');

    const fail = (status, error) =>
      htmlResponse(status, views.loginPage({ mode: 'signup', error, platformReady: true, hint: '' }));

    const allowed = await store.bumpRateLimit(`signup:${req.ip}`, LOGIN_WINDOW_MS, SIGNUP_LIMIT);
    if (!allowed) return fail(429, '注册太频繁了，请过一会儿再试。');
    if (!contactLooksValid(contact)) return fail(400, '请填写手机号或邮箱（手机号要写成纯数字）。');
    if (password.length < 8) return fail(400, '密码至少 8 位。');
    if (await store.getUserByContact(contact)) return fail(409, '这个手机号/邮箱已经注册过了，直接登录即可。');

    const user = await store.createUser({
      id: core.randomCode(12),
      contact,
      name,
      password_hash: await core.hashPassword(password),
      role: 'owner',
    });

    return redirectResponse('/me', { 'Set-Cookie': await sessionCookieHeader(req, `u:${user.id}`) });
  }

  function handleLogout() {
    return redirectResponse('/login', { 'Set-Cookie': CLEAR_COOKIE_HEADER });
  }

  /* --------------------------- 车主 / 平台后台 --------------------------- */

  /**
   * 请求体解析不出来时的统一处理。
   *
   * 存在的意义：`parseForm` 只认 urlencoded。如果哪天客户端改回 multipart，
   * 解析结果会是一个空对象 —— 拿它去写库就等于把用户已有的车牌、号码清空。
   * 所以宁可明确报错，也绝不静默写入空值。
   */
  function unparsableResponse(req, form) {
    if (!form.__unparsed) return null;
    const text = '提交的数据格式无法识别，这次没有保存任何内容。请刷新页面后重试。';
    return wantsFragments(req)
      ? jsonResponse(400, { ok: false, notice: text, kind: 'error' })
      : pageResponse(400, '提交失败', text);
  }

  /** 首屏和「局部刷新」共用同一份数据加载，避免两边算出不一样的结果 */
  async function loadDashboard(session, req) {
    const base = baseUrlOf(req);
    const isAdmin = session.kind === 'admin';

    const users = isAdmin ? await store.listUsers() : [];
    const userById = new Map(users.map((u) => [u.id, u]));

    const rows = isAdmin ? await store.listCars() : await store.listCarsByOwner(session.userId);
    const cars = [];
    for (const car of rows) {
      const owner = car.owner_id ? userById.get(car.owner_id) : null;
      cars.push(
        Object.assign({}, car, {
          qrSvg: qrSvgForContent(carUrl(car, base)),
          scanUrl: carUrl(car, base),
          editUrl: `${base}/edit/${await editTokenFor(car.id)}`,
          owner_contact: owner ? owner.contact : '',
        })
      );
    }

    return {
      base,
      isAdmin,
      account: isAdmin ? null : await store.getUser(session.userId),
      users,
      cars,
      // 贴纸编号：管理员看全部，车主只看自己生成的
      codes: isAdmin ? await store.listCodes(500) : await store.listCodesByOwner(session.userId, 500),
      messages: isAdmin
        ? await store.listMessages(100)
        : await store.listMessagesByOwner(session.userId, 100),
      unread: isAdmin ? await store.countUnread() : await store.countUnreadByOwner(session.userId),
      emptyCount: isAdmin
        ? cars.filter((car) => !car.plate && !car.phone && !car.call_number).length
        : 0,
    };
  }

  function universalInfo(data) {
    if (!data.isAdmin) return null;
    const enabled = data.cars.filter((car) => car.enabled);
    return {
      url: universalUrl(data.base),
      qrSvg: qrSvgForContent(universalUrl(data.base)),
      enabledCount: enabled.length,
      plates: enabled.map((car) => car.plate || '未填写车牌'),
    };
  }

  async function renderDashboard(session, req, url) {
    const data = await loadDashboard(session, req);
    const noticeKey = url.searchParams.get('notice');

    return htmlResponse(
      200,
      views.adminPage({
        mode: data.isAdmin ? 'admin' : 'owner',
        account: data.account,
        cars: data.cars,
        codes: data.codes,
        messages: data.messages,
        users: data.users,
        baseUrl: data.base,
        universal: universalInfo(data),
        unread: data.unread,
        notice: noticeKey && NOTICES[noticeKey] ? NOTICES[noticeKey] : null,
        cleanedCount: Number(url.searchParams.get('n')) || 0,
        emptyCount: data.emptyCount,
      })
    );
  }

  /** 前端带了这个头就是「别整页刷新，给我片段」 */
  function wantsFragments(req) {
    const headers = (req && req.headers) || {};
    return String(headers['x-requested-with'] || '').toLowerCase() === 'fetch';
  }

  /**
   * 改动完成后的响应。
   *   - AJAX：返回需要替换的片段（id → innerHTML），页面不重载
   *   - 普通表单提交：照旧 302 回后台（没有 JS 也能用）
   */
  async function afterChange(session, req, url, noticeKey) {
    if (!wantsFragments(req)) {
      return redirectResponse(`${homeFor(session)}?notice=${noticeKey}`);
    }

    const data = await loadDashboard(session, req);
    const notice = NOTICES[noticeKey] || null;

    return jsonResponse(200, {
      ok: true,
      // 前端拿它弹底部轻提示 —— 用户可能正滚在页面下方改东西，
      // 光在顶部更新提示区他根本看不到
      notice: notice ? { text: notice.text, kind: notice.kind } : null,
      html: {
        'notice-area': notice ? views.bannerHtml(notice.text, notice.kind) : '',
        'car-count': views.carCountHtml(data.cars.length),
        'car-actions': data.cars.length
          ? '<a class="btn btn-sm btn-primary" href="/print-all" target="_blank" rel="noreferrer">批量打印全部贴纸</a>'
          : '',
        'car-list': views.carListHtml(data.cars, { baseUrl: data.base, isAdmin: data.isAdmin }),
        'code-count': views.codeCountHtml(data.codes.length),
        'code-area': views.codeListHtml(data.codes, { cars: data.cars, isAdmin: data.isAdmin }),
        'empty-warn': views.emptyWarnHtml(data.emptyCount),
        'record-area': views.recordListHtml(data.messages),
        'record-actions': views.recordActionsHtml(data.unread),
        'user-count': views.userCountHtml(data.users.length),
        'user-area': views.userListHtml(data.users),
      },
      unread: data.unread,
      carCount: data.cars.length,
      resetNewCar: noticeKey === 'created',
    });
  }

  async function handleAdminHome(req, url) {
    const session = await currentSession(req);
    if (!session) return redirectResponse('/login');
    if (session.kind !== 'admin') return redirectResponse('/me');
    return renderDashboard(session, req, url);
  }

  async function handleMyCars(req, url) {
    const session = await currentSession(req);
    if (!session) return redirectResponse('/login');
    if (session.kind === 'admin') return redirectResponse('/admin');
    return renderDashboard(session, req, url);
  }

  function collectCarFields(form) {
    // 车牌：优先用「省 + 城市字母 + 号码」三段拼，拼不出来才用原样文字
    // （特殊车牌如 使/领/警/学/挂 没有省份代号，只能走原样那条路）
    const composed = core.composePlate(form.plate_province, form.plate_city, form.plate_rest);
    const rawPlate = core.normalizePlateRaw(form.plate);

    return {
      plate: core.truncate(composed || rawPlate, 20),
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
      // 也要避开已有编号：车辆编号本身就是一张贴纸的编号，
      // 撞上别人没绑定的空白编号会让这辆车一创建就「指向别人的贴纸」
      if (!(await store.getCar(id)) && !(await store.getCode(id))) return id;
    }
    throw new Error('无法生成唯一编号');
  }

  async function handleCreateCar(req, url) {
    const session = await currentSession(req);
    if (!session) return redirectResponse('/login');
    const raw = core.parseForm(await req.readText());
    const unparsable = unparsableResponse(req, raw);
    if (unparsable) return unparsable;
    const fields = collectCarFields(raw);

    // 空表单不建记录：否则后台很快堆满「未填写车牌」，通用码还会把它们列给扫码人看
    if (!carHasIdentity(fields)) {
      return wantsFragments(req)
        ? jsonResponse(400, { ok: false, notice: NOTICES.needinfo.text, kind: NOTICES.needinfo.kind })
        : redirectResponse(`${homeFor(session)}?notice=needinfo`);
    }

    const car = Object.assign(
      {
        id: await uniqueCarId(),
        // 车主建的归自己；平台方建的 owner_id 为空（属于平台自己录的车）
        owner_id: session.kind === 'user' ? session.userId : null,
      },
      fields
    );
    await store.createCar(car);
    // 每辆车天生带一张贴纸：编号就是车辆编号。
    // 建车时就把这行写下来，后台的编号列表才从第一刻起就是完整的
    // （老车由 db.js 启动时的迁移补齐，扫不到编号行时还有回落，见 resolveCode）。
    await store.createCode({
      code: car.id,
      car_id: car.id,
      owner_id: car.owner_id || null,
      note: '随车辆创建',
    });
    return afterChange(session, req, url, 'created');
  }

  async function handleUpdateCar(req, url, params) {
    const session = await currentSession(req);
    const found = await loadCarFor(session, params[0]);
    if (found.error) return found.error;

    // 修改**不做**「必须有车牌或号码」的校验：改一条已有记录时，
    // 用户很可能只动一个字段（比如只填个称呼），不能因为别的字段是空的就不让存。
    // 那条校验只拦「新建」，目的是别让后台堆满空白记录。
    const raw = core.parseForm(await req.readText());
    const unparsable = unparsableResponse(req, raw);
    if (unparsable) return unparsable;
    const fields = collectCarFields(raw);
    await store.updateCar(found.car.id, fields);
    return afterChange(session, req, url, 'updated');
  }

  /** 平台方专用：一次清掉所有空白车辆（车牌、号码全没有的） */
  async function handleCleanupEmpty(req, url) {
    const session = await currentSession(req);
    if (!session) return redirectResponse('/login');
    if (session.kind !== 'admin') return redirectResponse('/me');
    await store.deleteEmptyCars();
    return afterChange(session, req, url, 'cleaned');
  }

  async function handleDeleteCar(req, url, params) {
    const session = await currentSession(req);
    const found = await loadCarFor(session, params[0]);
    if (found.error) return found.error;
    // 先把这个车绑定的贴纸作废，再删车。
    // 反过来（只删车）会让编号行变成「未绑定」，那张贴纸扫开又变成可绑定的空白贴纸 ——
    // 车都没了，贴在它上面的码不该还活着。
    await store.deleteCodesByCar(found.car.id);
    await store.deleteCar(found.car.id);
    return afterChange(session, req, url, 'deleted');
  }

  /* ---------------------------- 贴纸编号 ---------------------------- */

  /**
   * 一个新编号：不能和已有编号重复，也不能撞上某辆车的编号
   * （车辆编号本身也是一个永远有效的码，撞了就会指向两辆车）。
   */
  async function uniqueCode() {
    for (let i = 0; i < 5; i++) {
      const code = core.randomCode(10);
      if (!(await store.getCode(code)) && !(await store.getCar(code))) return code;
    }
    throw new Error('无法生成唯一编号');
  }

  /** 这个编号归不归当前账号：管理员随意；车主只能碰自己名下的编号 */
  function codeBelongsTo(found, session) {
    if (!found) return false;
    if (session.kind === 'admin') return true;
    const owner = found.entry.owner_id || (found.car ? found.car.owner_id : null);
    return Boolean(owner) && owner === session.userId;
  }

  /**
   * 老贴纸（编号 = 车辆编号）在编号表里可能还没有行。
   * 要改它的绑定关系，就得先把这一行补出来 —— 否则改完一查，
   * 又会从「车辆编号」那条回落路径找回原来的车，改了等于没改。
   */
  async function materializeCode(found) {
    if (!found.entry.legacy) return;
    await store.createCode({
      code: found.code,
      car_id: found.car ? found.car.id : null,
      owner_id: found.entry.owner_id || null,
      note: '',
    });
  }

  /** 生成一批空白编号（未绑定），用于「先印一批，谁拿到谁绑定」 */
  async function handleCreateCodes(req, url) {
    const session = await currentSession(req);
    if (!session) return redirectResponse('/login');

    const raw = core.parseForm(await req.readText());
    const unparsable = unparsableResponse(req, raw);
    if (unparsable) return unparsable;

    const count = Math.max(1, Math.min(50, Math.floor(Number(raw.count) || 1)));
    const note = core.truncate(String(raw.note || '').trim(), 60);
    const ownerId = session.kind === 'user' ? session.userId : null;

    for (let i = 0; i < count; i++) {
      await store.createCode({ code: await uniqueCode(), owner_id: ownerId, note });
    }
    return afterChange(session, req, url, 'codes');
  }

  /** 把一张空白贴纸绑到某辆车上 */
  async function handleBindCode(req, url, params) {
    const session = await currentSession(req);
    if (!session) return redirectResponse('/login');

    const found = await resolveCode(params[0]);
    if (!found) return pageResponse(404, '编号不存在', '请确认二维码是否扫描完整。');
    if (!codeBelongsTo(found, session)) {
      return pageResponse(403, '绑定失败', '这个编号不属于当前账号。');
    }

    const raw = core.parseForm(await req.readText());
    const cars =
      session.kind === 'admin' ? await store.listCars() : await store.listCarsByOwner(session.userId);
    const car = cars.find((item) => item.id === String(raw.car_id || ''));
    if (!car) return pageResponse(403, '绑定失败', '这辆车不在当前账号下，或者已经被删除了。');

    await materializeCode(found);
    await store.bindCode(found.code, car.id, session.kind === 'admin' ? car.owner_id || null : session.userId);
    return afterChange(session, req, url, 'bound');
  }

  async function handleUnbindCode(req, url, params) {
    const session = await currentSession(req);
    if (!session) return redirectResponse('/login');

    const found = await resolveCode(params[0]);
    if (!found) return pageResponse(404, '编号不存在', '请确认二维码是否扫描完整。');
    if (!codeBelongsTo(found, session)) {
      return pageResponse(403, '解绑失败', '这个编号不属于当前账号。');
    }

    await materializeCode(found);
    await store.unbindCode(found.code);
    return afterChange(session, req, url, 'unbound');
  }

  async function handleDeleteCode(req, url, params) {
    const session = await currentSession(req);
    if (!session) return redirectResponse('/login');

    const found = await resolveCode(params[0]);
    if (!found) return afterChange(session, req, url, 'codedeleted');
    if (!codeBelongsTo(found, session)) {
      return pageResponse(403, '删除失败', '这个编号不属于当前账号。');
    }
    // 车辆编号本身就是永久有效的码（resolveCode 会回落到车辆），删了也会「复活」。
    // 与其骗用户，不如直接说清楚。
    if (await store.getCar(found.code)) {
      return wantsFragments(req)
        ? jsonResponse(400, { ok: false, notice: NOTICES.codefixed.text, kind: NOTICES.codefixed.kind })
        : redirectResponse(`${homeFor(session)}?notice=codefixed`);
    }

    await store.deleteCode(found.code);
    return afterChange(session, req, url, 'codedeleted');
  }

  /** 打印某一编号的贴纸（空白的也能打，打出来就是一张待绑定的贴纸） */
  async function handlePrintCode(req, url, params) {
    const session = await currentSession(req);
    if (!session) return redirectResponse('/login');

    const found = await resolveCode(params[0]);
    if (!found) return pageResponse(404, '编号不存在', '请确认二维码是否扫描完整。');
    if (!codeBelongsTo(found, session)) return redirectResponse('/login');

    const base = baseUrlOf(req);
    return htmlResponse(
      200,
      views.printPage(
        { id: found.code, plate: found.car ? found.car.plate || '' : '' },
        {
          baseUrl: base,
          qrSvg: qrSvgForContent(`${base}/c/${found.code}`),
          size: stickerSize(url),
          path: `/codes/${found.code}/print`,
          code: found.code,
          blank: !found.car,
        }
      )
    );
  }

  /** 一次打完所有还没绑定的空白贴纸 */
  async function handlePrintBlank(req, url) {
    const session = await currentSession(req);
    if (!session) return redirectResponse('/login');

    const base = baseUrlOf(req);
    const all =
      session.kind === 'admin'
        ? await store.listCodes(500)
        : await store.listCodesByOwner(session.userId, 500);
    const blank = all.filter((entry) => !entry.car_id);

    if (!blank.length) {
      return pageResponse(200, '没有待绑定的贴纸', '先在后台「贴纸编号」里生成一批空白编号。');
    }

    return htmlResponse(
      200,
      views.printAllPage({
        cars: blank.map((entry) => ({
          id: entry.code,
          plate: entry.code,
          qrSvg: qrSvgForContent(`${base}/c/${entry.code}`),
        })),
        baseUrl: base,
        size: stickerSize(url),
        path: '/print-blank',
        blank: true,
      })
    );
  }

  /** 通用二维码只服务平台方自己录的车（owner_id 为空），不碰车主的车 */
  async function platformCars() {
    return (await store.listCars()).filter((car) => !car.owner_id);
  }

  /** 通用二维码本身的 SVG（后台顶部那张） */
  async function handleUniversalQrSvg(req, url) {
    const session = await currentSession(req);
    if (!session || session.kind !== 'admin') return redirectResponse('/login');
    const disposition = url.searchParams.get('download') === '1' ? 'attachment' : 'inline';
    return response(
      200,
      Object.assign(
        {
          'Content-Type': 'image/svg+xml; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Disposition': `${disposition}; filename="chezai-universal.svg"`,
        },
        SECURITY_HEADERS
      ),
      qrSvgForContent(universalUrl(baseUrlOf(req)))
    );
  }

  /** 通用贴纸的打印页：一种设计，贴在任一车上 */
  async function handleUniversalPrint(req, url) {
    const session = await currentSession(req);
    if (!session || session.kind !== 'admin') return redirectResponse('/login');
    const base = baseUrlOf(req);
    return htmlResponse(
      200,
      views.printPage(
        { id: '', plate: '', placeholder: true },
        {
          baseUrl: base,
          qrSvg: qrSvgForContent(universalUrl(base)),
          universal: true,
          size: stickerSize(url),
          path: '/admin/print-universal',
        }
      )
    );
  }

  /** 批量打印：每辆车一张贴纸，排在一页里一次打完（车主只打自己的） */
  async function handlePrintAll(req, url) {
    const session = await currentSession(req);
    if (!session) return redirectResponse('/login');
    const base = baseUrlOf(req);
    const rows =
      session.kind === 'admin' ? await platformCars() : await store.listCarsByOwner(session.userId);
    const cars = rows
      .filter((car) => car.enabled)
      .map((car) => ({
        id: car.id,
        plate: car.plate || '未填写车牌',
        qrSvg: qrSvgForContent(carUrl(car, base)),
        scanUrl: carUrl(car, base),
      }));
    return htmlResponse(
      200,
      views.printAllPage({ cars, baseUrl: base, size: stickerSize(url), path: '/print-all' })
    );
  }

  async function handleQrSvg(req, url, params) {
    const session = await currentSession(req);
    const found = await loadCarFor(session, params[0]);
    if (found.error) return found.error;
    const car = found.car;

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
      qrSvgForContent(carUrl(car, baseUrlOf(req)))
    );
  }

  async function handlePrint(req, url, params) {
    const session = await currentSession(req);
    const found = await loadCarFor(session, params[0]);
    if (found.error) return found.error;
    const car = found.car;
    const base = baseUrlOf(req);
    return htmlResponse(
      200,
      views.printPage(car, {
        baseUrl: base,
        qrSvg: qrSvgForContent(carUrl(car, base)),
        size: stickerSize(url),
        path: `/cars/${car.id}/print`,
      })
    );
  }

  async function handleMarkRead(req, url, params) {
    const session = await currentSession(req);
    if (!session) return redirectResponse('/login');
    await store.markRead(params[0], session.kind === 'user' ? session.userId : null);
    return afterChange(session, req, url, 'read');
  }

  async function handleMarkAllRead(req, url) {
    const session = await currentSession(req);
    if (!session) return redirectResponse('/login');
    await store.markAllRead(session.kind === 'user' ? session.userId : null);
    return afterChange(session, req, url, 'readAll');
  }

  /* ----------------------------- 路由表 ---------------------------- */

  const ID = '([A-Za-z0-9_-]{1,40})';
  /** 管理令牌 = 编号 + '.' + base64url 签名 */
  const TOKEN = '([A-Za-z0-9_-]{1,40}\\.[A-Za-z0-9_-]{1,64})';

  const routes = [
    ['GET', /^\/healthz$/, async () => jsonResponse(200, { ok: true })],
    // 根路径：车主入口（直接进后台，没登录就去登录页）
    ['GET', /^\/$/, handleRoot],
    // 通用码：印在贴纸上给陌生人扫的，独立路径
    ['GET', /^\/m\/?$/, handleUniversalScan],
    ['GET', new RegExp(`^/c/${ID}$`), handleScan],
    ['POST', new RegExp(`^/c/${ID}/call$`), handlePostCall],
    // 扫到一张还没绑定的空白贴纸时，车主就地绑定
    ['POST', new RegExp(`^/c/${ID}/bind$`), handleBindFromScan],

    // 单辆车的管理链接：给别人用，不需要登录，也看不到别的车
    ['GET', new RegExp(`^/edit/${TOKEN}$`), handleCarEditPage],
    ['POST', new RegExp(`^/edit/${TOKEN}$`), handleCarEditSubmit],
    ['GET', new RegExp(`^/edit/${TOKEN}/print$`), handleCarEditPrint],

    ['GET', /^\/login$/, handleLoginForm],
    ['POST', /^\/login$/, handleLoginSubmit],
    ['GET', /^\/signup$/, handleSignupForm],
    ['POST', /^\/signup$/, handleSignupSubmit],
    ['POST', /^\/logout$/, handleLogout],
    // 兼容旧地址：老书签和 README 里都是 /admin/login
    ['GET', /^\/admin\/login$/, handleLoginForm],
    ['POST', /^\/admin\/login$/, handleLoginSubmit],
    ['POST', /^\/admin\/logout$/, handleLogout],

    // 车主：只看自己的车
    ['GET', /^\/me$/, handleMyCars],
    // 平台方：看全部
    ['GET', /^\/admin$/, handleAdminHome],
    ['POST', /^\/admin\/cleanup-empty$/, handleCleanupEmpty],
    ['GET', /^\/admin\/universal\.svg$/, handleUniversalQrSvg],
    ['GET', /^\/admin\/print-universal$/, handleUniversalPrint],

    // 车辆相关：车主和平台方共用，权限在处理器里按归属判断
    ['GET', /^\/print-all$/, handlePrintAll],
    ['POST', /^\/cars$/, handleCreateCar],
    ['POST', new RegExp(`^/cars/${ID}$`), handleUpdateCar],
    ['POST', new RegExp(`^/cars/${ID}/delete$`), handleDeleteCar],
    ['GET', new RegExp(`^/cars/${ID}/qr\\.svg$`), handleQrSvg],
    ['GET', new RegExp(`^/cars/${ID}/print$`), handlePrint],
    // 贴纸编号：先生成一批空白，谁拿到谁绑定；绑定关系随时可改
    ['POST', /^\/codes$/, handleCreateCodes],
    ['POST', new RegExp(`^/codes/${ID}/bind$`), handleBindCode],
    ['POST', new RegExp(`^/codes/${ID}/unbind$`), handleUnbindCode],
    ['POST', new RegExp(`^/codes/${ID}/delete$`), handleDeleteCode],
    ['GET', new RegExp(`^/codes/${ID}/print$`), handlePrintCode],
    ['GET', /^\/print-blank$/, handlePrintBlank],
    ['POST', /^\/messages\/(\d{1,12})\/read$/, handleMarkRead],
    ['POST', /^\/messages\/read-all$/, handleMarkAllRead],

    // 兼容旧地址（已经打印在纸上或存在书签里）
    ['GET', /^\/admin\/print-all$/, handlePrintAll],
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
