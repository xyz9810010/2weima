'use strict';

const { esc, fmtTime } = require('./core');

const REASONS = [
  '挡住了我的车，需要挪一下',
  '车灯没关 / 车窗没关',
  '发生剐蹭或事故',
  '车辆异常（漏油、冒烟、报警器响等）',
  '其他情况',
];

function layout({ title, body, bodyClass = '' }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="format-detection" content="telephone=no">
<title>${esc(title)}</title>
<link rel="stylesheet" href="/style.css">
<script src="/app.js" defer></script>
</head>
<body${bodyClass ? ` class="${esc(bodyClass)}"` : ''}>
${body}
</body>
</html>`;
}

function banner(text, kind = 'error') {
  return `<div class="banner banner-${esc(kind)}">${esc(text)}</div>`;
}

/* ------------------------------------------------------------------ */
/* 扫码方页面                                                          */
/* ------------------------------------------------------------------ */

function scanPage(car, { error, callNumber }) {
  const plate = car.plate || '未填写车牌';
  const note = car.note || '您好，如果我的车挡住了您，请通过下面的方式联系我，谢谢！';

  const callBlock = callNumber
    ? `<a class="btn btn-call btn-block" href="tel:${esc(callNumber)}"
          data-call-log="/c/${esc(car.id)}/call">
         <span class="btn-icon">&#9742;</span> 一键拨号（隐私号）
       </a>
       <p class="hint center">该号码由车主开通的隐私号服务转接，双方均不显示真实手机号。</p>`
    : `<div class="notice">车主暂未开通一键拨号，请使用下方留言，车主会尽快查看。</div>`;

  return layout({
    title: `挪车提醒 · ${plate}`,
    body: `<main class="wrap wrap-scan">
  <div class="hero">
    <div class="hero-plate">${esc(plate)}</div>
    <div class="hero-title">这是一辆临时停放的车辆</div>
  </div>

  <section class="card card-note">
    <p class="note-text">${esc(note)}</p>
  </section>

  ${error ? banner(error) : ''}

  <section class="card">
    ${callBlock}
    <div class="divider"><span>或</span></div>
    <form method="post" action="/c/${esc(car.id)}/message" class="stack">
      <label class="field">
        <span class="label">情况</span>
        <select name="reason">
          ${REASONS.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join('')}
        </select>
      </label>
      <label class="field">
        <span class="label">想对车主说</span>
        <textarea name="content" rows="3" maxlength="300"
          placeholder="例：您的车挡住了我出库，麻烦尽快挪一下，谢谢！"></textarea>
      </label>
      <label class="field">
        <span class="label">您的联系方式 <span class="hint-inline">选填，仅车主可见</span></span>
        <input type="text" name="contact" maxlength="60" autocomplete="off"
          placeholder="手机号 / 微信 / 称呼">
      </label>
      <button class="btn btn-primary btn-block" type="submit">发送提醒给车主</button>
    </form>
  </section>

  <p class="foot-note">
    本页面由车主自行设置，不会向扫码人展示车主的真实手机号。<br>
    请勿发送骚扰或广告信息，留言记录会保留用于追溯。
  </p>
</main>`,
  });
}

function sentPage(car) {
  return layout({
    title: '已通知车主',
    body: `<main class="wrap wrap-scan">
  <section class="card center-card">
    <div class="big-ok">&#10003;</div>
    <h1 class="ok-title">已通知车主</h1>
    <p class="muted">车主会尽快查看并处理，感谢您的耐心。</p>
    <a class="btn btn-ghost btn-block" href="/c/${esc(car.id)}">返回</a>
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

function loginPage({ error, configured = true, hint = '' }) {
  const form = configured
    ? `<form method="post" action="/admin/login" class="stack">
      <label class="field">
        <span class="label">管理密码</span>
        <input type="password" name="password" autocomplete="current-password" required autofocus>
      </label>
      <button class="btn btn-primary btn-block" type="submit">登录</button>
    </form>`
    : '<p class="muted">后台已锁定，配置好管理密码后刷新本页。</p>';

  return layout({
    title: '车主后台登录',
    body: `<main class="wrap wrap-narrow">
  <section class="card">
    <h1 class="card-title">挪车码 · 车主后台</h1>
    ${hint ? banner(hint, 'info') : ''}
    ${error ? banner(error) : ''}
    ${form}
  </section>
</main>`,
  });
}

function carForm(car, action, submitText) {
  const v = car || {};
  return `<form method="post" action="${esc(action)}" class="stack">
  <div class="grid-2">
    <label class="field">
      <span class="label">车牌号</span>
      <input type="text" name="plate" maxlength="20" value="${esc(v.plate)}" placeholder="京A·12345">
    </label>
    <label class="field">
      <span class="label">车主称呼</span>
      <input type="text" name="owner_name" maxlength="20" value="${esc(v.owner_name)}" placeholder="张先生">
    </label>
  </div>
  <div class="grid-2">
    <label class="field">
      <span class="label">真实手机号 <span class="hint-inline">不会展示给扫码人</span></span>
      <input type="text" name="phone" maxlength="20" value="${esc(v.phone)}" placeholder="13800138000">
    </label>
    <label class="field">
      <span class="label">对外号码 <span class="hint-inline">隐私号 / 虚拟号</span></span>
      <input type="text" name="call_number" maxlength="20" value="${esc(v.call_number)}" placeholder="17012345678">
    </label>
  </div>
  <label class="field">
    <span class="label">给扫码人的留言</span>
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

function carCard(car, { baseUrl, qrSvg }) {
  const scanUrl = `${baseUrl}/c/${car.id}`;
  return `<article class="car">
  <div class="car-head">
    <div>
      <div class="car-plate">${esc(car.plate || '未填写车牌')}</div>
      <div class="car-meta">
        编号 <code>${esc(car.id)}</code>
        <span class="dot">·</span>创建于 ${esc(fmtTime(car.created_at))}
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
        <a class="btn btn-sm btn-ghost" href="/admin/cars/${esc(car.id)}/print" target="_blank" rel="noreferrer">打印贴纸</a>
        <a class="btn btn-sm btn-ghost" href="/admin/cars/${esc(car.id)}/qr.svg?download=1">下载 SVG</a>
      </div>
      <p class="hint">
        ${car.call_number ? `对外号码：${esc(car.call_number)}` : '未设置对外号码：扫码人只能留言，无法直接拨号。'}
      </p>
    </div>
  </div>

  <details class="car-edit">
    <summary>编辑资料</summary>
    ${carForm(car, `/admin/cars/${car.id}`, '保存修改')}
    <form method="post" action="/admin/cars/${esc(car.id)}/delete" class="danger-zone"
          data-confirm="确定删除车辆 ${esc(car.plate || car.id)}？该车的留言也会一起删除。">
      <button class="btn btn-sm btn-danger" type="submit">删除该车辆</button>
    </form>
  </details>
</article>`;
}

function messageRow(message) {
  const kindLabel = message.kind === 'call' ? '拨号' : '留言';
  const unread = !message.read_at;
  return `<li class="msg ${unread ? 'msg-unread' : ''}">
  <div class="msg-head">
    <span class="badge ${message.kind === 'call' ? 'badge-call' : 'badge-msg'}">${kindLabel}</span>
    <span class="msg-plate">${esc(message.plate || message.car_id)}</span>
    <span class="msg-time">${esc(fmtTime(message.created_at))}</span>
    ${unread ? '<span class="badge badge-new">未读</span>' : ''}
  </div>
  ${message.reason ? `<div class="msg-reason">${esc(message.reason)}</div>` : ''}
  ${message.content ? `<div class="msg-content">${esc(message.content)}</div>` : ''}
  <div class="msg-foot">
    ${message.contact ? `<span>联系方式：${esc(message.contact)}</span>` : '<span class="muted">未留联系方式</span>'}
    <span class="muted">${esc(message.ip)}</span>
    ${unread ? `<form method="post" action="/admin/messages/${esc(message.id)}/read"><button class="btn btn-xs btn-ghost" type="submit">标记已读</button></form>` : ''}
  </div>
</li>`;
}

function adminPage({ cars, messages, baseUrl, unread, notice }) {
  const carSection = cars.length
    ? cars.map((car) => carCard(car, { baseUrl, qrSvg: car.qrSvg })).join('\n')
    : '<p class="muted">还没有车辆，先在上面添加一辆。</p>';

  const messageSection = messages.length
    ? `<ul class="msg-list">${messages.map(messageRow).join('\n')}</ul>`
    : '<p class="muted">暂无留言。</p>';

  return layout({
    title: '车主后台',
    bodyClass: 'admin',
    body: `<header class="topbar">
  <div class="brand">挪车码 · 车主后台</div>
  <div class="topbar-right">
    <span class="badge ${unread ? 'badge-new' : 'badge-on'}">未读 ${unread}</span>
    <form method="post" action="/admin/logout"><button class="btn btn-sm btn-ghost" type="submit">退出</button></form>
  </div>
</header>

<main class="wrap">
  ${notice ? banner(notice.text, notice.kind) : ''}

  <section class="card">
    <h2 class="card-title">接入地址</h2>
    <p class="muted">二维码指向：<code>${esc(baseUrl)}/c/&lt;编号&gt;</code></p>
    <p class="hint">
      上线前请把 <code>PUBLIC_BASE_URL</code> 设成你的固定域名（并配上 HTTPS）。
      若用请求里的 Host 临时生成，换域名后已打印的贴纸会失效。
    </p>
  </section>

  <section class="card">
    <h2 class="card-title">新增车辆</h2>
    ${carForm(null, '/admin/cars', '生成挪车码')}
  </section>

  <section class="card">
    <h2 class="card-title">车辆与贴纸（${cars.length}）</h2>
    <div class="car-list">${carSection}</div>
  </section>

  <section class="card">
    <div class="card-head">
      <h2 class="card-title">留言与拨号记录</h2>
      ${unread ? '<form method="post" action="/admin/messages/read-all"><button class="btn btn-sm btn-ghost" type="submit">全部标记已读</button></form>' : ''}
    </div>
    ${messageSection}
  </section>
</main>`,
  });
}

/* ------------------------------------------------------------------ */
/* 打印贴纸                                                            */
/* ------------------------------------------------------------------ */

function printPage(car, { baseUrl, qrSvg }) {
  const plate = car.plate || '临时停车';
  return layout({
    title: `挪车贴纸 · ${plate}`,
    bodyClass: 'print-body',
    body: `<div class="print-toolbar">
  <a class="btn btn-sm btn-ghost" href="/admin">返回后台</a>
  <button class="btn btn-sm btn-primary" type="button" data-print>打印 / 另存为 PDF</button>
  <span class="hint">建议用 A6 或更小尺寸、不干胶纸打印，贴在挡风玻璃内侧右上角。</span>
</div>

<div class="sticker">
  <div class="sticker-head">
    <div class="sticker-title">扫码挪车</div>
    <div class="sticker-sub">临时停靠 · 请多包涵</div>
  </div>
  <div class="sticker-qr">${qrSvg}</div>
  <div class="sticker-plate">${esc(plate)}</div>
  <div class="sticker-tip">车辆挡路请扫码联系车主<br>双方均不显示真实手机号</div>
  <div class="sticker-code">编号 ${esc(car.id)}</div>
  <div class="sticker-url">${esc(baseUrl)}/c/${esc(car.id)}</div>
</div>`,
  });
}

module.exports = {
  scanPage,
  sentPage,
  messagePage,
  loginPage,
  adminPage,
  printPage,
};
