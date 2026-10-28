/* ============================================================
   海南全岛地图 · 前台（展示 / 选点录入 / 嵌入）
   ------------------------------------------------------------
   录入交互：先在左侧「录入类型」中选中一个类型 → 点击地图空白处 → 立即在该坐标落点，
             并在该点旁弹出卡片，可直接手动填写这个点位的「地名 / 位置名称」并保存。
   删除交互：点击地图上已有的标记 → 弹出简易卡片 → 只删除被点的这一条记录（不提供批量清空）。
   地名：保存在点位数据的 name 字段（可空），保存后显示在悬浮提示与常显标签上；随时可再修改。
   同一坐标先后的多条记录全部保留，由 map.js 渲染为「外径不放大」的多层同心嵌套圆环，
   最中心是第 1 种类型的实心圆，向外依次是第 2、3… 种类型的圆环，所有层级同时显示。
   ------------------------------------------------------------
   嵌入能力：
     ?embed=1            隐藏侧栏（含录入入口），地图铺满，供 iframe 嵌入
     ?focus=<id>         进入时高亮指定点位
     向父页面发送  postMessage({ source:'hainan-map', type:'ready' })
     点位点击时发送 { type:'point-click', point }
     父页面可下发  { source:'hainan-map', type:'set-layer', name, visible }
                  { source:'hainan-map', type:'focus', id }
                  { source:'hainan-map', type:'resize' }
   ============================================================ */
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var EMBED  = params.get('embed') === '1';
  if (EMBED) document.body.classList.add('embed');

  /* 海南岛大致范围，用于拦截误点在岛外 */
  var BOUNDS = { minLng: 108.3, maxLng: 111.4, minLat: 18.0, maxLat: 20.4 };

  var CATS = window.MAP_CATEGORIES || [];
  var PTS  = window.MAP_POINTS || [];

  var map = null;
  var items = {};
  var activeType = null;      /* 当前选中的录入类型 key */
  var toastTimer = null;

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  /* 点位类型：新格式 categories[]，兼容旧的单值 category */
  function pointCats(p) {
    if (!p) return [];
    if (Array.isArray(p.categories)) return p.categories.filter(Boolean);
    return p.category ? [p.category] : [];
  }
  function catOf(key) {
    for (var i = 0; i < CATS.length; i++) if (CATS[i].key === key) return CATS[i];
    return null;
  }

  function toast(msg, kind) {
    var el = $('toast');
    el.textContent = msg;
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2200);
  }

  /* ---------------- 录入类型选择器 ---------------- */
  function renderTypePicker() {
    var box = $('typePicker');
    box.innerHTML = '';
    CATS.forEach(function (cat) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.dataset.key = cat.key;
      b.innerHTML = '<span class="chip__dot" style="background:' + cat.color + '"></span>' +
                    '<span class="chip__text">' + esc(cat.name) + '</span>';
      b.addEventListener('click', function () { setActiveType(cat.key === activeType ? null : cat.key); });
      box.appendChild(b);
    });
    syncTypePicker();
  }
  function syncTypePicker() {
    Array.prototype.forEach.call(document.querySelectorAll('#typePicker .chip'), function (b) {
      var on = b.dataset.key === activeType;
      b.classList.toggle('on', on);
      b.style.color = on ? (catOf(b.dataset.key) || {}).color : '';
    });
  }
  function setActiveType(key) {
    closePop();
    activeType = key;
    syncTypePicker();
    document.body.classList.toggle('picking', !!key);
    if (map) map.setLegendVisible(!key);      /* 录入时隐藏图例，避免点图例被当成落点 */
    var hint = $('pickHint');
    if (key) {
      var c = catOf(key);
      hint.textContent = '点击地图放置「' + (c ? c.name : key) + '」，再次点击类型可取消';
      hint.hidden = false;
    } else {
      hint.hidden = true;
    }
  }

  /* ---------------- 侧栏：图层开关 + 数量统计 ---------------- */
  function renderSidebar() {
    var listEl = $('layerList');
    listEl.innerHTML = '';
    items = {};
    CATS.forEach(function (cat) {
      var li = document.createElement('li');
      li.className = 'layer';
      li.innerHTML =
        '<span class="layer__dot" style="background:' + cat.color + '"></span>' +
        '<span class="layer__name">' + esc(cat.name) + '</span>' +
        '<span class="layer__count">0</span>';
      li.addEventListener('click', function () {
        var off = li.classList.toggle('off');
        if (map) map.setVisible(cat.name, !off);
      });
      items[cat.name] = li;
      listEl.appendChild(li);
    });
    refreshCounts();
  }
  function refreshCounts() {
    CATS.forEach(function (cat) {
      var li = items[cat.name];
      if (!li) return;
      var n = PTS.filter(function (p) { return pointCats(p).indexOf(cat.key) >= 0; }).length;
      var box = li.querySelector('.layer__count');
      if (box) box.textContent = n;
    });
  }
  function syncSidebar(selectedMap) {
    Object.keys(items).forEach(function (name) {
      items[name].classList.toggle('off', selectedMap[name] === false);
    });
  }

  /* ---------------- 驾车路线（高德规划结果） ----------------
     规划在服务端完成（密钥不下发），这里只做三件事：
       1) 拉取缓存好的分段路线 → 追加到地图图层；
       2) 在侧栏列出每一段的「起点 → 终点 · 距离 · 预计时长」与全程合计；
       3) 「规划 / 更新」按当前点位重新规划一次。
     点位增删后缓存会过期，用「段数 vs 点位数」做个轻量提示。 */
  var routeData = null;          /* 服务端缓存的 { legs, totalDistance, totalDuration } */
  var routesVisible = true;

  function fmtDist(m) {
    m = +m || 0;
    return m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m';
  }
  function fmtTime(s) {
    var min = Math.round((+s || 0) / 60);
    if (min < 60) return min + ' 分钟';
    var h = Math.floor(min / 60), r = min % 60;
    return h + ' 小时' + (r ? r + ' 分' : '');
  }

  function renderRoutePanel() {
    var sum = $('routeSummary'), list = $('routeList');
    if (!sum || !list) return;
    list.innerHTML = '';
    var legs = (routeData && routeData.legs) || [];
    if (!legs.length) {
      sum.textContent = '尚未生成驾车路线：点「规划 / 更新」按当前点位生成。';
      return;
    }
    var txt = legs.length + ' 条独立路线 · 合计 ' + fmtDist(routeData.totalDistance) +
              ' · 累计 ' + fmtTime(routeData.totalDuration);
    /* 路线对是由点位推导出来的，点位数变了就该重新规划 */
    var rp = (routeData.points || []);
    if (rp.length && rp.length !== PTS.length) txt += '（点位已变动，建议重新规划）';
    sum.textContent = txt;

    legs.forEach(function (lg) {
      var div = document.createElement('div');
      div.className = 'route-item';
      div.innerHTML = '<span class="route-item__idx">' + lg.index + '</span>' +
        '<span class="route-item__main"><b>' +
          esc((lg.from && lg.from.name) || '起点') + ' → ' + esc((lg.to && lg.to.name) || '终点') +
        '</b><em>' + fmtDist(lg.distance) + ' · ' + fmtTime(lg.duration) + '</em></span>';
      list.appendChild(div);
    });
  }

  function applyRoutes() {
    renderRoutePanel();
    if (map) map.setRoutes(routeData && routeData.legs, routesVisible);
  }

  function loadRoutes() {
    return fetch('/api/rental/routes', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        routeData = (j && j.routes) || null;
        if (j && j.configured === false && !(routeData && routeData.legs)) {
          $('routeSummary').textContent = '服务端尚未配置高德 Web 服务 Key，暂时无法规划路线。';
        }
        applyRoutes();
      })
      .catch(function (e) {
        console.warn('[routes] 路线数据加载失败：' + e.message);
        /* 自包含单文件版没有后端，路线以 window.MAP_ROUTES 预置，直接用它渲染 */
        if (window.MAP_ROUTES && !routeData) { routeData = window.MAP_ROUTES; applyRoutes(); }
      });
  }

  function syncRouteToggle() {
    var b = $('routeToggle');
    if (!b) return;
    b.classList.toggle('on', routesVisible);
    b.textContent = routesVisible ? '显示路线' : '已隐藏路线';
  }

  function buildRoutes() {
    var btn = $('routeBuild');
    if (btn) { btn.disabled = true; btn.textContent = '规划中…'; }
    $('routeSummary').textContent = '正在逐段调用高德驾车路线规划，请稍候…';

    fetch('/api/rental/routes/build', { method: 'POST' })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) throw new Error(j.error || ('请求失败 ' + r.status));
          return j;
        });
      })
      .then(function (j) {
        routeData = j.routes || null;
        routesVisible = true;
        syncRouteToggle();
        applyRoutes();
        toast('路线规划完成：' + ((routeData && routeData.legs.length) || 0) + ' 条', 'ok');
      })
      .catch(function (e) {
        toast('规划失败：' + e.message, 'err');
        renderRoutePanel();
      })
      .then(function () {
        if (btn) { btn.disabled = false; btn.textContent = '规划 / 更新'; }
      });
  }

  function initRoutePanel() {
    var t = $('routeToggle'), b = $('routeBuild');
    if (t) t.addEventListener('click', function () {
      routesVisible = !routesVisible;
      syncRouteToggle();
      if (map) map.setRoutesVisible(routesVisible);
    });
    if (b) b.addEventListener('click', buildRoutes);
    syncRouteToggle();
    loadRoutes();
  }

  /* ---------------- 地图 ---------------- */
  function buildMap() {
    map = window.HainanMap.create($('map'), {
      categories: CATS,
      points: PTS,
      roam: false,               /* 固定视野：底图始终只展示海南岛全域 */
      legend: true,
      onLegendChange: syncSidebar,
      onClick: onMapClick
    });
  }

  /* ---------------- 标记删除弹窗 ----------------
     点击已有标记 → 弹出简易卡片，只删除被点的这一条记录（同一位置多条可逐条删除）。 */
  var popEl = null;
  /* 待定落点：标签现在也是地图上的可点击图元，且离圆心较远（如右侧类型名、下方地名）。
     文档捕获阶段先只记录落点，等地图 click 判定完再决定是否真的落点。 */
  var pendingPick = null;

  function closePop() {
    if (popEl) { popEl.hidden = true; popEl.innerHTML = ''; }
  }

  /* 把弹窗放在标记旁边，并限制在地图区域内 */
  function placePop(px, py) {
    var stage = popEl.parentNode;
    var sw = stage.clientWidth, sh = stage.clientHeight;
    var w = popEl.offsetWidth, h = popEl.offsetHeight;
    var left = px + 14, top = py - h - 8;
    if (left + w > sw - 8) left = Math.max(8, px - w - 14);
    if (top < 8) top = py + 16;
    if (top + h > sh - 8) top = Math.max(8, sh - h - 8);
    popEl.style.left = left + 'px';
    popEl.style.top  = top + 'px';
  }

  /* 标记中心相对地图容器的 CSS 像素坐标 */
  function pixelOf(value) {
    if (!map || !map.chart || !value) return null;
    return map.chart.convertToPixel({ geoIndex: 0 }, value);
  }

  function deleteBtn(id, name, text, cls) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = cls; b.textContent = text;
    b.addEventListener('click', function (e) { e.stopPropagation(); removePoint(id, name); });
    return b;
  }

  /* 「保存地名」按钮：把卡片里各输入框的地名写入对应点位 */
  function saveBtn(pairsFn) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'pop__save'; b.textContent = '保存地名';
    b.addEventListener('click', function (e) { e.stopPropagation(); saveNames(pairsFn()); });
    return b;
  }

  /* 生成地名输入框（value 为已保存的地名，origin 用于判断是否有改动） */
  function nameInput(value, onEnter) {
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.className = 'pop__input';
    inp.maxLength = 60;
    inp.placeholder = '填写地名 / 位置名称';
    inp.value = value || '';
    inp.dataset.origin = value || '';
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onEnter(); }
      e.stopPropagation();                       /* 避免 Esc 等按键被全局监听当成关卡片 */
    });
    inp.addEventListener('click', function (e) { e.stopPropagation(); });
    return inp;
  }

  /* 单个点位卡片：显示类型/坐标 + 地名输入框 + 保存 + 删除 */
  function openPointPop(point, px, py, focusInput) {
    var cat = catOf(pointCats(point)[0]) || {};
    popEl.innerHTML =
      '<div class="pop__hd"><span class="pop__dot" style="background:' + esc(cat.color || '#2f6fed') + '"></span>' +
      '<span class="pop__nm">' + esc(cat.name || '点位') + '</span></div>' +
      '<span class="pop__coords">' + (+point.lng).toFixed(4) + ', ' + (+point.lat).toFixed(4) + '</span>';

    var inp = nameInput(point.name || '', function () { saveNames([{ id: point.id, input: inp }]); });
    popEl.appendChild(inp);
    popEl.appendChild(saveBtn(function () { return [{ id: point.id, input: inp }]; }));
    popEl.appendChild(deleteBtn(point.id, cat.name || '点位', '删除该标记', 'pop__del pop__del--full'));

    popEl.hidden = false;
    placePop(px, py);
    if (focusInput) inp.focus();
  }

  /* 同一位置的聚合卡片：逐条列出类型 + 各自的地名输入框 + 删除，底部统一保存 */
  function openClusterPop(data, px, py) {
    var members = data.members || [];
    if (!members.length) return;                        /* 无成员信息则不弹（理论上不会发生） */
    var html = '<div class="pop__hd">同一位置 · ' + members.length + ' 条</div><div class="pop__list">';
    members.forEach(function (m, i) {
      var c = catOf(m.catKey) || {};
      html += '<div class="pop__row" data-i="' + i + '">' +
                '<span class="pop__row-hd">' +
                  '<span class="pop__dot" style="background:' + esc(c.color || '#2f6fed') + '"></span>' +
                  '<span class="pop__nm">' + esc(c.name || m.catKey) + '</span>' +
                '</span>' +
              '</div>';
    });
    popEl.innerHTML = html + '</div>';

    var pairs = [];
    Array.prototype.forEach.call(popEl.querySelectorAll('.pop__row'), function (row) {
      var m = members[+row.dataset.i];
      var inp = nameInput(m.name || '', function () { saveNames(pairs); });
      row.appendChild(inp);
      row.querySelector('.pop__row-hd').appendChild(
        deleteBtn(m.pointId, (catOf(m.catKey) || {}).name || '点位', '删除', 'pop__del')
      );
      pairs.push({ id: m.pointId, input: inp });
    });
    popEl.appendChild(saveBtn(function () { return pairs; }));
    popEl.hidden = false;
    placePop(px, py);
  }

  /* 保存地名：只提交有改动的输入框，仅更新这些点位，其余点位不受影响 */
  function saveNames(pairs) {
    var changed = pairs.filter(function (x) {
      return x.input.value.trim() !== (x.input.dataset.origin || '');
    });
    if (!changed.length) return toast('地名没有变化', 'warn');

    Promise.all(changed.map(function (x) {
      return fetch('/api/rental/points/name', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: x.id, name: x.input.value.trim() })
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) throw new Error(j.error || ('请求失败 ' + r.status));
          return j;
        });
      });
    }))
      .then(function () {
        changed.forEach(function (x) { x.input.dataset.origin = x.input.value.trim(); });
        toast(changed.length > 1 ? '已保存 ' + changed.length + ' 个地名' : '已保存地名', 'ok');
        return loadData();
      })
      .catch(function (e) { toast('保存失败：' + e.message, 'err'); });
  }

  /* 删除单个点位（只删这一条，其余保留） */
  function removePoint(id, name) {
    fetch('/api/rental/points/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id })
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) throw new Error(j.error || ('请求失败 ' + r.status));
          return j;
        });
      })
      .then(function () {
        closePop();
        toast('已删除「' + name + '」', 'ok');
        return loadData();
      })
      .catch(function (e) { toast('删除失败：' + e.message, 'err'); });
  }

  /* 命中检测：点击位置是否落在某个「已显示」标记上 */
  function hitMarkerAt(clientX, clientY) {
    if (!map || !map.chart) return null;
    var box = $('map').getBoundingClientRect();
    var x = clientX - box.left, y = clientY - box.top;
    var best = 1e9, hit = null;
    PTS.forEach(function (p) {
      var shown = pointCats(p).some(function (k) {      /* 隐藏图层不参与命中 */
        var c = catOf(k), li = c && items[c.name];
        return !li || !li.classList.contains('off');
      });
      if (!shown) return;
      var px = pixelOf([+p.lng, +p.lat]);
      if (!px) return;
      var d = Math.sqrt((px[0] - x) * (px[0] - x) + (px[1] - y) * (px[1] - y));
      if (d < best) { best = d; hit = p; }
    });
    return best <= 9 ? hit : null;                      /* 命中半径略大于标记半径 */
  }

  /* 点击地图：命中标记 → 删除弹窗；点空白 → 关闭弹窗 */
  function onMapClick(p) {
    /* 嵌入模式只向父页面广播点击 */
    if (EMBED) {
      var pt = (p.data && p.data.raw) || null;
      if (pt && window.parent && window.parent !== window) {
        window.parent.postMessage({ source: 'hainan-map', type: 'point-click', point: pt }, '*');
      }
      return;
    }
    if (!p || !p.data) return;                          /* 点空白：已由 onDocClick 关闭弹窗 */
    /* 命中了标记本体或其标签（右侧类型名 / 下方地名）：取消本轮待定落点，
       避免「点标签反而在附近新增一个点位」 */
    pendingPick = null;
    var px = pixelOf(p.data.value) || [0, 0];
    if (p.data.cluster) return openClusterPop(p.data, px[0], px[1]);
    if (p.data.raw)     return openPointPop(p.data.raw, px[0], px[1]);
  }

  /* 落点：选中录入类型后，点击地图空白处即录入；点到已有标记时优先弹出删除，避免误录入。 */
  function onDocClick(e) {
    /* 弹窗内的点击不参与地图逻辑 */
    if (popEl && !popEl.hidden && popEl.contains(e.target)) return;

    var host = $('map');
    if (!host) return;
    var box = host.getBoundingClientRect();
    if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) return;

    /* 点到已有标记：交给地图 click 打开删除弹窗 */
    if (!EMBED && hitMarkerAt(e.clientX, e.clientY)) return;

    closePop();
    if (!activeType) return;

    var ll = map.chart.convertFromPixel({ geoIndex: 0 }, [e.clientX - box.left, e.clientY - box.top]);
    if (!ll) return;
    var lng = +ll[0], lat = +ll[1];
    if (lng < BOUNDS.minLng || lng > BOUNDS.maxLng || lat < BOUNDS.minLat || lat > BOUNDS.maxLat) {
      return toast('请在海南岛范围内选点', 'err');
    }

    /* 延迟到本轮事件派发结束再落点：若这次点击其实打在了标记或其标签上，
       地图 click 会把 pendingPick 清掉，于是不会误新增点位。 */
    pendingPick = { type: activeType, lng: lng, lat: lat };
    setTimeout(function () {
      var pick = pendingPick;
      pendingPick = null;
      if (pick) createPoint(pick.type, pick.lng, pick.lat);
    }, 0);
  }

  /* ---------------- 录入 ---------------- */
  function createPoint(type, lng, lat) {
    fetch('/api/rental/points', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: type, lng: lng, lat: lat,
        /* 回传当前比例尺下的「同一位置」容差，后端据此判断同类型是否重复录入 */
        tol: map ? map.tolerance() : undefined
      })
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) throw new Error(j.error || ('请求失败 ' + r.status));
          return j;
        });
      })
      .then(function (j) {
        var name = (catOf(type) || {}).name || type;
        if (j.action === 'duplicate') {
          toast('该位置已有「' + name + '」，未重复录入', 'warn');
        } else {
          toast('已录入「' + name + '」' + (j.spot > 1 ? '，该位置共 ' + j.spot + ' 条' : '') + '，可填写地名', 'ok');
        }
        return loadData().then(function () {
          /* 落点后立即弹出卡片并聚焦地名输入框，直接就能给这个点位写地名 */
          var pt = j.point;
          if (!pt) return;
          var px = pixelOf([+pt.lng, +pt.lat]);
          if (px) openPointPop(pt, px[0], px[1], true);
        });
      })
      .catch(function (e) { toast('录入失败：' + e.message, 'err'); });
  }

  /* ---------------- 数据加载（服务端为准，失败回退内置数据） ---------------- */
  function loadData() {
    return fetch('/api/rental/admin/data', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) {
        if (Array.isArray(j.categories) && j.categories.length) CATS = j.categories;
        if (Array.isArray(j.points)) PTS = j.points;
        refreshCounts();
        if (map) map.update({ categories: CATS, points: PTS });
        renderRoutePanel();               /* 点位数变了，路线清单可能已过期 */
      })
      .catch(function (e) {
        console.warn('[map] 点位数据加载失败，使用内置数据：' + e.message);
      });
  }

  /* ---------------- 初始化 ---------------- */
  popEl = $('pop');
  renderSidebar();
  renderTypePicker();
  buildMap();
  initRoutePanel();

  /* 落点 / 弹窗监听：捕获阶段处理地图区域的点击 */
  document.addEventListener('click', onDocClick, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePop(); });

  /* —— 与父页面通信 —— */
  window.addEventListener('message', function (e) {
    var d = e.data || {};
    if (d.source !== 'hainan-map') return;
    if (d.type === 'set-layer') map.setVisible(d.name, !!d.visible);
    if (d.type === 'focus')     map.focus(function (p) { return p.id === d.id; });
    if (d.type === 'resize')    map.resize();
  });

  /* —— 深链聚焦 —— */
  var f = params.get('focus');
  if (f) map.focus(function (p) { return p.id === f; });

  /* —— 就绪通知 —— */
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ source: 'hainan-map', type: 'ready' }, '*');
  }

  /* —— 拉取最新数据 —— */
  loadData();

  /* 供同页的「内容管理」标签切回来时调用：重新拉取数据并刷新地图
     （在管理页改过的点位 / 地名，切回本页时才看得到；路线缓存一并刷新） */
  window.HainanViewReload = function () { return loadData().then(loadRoutes); };
})();
