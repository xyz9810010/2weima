// 挪车码 · 前端脚本（仅两个小功能，页面本身不依赖 JS 也能用）

(function () {
  'use strict';

  // 1) 扫码人点"一键拨号"时，静默给车主记一条提醒；跳转 tel: 由 <a> 自己完成，不受影响。
  document.addEventListener('click', function (event) {
    var target = event.target;
    while (target && target !== document && !target.hasAttribute('data-call-log')) {
      target = target.parentNode;
    }
    if (!target || target === document) return;

    var url = target.getAttribute('data-call-log');
    if (!url) return;

    try {
      var payload = new Blob(['{}'], { type: 'application/json' });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, payload);
      } else if (window.fetch) {
        fetch(url, { method: 'POST', body: payload, keepalive: true });
      }
    } catch (error) {
      /* 记录失败不影响拨号 */
    }
  });

  // 2) 危险操作二次确认
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || !form.getAttribute) return;
    var message = form.getAttribute('data-confirm');
    if (message && !window.confirm(message)) {
      event.preventDefault();
    }
  });

  // 6) 局部刷新：data-remote 的表单用 fetch 提交，只换变化的片段，不整页重载。
  //    没有 JS、或服务端没按 AJAX 回应时，照常整页提交。
  var FRAGMENT_IDS = [
    'notice-area',
    'car-count',
    'car-actions',
    'car-list',
    'empty-warn',
    'record-area',
    'record-actions',
    'code-count',
    'code-area',
    'user-count',
    'user-area',
  ];

  function openGroupIndexes(scope) {
    // 「待绑定 / 已绑定」这两组也按展开状态记住，否则绑定一条之后列表整个收起来，
    // 用户还得再点一下才能看到结果
    var lists = scope.querySelectorAll('details.code-group');
    var open = [];
    for (var i = 0; i < lists.length; i++) if (lists[i].open) open.push(i);
    return open;
  }

  function restoreOpenGroups(scope, indexes) {
    var lists = scope.querySelectorAll('details.code-group');
    for (var i = 0; i < indexes.length; i++) {
      if (lists[indexes[i]]) lists[indexes[i]].open = true;
    }
  }

  function applyFragments(payload) {
    var codeArea = document.getElementById('code-area');
    var openedGroups = codeArea ? openGroupIndexes(codeArea) : [];
    var html = payload.html || {};
    for (var i = 0; i < FRAGMENT_IDS.length; i++) {
      var id = FRAGMENT_IDS[i];
      if (!(id in html)) continue;
      var el = document.getElementById(id);
      if (el) el.innerHTML = html[id];
    }
    if (codeArea) restoreOpenGroups(codeArea, openedGroups);

    var badge = document.getElementById('unread-badge');
    if (badge && typeof payload.unread === 'number') {
      badge.textContent = '未读 ' + payload.unread;
      badge.className = 'badge ' + (payload.unread ? 'badge-new' : 'badge-on');
    }
  }

  // 7) 轻提示：固定在屏幕底部，不管滚到哪里都看得到。
  //    role=status + aria-live 让读屏也会念出来，不是只有视觉反馈。
  function toast(text, kind) {
    if (!text) return;
    var host = document.getElementById('toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toast-host';
      host.className = 'toast-host';
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }

    // 只留最新一条：连着做两个操作时，堆叠起来反而看不清哪句是刚才那次
    host.innerHTML = '';

    var el = document.createElement('div');
    el.className = 'toast' + (kind === 'error' ? ' toast-error' : '');
    el.textContent = text;
    host.appendChild(el);

    setTimeout(function () {
      el.classList.add('toast-out');
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 320);
    }, 2400);
  }

  function setPending(form, pending) {
    var buttons = form.querySelectorAll('button[type="submit"]');
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      if (pending) {
        btn.setAttribute('data-label', btn.textContent);
        btn.disabled = true;
        btn.textContent = '处理中…';
      } else if (btn.getAttribute('data-label')) {
        btn.disabled = false;
        btn.textContent = btn.getAttribute('data-label');
        btn.removeAttribute('data-label');
      }
    }
  }

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || !form.getAttribute || !form.hasAttribute('data-remote')) return;
    if (!window.fetch || !window.FormData) return; // 老浏览器：走原来的整页提交
    if (event.defaultPrevented) return; // 二次确认里点了取消

    event.preventDefault();

    var action = form.getAttribute('action') || window.location.pathname;
    setPending(form, true);

    // 必须发 urlencoded，不能用 FormData：
    // FormData 会变成 multipart/form-data，而服务端（Node 与 Worker 共用）只用
    // URLSearchParams 解析表单 —— 那样提交上去的字段全是空的，
    // 保存就等于把车牌号码清空。这一条是踩过的坑。
    var encoded = new URLSearchParams(new FormData(form)).toString();

    fetch(action, {
      method: 'POST',
      body: encoded,
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'X-Requested-With': 'fetch',
      },
    })
      .then(function (res) {
        var type = res.headers.get('content-type') || '';
        if (type.indexOf('application/json') < 0) {
          // 服务端没走 AJAX（例如会话过期跳登录页）：老老实实整页跳过去
          window.location.href = res.url || window.location.href;
          return null;
        }
        return res.json().then(function (payload) {
          return { status: res.status, payload: payload };
        });
      })
      .then(function (result) {
        setPending(form, false);
        if (!result) return;

        var payload = result.payload || {};
        if (!payload.ok) {
          var area = document.getElementById('notice-area');
          if (area && payload.notice) {
            area.innerHTML =
              '<div class="banner banner-' +
              (payload.kind === 'error' ? 'error' : 'info') +
              '"' +
              (payload.kind === 'error' ? ' role="alert"' : '') +
              '>' +
              payload.notice +
              '</div>';
          }
          toast(payload.notice, payload.kind === 'error' ? 'error' : 'info');
          return;
        }

        applyFragments(payload);

        // 底部轻提示：改完立刻知道成没成，不用滚回顶部找那行提示
        if (payload.notice && payload.notice.text) {
          toast(payload.notice.text, payload.notice.kind);
        }

        var newCarForm = form.hasAttribute('data-car-id') ? null : form;
        if (newCarForm && payload.resetNewCar) {
          newCarForm.reset();
          newCarForm.dispatchEvent(new Event('change', { bubbles: true }));
          if (window.__chezaiRestoreProvince) window.__chezaiRestoreProvince();
        }
      })
      .catch(function () {
        // 网络出问题就退回普通提交，别让用户点了没反应
        setPending(form, false);
        form.submit();
      });
  });

  // 3) 打印按钮
  document.addEventListener('click', function (event) {
    var target = event.target;
    while (target && target !== document && !target.hasAttribute('data-print')) {
      target = target.parentNode;
    }
    if (!target || target === document) return;
    event.preventDefault();
    window.print();
  });

  // 4) 复制管理链接（长链接手抄容易错）
  document.addEventListener('click', function (event) {
    var target = event.target;
    while (target && target !== document && !target.hasAttribute('data-copy')) {
      target = target.parentNode;
    }
    if (!target || target === document) return;
    event.preventDefault();

    var text = target.getAttribute('data-copy');
    var done = function () {
      var old = target.textContent;
      target.textContent = '已复制';
      setTimeout(function () {
        target.textContent = old;
      }, 1500);
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {
        window.prompt('复制这条链接：', text);
      });
    } else {
      window.prompt('复制这条链接：', text);
    }
  });
  // 8) 编辑资料弹窗：原生 <dialog>。焦点圈禁与 Esc 关闭由浏览器提供，
  //    这里只负责打开、关闭、点遮罩关闭。CSP 禁内联脚本，全部走事件委托。
  document.addEventListener('click', function (event) {
    var opener = event.target.closest('[data-dialog-open]');
    if (opener) {
      var dialog = document.getElementById(opener.getAttribute('data-dialog-open'));
      if (!dialog) return;
      if (typeof dialog.showModal === 'function') {
        dialog.showModal();
      } else {
        // 老浏览器没有 showModal：直接标 open 当页内块级元素用
        dialog.setAttribute('open', '');
      }
      // 每次打开都还原成服务端渲染的初始值。弹窗关闭后 DOM 不销毁，
      // 上次误改的号码会留在输入框里：下次打开像没动过，一保存就连带改掉
      // （想改称呼也会把车牌一起改了）。form.reset() 还原的正是默认值。
      var forms = dialog.querySelectorAll('form');
      for (var i = 0; i < forms.length; i++) {
        forms[i].reset();
        updatePlatePreview(forms[i]);
      }
      var first = dialog.querySelector('.dialog-body input, .dialog-body select, .dialog-body textarea');
      if (first) first.focus();
      return;
    }

    var closer = event.target.closest('[data-dialog-close]');
    if (closer) {
      var box = closer.closest('dialog');
      if (box) {
        if (typeof box.close === 'function') box.close();
        else box.removeAttribute('open');
      }
      return;
    }

    // 点遮罩关闭：click 落在 dialog 元素自身、且坐标在它的盒子之外
    if (event.target instanceof HTMLDialogElement && event.target.hasAttribute('open')) {
      var rect = event.target.getBoundingClientRect();
      var outside =
        event.clientY < rect.top ||
        event.clientY >= rect.bottom ||
        event.clientX < rect.left ||
        event.clientX >= rect.right;
      if (outside) event.target.close();
    }
  });

  // 5) 车牌：自动补全格式（大写、只留有效字符）+ 实时预览 + 记住上次选的省份
  //    一页可能同时存在多张车牌表单（新增车辆 + 每辆车一个编辑弹窗），
  //    预览必须按事件所在的表单更新，否则在弹窗里打字改的是背后表单的预览行。
  //    作用域取 <form>：三段输入在 .plate-input 里，预览行与特殊车牌是它的兄弟，
  //    只看 .plate-input 会取不到预览（踩过）。
  function plateFormOf(node) {
    var form = node && node.closest ? node.closest('form') : null;
    return form || document;
  }

  function updatePlatePreview(scope) {
    scope = scope || document;
    var preview = scope.querySelector('[data-plate-preview]');
    var province = scope.querySelector('[data-plate-province]');
    var city = scope.querySelector('[data-plate-city]');
    var rest = scope.querySelector('[data-plate-rest]');
    if (!preview || !province || !city || !rest) return;

    if (province.value && city.value && rest.value) {
      preview.textContent = province.value + city.value + '·' + rest.value;
      preview.className = 'plate-preview on';
    } else {
      preview.textContent = '选省份和字母，再填后面的号码';
      preview.className = 'plate-preview';
    }
  }

  // 号码格子只允许数字和大写字母，且不含 I / O（车牌里不用这两个字母）
  document.addEventListener('input', function (event) {
    var target = event.target;
    if (!target || !target.hasAttribute) return;

    if (target.hasAttribute('data-plate-rest') || target.hasAttribute('data-plate-raw')) {
      var cleaned = target.value.toUpperCase().replace(/[^0-9A-Z·]/g, '');
      if (target.hasAttribute('data-plate-rest')) cleaned = cleaned.replace(/[IO·]/g, '');
      if (cleaned !== target.value) target.value = cleaned;
    }

    if (
      target.hasAttribute('data-plate-rest') ||
      target.hasAttribute('data-plate-province') ||
      target.hasAttribute('data-plate-city')
    ) {
      updatePlatePreview(plateFormOf(target));
    }
  });

  document.addEventListener('change', function (event) {
    var target = event.target;
    if (!target || !target.hasAttribute || !target.hasAttribute('data-plate-province')) return;
    // 记住这次选的省份：下次加车不用重新翻一遍下拉
    try {
      if (target.value) window.localStorage.setItem('chezai.plate.province', target.value);
    } catch (error) {
      /* 隐私模式下 localStorage 可能不可用，忽略 */
    }
  });

  updatePlatePreview();

  // 新增车辆时带出上次用过的省份，编辑已有车辆时不动。
  // 局部刷新提交成功后表单会被 reset，那时也要靠它把省份补回来。
  // 只认第一张表单（新增车辆）：编辑弹窗里的表单本来就带着值。
  function restoreProvince() {
    var province = document.querySelector('[data-plate-province]');
    if (!province || province.value) return;
    try {
      var saved = window.localStorage.getItem('chezai.plate.province');
      if (saved && province.querySelector('option[value="' + saved + '"]')) {
        province.value = saved;
        updatePlatePreview(document);
      }
    } catch (error) {
      /* 忽略 */
    }
  }

  window.__chezaiRestoreProvince = restoreProvince;
  restoreProvince();
})();
