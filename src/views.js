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
              : '<b>⚠️ 两个号码都没填：这张贴纸扫了不会有拨号按钮</b>'
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

  <details class="car-edit">
    <summary>编辑资料（换车牌 / 换号码 / 换车都改这里）</summary>
    ${carForm(car, `/cars/${car.id}`, '保存修改')}
    <form method="post" action="/cars/${esc(car.id)}/delete" class="danger-zone"
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
    ${unread ? `<form method="post" action="/messages/${esc(record.id)}/read"><button class="btn btn-xs btn-ghost" type="submit">标记已读</button></form>` : ''}
  </div>
</li>`;
}

function adminPage({ mode = 'admin', account = null, cars, messages, users = [], baseUrl, universal, unread, notice }) {
  const isAdmin = mode === 'admin';
  const carSection = cars.length
    ? cars
        .map((car) =>
          carCard(car, {
            baseUrl,
            qrSvg: car.qrSvg,
            ownerLabel: isAdmin && car.owner_contact ? `车主 ${car.owner_contact}` : '',
          })
        )
        .join('\n')
    : `<p class="muted">${isAdmin ? '还没有车辆，先在上面添加一辆。' : '还没有车辆，先添加一辆你的车。'}</p>`;

  const recordSection = messages.length
    ? `<ul class="msg-list">${messages.map(callRow).join('\n')}</ul>`
    : '<p class="muted">还没有人拨号。</p>';

  const userSection = !isAdmin
    ? ''
    : `<section class="card">
    <div class="card-head">
      <h2 class="card-title">车主账号（${users.length}）</h2>
    </div>
    <p class="hint">每个车主一个账号，只能看到和管理自己的车。</p>
    ${
      users.length
        ? `<ul class="user-list">${users
            .map(
              (u) => `<li class="user-row">
        <span class="user-contact">${esc(u.contact)}</span>
        ${u.name ? `<span class="user-name">${esc(u.name)}</span>` : ''}
        <span class="user-cars">${Number(u.car_count) || 0} 辆车</span>
        <span class="user-time">${esc(fmtTime(u.created_at))}</span>
      </li>`
            )
            .join('\n')}</ul>`
        : '<p class="muted">还没有车主注册。</p>'
    }
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
    <span class="badge ${unread ? 'badge-new' : 'badge-on'}">未读 ${unread}</span>
    <form method="post" action="/logout"><button class="btn btn-sm btn-ghost" type="submit">退出</button></form>
  </div>
</header>

<main class="wrap">
  ${notice ? banner(notice.text, notice.kind) : ''}
  ${
    isAdmin
      ? `<section class="card">
    <h2 class="card-title">平台控制台</h2>
    <p class="muted">你是平台管理员：这里的「新增车辆」建出来的是<b>平台自有车</b>（owner_id 为空），
      在车主账号里看不到；通用码也只认这些车。</p>
    <p class="hint">车主各自注册账号后，在「我的车辆」里自己建车、自己打印贴纸。</p>
  </section>`
      : `<section class="card">
    <h2 class="card-title">我的账号</h2>
    <p class="muted">${esc((account && account.contact) || '')}${account && account.name ? ` · ${esc(account.name)}` : ''}</p>
    <p class="hint">你只能看到和管理自己的车。</p>
  </section>`
  }

  <section class="card">
    <h2 class="card-title">新增车辆</h2>
    ${carForm(null, '/cars', '生成挪车码')}
  </section>

  <section class="card">
    <div class="card-head">
      <h2 class="card-title">车辆与贴纸（${cars.length}）</h2>
      ${cars.length ? `<a class="btn btn-sm btn-primary" href="/print-all" target="_blank" rel="noreferrer">批量打印全部贴纸</a>` : ''}
    </div>
    <p class="hint">
      <b>一车一码</b>：每辆车有自己的码，扫码直接进那一辆，扫码人不用选。
      批量打印会把所有车的贴纸排在一页里一次打完。
      改车牌、改号码都不用重新打印。
    </p>
    <div class="car-list">${carSection}</div>
  </section>

  ${universalSection}

  <section class="card">
    <div class="card-head">
      <h2 class="card-title">拨号记录</h2>
      ${unread ? `<form method="post" action="/messages/read-all"><button class="btn btn-sm btn-ghost" type="submit">全部标记已读</button></form>` : ''}
    </div>
    <p class="hint">这里只记「有人点了一次拨号按钮」，不记录扫码人的 IP、设备信息，也不记录通话内容与号码。</p>
    ${recordSection}
  </section>

  ${userSection}
</main>`,
  });
}

/* ------------------------------------------------------------------ */
/* 打印贴纸                                                            */
/* ------------------------------------------------------------------ */

/**
 * 贴纸。
 *
 * 刻意**不印车牌**：车牌和号码都是扫码那一刻从数据库现查的，
 * 印在贴纸上只会变成过期信息 —— 贴纸挪到别的车上、或者车换了牌照，
 * 印上去的旧车牌就和扫码页对不上了。
 * 印一个小号「编号」是给自己看的：它等于后台那条记录的编号，永久不变，
 * 换车换号码都还是它，便于把贴纸和后台记录对上号。
 */
function sticker(car, { qrSvg, universal = false }) {
  return `<div class="sticker">
  <div class="sticker-head">
    <div class="sticker-title">扫码挪车</div>
    <div class="sticker-sub">临时停靠 · 请多包涵</div>
  </div>
  <div class="sticker-qr">${qrSvg}</div>
  <div class="sticker-tip">车辆挡路请扫码联系车主</div>
  <div class="sticker-code">${universal ? '通用贴纸 · 可贴任意车辆' : `编号 ${esc(car.id)}`}</div>
</div>`;
}

function printPage(car, { baseUrl, qrSvg, universal = false }) {
  return layout({
    title: universal ? '挪车贴纸 · 通用' : `挪车贴纸 · ${car.plate || '未填写车牌'}`,
    bodyClass: 'print-body',
    body: `<div class="print-toolbar">
  <a class="btn btn-sm btn-ghost" href="/admin">返回后台</a>
  <button class="btn btn-sm btn-primary" type="button" data-print>打印 / 另存为 PDF</button>
  <span class="hint">建议用 A6 或更小尺寸、不干胶纸打印，贴在挡风玻璃内侧右上角。</span>
</div>

${sticker(car, { qrSvg, universal })}

<p class="print-note">
  ${
    universal
      ? '这是通用贴纸：一张可以贴在任意一辆车上。扫码后如果车主启用了多辆车，扫码人需要先点一下车牌。'
      : `贴纸上的码永久不变，所以车牌、号码随时能改，换到别的车上也不用重印。<br>
         它指向后台里编号为 ${esc(car.id)} 的那条记录 —— 改那条记录就等于改这张贴纸。<br>
         二维码内容：${esc(baseUrl)}/c/${esc(car.id)}`
  }
</p>`,
  });
}

/** 批量打印：把启用中的每辆车各出一张贴纸，排在一页里一次打完 */
function printAllPage({ cars, baseUrl }) {
  const sheet = cars.length
    ? cars
        .map(
          (car) => `<div class="sticker-cell">
        ${sticker(car, { qrSvg: car.qrSvg })}
        <div class="sticker-url">${esc(car.plate || '未填写车牌')} · ${esc(car.id)}</div>
      </div>`
        )
        .join('\n')
    : '<p class="muted">没有启用中的车辆。</p>';

  return layout({
    title: '批量打印挪车贴纸',
    bodyClass: 'print-body',
    body: `<div class="print-toolbar">
  <a class="btn btn-sm btn-ghost" href="/admin">返回后台</a>
  <button class="btn btn-sm btn-primary" type="button" data-print>打印 / 另存为 PDF</button>
  <span class="hint">每辆车一张，共 ${cars.length} 张。虚线下面那行是「车牌 · 编号」，裁剪后丢掉即可，别印到贴纸上。</span>
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
  printPage,
  printAllPage,
};
