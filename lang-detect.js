/* 全站语种识别（静态页面共用）
   优先级：已保存的手动选择 > 浏览器语言 > IP 国家（服务端注入 window.__BEISU_COUNTRY / /api/geo）> 时区 > 俄语兜底
   站点主要面向俄罗斯游客，未识别出语种时不再默认中文 */
(function () {
  var RU_CTY = ['RU', 'BY', 'KZ', 'KG', 'UA', 'UZ', 'AM', 'AZ', 'GE', 'MD', 'TJ', 'TM', 'LV', 'LT', 'EE', 'MN'];
  var ZH_CTY = ['CN', 'HK', 'TW', 'MO'];
  var EN_CTY = ['US', 'GB', 'AU', 'CA', 'NZ', 'IE', 'SG', 'MY', 'PH', 'IN', 'AE', 'ZA'];

  function normTag(v) {
    v = String(v || '').toLowerCase();
    if (v.indexOf('zh') === 0) return 'zh';
    if (v.indexOf('ru') === 0) return 'ru';
    if (v.indexOf('en') === 0) return 'en';
    return '';
  }

  function browserLang() {
    var list = [];
    try { list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || '']; }
    catch (e) { list = []; }
    for (var i = 0; i < list.length; i++) {
      var v = normTag(list[i]);
      if (v) return v;
    }
    return '';
  }

  function countryLang() {
    var c = String(window.__BEISU_COUNTRY || '').toUpperCase();
    if (!c) return '';
    if (RU_CTY.indexOf(c) >= 0) return 'ru';
    if (ZH_CTY.indexOf(c) >= 0) return 'zh';
    if (EN_CTY.indexOf(c) >= 0) return 'en';
    return '';
  }

  function tzLang() {
    var tz = '';
    try { tz = String(Intl.DateTimeFormat().resolvedOptions().timeZone || ''); } catch (e) { tz = ''; }
    if (!tz) return '';
    if (/^(Europe\/(Moscow|Samara|Volgograd|Kirov|Astrakhan|Kaliningrad|Ulyanovsk|Saratov|Izhevsk|Orenburg|Penza)|Asia\/(Yekaterinburg|Novosibirsk|Krasnoyarsk|Irkutsk|Vladivostok|Yakutsk|Magadan|Kamchatka|Almaty|Aqtobe|Bishkek|Tbilisi|Yerevan|Baku))/.test(tz)) return 'ru';
    if (/^(Asia\/(Shanghai|Chongqing|Harbin|Urumqi|Hong_Kong|Macau|Taipei)|PRC|ROC)/.test(tz)) return 'zh';
    return '';
  }

  /* 用户手动切换过语种 → 一直沿用，不再自动判断 */
  window.beisuSavedLang = function () {
    try {
      var v = localStorage.getItem('beisu-lang');
      return (v === 'zh' || v === 'en' || v === 'ru') ? v : '';
    } catch (e) { return ''; }
  };

  /* 同步识别：用于首屏渲染，不需要网络请求 */
  window.beisuDefaultLang = function () {
    var saved = window.beisuSavedLang();
    if (saved) return saved;
    return browserLang() || countryLang() || tzLang() || 'ru';
  };

  /* 浏览器与时区都给不出语种时，再用 /api/geo 的 IP 国家校正一次（结果缓存在本会话） */
  window.beisuRefineLang = function (cb) {
    if (window.beisuSavedLang()) return;
    if (browserLang()) return;
    if (!cb) return;
    var cached = '';
    try { cached = sessionStorage.getItem('beisu-geo-lang') || ''; } catch (e) { }
    if (cached) return cb(cached);
    try {
      fetch('/api/geo', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var v = (d && (d.lang === 'zh' || d.lang === 'en' || d.lang === 'ru')) ? d.lang : '';
          if (!v) return;
          try { sessionStorage.setItem('beisu-geo-lang', v); } catch (e2) { }
          cb(v);
        })
        .catch(function () { });
    } catch (e3) { }
  };
})();
