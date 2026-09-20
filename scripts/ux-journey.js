'use strict';

/**
 * 用户视角测试：用**真实浏览器**（本机 Chrome）走一遍完整流程。
 *
 * 和 `npm run e2e` 的区别（两个都要跑）：
 *   e2e 用 HTTP 断言，快而稳，但**看不到用户实际看到的东西**；
 *   这个脚本真的点、真的填、真的提交，所以抓得到这类问题：
 *     - 表单编码不对，提交上去是空字段（真发生过，会把车牌号码清空）
 *     - 提示条存在但在视野之外（真发生过，用户以为没保存）
 *     - 窄屏上标签被挤成一列一个字
 *   每一步都截图，供人眼看。
 *
 * 依赖：playwright-core + 本机 Chrome（项目本身仍零依赖，这是可选工具）。
 *   npm i playwright-core
 *   CHROME_PATH=/path/to/chrome node scripts/ux-journey.js
 * 它不进 `npm run verify` —— 那套是每次都要跑的。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** 项目本身零依赖，所以这里要能优雅地处理「没装 playwright-core」 */
function loadPlaywright() {
  const tries = ['playwright-core', 'playwright'];
  if (process.env.PLAYWRIGHT_PATH) tries.push(process.env.PLAYWRIGHT_PATH);
  for (const name of tries) {
    try {
      return require(name);
    } catch {
      /* 换下一个 */
    }
  }
  console.error('');
  console.error('这个脚本要用真实浏览器，需要 playwright-core（项目本身是零依赖，所以没装）。');
  console.error('');
  console.error('  在任意目录装一份：');
  console.error('    npm i playwright-core');
  console.error('  然后告诉脚本它在哪：');
  console.error('    PLAYWRIGHT_PATH=<那个目录>/node_modules/playwright-core node scripts/ux-journey.js');
  console.error('');
  console.error('  或者用 npx 临时装（会下载到缓存）：');
  console.error('    npx --yes -p playwright-core node scripts/ux-journey.js');
  console.error('');
  console.error('日常回归只需要 `npm run e2e`，这个脚本是补充，不是必需的。');
  process.exit(1);
}

const { chromium } = loadPlaywright();

const ROOT = path.join(__dirname, '..');
const SHOTS = path.join(os.tmpdir(), 'chezai-ux-shots');
const PORT = 38411;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chezai-ux-'));
const ADMIN_PW = 'ux-admin-password';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const findings = [];
const note = (level, text) => {
  findings.push({ level, text });
  console.log(`  ${level === 'BAD' ? '✗' : level === 'WARN' ? '!' : '✓'} ${text}`);
};

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
}

/**
 * 等「这一次操作」的提示。
 * 不能只等 .toast 出现 —— 上一步的提示可能还在，会立刻匹配到，
 * 等它到期消失后就误判成「没有反馈」（这个坑我踩过）。
 */
async function waitToast(page, expect) {
  await page
    .waitForFunction(
      (text) => {
        const el = document.querySelector('#toast-host .toast');
        return Boolean(el) && el.textContent.indexOf(text) >= 0;
      },
      expect,
      { timeout: 8000 }
    )
    .catch(() => null);
  const visible = await inViewport(page, '#toast-host .toast');
  const text = await page.locator('#toast-host .toast').first().innerText().catch(() => '(没有提示)');
  return { visible: visible.visible, text };
}

/** 元素是否真的在视口里（用户能不能看见） */
async function inViewport(page, selector) {
  const box = await page.locator(selector).first().boundingBox().catch(() => null);
  if (!box) return { visible: false, reason: '元素不存在' };
  const vp = page.viewportSize();
  const visible = box.y + box.height > 0 && box.y < vp.height;
  return { visible, box, vp };
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });

  const server = spawn(process.execPath, [path.join(ROOT, 'scripts/start.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(PORT), HOST: '127.0.0.1', ADMIN_PASSWORD: ADMIN_PW,
      SESSION_SECRET: 'ux-check-secret', DATA_DIR, PUBLIC_BASE_URL: '',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (c) => (serverLog += c));
  server.stderr.on('data', (c) => (serverLog += c));

  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* wait */ }
    await new Promise((r) => setTimeout(r, 100));
  }

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, // 手机尺寸：扫码人就是这个场景
    deviceScaleFactor: 1,
    locale: 'zh-CN',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    // headless 里没有电话拨号器，点 tel: 必然报这一句；真机上不会出现，不算页面问题
    if (text.includes("Failed to launch 'tel:")) return;
    errors.push(text);
  });

  try {
    /* ---------- 1. 车主输域名 vs 陌生人扫码 ---------- */
    console.log('\n【1】车主输域名进来，应该进后台；通用码在 /m');
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await shot(page, '01-root-goes-login');
    note(page.url().includes('/login') ? 'OK' : 'BAD', `输域名后到的是登录页：${page.url().replace(BASE, '')}`);
    const loginForm = await page.locator('input[name="password"]').count();
    note(loginForm > 0 ? 'OK' : 'BAD', '登录页有密码输入框');

    await page.goto(`${BASE}/m`, { waitUntil: 'domcontentloaded' });
    await shot(page, '02-universal-nocar');
    const uniText = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    note(uniText.includes('暂时无法联系车主') ? 'OK' : 'BAD', `通用码还没车时给人话：${uniText.slice(0, 50)}`);
    note((await page.locator('input[name="password"]').count()) === 0 ? 'OK' : 'BAD', '通用码页面不会露出登录表单');

    /* ---------- 2. 车主注册 ---------- */
    console.log('\n【2】车主注册');
    await page.goto(`${BASE}/signup`, { waitUntil: 'domcontentloaded' });
    await shot(page, '02-signup');
    await page.fill('input[name="contact"]', '13800001234');
    await page.fill('input[name="name"]', '张先生');
    await page.fill('input[name="password"]', 'user-password-123');
    await page.click('button[type="submit"]');
    await page.waitForURL('**/me', { timeout: 10000 });
    await shot(page, '03-my-cars-empty');
    note('OK', '注册后直接进「我的车辆」');

    /* ---------- 3. 新增一辆车（用下拉选车牌） ---------- */
    console.log('\n【3】新增车辆：只改称呼之前先建好车');
    await page.selectOption('select[name="plate_province"]', '浙');
    await page.selectOption('select[name="plate_city"]', 'G');
    await page.fill('input[name="plate_rest"]', '5RT71');
    const preview = await page.locator('[data-plate-preview]').innerText();
    note(preview.includes('浙G·5RT71') ? 'OK' : 'BAD', `实时预览显示：${preview}`);
    await page.fill('input[name="call_number"]', '16673911258');
    await shot(page, '04-new-car-filled');

    await page.click('form[action="/cars"] button[type="submit"]');

    // 关键：保存后用户能不能**看见**反馈
    const t1 = await waitToast(page, '已生成挪车码');
    note(t1.visible ? 'OK' : 'BAD', `建车后底部提示在视野内：${t1.visible ? '是' : '否'}（${t1.text}）`);
    await shot(page, '05-after-create-toast');

    const carCountText = await page.locator('#car-count').innerText().catch(() => '');
    note(carCountText.includes('1') ? 'OK' : 'BAD', `车辆数刷新为：${carCountText}`);
    note(page.url().includes('/me') ? 'OK' : 'BAD', `没有跳走（还在 ${page.url().replace(BASE, '')}）`);

    /* ---------- 4. 只改称呼（用户报的场景） ---------- */
    console.log('\n【4】只改一个字段：称呼');
    await page.click('details.car-edit > summary');
    await page.waitForTimeout(200);
    await page.fill('details.car-edit input[name="owner_name"]', '车主本人');
    // 先把页面滚到卡片处，模拟用户就在这一屏操作
    await page.locator('details.car-edit').scrollIntoViewIfNeeded();
    await shot(page, '06-edit-panel-open');

    await page.click('details.car-edit form[action^="/cars/"] button[type="submit"]');
    const t2 = await waitToast(page, '已保存修改');
    note(t2.visible ? 'OK' : 'BAD', `保存后提示在视野内：${t2.visible ? '是' : '否'}（${t2.text}）`);
    await shot(page, '07-after-save-toast');

    const stillOpen = await page.locator('details.car-edit[open]').count();
    note(stillOpen > 0 ? 'OK' : 'WARN', `保存后编辑面板${stillOpen > 0 ? '保持展开（不用重新点开）' : '被收起了'}`);

    const savedName = await page.locator('details.car-edit input[name="owner_name"]').inputValue();
    note(savedName === '车主本人' ? 'OK' : 'BAD', `称呼已存：${savedName}`);

    const plateKept = await page.locator('details.car-edit input[name="plate_rest"]').inputValue();
    note(plateKept === '5RT71' ? 'OK' : 'BAD', `车牌没被动：${plateKept}`);

    /* ---------- 5. 扫码人看到什么 ---------- */
    console.log('\n【5】陌生人扫码后看到的那一屏');
    const code = await page.locator('.scan-url').first().innerText().then((t) => t.trim().split('/').pop());
    await page.goto(`${BASE}/c/${code}`, { waitUntil: 'domcontentloaded' });
    await shot(page, '08-scan-page-phone');
    const scanText = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    note('INFO', `扫码页文字：${scanText.slice(0, 120)}`);

    const callBtn = page.locator('a.btn-call');
    const btnBox = await callBtn.boundingBox();
    note(btnBox && btnBox.height >= 44 ? 'OK' : 'BAD', `拨号按钮高度 ${btnBox ? Math.round(btnBox.height) : '?'}px（≥44 才算好按）`);
    const tel = await callBtn.getAttribute('href');
    note(tel && tel.startsWith('tel:') ? 'OK' : 'BAD', `按钮是 tel: 链接（${tel}）`);

    // 第一屏能不能看到按钮（不用滚动）
    const btnVisible = await inViewport(page, 'a.btn-call');
    note(btnVisible.visible ? 'OK' : 'WARN', `拨号按钮在第一屏内：${btnVisible.visible ? '是' : '否（要滚动）'}`);

    /* ---------- 6. 点一下按钮，页面会不会乱跑 ---------- */
    console.log('\n【6】点拨号按钮');
    await callBtn.click({ noWaitAfter: true }).catch(() => null);
    await page.waitForTimeout(600);
    note(page.url().includes(`/c/${code}`) ? 'OK' : 'WARN', `点击后仍停留在扫码页（tel: 未真的拨出）`);
    await shot(page, '09-after-tap-call');

    /* ---------- 7. 打印贴纸（用户最关心的产出物） ---------- */
    console.log('\n【7】打印贴纸：方形 / 长方形');
    await page.goto(`${BASE}/cars/${code}/print`, { waitUntil: 'domcontentloaded' });
    await shot(page, '10-print-square-screen');
    await page.emulateMedia({ media: 'print' });
    await shot(page, '11-print-square-paper');
    const sq = await page.locator('.sticker').boundingBox();
    note(sq && Math.abs(sq.width - 189) < 12 && Math.abs(sq.height - 189) < 12 ? 'OK' : 'WARN',
      `方形贴纸实际尺寸 ${sq ? Math.round(sq.width) + '×' + Math.round(sq.height) : '?'}px（96dpi 下 50mm≈189px）`);

    await page.goto(`${BASE}/cars/${code}/print?size=rect`, { waitUntil: 'domcontentloaded' });
    await page.emulateMedia({ media: 'print' });
    await shot(page, '12-print-rect-paper');
    const rc = await page.locator('.sticker').boundingBox();
    note(rc && Math.abs(rc.width - 378) < 16 && Math.abs(rc.height - 189) < 12 ? 'OK' : 'WARN',
      `长方形贴纸实际尺寸 ${rc ? Math.round(rc.width) + '×' + Math.round(rc.height) : '?'}px（100×50mm≈378×189px）`);
    await page.emulateMedia({ media: 'screen' });

    const printText = (await page.locator('.sticker').innerText()).replace(/\s+/g, ' ');
    note(!printText.includes('浙G') && !printText.includes(code) ? 'OK' : 'BAD',
      `贴纸上没有车牌也没有编号：${printText.slice(0, 40)}`);

    /* ---------- 8. 别人打开你发的管理链接 ---------- */
    console.log('\n【8】把管理链接发给别人后，他看到什么');
    await page.goto(`${BASE}/me`, { waitUntil: 'domcontentloaded' });
    const editHref = await page.locator('.edit-link').first().innerText();
    const strangerCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
    const stranger = await strangerCtx.newPage();
    await stranger.goto(editHref.trim(), { waitUntil: 'domcontentloaded' });
    await shot(stranger, '13-edit-link-stranger');
    const strangerText = (await stranger.locator('body').innerText()).replace(/\s+/g, ' ');
    note(strangerText.includes('管理我的挪车码') ? 'OK' : 'BAD', `别人能看到管理页`);
    note(!strangerText.includes('新增车辆') ? 'OK' : 'BAD', '别人看不到「新增车辆」（没有车辆列表）');
    note(!strangerText.includes('退出') ? 'OK' : 'BAD', '别人看不到后台入口');
    await strangerCtx.close();

    /* ---------- 9. 没有留号码的扫码页 ---------- */
    console.log('\n【9】车主没留号码时，扫码人看到什么');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/me`, { waitUntil: 'domcontentloaded' });
    await page.selectOption('select[name="plate_province"]', '粤');
    await page.selectOption('select[name="plate_city"]', 'B');
    await page.fill('input[name="plate_rest"]', '12345');
    await page.click('form[action="/cars"] button[type="submit"]');
    await page.waitForTimeout(900);

    const urls = await page.locator('.scan-url').allInnerTexts();
    const noNumCode = urls.map((u) => u.trim().split('/').pop()).find((c) => c !== code);
    note(Boolean(noNumCode) ? 'OK' : 'BAD', `又建了一辆只填车牌的车：${noNumCode}`);
    await page.goto(`${BASE}/c/${noNumCode}`, { waitUntil: 'domcontentloaded' });
    await shot(page, '14-scan-no-number');
    const noNumText = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    note(noNumText.includes('还没有留下联系电话') ? 'OK' : 'BAD', `明确告诉扫码人没号码：${noNumText.slice(0, 60)}`);
    note((await page.locator('a.btn-call').count()) === 0 ? 'OK' : 'BAD', '没有号码时不显示拨号按钮');

    /* ---------- 10. 平台后台 ---------- */
    console.log('\n【10】平台方（你）的后台');
    const adminCtx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
    const admin = await adminCtx.newPage();
    await admin.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await admin.fill('input[name="password"]', ADMIN_PW);
    await admin.click('button[type="submit"]');
    await admin.waitForURL('**/admin', { timeout: 10000 });
    await shot(admin, '15-admin-dashboard');
    const adminText = (await admin.locator('body').innerText()).replace(/\s+/g, ' ');
    note(adminText.includes('车主账号') ? 'OK' : 'BAD', '平台后台有车主账号列表');
    note(adminText.includes('通用二维码') ? 'OK' : 'BAD', '平台后台有通用码');
    note(adminText.includes('13800001234') ? 'OK' : 'BAD', '能看到车主账号');
    await adminCtx.close();

    /* ---------- 11. 桌面 / 手机后台 ---------- */
    console.log('\n【11】后台在两种屏幕下');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${BASE}/me`, { waitUntil: 'domcontentloaded' });
    await shot(page, '16-dashboard-desktop');
    const hScroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    note(!hScroll ? 'OK' : 'BAD', `桌面无横向滚动：${!hScroll}`);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/me`, { waitUntil: 'domcontentloaded' });
    await shot(page, '17-dashboard-phone');
    const hScroll2 = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    note(!hScroll2 ? 'OK' : 'BAD', `手机无横向滚动：${!hScroll2}`);
    const badge = await page.locator('.car-head > .badge').first().boundingBox();
    note(badge && badge.width > badge.height ? 'OK' : 'BAD',
      `「启用中」标签没有被挤成竖排（${badge ? Math.round(badge.width) + '×' + Math.round(badge.height) : '?'}px）`);

    /* ---------- 11b. 移动端专项：多尺寸 + 触控 + 内容优先级 ---------- */
    console.log('\n【11b】移动端专项（320 → 1440 全尺寸，技能清单要求）');
    for (const w of [320, 375, 414, 768, 1024, 1440]) {
      await page.setViewportSize({ width: w, height: w <= 414 ? 780 : 900 });
      await page.goto(`${BASE}/me`, { waitUntil: 'domcontentloaded' });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      note(!overflow ? 'OK' : 'BAD', `${w}px：无横向滚动`);
      if (w === 375) await shot(page, '19-mobile-375-dashboard');
      if (w === 768) await shot(page, '20-tablet-768-dashboard');
    }

    await page.setViewportSize({ width: 375, height: 780 });
    await page.goto(`${BASE}/me`, { waitUntil: 'domcontentloaded' });
    const smallBtn = await page.locator('.car .btn-sm, .car .btn-xs').first().boundingBox();
    note(smallBtn && smallBtn.height >= 44 ? 'OK' : 'BAD',
      `手机上小按钮高度 ${smallBtn ? Math.round(smallBtn.height) : '?'}px（技能要求 ≥44）`);
    const plateRest = await page.locator('input[name="plate_rest"]').first().boundingBox();
    note(plateRest && plateRest.width >= 90 ? 'OK' : 'WARN', `车牌号码输入框宽度 ${plateRest ? Math.round(plateRest.width) : '?'}px`);

    const order = await page.evaluate(() => {
      const y = (sel) => {
        const el = document.querySelector(sel);
        return el ? Math.round(el.getBoundingClientRect().top + window.scrollY) : -1;
      };
      return { cars: y('.card-cars'), newcar: y('.card-newcar') };
    });
    note(order.cars > 0 && order.cars < order.newcar ? 'OK' : 'BAD',
      `手机上先看到自己的车（车 y=${order.cars}，新增表单 y=${order.newcar}）`);
    await shot(page, '22-mobile-content-priority');

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${BASE}/me`, { waitUntil: 'domcontentloaded' });
    const orderDesk = await page.evaluate(() => {
      const y = (sel) => {
        const el = document.querySelector(sel);
        return el ? Math.round(el.getBoundingClientRect().top + window.scrollY) : -1;
      };
      return { cars: y('.card-cars'), newcar: y('.card-newcar') };
    });
    note(orderDesk.newcar > 0 && orderDesk.newcar < orderDesk.cars ? 'OK' : 'WARN',
      `桌面仍是「新增车辆」在前（表单 y=${orderDesk.newcar}，车 y=${orderDesk.cars}）`);

    await page.setViewportSize({ width: 780, height: 380 });
    await page.goto(`${BASE}/me`, { waitUntil: 'domcontentloaded' });
    const landOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    note(!landOverflow ? 'OK' : 'BAD', '横屏无横向滚动');
    await shot(page, '21-landscape-dashboard');

    // 扫码页在窄屏上，按钮和车牌是否还完好
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(`${BASE}/c/${code}`, { waitUntil: 'domcontentloaded' });
    const btn320 = await page.locator('a.btn-call').boundingBox();
    note(btn320 && btn320.height >= 44 ? 'OK' : 'BAD', `320px 宽下拨号按钮 ${btn320 ? Math.round(btn320.height) : '?'}px`);
    const plate320 = await page.locator('.hero-plate').boundingBox();
    note(plate320 && plate320.width <= 288 ? 'OK' : 'BAD', `320px 宽下车牌没有溢出（宽 ${plate320 ? Math.round(plate320.width) : '?'}px）`);
    await shot(page, '23-scan-320');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/me`, { waitUntil: 'domcontentloaded' });

    /* ---------- 12. 删除 ---------- */
    console.log('\n【12】删除车辆');
    page.on('dialog', (d) => d.accept());
    await page.click('details.car-edit > summary');
    await page.click('form[action$="/delete"] button[type="submit"]');
    const t3 = await waitToast(page, '已删除');
    note(t3.visible ? 'OK' : 'BAD', `删除后提示在视野内：${t3.visible ? '是' : '否'}（${t3.text}）`);
    await shot(page, '18-after-delete-toast');

    note(errors.length === 0 ? 'OK' : 'BAD', `浏览器控制台报错：${errors.length ? errors.join(' | ').slice(0, 200) : '无'}`);
  } catch (error) {
    note('BAD', `流程中断：${error.message}`);
    await shot(page, '99-error');
  } finally {
    await browser.close();
    server.kill();
    await new Promise((r) => setTimeout(r, 400));
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log('\n================ 汇总 ================');
  const bad = findings.filter((f) => f.level === 'BAD');
  const warn = findings.filter((f) => f.level === 'WARN');
  console.log(`问题 ${bad.length} 个，注意 ${warn.length} 个，截图在 ${SHOTS}`);
  for (const f of bad) console.log(`  ✗ ${f.text}`);
  for (const f of warn) console.log(`  ! ${f.text}`);
})();
