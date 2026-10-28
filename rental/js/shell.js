/* ============================================================
   海南全岛地图 · 单页外壳
   ------------------------------------------------------------
   把「地图」与「内容管理」两个视图放在同一个链接里，用顶部标签切换。
   两个模块（js/view.js、js/admin.js）按需懒加载，不同时初始化：
     · 两个模块都会各自建一个 ECharts 实例，且都用全局 document 选择器绑事件，
       同时执行会互相干扰（比如内容管理里的 .tab 被地图侧劫持）。
       —— 各自视图第一次显示时才注入脚本，从根上避免冲突。
     · 两边的地图容器 id 也不重名（#map / #adminMap）。
   切换时：
     · 派发一次 resize，让 ECharts 重新量尺寸（隐藏容器里量不到大小）；
     · 若另一侧此前已被使用过，则让当前视图重新拉一遍数据，避免看到旧内容。
   参数：
     ?tab=admin   直接进入内容管理（旧的 admin.html 会跳到这里）
     ?embed=1     只有地图、没有标签栏，供 iframe 嵌入
   ============================================================ */
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var EMBED  = params.get('embed') === '1';

  /* 视图名 -> 容器 id / 该视图对应的模块脚本 */
  var VIEWS = {
    map:   { el: 'viewMap',   script: 'js/view.js'  },
    admin: { el: 'viewAdmin', script: 'js/admin.js' }
  };

  var els     = {};    /* 视图名 -> 容器元素 */
  var loaded  = {};    /* 模块脚本是否已注入 */
  var visited = {};    /* 视图是否已被显示过 */
  var current = null;

  Object.keys(VIEWS).forEach(function (k) { els[k] = document.getElementById(VIEWS[k].el); });

  var tabs = Array.prototype.slice.call(document.querySelectorAll('.shell__tab'));

  function loadModule(name) {
    if (loaded[name]) return;
    loaded[name] = true;
    var s = document.createElement('script');
    s.src = VIEWS[name].script;
    document.body.appendChild(s);
  }

  /* 隐藏容器里 ECharts 量不到大小，显示后要让它重新量一次 */
  function resizeMaps() {
    window.dispatchEvent(new Event('resize'));
    requestAnimationFrame(function () { window.dispatchEvent(new Event('resize')); });
  }

  function show(name) {
    Object.keys(els).forEach(function (k) { if (els[k]) els[k].hidden = k !== name; });
    tabs.forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-view') === name); });
  }

  function activate(name) {
    if (!VIEWS[name]) name = 'map';
    if (current === name) return;
    var prev = current;
    current = name;

    show(name);
    loadModule(name);
    resizeMaps();

    /* 同一页里两侧共享同一份服务端数据：另一侧改过之后切回来要重新拉一遍 */
    if (prev && visited[prev]) {
      if (name === 'map'   && window.HainanViewReload)  window.HainanViewReload();
      if (name === 'admin' && window.HainanAdminReload) window.HainanAdminReload();
    }
    visited[name] = true;
  }

  /* —— 顶部标签 —— */
  tabs.forEach(function (t) {
    t.addEventListener('click', function () { activate(t.getAttribute('data-view')); });
  });

  /* —— 视图内部的互跳入口（「内容管理 →」「查看前台」）——
     保留 href 作为无脚本时的兜底，有脚本时改为原地切标签。 */
  Array.prototype.forEach.call(document.querySelectorAll('[data-goto]'), function (el) {
    el.addEventListener('click', function (e) {
      e.preventDefault();
      activate(el.getAttribute('data-goto'));
    });
  });

  /* —— 嵌入模式：只要地图，不要标签栏 —— */
  if (EMBED) {
    document.body.classList.add('embed');
    show('map');
    current = 'map';
    visited.map = true;
    loadModule('map');
    resizeMaps();
    return;
  }

  /* —— 初始视图（默认地图，?tab=admin 直达内容管理）—— */
  activate(params.get('tab') === 'admin' ? 'admin' : 'map');
})();
