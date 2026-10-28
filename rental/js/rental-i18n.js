/* ============================================================
   海南地图 · 租车行 / 市县名称三语对照
   ------------------------------------------------------------
   地图页（map-play.html）与车辆详情页（rental.html）共用一份：
     · areaName(中文区名, lang)  → 地图底图 / 门店所在市县的三语名
     · agencyName(门店对象, lang) → 门店三语名
   高德只返回中文门店名，这里给出英 / 俄对照；未收录的新门店
   回落到「品牌译名 · 市县名」，不会出现英文/俄文里夹中文。
   ============================================================ */
window.RentalI18n = (function () {
  'use strict';

  /* 各市县名称三语对照：地图底图（geojson）里的区名只有中文 */
  var AREA_NAMES = {
    '海口市': { zh: '海口', en: 'Haikou', ru: 'Хайкоу' },
    '三亚市': { zh: '三亚', en: 'Sanya', ru: 'Санья' },
    '儋州市': { zh: '儋州', en: 'Danzhou', ru: 'Даньчжоу' },
    '五指山市': { zh: '五指山', en: 'Wuzhishan', ru: 'Учжишань' },
    '琼海市': { zh: '琼海', en: 'Qionghai', ru: 'Цюнхай' },
    '文昌市': { zh: '文昌', en: 'Wenchang', ru: 'Вэньчан' },
    '万宁市': { zh: '万宁', en: 'Wanning', ru: 'Ваньнин' },
    '东方市': { zh: '东方', en: 'Dongfang', ru: 'Дунфан' },
    '定安县': { zh: '定安', en: 'Ding’an', ru: 'Динань' },
    '屯昌县': { zh: '屯昌', en: 'Tunchang', ru: 'Туньчан' },
    '澄迈县': { zh: '澄迈', en: 'Chengmai', ru: 'Чэнмай' },
    '临高县': { zh: '临高', en: 'Lingao', ru: 'Линьгао' },
    '白沙黎族自治县': { zh: '白沙', en: 'Baisha', ru: 'Байша' },
    '昌江黎族自治县': { zh: '昌江', en: 'Changjiang', ru: 'Чанцзян' },
    '乐东黎族自治县': { zh: '乐东', en: 'Ledong', ru: 'Лэдун' },
    '陵水黎族自治县': { zh: '陵水', en: 'Lingshui', ru: 'Линшуй' },
    '保亭黎族苗族自治县': { zh: '保亭', en: 'Baoting', ru: 'Баотин' },
    '琼中黎族苗族自治县': { zh: '琼中', en: 'Qiongzhong', ru: 'Цюнчжун' }
  };

  /* 门店名三语（按高德返回的中文全名对照） */
  var AGENCY_NAMES = {
    '神州租车(美兰机场T1服务点)': { en: 'Shenzhou Car Rental (Meilan Airport T1)', ru: 'Shenzhou Аренда авто (аэропорт Мэйлань, T1)' },
    '神州租车凤凰机场店': { en: 'Shenzhou Car Rental (Phoenix Airport)', ru: 'Shenzhou Аренда авто (аэропорт Феникс)' },
    '神州租车(东方华府服务点)': { en: 'Shenzhou Car Rental (Dongfang Huafu)', ru: 'Shenzhou Аренда авто (Дунфан, Хуафу)' },
    '一嗨租车(那大文化北路店)': { en: 'eHi Car Rental (Nada Wenhua North Rd)', ru: 'eHi Аренда авто (Нада, ул. Вэньхуа, север)' },
    '一嗨租车(五指山怡景花园店)': { en: 'eHi Car Rental (Wuzhishan Yijing Garden)', ru: 'eHi Аренда авто (Учжишань, сад Ицзин)' },
    '一嗨租车(博鳌机场店)': { en: 'eHi Car Rental (Bo’ao Airport)', ru: 'eHi Аренда авто (аэропорт Боао)' },
    '一嗨租车(见龙大道店)': { en: 'eHi Car Rental (Jianlong Ave)', ru: 'eHi Аренда авто (просп. Цзяньлун)' },
    '一嗨租车(水晶公园店)': { en: 'eHi Car Rental (Crystal Park)', ru: 'eHi Аренда авто (парк «Кристалл»)' },
    '一嗨租车(澄迈老城店)': { en: 'eHi Car Rental (Chengmai Laocheng)', ru: 'eHi Аренда авто (Чэнмай, Лаочэн)' },
    '一嗨租车(临高二环路店)': { en: 'eHi Car Rental (Lingao 2nd Ring Rd)', ru: 'eHi Аренда авто (Линьгао, 2-е кольцо)' },
    '一嗨租车(昌江环城东路店)': { en: 'eHi Car Rental (Changjiang Huancheng East Rd)', ru: 'eHi Аренда авто (Чанцзян, вост. кольцо)' },
    '一嗨租车(乐东站店)': { en: 'eHi Car Rental (Ledong Station)', ru: 'eHi Аренда авто (станция Лэдун)' },
    '一嗨租车(陵水动车站便捷点)': { en: 'eHi Car Rental (Lingshui Rail Station)', ru: 'eHi Аренда авто (ж/д станция Линшуй)' },
    '一嗨租车(保亭汽车站店)': { en: 'eHi Car Rental (Baoting Bus Station)', ru: 'eHi Аренда авто (автовокзал Баотин)' },
    '桐叶租车CAR RENTAL(文昌高铁店)': { en: 'Tongye Car Rental (Wenchang HSR Station)', ru: 'Tongye Аренда авто (вокзал ВСМ Вэньчан)' },
    '发呆呆租车': { en: 'Fadaidai Car Rental', ru: 'Fadaidai Аренда авто' },
    '奥鑫汽车租赁': { en: 'Aoxin Car Rental', ru: 'Aoxin Аренда авто' },
    '和胜汽车租赁': { en: 'Hesheng Car Rental', ru: 'Hesheng Аренда авто' }
  };

  /* 品牌译名：门店名没在对照表里时，至少把品牌说清楚 */
  var BRANDS = [
    ['神州租车', { en: 'Shenzhou Car Rental', ru: 'Shenzhou Аренда авто' }],
    ['一嗨租车', { en: 'eHi Car Rental', ru: 'eHi Аренда авто' }],
    ['桐叶租车', { en: 'Tongye Car Rental', ru: 'Tongye Аренда авто' }],
    ['发呆呆租车', { en: 'Fadaidai Car Rental', ru: 'Fadaidai Аренда авто' }],
    ['奥鑫汽车租赁', { en: 'Aoxin Car Rental', ru: 'Aoxin Аренда авто' }],
    ['和胜汽车租赁', { en: 'Hesheng Car Rental', ru: 'Hesheng Аренда авто' }]
  ];

  /* 取三语字段里当前语种的值，缺该语种时回落到中文 */
  function pickText(i18n, lang, fallback) {
    if (i18n && i18n[lang]) return i18n[lang];
    if (i18n && i18n.zh) return i18n.zh;
    return fallback || '';
  }

  function areaName(name, lang) {
    var m = AREA_NAMES[name];
    if (m) return m[lang] || m.zh;
    return name || '';
  }

  function agencyName(r, lang) {
    if (!r) return '';
    if (r.names) return pickText(r.names, lang, r.name || '');
    if (lang === 'zh') return r.name || '';
    var hit = AGENCY_NAMES[r.name];
    if (hit && hit[lang]) return hit[lang];
    var brand = '';
    for (var i = 0; i < BRANDS.length; i++) {
      if (r.name && r.name.indexOf(BRANDS[i][0]) >= 0) {
        brand = BRANDS[i][1][lang] || BRANDS[i][1].en;
        break;
      }
    }
    var area = r.area ? areaName(r.area, lang) : '';
    return [brand || r.name, area].filter(function (x) { return !!x; }).join(' · ');
  }

  return {
    areas: AREA_NAMES,
    areaName: areaName,
    agencyName: agencyName,
    pickText: pickText
  };
})();
