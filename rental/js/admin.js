/* ============================================================
   海南全岛地图 · 内容管理面板
   ------------------------------------------------------------
   本页仅作为内容展示 / 管理入口，不含账号与登录系统；
   入口权限由宿主主站负责。数据保存后持久化到 data/points.js。
   点位录入统一在地图页（index.html）用「选类型 + 点地图」完成，
   本页做查看 / 删除、图层维护，并可直接填写或修改每个点位的地名。
   ============================================================ */
(function () {
  'use strict';

  var state = { categories: [], points: [], plans: [] };
  var map = null;
  var editingLayerKey = null;  /* null 表示新增 */

  function $(id) { return document.getElementById(id); }

  /* 点位类型：新格式 categories[]，兼容旧的单值 category */
  function pointCats(p) {
    if (!p) return [];
    if (Array.isArray(p.categories)) return p.categories.filter(Boolean);
    return p.category ? [p.category] : [];
  }

  /* 点位的地名 / 介绍均按中文、英文、俄语分别录入：
     names / intro = { zh, en, ru }，空语种不保存。中文名同时写入旧的 name 字段
     （前台地图标签、悬浮提示、路线方案读的都是 name），保证老逻辑不受影响。 */
  var LANG_TAG = { zh: '中', en: 'EN', ru: 'RU' };
  var LANG_PH  = {
    name:  { zh: '中文名称', en: 'English name',  ru: 'Название' },
    intro: { zh: '中文介绍', en: 'English intro', ru: 'Описание' }
  };
  function i18nOf(obj, lang) { return (obj && obj[lang]) || ''; }
  function setI18n(p, field, lang, value) {
    var o = p[field] && typeof p[field] === 'object' ? p[field] : {};
    if (value) o[lang] = value; else delete o[lang];
    if (Object.keys(o).length) p[field] = o; else delete p[field];
    if (field === 'names') {          /* 中文名与旧字段 name 始终一致 */
      if (o.zh) p.name = o.zh; else delete p.name;
    }
  }

  /* ---------------- API ---------------- */
  function api(method, url, body) {
    return fetch(url, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) {
        if (!res.ok) throw new Error(j.error || ('请求失败 ' + res.status));
        return j;
      });
    });
  }

  function bootstrap() {
    /* 点位数据、手动路线方案一起拉：二者互不依赖，并发请求 */
    return Promise.all([
      api('GET', '/api/admin/data'),
      api('GET', '/api/admin/plans')
    ]).then(function (rs) {
      state.categories = rs[0].categories || [];
      state.points = rs[0].points || [];
      state.plans = rs[1].plans || [];
      requestAnimationFrame(function () { ensureMap(); renderAll(); });
    });
  }

  /* ---------------- 地图 ---------------- */
  function ensureMap() {
    if (map) { map.resize(); return; }
    map = window.HainanMap.create($('adminMap'), {
      categories: state.categories,
      points: state.points,
      roam: true,           /* 管理端允许缩放，便于核对坐标 */
      legend: false
    });
  }
  function refreshMap() { if (map) map.update({ categories: state.categories, points: state.points }); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* ---------------- 渲染列表 ---------------- */
  function renderAll() {
    renderLayerList();
    renderPointList();
    renderPlanPicks();
    renderPlanList();
    refreshMap();
  }

  function renderLayerList() {
    var box = $('adminLayerList');
    box.innerHTML = '';
    state.categories.forEach(function (cat) {
      var count = state.points.filter(function (p) { return pointCats(p).indexOf(cat.key) >= 0; }).length;

      var row = document.createElement('div');
      row.className = 'row';
      row.innerHTML =
        '<span class="row__dot" style="background:' + cat.color + '"></span>' +
        '<span class="row__main"><b>' + esc(cat.name) + '</b><em>' + esc(cat.key) + '</em></span>' +
        '<span class="row__count">' + count + '</span>' +
        '<span class="row__act">' +
          '<button data-act="edit" title="编辑">改</button>' +
          '<button data-act="del" class="danger" title="删除">删</button>' +
        '</span>';

      row.querySelector('[data-act="edit"]').onclick = function () { openLayerDrawer(cat.key); };
      row.querySelector('[data-act="del"]').onclick = function () { deleteLayer(cat.key); };
      box.appendChild(row);
    });
    if (!box.children.length) box.innerHTML = '<div class="empty">暂无图层</div>';
  }

  function renderPointList() {
    var box = $('pointList');
    box.innerHTML = '';
    var catName = {};
    state.categories.forEach(function (c) { catName[c.key] = c.name; });

    state.points.forEach(function (p) {
      var row = document.createElement('div');
      row.className = 'row';
      row.innerHTML =
        '<span class="row__main"><b>' + esc(pointCats(p).map(function (k) { return catName[k] || k; }).join(' · ')) + '</b>' +
          /* 经纬度：可直接改，改完地图上的标记同步移动（负号 / 小数都能填） */
          '<div class="i18n-edit">' +
            '<label><i>经</i><input class="row__name" data-field="lng" type="number" step="0.00001" value="' + (+p.lng) + '"></label>' +
            '<label><i>纬</i><input class="row__name" data-field="lat" type="number" step="0.00001" value="' + (+p.lat) + '"></label>' +
          '</div>' +
          /* 三语地名：中文名同时写入旧字段 name，前台地图 / 标签 / 路线方案都读它 */
          '<div class="i18n-edit">' + ['zh', 'en', 'ru'].map(function (lg) {
            return '<label><i>' + LANG_TAG[lg] + '</i>' +
                   '<input class="row__name" data-lang="' + lg + '" type="text" maxlength="60" placeholder="' +
                   LANG_PH.name[lg] + '" value="' + esc(i18nOf(p.names, lg)) + '"></label>';
          }).join('') + '</div>' +
          /* 三语介绍：只在游客页点位详情里展示，默认收起，避免列表过长 */
          '<details class="i18n-more"><summary>介绍（三语，选填）</summary>' +
            '<div class="i18n-edit">' + ['zh', 'en', 'ru'].map(function (lg) {
              return '<label><i>' + LANG_TAG[lg] + '</i>' +
                     '<textarea class="row__name row__name--ta" data-lang="' + lg + '" maxlength="200" placeholder="' +
                     LANG_PH.intro[lg] + '">' + esc(i18nOf(p.intro, lg)) + '</textarea></label>';
            }).join('') + '</div>' +
          '</details>' +
        '</span>' +
        '<span class="row__act"><button data-act="del" class="danger" title="删除">删</button></span>';

      Array.prototype.forEach.call(row.querySelectorAll('[data-lang]'), function (el) {
        var lg = el.dataset.lang;
        var isIntro = el.tagName === 'TEXTAREA';
        el.addEventListener('change', function () {
          var v = el.value.trim();
          if (v === i18nOf(isIntro ? p.intro : p.names, lg)) return;
          setI18n(p, isIntro ? 'intro' : 'names', lg, v);
          renderPointList();          /* 中文名改写后同步刷新旧 name 字段的展示 */
          save();
        });
      });

      /* 经纬度：光标离开即保存；非法值不提交并还原，改完地图上的标记同步移动 */
      Array.prototype.forEach.call(row.querySelectorAll('[data-field="lng"], [data-field="lat"]'), function (el) {
        var field = el.dataset.field;
        el.addEventListener('change', function () {
          var v = +el.value;
          if (!isFinite(v)) { el.value = +p[field]; return; }
          if (v === +p[field]) return;
          p[field] = v;
          refreshMap();
          save();
        });
      });

      row.querySelector('[data-act="del"]').onclick = function () { deletePoint(p.id); };
      box.appendChild(row);
    });

    if (!box.children.length) box.innerHTML = '<div class="empty">暂无点位</div>';

    /* 三语名称填写进度：只统计露营地图上会展示的露营地，
       一眼看出哪些点位还没补英文 / 俄语名（没补的语种在前台回落到中文）。 */
    var camps = state.points.filter(function (p) { return pointCats(p).indexOf('camping') >= 0; });
    var n = { zh: 0, en: 0, ru: 0 };
    camps.forEach(function (p) {
      ['zh', 'en', 'ru'].forEach(function (lg) { if (p.names && p.names[lg]) n[lg]++; });
    });
    $('i18nStat').textContent = '露营地点位名称：中文 ' + n.zh + '/' + camps.length +
      ' · 英文 ' + n.en + '/' + camps.length + ' · 俄语 ' + n.ru + '/' + camps.length;
  }

  function deletePoint(id) {
    if (!confirm('确定删除该坐标上的点位？')) return;
    state.points = state.points.filter(function (x) { return x.id !== id; });
    renderAll();
    save();
  }

  /* ---------------- 图层抽屉 ---------------- */
  function openDrawer() { $('layerDrawer').classList.add('open'); }
  function closeDrawer() { $('layerDrawer').classList.remove('open'); }
  Array.prototype.forEach.call(document.querySelectorAll('[data-close]'), function (el) {
    el.addEventListener('click', closeDrawer);
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });

  function openLayerDrawer(key) {
    editingLayerKey = key || null;
    var c = key ? state.categories.filter(function (x) { return x.key === key; })[0] : null;
    $('lyTitle').textContent = c ? '编辑图层' : '新增图层';
    $('lyKey').value = c ? c.key : '';
    $('lyKey').disabled = !!c;                 /* 编辑时 key 不可改（避免点位失联） */
    $('lyName').value = c ? c.name : '';
    $('lyColor').value = (c && /^#/.test(c.color)) ? c.color : '#2f6fed';
    $('lySymbol').value = (c && c.symbol) || 'circle';
    $('lySize').value = (c && c.symbolSize) || 14;
    $('lyLabel').checked = !!(c && c.showLabel);
    $('lyErr').textContent = '';
    openDrawer();
  }

  $('lySave').addEventListener('click', function () {
    var key = ($('lyKey').value || '').trim();
    var name = $('lyName').value.trim();
    if (!editingLayerKey && !/^[a-zA-Z][a-zA-Z0-9_]{1,19}$/.test(key)) return ($('lyErr').textContent = '标识需以字母开头（2-20 位字母/数字/下划线）');
    if (!name) return ($('lyErr').textContent = '请填写图层名称');

    var item = {
      key: editingLayerKey || key,
      name: name,
      color: $('lyColor').value,
      symbol: $('lySymbol').value,
      symbolSize: parseInt($('lySize').value, 10) || 14,
      showLabel: $('lyLabel').checked,
      z: 20
    };

    if (editingLayerKey) {
      state.categories = state.categories.map(function (c) { return c.key === editingLayerKey ? item : c; });
    } else {
      if (state.categories.some(function (c) { return c.key === key; })) return ($('lyErr').textContent = '标识已存在：' + key);
      state.categories.push(item);
    }
    closeDrawer();
    renderAll();
    save();
  });

  function deleteLayer(key) {
    var c = state.categories.filter(function (x) { return x.key === key; })[0];
    var n = state.points.filter(function (p) { return pointCats(p).indexOf(key) >= 0; }).length;
    if (!c || !confirm('删除图层「' + c.name + '」' + (n ? '，其下 ' + n + ' 个点位将一并删除' : '') + '？')) return;
    state.categories = state.categories.filter(function (x) { return x.key !== key; });
    /* 点位若还属于其它类型则保留，仅摘除被删类型；已无类型的点位一并删除 */
    state.points = state.points
      .map(function (p) {
        var rest = pointCats(p).filter(function (k) { return k !== key; });
        if (rest.length === pointCats(p).length) return p;
        if (!rest.length) return null;
        p.categories = rest;
        return p;
      })
      .filter(Boolean);
    renderAll();
    save();
  }

  /* ---------------- 保存 ---------------- */
  function save() {
    $('saveState').textContent = '保存中…';
    $('saveState').className = 'save-state';
    return api('PUT', '/api/admin/data', { categories: state.categories, points: state.points })
      .then(function () {
        $('saveState').textContent = '已保存 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
        $('saveState').className = 'save-state ok';
      })
      .catch(function (e) {
        $('saveState').textContent = '保存失败：' + e.message;
        $('saveState').className = 'save-state err';
      });
  }

  /* ---------------- 路线查询（和高德起点 / 终点导航一致） ----------------
     提交后由服务端把两端地名解析成经纬度、再调驾车路线规划，
     返回的 leg 结构与点位路线分段一致，因此直接交给地图既有的 setRoutes 渲染，
     距离 / 时长的展示规则（默认隐藏、悬浮该条才显示）也完全复用。 */
  function fmtDist(m) {
    var km = (+m || 0) / 1000;
    return km < 10 ? km.toFixed(1) + ' km' : Math.round(km) + ' km';
  }
  function fmtTime(s) {
    var min = Math.round((+s || 0) / 60);
    if (min < 60) return min + ' 分钟';
    var h = Math.floor(min / 60), r = min % 60;
    return h + ' 小时' + (r ? r + ' 分' : '');
  }

  function queryRoute() {
    var from = ($('rqFrom').value || '').trim();
    var to   = ($('rqTo').value || '').trim();
    var box  = $('rqResult');
    if (!from || !to) { box.textContent = '请填写起点和终点'; return; }
    if (from === to) { box.textContent = '起点和终点相同'; return; }

    box.textContent = '查询中…';
    $('rqGo').disabled = true;
    api('POST', '/api/route/query', { from: from, to: to })
      .then(function (j) {
        var leg = j.leg;
        if (map) map.setRoutes([leg], true);       /* 渲染线路（含悬浮显示距离时长） */
        box.innerHTML = '线路已渲染：<b>' + esc(leg.from.name) + ' → ' + esc(leg.to.name) + '</b>' +
                        '<br>路程 ' + fmtDist(leg.distance) + ' · 预计 ' + fmtTime(leg.duration) +
                        '<br>把鼠标移到线上即可看到该线路的距离与时长。';
      })
      .catch(function (e) { box.textContent = '查询失败：' + e.message; })
      .then(function () { $('rqGo').disabled = false; });
  }

  function clearRoute() {
    if (map) map.setRoutes([], true);
    $('rqResult').textContent = '';
  }

  $('rqGo').onclick = queryRoute;
  $('rqClear').onclick = clearRoute;
  /* 回车即查询，和高德输入框一致 */
  [$('rqFrom'), $('rqTo')].forEach(function (el) {
    el.addEventListener('keydown', function (e) { if (e.key === 'Enter') queryRoute(); });
  });

  /* ---------------- 路线方案（手动按顺序挑点位，仅后台存储） ----------------
     和上面的「路线查询」不是一回事：这里不调高德、不算距离时长、不画到地图，
     只把点位按出行顺序排好、存成一条方案（服务端落盘 data/plans.json）。
     推送给访客属于后续规划，本次不做。 */
  var planDraft = { id: null, stops: [] };     /* id 为空表示新建；stops 存点位 id，顺序即出行顺序 */

  function pointLabel(p) {
    var nm = (p.name || '').trim();
    return nm || ('未命名点位 ' + (+p.lng).toFixed(4) + ', ' + (+p.lat).toFixed(4));
  }

  /* 点位下拉：已选的点位若已被删除，额外补一个占位项，避免下拉悄悄跳回第一项 */
  function planStopOptions(sel) {
    var opts = '<option value="">— 请选择点位 —</option>';
    var found = false;
    state.points.forEach(function (p) {
      if (p.id === sel) found = true;
      opts += '<option value="' + esc(p.id) + '"' + (p.id === sel ? ' selected' : '') + '>' +
              esc(pointLabel(p)) + '</option>';
    });
    if (sel && !found) opts = '<option value="' + esc(sel) + '" selected>（点位已删除）</option>' + opts;
    return opts;
  }

  function renderPlanPicks() {
    var box = $('planPicks');
    box.innerHTML = '';
    if (!planDraft.stops.length) {
      box.innerHTML = '<div class="empty">还没有站点，点下面「+ 添加一站」开始</div>';
      return;
    }
    planDraft.stops.forEach(function (pid, i) {
      var row = document.createElement('div');
      row.className = 'plan-stop';
      row.innerHTML =
        '<span class="plan-stop__no">' + (i + 1) + '</span>' +
        '<select class="plan-stop__sel">' + planStopOptions(pid) + '</select>' +
        '<span class="plan-stop__act">' +
          '<button data-act="up" title="上移">↑</button>' +
          '<button data-act="down" title="下移">↓</button>' +
          '<button data-act="del" class="danger" title="移除本站">×</button>' +
        '</span>';
      row.querySelector('.plan-stop__sel').onchange = function (e) { planDraft.stops[i] = e.target.value; };
      row.querySelector('[data-act="up"]').onclick   = function () { moveStop(i, -1); };
      row.querySelector('[data-act="down"]').onclick = function () { moveStop(i, 1); };
      row.querySelector('[data-act="del"]').onclick  = function () { planDraft.stops.splice(i, 1); renderPlanPicks(); };
      box.appendChild(row);
    });
  }

  function moveStop(i, d) {
    var j = i + d;
    if (j < 0 || j >= planDraft.stops.length) return;
    var t = planDraft.stops[i];
    planDraft.stops[i] = planDraft.stops[j];
    planDraft.stops[j] = t;
    renderPlanPicks();
  }

  function renderPlanList() {
    var box = $('planList');
    box.innerHTML = '';
    $('planCount').textContent = state.plans.length ? state.plans.length + ' 条' : '';
    state.plans.forEach(function (pl) {
      var names = pl.stops.map(function (s) { return s.name || '未命名点位'; });
      var row = document.createElement('div');
      row.className = 'row';
      row.innerHTML =
        '<span class="row__main"><b>' + esc(pl.name) + '</b>' +
          '<em>' + pl.stops.length + ' 站 · ' + esc(names[0]) + ' → ' + esc(names[names.length - 1]) + '</em>' +
          '<span class="plan-row__path">' + esc(names.join(' → ')) + '</span>' +
        '</span>' +
        '<span class="row__act">' +
          '<button data-act="edit" title="载入到上方编辑器">改</button>' +
          '<button data-act="del" class="danger" title="删除">删</button>' +
        '</span>';
      row.querySelector('[data-act="edit"]').onclick = function () { loadPlan(pl.id); };
      row.querySelector('[data-act="del"]').onclick  = function () { deletePlan(pl.id); };
      box.appendChild(row);
    });
    if (!box.children.length) box.innerHTML = '<div class="empty">暂无已保存方案</div>';
  }

  function resetPlanDraft() {
    planDraft = { id: null, stops: [] };
    $('planName').value = '';
    renderPlanPicks();
  }

  function loadPlan(id) {
    var pl = state.plans.filter(function (x) { return x.id === id; })[0];
    if (!pl) return;
    planDraft = { id: pl.id, stops: pl.stops.map(function (s) { return s.pointId; }) };
    $('planName').value = pl.name;
    renderPlanPicks();
    $('planMsg').textContent = '已载入「' + pl.name + '」，改完点「保存方案」即覆盖原方案。';
  }

  function savePlan() {
    var name = ($('planName').value || '').trim();
    var msg = $('planMsg');
    if (!name) { msg.textContent = '请填写方案名称'; return; }
    if (planDraft.stops.length < 2) { msg.textContent = '请至少选择 2 个点位'; return; }

    var alive = {};
    state.points.forEach(function (p) { alive[p.id] = 1; });
    for (var i = 0; i < planDraft.stops.length; i++) {
      if (!alive[planDraft.stops[i]]) {
        msg.textContent = '第 ' + (i + 1) + ' 站的点位已被删除，请重新选择';
        return;
      }
    }

    var body = { name: name, stops: planDraft.stops.map(function (pid) { return { pointId: pid }; }) };
    msg.textContent = '保存中…';
    $('planSave').disabled = true;
    var req = planDraft.id
      ? api('PUT', '/api/admin/plans/' + encodeURIComponent(planDraft.id), body)
      : api('POST', '/api/admin/plans', body);

    req.then(function (j) {
      state.plans = j.plans || state.plans;
      resetPlanDraft();
      renderPlanList();
      msg.textContent = '已保存方案「' + name + '」（' + (j.plan ? j.plan.stops.length : 0) + ' 站）';
    }).catch(function (e) { msg.textContent = '保存失败：' + e.message; })
      .then(function () { $('planSave').disabled = false; });
  }

  function deletePlan(id) {
    var pl = state.plans.filter(function (x) { return x.id === id; })[0];
    if (!pl || !confirm('删除路线方案「' + pl.name + '」？')) return;
    api('DELETE', '/api/admin/plans/' + encodeURIComponent(id))
      .then(function (j) {
        state.plans = j.plans || [];
        if (planDraft.id === id) resetPlanDraft();
        renderPlanList();
        $('planMsg').textContent = '已删除方案「' + pl.name + '」';
      })
      .catch(function (e) { $('planMsg').textContent = '删除失败：' + e.message; });
  }

  $('planAddStop').onclick = function () { planDraft.stops.push(''); renderPlanPicks(); };
  $('planSave').onclick = savePlan;

  /* ---------------- 顶部操作 ---------------- */
  $('addLayer').onclick = function () { openLayerDrawer(null); };

  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
    t.onclick = function () {
      Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (x) { x.classList.remove('active'); });
      t.classList.add('active');
      $('tabPoints').hidden = t.dataset.tab !== 'points';
      $('tabLayers').hidden = t.dataset.tab !== 'layers';
      $('tabRoute').hidden  = t.dataset.tab !== 'route';
      $('tabPlans').hidden  = t.dataset.tab !== 'plans';
    };
  });

  /* ---------------- 启动（无需登录，直接进入管理面板） ---------------- */
  /* 供同页的「地图」标签切过来时调用：重新拉取数据并刷新列表与地图
     （在地图页新落 / 删掉的点位，切到本页时才看得到） */
  window.HainanAdminReload = bootstrap;

  bootstrap().catch(function (e) {
    $('saveState').textContent = '数据加载失败：' + e.message;
    $('saveState').className = 'save-state err';
  });
})();
