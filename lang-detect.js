/* 全站语种识别（静态页面共用）
   优先级：已保存的手动选择 > 俄语
   站点面向俄罗斯游客，默认俄语：不再按浏览器语言 / IP 国家 / 时区自动判断 */
(function () {
  /* 用户手动切换过语种 → 一直沿用，不再自动判断 */
  window.beisuSavedLang = function () {
    try {
      var v = localStorage.getItem('beisu-lang');
      return (v === 'zh' || v === 'en' || v === 'ru') ? v : '';
    } catch (e) { return ''; }
  };

  /* 默认语种：仅保留用户手动选择，其余一律俄语（俄语优先） */
  window.beisuDefaultLang = function () {
    return window.beisuSavedLang() || 'ru';
  };

  /* 保留此函数仅为兼容各页面调用：默认语种已固定俄语，无需二次校正 */
  window.beisuRefineLang = function () { };
})();
