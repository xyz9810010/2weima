'use strict';

/**
 * 端到端冒烟测试：node scripts/e2e.js
 *
 * 会真的把 Node 版服务拉起来（临时端口 + 临时数据目录），然后走一遍完整流程：
 *   登录 → 建车 → 扫码 → 留言 → 拨号 → 后台看记录 → 停用 → 已读 → 删除
 * 跑完自动关服务、删临时数据，不碰项目里的 data/。
 *
 * 零依赖：只用 Node 内置的 fetch 与 child_process。
 * 这里刻意断言了几条「不能坏」的安全不变量（例如扫码页绝不能出现车主真实手机号），
 * 以后改代码把它们改坏了，这个脚本会立刻报出来。
 */

const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = Number(process.env.E2E_PORT || 38231);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = `e2e-${Math.random().toString(16).slice(2, 10)}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chezai-e2e-'));
const REAL_PHONE = '13800138000';
const CALL_NUMBER = '4001234567';

let pass = 0;
let fail = 0;

function check(name, ok, extra) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra === undefined ? '' : `  → ${extra}`}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/* ----------------------------- HTTP 小工具 ----------------------------- */

let cookie = '';

async function request(method, pathname, form, options = {}) {
  const headers = {};
  if (options.auth !== false && cookie) headers.cookie = cookie;

  let body;
  if (form) {
    body = new URLSearchParams(form).toString();
    headers['content-type'] = 'application/x-www-form-urlencoded';
  }

  const res = await fetch(BASE + pathname, { method, headers, body, redirect: 'manual' });
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];

  // 只在「浏览器真的会存下来」时才记住这个 Cookie：
  // http 下带 Secure 的 Cookie 浏览器不会回传，这里必须一样，否则测试会掩盖真实故障。
  for (const raw of setCookies) {
    const [pair] = raw.split(';');
    const isSecure = /;\s*Secure/i.test(raw);
    if (pathname === '/admin/logout') cookie = '';
    else if (!isSecure) cookie = pair;
  }

  return {
    status: res.status,
    location: res.headers.get('location') || '',
    headers: res.headers,
    setCookie: setCookies.join(' | '),
    text: await res.text(),
  };
}

const get = (p, options) => request('GET', p, null, options);
const post = (p, form, options) => request('POST', p, form || {}, options);

/* ------------------------------- 启动服务 ------------------------------ */

function startServer() {
  const child = spawn(process.execPath, [path.join(__dirname, 'start.js')], {
    cwd: path.join(__dirname, '..'),
    env: Object.assign({}, process.env, {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      ADMIN_PASSWORD: PASSWORD,
      SESSION_SECRET: 'e2e-fixed-session-secret',
      DATA_DIR,
      // 置空而不是不传：否则本地 .env 里的值会漏进来
      PUBLIC_BASE_URL: '',
      TRUST_PROXY: '0',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  return { child, dump: () => output };
}

async function waitForReady() {
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/* --------------------------------- 用例 -------------------------------- */

async function run() {
  section('1. 基础与鉴权');
  check('GET /healthz = 200', (await get('/healthz')).status === 200);
  check('未登录访问 / 跳登录页', (await get('/')).location === '/admin/login');
  check('未登录访问 /admin 跳登录页', (await get('/admin')).location === '/admin/login');

  const loginPage = await get('/admin/login');
  check('登录页 = 200', loginPage.status === 200 && loginPage.text.includes('name="password"'));
  check(
    '页面带 CSP 默认拒绝头',
    (loginPage.headers.get('content-security-policy') || '').includes("default-src 'none'")
  );

  check('错误密码 = 401', (await post('/admin/login', { password: 'nope' })).status === 401);

  const login = await post('/admin/login', { password: PASSWORD });
  check('正确密码 = 302 → /admin', login.status === 302 && login.location === '/admin', login.location);
  check('会话 Cookie 是 HttpOnly', login.setCookie.includes('HttpOnly'));
  check('http 下 Cookie 不带 Secure（带了下游就登不进去）', !login.setCookie.includes('Secure'));
  check('后台首页 = 200', (await get('/admin')).status === 200);

  section('2. 建车 → 扫码 → 留言 → 拨号');
  const created = await post('/admin/cars', {
    plate: '沪A·88888',
    owner_name: '张三',
    phone: REAL_PHONE,
    call_number: '400-123-4567',
    note: '临时停车，谢谢',
    enabled: 'on',
  });
  check('建车 = 302 notice=created', created.location.includes('notice=created'), created.location);

  const admin = await get('/admin');
  check('后台列出该车辆', admin.text.includes('沪A·88888'));
  check('后台内嵌二维码 SVG', admin.text.includes('<svg'));

  const code = (admin.text.match(/\/c\/([A-Za-z0-9_-]{10})/) || [])[1];
  check('拿到 10 位车辆编号', Boolean(code), code);
  if (!code) return;

  const scan = await get(`/c/${code}`);
  check('扫码页 = 200', scan.status === 200);
  check('扫码页显示车牌', scan.text.includes('沪A·88888'));
  check('扫码页显示对外隐私号', scan.text.includes(CALL_NUMBER));
  check('【安全】扫码页不含车主真实手机号', !scan.text.includes(REAL_PHONE), '真实号码泄露了！');

  const sent = await post(`/c/${code}/message`, {
    reason: '挡住了我的车，需要挪一下',
    content: '你好，你的车挡住出入口了，麻烦挪一下',
    contact: '13900000000',
  });
  check('留言 = 302 → sent 页', sent.location === `/c/${code}/sent`, sent.location);
  check('sent 页 = 200', (await get(`/c/${code}/sent`)).status === 200);

  const call = await post(`/c/${code}/call`);
  check('拨号打点 = 200 {ok:true}', call.status === 200 && call.text.includes('"ok":true'));

  const admin2 = await get('/admin');
  check('后台看到留言内容', admin2.text.includes('挡住出入口'));
  check('后台看到拨号记录', admin2.text.includes('扫码人发起了拨号'));
  check('后台能看到车主真实手机号（仅车主侧）', admin2.text.includes(REAL_PHONE));

  section('3. 二维码 / 打印 / 静态资源 / 404');
  const svg = await get(`/admin/cars/${code}/qr.svg`);
  check('QR = 200 image/svg+xml', svg.status === 200 && svg.headers.get('content-type').includes('svg'));
  const dl = await get(`/admin/cars/${code}/qr.svg?download=1`);
  check('下载模式带 attachment', (dl.headers.get('content-disposition') || '').includes('attachment'));
  check('打印页 = 200', (await get(`/admin/cars/${code}/print`)).status === 200);
  check('静态 /style.css = 200', (await get('/style.css')).status === 200);
  check('静态 /app.js = 200', (await get('/app.js')).status === 200);
  check('不存在的编号 = 404', (await get('/c/NoSuchCode9')).status === 404);
  check('未命中路由 = 404', (await get('/definitely-not-here')).status === 404);

  section('4. 输入校验与限流');
  const empty = await post(`/c/${code}/message`, { reason: '', content: '' });
  check('空内容 = 302 err=2', empty.location.includes('err=2'), empty.location);
  const long = await post(`/c/${code}/message`, { reason: '', content: 'x'.repeat(301) });
  check('超长内容 = 302 err=3', long.location.includes('err=3'), long.location);

  let limited = false;
  for (let i = 0; i < 10 && !limited; i++) {
    const res = await post(`/c/${code}/message`, { reason: '测试', content: `第 ${i} 条` });
    limited = res.location.includes('err=1');
  }
  check('同 IP 反复提交触发限流', limited, '循环 10 次仍未限流');

  section('5. 后台：改 / 停用 / 已读 / 删');
  const updated = await post(`/admin/cars/${code}`, {
    plate: '沪A·88888',
    owner_name: '张三',
    phone: REAL_PHONE,
    call_number: '400-123-4567',
    note: '改过了',
  });
  check('更新车辆 = 302 notice=updated', updated.location.includes('notice=updated'), updated.location);
  check('后台显示新备注', (await get('/admin')).text.includes('改过了'));

  await post(`/admin/cars/${code}`, {
    plate: '沪A·88888',
    owner_name: '张三',
    phone: REAL_PHONE,
    call_number: '400-123-4567',
    note: '改过了',
  });
  const disabled = await get(`/c/${code}`);
  check('未勾选 enabled 即停用', disabled.status === 403, disabled.status);

  check('标记单条已读 = 302', (await post('/admin/messages/1/read')).status === 302);
  check('全部已读 = 302', (await post('/admin/messages/read-all')).status === 302);

  const deleted = await post(`/admin/cars/${code}/delete`);
  check('删除车辆 = 302 notice=deleted', deleted.location.includes('notice=deleted'), deleted.location);
  check('删除后扫码 = 404', (await get(`/c/${code}`)).status === 404);

  section('6. 会话与越权');
  check('登出 = 302', (await post('/admin/logout')).location === '/admin/login');
  check('登出后后台跳登录页', (await get('/admin')).location === '/admin/login');
  const anon = await post('/admin/cars', { plate: '伪造' }, { auth: false });
  check('未登录建车被拒（302 登录页）', anon.status === 302, anon.status);
}

/* --------------------------------- 主流程 ------------------------------- */

/** 关服务并等它真的退出：Windows 上 sqlite 文件句柄没释放时删目录会 EPERM */
async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
}

function removeDataDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    console.log(`（临时目录没能删掉，可手动清理：${dir}）`);
  }
}

(async () => {
  const { child, dump } = startServer();
  let exitCode = 0;

  try {
    if (!(await waitForReady())) {
      console.error('\n服务启动失败，输出如下：\n');
      console.error(dump());
      process.exitCode = 1;
      return;
    }

    await run();

    console.log('\n──────────────────────────────');
    console.log(`通过 ${pass} 项，失败 ${fail} 项`);
    if (fail > 0) {
      console.log('（服务端日志）\n' + dump());
      exitCode = 1;
    }
  } catch (error) {
    console.error('\n测试异常中断：', error);
    console.error('\n（服务端日志）\n' + dump());
    exitCode = 1;
  } finally {
    await stopServer(child);
    removeDataDir(DATA_DIR);
  }

  process.exitCode = exitCode;
})();
