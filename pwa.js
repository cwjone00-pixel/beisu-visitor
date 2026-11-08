/* beisuas PWA：注册 Service Worker + 捕获安装事件，展示「安装应用」提示
   - 满足 Chrome / Opera 的安装条件（manifest + service worker）
   - beforeinstallprompt 被触发时弹出站点内提示条，点击调用原生安装对话框
   - 已安装（独立窗口运行）或用户关闭后不再打扰 */

(function () {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () {});
    });
  }

  var DISMISS_KEY = 'beisu-install-dismiss';
  var DISMISS_DAYS = 7;
  var deferred = null;
  var banner = null;

  function standalone() {
    try {
      return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
        || window.navigator.standalone === true;
    } catch (e) { return false; }
  }

  function lang() {
    var v = '';
    try { v = (window.beisuForcedLang && window.beisuForcedLang()) || ''; } catch (e) {}
    if (!v) {
      var h = String(document.documentElement.lang || '').toLowerCase();
      v = h.indexOf('zh') === 0 ? 'zh' : (h.indexOf('en') === 0 ? 'en' : 'ru');
    }
    return v;
  }

  var TEXT = {
    ru: { title: 'Установить приложение beisuas', sub: 'Открывается в отдельном окне, без адресной строки', ok: 'Установить', no: 'Позже' },
    en: { title: 'Install the beisuas app', sub: 'Opens in its own window, without the address bar', ok: 'Install', no: 'Later' },
    zh: { title: '安装 beisuas 应用', sub: '独立窗口打开，不显示地址栏', ok: '安装应用', no: '稍后' }
  };

  function dismissed() {
    try {
      var t = +localStorage.getItem(DISMISS_KEY) || 0;
      return Date.now() - t < DISMISS_DAYS * 86400000;
    } catch (e) { return false; }
  }

  function remember() {
    try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch (e) {}
  }

  function hide() {
    if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
    banner = null;
  }

  function show() {
    if (banner || standalone() || dismissed()) return;
    var t = TEXT[lang()] || TEXT.ru;
    banner = document.createElement('div');
    banner.setAttribute('role', 'dialog');
    banner.style.cssText = 'position:fixed;left:50%;bottom:74px;transform:translateX(-50%);z-index:10000;'
      + 'display:flex;align-items:center;gap:10px;max-width:calc(100% - 24px);'
      + 'padding:10px 12px 10px 14px;border-radius:12px;background:rgba(28,35,48,.94);color:#fff;'
      + 'font-size:13px;line-height:1.35;box-shadow:0 10px 30px rgba(10,20,40,.28);'
      + 'font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei","Segoe UI",Roboto,sans-serif';

    var icon = document.createElement('img');
    icon.src = '/icon-192.png';
    icon.alt = '';
    icon.width = 30;
    icon.height = 30;
    icon.style.cssText = 'flex:none;border-radius:8px;background:#fff';

    var txt = document.createElement('div');
    txt.style.cssText = 'min-width:0';
    var h = document.createElement('div');
    h.textContent = t.title;
    h.style.cssText = 'font-weight:600;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    var s = document.createElement('div');
    s.textContent = t.sub;
    s.style.cssText = 'font-size:11.5px;color:rgba(255,255,255,.72);margin-top:2px';
    txt.appendChild(h);
    txt.appendChild(s);

    var ok = document.createElement('button');
    ok.type = 'button';
    ok.textContent = t.ok;
    ok.style.cssText = 'flex:none;padding:7px 13px;border:0;border-radius:8px;background:#2f7cf6;color:#fff;'
      + 'font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit';
    ok.onclick = function () {
      if (!deferred) { hide(); return; }
      var p = deferred;
      deferred = null;
      hide();
      p.prompt();
      if (p.userChoice && p.userChoice.then) p.userChoice.then(function () {}, function () {});
    };

    var no = document.createElement('button');
    no.type = 'button';
    no.textContent = t.no;
    no.setAttribute('aria-label', t.no);
    no.style.cssText = 'flex:none;width:24px;height:24px;border:0;border-radius:6px;background:transparent;'
      + 'color:rgba(255,255,255,.75);font-size:13px;cursor:pointer;font-family:inherit';
    no.onclick = function () { remember(); hide(); };

    banner.appendChild(icon);
    banner.appendChild(txt);
    banner.appendChild(ok);
    banner.appendChild(no);
    document.body.appendChild(banner);
  }

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferred = e;
    show();
  });

  window.addEventListener('appinstalled', function () {
    deferred = null;
    remember();
    hide();
  });
})();
