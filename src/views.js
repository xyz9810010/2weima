'use strict';

const { esc, fmtTime } = require('./core');

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

function scanPage(car, { dialNumber }) {
  const plate = car.plate || '未填写车牌';
  const note = car.note || '您好，如果我的车挡住了您，请点下面的按钮联系我，谢谢！';

  const callBlock = dialNumber
    ? `<a class="btn btn-call btn-block" href="tel:${esc(dialNumber)}"
          data-call-log="/c/${esc(car.id)}/call">
         <span class="btn-icon">&#9742;</span> 一键拨号
       </a>
       <p class="hint center">点击后手机将拨打车主留下的联系电话。</p>`
    : `<div class="notice">车主还没有留下联系电话，暂时无法拨号。</div>`;

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

  <section class="card">
    ${callBlock}
  </section>

  <p class="foot-note">
    本页面由车主自行设置。<br>
    请勿拨打骚扰或广告电话。
  </p>
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
      <span class="label">拨号号码 <span class="hint-inline">扫码人拨打的就是它</span></span>
      <input type="text" name="call_number" maxlength="20" value="${esc(v.call_number)}" placeholder="17012345678">
    </label>
    <label class="field">
      <span class="label">真实手机号 <span class="hint-inline">选填，仅你自己可见</span></span>
      <input type="text" name="phone" maxlength="20" value="${esc(v.phone)}" placeholder="13800138000">
    </label>
  </div>
  <p class="hint">
    有隐私号 / 虚拟号就填在<b>拨号号码</b>里，扫码人拨打它、看不到你的真实号；
    没有的话把手机号填在<b>真实手机号</b>里也行（拨号号码留空时会拨打它）。
    两个都留空，扫码页就不会有拨号按钮。
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
        ${
          car.call_number
            ? `拨号号码：${esc(car.call_number)}`
            : car.phone
              ? `未填拨号号码，扫码页将拨打真实手机号 ${esc(car.phone)}`
              : '<b>⚠️ 两个号码都没填：这张贴纸扫了不会有拨号按钮</b>'
        }
      </p>
    </div>
  </div>

  <details class="car-edit">
    <summary>编辑资料</summary>
    ${carForm(car, `/admin/cars/${car.id}`, '保存修改')}
    <form method="post" action="/admin/cars/${esc(car.id)}/delete" class="danger-zone"
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
    <span class="muted">${esc(record.ip)}</span>
    ${unread ? `<form method="post" action="/admin/messages/${esc(record.id)}/read"><button class="btn btn-xs btn-ghost" type="submit">标记已读</button></form>` : ''}
  </div>
</li>`;
}

function adminPage({ cars, messages, baseUrl, unread, notice }) {
  const carSection = cars.length
    ? cars.map((car) => carCard(car, { baseUrl, qrSvg: car.qrSvg })).join('\n')
    : '<p class="muted">还没有车辆，先在上面添加一辆。</p>';

  const recordSection = messages.length
    ? `<ul class="msg-list">${messages.map(callRow).join('\n')}</ul>`
    : '<p class="muted">还没有人拨号。</p>';

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
      <h2 class="card-title">拨号记录</h2>
      ${unread ? '<form method="post" action="/admin/messages/read-all"><button class="btn btn-sm btn-ghost" type="submit">全部标记已读</button></form>' : ''}
    </div>
    <p class="hint">这里只记录「有人点了一次拨号按钮」，不记录通话内容与号码。</p>
    ${recordSection}
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
  <div class="sticker-tip">车辆挡路请扫码联系车主</div>
  <div class="sticker-code">编号 ${esc(car.id)}</div>
  <div class="sticker-url">${esc(baseUrl)}/c/${esc(car.id)}</div>
</div>`,
  });
}

module.exports = {
  scanPage,
  messagePage,
  loginPage,
  adminPage,
  printPage,
};
