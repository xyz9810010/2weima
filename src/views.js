'use strict';

const core = require('./core');
const { esc, fmtTime } = core;

/* 图标一律内联 SVG：字体符号（☎）在不同系统里长得不一样，也没法跟随文字颜色和粗细 */
const ICON_PHONE = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.2 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/></svg>`;

const ICON_WARN = `<svg class="warn-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;

function layout({ title, body, bodyClass = '' }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="format-detection" content="telephone=no">
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
  <div class="hero">
    <div class="hero-label">挡路的车辆</div>
    <div class="hero-plate">${esc(plate)}</div>
    <div class="hero-title">这是一辆临时停放的车辆</div>
  </div>

  <section class="card card-note">
    <p class="note-text">${esc(note)}</p>
  </section>

  <section class="card action-card">
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
      <span class="pick-plate">${esc(car.plate)}</span>
      ${car.owner_name ? `<span class="pick-owner">${esc(car.owner_name)} 的车</span>` : ''}
      ${car.hasNumber ? '' : '<span class="pick-warn">暂未留电话</span>'}
    </a>`
    )
    .join('\n');

  return layout({
    title: '请选择挡路的车辆',
    body: `<main class="wrap wrap-scan">
  <div class="hero">
    <div class="hero-title">请选择挡路的车辆</div>
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
      这个页面只能修改 <b>${esc(plate)}</b> 这一辆车（编号 <code>${esc(car.id)}</code>）。
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
    <h1 class="card-title">挪车码${isSignup ? ' · 注册' : ''}</h1>
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
  <p class="plate-preview${preview ? ' on' : ''}" data-plate-preview>${esc(preview || '选省份和字母，再填后面的号码')}</p>
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
  return `<form method="post" action="${esc(action)}" class="stack"${attrs}>
  ${plateField(car)}
  <div class="grid-2">
    <label class="field">
      <span class="label">车主称呼 <span class="hint-inline">选填</span></span>
      <input type="text" name="owner_name" maxlength="20" value="${esc(v.owner_name)}" placeholder="张先生">
    </label>
    <label class="field">
      <span class="label">真实手机号 <span class="hint-inline">选填，仅你自己可见</span></span>
      <input type="text" name="phone" maxlength="20" inputmode="tel" value="${esc(v.phone)}" placeholder="13800138000">
    </label>
  </div>
  <label class="field">
    <span class="label">拨号号码 <span class="hint-inline">扫码人拨打的就是它</span></span>
    <input type="text" name="call_number" maxlength="20" inputmode="tel" value="${esc(v.call_number)}" placeholder="17012345678">
  </label>
  <p class="hint">
    填的是隐私号 / 虚拟号，扫码人就打它、看不到你的真实号；
    没有的话把手机号填在这里也行（真实手机号留空即可）。
    两个号都不填，扫码页就不会有拨号按钮。
  </p>
  <label class="field">
    <span class="label">给扫码人的提示</span>
    <textarea name="note" rows="2" maxlength="200"
      placeholder="临时停靠，马上回来，如有打扰请联系我，谢谢！">${esc(v.note)}</textarea>
  </label>
  <label class="check">
    <input type="checkbox" name="enabled" value="1" ${v.enabled === 0 ? '' : 'checked'}>
    <span>启用该挪车码（关闭后扫码显示"已停用"）</span>
  </label>
  <button class="btn btn-primary" type="submit">${esc(submitText)}</button>
</form>`;
}

function carCard(car, { baseUrl, qrSvg, ownerLabel }) {
  const scanUrl = `${baseUrl}/c/${car.id}`;
  return `<article class="car">
  <div class="car-head">
    <div>
      <div class="car-plate">${esc(car.plate || '未填写车牌')}</div>
      <div class="car-meta">
        编号 <code>${esc(car.id)}</code>
        <span class="dot">·</span>创建于 ${esc(fmtTime(car.created_at))}
        ${ownerLabel ? `<span class="dot">·</span>${esc(ownerLabel)}` : ''}
      </div>
      <div class="car-perm">
        <b>编号和二维码是永久的</b>：换车牌、换号码、换到另一辆车上，
        都只改下面这条记录，贴纸不用重印。
      </div>
    </div>
    <span class="badge ${car.enabled ? 'badge-on' : 'badge-off'}">${car.enabled ? '启用中' : '已停用'}</span>
  </div>

  <div class="car-body">
    <div class="qr-box">${qrSvg}</div>
    <div class="car-actions">
      <p class="scan-url">${esc(scanUrl)}</p>
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
    <code class="edit-link">${esc(car.editUrl)}</code>
    <p class="hint">
      把这条链接发给开这辆车的人，对方就能自己改车牌和号码 ——
      只能改这一辆，看不到你其他车，也拿不到后台密码。
      <b>转发这条链接 = 交出这一辆车的修改权</b>，请只发给你信任的人。
    </p>
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
  return `<li class="msg ${unread ? 'msg-unread' : ''}">
  <div class="msg-head">
    <span class="badge badge-call">拨号</span>
    <span class="msg-plate">${esc(record.plate || record.car_id)}</span>
    <span class="msg-time">${esc(fmtTime(record.created_at))}</span>
    ${unread ? '<span class="badge badge-new">未读</span>' : ''}
  </div>
  <div class="msg-content">有人点了一次「一键拨号」</div>
  <div class="msg-foot">
    <span class="muted">只记录次数与时间，不记录任何扫码人信息</span>
    ${unread ? `<form method="post" action="/messages/${esc(record.id)}/read" data-remote><button class="btn btn-xs btn-ghost" type="submit">标记已读</button></form>` : ''}
  </div>
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
  return `<div class="banner banner-error">
      有 ${emptyCount} 辆车是空白的（车牌、号码全没有），扫码打开什么也做不了。
      <form method="post" action="/admin/cleanup-empty" style="display:inline" data-remote
            data-confirm="确定删除这 ${emptyCount} 辆空白车辆吗？">
        <button class="btn btn-xs btn-danger" type="submit">清理这 ${emptyCount} 辆</button>
      </form>
    </div>`;
}

function recordListHtml(messages) {
  return messages.length
    ? `<ul class="msg-list">${messages.map(callRow).join('\n')}</ul>`
    : '<p class="muted">还没有人拨号。</p>';
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

function adminPage({
  mode = 'admin',
  account = null,
  cars,
  messages,
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
      <h2 class="card-title" id="user-count">车主账号（${users.length}）</h2>
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
        <p class="scan-url">${esc(universal.url)}</p>
        <div class="btn-row">
          <a class="btn btn-sm btn-ghost" href="/admin/print-universal" target="_blank" rel="noreferrer">打印通用贴纸</a>
          <a class="btn btn-sm btn-ghost" href="/admin/universal.svg?download=1">下载 SVG</a>
          <a class="btn btn-sm btn-ghost" href="/" target="_blank" rel="noreferrer">预览</a>
        </div>
        <p class="hint">${universalHint}</p>
        <p class="hint">
          它只认 <b>owner_id 为空</b>的自有车，不会影响车主的车。车主想让扫码直接对上车辆，用自己的专属码。
        </p>
      </div>
    </div>
  </section>`;

  return layout({
    title: isAdmin ? '平台后台' : '我的车辆',
    bodyClass: 'admin',
    body: `<header class="topbar">
  <div class="brand">挪车码 · ${isAdmin ? '平台后台' : '我的车辆'}</div>
  <div class="topbar-right">
    <span class="badge ${unread ? 'badge-new' : 'badge-on'}" id="unread-badge">未读 ${unread}</span>
    <form method="post" action="/logout"><button class="btn btn-sm btn-ghost" type="submit">退出</button></form>
  </div>
</header>

<main class="wrap">
  <div id="notice-area">${notice ? banner(notice.text, notice.kind) : ''}</div>
  ${
    isAdmin
      ? `<section class="card">
    <h2 class="card-title">平台控制台</h2>
    <p class="muted">你是平台管理员：这里的「新增车辆」建出来的是<b>平台自有车</b>（owner_id 为空），
      在车主账号里看不到；通用码也只认这些车。</p>
    <p class="hint">车主各自注册账号后，在「我的车辆」里自己建车、自己打印贴纸。</p>
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
      <h2 class="card-title" id="car-count">车辆与贴纸（${cars.length}）</h2>
      <div id="car-actions">
        ${cars.length ? `<a class="btn btn-sm btn-primary" href="/print-all" target="_blank" rel="noreferrer">批量打印全部贴纸</a>` : ''}
      </div>
    </div>
    <p class="hint">
      <b>一车一码</b>：每辆车有自己的码，扫码直接进那一辆，扫码人不用选。
      批量打印会把所有车的贴纸排在一页里一次打完。
      改车牌、改号码都不用重新打印。
    </p>
    <div id="empty-warn">${emptyWarnHtml(isAdmin ? emptyCount : 0)}</div>
    ${cleanedCount ? `<p class="hint">刚才清理掉了 ${cleanedCount} 辆空白车辆。</p>` : ''}
    <div class="car-list" id="car-list">${carListHtml(cars, { baseUrl, isAdmin })}</div>
  </section>

  ${universalSection}

  <section class="card card-records">
    <div class="card-head">
      <h2 class="card-title">拨号记录</h2>
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
 * 贴纸。两种尺寸：
 *   square = 50mm × 50mm 正方形（小巧，贴后视镜/角落）
 *   rect   = 100mm × 50mm 长方形（二维码在左、文字在右，贴挡风玻璃正合适）
 *
 * 刻意**不印车牌、也不印编号**：
 *   - 车牌和号码都是扫码那一刻从数据库现查的，印上去只会变成过期信息
 *   - 编号是内部标识，贴在玻璃上对扫码人没有意义
 * 所以贴纸只保留「让人扫码」这件事本身，外观完全通用，
 * 换车、换牌、换号码都不用重印。
 */
function sticker(car, { qrSvg, size = 'square' }) {
  const head = `<div class="sticker-title">扫码挪车</div>
    <div class="sticker-sub">临时停靠 · 请多包涵</div>`;

  if (size === 'rect') {
    return `<div class="sticker sticker-rect">
    <div class="sticker-qr">${qrSvg}</div>
    <div class="sticker-text">
      ${head}
      <div class="sticker-tip">车辆挡路请扫码<br>一键拨号联系车主</div>
    </div>
  </div>`;
  }

  return `<div class="sticker sticker-square">
    ${head}
    <div class="sticker-qr">${qrSvg}</div>
    <div class="sticker-tip">车辆挡路请扫码联系车主</div>
  </div>`;
}

/** 打印页上的尺寸切换（两个链接，当前那个高亮） */
function sizeSwitch(path, size) {
  const link = (key, label) =>
    `<a class="btn btn-xs ${size === key ? 'btn-primary' : 'btn-ghost'}" href="${esc(path)}?size=${key}">${label}</a>`;
  return `<span class="size-switch">尺寸：${link('square', '5×5 方形')}${link('rect', '10×5 长方形')}</span>`;
}

function printPage(car, { baseUrl, qrSvg, universal = false, size = 'square', path = '' }) {
  const label = size === 'rect' ? '10×5cm 长方形' : '5×5cm 正方形';
  return layout({
    title: universal ? `挪车贴纸 · 通用 · ${label}` : `挪车贴纸 · ${label}`,
    bodyClass: 'print-body',
    body: `<div class="print-toolbar">
  <a class="btn btn-sm btn-ghost" href="/admin">返回后台</a>
  <button class="btn btn-sm btn-primary" type="button" data-print>打印 / 另存为 PDF</button>
  ${path ? sizeSwitch(path, size) : ''}
  <span class="hint">${label}。建议用不干胶纸打印，贴在挡风玻璃内侧。</span>
</div>

${sticker(car, { qrSvg, size })}

<p class="print-note">
  ${
    universal
      ? '这是通用贴纸：一张可以贴在任意一辆车上。扫码后如果车主启用了多辆车，扫码人需要先点一下车牌。'
      : `贴纸外观是通用的（不印车牌、不印编号），但每张的码都指向后台里的一条记录。<br>
         改车牌、改号码、换到别的车上，都只改那条记录，贴纸不用重印。<br>
         二维码内容：${esc(baseUrl)}/c/${esc(car.id)}`
  }
</p>`,
  });
}

/** 批量打印：把启用中的每辆车各出一张贴纸，排在一页里一次打完 */
function printAllPage({ cars, baseUrl, size = 'square', path = '/print-all' }) {
  const label = size === 'rect' ? '10×5cm 长方形' : '5×5cm 正方形';
  const sheet = cars.length
    ? cars
        .map(
          (car) => `<div class="sticker-cell">
        ${sticker(car, { qrSvg: car.qrSvg, size })}
        <div class="sticker-url">${esc(car.plate || '未填写车牌')}</div>
      </div>`
        )
        .join('\n')
    : '<p class="muted">没有启用中的车辆。</p>';

  return layout({
    title: `批量打印挪车贴纸 · ${label}`,
    bodyClass: 'print-body',
    body: `<div class="print-toolbar">
  <a class="btn btn-sm btn-ghost" href="/admin">返回后台</a>
  <button class="btn btn-sm btn-primary" type="button" data-print>打印 / 另存为 PDF</button>
  ${sizeSwitch(path, size)}
  <span class="hint">
    ${label}，每辆车一张，共 ${cars.length} 张。框外那行车牌只是给你对号用，裁剪时剪掉。
    贴纸本身外观完全一样，贴之前请对照这行车牌，别贴错车。
  </span>
</div>

<div class="sticker-sheet">${sheet}</div>`,
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
  carListHtml,
  emptyWarnHtml,
  recordListHtml,
  recordActionsHtml,
  userListHtml,
  printPage,
  printAllPage,
};
