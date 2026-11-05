/* 全站语种识别（静态页面共用）
   优先级：服务端路由指定的语种 > 已保存的手动选择 > 俄语
   /ru、/en、/zh 页面由服务端写入 window.__BEISU_FORCED_LANG，页面语言完全由 URL 决定，
   不再依赖 localStorage；其余未做语言路由的子页面保留原有手动选择逻辑 */
(function () {
  /* 服务端写入的强制语种（/ru、/en、/zh 路由） */
  window.beisuForcedLang = function () {
    var v = window.__BEISU_FORCED_LANG;
    return (v === 'zh' || v === 'en' || v === 'ru') ? v : '';
  };

  /* 用户手动切换过语种 → 一直沿用，不再自动判断 */
  window.beisuSavedLang = function () {
    try {
      var v = localStorage.getItem('beisu-lang');
      return (v === 'zh' || v === 'en' || v === 'ru') ? v : '';
    } catch (e) { return ''; }
  };

  /* 默认语种：服务端指定 > 手动选择 > 俄语（俄语优先） */
  window.beisuDefaultLang = function () {
    return window.beisuForcedLang() || window.beisuSavedLang() || 'ru';
  };

  /* 保留此函数仅为兼容各页面调用：默认语种已固定俄语，无需二次校正 */
  window.beisuRefineLang = function () { };
})();
