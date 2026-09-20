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
  // 5) 车牌：自动补全格式（大写、只留有效字符）+ 实时预览 + 记住上次选的省份
  function plateEls() {
    return {
      province: document.querySelector('[data-plate-province]'),
      city: document.querySelector('[data-plate-city]'),
      rest: document.querySelector('[data-plate-rest]'),
      preview: document.querySelector('[data-plate-preview]'),
      raw: document.querySelector('[data-plate-raw]'),
    };
  }

  function updatePlatePreview() {
    var el = plateEls();
    if (!el.preview || !el.province || !el.city || !el.rest) return;

    var p = el.province.value;
    var c = el.city.value;
    var r = el.rest.value;

    if (p && c && r) {
      el.preview.textContent = p + c + '·' + r;
      el.preview.className = 'plate-preview on';
    } else {
      el.preview.textContent = '选省份和字母，再填后面的号码';
      el.preview.className = 'plate-preview';
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
      updatePlatePreview();
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

  // 新增车辆时带出上次用过的省份，编辑已有车辆时不动
  (function restoreProvince() {
    var el = plateEls();
    if (!el.province || el.province.value) return;
    try {
      var saved = window.localStorage.getItem('chezai.plate.province');
      if (saved && el.province.querySelector('option[value="' + saved + '"]')) {
        el.province.value = saved;
        updatePlatePreview();
      }
    } catch (error) {
      /* 忽略 */
    }
  })();
})();
