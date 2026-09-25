'use strict';

const core = require('./core');
const { esc, fmtTime, fmtShortTime } = core;

/* ------------------------------------------------------------------ */
/* 内联 SVG 图标                                                       */
/*                                                                     */
/* 图标一律内联 SVG：字体符号（☎）在不同系统里长得不一样，               */
/* 也没法跟随文字颜色和粗细。装饰性图标全部 aria-hidden。                */
/* ------------------------------------------------------------------ */

const ICON_PHONE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.2 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`;

const ICON_WARN = `<svg class="warn-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;

const ICON_CAR = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 11l1.6-4.2A2 2 0 0 1 8.5 5.5h7a2 2 0 0 1 1.9 1.3L19 11"/><path d="M4 11h16a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-1.5"/><path d="M4 11a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h1.5"/><path d="M7 17v1.5M17 17v1.5"/><path d="M7.5 13.5h.01M16.5 13.5h.01"/></svg>`;

const ICON_TAG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.6 13.4 12.6 21.4a2 2 0 0 1-2.8 0L3 14.6V4h10.6l7 7a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="8.5" r="0.5"/></svg>`;

const ICON_BELL = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 8-3 8h18s-3-1-3-8"/><path d="M13.7 20a2 2 0 0 1-3.4 0"/></svg>`;

const ICON_USERS = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>`;

/* 品牌记号：二维码定位图形（泊流「三座灯塔」的抽象） */
const BRAND_MARK = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" fill-rule="evenodd" d="M3 3h7v7H3V3zm1.75 1.75v3.5h3.5v-3.5h-3.5zM14 3h7v7h-7V3zm1.75 1.75v3.5h3.5v-3.5h-3.5zM3 14h7v7H3v-7zm1.75 1.75v3.5h3.5v-3.5h-3.5zM14 14h2.5v2.5H14V14zm4.5 0H21v2.5h-2.5V14zM14 18.5h2.5V21H14v-2.5zm4.5 0H21V21h-2.5v-2.5z"/></svg>`;

/**
 * 泊流静态切片：点阵网格 + 车道虚线 + 一座灯塔。
 * 纯装饰（aria-hidden），用 currentColor 上色，随主题自动适配；
 * 布局是确定性排布（品牌固定图案），不是每次随机的。
 */
function tidePattern(extraClass = '') {
  return `<svg class="tide ${extraClass}" viewBox="0 0 240 110" aria-hidden="true" focusable="false">
  <g fill="currentColor">
    <rect x="10" y="14" width="8" height="8" rx="2.5" opacity=".14"/>
    <rect x="26" y="30" width="8" height="8" rx="2.5" opacity=".26"/>
    <rect x="42" y="14" width="8" height="8" rx="2.5" opacity=".2"/>
    <rect x="58" y="30" width="8" height="8" rx="2.5" opacity=".12"/>
    <rect x="74" y="46" width="8" height="8" rx="2.5" opacity=".24"/>
    <rect x="90" y="30" width="8" height="8" rx="2.5" opacity=".16"/>
    <rect x="106" y="14" width="8" height="8" rx="2.5" opacity=".28"/>
    <rect x="122" y="30" width="8" height="8" rx="2.5" opacity=".12"/>
    <rect x="138" y="46" width="8" height="8" rx="2.5" opacity=".22"/>
    <rect x="154" y="30" width="8" height="8" rx="2.5" opacity=".14"/>
    <rect x="26" y="62" width="8" height="8" rx="2.5" opacity=".2"/>
    <rect x="58" y="78" width="8" height="8" rx="2.5" opacity=".16"/>
    <rect x="90" y="62" width="8" height="8" rx="2.5" opacity=".26"/>
    <rect x="122" y="78" width="8" height="8" rx="2.5" opacity=".14"/>
    <rect x="154" y="62" width="8" height="8" rx="2.5" opacity=".2"/>
    <rect x="106" y="94" width="8" height="8" rx="2.5" opacity=".18"/>
    <rect x="42" y="94" width="8" height="8" rx="2.5" opacity=".12"/>
    <rect x="138" y="94" width="8" height="8" rx="2.5" opacity=".24"/>
  </g>
  <g fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="7 9" stroke-linecap="round" opacity=".32">
    <path d="M8 56 C 52 48, 100 64, 148 54 S 214 46, 232 54"/>
  </g>
  <g aria-hidden="true">
    <rect x="192" y="26" width="34" height="34" rx="8" fill="none" stroke="currentColor" stroke-width="3" opacity=".85"/>
    <rect x="201" y="35" width="16" height="16" rx="4" fill="currentColor" opacity=".85"/>
  </g>
</svg>`;
}

/* 扫码页拨号按钮背后的涟漪：泊流的「连接脉冲」——
   一个信号从贴纸出发，把车主和陌生人连在同一条波前上 */
const RIPPLE_SVG = `<svg class="tide-ripple" viewBox="0 0 480 240" preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false">
  <g fill="none" stroke="currentColor" stroke-width="2">
    <circle cx="240" cy="250" r="64" opacity=".55"/>
    <circle cx="240" cy="250" r="112" opacity=".4"/>
    <circle cx="240" cy="250" r="160" opacity=".28"/>
    <circle cx="240" cy="250" r="208" opacity=".18"/>
  </g>
</svg>`;

/* 卡片标题旁的小图标（语义装饰，跟随 --primary） */
function cardIcon(icon) {
  return `<span class="card-icon" aria-hidden="true">${icon}</span>`;
}

/* 计数标题：首屏和 AJAX 局部刷新必须共用同一份实现，
   否则保存一次之后图标消失（「点一下变了样」）。 */
function carCountHtml(n) {
  return `${cardIcon(ICON_CAR)}车辆与贴纸（${n}）`;
}

function codeCountHtml(n) {
  return `${cardIcon(ICON_TAG)}贴纸编号（${n}）`;
}

function userCountHtml(n) {
  return `${cardIcon(ICON_USERS)}车主账号（${n}）`;
}

function layout({ title, body, bodyClass = '' }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="format-detection" content="telephone=no">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#eef3f8">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0f141b">
<title>${esc(title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/favicon.svg">
<link rel="stylesheet" href="/style.css">
<script src="/app.js" defer></script>
</head>
<body${bodyClass ? ` class="${esc(bodyClass)}"` : ''}>
${body}
</body>
</html>`;
}

function banner(text, kind = 'error') {
  return bannerHtml(text, kind);
}

/** 同一份横幅渲染，AJAX 片段也用它 */
function bannerHtml(text, kind = 'error') {
  // 错误要立刻被屏幕阅读器读出来，而不是等用户自己逛到那一行
  const role = kind === 'error' ? ' role="alert"' : '';
  return `<div class="banner banner-${esc(kind)}"${role}>${esc(text)}</div>`;
}

/* ------------------------------------------------------------------ */
/* 扫码方页面                                                          */
/* ------------------------------------------------------------------ */

function scanPage(car, { dialNumber }) {
  const plate = car.plate || '未填写车牌';
  const note = car.note || '您好，如果我的车挡住了您，请点下面的按钮联系我，谢谢！';

  const callBlock = dialNumber
    ? `<a class="btn btn-call btn-block" href="tel:${esc(dialNumber)}"
          data-call-log="/c/${esc(car.id)}/call" aria-label="拨打车主电话">
         <span class="btn-icon" aria-hidden="true">${ICON_PHONE}</span>
         <span>一键拨号</span>
       </a>
       <p class="hint center">点击后手机将拨打车主留下的联系电话。</p>`
    : `<div class="notice">车主还没有留下联系电话，暂时无法拨号。</div>`;

  return layout({
    title: `挪车提醒 · ${plate}`,
    body: `<main class="wrap wrap-scan">
  ${tidePattern('tide-hero')}
  <div class="hero">
    <div class="hero-label">挡路的车辆</div>
    <div class="hero-plate plate-chip">${esc(plate)}</div>
    <h1 class="hero-title">这是一辆临时停放的车辆</h1>
  </div>

  <section class="card card-note">
    <p class="note-text">${esc(note)}</p>
  </section>

  <section class="card action-card">
    ${RIPPLE_SVG}
    ${callBlock}
  </section>

  <p class="foot-note">
    本页面由车主自行设置。<br>
    请勿拨打骚扰或广告电话。
  </p>
</main>`,
  });
}

/**
 * 通用码在「启用了多辆车」时的落地页：让扫码人指认是哪辆车。
 * 人就站在车前面，照着车牌点一下即可；页面不展示任何号码。
 */
function pickCarPage(cars) {
  const items = cars
    .map(
      (car) => `<a class="pick-item" href="/c/${esc(car.id)}">
      <span class="pick-plate" translate="no">${esc(car.plate)}</span>
      ${car.owner_name ? `<span class="pick-owner">${esc(car.owner_name)} 的车</span>` : ''}
      ${car.hasNumber ? '' : '<span class="pick-warn">暂未留电话</span>'}
    </a>`
    )
    .join('\n');

  return layout({
    title: '请选择挡路的车辆',
    body: `<main class="wrap wrap-scan">
  ${tidePattern('tide-hero')}
  <div class="hero">
    <h1 class="hero-title">请选择挡路的车辆</h1>
    <div class="hero-sub">点一下车牌，就能直接拨给车主</div>
  </div>

  <section class="card">
    <div class="pick-list">${items}</div>
  </section>

  <p class="foot-note">
    这些车辆都由同一位车主登记。<br>
    请勿拨打骚扰或广告电话。
  </p>
</main>`,
  });
}

/**
 * 单辆车的管理页：把链接发给开这辆车的人，对方只能改这一辆。
 * 刻意做得很窄：没有车辆列表、没有拨号记录、没有其他车的信息。
 */
function carEditPage({ car, token, dialNumber, notice }) {
  const plate = car.plate || '未填写车牌';
  return layout({
    title: `管理挪车码 · ${plate}`,
    body: `<main class="wrap wrap-narrow">
  <section class="card">
    <h1 class="card-title">管理我的挪车码</h1>
    <p class="muted">
      这个页面只能修改 <b>${esc(plate)}</b> 这一辆车（编号 <code translate="no">${esc(car.id)}</code>）。
    </p>
    ${notice ? banner(notice, 'info') : ''}
    ${dialNumber ? '' : banner('现在两个号码都是空的，扫码页不会有拨号按钮。请至少填一个。')}
    ${carForm(car, `/edit/${esc(token)}`, '保存')}
  </section>

  <section class="card">
    <h2 class="card-title">这辆车的扫码页</h2>
    <p class="hint">改完立刻生效。<b>贴纸不用重印</b> —— 二维码里只有网址，车牌和号码是扫码时现查的。</p>
    <div class="btn-row">
      <a class="btn btn-sm btn-ghost" href="/c/${esc(car.id)}" target="_blank" rel="noreferrer">预览扫码页</a>
      <a class="btn btn-sm btn-ghost" href="/edit/${esc(token)}/print" target="_blank" rel="noreferrer">打印贴纸</a>
    </div>
  </section>
</main>`,
  });
}

function messagePage({ title, text, bodyHtml = '' }) {
  return layout({
    title,
    body: `<main class="wrap wrap-scan">
  <section class="card center-card">
    <h1 class="ok-title">${esc(title)}</h1>
    <p class="muted">${esc(text)}</p>
    ${bodyHtml}
  </section>
</main>`,
  });
}

/* ------------------------------------------------------------------ */
/* 车主后台                                                            */
/* ------------------------------------------------------------------ */

/**
 * 登录 / 注册。
 *
 * 登录表单里「账号」留空 = 平台方，用后台密码进；填了 = 车主账号。
 * 一个页面两种身份，少一个入口少一份困惑。
 */
function loginPage({ mode = 'login', error = '', platformReady = true, hint = '' }) {
  const isSignup = mode === 'signup';

  const form = isSignup
    ? `<form method="post" action="/signup" class="stack">
      <label class="field">
        <span class="label">手机号或邮箱</span>
        <input type="text" name="contact" autocomplete="username" required autofocus
          placeholder="13800138000 或 you@example.com">
      </label>
      <label class="field">
        <span class="label">怎么称呼 <span class="hint-inline">选填</span></span>
        <input type="text" name="name" maxlength="20" autocomplete="nickname" placeholder="张先生">
      </label>
      <label class="field">
        <span class="label">设置密码 <span class="hint-inline">至少 8 位</span></span>
        <input type="password" name="password" minlength="8" autocomplete="new-password" required>
      </label>
      <button class="btn btn-primary btn-block" type="submit">注册并开始使用</button>
    </form>
    <p class="hint center">
      已经有账号？<a href="/login">直接登录</a>
    </p>`
    : `<form method="post" action="/login" class="stack">
      <label class="field">
        <span class="label">手机号或邮箱 <span class="hint-inline">车主填这里</span></span>
        <input type="text" name="contact" autocomplete="username" autofocus
          placeholder="13800138000 或 you@example.com">
      </label>
      <label class="field">
        <span class="label">密码</span>
        <input type="password" name="password" autocomplete="current-password" required>
      </label>
      <button class="btn btn-primary btn-block" type="submit">登录</button>
    </form>
    <p class="hint center">
      还没有账号？<a href="/signup">注册一个</a>
    </p>
    ${
      platformReady
        ? `<p class="hint center">平台管理员：账号留空，直接填后台密码即可。</p>`
        : `<p class="hint center">平台后台还没配置 <code>ADMIN_PASSWORD</code>。</p>`
    }`;

  return layout({
    title: isSignup ? '注册 · 挪车码' : '登录 · 挪车码',
    body: `<main class="wrap wrap-narrow">
  <section class="card">
    <div class="brand">
      <span class="brand-mark" aria-hidden="true">${BRAND_MARK}</span>
      挪车码
    </div>
    ${tidePattern('tide-hero')}
    <h1 class="card-title">${isSignup ? '注册 · 挪车码' : '登录 · 挪车码'}</h1>
    <p class="muted">
      ${
        isSignup
          ? '每个车主一个账号，只管理自己的车。'
          : '车主用账号登录；平台管理员留空账号、填后台密码。'
      }
    </p>
    ${hint ? banner(hint, 'info') : ''}
    ${error ? banner(error) : ''}
    ${form}
  </section>
</main>`,
  });
}

/**
 * 车牌输入：省份和发牌机关字母是固定集合，做成选择；后面的号码单独一格。
 * 三段凑齐就自动拼成「浙G·5RT71」；凑不齐（使/领/警 这类特殊车牌）
 * 就退化到「特殊车牌」里的原样文字。
 */
function plateField(car) {
  const v = car || {};
  const parsed = core.parsePlate(v.plate);
  const province = parsed.province || '';
  const city = parsed.city || '';
  const rest = parsed.rest || '';
  const special = parsed.special || '';

  const provinceOptions = ['<option value="">省份</option>']
    .concat(
      core.PLATE_PROVINCES.map(
        (p) => `<option value="${esc(p)}"${p === province ? ' selected' : ''}>${esc(p)}</option>`
      )
    )
    .join('');

  const cityOptions = ['<option value="">字母</option>']
    .concat(
      core.PLATE_LETTERS.map(
        (l) => `<option value="${esc(l)}"${l === city ? ' selected' : ''}>${esc(l)}</option>`
      )
    )
    .join('');

  const preview = province && city && rest ? `${province}${city}·${rest}` : '';

  return `<div class="field">
  <span class="label">车牌号</span>
  <div class="plate-input">
    <select name="plate_province" aria-label="车牌省份简称" data-plate-province>${provinceOptions}</select>
    <select name="plate_city" aria-label="车牌城市字母" data-plate-city>${cityOptions}</select>
    <input type="text" name="plate_rest" maxlength="6" value="${esc(rest)}"
           placeholder="号码，如 5RT71" aria-label="车牌号码"
           autocomplete="off" autocapitalize="characters" spellcheck="false" data-plate-rest>
  </div>
  <p class="plate-preview${preview ? ' on' : ''}" data-plate-preview${preview ? ' translate="no"' : ''}>${esc(preview || '选省份和字母，再填后面的号码')}</p>
  <details class="plate-special"${special ? ' open' : ''}>
    <summary>特殊车牌 / 直接粘贴完整车牌</summary>
    <input type="text" name="plate" maxlength="20" value="${esc(special)}"
           placeholder="使123456、浙G·5RT71…" aria-label="完整车牌" data-plate-raw>
    <p class="hint">上面三段填全就用上面三段；上面没填全、这里填了，就按这里的原样文字用。</p>
  </details>
</div>`;
}

/**
 * 车辆表单。
 * remote=true 时表单带 data-remote：有 JS 就 fetch 局部替换，
 * 没 JS（或 fetch 失败）就照常整页提交 —— 两条路服务端都支持。
 */
function carForm(car, action, submitText, { remote = false, carId = '' } = {}) {
  const v = car || {};
  const attrs = remote ? ` data-remote${carId ? ` data-car-id="${esc(carId)}"` : ''}` : '';
  return `<form method="post" action="${esc(action)}" class="stack" autocomplete="off"${attrs}>
  ${plateField(car)}
  <div class="grid-2">
    <label class="field">
      <span class="label">车主称呼 <span class="hint-inline">选填</span></span>
      <input type="text" name="owner_name" maxlength="20" value="${esc(v.owner_name)}" placeholder="张先生">
    </label>
    <label class="field">
      <span class="label">真实手机号 <span class="hint-inline">选填，仅你自己可见</span></span>
      <input type="text" name="phone" maxlength="20" inputmode="tel" value="${esc(v.phone)}"
             placeholder="13800138000" autocomplete="off" spellcheck="false">
    </label>
  </div>
  <label class="field">
    <span class="label">拨号号码 <span class="hint-inline">扫码人拨打的就是它</span></span>
    <input type="text" name="call_number" maxlength="20" inputmode="tel" value="${esc(v.call_number)}"
           placeholder="17012345678" autocomplete="off" spellcheck="false">
  </label>
  <p class="hint">
    填的是隐私号 / 虚拟号，扫码人就打它、看不到你的真实号；
    没有的话把手机号填在这里也行（真实手机号留空即可）。
    两个号都不填，扫码页就不会有拨号按钮。
  </p>
  <label class="field">
    <span class="label">给扫码人的提示</span>
    <textarea name="note" rows="2" maxlength="200"
      placeholder="临时停靠，马上回来，如有打扰请联系我…">${esc(v.note)}</textarea>
  </label>
  <label class="check">
    <input type="checkbox" name="enabled" value="1" ${v.enabled === 0 ? '' : 'checked'}>
    <span>启用该挪车码（关闭后扫码显示「已停用」）</span>
  </label>
  <button class="btn btn-primary" type="submit">${esc(submitText)}</button>
</form>`;
}

function carCard(car, { baseUrl, qrSvg, ownerLabel }) {
  const scanUrl = `${baseUrl}/c/${car.id}`;
  return `<article class="car">
  <div class="car-head">
    <div>
      <div class="car-plate" translate="no">${esc(car.plate || '未填写车牌')}</div>
      <div class="car-meta">
        编号 <code translate="no">${esc(car.id)}</code>
        <span class="dot">·</span>创建于 ${esc(fmtTime(car.created_at))}
        ${ownerLabel ? `<span class="dot">·</span>${esc(ownerLabel)}` : ''}
      </div>
      <div class="car-perm">
        <b>编号和二维码是永久的</b>：换车牌、换号码都不用重印贴纸。
      </div>
    </div>
    <span class="badge ${car.enabled ? 'badge-on' : 'badge-off'}">${car.enabled ? '启用中' : '已停用'}</span>
  </div>

  <div class="car-body">
    <div class="qr-box">${qrSvg}</div>
    <div class="car-actions">
      <p class="scan-url" translate="no">${esc(scanUrl)}</p>
      <div class="btn-row">
        <a class="btn btn-sm btn-ghost" href="/c/${esc(car.id)}" target="_blank" rel="noreferrer">预览</a>
        <a class="btn btn-sm btn-ghost" href="/cars/${esc(car.id)}/print" target="_blank" rel="noreferrer">打印贴纸</a>
        <a class="btn btn-sm btn-ghost" href="/cars/${esc(car.id)}/qr.svg?download=1">下载 SVG</a>
      </div>
      <p class="hint">
        ${
          car.call_number
            ? `拨号号码：${esc(car.call_number)}`
            : car.phone
              ? `未填拨号号码，扫码页将拨打真实手机号 ${esc(car.phone)}`
              : `<span class="warn-text">${ICON_WARN}两个号码都没填：这张贴纸扫了不会有拨号按钮</span>`
        }
      </p>
    </div>
  </div>

  <div class="car-share">
    <div class="car-share-head">
      <b>这辆车的管理链接</b>
      <button class="btn btn-xs btn-ghost" type="button" data-copy="${esc(car.editUrl)}">复制</button>
    </div>
    <code class="edit-link" translate="no">${esc(car.editUrl)}</code>
    <details class="card-help">
      <summary>这条链接是干什么的？</summary>
      <p class="hint">
        把这条链接发给开这辆车的人，对方就能自己改车牌和号码 ——
        只能改这一辆，看不到你其他车，也拿不到后台密码。
        <b>转发这条链接 = 交出这一辆车的修改权</b>，请只发给你信任的人。
      </p>
    </details>
  </div>

  <details class="car-edit" data-car-id="${esc(car.id)}">
    <summary>编辑资料（换车牌 / 换号码 / 换车都改这里）</summary>
    ${carForm(car, `/cars/${car.id}`, '保存修改', { remote: true, carId: car.id })}
    <form method="post" action="/cars/${esc(car.id)}/delete" class="danger-zone" data-remote
          data-confirm="确定删除车辆 ${esc(car.plate || car.id)}？该车的拨号记录也会一起删除。">
      <button class="btn btn-sm btn-danger" type="submit">删除该车辆</button>
    </form>
  </details>
</article>`;
}

function callRow(record) {
  const unread = !record.read_at;
  // 一行一条：车牌 · 时间 · 状态。
  // 以前每条都重复「有人点了一次拨号」「只记录次数与时间，不记录任何扫码人信息」——
  // 三行字里两行是噪音，20 条记录就是 60 行。这两句话现在只写在卡片标题下面一次。
  //
  // 时间不带年份：记录都是近期活动，年份只是占地方。
  return `<li class="msg ${unread ? 'msg-unread' : ''}">
  <span class="msg-plate">${esc(record.plate || record.car_id)}</span>
  <span class="msg-time">${esc(fmtShortTime(record.created_at))}</span>
  ${unread ? '<span class="badge badge-new">未读</span>' : ''}
  ${
    unread
      ? `<form method="post" action="/messages/${esc(record.id)}/read" data-remote><button class="btn btn-xs btn-ghost" type="submit">标记已读</button></form>`
      : ''
  }
</li>`;
}

/* ------------------------------------------------------------------ */
/* 后台的可替换片段                                                    */
/*                                                                     */
/* 这些片段首屏渲染和 AJAX 局部刷新共用同一份实现 —— 只有一套模板，      */
/* 不会出现「点一下变了样」的漂移。                                     */
/* ------------------------------------------------------------------ */

function carListHtml(cars, { baseUrl, isAdmin }) {
  if (!cars.length) {
    return `<p class="muted">${isAdmin ? '还没有车辆，先在上面添加一辆。' : '还没有车辆，先添加一辆你的车。'}</p>`;
  }
  return cars
    .map((car) =>
      carCard(car, {
        baseUrl,
        qrSvg: car.qrSvg,
        ownerLabel: isAdmin && car.owner_contact ? `车主 ${car.owner_contact}` : '',
      })
    )
    .join('\n');
}

function emptyWarnHtml(emptyCount) {
  if (!emptyCount) return '';
  return `<div class="banner banner-error" role="alert">
      有 ${emptyCount} 辆车是空白的（车牌、号码全没有），扫码打开什么也做不了。
      <form method="post" action="/admin/cleanup-empty" class="banner-form" data-remote
            data-confirm="确定删除这 ${emptyCount} 辆空白车辆吗？">
        <button class="btn btn-xs btn-danger" type="submit">清理这 ${emptyCount} 辆</button>
      </form>
    </div>`;
}

/**
 * 拨号记录列表。
 * 记录只增不减，全铺出来会把整页撑到十几屏，
 * 所以默认只铺最近 10 条，更早的收进一个 <details> —— 禁用 JS 也能展开。
 */
function recordListHtml(messages, { limit = 10 } = {}) {
  if (!messages.length) return '<p class="muted">还没有人拨号。</p>';
  const list = (rows) => `<ul class="msg-list">${rows.map(callRow).join('\n')}</ul>`;
  const older = messages.slice(limit);
  return (
    list(messages.slice(0, limit)) +
    (older.length
      ? `<details class="more-records"><summary>还有 ${older.length} 条更早的记录</summary>${list(older)}</details>`
      : '')
  );
}

function recordActionsHtml(unread) {
  return unread
    ? '<form method="post" action="/messages/read-all" data-remote><button class="btn btn-sm btn-ghost" type="submit">全部标记已读</button></form>'
    : '';
}

function userListHtml(users) {
  if (!users.length) return '<p class="muted">还没有车主注册。</p>';
  return `<ul class="user-list">${users
    .map(
      (u) => `<li class="user-row">
        <span class="user-contact">${esc(u.contact)}</span>
        ${u.name ? `<span class="user-name">${esc(u.name)}</span>` : ''}
        <span class="user-cars">${Number(u.car_count) || 0} 辆车</span>
        <span class="user-time">${esc(fmtTime(u.created_at))}</span>
      </li>`
    )
    .join('\n')}</ul>`;
}

/* --------------------------- 贴纸编号 ---------------------------- */

/**
 * 一条编号。已绑定的显示它绑在哪辆车上，未绑定的给一个「绑定到…」的下拉。
 *
 * 这里刻意把「编号」放在最前面且用等宽字体：贴纸正面不印编号，后台对号时
 * 靠的就是这一串，长得像什么不重要，好抄才重要。
 */
function codeRowHtml(entry, { cars, isAdmin }) {
  const bound = Boolean(entry.car_id);
  const plate = entry.plate || (bound ? entry.car_id : '');

  if (!bound) {
    const options = cars
      .map((car) => `<option value="${esc(car.id)}">${esc(carOptionLabel(car))}</option>`)
      .join('');
    return `<li class="code-row">
    <code class="code-id">${esc(entry.code)}</code>
    <span class="badge badge-off">未绑定</span>
    ${
      cars.length
        ? `<form method="post" action="/codes/${esc(entry.code)}/bind" class="code-bind" data-remote>
        <select name="car_id" aria-label="绑定到哪辆车">${options}</select>
        <button class="btn btn-xs btn-primary" type="submit">绑定</button>
      </form>`
        : '<span class="hint">先添加一辆车</span>'
    }
    <span class="code-ops">
      <a class="btn btn-xs btn-ghost" href="/codes/${esc(entry.code)}/print" target="_blank" rel="noreferrer">打印</a>
      <form method="post" action="/codes/${esc(entry.code)}/delete" data-remote
            data-confirm="删除编号 ${esc(entry.code)}？这张贴纸作废，别人扫开就找不到车了。">
        <button class="btn btn-xs btn-ghost" type="submit">删除</button>
      </form>
    </span>
  </li>`;
  }

  return `<li class="code-row">
    <code class="code-id">${esc(entry.code)}</code>
    <span class="badge ${entry.car_enabled === 0 ? 'badge-off' : 'badge-on'}" translate="no">${esc(plate)}</span>
    ${isAdmin && entry.owner_contact ? `<span class="muted code-owner">${esc(entry.owner_contact)}</span>` : ''}
    <span class="code-ops">
      <a class="btn btn-xs btn-ghost" href="/codes/${esc(entry.code)}/print" target="_blank" rel="noreferrer">打印</a>
      <form method="post" action="/codes/${esc(entry.code)}/unbind" data-remote>
        <button class="btn btn-xs btn-ghost" type="submit">解绑</button>
      </form>
    </span>
  </li>`;
}

function carOptionLabel(car) {
  const plate = car.plate || '未填写车牌';
  return car.enabled ? plate : `${plate}（已停用）`;
}

/** 分组：未绑定的铺在前面（那是要干活的部分），已绑定的收起来 */
function codeListHtml(codes, { cars = [], isAdmin = false, limit = 8 } = {}) {
  if (!codes.length) {
    return '<p class="muted">还没有贴纸编号。点右上角「生成空白贴纸」一次生成一批，谁拿到谁绑定。</p>';
  }

  const unbound = codes.filter((entry) => !entry.car_id);
  const bound = codes.filter((entry) => entry.car_id);

  const group = (title, rows, open) => {
    if (!rows.length) return '';
    const head = rows.slice(0, limit);
    const rest = rows.slice(limit);
    const list = (part) => `<ul class="code-list">${part.map((e) => codeRowHtml(e, { cars, isAdmin })).join('\n')}</ul>`;
    return `<details class="code-group"${open ? ' open' : ''}>
    <summary>${title}（${rows.length}）</summary>
    ${list(head)}
    ${rest.length ? `<details class="more-records"><summary>还有 ${rest.length} 个</summary>${list(rest)}</details>` : ''}
  </details>`;
  };

  return (
    group('待绑定', unbound, true) +
    group('已绑定', bound, false) +
    (unbound.length
      ? ''
      : '<p class="hint">没有待绑定的编号了。要发新贴纸就再生一批。</p>')
  );
}

/**
 * 别人扫到一张「还没绑定」的贴纸时看到的页面。
 *
 * 这页只有一个任务：让车主把它绑到自己的车上（或告诉他先登录 / 先加车）。
 * 对扫码的路人来说这是个死胡同，所以话说清楚：这车还没启用挪车码。
 */
function bindCodePage({ code, cars = [], loggedIn = false, home = '/' }) {
  const carOptions = cars
    .map((car) => `<option value="${esc(car.id)}">${esc(carOptionLabel(car))}</option>`)
    .join('');

  const action = !loggedIn
    ? `<a class="btn btn-primary btn-block" href="/login">我是车主，登录后绑定</a>
       <p class="hint center">绑定只需要一次：登录 → 选中你的车 → 贴到挡风玻璃上。</p>`
    : cars.length
      ? `<form method="post" action="/c/${esc(code)}/bind" class="stack">
        <label class="field">
          <span>绑定到我的车</span>
          <select name="car_id" required>${carOptions}</select>
        </label>
        <button class="btn btn-primary btn-block" type="submit">绑定这张贴纸</button>
      </form>
      <p class="hint center">绑定之后，别人扫这张贴纸就能直接联系到你了。</p>`
      : `<a class="btn btn-primary btn-block" href="${esc(home)}">去后台添加一辆车</a>
       <p class="hint center">你还没有车辆记录，先添加一辆车，再回来绑定这张贴纸。</p>`;

  return layout({
    title: '贴纸待绑定',
    body: `<main class="wrap wrap-scan">
  ${tidePattern('tide-hero')}
  <div class="hero">
    <div class="hero-label">贴纸编号</div>
    <div class="hero-plate plate-chip hero-code" translate="no">${esc(code)}</div>
    <h1 class="hero-title">这张贴纸还没绑定车辆</h1>
  </div>

  <section class="card card-note">
    <p class="note-text">如果你是车主：把这张贴纸绑到自己的车上，别人扫它就能找到你。<br>
      如果你只是路过：说明车主还没有启用这张贴纸的联系方式。</p>
  </section>

  <section class="card action-card">
    ${action}
  </section>
</main>`,
  });
}

function adminPage({
  mode = 'admin',
  account = null,
  cars,
  messages,
  codes = [],
  users = [],
  baseUrl,
  universal,
  unread,
  notice,
  emptyCount = 0,
  cleanedCount = 0,
}) {
  const isAdmin = mode === 'admin';

  const userSection = !isAdmin
    ? ''
    : `<section class="card card-users">
    <div class="card-head">
      <h2 class="card-title" id="user-count">${userCountHtml(users.length)}</h2>
    </div>
    <p class="hint">每个车主一个账号，只能看到和管理自己的车。</p>
    <div id="user-area">${userListHtml(users)}</div>
  </section>`;

  // 通用码只对平台方有意义：它只认平台自己录的车（owner_id 为空）
  const universalHint = !universal
    ? ''
    : universal.enabledCount === 0
      ? '你现在没有启用中的自有车辆，这个码扫开会提示「暂时无法联系车主」。'
      : universal.enabledCount === 1
        ? `现在只启用了 1 辆（${esc(universal.plates[0])}），扫码会直接进那一辆。`
        : `你现在启用了 ${universal.enabledCount} 辆自有车（${universal.plates.map(esc).join('、')}），扫码页会先列出这些车牌让扫码人点。`;

  const universalSection = !universal
    ? ''
    : `<section class="card card-universal">
    <div class="card-head">
      <h2 class="card-title">通用二维码（平台自有车用）</h2>
      <span class="badge badge-call">一张贴纸贴所有车</span>
    </div>
    <div class="car-body">
      <div class="qr-box">${universal.qrSvg}</div>
      <div class="car-actions">
        <p class="scan-url" translate="no">${esc(universal.url)}</p>
        <div class="btn-row">
          <a class="btn btn-sm btn-ghost" href="/admin/print-universal" target="_blank" rel="noreferrer">打印通用贴纸</a>
          <a class="btn btn-sm btn-ghost" href="/admin/universal.svg?download=1">下载 SVG</a>
          <a class="btn btn-sm btn-ghost" href="/" target="_blank" rel="noreferrer">预览</a>
        </div>
        <p class="hint">${universalHint}</p>
        <details class="card-help">
          <summary>这个码认哪些车？</summary>
          <p class="hint">
            它只认 <b>owner_id 为空</b>的自有车，不会影响车主的车。车主想让扫码直接对上车辆，用自己的专属码。
          </p>
        </details>
      </div>
    </div>
  </section>`;

  return layout({
    title: isAdmin ? '平台后台' : '我的车辆',
    bodyClass: 'admin',
    body: `<a class="skip-link" href="#main">跳到主要内容</a>
<header class="topbar">
  <div class="brand">
    <span class="brand-mark" aria-hidden="true">${BRAND_MARK}</span>
    挪车码 · ${isAdmin ? '平台后台' : '我的车辆'}
  </div>
  <div class="topbar-right">
    <span class="badge ${unread ? 'badge-new' : 'badge-on'}" id="unread-badge">未读 ${unread}</span>
    <form method="post" action="/logout"><button class="btn btn-sm btn-ghost" type="submit">退出</button></form>
  </div>
</header>

<main class="wrap" id="main">
  <h1 class="sr-only">${isAdmin ? '平台后台' : '我的车辆'}</h1>
  <div id="notice-area">${notice ? banner(notice.text, notice.kind) : ''}</div>
  ${
    isAdmin
      ? `<section class="card">
    <h2 class="card-title">平台控制台</h2>
    <p class="hint">你是平台管理员：这里「新增车辆」建出来的是<b>平台自有车</b>（owner_id 为空），
      车主账号里看不到，通用码也只认这些车。车主各自注册账号后，在「我的车辆」里自己建车、自己打印贴纸。</p>
  </section>`
      : `<section class="card card-account">
    <h2 class="card-title">我的账号</h2>
    <p class="muted">${esc((account && account.contact) || '')}${account && account.name ? ` · ${esc(account.name)}` : ''}</p>
    <p class="hint">你只能看到和管理自己的车。</p>
  </section>`
  }

  <section class="card card-newcar">
    <h2 class="card-title">新增车辆</h2>
    ${carForm(null, '/cars', '生成挪车码', { remote: true })}
    <p class="hint">至少要填「车牌」或一个号码 —— 什么都不填的记录建了也没用，会被拦下来。</p>
  </section>

  <section class="card card-cars">
    <div class="card-head">
      <h2 class="card-title" id="car-count">${carCountHtml(cars.length)}</h2>
      <div id="car-actions">
        ${cars.length ? `<a class="btn btn-sm btn-primary" href="/print-all" target="_blank" rel="noreferrer">批量打印全部贴纸</a>` : ''}
      </div>
    </div>
    <p class="hint"><b>一车一码</b>：每辆车有自己的码，扫码直接进那一辆，扫码人不用选。</p>
    <details class="card-help">
      <summary>贴纸怎么用？</summary>
      <p class="hint">
        批量打印会把所有车的贴纸排在一页里一次打完。改车牌、改号码都不用重新打印；
        贴纸外观完全通用，撕下来可以贴到别的车上，贴之前对照框外的车牌别贴错车。
      </p>
    </details>
    <div id="empty-warn">${emptyWarnHtml(isAdmin ? emptyCount : 0)}</div>
    ${cleanedCount ? `<p class="hint">刚才清理掉了 ${cleanedCount} 辆空白车辆。</p>` : ''}
    <div class="car-list" id="car-list">${carListHtml(cars, { baseUrl, isAdmin })}</div>
  </section>

  ${universalSection}

  <section class="card card-codes">
    <div class="card-head">
      <h2 class="card-title" id="code-count">${codeCountHtml(codes.length)}</h2>
      <div id="code-actions">
        <form method="post" action="/codes" class="code-generate" data-remote>
          <input type="number" name="count" value="1" min="1" max="50" inputmode="numeric"
                 aria-label="生成几个空白编号">
          <button class="btn btn-sm btn-primary" type="submit">生成空白贴纸</button>
        </form>
      </div>
    </div>
    <p class="hint">
      贴纸印的是<b>编号</b>，不是车牌 —— 可以先印一批空白贴纸，谁拿到谁绑定。
      换车、绑错了、补印，都只改绑定关系，贴纸不用重印。
    </p>
    <details class="card-help">
      <summary>一批空白贴纸怎么发下去？</summary>
      <p class="hint">
        ① 这里生成 N 个编号 → ② 逐个「打印」出贴纸（贴纸上只有编号，没有车牌）→
        ③ 车主拿到贴纸后用手机扫一下，选中自己的车就绑定好了；绑错了在下面「已绑定」里解绑重绑。
        同一辆车也可以绑多张贴纸（比如前后各一张）。
      </p>
    </details>
    <div id="code-area">${codeListHtml(codes, { cars, isAdmin })}</div>
  </section>

  <section class="card card-records">
    <div class="card-head">
      <h2 class="card-title">${cardIcon(ICON_BELL)}拨号记录</h2>
      <div id="record-actions">${recordActionsHtml(unread)}</div>
    </div>
    <p class="hint">这里只记「有人点了一次拨号按钮」，不记录扫码人的 IP、设备信息，也不记录通话内容与号码。</p>
    <div id="record-area">${recordListHtml(messages)}</div>
  </section>

  ${userSection}
</main>`,
  });
}

/* ------------------------------------------------------------------ */
/* 打印贴纸                                                            */
/* ------------------------------------------------------------------ */

/**
 * 贴纸。三种尺寸：
 *   square  = 50mm × 50mm 正方形（小巧，贴后视镜/角落）
 *   square6 = 60mm × 60mm 正方形（二维码最大，字也看得清）
 *   rect    = 100mm × 50mm 长方形（二维码在左、文字在右，贴挡风玻璃正合适）
 *
 * 刻意**不印车牌、也不印编号**：
 *   - 车牌和号码都是扫码那一刻从数据库现查的，印上去只会变成过期信息
 *   - 编号是内部标识，贴在玻璃上对扫码人没有意义
 * 所以贴纸只保留「让人扫码」这件事本身，外观完全通用，
 * 换车、换牌、换号码都不用重印。
 *
 * 文案三行：标题「扫码挪车」/ 副标题「临时停靠 · 请多包涵」/ 提示「车辆挡路请扫码联系车主」。
 * 副标题要多占一行高度，二维码就得让出相应的高度 —— 每款让多少是按实测定的，
 * 让到「文字刚好放得下、二维码取最大」，见 public/style.css 里各尺寸的注释。
 */
const STICKER_SIZES = {
  square: '5×5cm 正方形',
  square6: '6×6cm 正方形',
  rect: '10×5cm 长方形',
};

function stickerSizeOf(value) {
  return STICKER_SIZES[value] ? value : 'square';
}

function sticker(car, { qrSvg, size = 'square' }) {
  const key = stickerSizeOf(size);
  const head = `<div class="sticker-title">扫码挪车</div>
    <div class="sticker-sub">临时停靠 · 请多包涵</div>`;

  if (key === 'rect') {
    return `<div class="sticker sticker-rect">
    <div class="sticker-qr">${qrSvg}</div>
    <div class="sticker-text">
      ${head}
      <div class="sticker-tip">车辆挡路请扫码<br>一键拨号联系车主</div>
    </div>
  </div>`;
  }

  return `<div class="sticker sticker-${key}">
    ${head}
    <div class="sticker-qr">${qrSvg}</div>
    <div class="sticker-tip">车辆挡路请扫码联系车主</div>
  </div>`;
}

/** 打印页上的尺寸切换（当前那个高亮） */
function sizeSwitch(path, size) {
  const link = (key, label) =>
    `<a class="btn btn-xs ${size === key ? 'btn-primary' : 'btn-ghost'}" href="${esc(path)}?size=${key}">${label}</a>`;
  return `<span class="size-switch">尺寸：${link('square', '5×5 方形')}${link('square6', '6×6 方形')}${link('rect', '10×5 长方形')}</span>`;
}

function printPage(
  car,
  { baseUrl, qrSvg, universal = false, size = 'square', path = '', code = '', blank = false }
) {
  const label = STICKER_SIZES[stickerSizeOf(size)];
  // 一张贴纸印的是它自己的编号；没给就按车辆编号（老贴纸的行为）
  const printedCode = code || car.id;
  return layout({
    title: universal ? `挪车贴纸 · 通用 · ${label}` : `挪车贴纸 · ${label}`,
    bodyClass: 'print-body',
    body: `<div class="print-toolbar">
  <a class="btn btn-sm btn-ghost" href="/admin">返回后台</a>
  <button class="btn btn-sm btn-primary" type="button" data-print>打印 / 另存为 PDF</button>
  ${path ? sizeSwitch(path, size) : ''}
  <span class="hint">白色区域就是 A4 纸的版面，贴纸按真实尺寸（${label}）排。</span>
</div>

<div class="print-notes">
  <p class="print-note print-note-mobile">
    手机上纸张按比例缩小显示，只为一眼看完整版式；打印出来的尺寸不受影响。
  </p>
  <p class="print-note">
    <b>打印时把「缩放」设成 100%（或「实际大小」）</b>，边距用默认即可 —— 否则贴纸尺寸会跟着变，
    二维码可能小到扫不动。打印完沿贴纸的黑色边框裁剪。
  </p>
  <p class="print-note">
    ${
      blank
        ? `这是<b>空白贴纸</b>：编号 <b>${esc(printedCode)}</b>，还没绑定到车辆。<br>
           贴到车上之前，请车主用手机扫一下这张贴纸，选中自己的车完成绑定；<br>
           绑定之前别人扫开只会看到「这张贴纸还没绑定车辆」。<br>
           二维码内容：${esc(baseUrl)}/c/${esc(printedCode)}`
        : universal
          ? '这是通用贴纸：一张可以贴在任意一辆车上。扫码后如果车主启用了多辆车，扫码人需要先点一下车牌。'
          : `贴纸外观是通用的（不印车牌、不印编号），但每张的码都指向后台里的一条记录。<br>
           改车牌、改号码、换到别的车上，都只改那条记录，贴纸不用重印。<br>
           二维码内容：${esc(baseUrl)}/c/${esc(printedCode)}`
    }
  </p>
</div>

<div class="paper paper-single">
  ${sticker(car, { qrSvg, size })}
</div>`,
  });
}

/** 一张 A4 每行能放几张：和 CSS 里贴纸网格的宽度、间距保持同一套算法 */
const STICKER_MM = { square: 50, square6: 60, rect: 100 };
const SHEET_MM = 198; // A4 210mm 减去左右各 6mm 页边距
const SHEET_GAP_MM = 5;

function stickersPerRow(size) {
  const key = stickerSizeOf(size);
  const per = Math.floor((SHEET_MM + SHEET_GAP_MM) / (STICKER_MM[key] + SHEET_GAP_MM));
  return Math.max(1, per);
}

/** 批量打印：车辆各出一张贴纸，或把一批空白编号一次打完，排在一页里 */
function printAllPage({ cars, baseUrl, size = 'square', path = '/print-all', blank = false }) {
  const label = STICKER_SIZES[stickerSizeOf(size)];
  const sheet = cars.length
    ? cars
        .map(
          (car) => `<div class="sticker-cell">
        ${sticker(car, { qrSvg: car.qrSvg, size })}
        <div class="sticker-url">${esc(car.plate || '未填写车牌')}</div>
      </div>`
        )
        .join('\n')
    : `<p class="muted">${blank ? '没有待绑定的空白贴纸。' : '没有启用中的车辆。'}</p>`;

  return layout({
    title: blank ? `批量打印空白贴纸 · ${label}` : `批量打印挪车贴纸 · ${label}`,
    bodyClass: 'print-body',
    body: `<div class="print-toolbar">
  <a class="btn btn-sm btn-ghost" href="/admin">返回后台</a>
  <button class="btn btn-sm btn-primary" type="button" data-print>打印 / 另存为 PDF</button>
  ${sizeSwitch(path, size)}
  <span class="hint">
    白色区域就是 A4 纸的版面：${label} 每行 ${stickersPerRow(size)} 张，共 ${cars.length} 张，
    屏幕上怎么排，纸上就怎么排。
  </span>
</div>

<div class="print-notes">
  <p class="print-note print-note-mobile">
    手机上纸张按比例缩小显示，只为一眼看完整版式；打印出来的尺寸不受影响。
  </p>
  <p class="print-note">
    <b>打印时把「缩放」设成 100%（或「实际大小」）</b>，边距用默认即可 —— 否则贴纸尺寸会跟着变，
    二维码可能小到扫不动。打印完沿每张贴纸的黑色边框裁剪；框外那行小字是给你对号用的，剪掉。
  </p>
</div>

<div class="paper">
  <div class="sticker-sheet">${sheet}</div>
</div>`,
  });
}

module.exports = {
  scanPage,
  pickCarPage,
  carEditPage,
  messagePage,
  loginPage,
  adminPage,
  bannerHtml,
  carCountHtml,
  codeCountHtml,
  userCountHtml,
  carListHtml,
  emptyWarnHtml,
  recordListHtml,
  recordActionsHtml,
  userListHtml,
  codeListHtml,
  bindCodePage,
  printPage,
  printAllPage,
  stickerSizeOf,
  STICKER_SIZES,
};
