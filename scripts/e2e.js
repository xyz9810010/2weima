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
  Object.assign(headers, options.headers || {});

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

  // 根路径 = 车主入口；通用码在 /m
  {
    const root = await get('/');
    check('未登录访问根路径 → 登录页', root.status === 302 && root.location === '/login', root.status + ' ' + root.location);
    const uni = await get('/m');
    check('通用码路径在 /m', uni.status === 200, uni.status);
  }
  check('未登录访问 /admin 跳登录页', (await get('/admin')).location === '/login');
  check('未登录访问 /me 跳登录页', (await get('/me')).location === '/login');

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

  section('2. 建车 → 扫码 → 一键拨号');
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
  check('扫码页有 tel: 拨号按钮', scan.text.includes(`href="tel:${CALL_NUMBER}"`), '没有拨号按钮');
  check('拨号按钮指向「拨号号码」', !scan.text.includes(`tel:${REAL_PHONE}`));
  check('【安全】有独立拨号号码时，扫码页不含真实手机号', !scan.text.includes(REAL_PHONE), '真实号码泄露了！');
  check('扫码页已无留言表单', !scan.text.includes('name="content"') && !scan.text.includes('name="contact"'));

  const call = await post(`/c/${code}/call`);
  check('拨号打点 = 200 {ok:true}', call.status === 200 && call.text.includes('"ok":true'));

  const admin2 = await get('/admin');
  // 记录现在是一行一条（车牌 · 时间 · 状态），不再每条都重复那两句说明文字
  check(
    '后台看到拨号记录（车牌 + 时间那一行）',
    /<li class="msg[^"]*">\s*<span class="msg-plate">/.test(admin2.text) && admin2.text.includes('拨号记录'),
    '没看到记录行'
  );
  check('后台能看到车主填的号码（仅车主侧）', admin2.text.includes(REAL_PHONE));

  // 只针对「拨号记录」这块列表断言（页面别处会合法地出现 baseUrl 里的主机名）
  {
    const recordArea = (admin2.text.match(/<ul class="msg-list">[\s\S]*?<\/ul>/) || [''])[0];
    check(
      '【隐私】拨号记录区域不含任何 IP',
      recordArea.length > 0 && !/\d{1,3}(\.\d{1,3}){3}|::1|::ffff/.test(recordArea),
      recordArea.slice(0, 160)
    );
  }

  // 最硬的一条：直接看表结构，确认根本没有能存 IP / UA 的地方
  {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(DATA_DIR, 'chezai.db'));
    const cols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
    const rows = db.prepare('SELECT * FROM messages').all();
    db.close();
    check('【隐私】拨号记录表没有 ip / ua 列', !cols.includes('ip') && !cols.includes('ua'), cols.join(','));
    check('【隐私】拨号记录每行只关联车辆与时间', rows.length === 1 && rows[0].car_id === code, JSON.stringify(rows[0] || {}).slice(0, 120));
  }

  section('3. 只填真实手机号时，也必须能拨号（回归）');
  const onlyPhone = await post('/admin/cars', {
    plate: '京B·00001',
    owner_name: '李四',
    phone: '13711112222',
    call_number: '',
    note: '',
    enabled: 'on',
  });
  check('建车 = 302', onlyPhone.location.includes('notice=created'), onlyPhone.location);
  const admin3 = await get('/admin');
  const code2 = (admin3.text.match(/\/c\/([A-Za-z0-9_-]{10})/g) || [])
    .map((s) => s.slice(3))
    .find((c) => c !== code);
  check('拿到第二辆车编号 ' + code2, Boolean(code2));
  if (code2) {
    const scan2 = await get(`/c/${code2}`);
    check('未填「拨号号码」时，扫码页仍然有拨号按钮', scan2.text.includes('href="tel:13711112222"'), '没有回退到真实手机号');
    const call2 = await post(`/c/${code2}/call`);
    check('回退号码也能打点', call2.status === 200 && call2.text.includes('"ok":true'), call2.status);
  }

  section('4. 两个号码都没填时，不应该有拨号按钮');
  const noNumber = await post('/admin/cars', {
    plate: '粤C·00002', owner_name: '', phone: '', call_number: '', note: '', enabled: 'on',
  });
  check('建车 = 302', noNumber.location.includes('notice=created'), noNumber.location);
  const admin4 = await get('/admin');
  const code3 = (admin4.text.match(/\/c\/([A-Za-z0-9_-]{10})/g) || [])
    .map((s) => s.slice(3))
    .find((c) => c !== code && c !== code2);
  check('拿到第三辆车编号 ' + code3, Boolean(code3));
  if (code3) {
    const scan3 = await get(`/c/${code3}`);
    check('没有号码时扫码页不给拨号按钮', !scan3.text.includes('href="tel:'), '竟然有按钮');
    check('没有号码时给出明确提示', scan3.text.includes('还没有留下联系电话'));
    for (const c of [code2, code3]) await post(`/admin/cars/${c}/delete`);
    const afterCleanup = await get('/admin');
    check('清掉回归用例的两辆车', !afterCleanup.text.includes('京B·00001') && !afterCleanup.text.includes('粤C·00002'));
  }

  section('5. 二维码 / 打印 / 静态资源 / 404');
  const svg = await get(`/admin/cars/${code}/qr.svg`);
  check('QR = 200 image/svg+xml', svg.status === 200 && svg.headers.get('content-type').includes('svg'));
  const dl = await get(`/admin/cars/${code}/qr.svg?download=1`);
  check('下载模式带 attachment', (dl.headers.get('content-disposition') || '').includes('attachment'));
  check('打印页 = 200', (await get(`/admin/cars/${code}/print`)).status === 200);
  {
    // 贴纸必须能随便挪到别的车上，所以本体上不能出现会过期的车牌，也不该露出内部编号
    const one = (await get(`/admin/cars/${code}/print`)).text;
    const body = (one.split('<div class="sticker ')[1] || '').split('<p class="print-note">')[0];
    check('单张贴纸本体不印车牌（换车也不用重印）', !body.includes('沪A·88888'), body.slice(0, 200));
    check('单张贴纸本体不印编号', !body.includes(code), '编号露在贴纸上了');
  }

  // 三款尺寸：5×5cm 方形 / 6×6cm 方形 / 10×5cm 长方形
  {
    const def = await get(`/admin/cars/${code}/print`);
    check('默认尺寸是 5×5 方形', def.text.includes('class="sticker sticker-square"'), '默认不是方形');
    check(
      '打印页有三个尺寸切换入口',
      def.text.includes('?size=square') && def.text.includes('?size=square6') && def.text.includes('?size=rect')
    );

    const square = await get(`/admin/cars/${code}/print?size=square`);
    const square6 = await get(`/admin/cars/${code}/print?size=square6`);
    const rect = await get(`/admin/cars/${code}/print?size=rect`);
    check('?size=square 出方形贴纸', square.text.includes('class="sticker sticker-square"'));
    check('?size=square6 出 6×6 方形贴纸', square6.text.includes('class="sticker sticker-square6"'), '没有 6×6');
    check('6×6 顶部文案标了尺寸', square6.text.includes('6×6cm 正方形'), '标题没写尺寸');
    check('?size=rect 出长方形贴纸', rect.text.includes('class="sticker sticker-rect"'), '没有长方形');
    check('长方形版二维码在左、文字在右', /sticker-rect">\s*<div class="sticker-qr">/.test(rect.text));

    for (const [label, html] of [['方形', square.text], ['6×6 方形', square6.text], ['长方形', rect.text]]) {
      const body = (html.split('<div class="sticker ')[1] || '').split('<p class="print-note">')[0];
      check(`${label}贴纸有二维码`, body.includes('<svg'));
      check(`${label}贴纸有「扫码挪车」`, body.includes('扫码挪车'));
      check(`${label}贴纸不印车牌`, !body.includes('沪A·88888'));
      check(`${label}贴纸不印编号`, !body.includes(code));
    }

    // 文案三行：标题「扫码挪车」/ 副标题「临时停靠 · 请多包涵」/ 提示「车辆挡路请扫码联系车主」，三款都有
    for (const [label, html] of [['5×5', square.text], ['6×6', square6.text], ['长方形', rect.text]]) {
      const body = (html.split('<div class="sticker ')[1] || '').split('<p class="print-note">')[0];
      check(`${label}贴纸有副标题「临时停靠 · 请多包涵」`, body.includes('临时停靠 · 请多包涵'), '副标题没了');
      check(`${label}贴纸有提示「车辆挡路请扫码…」`, body.includes('车辆挡路请扫码'), '提示没了');
    }
    // 正方形是竖排：副标题在二维码之前；长方形是横排（码在左、字在右），不套这个顺序
    check(
      '5×5 竖排顺序：标题 → 副标题 → 二维码',
      square.text.indexOf('临时停靠') < square.text.indexOf('<svg'),
      '顺序不对'
    );
    check(
      '6×6 竖排顺序：标题 → 副标题 → 二维码',
      square6.text.indexOf('临时停靠') < square6.text.indexOf('<svg'),
      '顺序不对'
    );

    // 非法 / 未知尺寸一律回落到方形，不能白屏
    const bogus = await get(`/admin/cars/${code}/print?size=big`);
    check('未知尺寸回落到方形', bogus.status === 200 && bogus.text.includes('sticker-square'), bogus.status);

    /* ---- 打印页本身：预览、缩放提示、每行几张 ---- */
    check('单张贴纸打印页有 A4 纸版面预览', def.text.includes('class="paper paper-single"'));
    check('单张贴纸打印页提醒「缩放设成 100%」', def.text.includes('缩放'), '用户最容易踩的坑：缩放不是 100%');
    check('单张贴纸打印页说明沿边框裁剪', def.text.includes('裁剪'));
    check('打印说明放在纸的上面（不用滚过整张 A4 才看到）', def.text.indexOf('print-notes') < def.text.indexOf('class="paper'));

    const sheet = await get('/print-all?size=square');
    check('批量打印页也有 A4 版面预览', sheet.text.includes('class="paper"') && sheet.text.includes('sticker-sheet'));
    check('批量打印页写明每行几张（5×5 → 3 张）', /每行 3 张/.test(sheet.text), sheet.text.slice(0, 300));
    check('批量打印页也提醒缩放 100%', sheet.text.includes('缩放'));
    check('批量打印页写明「屏幕上怎么排，纸上就怎么排」', sheet.text.includes('屏幕上怎么排'));

    const sheet6 = await get('/print-all?size=square6');
    check('6×6 每行也是 3 张', /每行 3 张/.test(sheet6.text));
    const sheetRect = await get('/print-all?size=rect');
    check('10×5 长方形每行 1 张', /每行 1 张/.test(sheetRect.text), sheetRect.text.slice(0, 300));

    // 屏幕上「每行几张」必须等于打印时的行数，否则预览就是在骗人
    {
      const css = (await get('/style.css')).text;
      const printBlock = css.slice(css.indexOf('@media print'));
      check(
        '【关键】打印时隐藏工具栏和说明（纸上只要贴纸）',
        /\.print-toolbar,\s*\.print-note\s*\{\s*display: none;/.test(printBlock),
        '打印样式没隐藏工具栏'
      );
      const sheetStart = css.indexOf('.sticker-sheet {');
      const screenSheetRule = css.slice(sheetStart, sheetStart + 400);
      check(
        '屏幕与打印共用同一套贴纸网格（同一宽度、同一间距）',
        screenSheetRule.includes('width: 198mm') &&
          screenSheetRule.includes('gap: 5mm') &&
          /\.sticker-sheet \{\s*width: 100%;\s*max-width: 198mm;/.test(printBlock),
        '两套网格会算出不一样的每行张数'
      );
      check('纸张预览只在屏幕上画（打印时去掉轮廓与内边距）', /\.paper \{[\s\S]*?box-shadow: none;/.test(printBlock));
      check('打印页含「手机上按比例缩小」的说明', def.text.includes('print-note-mobile'));
      check(
        '手机端的纸张缩放只作用于屏幕（@media screen 限定）',
        /@media screen and \(max-width: 900px\) \{[\s\S]*?\.paper \{\s*zoom:/.test(css),
        '用了不带 screen 限定的媒体查询，缩放会漏进打印'
      );
      check(
        '「手机上按比例缩小」提示平时隐藏、窄屏才显示',
        /\.print-note-mobile \{\s*display: none;/.test(css) &&
          /\.print-note-mobile \{\s*display: block;/.test(css)
      );
    }

    // 二维码本体必须铺满画布。
    // 曾经画布按「含静默区的正方形内接于圆」放大 √2（为圆形轮廓留的），
    // 结果 44mm 的贴纸框里二维码本体只有 26mm，四周一大圈白边 —— 白扔 41% 的边长。
    {
      const { toSvg, encode } = require('../src/qr.js');
      const sample = `${BASE}/c/AbCdEfGhIj`;
      const canvasModules = Number(/width="(\d+)"/.exec(toSvg(sample, { scale: 8, quiet: 3 }))[1]) / 8;
      const cover = encode(sample).size / canvasModules;
      check('二维码本体铺满画布（没留圆形白边）', cover >= 0.8, `本体只占画布 ${(cover * 100).toFixed(0)}%`);
      const circleModules =
        Number(/width="(\d+)"/.exec(toSvg(sample, { scale: 8, quiet: 3, circular: true }))[1]) / 8;
      check(
        '只有显式开启圆形裁剪时才留 √2 对角线余量',
        Math.abs(circleModules / canvasModules - Math.SQRT2) < 0.03,
        `${circleModules} / ${canvasModules}`
      );
    }
  }
  check('静态 /style.css = 200', (await get('/style.css')).status === 200);
  check('静态 /app.js = 200', (await get('/app.js')).status === 200);
  check('不存在的编号 = 404', (await get('/c/NoSuchCode9')).status === 404);
  check('未命中路由 = 404', (await get('/definitely-not-here')).status === 404);
  check('留言接口已下线 = 404', (await post(`/c/${code}/message`, { content: 'x' })).status === 404);

  section('6. 把码给别人：单辆车的管理链接');
  {
    // 先造一辆「别人的车」，这样「看不到其他车」这条断言才有意义
    await post('/admin/cars', {
      plate: '苏D·12345', owner_name: '别人的车', phone: '13655556666', call_number: '', note: '', enabled: 'on',
    });

    const adminRow = await get('/admin');
    check('后台每辆车都有管理链接', adminRow.text.includes('这辆车的管理链接'));
    // 车列表是新的在前，所以必须按「卡片」定位，不能按出现顺序猜
    const cards = adminRow.text.split('<article class="car">').slice(1);
    const myCard = cards.find((c) => c.includes('沪A·88888')) || '';
    const otherCard = cards.find((c) => c.includes('苏D·12345')) || '';
    check('两辆车各有一条管理链接', Boolean(myCard) && Boolean(otherCard));
    const link = (myCard.match(/\/edit\/([A-Za-z0-9_-]{1,40}\.[A-Za-z0-9_-]{1,64})/) || [])[1] || '';
    check('能解析出本辆车的管理令牌 ' + link.slice(0, 14) + '…', Boolean(link), link);
    check('两辆车的管理链接不同', !otherCard.includes(link) && link.length > 0);

    if (link) {
      // 关键：一个「没登录」的独立客户端 —— 模拟拿到链接的另一个人
      const stranger = await request('GET', `/edit/${link}`, null, { auth: false });
      check('【关键】未登录也能打开（不需要后台密码）', stranger.status === 200, stranger.status);
      check('页面显示的是这辆车', stranger.text.includes('沪A·88888'));
      check('【隔离】页面不泄露其他车辆', !stranger.text.includes('苏D·12345'), '看到了别人的车');
      check('【隔离】没有车辆列表、没有拨号记录', !stranger.text.includes('拨号记录') && !stranger.text.includes('新增车辆'));

      const saved = await request(
        'POST',
        `/edit/${link}`,
        {
          plate: '沪A·88888',
          owner_name: '张三',
          phone: REAL_PHONE,
          call_number: '400-000-9999',
          note: '对方改的',
          enabled: 'on',
        },
        { auth: false }
      );
      check('未登录也能保存', saved.status === 302 && saved.location.includes('notice=saved'), saved.status);

      const scanAfter = await get(`/c/${code}`);
      check('改完扫码页立刻生效（换了号码）', scanAfter.text.includes('4000009999'), '没生效');
      check('同一张贴纸，编号和车牌都没变', scanAfter.text.includes('沪A·88888'));

      const printByStranger = await request('GET', `/edit/${link}/print`, null, { auth: false });
      check('对方也能自己打印贴纸', printByStranger.status === 200, printByStranger.status);

      const forged = await request(
        'GET',
        `/edit/${code}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`,
        null,
        { auth: false }
      );
      check('【安全】伪造令牌 = 404', forged.status === 404, forged.status);
      const noSig = await request('GET', `/edit/${code}`, null, { auth: false });
      check('【安全】只给编号不签名 = 404', noSig.status === 404, noSig.status);
    }

    // 清掉「别人的车」，并恢复原号码（后面几节还要用）
    const listAgain = await get('/admin');
    const otherCode = [...new Set((listAgain.text.match(/\/c\/([A-Za-z0-9_-]{10})/g) || []).map((s) => s.slice(3)))]
      .find((c) => c !== code);
    if (otherCode) await post(`/admin/cars/${otherCode}/delete`);
    await post(`/admin/cars/${code}`, {
      plate: '沪A·88888', owner_name: '张三', phone: REAL_PHONE, call_number: '400-123-4567', note: '改过了',
    });
  }

  section('7. 后台：改 / 停用 / 已读 / 删');
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

  section('8. 通用码（一张贴纸贴所有车）');
  {
    const base = BASE;
    const { toSvg } = require('../src/qr.js');

    // 上一节把车都删光了，正好先测「什么都没有」的情况
    check('一辆车都没有时通用码给出提示', (await get('/m')).status === 200);

    const adminRow = await get('/admin');
    check('后台顶部展示通用二维码', adminRow.text.includes('通用二维码'));
    check('后台写明通用码地址是 /m', adminRow.text.includes(`${base}/m`));

    const uniSvg = await get('/admin/universal.svg');
    check('通用码 SVG = 200', uniSvg.status === 200 && uniSvg.text.startsWith('<svg'), uniSvg.status);
    // SVG 是确定性的，直接和「用 /m 重新编码一次」的结果比对，
    // 这样能证明通用码里装的确实是 域名/m 而不是某辆车的固定编号
    check(
      '【关键】通用码内容 = 域名/m',
      uniSvg.text === toSvg(`${base}/m`, { scale: 8, quiet: 3 }),
      '通用码内容不对'
    );

    const a = await post('/admin/cars', {
      plate: '浙A·77777', owner_name: '车主甲', phone: '13800001111', call_number: '', note: '', enabled: 'on',
    });
    check('建第一辆启用中的车', a.location.includes('notice=created'), a.location);

    const direct = await get('/m');
    check('只启用 1 辆车时，通用码直达该车', direct.status === 200 && direct.text.includes('浙A·77777'), direct.status);
    check('直达时就有拨号按钮', direct.text.includes('href="tel:'));
    check('直达时没有选车牌页', !direct.text.includes('请选择挡路的车辆'));

    const b = await post('/admin/cars', {
      plate: '苏D·12345', owner_name: '车主乙', phone: '13655556666', call_number: '', note: '', enabled: 'on',
    });
    check('建第二辆启用中的车', b.location.includes('notice=created'), b.location);

    const picker = await get('/m');
    check('启用 2 辆车时，通用码显示选车牌页', picker.status === 200 && picker.text.includes('请选择挡路的车辆'), picker.status);
    check('选车牌页列出两辆车牌', picker.text.includes('浙A·77777') && picker.text.includes('苏D·12345'));
    check('选车牌页本身不给拨号链接（号码要点进去才出现）', !picker.text.includes('href="tel:'));
    check('后台顶部会说明「多辆车时扫码人要先选」', (await get('/admin')).text.includes('扫码页会先列出这些车牌'));

    const list5 = await get('/admin');
    const codes = [...new Set((list5.text.match(/\/c\/([A-Za-z0-9_-]{10})/g) || []).map((s) => s.slice(3)))];
    check('拿到两辆车编号', codes.length === 2, codes.join(','));
    check('点进某一辆就能拨号', (await get(`/c/${codes[0]}`)).text.includes('href="tel:'));

    const printAll = await get('/admin/print-all');
    check('批量打印页 = 200', printAll.status === 200);
    check('批量打印页正好两张贴纸', (printAll.text.match(/class="sticker sticker-/g) || []).length === 2);
    {
      // 只取贴纸本体：切到下面那行对号用的车牌小字之前
      const chunks = printAll.text
        .split('<div class="sticker ')
        .slice(1)
        .map((c) => c.split('<div class="sticker-url">')[0]);
      check(
        '【关键】贴纸本体不印车牌、不印编号，可随时挪到别的车上',
        chunks.length === 2 &&
          chunks.every((c) => !c.includes('浙A·77777') && !c.includes('苏D·12345') && !/编号|tz3n|编号 /.test(c)),
        chunks[0] ? chunks[0].slice(0, 200) : 'no sticker'
      );
      check('贴纸本体只有「扫码挪车」这一件事', chunks.every((c) => c.includes('扫码挪车')));
    }
    check(
      '贴纸框外另有一行车牌，纯粹用来对号',
      printAll.text.includes('浙A·77777') && printAll.text.includes('苏D·12345')
    );
    check('批量打印页不出现任何编号', !/编号/.test(printAll.text.split('<div class="sticker-sheet">')[0]), '标题区出现了编号');
    check('批量打印默认方形', (printAll.text.match(/class="sticker sticker-square"/g) || []).length === 2);

    const printAllRect = await get('/print-all?size=rect');
    check('批量打印可切长方形', (printAllRect.text.match(/sticker-rect/g) || []).length === 2, '长方形批量失败');

    const printAll6 = await get('/print-all?size=square6');
    check(
      '批量打印可切 6×6 方形',
      (printAll6.text.match(/class="sticker sticker-square6"/g) || []).length === 2,
      '6×6 批量失败'
    );

    const uniPrint = await get('/admin/print-universal');
    check('通用贴纸打印页 = 200', uniPrint.status === 200 && uniPrint.text.includes('通用贴纸'));
    check('通用贴纸不印任何车牌', !uniPrint.text.includes('浙A·77777') && !uniPrint.text.includes('苏D·12345'));

    for (const c of codes) await post(`/admin/cars/${c}/delete`);
    check('全部删掉后通用码又给出提示', (await get('/m')).status === 200);
  }

  section('9. 多租户：每个车主一个账号，互相看不见');
  {
    // 独立 Cookie jar 的客户端，模拟两个不同的车主
    function newClient() {
      let jar = '';
      const call = async (method, path, form) => {
        const headers = {};
        if (jar) headers.cookie = jar;
        let body;
        if (form) {
          body = new URLSearchParams(form).toString();
          headers['content-type'] = 'application/x-www-form-urlencoded';
        }
        const res = await fetch(BASE + path, { method, headers, body, redirect: 'manual' });
        for (const raw of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
          if (!/;\s*Secure/i.test(raw)) jar = raw.split(';')[0];
        }
        return { status: res.status, location: res.headers.get('location') || '', text: await res.text() };
      };
      return { get: (p) => call('GET', p), post: (p, f) => call('POST', p, f) };
    }

    const a = newClient();
    const b = newClient();

    const signupPage = await a.get('/signup');
    check('注册页可访问', signupPage.status === 200 && signupPage.text.includes('name="contact"'), signupPage.status);

    const wrongContact = await a.post('/signup', { contact: '不是手机号', password: 'password123' });
    check('联系方式不合法被拒', wrongContact.status === 400, wrongContact.status);
    const shortPw = await a.post('/signup', { contact: '13800000001', password: 'short' });
    check('密码太短被拒', shortPw.status === 400, shortPw.status);

    const signupA = await a.post('/signup', { contact: '13800000001', name: '车主甲', password: 'password-aaa' });
    check('车主甲注册成功 → /me', signupA.status === 302 && signupA.location === '/me', signupA.location);
    const dup = await b.post('/signup', { contact: '13800000001', password: 'password-bbb' });
    check('同一手机号不能重复注册', dup.status === 409, dup.status);

    const signupB = await b.post('/signup', { contact: '13800000002', name: '车主乙', password: 'password-bbb' });
    check('车主乙注册成功 → /me', signupB.status === 302 && signupB.location === '/me', signupB.location);

    const meA1 = await a.get('/me');
    check('车主甲的「我的车辆」= 200', meA1.status === 200, meA1.status);
    check('车主甲能新增车辆', meA1.text.includes('/cars'), meA1.status);
    check('车主后台没有通用码板块', !meA1.text.includes('通用二维码'), '多租户不该有平台级功能');
    check('车主后台没有车主账号列表', !meA1.text.includes('车主账号'), '看到了平台功能');

    const createA = await a.post('/cars', {
      plate: '甲A·11111', owner_name: '甲', phone: '13800000001', call_number: '', note: '', enabled: 'on',
    });
    check('车主甲建车成功', createA.status === 302 && createA.location.includes('notice=created'), createA.location);
    const createB = await b.post('/cars', {
      plate: '乙B·22222', owner_name: '乙', phone: '13800000002', call_number: '', note: '', enabled: 'on',
    });
    check('车主乙建车成功', createB.status === 302, createB.location);

    const meA2 = await a.get('/me');
    const meB2 = await b.get('/me');
    check('车主甲只看到自己的车', meA2.text.includes('甲A·11111') && !meA2.text.includes('乙B·22222'), '串号了');
    check('车主乙只看到自己的车', meB2.text.includes('乙B·22222') && !meB2.text.includes('甲A·11111'), '串号了');

    const codeA = (meA2.text.match(/\/c\/([A-Za-z0-9_-]{10})/) || [])[1];
    check('拿到车主甲的车牌编号 ' + codeA, Boolean(codeA));

    if (codeA) {
      check('【隔离】乙不能改甲的车', (await b.post(`/cars/${codeA}`, { plate: '被改了', enabled: 'on' })).status === 404);
      check('【隔离】乙不能删甲的车', (await b.post(`/cars/${codeA}/delete`)).status === 404);
      check('【隔离】乙不能下甲车的二维码', (await b.get(`/cars/${codeA}/qr.svg`)).status === 404);
      check('【隔离】乙不能打甲车的贴纸', (await b.get(`/cars/${codeA}/print`)).status === 404);
      const stillMine = await a.get('/me');
      check('甲的车没被改动', stillMine.text.includes('甲A·11111') && !stillMine.text.includes('被改了'));

      // 通用码（/m）绝不能把车主的车列出来
      const uniAfter = await get('/m', { auth: false });
      check('【隐私】通用码不暴露车主的车', !uniAfter.text.includes('甲A·11111') && !uniAfter.text.includes('乙B·22222'), '车主的车牌被公开了！');
    }

    // 平台方看得到全部 + 账号列表
    const adminRow = await get('/admin');
    check('平台方能看到两辆车', adminRow.text.includes('甲A·11111') && adminRow.text.includes('乙B·22222'));
    check('平台方能标出车主', adminRow.text.includes('车主 13800000001'));
    check('平台方有车主账号列表', adminRow.text.includes('车主账号（2）'), '没有账号列表');

    // 登录：正确 / 错误 / 账号不存在
    const fresh = newClient();
    check('错误密码 = 401', (await fresh.post('/login', { contact: '13800000001', password: 'wrong-pass' })).status === 401);
    check('不存在的账号 = 401', (await fresh.post('/login', { contact: '13900009999', password: 'whatever1' })).status === 401);
    const loginA = await fresh.post('/login', { contact: '13800000001', password: 'password-aaa' });
    check('车主用账号密码能登录', loginA.status === 302 && loginA.location === '/me', loginA.location);
    check('登录后能看到自己的车', (await fresh.get('/me')).text.includes('甲A·11111'));

    // 清掉这两辆测试车
    const aRow = await a.get('/me');
    for (const c of [...new Set((aRow.text.match(/\/c\/([A-Za-z0-9_-]{10})/g) || []).map((s) => s.slice(3)))]) {
      await a.post(`/cars/${c}/delete`);
    }
    const bRow = await b.get('/me');
    for (const c of [...new Set((bRow.text.match(/\/c\/([A-Za-z0-9_-]{10})/g) || []).map((s) => s.slice(3)))]) {
      await b.post(`/cars/${c}/delete`);
    }
  }

  section('11. 空记录防护（后台不该被空白车辆堆满）');
  {
    const carCount = (html) => Number((html.match(/车辆与贴纸（(\d+)）/) || [])[1] || -1);
    const before = await get('/admin');
    const baseCount = carCount(before.text);
    check('起始车辆数可读', baseCount >= 0, baseCount);

    // 空表单不该建出记录 —— 线上就是被这个坑过：11 辆全空的车，通用码还会把它们列给扫码人
    const empty = await post('/cars', { plate: '', owner_name: '', phone: '', call_number: '', note: '', enabled: 'on' });
    check('空表单建车被拦下', empty.status === 302 && empty.location.includes('notice=needinfo'), empty.location);
    check('后台车辆数没有增加', carCount((await get('/admin')).text) === baseCount, '还是建出来了');
    check('后台会说明为什么没建成', (await get('/admin?notice=needinfo')).text.includes('没建成'));

    // 只填一个号码也算有内容
    const onlyNumber = await post('/cars', { plate: '', owner_name: '', phone: '', call_number: '400-111-2222', note: '', enabled: 'on' });
    check('只填拨号号码可以建', onlyNumber.location.includes('notice=created'), onlyNumber.location);
    const list = await get('/admin');
    check('车辆数 +1', carCount(list.text) === baseCount + 1, carCount(list.text));
    const code = [...new Set((list.text.match(/\/c\/([A-Za-z0-9_-]{10})/g) || []).map((s) => s.slice(3)))].pop();
    check('拿到编号 ' + code, Boolean(code), code);

    if (code) {
      // 改成全空也要被拦
      // 「只改一个字段」：按浏览器的行为提交整份表单，只把称呼填上。
      // 修改不该受「必须有车牌或号码」那条限制 —— 那条只拦新建。
      const onlyName = await request('POST', `/cars/${code}`, {
        plate_province: '', plate_city: '', plate_rest: '', plate: '',
        owner_name: '只填了称呼', phone: '', call_number: '400-111-2222', note: '', enabled: 'on',
      }, { headers: { 'X-Requested-With': 'fetch' } });
      check('只改称呼也能保存（修改不做必填校验）', onlyName.status === 200, onlyName.status);
      check('称呼存进去了', (await get('/admin')).text.includes('只填了称呼'), '没存上');

      // 浏览器提交时其它字段是预填的，所以只改称呼不会动到车牌和号码
      const keepOthers = await request('POST', `/cars/${code}`, {
        plate_province: '粤', plate_city: 'B', plate_rest: '9X8K6',
        plate: '', owner_name: '只填了称呼', phone: '', call_number: '400-111-2222', note: '', enabled: 'on',
      }, { headers: { 'X-Requested-With': 'fetch' } });
      check('改称呼不影响车牌和号码', keepOthers.status === 200, keepOthers.status);
      const kept = await get('/admin');
      check('车牌还是 粤B·9X8K6', kept.text.includes('粤B·9X8K6'), '车牌丢了');
      check('号码还是 4001112222', kept.text.includes('4001112222'), '号码丢了');

      // 平台方的「清理空白车辆」按钮
      await post(`/cars/${code}/delete`);
      check('清掉测试车', carCount((await get('/admin')).text) === baseCount);
    }

    const cleaned = await post('/admin/cleanup-empty');
    check('平台方可以一键清理空白车辆', cleaned.location.includes('notice=cleaned'), cleaned.location);
  }

  section('12. 车牌结构化输入（省 + 字母 + 号码）');
  {
    const form = await get('/admin');
    check('表单有省份下拉', form.text.includes('name="plate_province"') && form.text.includes('>浙<'));
    check('表单有城市字母下拉', form.text.includes('name="plate_city"'));
    check('表单有号码输入框', form.text.includes('name="plate_rest"'));
    check('有特殊车牌兜底入口', form.text.includes('name="plate"'));

    // 车牌字母不含 I 和 O（跟 1、0 会看混）
    const citySelect = (form.text.match(/<select name="plate_city"[\s\S]*?<\/select>/) || [''])[0];
    const letters = [...citySelect.matchAll(/<option value="([A-Z])"/g)].map((m) => m[1]);
    check('字母选项不含 I / O', letters.length >= 24 && !letters.includes('I') && !letters.includes('O'), letters.join(''));

    // 三段拼成标准写法，且小写会被规范化
    // （用 粤B·9X8K6 而不是例子里的 浙G·5RT71 —— 后者在占位提示里也出现过，会让文本查找撞车）
    const created = await post('/cars', {
      plate_province: '粤', plate_city: 'b', plate_rest: '9x8k6',
      owner_name: '', phone: '', call_number: '13800138000', note: '', enabled: 'on',
    });
    check('结构化建车成功', created.location.includes('notice=created'), created.location);

    const list = await get('/admin');
    check('自动排版成 粤B·9X8K6（转大写）', list.text.includes('粤B·9X8K6'), '没排版');
    const card =
      list.text
        .split('<article class="car">')
        .slice(1)
        .find((c) => c.includes('粤B·9X8K6')) || '';
    const code = (card.match(/\/c\/([A-Za-z0-9_-]{10})/) || [])[1];
    check('拿到编号 ' + code, Boolean(code), code);

    if (code) {
      const scan = await get(`/c/${code}`);
      check('扫码页显示排版后的车牌', scan.text.includes('粤B·9X8K6'));

      // 再进来时要把车牌拆回三个控件
      const again = await get('/admin');
      check('编辑时回填省份', /<option value="粤" selected/.test(again.text), '省份没回填');
      check('编辑时回填字母', /<option value="B" selected/.test(again.text), '字母没回填');
      check('编辑时回填号码', again.text.includes('value="9X8K6"'), '号码没回填');

      // 特殊车牌走原样
      const special = await post(`/cars/${code}`, {
        plate_province: '', plate_city: '', plate_rest: '', plate: '使123456',
        owner_name: '', phone: '', call_number: '13800138000', note: '', enabled: 'on',
      });
      check('特殊车牌原样保存', special.location.includes('notice=updated'), special.location);
      check('后台显示 使123456', (await get('/admin')).text.includes('使123456'));

      // 三段填全时优先用三段，忽略原样框
      await post(`/cars/${code}`, {
        plate_province: '沪', plate_city: 'A', plate_rest: '12345', plate: '乱写的',
        owner_name: '', phone: '', call_number: '13800138000', note: '', enabled: 'on',
      });
      const final = await get('/admin');
      check('三段优先于原样框', final.text.includes('沪A·12345') && !final.text.includes('乱写的'));

      await post(`/cars/${code}/delete`);
      check('测试车已删除', !(await get('/admin')).text.includes('沪A·12345'));
    }
  }

  section('13. UI/UX 基础（可访问性 / 触控 / 图标）');
  {
    const css = (await get('/style.css')).text;
    check('键盘焦点可见（:focus-visible）', css.includes(':focus-visible'));
    check('尊重系统「减少动态效果」', css.includes('prefers-reduced-motion'));
    check('去掉移动端 300ms 点击延迟', css.includes('touch-action: manipulation'));
    check('适配 iPhone 安全区', css.includes('safe-area-inset'));
    check('深色模式有独立取值', css.includes('prefers-color-scheme: dark'));
    check('触摸目标有统一下限', css.includes('--tap-min'));
    check('间距用统一的节奏变量', css.includes('--sp-1') && css.includes('--sp-4'));

    // 前面几节把车都删光了，这里临时建一辆来看扫码页
    const before = await get('/admin');
    const known = new Set((before.text.match(/\/c\/([A-Za-z0-9_-]{10})/g) || []).map((s) => s.slice(3)));
    await post('/cars', { plate: 'UI检查·0001', phone: '13800138000', call_number: '', note: '', enabled: 'on' });
    const withCar = await get('/admin');
    const uiCode = [...new Set((withCar.text.match(/\/c\/([A-Za-z0-9_-]{10})/g) || []).map((s) => s.slice(3)))]
      .find((c) => !known.has(c));

    const scan = await get(`/c/${uiCode}`);
    check('临时车扫码页 = 200', scan.status === 200, scan.status);
    check('拨号按钮用内联 SVG 图标', scan.text.includes('btn-icon') && scan.text.includes('<svg'));
    check('不再用字体符号当图标（☎）', !scan.text.includes('&#9742;'), '还在用 ☎');
    check('拨号按钮有可读名称', scan.text.includes('aria-label="拨打车主电话"'));
    check('装饰性图标对屏幕阅读器隐藏', scan.text.includes('aria-hidden="true"'));
    check('扫码页标出「挡路的车辆」', scan.text.includes('挡路的车辆'));
    await post(`/cars/${uiCode}/delete`);

    const badSignup = await post('/signup', { contact: '不是手机号', password: 'password123' });
    check('错误提示会主动播报（role=alert）', badSignup.text.includes('role="alert"'), '没有 role=alert');
    check('页面声明了中文语言', badSignup.text.includes('lang="zh-CN"'));
    check('移动端视口含 viewport-fit=cover', badSignup.text.includes('viewport-fit=cover'));

    const adminRow = await get('/admin');
    check('后台不再用 emoji 当警告图标', !adminRow.text.includes('⚠'), '还有 ⚠️');
    check('脚本里有底部轻提示实现', (await get('/app.js')).text.includes('toast-host'));
    check('样式里有轻提示的定位', css.includes('.toast-host'));
    check('静态资源不做长缓存（改完立刻生效）', (await get('/style.css')).headers.get('cache-control') === 'no-cache', (await get('/style.css')).headers.get('cache-control'));
  }

  section('14. 局部刷新（改动不整页重载）');
  {
    const ajax = { headers: { 'X-Requested-With': 'fetch' } };
    const json = (res) => {
      try { return JSON.parse(res.text); } catch { return null; }
    };

    const dash = await get('/admin');
    for (const id of ['notice-area', 'car-list', 'car-count', 'car-actions', 'empty-warn', 'record-area', 'record-actions']) {
      check(`后台有可替换区域 #${id}`, dash.text.includes(`id="${id}"`), '缺这个 id');
    }
    check('改动类表单标了 data-remote', dash.text.includes('data-remote'));

    const before = new Set((dash.text.match(/\/c\/([A-Za-z0-9_-]{10})/g) || []).map((s) => s.slice(3)));

    const created = await request('POST', '/cars', {
      plate_province: '闽', plate_city: 'd', plate_rest: '6y7u8',
      owner_name: '', phone: '', call_number: '13800138000', note: '', enabled: 'on',
    }, ajax);
    check('AJAX 建车 = 200', created.status === 200, created.status);
    const payload = json(created);
    check('返回 JSON 而不是整页', payload !== null && !created.text.includes('<!doctype html>'));
    check('返回 ok:true', payload && payload.ok === true);
    check('片段里带上新车', payload && payload.html['car-list'].includes('闽D·6Y7U8'));
    check('片段里更新了车辆数', payload && payload.html['car-count'].includes('车辆与贴纸'), payload && payload.html['car-count']);
    check('新建后要求前端重置表单', payload && payload.resetNewCar === true);
    // 底部轻提示靠这个字段：用户可能正滚在页面下方，顶部提示他看不到
    check('带回可弹提示的文案', payload && payload.notice && payload.notice.text.includes('已生成'), payload && JSON.stringify(payload.notice));

    const code = payload ? (payload.html['car-list'].match(/\/c\/([A-Za-z0-9_-]{10})/g) || [])
      .map((s) => s.slice(3))
      .find((c) => !before.has(c)) : '';
    check('从片段里就能取到新编号 ' + code, Boolean(code), code);

    if (code) {
      const updated = json(await request('POST', `/cars/${code}`, {
        plate_province: '闽', plate_city: 'D', plate_rest: '6Y7U8',
        owner_name: '', phone: '', call_number: '13900139000', note: '改过了', enabled: 'on',
      }, ajax));
      check('AJAX 保存返回新片段', updated && updated.html['car-list'].includes('13900139000'));
      check('保存也带回「已保存」提示', updated && updated.notice && updated.notice.text.includes('已保存'), updated && JSON.stringify(updated.notice));

      const partial = await request('POST', `/cars/${code}`, {
        plate_province: '', plate_city: '', plate_rest: '', plate: '',
        owner_name: '只改称呼', phone: '', call_number: '13900139000', note: '', enabled: 'on',
      }, ajax);
      check('AJAX 改单个字段不再被拦（更新不做必填校验）', partial.status === 200, partial.status);

      const bad = await request('POST', '/cars', {
        plate_province: '', plate_city: '', plate_rest: '', plate: '', owner_name: '', phone: '', call_number: '', note: '', enabled: 'on',
      }, ajax);
      const badPayload = json(bad);
      check('AJAX 新建空白记录 = 400 且带说明', bad.status === 400 && badPayload && badPayload.ok === false && badPayload.notice.includes('还没建成'), bad.status);

      const removed = json(await request('POST', `/cars/${code}/delete`, {}, ajax));
      check('AJAX 删除后片段里没有它', removed && !removed.html['car-list'].includes('闽D·6Y7U8'));
    }

    // 关键：没有这个头时必须还是普通 302 —— 无 JS 也不能坏
    const list = await get('/admin');
    const known = new Set((list.text.match(/\/c\/([A-Za-z0-9_-]{10})/g) || []).map((s) => s.slice(3)));
    const plain = await post('/cars', {
      plate_province: '闽', plate_city: 'D', plate_rest: '6Y7U8',
      owner_name: '', phone: '', call_number: '13800138000', note: '', enabled: 'on',
    });
    check('不带 AJAX 头仍然是 302 跳转（无 JS 回退）', plain.status === 302 && plain.location.includes('notice=created'), `${plain.status} ${plain.location}`);

    const after = await get('/admin');
    const created2 = [...new Set((after.text.match(/\/c\/([A-Za-z0-9_-]{10})/g) || []).map((s) => s.slice(3)))]
      .find((c) => !known.has(c));
    if (created2) await post(`/cars/${created2}/delete`);
    check('测试车已清理', (await get('/admin')).text.includes('车辆与贴纸'));
  }

  section('15. 请求编码：解析失败绝不能清空数据');
  {
    // 真实浏览器曾经发过 multipart/form-data（fetch + FormData），
    // 而服务端只用 URLSearchParams 解析 —— 解析出来是空对象，
    // 保存一次就会把车牌和号码整个清掉。这条断言钉的就是这个。
    const list = await get('/admin');
    const known = new Set((list.text.match(/\/c\/([A-Za-z0-9_-]{10})/g) || []).map((s) => s.slice(3)));
    await post('/cars', {
      plate_province: '粤', plate_city: 'D', plate_rest: '7Z8Y9',
      owner_name: '', phone: '', call_number: '13800138000', note: '', enabled: 'on',
    });
    const withCar = await get('/admin');
    const code = [...new Set((withCar.text.match(/\/c\/([A-Za-z0-9_-]{10})/g) || []).map((s) => s.slice(3)))]
      .find((c) => !known.has(c));
    check('建了一辆用于编码测试的车 ' + code, Boolean(code));

    if (code) {
      const multipart =
        '------WebKitFormBoundaryE2E\r\n' +
        'Content-Disposition: form-data; name="plate_rest"\r\n\r\n\r\n' +
        '------WebKitFormBoundaryE2E--\r\n';
      const res = await fetch(`${BASE}/cars/${code}`, {
        method: 'POST',
        headers: {
          'content-type': 'multipart/form-data; boundary=----WebKitFormBoundaryE2E',
          'X-Requested-With': 'fetch',
          cookie,
        },
        body: multipart,
        redirect: 'manual',
      });
      check('multipart 请求被明确拒绝（不是静默写入空值）', res.status === 400, res.status);

      const after = await get('/admin');
      check('【安全】被拒绝后车牌还在（不会被清空）', after.text.includes('粤D·7Z8Y9'), '车牌被清掉了！');
      check('【安全】被拒绝后号码还在', after.text.includes('13800138000'), '号码被清掉了！');

      await post(`/cars/${code}/delete`);
      check('清掉编码测试车', !(await get('/admin')).text.includes('粤D·7Z8Y9'));
    }
  }

  section('16. 贴纸编号：一批空白贴纸，谁拿到谁绑定，绑定关系可改');
  {
    // 独立 Cookie jar，用来演「另一个车主」
    function newClient() {
      let jar = '';
      const call = async (method, path, form) => {
        const headers = {};
        if (jar) headers.cookie = jar;
        let body;
        if (form) {
          body = new URLSearchParams(form).toString();
          headers['content-type'] = 'application/x-www-form-urlencoded';
        }
        const res = await fetch(BASE + path, { method, headers, body, redirect: 'manual' });
        for (const raw of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
          if (!/;\s*Secure/i.test(raw)) jar = raw.split(';')[0];
        }
        return { status: res.status, location: res.headers.get('location') || '', text: await res.text() };
      };
      return { get: (p) => call('GET', p), post: (p, f) => call('POST', p, f) };
    }

    const codesIn = (html) =>
      [...new Set((html.match(/<code class="code-id">[A-Za-z0-9_-]{1,40}<\/code>/g) || []).map((s) => s.replace(/<[^>]+>/g, '')))];
    const heroPlate = (html) => (/<div class="hero-plate[^"]*">([^<]+)<\/div>/.exec(html) || [])[1] || '';

    // 平台方先建一辆车（老贴纸就是「编号 = 车辆编号」那种）
    const before = await get('/admin');
    const knownCars = new Set((before.text.match(/\/c\/([A-Za-z0-9_-]{10})/g) || []).map((s) => s.slice(3)));
    await post('/cars', {
      plate: '沪E·33333', owner_name: '平台', phone: '13800000031', call_number: '', note: '', enabled: 'on',
    });
    const withCar = await get('/admin');
    const carId = [...new Set((withCar.text.match(/\/c\/([A-Za-z0-9_-]{10})/g) || []).map((s) => s.slice(3)))].find(
      (c) => !knownCars.has(c)
    );
    check('平台方建了一辆用于编号测试的车 ' + carId, Boolean(carId));

    check('【兼容】老的车辆编号仍能扫开', (await get(`/c/${carId}`, { auth: false })).status === 200);
    check(
      '【兼容】老编号在后台编号列表里有自己的一行（迁移生效）',
      withCar.text.includes(`<code class="code-id">${carId}</code>`)
    );

    const gen = await post('/codes', { count: '3', note: '测试批次' });
    check('生成 3 个空白编号 = 302', gen.status === 302, gen.status);

    const page = await get('/admin');
    const beforeCodes = new Set(codesIn(before.text));
    const blanks = codesIn(page.text).filter((c) => !beforeCodes.has(c) && c !== carId);
    check(`生成后新增了 ${blanks.length} 个空白编号`, blanks.length === 3, blanks.join(','));
    check('后台把它们归到「待绑定」', page.text.includes('待绑定（') && page.text.includes(blanks[0]));

    const blank = blanks[0];

    const scanBlank = await get(`/c/${blank}`, { auth: false });
    check(
      '空白贴纸扫开 = 200 且提示还没绑定（不是 404）',
      scanBlank.status === 200 && scanBlank.text.includes('这张贴纸还没绑定车辆'),
      scanBlank.status
    );
    check('空白贴纸页给未登录的人一个登录入口', scanBlank.text.includes('我是车主，登录后绑定'));
    check('【隐私】空白贴纸页不泄露任何车牌', !scanBlank.text.includes('沪E·33333'));

    const anonBind = await post(`/c/${blank}/bind`, { car_id: carId }, { auth: false });
    check('未登录不能绑定（跳登录页）', anonBind.status === 302 && anonBind.location === '/login', anonBind.location);

    // 车主丙 = 复用第 9 节注册好的「车主甲」（同一 IP 的注册额度有限，这里只登录）
    const c = newClient();
    const loginC = await c.post('/login', { contact: '13800000001', password: 'password-aaa' });
    check('车主甲登录成功', loginC.status === 302 && loginC.location === '/me', loginC.location);
    await c.post('/cars', { plate: '甲A·33333', owner_name: '甲', phone: '13800000001', call_number: '', note: '', enabled: 'on' });
    await c.post('/cars', { plate: '甲A·44444', owner_name: '甲', phone: '13800000001', call_number: '', note: '', enabled: 'on' });
    const meC = await c.get('/me');
    const cCars = [...new Set((meC.text.match(/\/c\/([A-Za-z0-9_-]{10})/g) || []).map((s) => s.slice(3)))];
    check(`车主甲名下有两辆车`, cCars.length === 2, cCars.join(','));
    check('【隔离】车主甲看不到平台方的编号', !codesIn(meC.text).includes(carId), '串号了');

    await c.post('/codes', { count: '1' });
    const meC2 = await c.get('/me');
    const codeC = codesIn(meC2.text).find((x) => !cCars.includes(x));
    check('拿到车主甲自己生成的空白编号 ' + codeC, Boolean(codeC));

    // 绑定 → 改绑 → 解绑，全程只改「编号 ↔ 车」这一条关系
    const bind1 = await c.post(`/codes/${codeC}/bind`, { car_id: cCars[0] });
    check('车主甲把贴纸绑到自己的车 = 302', bind1.status === 302, bind1.status);
    const p1 = heroPlate((await c.get(`/c/${codeC}`, { auth: false })).text);

    await c.post(`/codes/${codeC}/bind`, { car_id: cCars[1] });
    const p2 = heroPlate((await c.get(`/c/${codeC}`, { auth: false })).text);
    check(
      `改绑后扫开的是另一辆车（${p1 || '空'} → ${p2 || '空'}）`,
      Boolean(p1 && p2) && p1 !== p2 && [p1, p2].every((p) => p.includes('甲A·'))
    );

    const unbind = await c.post(`/codes/${codeC}/unbind`);
    check('解绑 = 302', unbind.status === 302, unbind.status);
    const scanUnbound = await c.get(`/c/${codeC}`, { auth: false });
    check(
      '解绑后扫开又变回「还没绑定」',
      scanUnbound.status === 200 && scanUnbound.text.includes('这张贴纸还没绑定车辆')
    );

    // 扫一张平台方的空白贴纸，当场绑到甲自己的车（谁拿到谁绑定）
    const scanBind = await c.post(`/c/${blanks[1]}/bind`, { car_id: cCars[0] });
    check(
      '扫码绑定：谁拿到谁绑定，绑完回到扫码页',
      scanBind.status === 302 && scanBind.location === `/c/${blanks[1]}`,
      scanBind.location
    );
    const meC3 = await c.get('/me');
    check('绑定后这张贴纸出现在甲的后台', codesIn(meC3.text).includes(blanks[1]));
    const adminAfterBind = await get('/admin');
    check(
      '【归属】绑定后编号归了甲：平台方的列表里它挂在甲名下',
      adminAfterBind.text.includes(blanks[1]) && adminAfterBind.text.includes('13800000001')
    );

    // 越权：车主乙
    const d = newClient();
    const loginD = await d.post('/login', { contact: '13800000002', password: 'password-bbb' });
    check('车主乙登录成功', loginD.status === 302, loginD.location);
    await d.post('/cars', { plate: '乙B·55555', owner_name: '乙', phone: '13800000002', call_number: '', note: '', enabled: 'on' });
    const meD = await d.get('/me');
    const carD = (meD.text.match(/\/c\/([A-Za-z0-9_-]{10})/) || [])[1];
    check('车主乙有自己的车 ' + carD, Boolean(carD));

    check('【隔离】乙不能解绑甲的编号', (await d.post(`/codes/${codeC}/unbind`)).status === 403);
    check('【隔离】乙不能删除甲的编号', (await d.post(`/codes/${codeC}/delete`)).status === 403);
    check('【隔离】乙不能把甲的编号绑到自己的车', (await d.post(`/codes/${codeC}/bind`, { car_id: carD })).status === 403);
    check('【隔离】甲不能把编号绑到平台方的车', (await c.post(`/codes/${codeC}/bind`, { car_id: carId })).status === 403);
    check('【隔离】乙打不开甲的贴纸打印页', (await d.get(`/codes/${codeC}/print`)).status === 302);
    check('【隔离】乙的后台里没有甲的编号', !codesIn((await d.get('/me')).text).includes(codeC));

    // 「编号 = 车辆编号」删不掉：车辆还在，它就永远有效（删了会从回落路径「复活」）
    const delCarCode = await post(`/codes/${carId}/delete`);
    check(
      '车辆编号不允许删除，并跳回去解释原因',
      delCarCode.status === 302 && delCarCode.location.includes('notice=codefixed'),
      `${delCarCode.status} ${delCarCode.location}`
    );

    // 打印
    const printCode = await get(`/codes/${blank}/print`);
    check(
      '空白编号的打印页 = 200，二维码就指向这个编号',
      printCode.status === 200 && printCode.text.includes(`/c/${blank}`),
      printCode.status
    );
    check('空白贴纸的打印说明写明「还没绑定」', printCode.text.includes('空白贴纸') && printCode.text.includes('还没绑定'));
    const printBlank = await get('/print-blank');
    check(
      '批量打印空白贴纸 = 200 且把待绑定编号排进去了',
      printBlank.status === 200 &&
        printBlank.text.includes('批量打印空白贴纸') &&
        (printBlank.text.match(/sticker-url">[A-Za-z0-9_-]{10}</g) || []).length >= 1,
      printBlank.status
    );
  }

  section('17. 布局：长列表和长说明不能把页面撑爆');
  {
    // 记录是只增不减的：以前 20 条就把后台撑到 5.4 屏，这里造出 >10 条来验证封顶
    const before = await get('/admin');
    const known = new Set((before.text.match(/\/c\/([A-Za-z0-9_-]{10})/g) || []).map((s) => s.slice(3)));
    await post('/cars', {
      plate_province: '沪', plate_city: 'C', plate_rest: '12121',
      owner_name: '', phone: '', call_number: '13800138001', note: '', enabled: 'on',
    });
    const withCar = await get('/admin');
    const layoutCode = [...new Set((withCar.text.match(/\/c\/([A-Za-z0-9_-]{10})/g) || []).map((s) => s.slice(3)))]
      .find((c) => !known.has(c));
    check('建了一辆用于布局测试的车 ' + layoutCode, Boolean(layoutCode));

    if (layoutCode) {
      for (let i = 0; i < 12; i++) await post(`/c/${layoutCode}/call`);

      const page = await get('/admin');
      const records = page.text.split('id="record-area"')[1] || '';
      const [visiblePart, detailsPart = ''] = records.split('<details');
      const visible = (visiblePart.match(/<li class="msg/g) || []).length;
      const older = (detailsPart.match(/<li class="msg/g) || []).length;

      check('拨号记录默认只铺最近 10 条', visible === 10, `铺了 ${visible} 条`);
      check('更早的记录收进折叠区，条数对得上', older > 0 && records.includes(`还有 ${older} 条更早的记录`));
      check('记录是一行一条，不再每条重复那两句说明', !records.includes('有人点了一次'), '还在重复');
      check('隐私说明全页只写一次', (page.text.match(/不记录扫码人的 IP/g) || []).length === 1, '说明重复了');
      check(
        '详细说明收进可折叠区，默认不是文字墙',
        (page.text.match(/<details class="card-help">/g) || []).length >= 3,
        '说明还摊在页面上'
      );

      await post(`/cars/${layoutCode}/delete`);
    }
  }

  section('18. 会话与越权');
  check('登出 = 302', (await post('/logout')).location === '/login');
  check('登出后后台跳登录页', (await get('/admin')).location === '/login');
  const anon = await post('/cars', { plate: '伪造' }, { auth: false });
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
