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
})();
