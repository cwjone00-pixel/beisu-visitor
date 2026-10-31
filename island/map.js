/* ============================================================
   海南全岛地图 · 共享地图渲染模块
   ------------------------------------------------------------
   被地图页 index.html（查看/录入/嵌入）与内容管理页 admin.html 复用。
   数据（分类 / 点位）由外部传入，本模块不做任何固定内容硬编码。
   点位的真实经纬度只用于定位，任何展示层的「散开」都不改数据。
   ------------------------------------------------------------
   三层展示规则（只影响显示，不动数据）：
     1) 密集聚合：按当前比例尺换算，像素距离小于 COARSE_PX 的多条点位合并成
        「数字气泡」，气泡内数字为点位条数；点一下气泡即就地展开全部成员。
     2) 同位置同心圆环：完全落在同一位置的多条记录，以「多层同心嵌套圆环」同时显示，
        外径与普通单点标记一致（不放大）。每层只占一条互不重叠的同心环带
        （中空圆环 + 描边），因此与绘制顺序无关，各层颜色同时可见。
     3) 标签避让：所有文字集中在独立标签层渲染，自动在点位四周择优落位、
        互相避让不重叠，并用「引线 + 箭头」指回它原本的点位坐标。
   另有独立的地标层（landmarks，城市 / 机场这类固定参照点）：单独成系列、
   不参与上面的密集聚合，因此不会挤占或改变营地点位的展示。
   · landmark.labelOnly = true    不画图标点位，只把地名常显在图上（城市）；
   · landmark.labelMode = 'hover' 该地标的名称不进常显层，改由悬浮提示框给出（机场）；
   名称显示模式由 cfg.labelMode 控制：默认 'always'（所有名称常显）；
   传 'hover' 时只保留上面这种常显地名，其余点位名称改由鼠标悬浮时的提示框给出。
   用法：
     var map = HainanMap.create(el, { categories, points, landmarks, roam, legend, labelMode, onClick });
     map.update({ categories, points });   // 数据变更后重绘
     map.update({ landmarks });             // 地标层单独更新（如切换语种换名称）
     map.update({ haloCategory: ['sea', 'forest', 'lake'] });  // 给这些分类里每个独立点位加呼吸光晕（选中后自动撤掉，传 null 取消）
     map.setVisible('露营地', false);       // 图层显隐
     map.toggleCluster('<聚合 key>');       // 展开 / 收起某个聚合气泡
     map.focus(function(p){ ... });         // 高亮某个点位
   ============================================================ */
window.HainanMap = (function () {
  'use strict';

  var RING_NAME  = '__cluster__';   /* 圆环 / 聚合气泡系列（不进入图例） */
  var LABEL_NAME = '__labels__';    /* 标签层：引线 + 箭头 + 文字 */
  var ROUTE_NAME = '__routes__';    /* 驾车路线层（贴合公路的折线 + 距离/时长） */
  var SELECT_NAME = '__selected__'; /* 选中态高亮层（外圈色环 + 放大圆点） */
  var GROUP_TOL  = 0.002;           /* 兜底容差（度）：比例尺未算出时的同位置判定 */
  var FALLBACK_SIZE = 14;           /* 分类未配置 symbolSize 时的标记直径(px) */

  /* 行政区（市县）名称多语对照：GeoJSON 里只有中文名，鼠标悬浮到市县时
     提示框与本页高亮地名按当前语种输出（缺译的语种回落到中文）。 */
  var REGION_I18N = {
    '海口市':                 { en:'Haikou',                ru:'Хайкоу' },
    '三亚市':                 { en:'Sanya',                 ru:'Санья' },
    '儋州市':                 { en:'Danzhou',               ru:'Даньчжоу' },
    '琼海市':                 { en:'Qionghai',              ru:'Цюнхай' },
    '文昌市':                 { en:'Wenchang',              ru:'Вэньчан' },
    '万宁市':                 { en:'Wanning',               ru:'Ваньнин' },
    '东方市':                 { en:'Dongfang',              ru:'Дунфан' },
    '五指山市':               { en:'Wuzhishan',             ru:'Учжишань' },
    '定安县':                 { en:"Ding'an",               ru:'Динань' },
    '屯昌县':                 { en:'Tunchang',              ru:'Туньчан' },
    '澄迈县':                 { en:'Chengmai',              ru:'Чэнмай' },
    '临高县':                 { en:'Lingao',                ru:'Линьгао' },
    '白沙黎族自治县':         { en:'Baisha Li Autonomous County',       ru:'Байша-Лиский автономный уезд' },
    '昌江黎族自治县':         { en:'Changjiang Li Autonomous County',   ru:'Чанцзян-Лиский автономный уезд' },
    '乐东黎族自治县':         { en:'Ledong Li Autonomous County',       ru:'Лэдун-Лиский автономный уезд' },
    '陵水黎族自治县':         { en:'Lingshui Li Autonomous County',     ru:'Линшуй-Лиский автономный уезд' },
    '保亭黎族苗族自治县':     { en:'Baoting Li and Miao Autonomous County',   ru:'Баотин-Ли-Мяоский автономный уезд' },
    '琼中黎族苗族自治县':     { en:'Qiongzhong Li and Miao Autonomous County', ru:'Цюнчжун-Ли-Мяоский автономный уезд' }
  };
  /* 悬浮提示里「行政区」后缀的三语写法（与游客地图页原有文案一致） */
  var REGION_SUFFIX = { zh:' · 行政区', en:' · District', ru:' · Район' };

  /* 市县名按语种输出：查对照表；已是译文（或未收录的地名）原样返回 */
  function regionName(raw, lg) {
    var n = String(raw == null ? '' : raw);
    var t = REGION_I18N[n];
    if (t) return (lg === 'en' || lg === 'ru') ? (t[lg] || n) : n;
    return n;
  }

  /* 行政区悬浮提示整句：地名 + 语种后缀（页面自己的提示也复用这一份） */
  function areaTip(raw, lg) {
    return regionName(raw, lg) + (REGION_SUFFIX[lg] || REGION_SUFFIX.zh);
  }

  /* 是否「移动端窄屏」：手机 / 平板竖屏用 map 的容器宽度也小，
     统一按视口宽度判定（桌面浏览器与内容管理页都走不到这里）。 */
  function isCompactView() {
    try {
      return window.matchMedia('(max-width: 900px)').matches;
    } catch (e) {
      return (window.innerWidth || 0) <= 900;
    }
  }

  var COARSE_PX  = 40;              /* 密集聚合半径(px)：比它近的点位合并成气泡 */
  var COARSE_TOL = 0.02;            /* 比例尺未算出时的兜底聚合容差（度） */
  var COARSE_MAX = 0.08;            /* 聚合的「真实距离」上限（度，约 8.8km）：
                                       地图窗口很小的时候像素阈值会等于几十公里，
                                       加这道上限防止把相距很远的点位并成一颗气泡 */
  var BUBBLE_MIN = 24, BUBBLE_MAX = 44;

  /* 标签排版参数 */
  var FONT       = 'sans-serif';
  var FONT_SIZE  = 11.5;
  var LINE_H     = 14;
  var PAD_X      = 4;
  var PAD_Y      = 2.5;
  var LABEL_GAP  = 9;               /* 标签与标记之间的最小间距 */
  var ARROW_LEN  = 7;               /* 箭头长度 */
  var ARROW_HALF = 3.4;             /* 箭头半宽 */
  var SPIDER_MAX = 92;              /* 就地展开时成员铺开的最大半径 */

  /* 量文字宽度，用于标签避让（和 zrender 用同一套字体设置即可） */
  var measureCtx = document.createElement('canvas').getContext('2d');
  function textW(t, weight) {
    measureCtx.font = (weight || 600) + ' ' + FONT_SIZE + 'px ' + FONT;
    return measureCtx.measureText(t).width;
  }

  function ensureRegistered() {
    if (window.__hainanMapRegistered) return;
    if (window.HAINAN_GEO) echarts.registerMap('hainan', window.HAINAN_GEO);
    window.__hainanMapRegistered = true;
  }

  /* 取当前语种对应的地图名：中文用原始地图，英/俄在首次使用时注册一份译名副本 */
  var translatedMaps = {};
  function mapForLang(lg) {
    if (lg !== 'en' && lg !== 'ru') return 'hainan';
    var name = 'hainan-' + lg;
    if (translatedMaps[name]) return name;
    if (!window.HAINAN_GEO) return 'hainan';
    var copy = JSON.parse(JSON.stringify(window.HAINAN_GEO));
    (copy.features || []).forEach(function (f) {
      var raw = f && f.properties && f.properties.name;
      var tr = REGION_I18N[raw];
      if (tr && tr[lg]) f.properties.name = tr[lg];
    });
    echarts.registerMap(name, copy);
    translatedMaps[name] = true;
    return name;
  }

  /* 距离 / 时长的展示格式（路线标签与提示共用） */
  function fmtKm(m) {
    m = +m || 0;
    return m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m';
  }
  function fmtDur(s) {
    var min = Math.round((+s || 0) / 60);
    if (min < 60) return min + ' 分钟';
    var h = Math.floor(min / 60), r = min % 60;
    return h + ' 小时' + (r ? r + ' 分' : '');
  }

  function create(el, cfg) {
    cfg = cfg || {};
    ensureRegistered();

    var categories   = cfg.categories || [];
    var points       = cfg.points || [];
    /* 当前界面语种：只影响市县名等提示文案，点位名称由外部按语种传入 */
    var lang         = (cfg.lang === 'en' || cfg.lang === 'ru') ? cfg.lang : 'zh';
    var hidden       = {};              /* 图层显隐状态（按分类 key） */
    var legendOn     = cfg.legend !== false;
    /* 标签里是否带上「类型名」那一行。默认带（内容管理页需要）；
       游客露营地图已用图例颜色区分类型，标签再重复一遍类型名显得啰嗦，
       所以在 camp.html 里传 labelKinds:false，标签只留营地名称。 */
    var labelKinds   = cfg.labelKinds !== false;
    var legendVisible = true;           /* 录入模式下可临时隐藏图例 */
    var expanded     = {};              /* 已就地展开的聚合组 key */
    var selectedId   = null;            /* 当前选中的点位 id（高亮用，null=无选中） */
    var routes       = [];              /* 驾车路线分段（服务端规划结果） */
    /* 地标层（城市 / 机场等）：与营地点位完全分开的一组标记。
       · 单独成系列、单独出标签，画在营地点位之上；
       · 不参与密集聚合 —— 否则一个城市只要离营地够近，
         就会被并进气泡里，标签随之消失；
       · 不参与 markerSize()，营地那边的标记尺寸与标签间距保持原样。
       结构：[{ key, name, color, symbol, symbolSize, z, labelColor,
                points:[{ id, name, lng, lat }] }] */
    var landmarks    = Array.isArray(cfg.landmarks) ? cfg.landmarks : [];
    /* 名称显示模式：
       'always'（默认）—— 所有点位名称常显，地图页 / 内容管理页沿用；
       'hover' —— 只有地标里标了常显的地名（城市）常显，其余点位名称鼠标悬浮才出现。
       游客露营页用 'hover'：城市地名常显，营地与机场的名称悬浮才显示。 */
    var hoverLabels  = cfg.labelMode === 'hover';
    /* 移动端（窄屏 / 触屏）不在地图上写景点名称：手机屏幕小，十几个地名挤在一起
       既看不清又互相遮挡。此时只保留点位图标，名称交给页面底部弹卡展示。
       桌面端完全保持原有逻辑。cfg.mobileNoLabels 打开后按屏宽自动判定。 */
    var mobileNoLabels = !!cfg.mobileNoLabels && isCompactView();
    var routesVisible = true;           /* 驾车路线层显隐 */
    var hoveredRoute = null;            /* 鼠标当前悬停的路线下标（null=未悬停） */
    /* 可点击引导光晕：给某几类里「每个独立显示的点位」叠一圈缓慢呼吸的光环，
       表达「这个圆点可以点」；选中后该点位的光环自动撤掉。可传单个分类 key 或数组
       —— 露营页的营地按海边 / 雨林 / 湖畔拆成了三个分类，故传数组。null = 不加光晕。 */
    var haloCatKeys  = cfg.haloCategory ? [].concat(cfg.haloCategory) : null;

    /* 「同一位置」判定不写死经纬度，而是按当前比例尺换算：
       两次落点只要在地图上会互相遮挡（像素距离小于一个标记直径），就算同一位置，
       渲染成多层嵌套圆环 —— 从根上杜绝「标记互相覆盖、只剩一种颜色」。 */
    var tolDeg       = { lng: GROUP_TOL, lat: GROUP_TOL };
    var coarseTolDeg = { lng: COARSE_TOL, lat: COARSE_TOL };
    var scaleKnown   = false;

    var chart = echarts.init(el);

    /* 单个标记的显示直径（px），同时用作「视觉上互相遮挡」的判定阈值 */
    function markerSize() {
      var m = 0;
      categories.forEach(function (c) { m = Math.max(m, +c.symbolSize || 0); });
      return m > 0 ? m : FALLBACK_SIZE;
    }

    /* 点位类型：新格式 categories[]，兼容旧的单值 category */
    function pointCats(p) {
      if (!p) return [];
      if (Array.isArray(p.categories)) return p.categories.filter(Boolean);
      return p.category ? [p.category] : [];
    }
    function catByKey(k) {
      for (var i = 0; i < categories.length; i++) if (categories[i].key === k) return categories[i];
      return null;
    }
    function catName(k) { var c = catByKey(k); return c ? c.name : k; }
    function catColor(k) { var c = catByKey(k); return (c && c.color) || '#334155'; }
    /* 组装标签的文字行：labelKinds 关掉时不要类型名那一行；
       万一因此一行都不剩（点位没填名称），仍回落到类型名，避免标签凭空消失。 */
    function labelLines(kindText, kindColor, rest) {
      var lines = [];
      if (labelKinds) lines.push({ text: kindText, color: kindColor, weight: 700 });
      lines = lines.concat(rest || []);
      if (!lines.length) lines.push({ text: kindText, color: kindColor, weight: 700 });
      return lines;
    }
    function catByName(n) {
      for (var i = 0; i < categories.length; i++) if (categories[i].name === n) return categories[i];
      return null;
    }

    /* 注意：坐标系尚未就绪时 convertToPixel/convertFromPixel 会「抛异常」而不是返回空值，
       所以这里必须 try/catch —— 否则首帧绘制会直接中断，整张图变成空白。 */
    function toPixel(lng, lat) {
      var v;
      try { v = chart.convertToPixel({ geoIndex: 0 }, [lng, lat]); } catch (e) { return null; }
      return (v && isFinite(v[0]) && isFinite(v[1])) ? v : null;
    }
    function toGeo(px) {
      var v;
      try { v = chart.convertFromPixel({ geoIndex: 0 }, px); } catch (e) { return null; }
      return (v && isFinite(v[0]) && isFinite(v[1])) ? v : null;
    }

    /* ---------- 可见条目：每个「点位 × 已启用类型」一条 ---------- */
    function visibleEntries() {
      var out = [];
      points.forEach(function (p) {
        pointCats(p).forEach(function (k) {
          if (hidden[k] || !catByKey(k)) return;      /* 隐藏的图层不参与 */
          out.push({ catKey: k, pointId: p.id, lng: +p.lng, lat: +p.lat, raw: p });
        });
      });
      return out;
    }

    /* 按点位归并（一个点位一条，携带它所有可见类型条目） */
    function pointList() {
      var byId = {};
      visibleEntries().forEach(function (e) {
        var g = byId[e.pointId];
        if (!g) {
          g = byId[e.pointId] = { pointId: e.pointId, lng: e.lng, lat: e.lat, raw: e.raw, entries: [] };
        }
        g.entries.push(e);
      });
      return Object.keys(byId).map(function (k) { return byId[k]; });
    }

    /* ---------- 第一层：密集聚合（像素距离 + 真实距离上限） ---------- */
    function coarseGroups() {
      var list = pointList(), groups = [];
      list.forEach(function (p) {
        p.px = toPixel(p.lng, p.lat);
        var hit = null;
        for (var i = 0; i < groups.length; i++) {
          var g = groups[i];
          if (g.px && p.px) {
            var dx = g.px[0] - p.px[0], dy = g.px[1] - p.px[1];
            if (Math.sqrt(dx * dx + dy * dy) <= COARSE_PX &&
                Math.abs(g.lng - p.lng) <= COARSE_MAX &&
                Math.abs(g.lat - p.lat) <= COARSE_MAX) { hit = g; break; }
          } else if (Math.abs(g.lng - p.lng) <= coarseTolDeg.lng &&
                     Math.abs(g.lat - p.lat) <= coarseTolDeg.lat) { hit = g; break; }
        }
        if (!hit) {
          hit = { key: p.lng.toFixed(4) + ',' + p.lat.toFixed(4), lng: p.lng, lat: p.lat, px: p.px, points: [] };
          groups.push(hit);
        }
        hit.points.push(p);
      });
      /* 气泡/蛛网锚点取成员重心：避免气泡正好压在其中一个成员身上，位置更有代表性 */
      groups.forEach(function (g) {
        var n = g.points.length;
        if (n < 2) return;
        var sl = 0, sa = 0, sx = 0, sy = 0, allPx = !!g.px;
        g.points.forEach(function (p) {
          sl += p.lng; sa += p.lat;
          if (p.px) { sx += p.px[0]; sy += p.px[1]; } else { allPx = false; }
        });
        g.cLng = sl / n; g.cLat = sa / n;
        if (allPx) { g.cPx = sx / n; g.cPy = sy / n; }
      });
      return groups;
    }

    /* 组内所有点位是否完全叠在同一处（这种走同心圆环，不合并成气泡） */
    function sameSpot(pts) {
      if (pts.length < 2) return true;
      var a = pts[0].px, tol = markerSize();
      for (var i = 1; i < pts.length; i++) {
        var b = pts[i].px;
        if (a && b) {
          var dx = a[0] - b[0], dy = a[1] - b[1];
          if (Math.sqrt(dx * dx + dy * dy) > tol) return false;
        } else if (Math.abs(pts[0].lng - pts[i].lng) > tolDeg.lng ||
                   Math.abs(pts[0].lat - pts[i].lat) > tolDeg.lat) return false;
      }
      return true;
    }

    /* ---------- 标记构造 ---------- */

    /* 数字气泡：合并成一条，中心实心圆 + 数字，双色时按比例拼色 */
    function pushBubble(g, markers, labels) {
      var tally = {}, order = [];
      g.points.forEach(function (p) {
        p.entries.forEach(function (e) {
          if (tally[e.catKey] == null) { tally[e.catKey] = 0; order.push(e.catKey); }
          tally[e.catKey]++;
        });
      });
      var n = g.points.length;
      var size = Math.min(BUBBLE_MAX, BUBBLE_MIN + Math.max(0, n - 2) * 1.8);
      var ax = (g.cLng != null) ? g.cLng : g.lng;    /* 锚点：成员重心 */
      var ay = (g.cLat != null) ? g.cLat : g.lat;
      var keys = order, color;
      if (keys.length === 1) {
        color = catColor(keys[0]);
      } else {
        /* 多种类型混在一个气泡里：按条数比例做双色渐变，蓝黄一眼可辨 */
        var total = 0; keys.forEach(function (k) { total += tally[k]; });
        var acc = 0, stops = [];
        keys.forEach(function (k, i) {
          stops.push({ offset: acc / total, color: catColor(k) });
          acc += tally[k];
          stops.push({ offset: acc / total, color: catColor(k) });
        });
        color = { type: 'linear', x: 0, y: 0, x2: 1, y2: 1, colorStops: stops };
      }
      var members = [];
      g.points.forEach(function (p) {
        p.entries.forEach(function (e) {
          members.push({ pointId: e.pointId, catKey: e.catKey, name: (e.raw && e.raw.name) || '' });
        });
      });
      var kinds = [];
      keys.forEach(function (k) { kinds.push(catName(k)); });

      markers.push({
        kind: 'bubble',
        name: '__bubble__',
        value: [ax, ay],
        cluster: true, groupKey: g.key, count: n,
        kinds: kinds, tally: tally, members: members,
        raw: null, pointId: g.points[0].pointId,
        symbolSize: size,
        itemStyle: {
          color: color, borderColor: '#fff', borderWidth: 2,
          shadowBlur: 10, shadowColor: 'rgba(20,40,80,.32)'
        },
        label: {
          show: true, position: 'inside', formatter: String(n),
          color: '#fff', fontSize: 12.5, fontWeight: 700
        }
      });

      /* 气泡旁一行：分类 + 条数，颜色跟分类一致（蓝露营地 / 黄打卡点） */
      labels.push({
        tip: [ax, ay],
        markerR: size / 2,
        lines: keys.map(function (k) {
          return { text: catName(k) + ' ' + tally[k], color: catColor(k), weight: 700 };
        })
      });
      return g.points;
    }

    /* 同心圆环（同位置多条记录）+ 单点 */
    function pushSpotways(pts, markers, labels) {
      var entries = [];
      pts.forEach(function (p) { entries = entries.concat(p.entries); });
      var lng = pts[0].lng, lat = pts[0].lat;

      if (entries.length === 1) {
        var e = entries[0], place = (e.raw && e.raw.name) || '';
        var info = {
          name: catName(e.catKey), value: [lng, lat],
          place: place, raw: e.raw, catKey: e.catKey, pointId: e.pointId
        };
        markers.push({
          kind: 'dot', name: info.name, value: info.value,
          place: place, raw: e.raw, catKey: e.catKey, pointId: e.pointId,
          label: { show: false }
        });
        var placeLines = [];
        if (place) placeLines.push({ text: place, color: '#1f2d3d', weight: 600 });
        /* hover 模式下名称改由标记的 emphasis 负责（悬浮才出现），这里不再常显 */
        if (!hoverLabels) {
          labels.push({
            tip: [lng, lat], markerR: markerSize() / 2,
            lines: labelLines(catName(e.catKey), catColor(e.catKey), placeLines)
          });
        }
        return;
      }

      /* 完全同位置的多条：多层同心嵌套圆环，外径与单点一致（不放大）
         总半径 R = D/2，环带宽 w = R/n；第 i 层占半径带 [i*w,(i+1)*w]。
         圆环用「中空 + 描边」实现：symbolSize 取环带中线直径 (2i+1)*w，
         borderWidth = w 时描边恰好落在 [i*w,(i+1)*w]，与相邻层不重叠，
         因此与绘制顺序无关，各层颜色同时可见。 */
      var n = entries.length, D = markerSize(), w = D / (2 * n);
      var kinds = entries.map(function (x) { return catName(x.catKey); });
      var labeled = entries.map(function (x) {
        var cn = catName(x.catKey);
        return (x.raw && x.raw.name) ? cn + ' · ' + x.raw.name : cn;
      });
      var members = entries.map(function (x) {
        return { pointId: x.pointId, catKey: x.catKey, name: (x.raw && x.raw.name) || '' };
      });
      var base = {
        cluster: true, groupKey: 'ring:' + lng.toFixed(4) + ',' + lat.toFixed(4),
        count: n, kinds: kinds, labels: labeled, members: members, raw: null
      };
      for (var i = 0; i < n; i++) {
        var x = entries[i], color = catColor(x.catKey);
        markers.push({
          kind: 'ring', name: catName(x.catKey), value: [lng, lat], layer: i,
          cluster: true, groupKey: base.groupKey, count: n,
          kinds: kinds, labels: labeled, members: members,
          catKey: x.catKey, pointId: x.pointId, raw: null,
          symbolSize: i === 0 ? 2 * w : (2 * i + 1) * w,
          itemStyle: i === 0
            ? { color: color, borderWidth: 0 }
            : { color: 'transparent', borderColor: color, borderWidth: w },
          label: { show: false }
        });
      }
      /* 最外沿一圈白色细边，内沿贴着色带外侧，整体外径贴近普通单点 */
      markers.push({
        kind: 'ring', name: '__halo__', value: [lng, lat], layer: -1,
        cluster: true, groupKey: base.groupKey, count: n,
        kinds: kinds, labels: labeled, members: members,
        catKey: entries[0].catKey, pointId: entries[0].pointId,
        raw: null, silent: true,
        symbolSize: D + 1.5,
        itemStyle: { color: 'transparent', borderColor: '#ffffff', borderWidth: 1.5, shadowBlur: 8 },
        label: { show: false }
      });

      /* 同位置多条：分类名一行（用中性色），每个地名各占一行、按自己的分类上色。
         合成一行会特别宽、容易和邻居撞车；拆行后更窄，也更容易分辨谁是谁。 */
      var multiLines = [];
      entries.forEach(function (x) {
        var nm = (x.raw && x.raw.name) || '';
        if (nm) multiLines.push({ text: nm, color: catColor(x.catKey), weight: 600 });
      });
      /* hover 模式下不常显（悬浮时看标记的 emphasis 标签） */
      if (!hoverLabels) {
        labels.push({
          tip: [lng, lat], markerR: D / 2,
          lines: labelLines(kinds.join(' / '), '#5b6675', multiLines)
        });
      }
    }

    /* 就地展开：成员沿一圈铺开，各自画引线指回真实坐标（不改数据）
       善后：中心留一个空心小环，再点一次收起。 */
    function pushSpider(g, markers, labels) {
      var n = g.points.length;
      var c = (g.cPx != null) ? [g.cPx, g.cPy] : (g.px || toPixel(g.lng, g.lat));
      if (!c) return pushSpotways(g.points, markers, labels);
      var ax = (g.cLng != null) ? g.cLng : g.lng;
      var ay = (g.cLat != null) ? g.cLat : g.lat;
      var R = Math.min(SPIDER_MAX, Math.max(34, 11 * n));

      g.points.forEach(function (p, i) {
        var a = -Math.PI / 2 + i * (2 * Math.PI / n);
        var px = [c[0] + R * Math.cos(a), c[1] + R * Math.sin(a)];
        var geo = toGeo(px) || [p.lng, p.lat];
        var e = p.entries[0], place = (e.raw && e.raw.name) || '';

        markers.push({
          kind: 'spider', name: catName(e.catKey), value: [p.lng, p.lat],
          place: place, raw: p.raw, catKey: e.catKey, pointId: p.pointId,
          spider: [geo[0], geo[1]],
          symbolSize: 11,
          itemStyle: { color: catColor(e.catKey), borderColor: '#fff', borderWidth: 1.5, shadowBlur: 6 },
          label: { show: false }
        });
        /* 铺开的点 → 真实坐标 的引线（箭头指回真实位置） */
        labels.push({ tip: [p.lng, p.lat], from: [geo[0], geo[1]], markerR: 5, lines: [] });

        var types = p.entries.map(function (x) { return catName(x.catKey); });
        var spiderLines = [];
        if (place) spiderLines.push({ text: place, color: '#1f2d3d', weight: 600 });
        labels.push({
          tip: [geo[0], geo[1]], markerR: 6,
          lines: labelLines(types.join(' / '), catColor(e.catKey), spiderLines)
        });
      });

      /* 收起按钮：中心空心小环 */
      markers.push({
        kind: 'collapse', name: '__collapse__', value: [ax, ay],
        cluster: true, groupKey: g.key, count: n, collapse: true,
        symbolSize: 18,
        itemStyle: { color: 'rgba(255,255,255,.92)', borderColor: '#7c8aa0', borderWidth: 1.5, borderType: 'dashed' },
        label: { show: true, position: 'inside', formatter: '\u2212', color: '#7c8aa0', fontSize: 12, fontWeight: 700 }
      });
    }

    /* ---------- 组装渲染计划 ---------- */
    function buildPlan() {
      var markers = [], labels = [];
      /* 移动端：景点名称一律不画在地图上（只留图标），名称在页面底部弹卡里展示。
         桌面端 labels 照旧参与避让排版。 */
      var spotLabels = !mobileNoLabels;
      /* 移动端用一个「丢弃式」收集器替代真正的标签数组：
         各处 push 的景点名称直接丢掉，其余渲染逻辑与桌面端完全一致。 */
      var sink = spotLabels ? labels : { push: function () {} };
      coarseGroups().forEach(function (g) {
        var dense = g.points.length >= 2 && !sameSpot(g.points);
        if (dense && !expanded[g.key])    return void pushBubble(g, markers, sink);
        if (dense && expanded[g.key])     return void pushSpider(g, markers, sink);
        pushSpotways(g.points, markers, sink);
      });
      /* 地标标签：只有「常显型」地标（城市）在这里出常显地名，和营地标签一起参与避让；
         「悬浮型」地标（机场）的名称由标记自己的 emphasis 负责，默认不占版面。
         移动端同样不出——地名在手机上会把图面糊满。 */
      if (spotLabels) landmarks.forEach(function (g) {
        if (g.labelMode === 'hover') return;
        (g.points || []).forEach(function (p) {
          if (!p.name) return;
          labels.push({
            tip: [p.lng, p.lat],
            markerR: g.labelOnly ? 0 : (+g.symbolSize || 16) / 2 + 2,
            noLeader: !!g.labelOnly,      /* 没有图标点位，就不画引线箭头 */
            lines: [{ text: p.name, color: g.labelColor || '#1f2d3d', weight: 700 }]
          });
        });
      });
      return { markers: markers, labels: labels.concat(routeLabelItems()) };
    }

    /* ---------- 标签避让排版 ---------- */
    /* 每个标签在点位四周试一圈候选落位，取第一个既不出画布、也不与其它标签重叠、
       也不盖住其它标记点的位置。候选按「近→远、上方优先」排序，所以标签总是
       尽量贴着自己的点位；实在挤不下才往外挪，靠引线 + 箭头指回真实坐标。
       全部候选都冲突时取代价最小的那个，保证任何一条文字都不会被丢掉。 */
    function layoutLabels(items, extraDots) {
      /* 画布尺寸：标签必须整块留在画布内，否则贴边的文字会被裁掉看不清 */
      var W = chart.getWidth() || 0, H = chart.getHeight() || 0;
      var EDGE = 2;

      items.forEach(function (it) { it._px = toPixel(it.tip[0], it.tip[1]); });
      var dots = [];
      items.forEach(function (it) { if (it._px) dots.push(it._px); });
      /* 隐去名称的点位（悬浮模式下只有它被选中时才出字）自己不在 items 里，
         但它的图标仍在地图上，标签同样不许压住它 —— 补进来一起参与避让。
         与已有锚点重合的位置跳过，避免同一个点被重复计罚分。 */
      (extraDots || []).forEach(function (p) {
        if (!p) return;
        for (var i = 0; i < dots.length; i++) {
          if (Math.abs(dots[i][0] - p[0]) < 0.5 && Math.abs(dots[i][1] - p[1]) < 0.5) return;
        }
        dots.push(p);
      });

      var idx = [];
      items.forEach(function (it, i) {
        if (!it.lines || !it.lines.length) { it.dx = 0; it.dy = 0; return; }
        var w = 0;
        it.lines.forEach(function (ln) { w = Math.max(w, textW(ln.text, ln.weight)); });
        it._w = Math.ceil(w) + PAD_X * 2;
        it._h = it.lines.length * LINE_H + PAD_Y * 2;
        idx.push(i);
      });

      /* 密集区先占位：周围标记点多的标签先放，稀疏区的后放、给它们让路 */
      function crowd(it) {
        var p = it._px; if (!p) return -1;
        var n = 0;
        for (var i = 0; i < dots.length; i++) {
          var dx = dots[i][0] - p[0], dy = dots[i][1] - p[1];
          if (dx * dx + dy * dy < 130 * 130) n++;
        }
        return n;
      }
      idx.sort(function (a, b) {
        var A = items[a], B = items[b];
        if (!A._px) return 1;
        if (!B._px) return -1;
        return (crowd(B) - crowd(A)) || (A._px[1] - B._px[1]) || (A._px[0] - B._px[0]);
      });

      /* 候选偏移：7 圈 × 8 方向。圈够密才排得开，窗口很窄时也能给每个标签
         找到一块空地（宁可引线拉长一点，也不让两条文字叠在一起）。 */
      var ANG = [0, -0.7, 0.7, -Math.PI / 2, Math.PI / 2, -2.3, 2.3, Math.PI];
      var RINGS = [1, 1.35, 1.75, 2.2, 2.75, 3.4, 4.2];
      function candsFor(it) {
        var r = (it.markerR || 6) + LABEL_GAP;
        var hx = r + it._w / 2, hy = r + it._h / 2, out = [];
        RINGS.forEach(function (k) {
          ANG.forEach(function (a) { out.push([Math.cos(a) * hx * k, Math.sin(a) * hy * k]); });
        });
        return out;
      }

      function bestFor(it, obstacles) {
        var p = it._px, w = it._w, h = it._h;
        if (!p) return { dx: 0, dy: 0, rect: null, score: 0 };
        var cands = candsFor(it), best = null, bestScore = Infinity;
        for (var k = 0; k < cands.length; k++) {
          var cx = p[0] + cands[k][0], cy = p[1] + cands[k][1];
          var rect = { x: cx - w / 2, y: cy - h / 2, w: w, h: h };
          /* 注意：这里不裁剪，让 clashScore 里的「出画布」罚分生效，
             从而优先选留在画布内的候选；裁剪只作为最后兜底（见 clampTo）。 */
          var sc = clashScore(rect, obstacles, dots, W, H, EDGE);
          if (sc <= 0) return { dx: cands[k][0], dy: cands[k][1], rect: rect, score: 0 };
          if (sc < bestScore) { bestScore = sc; best = { dx: cands[k][0], dy: cands[k][1], rect: rect, score: sc }; }
        }
        return best;
      }

      /* 兜底：候选全都出界时，把整块框拉回画布内（引线会自动重新连到框边） */
      function clampTo(it, r) {
        if (!r.rect || !(W > 0 && H > 0) || !it._px) return r;
        var p = it._px, w = it._w, h = it._h;
        var lox = EDGE + w / 2, hix = W - EDGE - w / 2;
        var loy = EDGE + h / 2, hiy = H - EDGE - h / 2;
        if (hix < lox) { lox = hix = W / 2; }
        if (hiy < loy) { loy = hiy = H / 2; }
        var cxc = Math.min(Math.max(p[0] + r.dx, lox), hix);
        var cyc = Math.min(Math.max(p[1] + r.dy, loy), hiy);
        return {
          dx: cxc - p[0], dy: cyc - p[1],
          rect: { x: cxc - w / 2, y: cyc - h / 2, w: w, h: h },
          score: r.score
        };
      }

      var rects = {};
      idx.forEach(function (i) {
        var it = items[i];
        var r = clampTo(it, bestFor(it, idx.filter(function (j) { return rects[j]; }).map(function (j) { return rects[j]; })));
        rects[i] = r.rect || { x: -9999, y: -9999, w: 0, h: 0, score: 0 };
        rects[i].score = r.score;
        it.dx = r.dx; it.dy = r.dy;
      });

      /* 精修：把仍有冲突的标签挪到更空的位置（最多 6 轮，无改善就停） */
      function rectsOf(except) {
        var out = [];
        idx.forEach(function (j) { if (j !== except && rects[j]) out.push(rects[j]); });
        return out;
      }
      for (var pass = 0; pass < 6; pass++) {
        var order = idx.slice().sort(function (a, b) { return (rects[b].score || 0) - (rects[a].score || 0); });
        var moved = 0, worst = 0;
        order.forEach(function (i) {
          var cur = rects[i];
          worst = Math.max(worst, cur.score || 0);
          if (!cur.score) return;
          var r = clampTo(items[i], bestFor(items[i], rectsOf(i)));
          if (r.score < cur.score) {
            rects[i] = r.rect || cur;
            rects[i].score = r.score;
            items[i].dx = r.dx; items[i].dy = r.dy;
            moved++;
          }
        });
        if (!moved || worst <= 0) break;
      }
    }

    function clashScore(rect, placed, dots, W, H, EDGE) {
      var score = 0, i, ox, oy;
      for (i = 0; i < placed.length; i++) {
        var b = placed[i];
        ox = Math.min(rect.x + rect.w, b.x + b.w) - Math.max(rect.x, b.x);
        oy = Math.min(rect.y + rect.h, b.y + b.h) - Math.max(rect.y, b.y);
        if (ox > -3 && oy > -3) score += (ox + 3) * (oy + 3);
      }
      /* 也不要把别的标记点盖住 */
      for (i = 0; i < dots.length; i++) {
        var d = dots[i];
        if (d[0] > rect.x - 5 && d[0] < rect.x + rect.w + 5 &&
            d[1] > rect.y - 5 && d[1] < rect.y + rect.h + 5) score += 260;
      }
      /* 超出画布的部分重罚：文字被裁掉比盖住一个点更影响阅读 */
      if (W > 0 && H > 0) {
        var over = 0;
        over += Math.max(0, EDGE - rect.x);
        over += Math.max(0, (rect.x + rect.w) - (W - EDGE));
        over += Math.max(0, EDGE - rect.y);
        over += Math.max(0, (rect.y + rect.h) - (H - EDGE));
        score += over * 90;
      }
      return score;
    }

    /* ---------- 标签层：引线 + 箭头 + 文字 ---------- */
    function leader(children, from, to, markerR) {
      var vx = to[0] - from[0], vy = to[1] - from[1];
      var len = Math.sqrt(vx * vx + vy * vy);
      if (len < 3) return;
      var ux = vx / len, uy = vy / len;
      var back = (markerR || 0) + 3.6;              /* 箭头尖端离点位中心 */
      var tx = to[0] - ux * back, ty = to[1] - uy * back;
      children.push({
        type: 'polyline',
        shape: { points: [[from[0], from[1]], [tx, ty]] },
        style: { stroke: '#8697ad', lineWidth: 1.1, fill: 'none' }
      });
      var bx = tx - ux * ARROW_LEN, by = ty - uy * ARROW_LEN;
      var px = -uy, py = ux;
      children.push({
        type: 'polygon',
        shape: {
          points: [[tx, ty],
                   [bx + px * ARROW_HALF, by + py * ARROW_HALF],
                   [bx - px * ARROW_HALF, by - py * ARROW_HALF]]
        },
        style: { fill: '#8697ad' }
      });
    }

    /* 标签层当前的数据项（按 dataIndex 与 ECharts 回调对齐）。
       注意：ECharts 回调里 params.data / api.coord 在部分版本/坐标系下取不到值，
       所以这里不依赖它们 —— 项目自己按 dataIndex 取，坐标自己用 toPixel 换算。 */
    var labelItems = [];

    function renderLabel(params) {
      var i = params && params.dataIndex;
      var it = (i != null) ? labelItems[i] : null;
      if (!it && params && params.data) it = params.data;

      var children = [];
      var out = { type: 'group', children: children };
      if (!it || !it.tip) return out;
      var tip = toPixel(it.tip[0], it.tip[1]);
      if (!tip) return out;

      /* 纯引线（就地展开时：铺开的点 → 真实坐标） */
      if (it.from) {
        var f = toPixel(it.from[0], it.from[1]);
        if (f) leader(children, f, tip, it.markerR || 5);
        return out;
      }
      if (!it.lines || !it.lines.length) return out;

      var w = it._w || 0, h = it._h || 0;
      if (w <= 0 || h <= 0) return out;
      var cx = tip[0] + (it.dx || 0), cy = tip[1] + (it.dy || 0);
      var x0 = cx - w / 2, y0 = cy - h / 2;

      /* 引线起点取标签框上离点位最近的一点，避免线穿过文字 */
      var ax = Math.min(Math.max(tip[0], x0), x0 + w);
      var ay = Math.min(Math.max(tip[1], y0), y0 + h);
      if (!it.noLeader) leader(children, [ax, ay], tip, it.markerR || 6);

      children.push({
        type: 'rect',
        shape: { x: x0, y: y0, width: w, height: h, r: 5 },
        style: it.hot
          ? { fill: 'rgba(255,247,242,.97)', stroke: 'rgba(255,110,50,.9)', lineWidth: 1.6 }
          : { fill: 'rgba(255,255,255,.9)', stroke: 'rgba(130,150,180,.35)', lineWidth: 1 }
      });
      it.lines.forEach(function (ln, k) {
        children.push({
          type: 'text',
          style: {
            x: x0 + PAD_X,
            y: y0 + PAD_Y + k * LINE_H + LINE_H / 2,
            text: ln.text,
            fill: ln.color,
            font: (ln.weight || 600) + ' ' + FONT_SIZE + 'px ' + FONT,
            textAlign: 'left',
            textVerticalAlign: 'middle',
            stroke: '#ffffff',
            lineWidth: 2.5
          }
        });
      });
      return out;
    }

    /* ---------- 组装系列 ---------- */
    /* 驾车路线层：每段一条折线（由高德返回的 step.polyline 拼接而成，贴合真实公路）。
       注意：ECharts 5 的 lines 系列不渲染 label，里程标签改走下面的自定义标签层。
       z 低于点位标记，保证标记与标签始终压在线之上。 */
    function buildRouteSeries() {
      if (!routesVisible || !routes.length) return [];
      return [{
        id: ROUTE_NAME,
        name: ROUTE_NAME,
        type: 'lines',
        coordinateSystem: 'geo',
        polyline: true,
        z: 3,
        lineStyle: { color: '#ff6a3d', width: 2.6, opacity: .85, curveness: 0 },
        emphasis: { lineStyle: { width: 4.5, opacity: 1 } },
        data: routes.map(function (lg, i) {
          var d = {
            kind: 'route',
            coords: lg.polyline || [],
            index: lg.index || (i + 1),
            from: lg.from || null,
            to: lg.to || null,
            distance: +lg.distance || 0,
            duration: +lg.duration || 0
          };
          /* 悬停的那一条加重描边，让「当前看的是哪一段」一目了然 */
          if (i === hoveredRoute) d.lineStyle = { color: '#ff4d1a', width: 4.2, opacity: 1 };
          return d;
        })
      }];
    }

    /* 每段路线的「距离 · 预计时长」标签：默认一张都不画（31 段全铺出来太杂乱）；
       只有鼠标悬停到某一条路线上时，才临时为这一段生成标签，移开即消失。
       数据本身始终保留在 routes / 后台 routes.json 里，只是不常显。 */
    function routeLabelItems() {
      if (!routesVisible || !routes.length) return [];
      if (hoveredRoute == null || !routes[hoveredRoute]) return [];
      var lg = routes[hoveredRoute];
      var pts = lg.polyline || [];
      if (pts.length < 2) return [];
      var mid = pts[Math.floor(pts.length / 2)];
      var lines = [{
        text: (lg.index || (hoveredRoute + 1)) + ') ' + fmtKm(lg.distance) + ' · ' + fmtDur(lg.duration),
        color: '#c2400f', weight: 700
      }];
      if (lg.from || lg.to) {
        lines.push({
          text: ((lg.from && lg.from.name) || '起点') + ' → ' + ((lg.to && lg.to.name) || '终点'),
          color: '#6b7c93', weight: 500
        });
      }
      return [{ tip: [mid[0], mid[1]], markerR: 5, noLeader: true, hot: true, lines: lines }];
    }

    function buildSeries(plan) {
      var byCat = {};
      categories.forEach(function (c) { byCat[c.key] = []; });
      var ringData = [];

      plan.markers.forEach(function (m) {
        if (m.kind === 'dot') byCat[m.catKey].push(m);
        else                  ringData.push(m);
      });

      var series = buildRouteSeries().concat(categories.map(function (cat) {
        return {
          name: cat.name,
          type: 'scatter',
          coordinateSystem: 'geo',
          symbol: cat.symbol || 'circle',
          symbolSize: cat.symbolSize || 14,
          itemStyle: {
            color: cat.color || '#2f6fed',
            /* 描边 / 投影允许分类自己覆盖（不传就是原来的默认值）——
               露营第二个子页把「已选打卡点」这一层画成粗白描边的高亮徽章，
               与只有 1.5px 细描边的普通黄点明确分开。 */
            borderColor: cat.borderColor || '#fff',
            borderWidth: cat.borderWidth == null ? 1.5 : cat.borderWidth,
            shadowBlur: cat.shadowBlur == null ? 8 : cat.shadowBlur,
            shadowColor: cat.shadowColor || 'rgba(20,40,80,.28)'
          },
          label: { show: false },        /* 常显文字统一走独立标签层，避免与引线脱节 */
          emphasis: { scale: 1.35 },
          z: cat.z || 10,
          data: byCat[cat.key]
        };
      }));

      /* 可点击引导光晕：给这些分类里「独立显示」的每个点位都叠一圈缓慢呼吸的光环，
         表达「这个圆点可以点」；一旦某个点位被选中，它的光环就撤掉，
         改由 __selected__ 系列画固定高亮标记 —— 待点击 / 已选中两种状态一眼可分。
         被聚合成气泡的不加（那个位置由气泡代表，套光环会显得突兀且点不到具体营地）。
         · 用 echarts 自带的 effectScatter 涟漪实现，自动跟随缩放 / 拖动，无需逐帧重算；
         · silent = true 不响应鼠标，绝不会抢走点位的点击；
         · z 比标记低一层，光环从标记下方透出，不遮挡图标本身；
         · 颜色取该分类自己的颜色 —— 页面底色是浅蓝，白光环会糊在背景里看不见。 */
      if (haloCatKeys && haloCatKeys.length) {
        /* 按分类分桶：一个 effectScatter 系列只能有一个颜色，
           而营地按海边 / 雨林 / 湖畔各有一色，所以每类各出一个光晕系列。 */
        var haloByCat = {}, haloSeen = {};
        plan.markers.forEach(function (m) {
          /* 独立圆点直接加；几条坐标挨得太近的点位会被画成「多层同心圆环」，
             这时的 layer 0 标记代表整个环组 —— 按「组」补一次光晕，
             否则这些挨在一起的点位就成了唯一没有「可点击」暗示的漏网之鱼。 */
          var isGroup = (m.kind === 'ring' && m.layer === 0);
          if (m.kind !== 'dot' && !isGroup) return;
          if (haloCatKeys.indexOf(m.catKey) < 0) return;
          if (m.pointId && m.pointId === selectedId) return;         /* 已选中：改由 __selected__ 系列画固定高亮标记 */
          var key = m.value[0].toFixed(6) + ',' + m.value[1].toFixed(6);
          if (haloSeen[key]) return;                                 /* 同一位置只留一圈，不重复叠 */
          haloSeen[key] = true;
          (haloByCat[m.catKey] = haloByCat[m.catKey] || []).push({ name: '', value: m.value });
        });
        categories.forEach(function (cat) {
          var data = haloByCat[cat.key];
          if (!data || !data.length) return;
          series.push({
            name: '__halo__' + cat.key,       /* 内部系列（__ 前缀不进图例），不参与点击判定 */
            type: 'effectScatter',
            coordinateSystem: 'geo',
            symbol: 'circle',
            symbolSize: markerSize() * 1.5,
            silent: true,
            /* 光晕取该分类自己的颜色 —— 页面底色是浅蓝，白光环会糊在背景里看不见，
               同色光环则像是这个圆点自带的辉光。
               opacity 压到 0.55：让它读起来是「一圈柔光」而不是「一个实心环」，
               与选中态那圈不透明的粗高亮环在质感上也拉开距离。 */
            itemStyle: { color: cat.color || '#2f6fed', opacity: 0.55 },
            /* number 1 = 屏幕上只留一圈：光圈缓缓放大、淡出，再重新开始，
               像一次安静的呼吸。默认的 3 圈叠在一起会像雷达扫描靶，显得急躁。
               scale 收得比较紧（22.5 → 38px）—— 选中的固定高亮环是 45px 的粗环，
               若光晕也能扩到同样大，静止的一瞬间两者就分不清了。 */
            rippleEffect: { period: 4.5, scale: 1.7, brushType: 'stroke', number: 1 },
            showEffectOn: 'render',
            z: (cat.z || 10) - 1,             /* 压在标记下面，光圈从圆点下方透出，不遮图标 */
            data: data
          });
        });
      }

      /* 地标层（城市 / 机场）：图标与配色由配置决定，画在营地点位之上（z 更大），点击照常触发 onClick。
         · labelOnly（城市）不画图标点位 —— 城市是面状地名，用点标记不贴切，
           它的地名由上面的标签层常显；
         · 其余地标（机场）图标常显，名称与营地点位一样，鼠标悬浮时由提示框给出。 */
      landmarks.forEach(function (g) {
        if (g.labelOnly) return;
        series.push({
          name: g.name || g.key,
          type: 'scatter',
          coordinateSystem: 'geo',
          symbol: g.symbol || 'diamond',
          symbolSize: +g.symbolSize || 16,
          itemStyle: {
            color: g.color || '#7b4bc4',
            borderColor: '#fff',
            borderWidth: 2,
            shadowBlur: 9,
            shadowColor: 'rgba(20,40,80,.3)'
          },
          label: { show: false },
          emphasis: { scale: 1.3 },
          z: +g.z || 16,
          data: (g.points || []).map(function (p) {
            return {
              name: g.name || '', value: [p.lng, p.lat],
              place: p.name, raw: p, catKey: g.key, pointId: p.id,
              landmark: true, label: { show: false }
            };
          })
        });
      });

      series.push({
        name: RING_NAME,
        type: 'scatter',
        coordinateSystem: 'geo',
        symbol: 'circle',
        symbolSize: FALLBACK_SIZE,
        itemStyle: { borderColor: '#ffffff', shadowColor: 'rgba(20,40,80,.35)' },
        label: { show: true },
        emphasis: { scale: 1 },
        z: 40,
        data: ringData
      });

      var sel = buildSelectSeries(plan);
      if (sel) series.push(sel);

      series.push({
        id: LABEL_NAME,
        name: LABEL_NAME,
        type: 'custom',
        coordinateSystem: 'geo',
        silent: true,                    /* 标签只做展示，不抢点位/气泡的点击 */
        z: 90,
        renderItem: renderLabel,
        data: labelData(plan.labels)
      });

      return series;
    }

    /* ---------- 选中态高亮 ----------
       在当前选中的点位「原位置」上叠一层高亮：外圈色环 + 放大圆点。
       独立成系列、silent（不抢点击、不进图例），既不参与聚合/避让，
       也不改动任何其它系列 —— 因此未选中点位与地图其它功能完全保持原样。 */
    function dotSizeOf(m) {
      if (m && +m.symbolSize) return +m.symbolSize;        /* 气泡 / 圆环 / 铺开的点自带尺寸 */
      var c = (m && m.catKey) ? catByKey(m.catKey) : null; /* 普通单点用所属分类的尺寸 */
      return (c && +c.symbolSize) || markerSize();
    }
    /* 找到选中点位当前渲染成的那个标记（聚合组内 / 同位置同心环都能定位） */
    function selectedMarker(plan) {
      if (!selectedId) return null;
      var hit = null;
      plan.markers.forEach(function (m) {
        if (hit) return;
        if (m.pointId === selectedId) { hit = m; return; }
        if (m.members) {
          for (var i = 0; i < m.members.length; i++) {
            if (m.members[i].pointId === selectedId) { hit = m; return; }
          }
        }
      });
      return hit;
    }
    function buildSelectSeries(plan) {
      if (!selectedId) return null;

      var pos = null, base = 0, color = '#2f6fed', solid = false;

      var m = selectedMarker(plan);
      if (m) {
        pos   = (m.kind === 'spider' && m.spider) ? m.spider : m.value;   /* 铺开的点取它铺开后的位置 */
        base  = dotSizeOf(m);
        color = m.catKey ? catColor(m.catKey) : '#2f6fed';
        solid = (m.kind === 'dot' || m.kind === 'spider');               /* 单点才叠放大圆点，气泡/同心环只画外圈 */
      } else {
        /* 选中机场这类地标：它们单独成系列，这里按坐标直接补一层高亮 */
        for (var gi = 0; gi < landmarks.length && !pos; gi++) {
          var g = landmarks[gi];
          if (g.labelOnly) continue;                                     /* 城市只出地名、没有图标，不画高亮 */
          for (var pi = 0; pi < (g.points || []).length; pi++) {
            var p = g.points[pi];
            if (p.id !== selectedId) continue;
            pos = [+p.lng, +p.lat];
            base = +g.symbolSize || 16;
            color = g.color || '#7b4bc4';
            break;
          }
        }
      }
      if (!pos) return null;

      var data = [
        /* 外圈色环：明显高出点位本身一圈，一眼看出「就是它」。
           尺寸刻意做得比「可点击光晕」大一圈、且描边更粗 ——
           光晕是细的虚线感光圈会呼吸放大，选中环是 45px 的粗实环且完全静止，
           两种状态在静止画面里也能立刻分开。 */
        { value: pos, symbolSize: base + 30,
          itemStyle: { color: 'transparent', borderColor: color, borderWidth: 4 } },
        /* 白色间隔环：把色环与点位隔开，深色底图上也看得清 */
        { value: pos, symbolSize: base + 18,
          itemStyle: { color: 'transparent', borderColor: 'rgba(255,255,255,.95)', borderWidth: 3 } }
      ];
      /* 单点：再叠一枚放大的实心圆，做出「点被放大」的选中感 */
      if (solid) {
        data.push({
          value: pos, symbolSize: base + 9,
          itemStyle: {
            color: color, borderColor: '#fff', borderWidth: 2,
            shadowBlur: 16, shadowColor: 'rgba(20,40,80,.45)'
          }
        });
      }

      return {
        id: SELECT_NAME, name: SELECT_NAME,
        type: 'scatter',
        coordinateSystem: 'geo',
        symbol: 'circle',
        silent: true,                 /* 只做展示：不抢底层点位的点击与悬浮 */
        z: 60,                        /* 所有标记之上、标签层之下 */
        data: data
      };
    }

    /* 标签层数据（几何在一次绘制前已算好） */
    function labelData(labels) {
      return labels.map(function (it) {
        return {
          value: it.tip, tip: it.tip, from: it.from || null,
          lines: it.lines, markerR: it.markerR,
          noLeader: !!it.noLeader, hot: !!it.hot,
          dx: it.dx || 0, dy: it.dy || 0
        };
      });
    }

    var geoReady = false;              /* geo 坐标系是否已建立（可做像素换算） */
    var bootTimer = null;
    var bootTries = 0;

    function draw() {
      if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }

      if (!geoReady) {
        /* 首帧：geo 坐标系还没建好，算不出像素位置。
           先只画底图与点位（不带标签），坐标系建立后立刻补一帧完整绘制。 */
        var boot = buildPlan();
        boot.labels = [];
        labelItems = [];
        applyOption(boot);
        geoReady = !!toPixel(109.83, 19.15);
        probeScale();
        if (bootTries++ < 20) {
          bootTimer = setTimeout(function () { bootTimer = null; draw(); }, 60);
        }
        return;
      }
      bootTries = 0;

      probeScale();                    /* 按当前比例尺换算像素容差 */
      var plan = buildPlan();          /* 聚合 / 避让全部基于真实像素 */
      /* 所有图标的像素位置（含没有常显名称的点位）都交给排版做障碍物，
         标签就不会压住任何一个点位图标 */
      layoutLabels(plan.labels, plan.markers.map(function (m) {
        return m.value ? toPixel(m.value[0], m.value[1]) : null;
      }));
      labelItems = plan.labels;        /* 供 renderLabel 按 dataIndex 取用 */
      applyOption(plan);               /* 一次画完（含标签几何） */
      cacheRoutePixels();              /* 路线像素折线缓存，供悬停命中判断 */
    }

    /* ---------- 路线悬停命中 ----------
       不依赖 ECharts 的 mouseover/mouseout：本项目 setOption 用的是 notMerge，
       一重绘就会把 hover 状态清掉，进而触发 mouseout → 再重绘，来回抖动。
       改成自己按指针位置判断，只有「悬停目标变了」才重绘，行为完全确定。
       底图 roam:false（视野固定），所以每次绘制后缓存的像素位置一直有效。 */
    var routePx = [];
    var HOVER_PX = 9;                /* 鼠标离路线多少像素内算悬停 */

    function cacheRoutePixels() {
      routePx = [];
      if (!routesVisible || !routes.length) return;
      routes.forEach(function (lg, i) {
        var src = lg.polyline || [], out = [];
        for (var k = 0; k < src.length; k++) {
          var q = toPixel(src[k][0], src[k][1]);
          if (q) out.push(q);
        }
        if (out.length > 1) routePx.push({ idx: i, pts: out });
      });
    }

    function distToSeg(px, py, a, b) {
      var dx = b[0] - a[0], dy = b[1] - a[1];
      var len = dx * dx + dy * dy;
      var t = len ? ((px - a[0]) * dx + (py - a[1]) * dy) / len : 0;
      t = t < 0 ? 0 : (t > 1 ? 1 : t);
      var qx = a[0] + t * dx, qy = a[1] + t * dy;
      return Math.sqrt((px - qx) * (px - qx) + (py - qy) * (py - qy));
    }

    function hitRoute(mx, my) {
      var best = null, bestD = HOVER_PX;
      for (var r = 0; r < routePx.length; r++) {
        var pts = routePx[r].pts;
        for (var k = 0; k < pts.length - 1; k++) {
          var d = distToSeg(mx, my, pts[k], pts[k + 1]);
          if (d < bestD) { bestD = d; best = routePx[r].idx; }
        }
      }
      return best;
    }

    function setHoveredRoute(i) {
      var v = (i == null) ? null : i;
      if (v === hoveredRoute) return;
      hoveredRoute = v;
      draw();
    }

    el.addEventListener('mousemove', function (e) {
      if (!routesVisible || !routePx.length) return;
      var rect = el.getBoundingClientRect();
      setHoveredRoute(hitRoute(e.clientX - rect.left, e.clientY - rect.top));
    });
    el.addEventListener('mouseleave', function () { setHoveredRoute(null); });

    /* 由当前地图比例尺把「像素阈值」换算成经纬度容差 */
    function probeScale() {
      var o, px, py, pz;
      try {
        o  = chart.convertToPixel({ geoIndex: 0 }, [109.5, 19.0]);
        px = chart.convertToPixel({ geoIndex: 0 }, [110.5, 19.0]);
        py = chart.convertToPixel({ geoIndex: 0 }, [109.5, 18.0]);
        pz = chart.convertToPixel({ geoIndex: 0 }, [109.5, 20.0]);
      } catch (e) { return; }
      if (!o || !px || !py || !pz) return;
      var perLng = Math.abs(px[0] - o[0]);        /* 1 度经度 = 多少像素 */
      var perLat = Math.abs(py[1] - pz[1]);       /* 1 度纬度 = 多少像素 */
      if (perLng < 1 || perLat < 1) return;
      var tol = markerSize();                     /* 会互相遮挡的像素距离 */
      tolDeg = { lng: tol / perLng, lat: tol / perLat };
      coarseTolDeg = { lng: COARSE_PX / perLng, lat: COARSE_PX / perLat };
      scaleKnown = true;
    }

    function applyOption(plan) {
      var selected = {};
      categories.forEach(function (c) { selected[c.name] = !hidden[c.key]; });

      chart.setOption({
        backgroundColor: 'transparent',
        tooltip: {
          /* 移动端不弹地图浮层：景点名称/坐标一律不显示在图面上，
             名称与详情交给页面底部弹卡。桌面端行为保持不变。 */
          show: !mobileNoLabels,
          trigger: 'item',
          borderWidth: 0,
          padding: [8, 10],
          backgroundColor: 'rgba(20,30,45,.92)',
          textStyle: { color: '#fff', fontSize: 12 },
          formatter: function (p) {
            var d = p.data || {};
            /* 路线不在 tooltip 里重复显示距离/时长：悬停时的信息由线上的标签给出，
               这里再弹一个浮层只会让画面变乱。 */
            if (d.kind === 'route') return '';
            if (d.kind === 'bubble') {
              var rows = Object.keys(d.tally || {}).map(function (k) {
                return catName(k) + ' ' + d.tally[k];
              }).join('　');
              return '<b>密集区域 · ' + d.count + ' 个点位</b><br>' + rows +
                     '<br><span style="opacity:.72">点击气泡可就地展开全部点位</span>';
            }
            if (d.kind === 'collapse') {
              return '<b>' + d.count + ' 个点位</b><br><span style="opacity:.72">点击收起</span>';
            }
            if (d.cluster) {
              return '<b>同一位置 · ' + d.count + ' 条点位</b>' +
                     '<br>由内向外：' + (d.labels || d.kinds || []).join(' → ');
            }
            if (p.componentType === 'geo') return areaTip(p.name, lang);
            var r = d.raw || {};
            var place = d.place || '';
            return (place ? '<b>' + place + '</b><br>' : '') +
                   (place ? '<span style="opacity:.75">' + (d.name || '点位') + '</span><br>'
                          : '<b>' + (d.name || '点位') + '</b><br>') +
                   (+r.lng).toFixed(4) + ', ' + (+r.lat).toFixed(4);
          }
        },
        legend: (legendOn && legendVisible) ? {
          bottom: 12, left: 'center', icon: 'circle',
          itemWidth: 9, itemHeight: 9, itemGap: 16,
          textStyle: { color: '#4a5260', fontSize: 12 },
          selected: selected,
          data: categories.map(function (c) { return c.name; })
        } : { show: false },
        geo: {
          /* 市县名跟随语种：中文用原始地图，英/俄换用译名地图 */
          map: mapForLang(lang),
          roam: !!cfg.roam,
          zoom: 1.12,
          center: [109.83, 19.15],
          label: { show: false },
          itemStyle: { areaColor: '#e9f1fb', borderColor: '#9cb8dd', borderWidth: 1 },
          emphasis: {
            itemStyle: { areaColor: '#d6e6fb' },
            /* 悬浮时区域内浮现的地名同样跟随语种；移动端不浮现，保持图面干净 */
            label: {
              show: !mobileNoLabels, color: '#1f2d3d', fontSize: 12,
              formatter: function (p) { return regionName(p.name, lang); }
            }
          },
          select: { disabled: true }
        },
        series: buildSeries(plan)
      }, true);
    }

    chart.on('legendselectchanged', function (e) {
      Object.keys(e.selected).forEach(function (n) {
        var c = catByName(n);
        if (c) hidden[c.key] = !e.selected[n];
      });
      if (cfg.onLegendChange) cfg.onLegendChange(e.selected);
      draw();                                  /* 显隐变化后按可见图层重新分组、重绘 */
    });

    chart.on('click', function (p) {
      /* 聚合气泡：先就地展开 / 收起，再把点击事件交给外层（外层仍会弹成员卡片） */
      var d = p && p.data;
      if (d && d.cluster && d.groupKey && !/^ring:/.test(d.groupKey)) {
        expanded[d.groupKey] = !expanded[d.groupKey];
        draw();
      }
      if (cfg.onClick) cfg.onClick(p);
    });

    draw();
    /* 容器尺寸变化会改变比例尺，需重新换算像素容差 */
    window.addEventListener('resize', function () {
      scaleKnown = false;
      /* 窗口在「移动端宽度」与「桌面宽度」之间变化时，
         名称显隐规则随之切换（横竖屏切换也会走到这里） */
      if (cfg.mobileNoLabels) mobileNoLabels = isCompactView();
      chart.resize();
      draw();
    });

    /* 找到某条记录当前渲染在哪个系列的哪个数据项（供高亮使用） */
    function locate(point) {
      var series = buildSeries(buildPlan());
      for (var si = 0; si < series.length; si++) {
        var data = series[si].data || [];
        for (var di = 0; di < data.length; di++) {
          var d = data[di];
          if (d.raw === point) return { seriesIndex: si, dataIndex: di };
          if (point && d.pointId && d.pointId === point.id) return { seriesIndex: si, dataIndex: di };
          if (point && d.members) {
            for (var mi = 0; mi < d.members.length; mi++) {
              if (d.members[mi].pointId === point.id) return { seriesIndex: si, dataIndex: di };
            }
          }
        }
      }
      return null;
    }

    return {
      chart: chart,
      update: function (next) {
        if (next) {
          if (Array.isArray(next.categories)) categories = next.categories;
          if (Array.isArray(next.points)) {
            points = next.points;
            expanded = {};                   /* 数据变了，之前的展开状态作废 */
          }
          /* 地标层随语种切换一起重传（名称要跟着语言变） */
          if (Array.isArray(next.landmarks)) landmarks = next.landmarks;
          /* 语种切换：市县悬浮提示 / 高亮地名跟着换语言 */
          if (next.lang) lang = (next.lang === 'en' || next.lang === 'ru') ? next.lang : 'zh';
          /* 选中态：只传 id 即可（传 null / '' 取消选中）。单独传时不会重传点位数据，
             因此不会把用户已展开的聚合气泡又收起来。 */
          if (next.selected !== undefined) selectedId = next.selected || null;
          /* 引导光晕：传分类 key（可传数组）开，传 null 关 */
          if (next.haloCategory !== undefined) {
            var nk = next.haloCategory ? [].concat(next.haloCategory) : null;
            if (String(nk) !== String(haloCatKeys)) haloCatKeys = nk;
          }
        }
        draw();
      },
      setVisible: function (name, visible) {
        var c = catByName(name);
        if (c) hidden[c.key] = !visible;
        draw();
      },
      setLegendVisible: function (visible) {
        legendVisible = !!visible;
        chart.setOption({ legend: { show: legendVisible && legendOn } });
      },
      /* 展开 / 收起某个聚合气泡（外层点击气泡时调用） */
      toggleCluster: function (key) {
        if (!key) return;
        expanded[key] = !expanded[key];
        draw();
      },
      /* 注入 / 清空驾车路线分段（服务端规划结果） */
      setRoutes: function (legs, visible) {
        routes = Array.isArray(legs) ? legs : [];
        if (visible != null) routesVisible = !!visible;
        hoveredRoute = null;                 /* 路线换了，旧的悬停下标记失效 */
        draw();
      },
      setRoutesVisible: function (visible) {
        routesVisible = !!visible;
        if (!routesVisible) hoveredRoute = null;
        draw();
      },
      /* 高亮并弹出某条点位的提示（聚合组内的记录也能定位） */
      focus: function (pred) {
        for (var i = 0; i < points.length; i++) {
          if (!pred(points[i])) continue;
          var loc = locate(points[i]);
          if (!loc) return false;
          chart.dispatchAction({ type: 'highlight', seriesIndex: loc.seriesIndex, dataIndex: loc.dataIndex });
          chart.dispatchAction({ type: 'showTip', seriesIndex: loc.seriesIndex, dataIndex: loc.dataIndex });
          return true;
        }
        return false;
      },
      /* 当前「同一位置」判定容差（度）：录入时随请求回传，后端据此判断重复录入 */
      tolerance: function () { return Math.max(tolDeg.lng, tolDeg.lat); },
      resize: function () {
        scaleKnown = false;
        chart.resize();
        draw();
      }
    };
  }

  return { create: create, regionName: regionName, areaTip: areaTip };
})();
