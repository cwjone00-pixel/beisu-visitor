/* ============================================================
   beisuas 游客端 · 后端服务（Node.js 内置模块，零依赖）
   -----------------------------------------------------------
   职责：
   1. 存储后台配置数据（JSON 文件持久化）：
      - quickButtons  首页快捷按钮（绑定关键词，三语文字）
      - rules         关键词自动回复规则（精准/模糊，三语回复，配套按钮）
      - fallback      兜底回复（三语，可带配套按钮）
   2. 提供配置增删改查 / 启停接口
   3. 关键词匹配逻辑（精准 > 模糊 > 兜底），返回三语数据
   4. 静态托管游客前端 index.html 与后台 admin.html

   前端零硬编码：所有文案、按钮、关键词均由本后端输出。
   ============================================================ */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const PORT = process.env.PORT || 3210;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data', 'rules.json');
/* 全岛游地图（露营点 / 打卡点 / 地标）独立成一份数据，与聊天配置互不影响 */
const MAP_FILE = path.join(ROOT, 'data', 'map.json');
/* 邮件里激活链接的对外基础地址：固定为线上域名，避免本地联调时邮件指向 localhost；可用环境变量 PUBLIC_BASE_URL 覆盖 */
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || 'https://beisu-visitor.onrender.com').trim().replace(/\/+$/, '');

/* ---------------- 云存储（MongoDB Atlas 免费集群） ----------------
   配置 MONGODB_URI（环境变量或 secrets.json 的 mongo.uri）后，
   5 个数据集合（rules/chats/auth/users/map）持久化到云端，Render 重启不再丢数据；
   未配置时完全退回本地 JSON 文件模式，本地开发零影响。
   读取走内存缓存（同步），写入内存后防抖回写云端（replaceOne upsert）。 */
const CLOUD_DOCS = ['rules', 'chats', 'auth', 'users', 'map'];
const cloud = { enabled:false, col:null, docs:{}, dirty:new Set(), timer:null };
const cloudGet = name => cloud.docs[name];
function cloudSave(name, value){
  cloud.docs[name] = value;
  cloud.dirty.add(name);
  if (!cloud.timer) cloud.timer = setTimeout(flushCloud, 300);
}
async function flushCloud(){
  cloud.timer = null;
  const names = [...cloud.dirty];
  cloud.dirty.clear();
  for (const name of names){
    try { await cloud.col.replaceOne({ _id:name }, { _id:name, value: cloud.docs[name] }, { upsert:true }); }
    catch(e){ console.error('[cloud] 写回失败 ' + name + ':', e.message); cloud.dirty.add(name); }
  }
  if (cloud.dirty.size && !cloud.timer) cloud.timer = setTimeout(flushCloud, 2000);   // 失败稍后重试
}
function readLocalSeed(name){
  const file = { rules:DATA_FILE, chats:CHAT_FILE, auth:AUTH_FILE, users:USER_FILE, map:MAP_FILE }[name];
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch(e){ return null; }
}
async function initCloud(uri){
  if (!uri){ console.log('[cloud] 未配置 MONGODB_URI，使用本地 JSON 文件存储'); return; }
  const { MongoClient } = require('mongodb');
  const connect = () => new MongoClient(uri, { serverSelectionTimeoutMS: 10000 }).connect();
  let client;
  try {
    client = await connect();
  } catch(e){
    /* 部分网络的默认 DNS 无法解析 SRV 记录（querySrv ETIMEOUT）：退回公共 DNS 重试一次 */
    if (!/querySrv|ETIMEOUT|ENOTFOUND|ESERVFAIL|EAI_AGAIN/i.test(String(e && e.message))) throw e;
    console.log('[cloud] 默认 DNS 无法解析 SRV，改用公共 DNS 重试…');
    try { require('dns').setServers(['8.8.8.8', '1.1.1.1']); } catch(_){}
    client = await connect();
  }
  cloud.db = client.db(process.env.MONGODB_DB || 'beisu');
  cloud.col = cloud.db.collection('singleton');
  cloud.mediaCol = cloud.db.collection('media');   // 图片媒体：独立集合，避免撑爆 chats 单文档 16MB 上限
  for (const name of CLOUD_DOCS){
    const doc = await cloud.col.findOne({ _id:name });
    if (doc && doc.value !== undefined){ cloud.docs[name] = doc.value; }
    else {
      const seed = readLocalSeed(name);   // 云库为空：用本地既有数据播种（迁移）；本地也无则留空待首次写入
      cloud.docs[name] = seed;
      if (seed !== null) await cloud.col.replaceOne({ _id:name }, { _id:name, value:seed }, { upsert:true });
    }
  }
  cloud.enabled = true;
  console.log('[cloud] MongoDB 已连接，云端持久化已启用（DB=' + (process.env.MONGODB_DB || 'beisu') + '）');
}

/* ---------------- 数据持久化 ---------------- */
function ensureDataFile(){
  if (!fs.existsSync(path.dirname(DATA_FILE))) fs.mkdirSync(path.dirname(DATA_FILE), { recursive:true });
  if (!fs.existsSync(DATA_FILE)){
    // 初始空数据：无任何硬编码内容，全部由后台录入
    const initial = {
      quickButtons: [],
      rules: [],
      fallback: { reply: { zh:'', en:'', ru:'' }, quickButtons: [], appendLink:false },
      link: { text: { zh:'', en:'', ru:'' }, url: '' },
      guide: { text: { zh:'', en:'', ru:'' } },
      placeholder: { bot: { zh:'', en:'', ru:'' }, agent: { zh:'', en:'', ru:'' } },
      articles: [],
      events: [],
      cards: [],
      agentChat: { translate: true }
    };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2), 'utf-8');
  }
}
let dataCache = null;
/* 归一化任意来源的原始配置（本地文件 / 云库文档）为完整可用结构 */
function shapeData(raw){
  const d = migrate(raw && typeof raw === 'object' ? raw : {});
  if (!Array.isArray(d.quickButtons)) d.quickButtons = [];
  if (!Array.isArray(d.rules)) d.rules = [];
  if (!d.fallback || typeof d.fallback !== 'object') d.fallback = { reply:{zh:'',en:'',ru:''}, quickButtons:[], appendLink:false };
  d.link = normalizeLinkTemplate(d.link);
  d.links = normalizeLinks(d.links, d.link);
    /* 首页引导文字（三语）；旧数据无此字段时按当前线上文案补齐基线，后台可自由修改 */
    if (!d.guide || typeof d.guide !== 'object' || !('text' in d.guide)){
      d.guide = { text: { zh:'请问你过来有什么需求？', en:'How can we help you today?', ru:'Чем мы можем вам помочь?' } };
    } else {
      d.guide = { text: normLabel(d.guide.text) };
    }
    /* 输入框占位提示（按在线状态区分，三语）；旧数据无此字段时补齐基线文案，后台可自由修改 */
    if (!d.placeholder || typeof d.placeholder !== 'object'){
      d.placeholder = {
        bot:   { zh:'请你放心，机器人一样可以给你处理大部分问题。', en:"Don't worry — the bot can handle most of your questions.", ru:'Не волнуйтесь, бот поможет решить большинство ваших вопросов.' },
        agent: { zh:'有什么迷茫的地方向我提问。', en:'Feel free to ask me anything on your mind.', ru:'Спрашивайте меня о том, что вас беспокоит.' }
      };
    } else {
      d.placeholder = { bot: normLabel(d.placeholder.bot), agent: normLabel(d.placeholder.agent) };
    }
    /* 输入框快捷按钮（租房/租车/旅游搭子，三语）；旧数据无此字段时补齐基线，后台可自由修改 */
    if (!Array.isArray(d.composerButtons)){
      d.composerButtons = [
        { id: crypto.randomUUID(), keyword:'租房',   label:{ zh:'租房',     en:'Housing Rental', ru:'Аренда жилья' } },
        { id: crypto.randomUUID(), keyword:'租车',   label:{ zh:'租车',     en:'Car Rental',     ru:'Аренда авто' } },
        { id: crypto.randomUUID(), keyword:'旅游搭子', label:{ zh:'旅游搭子', en:'Travel Buddy',   ru:'Попутчик' } }
      ];
    } else {
      d.composerButtons = d.composerButtons.map(normalizeHomeButton);
    }
    /* 左侧菜单 5 项（名称 + 简介，三语）：只存后台改过的值，未改的项不落库 */
    d.menuTexts = normMenuTexts(d.menuTexts);
    /* 文章资讯（后台录入的图文；draft 草稿 / published 已发布） */
    if (!Array.isArray(d.articles)) d.articles = [];
    d.articles = d.articles.map(a => normArticle(a, d.articles));
    /* 商业活动（后台录入的图文；与文章资讯分开存储，仅用于前端左侧「商业活动」板块展示） */
    if (!Array.isArray(d.events)) d.events = [];
    d.events = d.events.map(e => normEvent(e));
    /* 页面卡片（聊天里发送的方块富媒体卡片：标题/简介/封面图/跳转地址，三语） */
    if (!Array.isArray(d.cards)) d.cards = [];
    d.cards = d.cards.map(normCard);
    /* 全岛游价格方案（后台配置；0 = 未配置，前端占位展示）：
       免拼 = 包下整台车，4/7/9 座（座位含司机）各自一个整车价；
       拼团 = 与其他游客拼车按人头付费，4/7/9 座各自一个单人单价 */
    if (!d.islandPricing || typeof d.islandPricing !== 'object') d.islandPricing = {};
    if (!d.islandPricing.private || typeof d.islandPricing.private !== 'object') d.islandPricing.private = {};
    ['seat4', 'seat7', 'seat9'].forEach(function (k) {
      d.islandPricing.private[k] = Math.max(0, Math.min(999999, Math.round(+d.islandPricing.private[k] || 0)));
    });
    /* 拼团单价：历史数据 shared 可能是单数字（旧版不分车型），迁移时把该值铺到 4/7/9 座；
       新版为 { seat4, seat7, seat9 }，按车型各自一个单人单价 */
    if (!d.islandPricing.shared || typeof d.islandPricing.shared !== 'object') {
      const legacy = Math.max(0, Math.min(999999, Math.round(+d.islandPricing.shared || 0)));
      d.islandPricing.shared = { seat4: legacy, seat7: legacy, seat9: legacy };
    } else {
      ['seat4', 'seat7', 'seat9'].forEach(function (k) {
        d.islandPricing.shared[k] = Math.max(0, Math.min(999999, Math.round(+d.islandPricing.shared[k] || 0)));
      });
    }
    /* 人工消息自动翻译总开关（缺省开启）+ 机器人总开关（缺省开启） */
    if (!d.agentChat || typeof d.agentChat !== 'object') d.agentChat = {};
    d.agentChat.translate = d.agentChat.translate !== false;
    d.agentChat.botEnabled = d.agentChat.botEnabled !== false;
    /* 关键词回复顺序延时发送总开关（缺省开启；关闭则所有追加消息瞬时发出，保持旧行为） */
    d.replySeq = d.replySeq !== false;
    /* 海南项目体验 · 项目与价格（后台可改；按 slug 稀疏覆盖，留空沿用页面默认三语文案） */
    d.expProjects = normExpProjects(d.expProjects);
    return d;
}
/* 体验站 4 个项目的可覆盖字段：名称/价格/定金/简介/时长/人数/难度/出发地。
   只存后台真正填过的值，未填的继续用前端默认文案，避免把多语言默认内容覆盖成空白。 */
const EXP_SLUG_RE = /^[a-z0-9-]{1,40}$/;
const EXP_TEXT_FIELDS = { name:60, intro:300, duration:30, group:30, level:30, from:30 };
function normExpProjects(raw){
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  Object.keys(raw).forEach(function (slug) {
    if (!EXP_SLUG_RE.test(slug)) return;
    const v = (raw[slug] && typeof raw[slug] === 'object') ? raw[slug] : {};
    const item = {};
    Object.keys(EXP_TEXT_FIELDS).forEach(function (k) {
      const s = String(v[k] == null ? '' : v[k]).trim().slice(0, EXP_TEXT_FIELDS[k]);
      if (s) item[k] = s;
    });
    ['price', 'deposit'].forEach(function (k) {
      const s = String(v[k] == null ? '' : v[k]).trim();
      if (!s) return;
      const n = Math.round(Number(s));
      if (isFinite(n) && n >= 0) item[k] = Math.min(999999, n);
    });
    if (Object.keys(item).length) out[slug] = item;
  });
  return out;
}
function loadData(){
  if (cloud.enabled){
    if (!dataCache) dataCache = shapeData(cloudGet('rules'));
    return dataCache;
  }
  ensureDataFile();
  try { return shapeData(JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'))); }
  catch(e){ return shapeData({}); }
}
function saveData(data){
  dataCache = data;
  if (cloud.enabled) return cloudSave('rules', data);
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf-8');
}
/* 兼容旧格式（reply 为字符串）→ 迁移为三语对象 */
function migrate(data){
  const toTri = v => (v && typeof v === 'object') ? { zh:v.zh||'', en:v.en||'', ru:v.ru||'' } : { zh:String(v||''), en:'', ru:'' };
  (data.rules||[]).forEach(r => { r.reply = toTri(r.reply); r.keywords = normKeywordMap(r.keywords); });
  if (data.fallback) data.fallback.reply = toTri(data.fallback.reply);
  return data;
}

/* ---------------- 全岛游地图数据（露营点 / 打卡点 / 地标） ----------------
   与聊天配置分开存储：本地 data/map.json，云端 singleton 的 'map' 文档。
   露营点与游玩打卡点共用同一份点位数据，只靠分类 key 区分：
     camping → 露营点（游客地图页）、play → 游玩打卡点（打卡点页）。
   露营点再按 campTypes 映射成海边(sea) / 雨林(forest) / 湖畔(lake) 三类上色；
   类型表里没有的露营点默认按海边展示，后台以后新加点位不用改代码就能看到。
   点位数据由后台「全岛游地图」模块增删改，游客端两个页面只读。 */
const MAP_LANGS = ['zh','en','ru'];
const MAP_NAME_MAX = 60, MAP_INTRO_MAX = 200;
const MAP_CAMP_KEY = 'camping', MAP_PLAY_KEY = 'play';
/* 图层（分类）标识：字母开头，2-20 位字母/数字/下划线 */
const MAP_LAYER_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{1,19}$/;
const MAP_LAYER_NAME_MAX = 30;
/* 路线方案：仅后台留存，名称上限与站点数下限 */
const PLAN_NAME_MAX = 60;
const MAP_KINDS = [
  { key:'sea',    name:'海边露营点', names:{ zh:'海边露营点', en:'Seaside Camping Spot',     ru:'Кемпинг у моря' },              color:'#1e88e5', symbol:'circle', symbolSize:15, z:12 },
  { key:'forest', name:'雨林露营点', names:{ zh:'雨林露营点', en:'Rainforest Camping Spot',  ru:'Кемпинг в тропическом лесу' }, color:'#2e9e5b', symbol:'circle', symbolSize:15, z:13 },
  { key:'lake',   name:'湖畔露营点', names:{ zh:'湖畔露营点', en:'Lakeside Camping Spot',    ru:'Кемпинг у озера' },            color:'#f08c1a', symbol:'circle', symbolSize:15, z:14 }
];
const MAP_KIND_KEYS = MAP_KINDS.map(k => k.key);

/* 三语字段：trim + 截断，丢掉空语种；非对象按空处理 */
function mapI18n(v, max){
  const out = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  MAP_LANGS.forEach(l => { const s = String(v[l] == null ? '' : v[l]).trim().slice(0, max); if (s) out[l] = s; });
  return out;
}
function mapCats(p){
  if (!p) return [];
  if (Array.isArray(p.categories)) return p.categories.filter(Boolean);
  return p.category ? [p.category] : [];
}
/* 点位三语名称：老数据只有 name 时按中文名看待 */
function mapNames(p){
  const o = mapI18n(p && p.names, MAP_NAME_MAX);
  if (!o.zh){
    const s = (p && p.name == null) ? '' : String(p.name).trim().slice(0, MAP_NAME_MAX);
    if (s) o.zh = s;
  }
  return o;
}
function normMapPoint(p){
  const out = { id:p.id, categories:mapCats(p), lng:+p.lng, lat:+p.lat };
  const names = mapNames(p);
  if (names.zh) out.name = names.zh;      /* 旧字段：与中文名保持一致，便于阅读兼容 */
  if (Object.keys(names).length) out.names = names;
  const intro = mapI18n(p && p.intro, MAP_INTRO_MAX);
  if (Object.keys(intro).length) out.intro = intro;
  return out;
}
/* 图层（分类）归一化：只保留地图渲染需要的展示字段 */
function normLayer(input, base){
  const c = base || {};
  /* 编辑时以 base.key 为准（标识不可改，否则引用它的点位会失联） */
  const key = c.key != null ? c.key : String((input && input.key) != null ? input.key : '').trim();
  return {
    key: key,
    name: String((input && input.name) != null ? input.name : c.name || '').trim().slice(0, MAP_LAYER_NAME_MAX),
    color: /^#[0-9a-fA-F]{3,8}$/.test(String((input && input.color) || c.color || '')) ? String(input.color || c.color) : '#2f7cf6',
    symbol: String((input && input.symbol) || c.symbol || 'circle'),
    symbolSize: Math.min(60, Math.max(6, parseInt((input && input.symbolSize) || c.symbolSize || 14, 10) || 14)),
    showLabel: (input && input.showLabel != null) ? !!input.showLabel : !!c.showLabel,
    z: parseInt((input && input.z) || c.z || 20, 10) || 20
  };
}
/* 路线方案归一化：站点存「点位 id + 保存当时的名称/坐标」快照，点位以后被删也能看清内容 */
function normPlan(input, base){
  const p = base || {};
  const stops = Array.isArray(input && input.stops) ? input.stops : (p.stops || []);
  return {
    id: p.id || ('pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)),
    name: String((input && input.name) != null ? input.name : p.name || '').trim().slice(0, PLAN_NAME_MAX),
    stops: stops.map(s => ({ pointId:String(s && s.pointId || ''), name:String((s && s.name) || ''), lng:+((s && s.lng)), lat:+((s && s.lat)) })),
    createdAt: p.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}
/* 驾车路线缓存归一化：只认结构完整的对象，否则视为还没规划过 */
function normRoutes(raw){
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.legs) || !raw.legs.length) return null;
  return {
    generatedAt: raw.generatedAt || '',
    linkK: +raw.linkK || 0,
    points: Array.isArray(raw.points) ? raw.points : [],
    legs: raw.legs,
    totalDistance: +raw.totalDistance || 0,
    totalDuration: +raw.totalDuration || 0
  };
}
function emptyMapData(){ return { categories:[], points:[], campTypes:{}, landmarks:{ groups:[], points:[] }, routes:null, plans:[] }; }
function shapeMap(raw){
  const d = (raw && typeof raw === 'object') ? raw : {};
  const out = emptyMapData();
  if (Array.isArray(d.categories)) out.categories = d.categories.filter(c => c && typeof c.key === 'string' && c.key.trim()).map(c => normLayer(c));
  if (Array.isArray(d.points)) out.points = d.points.filter(p => p && p.id).map(p => normMapPoint(p));
  if (d.campTypes && typeof d.campTypes === 'object' && !Array.isArray(d.campTypes)){
    Object.keys(d.campTypes).forEach(id => { if (MAP_KIND_KEYS.indexOf(d.campTypes[id]) >= 0) out.campTypes[id] = d.campTypes[id]; });
  }
  const lm = d.landmarks;
  if (lm && typeof lm === 'object'){
    if (Array.isArray(lm.groups)) out.landmarks.groups = lm.groups.filter(g => g && g.key);
    if (Array.isArray(lm.points)) out.landmarks.points = lm.points.filter(p => p && p.id && isFinite(+p.lng) && isFinite(+p.lat))
      .map(p => ({ id:p.id, kind:p.kind, name:p.name || '', names:(p.names && typeof p.names === 'object') ? p.names : {}, lng:+p.lng, lat:+p.lat }));
  }
  out.routes = normRoutes(d.routes);
  if (Array.isArray(d.plans)) out.plans = d.plans.filter(p => p && p.id).map(p => normPlan(p, p));
  return out;
}
/* 后台提交图层校验：标识格式 + 是否重名 + 名称必填 */
function validateLayer(body, d, editingKey){
  const key = String((body && body.key) || '').trim();
  if (!editingKey){
    if (!MAP_LAYER_KEY_RE.test(key)) return { error:'图层标识需以字母开头（2-20 位字母 / 数字 / 下划线）' };
    if (d.categories.some(c => c.key === key)) return { error:'图层标识已存在：' + key };
  }
  const name = String((body && body.name) || '').trim();
  if (!name) return { error:'请填写图层名称' };
  if (name.length > MAP_LAYER_NAME_MAX) return { error:'图层名称过长（最多 ' + MAP_LAYER_NAME_MAX + ' 字）' };
  return { layer: normLayer(body, editingKey ? d.categories.filter(c => c.key === editingKey)[0] : null) };
}
/* 后台提交路线方案校验 */
function validatePlan(body, d){
  if (!body || typeof body !== 'object') return { error:'数据结构不正确' };
  const name = String(body.name || '').trim();
  if (!name) return { error:'请填写方案名称' };
  if (name.length > PLAN_NAME_MAX) return { error:'方案名称过长（最多 ' + PLAN_NAME_MAX + ' 字）' };
  const stops = Array.isArray(body.stops) ? body.stops : null;
  if (!stops) return { error:'站点列表格式不正确' };
  if (stops.length < 2) return { error:'请至少选择 2 个点位' };
  const seen = {};
  for (const s of stops){
    const pid = String((s && s.pointId) || '').trim();
    if (!pid) return { error:'存在未选择点位的站' };
    if (seen[pid]) return { error:'同一条方案里点位不能重复' };
    seen[pid] = 1;
  }
  /* 站点快照一律以服务端的点位数据为准，避免前端传入过期的名称 / 坐标 */
  const byId = {};
  d.points.forEach(p => { byId[p.id] = p; });
  const resolved = [];
  for (const s of stops){
    const pt = byId[String(s.pointId)];
    if (!pt) return { error:'点位不存在：' + s.pointId };
    resolved.push({ pointId:pt.id, name:mapNames(pt).zh || '', lng:+pt.lng, lat:+pt.lat });
  }
  return { stops:resolved };
}
let mapCache = null;
function loadMap(){
  if (cloud.enabled){ if (!mapCache) mapCache = shapeMap(cloudGet('map')); return mapCache; }
  try { return shapeMap(JSON.parse(fs.readFileSync(MAP_FILE, 'utf-8'))); }
  catch(e){ return shapeMap(null); }
}
function saveMap(m){
  mapCache = m;
  if (cloud.enabled) return cloudSave('map', m);
  fs.mkdirSync(path.dirname(MAP_FILE), { recursive:true });
  fs.writeFileSync(MAP_FILE, JSON.stringify(m, null, 2), 'utf-8');
}
/* 游客端地图页：露营点（按 campTypes 归到 sea / forest / lake） */
function mapCampPoints(){
  const d = loadMap(), types = d.campTypes;
  return d.points
    .filter(p => mapCats(p).indexOf(MAP_CAMP_KEY) >= 0)
    .map(p => {
      const t = types[p.id];
      return { id:p.id, name:mapNames(p).zh || '', names:mapNames(p), intro:mapI18n(p.intro, MAP_INTRO_MAX),
               lng:+p.lng, lat:+p.lat, categories:[MAP_KIND_KEYS.indexOf(t) >= 0 ? t : 'sea'] };
    });
}
/* 游客端打卡点页：直接读库里 play 分类那批点位，与露营点同一份数据 */
function mapPlayPoints(){
  return loadMap().points
    .filter(p => mapCats(p).indexOf(MAP_PLAY_KEY) >= 0)
    .map(p => ({ id:p.id, name:mapNames(p).zh || '', names:mapNames(p), intro:mapI18n(p.intro, MAP_INTRO_MAX), lng:+p.lng, lat:+p.lat }));
}
/* 打卡点该用的配色 / 图标：沿用后台给 play 分类的配置，两个页面看起来一致 */
function mapPlayKind(){
  const c = loadMap().categories.filter(x => x.key === MAP_PLAY_KEY)[0];
  return c ? { key:c.key, name:c.name, color:c.color, symbol:c.symbol, symbolSize:c.symbolSize } : null;
}
/* 地标层（城市 / 机场）：与露营点分开下发，前端各画一层，互不影响 */
function mapLandmarks(){
  const lm = loadMap().landmarks;
  const keys = {}; lm.groups.forEach(g => { keys[g.key] = 1; });
  return {
    groups: lm.groups,
    points: lm.points.filter(p => keys[p.kind])
  };
}
/* 后台提交校验：类型必须存在、经纬度必须是数字、名称/介绍不超长 */
function validateMapPoint(body, d){
  const cats = Array.isArray(body.categories) ? body.categories.filter(Boolean) : (body.category ? [body.category] : []);
  if (!cats.length) return { error:'请选择点位类型' };
  const keys = {}; d.categories.forEach(c => { keys[c.key] = 1; });
  for (const k of cats) if (!keys[k]) return { error:'点位类型不存在：' + k };
  const lng = +body.lng, lat = +body.lat;
  if (!isFinite(lng) || !isFinite(lat)) return { error:'经纬度无效' };
  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return { error:'经纬度超出范围' };
  const len = v => v == null ? 0 : String(v).trim().length;
  for (const l of MAP_LANGS){
    if (body.names && body.names[l] != null && typeof body.names[l] !== 'string') return { error:'点位名称格式不正确' };
    if (body.intro && body.intro[l] != null && typeof body.intro[l] !== 'string') return { error:'点位介绍格式不正确' };
    if (len(body.names && body.names[l]) > MAP_NAME_MAX) return { error:'点位名称过长（每种语言最多 ' + MAP_NAME_MAX + ' 字）' };
    if (len(body.intro && body.intro[l]) > MAP_INTRO_MAX) return { error:'点位介绍过长（每种语言最多 ' + MAP_INTRO_MAX + ' 字）' };
  }
  const campType = String(body.campType || '').trim();
  if (campType && MAP_KIND_KEYS.indexOf(campType) < 0) return { error:'露营点子类型不存在：' + campType };
  /* 点位名称必填：前台地图靠名称标记与悬浮提示，无名点位对游客没有意义 */
  const names = mapI18n(body.names, MAP_NAME_MAX);
  if (!Object.keys(names).length) return { error:'请至少填写一种语言的点位名称' };
  return { categories:cats, names:names, intro:mapI18n(body.intro, MAP_INTRO_MAX), lng:+lng.toFixed(6), lat:+lat.toFixed(6), campType:campType };
}

/* ---------------- 驾车路线规划（高德 Web 服务 API） ----------------
   高德「驾车路线规划」接口：https://restapi.amap.com/v3/direction/driving
   · 密钥只保存在服务端（环境变量 AMAP_KEY 优先，其次 data/secrets.json 的 amap.key），
     前端不下发、不接触密钥；
   · 点位经纬度已是 GCJ-02（高德坐标系），可直接作为 origin / destination 传入；
   · 返回的 step.polyline 逐段拼接成折线，因此路线贴合真实公路，不是两点直线；
   · 规划结果写回地图数据的 routes 字段持久化，刷新页面不再重复消耗配额。 */
const SIMPLIFY_TOL = 0.0002;      /* 折线抽稀容差（度），约 22m */
const ROUTE_DECIMALS = 5;         /* 坐标保留 5 位小数（约 1m），压缩体积 */
const AMAP_GAP = 250;             /* 个人 Key QPS 很低，调用之间留间隔 */
const LINK_K = 3;                 /* 每个点位连到最近的 K 个点位，推导路线对 */

function amapKey(){ return loadSecrets().amap.key; }

/* 请求高德 Web 服务接口并解析 JSON（零依赖 https） */
function amapGet(url){
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout:15000 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => {
        let j; try { j = JSON.parse(body); } catch(e){ return reject(new Error('高德返回内容无法解析')); }
        if (j.status !== '1') return reject(new Error('高德接口报错：' + (j.info || '未知') + '（infocode ' + (j.infocode || '-') + '）'));
        resolve(j);
      });
    });
    req.on('timeout', () => { req.destroy(new Error('高德接口超时')); });
    req.on('error', reject);
  });
}
function amapGap(){ return new Promise(r => setTimeout(r, AMAP_GAP)); }

/* 关键词搜索是模糊匹配：瞎填也会返回不相干的门店，直接采用会悄悄生成错路线。
   这里要求返回结果的名称与输入至少有 2 个连续相同字符（或互相包含），否则视为没匹配到。 */
function nameMatches(query, resultName){
  const a = String(query), b = String(resultName || '');
  if (!a || !b) return false;
  if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return true;
  for (let i = 0; i + 2 <= a.length; i++) if (b.indexOf(a.substr(i, 2)) >= 0) return true;
  return false;
}

/* 文字 → 经纬度。本图是「海南全岛地图」，优先在岛内解析（不加城市限制时同名地点会被解析到外省）。 */
function geocodePlace(text, key){
  const q = String(text || '').trim();
  if (!q) return Promise.reject(new Error('地点不能为空'));

  const mm = q.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (mm){
    const lng = +mm[1], lat = +mm[2];
    if (lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90) return Promise.resolve({ name:q, lng:lng, lat:lat, source:'coords' });
  }

  const enc = encodeURIComponent(q), k = encodeURIComponent(key);
  return amapGet('https://restapi.amap.com/v3/place/text?keywords=' + enc + '&city=' + encodeURIComponent('海南') + '&offset=5&page=1&key=' + k)
    .catch(() => null)
    .then(j => {
      const list = (j && j.pois) || [];
      for (let i = 0; i < list.length; i++){
        const poi = list[i];
        if (poi && poi.location && nameMatches(q, poi.name)){
          const c = String(poi.location).split(',');
          const area = poi.cityname || poi.adname || '';
          return { name:(poi.name || q) + (area ? '（' + area + '）' : ''), lng:+c[0], lat:+c[1], source:'poi' };
        }
      }
      return amapGet('https://restapi.amap.com/v3/geocode/geo?address=' + enc + '&key=' + k)
        .catch(() => null)
        .then(g => {
          const g0 = g && (g.geocodes || [])[0];
          const addr = g0 && g0.formatted_address;
          if (!g0 || !g0.location || !nameMatches(q, addr)){
            throw new Error('未能定位「' + q + '」，请换个说法，或直接填经纬度（如 109.5,18.3）');
          }
          const c = String(g0.location).split(',');
          return { name:addr || q, lng:+c[0], lat:+c[1], source:'geocode' };
        });
    });
}

/* 两点球面距离（米）。只用于决定「串联顺序」，不参与路线本身（路线一律由高德给）。 */
function metersBetween(a, b){
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/* 路线对（起点→终点）：每个点位连到它最近的 LINK_K 个点位；无向去重，A—B 只规划一次。
   想改成人工指定路线对，只要替换 buildPairs 的返回值即可。 */
function buildPairs(points){
  const seen = {}, pairs = [];
  points.forEach(p => {
    points.filter(q => q.id !== p.id)
      .map(q => ({ q:q, d:metersBetween(p, q) }))
      .sort((x, y) => x.d - y.d)
      .slice(0, LINK_K)
      .forEach(x => {
        const key = p.id < x.q.id ? p.id + '|' + x.q.id : x.q.id + '|' + p.id;
        if (seen[key]) return;
        seen[key] = 1;
        pairs.push({ a:p, b:x.q });
      });
  });
  return pairs;
}

/* 折线抽稀（Douglas–Peucker）：保持贴合公路的形状，去掉密集的冗余点位，把接口体积压掉一个数量级。 */
function simplifyLine(pts, tol){
  if (!Array.isArray(pts) || pts.length < 3) return pts || [];
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  while (stack.length){
    const seg = stack.pop(), i0 = seg[0], i1 = seg[1];
    if (i1 <= i0 + 1) continue;
    const ax = pts[i0][0], ay = pts[i0][1], bx = pts[i1][0], by = pts[i1][1];
    const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
    let maxD = -1, maxI = -1;
    for (let i = i0 + 1; i < i1; i++){
      const px = pts[i][0], py = pts[i][1];
      let d;
      if (len === 0) d = Math.sqrt((px - ax) * (px - ax) + (py - ay) * (py - ay));
      else {
        let t = ((px - ax) * dx + (py - ay) * dy) / len;
        t = t < 0 ? 0 : (t > 1 ? 1 : t);
        const qx = ax + t * dx, qy = ay + t * dy;
        d = Math.sqrt((px - qx) * (px - qx) + (py - qy) * (py - qy));
      }
      if (d > maxD){ maxD = d; maxI = i; }
    }
    if (maxD > tol){ keep[maxI] = true; stack.push([i0, maxI], [maxI, i1]); }
  }
  const out = [];
  for (let k = 0; k < pts.length; k++) if (keep[k]) out.push(pts[k]);
  return out;
}

/* 折线首尾锚定到点位真实坐标（修复「线断 / 漏渲染」的关键）：
   高德驾车折线首末点会吸附到「可通车道路」上，点位位于山顶 / 林场内部时会与点位坐标差 1～2.5km，
   逐段拼接后在点位附近露出缺口。这里把点位坐标直接补到折线首尾，相邻两段严格共用同一个端点，整条链路连续。 */
function anchorEnds(pts, a, b){
  const out = [];
  const push = (lng, lat) => {
    const c = [+(+lng).toFixed(ROUTE_DECIMALS), +(+lat).toFixed(ROUTE_DECIMALS)];
    const last = out[out.length - 1];
    if (!last || last[0] !== c[0] || last[1] !== c[1]) out.push(c);
  };
  push(a.lng, a.lat);
  pts.forEach(c => push(c[0], c[1]));
  push(b.lng, b.lat);
  return out;
}

/* 调一次高德驾车路线，返回 { distance(米), duration(秒), polyline:[[lng,lat], ...] } */
function fetchDrivingLeg(a, b, key){
  const url = 'https://restapi.amap.com/v3/direction/driving' +
    '?origin=' + a.lng + ',' + a.lat +
    '&destination=' + b.lng + ',' + b.lat +
    '&extensions=base&strategy=0&key=' + encodeURIComponent(key);
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout:20000 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => {
        let j; try { j = JSON.parse(body); } catch(e){ return reject(new Error('高德返回内容无法解析')); }
        if (j.status !== '1' || !j.route || !j.route.paths || !j.route.paths.length){
          return reject(new Error('高德接口报错：' + (j.info || '未知') + '（infocode ' + (j.infocode || '-') + '）'));
        }
        const p = j.route.paths[0];
        const coords = [];
        (p.steps || []).forEach(st => {
          String(st.polyline || '').split(';').forEach(pt => {
            const c = pt.split(',');
            if (c.length === 2 && isFinite(+c[0]) && isFinite(+c[1])) coords.push([+c[0], +c[1]]);
          });
        });
        resolve({ distance:+p.distance || 0, duration:+p.duration || 0, polyline:anchorEnds(simplifyLine(coords, SIMPLIFY_TOL), a, b) });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('高德接口超时')); });
    req.on('error', reject);
  });
}

let routeBuilding = false;      /* 同一时间只允许一次规划，避免重复烧配额 */

/* 按当前点位逐段规划并写回地图数据的 routes 字段（串行 + 间隔，避开个人 Key 的 QPS 限流） */
function buildMapRoutes(key, cb){
  const d = loadMap();
  if (!d.points.length) return cb(new Error('还没有任何点位，无法规划路线'));
  if (routeBuilding) return cb(new Error('正在规划中，请稍候'));

  const pairs = buildPairs(d.points);
  const legs = [];
  let i = 0, totalD = 0, totalT = 0;
  routeBuilding = true;

  function step(){
    if (i >= pairs.length){
      const out = {
        generatedAt: new Date().toISOString(),
        linkK: LINK_K,
        points: d.points.map(p => ({ id:p.id, name:mapNames(p).zh || '', lng:+p.lng, lat:+p.lat, categories:mapCats(p) })),
        legs: legs,
        totalDistance: totalD,
        totalDuration: totalT
      };
      try { const cur = loadMap(); cur.routes = out; saveMap(cur); }
      catch(e){ routeBuilding = false; return cb(e); }
      routeBuilding = false;
      console.log('[routes] 规划完成：' + legs.length + ' 条独立路线 / 合计 ' + (totalD / 1000).toFixed(1) + ' km');
      return cb(null, out);
    }
    const a = pairs[i].a, b = pairs[i].b;
    fetchDrivingLeg(a, b, key).then(leg => {
      leg.index = i + 1;
      leg.from = { id:a.id, name:mapNames(a).zh || '', lng:+a.lng, lat:+a.lat };
      leg.to   = { id:b.id, name:mapNames(b).zh || '', lng:+b.lng, lat:+b.lat };
      legs.push(leg);
      totalD += leg.distance; totalT += leg.duration;
      console.log('[routes] 第 ' + (i + 1) + '/' + pairs.length + ' 条：' + (leg.from.name || a.id) + ' → ' + (leg.to.name || b.id) + '  ' + (leg.distance / 1000).toFixed(1) + ' km');
      i++;
      setTimeout(step, 150);            /* 串行 + 间隔，避免触发 QPS 限流 */
    }).catch(e => {
      routeBuilding = false;
      cb(new Error('第 ' + (i + 1) + ' 条（' + (mapNames(a).zh || a.id) + ' → ' + (mapNames(b).zh || b.id) + '）规划失败：' + e.message));
    });
  }
  step();
}

/* ---------------- 校验与归一化 ---------------- */
function normLabel(l){
  l = (l && typeof l === 'object') ? l : {};
  return { zh:String(l.zh||'').trim(), en:String(l.en||'').trim(), ru:String(l.ru||'').trim() };
}
/* 左侧菜单 5 项文案：标题 m0-m4、简介 m0d-m4d；只保留有值的键，留空即用页面内置默认 */
const MENU_TEXT_KEYS = ['m0','m1','m2','m3','m4','m0d','m1d','m2d','m3d','m4d'];
function normMenuTexts(src){
  src = (src && typeof src === 'object') ? src : {};
  const out = {};
  MENU_TEXT_KEYS.forEach(function (k) {
    const v = normLabel(src[k]);
    if (v.zh || v.en || v.ru) out[k] = v;
  });
  return out;
}
/* 关键词三语分存 {zh:[],en:[],ru:[]}；兼容旧平铺数组（按字符脚本归位，仅用于历史数据迁移） */
function normKeywordMap(kw){
  const out = { zh:[], en:[], ru:[] };
  const push = (lang, k) => {
    const s = String(k == null ? '' : k).trim();
    if (s && !out[lang].includes(s)) out[lang].push(s);
  };
  if (Array.isArray(kw)){
    kw.forEach(k => push(detectKeywordLang(String(k)), k));
  } else if (kw && typeof kw === 'object'){
    ['zh','en','ru'].forEach(lang => (Array.isArray(kw[lang]) ? kw[lang] : []).forEach(k => push(lang, k)));
  }
  return out;
}
function normButtons(list, max){
  return (Array.isArray(list) ? list : []).slice(0, max)
    .map(b => ({ label: normLabel(b && b.label) }))
    .filter(b => b.label.zh || b.label.en || b.label.ru);
}
function normalizeHomeButton(b){
  return {
    id: b.id || crypto.randomUUID(),
    keyword: String(b.keyword || '').trim(),
    label: normLabel(b.label)
  };
}
function normalizeLinkTemplate(l){
  l = (l && typeof l === 'object') ? l : {};
  return { text: normLabel(l.text), url: String(l.url || '').trim() };
}
/* 底部链接支持多条、多种链接方式：url 网页 / telegram / whatsapp / tel 电话 / mailto 邮箱 */
const LINK_TYPES = ['url', 'telegram', 'whatsapp', 'tel', 'mailto'];
/* 按类型把后台录入的值合成最终可点击 href；非法/空值返回空串（前端不展示） */
function composeLinkHref(type, value){
  const v = String(value || '').trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) return v;   // 已带协议：各类型都原样放行（如 t.me/xxx、wa.me/xxx 完整链接）
  if (type === 'telegram') return 'https://t.me/' + v.replace(/^@/, '');
  if (type === 'whatsapp'){
    const num = v.replace(/[^\d]/g, '');
    return num ? 'https://wa.me/' + num : '';
  }
  if (type === 'tel'){
    const num = v.replace(/[^\d+]/g, '');
    return num ? 'tel:' + num : '';
  }
  if (type === 'mailto') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? 'mailto:' + v : '';
  return 'https://' + v.replace(/^\/+/, '');
}
function normalizeLinkItem(x){
  x = (x && typeof x === 'object') ? x : {};
  const type = LINK_TYPES.indexOf(x.type) >= 0 ? x.type : 'url';
  const value = String(x.value != null ? x.value : (x.url || '')).trim().slice(0, 500);
  return { id: x.id || crypto.randomUUID(), type: type, text: normLabel(x.text), value: value };
}
/* links 为新结构（数组）；legacy 为旧版单链接对象 {text,url}，links 为空时自动迁移过来 */
function normalizeLinks(list, legacy){
  const arr = (Array.isArray(list) ? list : []).map(normalizeLinkItem).filter(x => x.value);
  if (!arr.length && legacy && legacy.url){
    arr.push(normalizeLinkItem({ type:'url', text: legacy.text, value: legacy.url }));
  }
  return arr.slice(0, 20);
}
/* 规则「追加消息」：主回复之后按顺序逐条发送的补充消息。
   每条 = 三语文案 + 延时（秒，相对上一条消息的等待时间，0~60）；z 空则丢弃；最多 8 条 */
function normExtraMsgs(list){
  return (Array.isArray(list) ? list : []).slice(0, 8).map(function (x) {
    x = (x && typeof x === 'object') ? x : {};
    const text = normLabel(x.text);
    const n = Number(x.delay);
    const delay = (isFinite(n) && n > 0) ? Math.min(60, Math.round(n * 10) / 10) : 0;
    return { text: text, delay: delay };
  }).filter(function (x) { return x.text.zh || x.text.en || x.text.ru; });
}
function normalizeRule(r){
  const type = (r.type === 'fuzzy') ? 'fuzzy' : 'exact';
  const keywords = normKeywordMap(r.keywords);
  const reply = normLabel(r.reply);
  const quickButtons = normButtons(r.quickButtons, 4);
  const enabled = r.enabled === false ? false : true;
  const appendLink = r.appendLink === true;   // 是否附加底部链接，默认关闭
  const cardId = String(r.cardId || '').trim().slice(0, 64);   // 绑定的页面卡片 ID（空=不绑定）
  const cn = Number(r.cardDelay);
  // 卡片发送延时：关键词命中后等多少秒才发卡片（默认 1.5，0~60；0 = 与文字回复同时）
  const cardDelay = (isFinite(cn) && cn >= 0) ? Math.min(60, Math.round(cn * 10) / 10) : 1.5;
  const extra = normExtraMsgs(r.extra);                        // 主回复之后按顺序逐条追加的消息（每条自带延时）
  return { id: r.id || crypto.randomUUID(), type, keywords, reply, quickButtons, enabled, appendLink, cardId, cardDelay, extra };
}
function normalizeFallback(fb){
  fb = fb || {};
  return {
    reply: normLabel(fb.reply),
    quickButtons: normButtons(fb.quickButtons, 4),
    appendLink: fb.appendLink === true          // 兜底同样支持附加链接，默认关闭
  };
}

/* ---------------- 匹配逻辑（精准 > 模糊 > 兜底；关键词按界面语种隔离） ---------------- */
/* 识别单条关键词的语种：含西里尔字母→俄语，含汉字→中文，其余→英语（仅用于旧数据迁移归位） */
function detectKeywordLang(kw){
  if (/\p{Script=Cyrillic}/u.test(kw)) return 'ru';
  if (/\p{Script=Han}/u.test(kw)) return 'zh';
  return 'en';
}
function matchInput(input, lang){
  const data = loadData();
  const text = String(input || '').trim();
  // 语言隔离：仅使用与前端界面语种对应的「XX关键词」框内容；语种非法时不匹配任何规则（禁止跨语种命中）
  const kwOf = r => (lang === 'zh' || lang === 'en' || lang === 'ru') ? (r.keywords[lang] || []) : [];
  if (text){
    const enabled = data.rules.filter(r => r.enabled !== false);
    // 精准匹配
    for (const r of enabled){
      if (r.type !== 'exact') continue;
      if (kwOf(r).some(k => text === k)) return { ...r, isFallback:false };
    }
    // 模糊匹配
    for (const r of enabled){
      if (r.type !== 'fuzzy') continue;
      if (kwOf(r).some(k => k && text.includes(k))) return { ...r, isFallback:false };
    }
  }
  return { ...data.fallback, isFallback:true };
}
function matchPayload(hit){
  const data = loadData();
  // 仅当该规则/兜底开启 appendLink 时，附加全部已配置的底部链接（多条、按类型合成 href）
  let links = [];
  if (hit.appendLink === true && Array.isArray(data.links)){
    links = data.links
      .map(l => ({ text: l.text, href: composeLinkHref(l.type, l.value), type: l.type }))
      .filter(l => l.href);
  }
  /* 兼容旧版前端/历史消息：link 取第一条（旧结构 {text,url}） */
  const link = links.length ? { text: links[0].text, url: links[0].href } : null;
  /* 规则绑定的页面卡片：仅当卡片存在且启用时下发；游客端按当前语种渲染标题/简介 */
  let card = null;
  if (hit.cardId){
    const c = data.cards.filter(function (x) { return x.id === hit.cardId && x.enabled !== false; })[0];
    if (c && c.url) card = { id:c.id, pageKey:c.pageKey, url:c.url, cover:c.cover, titles:c.titles, descs:c.descs };
  }
  return {
    reply: hit.reply || { zh:'', en:'', ru:'' },
    quickButtons: hit.quickButtons || [],
    matched: !hit.isFallback,
    link,
    links,
    card,
    cardDelay: (typeof hit.cardDelay === 'number' && hit.cardDelay >= 0) ? hit.cardDelay : 1.5,  // 卡片发送延时（秒）
    extra: Array.isArray(hit.extra) ? hit.extra : []   // 主回复之后按顺序逐条追加的消息
  };
}
/* 关键词回复写入会话流：按顺序逐条写入，每条附带「相对上一条」的延时 delayMs。
   顺序：主回复（立即）→ 页面卡片（等「卡片发送延时」后发出，卡片慢一点发）→ 追加消息依次累加。
   无卡片时主回复仍是第 1 条（立即），追加消息紧随其后，节奏不变。
   游客端按 delayMs 依次展示（上一条显示完再显示下一条）；总开关关闭时全部为 0，即瞬时发出（旧行为）。 */
function pushRuleMsgs(sid, payload, seqEnabled){
  let acc = 0;
  const hasCard = !!payload.card;
  // 卡片发送延时（秒）：关键词命中后等多少秒才发卡片；旧规则无此字段时兜底 1.5，0 表示与主回复同时
  const cd = (typeof payload.cardDelay === 'number' && payload.cardDelay >= 0) ? payload.cardDelay : 1.5;
  const rep = payload.reply || {};
  if (rep.zh || rep.en || rep.ru){
    addMsg(sid, { role:'bot', reply:payload.reply, quickButtons:payload.quickButtons, link:payload.link, links:payload.links, delayMs: 0 });
  }
  if (hasCard){
    acc = seqEnabled ? acc + Math.round(cd * 1000) : 0;
    addMsg(sid, { role:'bot', card:payload.card, delayMs: acc });
  }
  (payload.extra || []).forEach(function (e) {
    const t = e.text || {};
    if (!(t.zh || t.en || t.ru)) return;
    acc = seqEnabled ? acc + (+e.delay || 0) * 1000 : 0;
    addMsg(sid, { role:'bot', reply:{ zh:t.zh || '', en:t.en || '', ru:t.ru || '' }, delayMs: acc });
  });
}

/* ---------------- HTTP 工具 ---------------- */
function send(res, status, body){
  const isJson = typeof body === 'object';
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,PATCH,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(isJson ? JSON.stringify(body) : body);
}
function readBody(req, maxBytes){
  return new Promise((resolve) => {
    let raw = '', size = 0, over = false;
    const limit = maxBytes || 0;                 // 传入上限时超限即截断（防止超大请求打爆内存）
    req.on('data', c => {
      if (over) return;
      size += c.length;
      if (limit && size > limit){ over = true; raw = ''; return; }
      raw += c;
    });
    req.on('end', () => {
      if (over) return resolve({ __tooLarge:true });
      try { resolve(JSON.parse(raw || '{}')); }
      catch { resolve({}); }
    });
  });
}

/* ---------------- 文章资讯：数据结构与工具 ----------------
   文章与站点配置同存于 rules 文档的 articles 数组；配图只存媒体引用（/api/media/<id>），不落 base64。
   状态：draft（草稿，公开页面 404，仅后台可预览）| published（已发布，生成独立页面供 Yandex 等爬虫抓取） */
function slugify(s){
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
const ART_LANGS = ['zh', 'en', 'ru'];
/* 一篇文章的三语内容：中文/英文/俄语各自独立录入（不自动翻译、不预设文案） */
function normArtI18n(a){
  const src = (a && typeof a.i18n === 'object' && a.i18n) ? a.i18n : {};
  const out = {};
  ART_LANGS.forEach(l => {
    /* 兼容旧数据：无 i18n 时，把原单语 title/body 视为中文 */
    const v = (src[l] && typeof src[l] === 'object') ? src[l]
      : (l === 'zh' && (a.title || a.body) ? { title:a.title, body:a.body } : {});
    out[l] = { title: String(v.title || '').slice(0, 200), body: String(v.body || '').slice(0, 20000) };
  });
  return out;
}
/* 主语言：优先中文，其次英文/俄语（用于无 lang 参数时的默认渲染、slug 生成回退、后台列表展示） */
function artPrimary(i18n){
  for (const l of ART_LANGS){
    const v = (i18n && i18n[l]) || {};
    if (String(v.title || '').trim() || String(v.body || '').trim()) return { lang:l, title:v.title, body:v.body };
  }
  return { lang:'zh', title:'', body:'' };
}
/* 取指定语言内容；该语种为空时回退主语言，保证任何语言下都有内容可显示 */
function artLang(i18n, l){
  const v = (i18n && i18n[l]) || {};
  if (String(v.title || '').trim() || String(v.body || '').trim()) return v;
  const p = artPrimary(i18n);
  return { title:p.title, body:p.body };
}
function normArticle(input, all){
  const a = (input && typeof input === 'object') ? input : {};
  const id = a.id || crypto.randomUUID();
  const others = (all || []).filter(x => x && x.id !== id);
  const i18n = normArtI18n(a);
  const primary = artPrimary(i18n);
  const base = slugify(a.slug)
    || slugify(i18n.en.title) || slugify(i18n.zh.title) || slugify(i18n.ru.title)
    || ('a' + crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 8));   // 纯中文标题无可用 ASCII 时回退短码
  let slug = base, n = 2;
  while (others.some(x => x.slug === slug)) slug = base + '-' + (n++);                   // 保证 slug 全局唯一
  const status = a.status === 'published' ? 'published' : 'draft';
  const createdAt = a.createdAt || Date.now();
  /* 历史别名：曾用过、现已改掉的 slug 保留下来，旧链接自动 301 跳到当前页面，保证已收录地址不失效 */
  const prevSlugs = Array.from(new Set((Array.isArray(a.prevSlugs) ? a.prevSlugs : []).map(String).filter(Boolean)))
    .filter(s => s !== slug);
  return {
    id,
    slug,
    prevSlugs,
    i18n,                        // 三语正文与标题（唯一内容源）
    title: primary.title,        // 兼容/展示字段：主语言标题
    body: primary.body,          // 兼容字段：主语言正文
    cover: String(a.cover || '').slice(0, 300),
    status,
    createdAt,
    updatedAt: a.updatedAt || createdAt,
    publishedAt: status === 'published' ? (a.publishedAt || createdAt) : (a.publishedAt || 0)
  };
}
/* 校验：至少填写一种语言的标题（前端三框可任填） */
function artHasTitle(body){
  const src = (body && typeof body.i18n === 'object' && body.i18n) ? body.i18n : {};
  return ART_LANGS.some(l => String(((src[l] || {}).title) || '').trim()) || String((body && body.title) || '').trim();
}
/* ---------------- 商业活动：数据结构（与文章资讯完全分开存储） ----------------
   与文章资讯不同：不需要独立页面 / slug / SEO，仅用于前端左侧「商业活动」板块的卡片与详情展示。
   配图同样只存媒体引用（/api/media/<id>），不落 base64。 */
function normEvent(input){
  const e = (input && typeof input === 'object') ? input : {};
  const id = e.id || crypto.randomUUID();
  const i18n = normArtI18n(e);
  const primary = artPrimary(i18n);
  const createdAt = e.createdAt || Date.now();
  return {
    id,
    i18n,                        // 三语标题与正文（唯一内容源）
    title: primary.title,        // 兼容/展示字段：主语言标题
    body: primary.body,          // 兼容字段：主语言正文
    cover: String(e.cover || '').slice(0, 300),
    createdAt,
    updatedAt: e.updatedAt || createdAt
  };
}
function articlePath(a){ return '/article/' + a.slug; }

/* ---------------- 页面卡片（聊天里发送的方块富媒体卡片） ----------------
   每张卡片绑定一个页面：卡片标题 / 简介 / 封面图 / 跳转地址，三语文案分开配置。
   目前【全岛游】(/island) 与【海南项目体验】(/experience) 是站内真页面（整条链路在同一站内），
   其余三个页面（租房/租车/合作）后续另做，卡片 url 先留空待填；pageKey 用于关键词规则与人工发送时识别归属页面。 */
const CARD_PAGES = [
  { key:'island',    url:'/island', names:{ zh:'全岛游',           en:'Island Tour',              ru:'Островной тур' } },
  { key:'rent',      url:'',        names:{ zh:'租房',             en:'Housing Rental',           ru:'Аренда жилья' } },
  { key:'car',       url:'',        names:{ zh:'租车',             en:'Car Rental',               ru:'Аренда авто' } },
  { key:'review',    url:'/experience', names:{ zh:'海南项目体验评价', en:'Hainan Project Reviews',   ru:'Отзывы о проектах Хайнаня' } },
  { key:'cooperate', url:'',        names:{ zh:'加入我们合作',     en:'Join Us & Cooperate',      ru:'Сотрудничество' } }
];
function cardPageByKey(key){ return CARD_PAGES.filter(function (p) { return p.key === key; })[0] || null; }
function normCard(input){
  const c = (input && typeof input === 'object') ? input : {};
  const id = c.id || crypto.randomUUID();
  const pageKey = cardPageByKey(c.pageKey) ? c.pageKey : 'island';
  const page = cardPageByKey(pageKey);
  /* 跳转地址：页面已有固定路由时锁定为页面地址，否则用手动填写的 url（后续新页面用） */
  const url = page.url || String(c.url || '').trim().slice(0, 300);
  return {
    id,
    pageKey,
    url,
    cover: String(c.cover || '').slice(0, 300),
    titles: normLabel(c.titles),   // 三语卡片标题
    descs: normLabel(c.descs),     // 三语卡片简介
    enabled: c.enabled === false ? false : true,
    createdAt: c.createdAt || Date.now(),
    updatedAt: c.updatedAt || Date.now()
  };
}
/* 校验卡片：至少一种语言标题；url 必须是站内路径或 http(s) 外链 */
function validateCard(body){
  const titles = normLabel(body && body.titles);
  if (!titles.zh && !titles.en && !titles.ru) return '请至少填写一种语言的卡片标题';
  const pageKey = body && body.pageKey;
  if (!cardPageByKey(pageKey)) return '未知页面：' + pageKey;
  const page = cardPageByKey(pageKey);
  const url = page.url || String((body && body.url) || '').trim();
  if (url && !/^(\/|https?:\/\/)/.test(url)) return '跳转地址必须是站内路径或 http(s) 链接';
  return null;
}
/* 爬虫识别：Yandex 系 UA（YandexBot / YandexImages / YandexMobileBot 等）统一命中 */
function isYandexBot(ua){ return /yandex/i.test(String(ua || '')); }
/* 某 slug 被当前文章启用后，把它从其它文章的历史别名里摘除，避免留下指向别处的死重定向 */
function pruneAliases(all, art){
  for (const a of all){
    if (a.id === art.id) continue;
    if (Array.isArray(a.prevSlugs) && a.prevSlugs.length) a.prevSlugs = a.prevSlugs.filter(s => s !== art.slug);
  }
}
/* 解析 /article/<slug>：优先命中当前 slug；未命中时看是否命中某篇的「历史别名」→ 返回新地址供 301 跳转 */
function resolveArticleSlug(slug){
  const arts = loadData().articles;
  const art = arts.find(a => a.slug === slug);
  if (art) return { art, redirect:'' };
  const moved = arts.find(a => (a.prevSlugs || []).includes(slug));
  if (moved && moved.status === 'published') return { art:null, redirect:articlePath(moved) };
  return { art:null, redirect:'' };
}
function escHtml(s){
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
/* 正文按空行分段、段内换行转 <br>，整体转义（防止录入内容注入脚本） */
function bodyToHtml(body){
  const paras = String(body || '').replace(/\r\n?/g, '\n').split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  return paras.map(p => '<p>' + escHtml(p).replace(/\n/g, '<br>') + '</p>').join('\n') || '<p></p>';
}
/* 文本类响应按需 gzip 压缩（体积约降 75%，手机端首屏更快）；客户端不支持或已是图片等二进制格式时原样发送 */
const GZIP_MIN = 1024;
function sendMaybeGzip(req, res, status, headers, body){
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ''), 'utf-8');
  const type = headers['Content-Type'] || '';
  const compressible = /^(text\/|application\/(javascript|json|xml)|image\/svg)/i.test(type);
  const accepts = /\bgzip\b/i.test(String((req && req.headers && req.headers['accept-encoding']) || ''));
  if (!accepts || !compressible || buf.length < GZIP_MIN){
    headers['Content-Length'] = buf.length;
    res.writeHead(status, headers);
    return res.end(buf);
  }
  zlib.gzip(buf, (err, gz) => {
    if (err){   // 压缩失败时回退为原样发送，保证请求不失败
      headers['Content-Length'] = buf.length;
      res.writeHead(status, headers);
      return res.end(buf);
    }
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = headers['Vary'] ? headers['Vary'] + ', Accept-Encoding' : 'Accept-Encoding';
    headers['Content-Length'] = gz.length;
    res.writeHead(status, headers);
    res.end(gz);
  });
}
function sendHtml(req, res, status, html, varyUA){
  const h = { 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-cache', 'X-Content-Type-Options':'nosniff' };
  if (varyUA) h['Vary'] = 'User-Agent';   // 文章页内容随 UA 变化（Yandex 定向俄语），需声明 Vary 避免中间缓存串内容
  sendMaybeGzip(req, res, status, h, html);
}
const ARTICLE_CSS = 'body{margin:0;background:#f6f7f9;color:#22282f;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB",Roboto,sans-serif;line-height:1.75}'
  + 'main{max-width:760px;margin:0 auto;padding:32px 20px 64px;background:#fff;min-height:100vh;box-sizing:border-box}'
  + '.back{display:inline-block;margin-bottom:18px;font-size:13px;color:#2f7cf6;text-decoration:none}'
  + 'h1{font-size:26px;line-height:1.35;margin:0 0 10px}'
  + '.meta{color:#8b94a0;font-size:13px;margin-bottom:20px}'
  + '.cover{display:block;width:100%;max-height:420px;object-fit:cover;border-radius:12px;margin:0 0 24px}'
  + 'article p{margin:0 0 16px;font-size:16px}';
/* 文章独立页面：服务端直出，含 title/description/canonical/hreflang/og/JSON-LD，便于爬虫抓取收录
   同一篇文章共用同一 URL/slug；按 lang 参数输出对应语种内容（缺省用主语言），canonical 始终指向不带参数的干净地址
   hreflang 交替标签声明 zh/en/ru 三个语言版本，避免多语言同源内容被判重复 */
function articlePageHtml(art, preview, l){
  const c = artLang(art.i18n, l || '');
  const title = c.title || art.title;
  const body = c.body || art.body;
  const url = PUBLIC_BASE_URL + articlePath(art);
  const desc = String(body || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const img = art.cover ? (/^https?:/i.test(art.cover) ? art.cover : PUBLIC_BASE_URL + art.cover) : '';
  const published = new Date(art.publishedAt || art.createdAt).toISOString();
  const modified = new Date(art.updatedAt || art.createdAt).toISOString();
  const ld = { '@context':'https://schema.org', '@type':'Article', headline:title, datePublished:published, dateModified:modified, mainEntityOfPage:url };
  if (img) ld.image = [img];
  const htmlLang = (l === 'zh') ? 'zh-CN' : (ART_LANGS.includes(l) ? l : 'zh-CN');
  const alternates = ART_LANGS.map(x => '<link rel="alternate" hreflang="' + x + '" href="' + escHtml(url + '?lang=' + x) + '">').join('\n')
    + '\n<link rel="alternate" hreflang="x-default" href="' + escHtml(url) + '">';
  return '<!DOCTYPE html>\n<html lang="' + htmlLang + '">\n<head>\n'
    + '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n'
    + '<title>' + escHtml(title) + '</title>\n'
    + '<meta name="description" content="' + escHtml(desc) + '">\n'
    + '<link rel="canonical" href="' + escHtml(url) + '">\n'
    + alternates + '\n'
    + '<meta property="og:type" content="article">\n'
    + '<meta property="og:title" content="' + escHtml(title) + '">\n'
    + '<meta property="og:description" content="' + escHtml(desc) + '">\n'
    + '<meta property="og:url" content="' + escHtml(url) + '">\n'
    + (img ? '<meta property="og:image" content="' + escHtml(img) + '">\n' : '')
    + '<meta name="robots" content="' + (preview ? 'noindex,nofollow' : 'index,follow') + '">\n'
    + '<script type="application/ld+json">' + JSON.stringify(ld) + '</script>\n'
    + '<style>' + ARTICLE_CSS + '</style>\n</head>\n<body>\n<main>\n'
    + '<a class="back" href="/">← 返回首页</a>\n'
    + '<h1>' + escHtml(title) + '</h1>\n'
    + '<div class="meta">' + published.slice(0, 10) + (preview ? ' · 草稿预览（未发布，不收录）' : '') + '</div>\n'
    + (img ? '<img class="cover" src="' + escHtml(img) + '" alt="' + escHtml(title) + '">\n' : '')
    + '<article>\n' + bodyToHtml(body) + '\n</article>\n</main>\n</body>\n</html>';
}
function articleNotFoundHtml(){
  return '<!DOCTYPE html>\n<html lang="zh">\n<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>页面不存在</title><meta name="robots" content="noindex">'
    + '<style>body{font-family:-apple-system,"Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;color:#22282f}a{color:#2f7cf6}</style></head>'
    + '<body><div style="text-align:center"><h1 style="font-size:20px">404 · 页面不存在</h1><p><a href="/">返回首页</a></p></div></body></html>';
}
/* sitemap：列出首页与全部已发布文章，供 Yandex 等爬虫发现 */
function sitemapXml(){
  const items = loadData().articles.filter(a => a.status === 'published').sort((x, y) => (y.publishedAt || 0) - (x.publishedAt || 0));
  const urls = ['<url><loc>' + escHtml(PUBLIC_BASE_URL) + '/</loc><changefreq>daily</changefreq></url>']
    .concat(items.map(a => '<url><loc>' + escHtml(PUBLIC_BASE_URL + articlePath(a)) + '</loc>'
      + '<lastmod>' + new Date(a.updatedAt || a.createdAt).toISOString().slice(0, 10) + '</lastmod></url>'));
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + urls.join('\n') + '\n</urlset>\n';
}

const MIME = {
  '.html':'text/html; charset=utf-8',
  '.js':'application/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8',
  '.svg':'image/svg+xml',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg'
};
function serveStatic(req, res){
  let urlPath = req.url.split('?')[0];
  try { urlPath = decodeURIComponent(urlPath); } catch(e){}
  if (urlPath === '/' || /^\/tg\/[A-Za-z0-9_-]+$/.test(urlPath)) urlPath = '/index.html';
  /* 全岛游地图子页面：站内路径，不对外暴露地图自己的独立网址（/island → 露营点地图，/island/spots → 打卡点页） */
  if (urlPath === '/island' || urlPath === '/island/') urlPath = '/island/camp.html';
  if (urlPath === '/island/spots' || urlPath === '/island/spots/') urlPath = '/island/camp-next.html';
  /* 海南项目体验（站内整条链路：项目列表 → 项目详情 → 预订 → 预订成功）。
     /experience 及其子路径都交给同一份前端入口，由前端路由接管；
     真实存在的静态文件（assets 等）照常直出，找不到才回退到 index.html。 */
  if (urlPath === '/experience' || urlPath === '/experience/') {
    urlPath = '/experience/index.html';
  } else if (urlPath.startsWith('/experience/') && path.extname(urlPath) === '') {
    urlPath = '/experience/index.html';
  }
  /* 安全：禁止通过静态资源访问 data 目录（users/auth/secrets 等敏感数据），杜绝密钥泄露 */
  if (/^\/data(\/|$)/i.test(urlPath)) return send(res, 404, 'Not Found');
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'Not Found');
    const ext = path.extname(filePath).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    /* HTML 页面禁止缓存：移动端浏览器容易复用旧页面，导致前端改动看不到 */
    if (ext === '.html') headers['Cache-Control'] = 'no-cache';
    /* 地图用的两个大文件（echarts ~1MB / 地理边界）内容极少变动：允许浏览器缓存，
       避免每次进入地图子页面都重新下载一遍 */
    if (/[\\/]island[\\/](echarts\.min\.js|hainan\.geojson\.js)$/.test(filePath)) headers['Cache-Control'] = 'public, max-age=86400';
    sendMaybeGzip(req, res, 200, headers, data);
  });
}

/* ---------------- 人工消息自动翻译（仅用于人工收发消息，机器人自动回复不经过机器翻译） ---------------- */
const TR_CACHE = new Map();
const TR_PENDING = new Map();     // 同一文本并发翻译去重
let TR_COOLDOWN_UNTIL = 0;        // 熔断冷却：翻译服务连续失败后 60s 内直接快速失败
function trFetch(url){
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 6000 }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => resolve(d));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}
/* translateText(text, 'zh-CN'|'en'|'ru') → 译文；失败返回 null（调用方按原文处理） */
async function translateText(text, to){
  text = String(text || '').trim();
  to = (to === 'zh') ? 'zh-CN' : to;
  if (!text || ['zh-CN','en','ru'].indexOf(to) < 0) return null;
  const key = to + '|' + text;
  if (TR_CACHE.has(key)) return TR_CACHE.get(key);
  /* 熔断冷却期内不发起外网请求，立即失败，避免轮询接口被拖死 */
  if (Date.now() < TR_COOLDOWN_UNTIL) return null;
  /* 同一文本的并发请求复用同一个翻译任务 */
  if (TR_PENDING.has(key)) return TR_PENDING.get(key);
  const q = encodeURIComponent(text.slice(0, 1200));
  const endpoints = [
    `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${to}&dt=t&q=${q}`,
    `https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=${to}&q=${q}`,
    `https://clients5.google.com/translate_a/single?client=gtx&sl=auto&tl=${to}&dt=t&q=${q}`
  ];
  const parse = (raw, idx) => {
    const j = JSON.parse(raw);
    if (idx === 1) return Array.isArray(j) ? (Array.isArray(j[0]) ? String(j[0][0] || '') : String(j[0] || '')) : '';
    return (Array.isArray(j) && Array.isArray(j[0])) ? j[0].map(x => (x && x[0]) || '').join('') : '';
  };
  const job = (async () => {
    /* 3 个端点 + 最多 2 次重试，应对限流/瞬时网络抖动 */
    for (let attempt = 0; attempt < 3; attempt++){
      for (let i = 0; i < endpoints.length; i++){
        try {
          const raw = await trFetch(endpoints[i]);
          const out = parse(raw, i);
          if (out){ TR_CACHE.set(key, out); TR_COOLDOWN_UNTIL = 0; return out; }
        } catch(e){}
      }
      if (attempt < 2) await new Promise(r => setTimeout(r, 400));
    }
    /* 全部失败 → 熔断 60 秒，期间翻译快速失败（按原文兜底），恢复后自动熔断解除 */
    TR_COOLDOWN_UNTIL = Date.now() + 60000;
    return null;
  })();
  TR_PENDING.set(key, job);
  try { return await job; } finally { TR_PENDING.delete(key); }
}

/* ---------------- 人工介入聊天：会话存储 ---------------- */
const CHAT_FILE = path.join(ROOT, 'data', 'chats.json');
let chatCache = null;
function loadChats(){
  if (chatCache) return chatCache;
  if (cloud.enabled){
    const raw = cloudGet('chats');
    chatCache = (raw && typeof raw === 'object') ? raw : { sessions:{} };
  } else {
    try { chatCache = JSON.parse(fs.readFileSync(CHAT_FILE, 'utf-8')); }
    catch(e){ chatCache = { sessions:{} }; }
  }
  if (!chatCache.sessions || typeof chatCache.sessions !== 'object') chatCache.sessions = {};
  return chatCache;
}
function saveChats(){
  if (cloud.enabled) return cloudSave('chats', loadChats());
  fs.writeFileSync(CHAT_FILE, JSON.stringify(loadChats(), null, 2), 'utf-8');
}
/* 后台三语展示：异步为会话消息补齐译文（客户消息 transZh/transEn/transRu，人工消息按原文补 transEn/transRu）。
   不阻塞本次响应，完成后落库；同会话并发去重（TR_INFLIGHT）。英译/俄译一律落库，避免"暂不可用"误判。
   ?since= 增量路由与 GET /api/chat/:id 全量路由共用此函数。 */
function scheduleTrFill(s){
  if (!s || s.ended || !loadData().agentChat.translate) return;
  const msgs = s.messages || [];
  const need = msgs.filter(m => {
    if (!m || !m.text) return false;
    if (m.role === 'visitor') return !m.transZh || !m.transEn || !m.transRu;
    if (m.role === 'agent') return !m.transEn || !m.transRu;
    return false;
  });
  const TR_INFLIGHT = (global.__trInflight = global.__trInflight || new Set());
  if (!need.length || TR_INFLIGHT.has(s.id)) return;
  TR_INFLIGHT.add(s.id);
  Promise.all(need.map(async m => {
    const src = (m.role === 'agent' && m.origText) ? m.origText : m.text;
    const jobs = [];
    if (m.role === 'visitor' && !m.transZh) jobs.push(translateText(src, 'zh-CN').then(t => { if (t && t !== src) m.transZh = t; }));
    if (!m.transEn) jobs.push(translateText(src, 'en').then(t => { if (t) m.transEn = t; }));
    if (!m.transRu) jobs.push(translateText(src, 'ru').then(t => { if (t) m.transRu = t; }));
    await Promise.all(jobs);
  })).then(() => saveChats()).catch(() => {}).finally(() => TR_INFLIGHT.delete(s.id));
}
function getSession(id){
  const db = loadChats();
  if (!db.sessions[id]) db.sessions[id] = { id, mode:'bot', createdAt:Date.now(), messages:[] };
  return db.sessions[id];
}
function addMsg(sid, m){
  const s = getSession(sid);
  m.id = s.messages.length ? s.messages[s.messages.length - 1].id + 1 : 1;
  m.ts = Date.now();
  s.messages.push(m);
  if (s.messages.length > 500) s.messages.splice(0, s.messages.length - 500);
  saveChats();
  return m;
}

/* 全岛游行程提交的访客消息文案：按游客当前界面语种拼接，后台人工可在实时对话里翻译 */
function islandSummary(lang, d){
  const L = {
    zh: { title:'【全岛游打卡提交】', camp:'露营点', spots:'打卡点', none:'（未选择）', sep:'、',
          tour:'出行方式', tourPrivate:'免拼', tourShared:'拼团',
          tents:'帐篷数量', tentType:'帐篷类型', tentSingle:'单人帐篷', tentShared:'多人共用大帐篷',
          sug:function (s){ return s ? '建议 ' + s + ' 座车' : '人数较多，车型需定制'; },
          people:function (n, s){ return '出行人数: ' + n + ' 人 · ' + s + ' · 露营装备 ' + n + ' 套'; },
          tentsLine:function (n, t){ return '帐篷: ' + n + ' 顶' + (t ? '（' + t + '）' : ''); },
          priceP:function (v, p){ return '包车价格: ' + v + ' 座车 ¥' + p; },
          priceS:function (v, pp, n, sum){ return '拼团价格: ' + v + ' 座 ¥' + pp + '/人 × ' + n + ' 人 = ¥' + sum; } },
    en: { title:'[Island tour check-in]', camp:'Campsite', spots:'Spots', none:'(none)', sep:', ',
          tour:'Tour type', tourPrivate:'Private Tour', tourShared:'Shared Tour',
          tents:'Tents', tentType:'Tent type', tentSingle:'Single tent', tentShared:'Shared large tent',
          sug:function (s){ return s ? 'Suggested ' + s + '-seat vehicle' : 'Larger group — vehicle to be customized'; },
          people:function (n, s){ return 'Travelers: ' + n + ' · ' + s + ' · Camping gear ×' + n; },
          tentsLine:function (n, t){ return 'Tents: ' + n + (t ? ' (' + t + ')' : ''); },
          priceP:function (v, p){ return 'Charter price: ' + v + '-seat car ¥' + p; },
          priceS:function (v, pp, n, sum){ return 'Shared price: ' + v + '-seat ¥' + pp + '/pax × ' + n + ' = ¥' + sum; } },
    ru: { title:'[Отметка на экскурсии]', camp:'Кемпинг', spots:'Места', none:'(нет)', sep:', ',
          tour:'Формат тура', tourPrivate:'Индивидуальный тур', tourShared:'Совместный тур',
          tents:'Палатки', tentType:'Тип палатки', tentSingle:'Одноместная палатка', tentShared:'Общая большая палатка',
          sug:function (s){ return s ? 'Рекомендуется ' + s + '-местный автомобиль' : 'Большая группа — транспорт подбирается индивидуально'; },
          people:function (n, s){ return 'Человек: ' + n + ' · ' + s + ' · Снаряжение ×' + n; },
          tentsLine:function (n, t){ return 'Палаток: ' + n + (t ? ' (' + t + ')' : ''); },
          priceP:function (v, p){ return 'Цена аренды авто: ' + v + '-местный ¥' + p; },
          priceS:function (v, pp, n, sum){ return 'Цена совместного тура: ' + v + '-местный ¥' + pp + '/чел. × ' + n + ' = ¥' + sum; } }
  }[lang] || {
    title:'【全岛游打卡提交】', camp:'露营点', spots:'打卡点', none:'（未选择）', sep:'、',
    tour:'出行方式', tourPrivate:'免拼', tourShared:'拼团',
    tents:'帐篷数量', tentType:'帐篷类型', tentSingle:'单人帐篷', tentShared:'多人共用大帐篷',
    sug:function (s){ return s ? '建议 ' + s + ' 座车' : '人数较多，车型需定制'; },
    people:function (n, s){ return '出行人数: ' + n + ' 人 · ' + s + ' · 露营装备 ' + n + ' 套'; },
    tentsLine:function (n, t){ return '帐篷: ' + n + ' 顶' + (t ? '（' + t + '）' : ''); },
    priceP:function (v, p){ return '包车价格: ' + v + ' 座车 ¥' + p; },
    priceS:function (v, pp, n, sum){ return '拼团价格: ' + v + ' 座 ¥' + pp + '/人 × ' + n + ' 人 = ¥' + sum; }
  };
  /* 人数匹配车型（座位数含司机，乘客上限 3/6/8）：1-3 人 → 4 座，4-6 人 → 7 座，7-8 人 → 9 座，9 人需定制 */
  function seatsOf(n){ return n <= 3 ? 4 : (n <= 6 ? 7 : (n <= 8 ? 9 : 0)); }
  /* 按 ID 反查点位名称，只输出地名（不带 p_mv 编码），
     ID 仍保留在消息结构化字段 island.campId / island.spots 里供后台识别 */
  const all = loadMap().points;
  function nameOf(id){
    const p = all.filter(function (x) { return x.id === id; })[0];
    if (!p) return id;
    return (p.names && (p.names[lang] || p.names.zh)) || p.name || id;
  }
  const lines = [
    L.title,
    L.camp + ': ' + nameOf(d.campId),
    L.spots + ': ' + (d.spots.length ? d.spots.map(nameOf).join(L.sep) : L.none)
  ];
  /* 出行方式（免拼 / 拼团）：选择了才追加这一行 */
  if (d.tourType) lines.push(L.tour + ': ' + (d.tourType === 'private' ? L.tourPrivate : L.tourShared));
  /* 填了出行人数才追加这一行（人数 · 建议车型 · 装备套数） */
  if (d.people) lines.push(L.people(d.people, L.sug(seatsOf(d.people))));
  /* 帐篷数量（填了才追加），帐篷类型（选了才追加括号说明） */
  if (d.tents){
    const tlabel = d.tentType === 'single' ? L.tentSingle : (d.tentType === 'shared' ? L.tentShared : '');
    lines.push(L.tentsLine(d.tents, tlabel));
  }
  /* 所选方案价格（后台已配置才附加）：免拼带所选车型整车价，拼团带 所选车型单价×人数=总价 */
  const pricing = loadData().islandPricing || {};
  if (d.tourType === 'private' && d.vehicle){
    const p = pricing.private && +pricing.private['seat' + d.vehicle];
    if (p > 0) lines.push(L.priceP(d.vehicle, p));
  } else if (d.tourType === 'shared' && d.people){
    /* 拼团单价按所选车型取（客户端带了 vehicle 就用它，否则按人数推荐最小可坐车型） */
    const sv = d.vehicle || seatsOf(d.people);
    const pp = sv && pricing.shared ? +pricing.shared['seat' + sv] : 0;
    if (pp > 0) lines.push(L.priceS(sv, pp, d.people, pp * d.people));
  }
  return lines.join('\n');
}

/* ---------------- 图片媒体：独立存储（避免把 base64 塞进 chats 单体文档撑爆 16MB 上限） ----------------
   有云库 → 单独集合 media 一图一文；无云库 → data/media/<id>.bin + <id>.json（服务器不对外暴露 data 目录） */
const MEDIA_DIR = path.join(ROOT, 'data', 'media');
const MEDIA_MAX = 4 * 1024 * 1024;             // 单张图片原始字节上限 4MB
async function saveMedia(buf, mime){
  const id = crypto.randomUUID();
  if (cloud.enabled && cloud.mediaCol){
    await cloud.mediaCol.replaceOne({ _id:id }, { _id:id, mime, data:buf.toString('base64'), createdAt:Date.now() }, { upsert:true });
  } else {
    fs.mkdirSync(MEDIA_DIR, { recursive:true });
    fs.writeFileSync(path.join(MEDIA_DIR, id + '.bin'), buf);
    fs.writeFileSync(path.join(MEDIA_DIR, id + '.json'), JSON.stringify({ mime, createdAt:Date.now() }));
  }
  return id;
}
async function loadMedia(id){
  if (cloud.enabled && cloud.mediaCol){
    const doc = await cloud.mediaCol.findOne({ _id:id });
    if (!doc || !doc.data) return null;
    return { mime: doc.mime || 'image/jpeg', buf: Buffer.from(doc.data, 'base64') };
  }
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(MEDIA_DIR, id + '.json'), 'utf-8'));
    return { mime: meta.mime || 'image/jpeg', buf: fs.readFileSync(path.join(MEDIA_DIR, id + '.bin')) };
  } catch(e){ return null; }
}

/* ---------------- 人工客服账号与在线状态 ----------------
   在线判定：后台登录成功且持续上报心跳 → operatorOnline=true。
   页面关闭 / 心跳超时（10s）→ 仅置为「人工离线」（游客端指示灯熄灭）、不清除登录态。
   登录态只有两条出口：用户主动点「退出登录」，或该 token 被显式移除。 */
const AUTH_FILE = path.join(ROOT, 'data', 'auth.json');
const PRESET_USER = 'operator';
const PRESET_PASS = 'beisuas';   // 初始预设密码，可在后台修改
const HEARTBEAT_TIMEOUT = 10 * 1000;   // 超过此时长未收到心跳 → 仅判定「人工离线」（指示灯熄灭），不清除登录态
let authCache = null;
function hashPwd(salt, pwd){ return crypto.createHash('sha256').update(salt + ':' + pwd).digest('hex'); }
function loadAuth(){
  if (authCache) return authCache;
  let loaded = false;
  if (cloud.enabled){
    const raw = cloudGet('auth');
    if (raw && typeof raw === 'object'){ authCache = raw; loaded = true; }
  } else {
    try { authCache = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf-8')); loaded = true; }
    catch(e){ loaded = false; }
  }
  if (!loaded){
    /* 首次运行：预设一套初始账号 */
    const salt = crypto.randomBytes(16).toString('hex');
    authCache = {
      accounts: [{ id: crypto.randomUUID(), username: PRESET_USER, salt, hash: hashPwd(salt, PRESET_PASS), createdAt: Date.now() }],
      sessions: []
    };
    if (cloud.enabled) cloudSave('auth', authCache);
    else fs.writeFileSync(AUTH_FILE, JSON.stringify(authCache, null, 2), 'utf-8');
  }
  if (!Array.isArray(authCache.accounts)) authCache.accounts = [];
  if (!Array.isArray(authCache.sessions)) authCache.sessions = [];
  return authCache;
}
function saveAuth(){
  if (cloud.enabled) return cloudSave('auth', loadAuth());
  fs.writeFileSync(AUTH_FILE, JSON.stringify(loadAuth(), null, 2), 'utf-8');
}
/* 会话是否仍在线（有心跳且在超时窗口内）—— 仅用于判定「人工客服在线」指示灯 */
function sessionLive(s){ return !!s && !!s.lastSeen && (Date.now() - s.lastSeen) < HEARTBEAT_TIMEOUT; }
/* 人工在线：存在任一「在线且未被标记为已关闭」的会话 */
function operatorOnline(){ return loadAuth().sessions.some(s => sessionLive(s) && s.closing !== true); }
/* 校验 token：只要该 token 仍存在即视为已登录（登录态只在点「退出登录」时销毁）；
   心跳超时、页面关闭都只影响「人工在线」指示，不再把用户踢回登录页。
   任何带 token 的真实请求都刷新心跳（内存更新，不落盘），并清除关闭标记 */
function sessionUser(token){
  if (!token) return null;
  const s = loadAuth().sessions.find(x => x.token === String(token));
  if (!s) return null;
  s.lastSeen = Date.now();
  s.closing = false;
  return s.username;
}
/* 定时巡检：只把「人工在线」的状态变化广播给游客前端
   （浏览器异常退出、未上报关闭时，心跳超时后指示灯熄灭）。
   broadcastState 内部会自动跳过无变化的广播，故此处基本是空转。 */
function sweepSessions(){ broadcastState(); }

/* ---------------- 访客用户（邮箱注册 + 邮件链接激活） ----------------
   用户以「邮箱 + 密码」注册；注册后状态为 pending，须点击邮件里的激活链接后（status=active）方可登录；
   邮箱与昵称均全局唯一。忘记密码仍走邮箱验证码核验。
   未配置 Resend 密钥时为演示模式：不真实发送，激活链接打印到服务端控制台。 */
const USER_FILE = path.join(ROOT, 'data', 'users.json');
let userCache = null;
function loadUsers(){
  if (userCache) return userCache;
  if (cloud.enabled){
    const raw = cloudGet('users');
    userCache = (raw && typeof raw === 'object') ? raw : { users: [] };
  } else {
    try { userCache = JSON.parse(fs.readFileSync(USER_FILE, 'utf-8')); }
    catch(e){ userCache = { users: [] }; }
  }
  if (!Array.isArray(userCache.users)) userCache.users = [];
  return userCache;
}
function saveUsers(){
  if (cloud.enabled) return cloudSave('users', loadUsers());
  fs.writeFileSync(USER_FILE, JSON.stringify(loadUsers(), null, 2), 'utf-8');
}
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
/* 一次性临时邮箱域名黑名单：注册时拦截，防止爬虫批量建号 */
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com','tempmail.com','temp-mail.org','10minutemail.com','guerrillamail.com',
  'sharklasers.com','yopmail.com','throwawaymail.com','trashmail.com','getnada.com',
  'dispostable.com','maildrop.cc','mailnesia.com','mytemp.email','tempmail.net',
  'fakeinbox.com','mailcatch.com','spamgourmet.com','mohmal.com','emailondeck.com',
  'moakt.com','tempinbox.com','luxusmail.org','inboxkitten.com','burnermail.io',
  '33mail.com','mail.tm','tempr.email','discard.email','instantemailaddress.com'
]);
function emailDomain(email){ const i = String(email || '').lastIndexOf('@'); return i < 0 ? '' : String(email).slice(i + 1).toLowerCase(); }
function isDisposable(email){ return DISPOSABLE_DOMAINS.has(emailDomain(email)); }
function normEmail(email){ return String(email || '').trim().toLowerCase(); }
function findByEmail(email){ const e = normEmail(email); if (!e) return null; return loadUsers().users.find(u => normEmail(u.email) === e); }
/* 昵称查重：忽略大小写与首尾空格，全局唯一 */
function nicknameTaken(nickname, exceptId){
  const n = String(nickname || '').trim().toLowerCase();
  if (!n) return false;
  return loadUsers().users.some(u => u.id !== exceptId && String(u.nickname || '').trim().toLowerCase() === n);
}
/* 验证码：内存存储，10 分钟有效；同一邮箱 60 秒内不可重复发送。键按邮箱隔离 */
const CODE_TTL = 10 * 60 * 1000;
const CODE_RESEND_GAP = 60 * 1000;
const codeStore = new Map();   // `email:${email}` -> { code, purpose, expiresAt, sentAt, tries }
function codeKey(id){ return 'email:' + String(id || ''); }
function genCode(){ return String(Math.floor(100000 + Math.random() * 900000)); }
/* 邮箱激活令牌：注册后 24 小时内有效，一次性使用（存于用户记录，重启不丢失） */
const ACTIVATE_TTL = 24 * 60 * 60 * 1000;
function genToken(){ return crypto.randomBytes(24).toString('hex'); }

/* ================================================================
   第三方服务集成（正式版）：Resend 邮件验证码 + Google reCAPTCHA
   ----------------------------------------------------------------
   凭证填写位置：data/secrets.json（首次运行自动生成模板，见下）。
   · 密钥留空时自动退回【模拟模式】：验证码回显前端 + 控制台，人机验证仅校验非空。
   · 填入真实密钥后无需改代码，重启服务即启用真实服务。
   ⚠️ Resend API Key / reCAPTCHA Secret Key 为敏感信息，
      仅存于后端文件，严禁写入前端页面或通过任何接口下发到浏览器。
   ================================================================ */
const SECRETS_FILE = path.join(ROOT, 'data', 'secrets.json');
const SECRETS_TEMPLATE = {
  twilio:    { accountSid: '', authToken: '', fromPhone: '' },
  resend:    { apiKey: '', fromEmail: '', fromName: 'beisuas' },
  recaptcha: { version: 'v2', siteKey: '', secretKey: '' },
  telegram:  { botUsername: '', botToken: '' },   // Telegram 登录：botUsername 公开（前端控件用），botToken 仅后端校验用
  amap:      { key: '' },                          // 高德 Web 服务 Key：驾车路线规划用，仅后端，不下发前端
  mongo:     { uri: '' }
};
function ensureSecretsFile(){
  if (fs.existsSync(SECRETS_FILE)) return;
  try { fs.writeFileSync(SECRETS_FILE, JSON.stringify(SECRETS_TEMPLATE, null, 2), 'utf-8'); }
  catch(e){ console.error('[secrets] 初始化失败:', e.message); }
}
function loadSecrets(){
  ensureSecretsFile();
  let s = {};
  try { s = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf-8')); } catch(e){ s = {}; }
  const str = (o, k) => String((o && o[k]) || '').trim();
  /* 环境变量回退：便于在 Render 等平台通过环境变量注入密钥（优先级低于本地 secrets.json） */
  const env = process.env || {};
  const pick = (fileVal, envKey) => fileVal || String(env[envKey] || '').trim();
  return {
    twilio:    { accountSid: pick(str(s.twilio, 'accountSid'), 'TWILIO_ACCOUNT_SID'), authToken: pick(str(s.twilio, 'authToken'), 'TWILIO_AUTH_TOKEN'), fromPhone: pick(str(s.twilio, 'fromPhone'), 'TWILIO_FROM_PHONE') },
    resend:    { apiKey: pick(str(s.resend, 'apiKey'), 'RESEND_API_KEY'), fromEmail: pick(str(s.resend, 'fromEmail'), 'RESEND_FROM_EMAIL'), fromName: pick(str(s.resend, 'fromName'), 'RESEND_FROM_NAME') || 'beisuas' },
    recaptcha: { version: (str(s.recaptcha, 'version') || str(env, 'RECAPTCHA_VERSION')) === 'v3' ? 'v3' : 'v2',
                 siteKey: pick(str(s.recaptcha, 'siteKey'), 'RECAPTCHA_SITE_KEY'), secretKey: pick(str(s.recaptcha, 'secretKey'), 'RECAPTCHA_SECRET_KEY') },
    telegram:  { botUsername: pick(str(s.telegram, 'botUsername'), 'TELEGRAM_BOT_USERNAME'), botToken: pick(str(s.telegram, 'botToken'), 'TELEGRAM_BOT_TOKEN') },
    amap:      { key: pick(str(s.amap, 'key'), 'AMAP_KEY') },
    mongo:     { uri: pick(str(s.mongo, 'uri'), 'MONGODB_URI') }
  };
}
/* 是否已配置为真实服务（用于前端提示与人机验证渲染方式） */
const emailLive  = () => { const g = loadSecrets().resend; return !!(g.apiKey && g.fromEmail); };

/* 通过 Resend 发送 6 位验证码邮件；未配置密钥时返回 { mode:'demo' } */
function sendVerificationEmail(email, code, purpose){
  return new Promise((resolve, reject) => {
    const g = loadSecrets().resend;
    if (!(g.apiKey && g.fromEmail)) return resolve({ mode:'demo' });   // 模拟模式：不真实发信
    const subject = purpose === 'reset' ? '【beisuas】重置密码验证码' : '【beisuas】注册验证码';
    const html = '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;color:#1c2330;line-height:1.7">'
      + '<p>您好，</p><p>您的验证码为：<b style="font-size:22px;letter-spacing:3px;color:#2f7cf6">' + code + '</b></p>'
      + '<p>验证码 10 分钟内有效，请勿向他人泄露。如非本人操作，请忽略本邮件。</p>'
      + '<p style="color:#8b94a0;font-size:12px">— beisuas 团队</p></div>';
    const payload = JSON.stringify({
      from: g.fromName ? (g.fromName + ' <' + g.fromEmail + '>') : g.fromEmail,
      to: [email],
      subject,
      html
    });
    const req = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + g.apiKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ mode:'live' });
        else reject(new Error('Resend ' + res.statusCode + ' ' + raw.slice(0, 200)));
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('Resend 请求超时')));
    req.write(payload); req.end();
  });
}
/* 通过 Resend 发送「邮箱激活链接」邮件；未配置密钥时返回 { mode:'demo' } */
function sendActivationEmail(email, link){
  return new Promise((resolve, reject) => {
    const g = loadSecrets().resend;
    if (!(g.apiKey && g.fromEmail)) return resolve({ mode:'demo' });   // 模拟模式：不真实发信
    const subject = '【beisuas】邮箱激活';
    const html = '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;color:#1c2330;line-height:1.7">'
      + '<p>您好，</p><p>感谢注册beisuas。请点击下方按钮完成邮箱激活：</p>'
      + '<p><a href="' + link + '" style="display:inline-block;padding:10px 22px;background:#2f7cf6;color:#ffffff;border-radius:8px;text-decoration:none">激活邮箱</a></p>'
      + '<p>该链接 24 小时内有效，且只能使用一次。若按钮无法点击，请复制以下地址到浏览器打开：</p>'
      + '<p style="color:#8b94a0;font-size:12px;word-break:break-all">' + link + '</p>'
      + '<p style="color:#8b94a0;font-size:12px">如非本人操作，请忽略本邮件。— beisuas 团队</p></div>';
    const payload = JSON.stringify({
      from: g.fromName ? (g.fromName + ' <' + g.fromEmail + '>') : g.fromEmail,
      to: [email],
      subject,
      html
    });
    const req = https.request({
      hostname: 'api.resend.com', path: '/emails', method: 'POST',
      headers: { 'Authorization': 'Bearer ' + g.apiKey, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ mode:'live' });
        else reject(new Error('Resend ' + res.statusCode + ' ' + raw.slice(0, 200)));
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('Resend 请求超时')));
    req.write(payload); req.end();
  });
}
/* 校验 reCAPTCHA 令牌（Secret Key 仅在后端使用）；未配置密钥时退化为“令牌非空”校验 */
function verifyRecaptcha(token, remoteip){
  return new Promise((resolve, reject) => {
    const r = loadSecrets().recaptcha;
    if (!r.secretKey) return resolve({ ok: String(token || '').trim().length > 0, mode:'demo' });
    let form = 'secret=' + encodeURIComponent(r.secretKey) + '&response=' + encodeURIComponent(String(token || ''));
    if (remoteip) form += '&remoteip=' + encodeURIComponent(remoteip);
    const req = https.request({
      hostname: 'www.google.com', path: '/recaptcha/api/siteverify', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) }
    }, res => {
      let raw = ''; res.on('data', c => raw += c);
      res.on('end', () => {
        try { const j = JSON.parse(raw); resolve({ ok: !!j.success, mode:'live', score: j.score, error: j['error-codes'] }); }
        catch(e){ reject(new Error('reCAPTCHA 响应解析失败')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('reCAPTCHA 请求超时')));
    req.write(form); req.end();
  });
}

/* ---------------- Telegram 网页登录 ----------------
   Telegram Login Widget 回调数据校验（官方算法）：
     secret_key        = SHA256(bot_token)
     data_check_string = 除 hash 外所有键值对按 "key=value" 升序用 \n 连接
     校验 hash == HMAC_SHA256(data_check_string, secret_key)
   auth_date 超过 1 天视为过期，防止重放。未配置 Bot Token 时不可用。 */
/*==TG_VERIFY_BEGIN==*/
const TG_AUTH_TTL = 24 * 60 * 60 * 1000;
function verifyTelegramAuth(user){
  const g = loadSecrets().telegram;
  if (!g.botToken) return { ok:false, error:'未配置 Telegram Bot Token' };
  const data = (user && typeof user === 'object') ? user : {};
  const hash = String(data.hash || '');
  const tgId = String(data.id || '');
  if (!hash || !tgId) return { ok:false, error:'登录数据不完整' };
  const dataCheckString = Object.keys(data)
    .filter(k => k !== 'hash' && data[k] !== undefined && data[k] !== null)
    .map(k => k + '=' + data[k]).sort().join('\n');
  const secretKey = crypto.createHash('sha256').update(g.botToken).digest();
  const calc = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  const a = Buffer.from(calc, 'utf-8'), b = Buffer.from(hash, 'utf-8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok:false, error:'Telegram 签名校验失败' };
  const authDate = Number(data.auth_date || 0) * 1000;
  if (authDate && Date.now() - authDate > TG_AUTH_TTL) return { ok:false, error:'登录凭证已过期，请重新登录' };
  return { ok:true, id:tgId, first:String(data.first_name || '').trim(), last:String(data.last_name || '').trim(),
           username:String(data.username || '').trim(), photo:String(data.photo_url || '').trim() };
}
/*==TG_VERIFY_END==*/
/* Telegram 昵称：优先「名 姓」，其次用户名，最后回退；与站内已用昵称冲突时自动加序号 */
function telegramNickname(v){
  const base = ([v.first, v.last].filter(Boolean).join(' ') || v.username || ('TG' + v.id)).slice(0, 20);
  let nick = base;
  for (let i = 2; nicknameTaken(nick) && i < 1000; i++) nick = base + ' ' + i;
  return nick.slice(0, 24);
}

/* Telegram 登录采用「官方跳转授权」方式（不用可被第三方 Cookie 拦截 / 样式不可控的 iframe 控件）：
   前端点击圆形按钮 → GET /api/auth/telegram/start → 302 到 oauth.telegram.org/auth
   → 用户确认后 Telegram 带签名参数回跳本站 → 前端 POST /api/auth/telegram 完成登录。
   Bot 数字 ID 由 Bot Token 调 getMe 取得并缓存，不写死在前端。 */
const TG_STATES = new Map();          // 一次性 state → { createdAt, bindUserId }
const TG_STATE_TTL = 10 * 60 * 1000;
let TG_BOT_ID = '';                    // getMe 结果缓存（进程内）
let TG_BOT_ID_PENDING = null;          // 并发首次请求复用同一次 getMe，避免重复外网调用
function tgGetMe(token, timeout){
  return new Promise((resolve, reject) => {
    const req = https.get('https://api.telegram.org/bot' + token + '/getMe', { timeout: timeout || 15000 }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => resolve(d));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
/* 通用 Bot API POST（sendMessage / setWebhook 等）：返回解析后的 JSON，失败仅抛出由调用方记日志 */
function tgApi(method, payload){
  return new Promise((resolve, reject) => {
    const g = loadSecrets().telegram;
    if (!g.botToken) return reject(new Error('未配置 Telegram Bot Token'));
    const data = JSON.stringify(payload || {});
    const req = https.request({
      method: 'POST', host: 'api.telegram.org', path: '/bot' + g.botToken + '/' + method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 15000
    }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch(e){ reject(new Error('Bot API 响应解析失败')); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(data);
  });
}
/* 手机端唤起 App 登录依赖 webhook 收 /start：仅在线上环境（Render 注入 RENDER=true，或显式 TG_WEBHOOK=1）
   把 webhook 指到本站，避免本地联调时抢走线上机器人的消息；失败不影响站点其它功能。 */
/* webhook 密钥：由 botToken 派生（确定性、免配置），setWebhook 时上报，
   之后每个回调带 X-Telegram-Bot-Api-Secret-Token 头，路由据此拒绝伪造回调 */
function tgWebhookSecret(){
  const g = loadSecrets().telegram;
  return g.botToken ? crypto.createHash('sha256').update(g.botToken + ':webhook').digest('hex').slice(0, 48) : '';
}
async function tgSetupWebhook(){
  try {
    const g = loadSecrets().telegram;
    const onRender = !!process.env.RENDER || process.env.TG_WEBHOOK === '1';
    if (!g.botToken || !onRender || !/^https:\/\//i.test(PUBLIC_BASE_URL) || /localhost|127\.0\.0\.1/i.test(PUBLIC_BASE_URL)) return;
    const j = await tgApi('setWebhook', { url: PUBLIC_BASE_URL + '/api/tg-webhook',
      allowed_updates: ['message'], drop_pending_updates: true, secret_token: tgWebhookSecret() });
    if (j && j.ok) console.log('[Telegram] webhook 已注册 → ' + PUBLIC_BASE_URL + '/api/tg-webhook');
    else console.error('[Telegram] setWebhook 失败: ' + JSON.stringify(j));
  } catch(e){ console.error('[Telegram] setWebhook 异常:', e.message); }
}
async function tgBotId(){
  if (TG_BOT_ID) return TG_BOT_ID;
  if (TG_BOT_ID_PENDING) return TG_BOT_ID_PENDING;
  TG_BOT_ID_PENDING = (async () => {
    const g = loadSecrets().telegram;
    if (!g.botToken) return '';
    /* 冷启动（Render 免费实例休眠后唤醒）时首次外网调用可能超时，故给足 15s 并重试一次 */
    for (let i = 0; i < 2 && !TG_BOT_ID; i++){
      try {
        const j = JSON.parse(await tgGetMe(g.botToken, 15000));
        if (j && j.ok && j.result && j.result.id) TG_BOT_ID = String(j.result.id);
      } catch(e){ console.error('[Telegram] getMe 失败(' + (i+1) + '/2):', e.message); }
    }
    return TG_BOT_ID;
  })();
  const id = await TG_BOT_ID_PENDING;
  TG_BOT_ID_PENDING = null;
  return id;
}

/* ---------------- 第三方账号绑定 ----------------
   绑定的作用只是「把 Telegram 身份写到同一个站点用户 ID 上」：
   · 未登录时使用 Telegram 登录 → 按 telegramId 建/取账号
   · 已登录时使用 Telegram 授权 → 把该 Telegram 身份绑定到当前账号，之后任一方登录都进入同一账号
   归属证明：访客账号没有独立登录态，用「用户 ID + 会话 ID」配对校验操作者身份
   （会话 ID 是该账号浏览器本地持有的不可猜字符串，等同现有会话凭证）。 */
const PROVIDER_FIELDS = { telegram: { id:'telegramId', name:'telegramName' } };
function userById(id){ return loadUsers().users.find(x => String(x.id || '') === String(id || '')) || null; }
function userByCreds(uid, sid){
  const u = userById(uid);
  if (!u || !sid || String(u.sessionId || '') !== String(sid)) return null;
  return u;
}
/* 返回给前端的账号信息（附带已绑定的第三方身份标记，不含任何第三方密钥） */
function publicUser(u){
  return { id:u.id, email:u.email || '', nickname:u.nickname, sessionId:u.sessionId,
           createdAt:u.createdAt, provider:u.provider || 'email',
           bound: { telegram: !!u.telegramId } };
}
/* 把第三方身份写入目标账号；若该身份原先挂在别的账号上则先摘除
   （授权者本人即可证明该第三方身份的归属，故允许迁移，不会造成越权） */
function linkThirdParty(u, provider, id, info){
  const f = PROVIDER_FIELDS[provider] || { id:'thirdPartyId', name:'thirdPartyName' };
  id = String(id || '');
  loadUsers().users.forEach(x => {
    if (x !== u && String(x[f.id] || '') === id){ delete x[f.id]; console.log('[绑定] 第三方身份从旧账号摘除: ' + x.id); }
  });
  u[f.id] = id;
  /* provider 仅在账号尚无主要来源时写入，避免覆盖邮箱注册账号的来源标记 */
  if (!u.provider || u.provider === 'email') u.provider = provider;
  if (info && info.name) u[f.name] = String(info.name);
  if (info && info.photo) u.photoUrl = String(info.photo);
  saveUsers();
}

/* ---------------- 路由 ---------------- */
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '');
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  let m;   // 路由正则匹配结果（供各分支复用，声明置于顶部以便全流程使用）

  /* ---- 后台管理接口鉴权 ----
     除白名单（游客前端 / 登录流程所需）外，所有 /api/* 必须携带有效登录 token，
     否则统一 401，防止绕过登录页直接调用后台接口。
     token 来源：请求头 X-Op-Token（后台页面自动附带）或 ?token= 查询参数 */
  if (p.startsWith('/api/')){
    const open =
      p === '/api/auth/status' || p === '/api/auth/login' || p === '/api/auth/logout' ||
      p === '/api/auth/heartbeat' || p === '/api/auth/close' ||
      p === '/api/config' || p === '/api/match' || p === '/api/media' ||
      (p === '/api/island/submit' && req.method === 'POST') ||
      (p === '/api/island-config' && req.method === 'GET') ||
      (p === '/api/camp-points' && req.method === 'GET') ||
      (p === '/api/play-points' && req.method === 'GET') ||
      (p === '/api/articles' && req.method === 'GET') ||
      (p === '/api/events' && req.method === 'GET') ||
      p === '/api/auth/check' || p === '/api/auth/send-code' ||
      p === '/api/auth/register' || p === '/api/auth/login-email' || p === '/api/auth/reset' ||
      p === '/api/auth/guest' ||
      p === '/api/auth/activate' || p === '/api/auth/telegram' || p === '/api/auth/telegram/start' ||
      p === '/api/auth/bind/telegram' || p === '/api/auth/links' ||
      (p === '/api/tg-webhook' && req.method === 'POST') ||   // Telegram 服务器回调，无本站登录态
      (p === '/api/auth/config' && req.method === 'GET') ||
      (p === '/api/bot-switch' && req.method === 'GET') ||
      (p === '/api/reply-seq' && req.method === 'GET') ||
      (p.startsWith('/api/media/') && req.method === 'GET') ||
      (p === '/api/booking/note' && req.method === 'POST') ||   // 官网预订成功页跨域写入清单，无本站登录态
      (p === '/api/bookings' && req.method === 'POST') ||       // 站内「海南项目体验」预订表单提交
      (p === '/api/settings' && req.method === 'GET') ||        // 站内体验页页脚联系方式（游客只读）
      (p === '/api/exp/projects' && req.method === 'GET') ||    // 站内体验页项目与价格（游客只读）
      (p.startsWith('/api/chat/') && p.endsWith('/messages') && req.method === 'GET');
    if (!open && !sessionUser(req.headers['x-op-token'] || url.searchParams.get('token') || '')){
      return send(res, 401, { ok:false, error:'未登录或登录态已失效，请重新登录' });
    }
  }

  /* ---- 客服在线状态（游客前端轮询；带 token 时同时校验登录态） ---- */
  if (p === '/api/auth/status' && req.method === 'GET'){
    const token = url.searchParams.get('token') || '';
    return send(res, 200, { operatorOnline: operatorOnline(), loggedInAs: sessionUser(token) });
  }
  /* ---- 心跳上报：后台坐席页面每 3 秒调用，维持「人工在线」；超时未上报即判定人工离线（登录态保留） ---- */
  if (p === '/api/auth/heartbeat' && req.method === 'POST'){
    const body = await readBody(req);
    const token = body.token || req.headers['x-op-token'] || url.searchParams.get('token') || '';
    const username = sessionUser(token);
    if (!username) return send(res, 401, { ok:false, error:'登录态已失效，请重新登录' });
    broadcastState();   // 状态未变化时内部自动跳过广播
    return send(res, 200, { ok:true, operatorOnline: operatorOnline() });
  }
  /* ---- 页面关闭：仅标记会话为「已关闭」并立即广播离线（游客端指示灯即时熄灭）；
     不清除登录态，重新打开后台无需重新登录；下次心跳会自动清除关闭标记恢复在线 ---- */
  if (p === '/api/auth/close' && req.method === 'POST'){
    const body = await readBody(req);
    const db = loadAuth();
    const s = db.sessions.find(x => x.token === String(body.token || ''));
    if (s){ s.closing = true; broadcastState(true); }
    return send(res, 200, { ok:true });
  }
  /* ---- 客服登录 ---- */
  if (p === '/api/auth/login' && req.method === 'POST'){
    const body = await readBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const db = loadAuth();
    const acc = db.accounts.find(a => a.username === username);
    if (!acc || acc.hash !== hashPwd(acc.salt, password)) return send(res, 401, { ok:false, error:'账号或密码错误' });
    const token = crypto.randomUUID();
    db.sessions.push({ token, username: acc.username, createdAt: Date.now(), lastSeen: Date.now() });
    saveAuth();
    broadcastState(true);
    return send(res, 200, { ok:true, token, username: acc.username });
  }
  /* ---- 客服退出登录：销毁会话 → 置离线 → 广播给游客前端 ---- */
  if (p === '/api/auth/logout' && req.method === 'POST'){
    const body = await readBody(req);
    const db = loadAuth();
    db.sessions = db.sessions.filter(s => s.token !== String(body.token || ''));
    saveAuth();
    broadcastState(true);
    return send(res, 200, { ok:true });
  }
  /* ---- 登录后修改自己的密码 ---- */
  if (p === '/api/auth/password' && req.method === 'POST'){
    const body = await readBody(req);
    const username = sessionUser(body.token);
    if (!username) return send(res, 401, { ok:false, error:'登录态已失效，请重新登录' });
    const newPassword = String(body.newPassword || '');
    if (newPassword.length < 6) return send(res, 400, { ok:false, error:'新密码至少 6 位' });
    const db = loadAuth();
    const acc = db.accounts.find(a => a.username === username);
    if (!acc || acc.hash !== hashPwd(acc.salt, String(body.oldPassword || ''))) return send(res, 401, { ok:false, error:'旧密码不正确' });
    acc.hash = hashPwd(acc.salt, newPassword);
    saveAuth();
    return send(res, 200, { ok:true });
  }
  /* ---- 账号列表 / 新建账号 ---- */
  if (p === '/api/auth/accounts' && req.method === 'GET'){
    const db = loadAuth();
    return send(res, 200, { accounts: db.accounts.map(a => ({ id:a.id, username:a.username, createdAt:a.createdAt })) });
  }
  if (p === '/api/auth/accounts' && req.method === 'POST'){
    const body = await readBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!username || password.length < 6) return send(res, 400, { ok:false, error:'账号不能为空，密码至少 6 位' });
    const db = loadAuth();
    if (db.accounts.some(a => a.username === username)) return send(res, 400, { ok:false, error:'该账号已存在' });
    const salt = crypto.randomBytes(16).toString('hex');
    db.accounts.push({ id: crypto.randomUUID(), username, salt, hash: hashPwd(salt, password), createdAt: Date.now() });
    saveAuth();
    return send(res, 200, { ok:true });
  }

  /* ---- 前端可见的账号相关配置（仅下发公开信息；Secret Key 绝不外泄） ---- */
  if (p === '/api/auth/config' && req.method === 'GET'){
    const sec = loadSecrets();
    const r = sec.recaptcha, tg = sec.telegram;
    return send(res, 200, {
      recaptchaSiteKey: r.siteKey,     // 前端公开 key
      recaptchaVersion: r.version,     // 'v2' 复选框 / 'v3' 分数式
      recaptchaEnabled: !!r.siteKey,   // 未配置 → 前端使用模拟勾选框
      emailMode: emailLive() ? 'live' : 'demo',    // demo 时验证码回显前端，便于联调
      telegramEnabled: !!(tg.botUsername && tg.botToken),   // 两者齐备才展示 Telegram 登录控件
      telegramBotUsername: tg.botUsername                    // 公开：前端控件 data-telegram-login 使用
    });
  }
  /* ---- 游客匿名登录：免注册直接进入网站 ----
     仅开放浏览与机器人问答权限：不写入访客用户列表（loadUsers），不提供账号管理（改密码/绑定第三方），
     身份只作为浏览器本地会话使用；会话打上 guest 标记，后端据此禁止人工客服接管。 */
  if (p === '/api/auth/guest' && req.method === 'POST'){
    return send(res, 200, { ok:true, user: {
      id: 'guest-' + crypto.randomUUID(),
      email: '',
      nickname: '游客',
      sessionId: crypto.randomUUID(),
      createdAt: Date.now(),
      provider: 'guest',
      isGuest: true
    } });
  }
  /* ---- 访客账号：预校验（邮箱 格式与唯一性、昵称唯一） ---- */
  if (p === '/api/auth/check' && req.method === 'POST'){
    const body = await readBody(req);
    const email = normEmail(body.email);
    const nickname = String(body.nickname || '').trim();
    const emailValid = EMAIL_RE.test(email);
    const ex = findByEmail(email);
    return send(res, 200, {
      emailValid,
      emailDisposable: emailValid && isDisposable(email),
      emailTaken: emailValid && !!ex && ex.status !== 'pending',   // 未激活的 pending 记录允许重新注册
      emailPending: emailValid && !!ex && ex.status === 'pending',
      nicknameTaken: nicknameTaken(nickname, ex ? ex.id : undefined)
    });
  }
  /* ---- 发送 6 位验证码（Resend 邮件；先校验 reCAPTCHA） ---- */
  if (p === '/api/auth/send-code' && req.method === 'POST'){
    const body = await readBody(req);
    const email = normEmail(body.email);
    const purpose = body.purpose === 'reset' ? 'reset' : 'register';
    /* 人机验证：调用 Google siteverify（Secret Key 仅在后端使用） */
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
    let cap;
    try { cap = await verifyRecaptcha(body.captcha, ip); }
    catch(e){ console.error('[reCAPTCHA] 校验失败:', e.message); return send(res, 502, { ok:false, error:'人机验证服务暂不可用，请稍后再试' }); }
    if (!cap.ok) return send(res, 400, { ok:false, error:'人机验证未通过，请重新验证' });
    const key = codeKey(email);
    if (!EMAIL_RE.test(email)) return send(res, 400, { ok:false, error:'邮箱格式不正确' });
    if (isDisposable(email)) return send(res, 403, { ok:false, error:'该邮箱为一次性临时邮箱，禁止注册' });
    const exists = !!findByEmail(email);
    if (purpose === 'register' && exists) return send(res, 409, { ok:false, error:'该邮箱已被注册' });
    if (purpose === 'reset' && !exists) return send(res, 404, { ok:false, error:'该邮箱尚未注册' });
    const prev = codeStore.get(key);
    if (prev && Date.now() - prev.sentAt < CODE_RESEND_GAP){
      const wait = Math.ceil((CODE_RESEND_GAP - (Date.now() - prev.sentAt)) / 1000);
      return send(res, 429, { ok:false, error:'验证码已发送，请 ' + wait + ' 秒后再试' });
    }
    const code = genCode();
    codeStore.set(key, { code, purpose, expiresAt: Date.now() + CODE_TTL, sentAt: Date.now(), tries: 0 });
    let out;
    try { out = await sendVerificationEmail(email, code, purpose); }
    catch(e){
      codeStore.delete(key);   // 发送失败 → 作废本次验证码，允许立即重试
      console.error('[Resend] 发送失败:', e.message);
      return send(res, 502, { ok:false, error:'验证码邮件发送失败，请稍后再试' });
    }
    console.log('[验证码] email ' + email + ' → ' + code + '（' + purpose + '，10 分钟内有效，' + (out.mode === 'demo' ? '模拟模式' : 'Resend 已发送') + '）');
    return send(res, 200, { ok:true, mode: out.mode, expiresIn: CODE_TTL, demoCode: out.mode === 'demo' ? code : undefined });
  }
  /* ---- 注册：创建 pending 账号 + 发送激活链接（校验 reCAPTCHA 与 邮箱/昵称 唯一） ---- */
  if (p === '/api/auth/register' && req.method === 'POST'){
    const body = await readBody(req);
    const email = normEmail(body.email);
    const nickname = String(body.nickname || '').trim();
    const password = String(body.password || '');
    if (!EMAIL_RE.test(email)) return send(res, 400, { ok:false, error:'邮箱格式不正确' });
    if (isDisposable(email)) return send(res, 403, { ok:false, error:'该邮箱为一次性临时邮箱，禁止注册' });
    const prev = findByEmail(email);
    if (prev && prev.status !== 'pending') return send(res, 409, { ok:false, error:'该邮箱已被注册' });
    if (password.length < 6) return send(res, 400, { ok:false, error:'密码至少 6 位' });
    if (!nickname) return send(res, 400, { ok:false, error:'请填写昵称' });
    if (nicknameTaken(nickname, prev ? prev.id : undefined)) return send(res, 409, { ok:false, error:'该昵称已被占用，请更换其他昵称' });
    /* 人机验证：注册入口已无独立验证码步骤，改为提交注册时校验 reCAPTCHA */
    const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
    let cap;
    try { cap = await verifyRecaptcha(body.captcha, ip); }
    catch(e){ console.error('[reCAPTCHA] 校验失败:', e.message); return send(res, 502, { ok:false, error:'人机验证服务暂不可用，请稍后再试' }); }
    if (!cap.ok) return send(res, 400, { ok:false, error:'人机验证未通过，请重新验证' });
    const salt = crypto.randomBytes(16).toString('hex');
    const sid = String(body.sessionId || '').trim().slice(0, 64) || crypto.randomUUID();
    const token = genToken();
    /* 复用未激活的同邮箱记录（激活链接丢失后可重新注册）；否则新建 */
    const user = prev || { id: crypto.randomUUID(), createdAt: Date.now() };
    Object.assign(user, { email, salt, hash: hashPwd(salt, password), nickname, sessionId: sid,
      status:'pending', activateToken: token, activateExpires: Date.now() + ACTIVATE_TTL });
    if (!prev) loadUsers().users.push(user);
    saveUsers();
    /* 生成激活链接：前缀统一使用对外域名（PUBLIC_BASE_URL），确保线上邮件可直接打开 */
    const link = PUBLIC_BASE_URL + '/api/auth/activate?token=' + token;
    let out;
    try { out = await sendActivationEmail(email, link); }
    catch(e){
      if (!prev){   // 新建失败则回滚，避免占用邮箱/昵称
        const arr = loadUsers().users, idx = arr.findIndex(x => x.id === user.id);
        if (idx >= 0){ arr.splice(idx, 1); saveUsers(); }
      }
      console.error('[Resend] 激活邮件发送失败:', e.message);
      return send(res, 502, { ok:false, error:'激活邮件发送失败，请稍后再试' });
    }
    console.log('[激活链接] ' + email + ' → ' + link + '（24 小时内有效，' + (out.mode === 'demo' ? '模拟模式' : 'Resend 已发送') + '）');
    return send(res, 201, { ok:true, pending:true, email, demo: out.mode === 'demo' });
  }
  /* ---- 邮箱激活：GET /api/auth/activate?token=... → 校验令牌并置为 active，随后 302 回跳前端 ---- */
  if (p === '/api/auth/activate' && req.method === 'GET'){
    const token = url.searchParams.get('token') || '';
    const u = token ? loadUsers().users.find(x => x.activateToken === token) : null;
    const ok = !!(u && u.status === 'pending' && u.activateExpires > Date.now());
    if (ok){ u.status = 'active'; delete u.activateToken; delete u.activateExpires; saveUsers(); }
    res.writeHead(302, { 'Location': '/' + (ok ? '?activated=1' : '?activated=0') });
    return res.end();
  }
  /* ---- 登录：邮箱 + 密码 → 返回账号及其会话（恢复历史聊天） ---- */
  if (p === '/api/auth/login-email' && req.method === 'POST'){
    const body = await readBody(req);
    const email = normEmail(body.identifier || body.email || '');
    const u = findByEmail(email);
    if (!u || u.hash !== hashPwd(u.salt, String(body.password || ''))) return send(res, 401, { ok:false, error:'账号或密码不正确' });
    if (u.status === 'pending') return send(res, 403, { ok:false, error:'该账号尚未激活，请点击邮件中的激活链接完成激活' });
    if (u.blocked === true) return send(res, 403, { ok:false, error:'该账号已被禁止登录，如有疑问请联系管理员' });
    const sid = u.sessionId || crypto.randomUUID();
    u.sessionId = sid; saveUsers();
    return send(res, 200, { ok:true, user: { id:u.id, email:u.email, nickname:u.nickname, sessionId:sid, createdAt:u.createdAt } });
  }
  /* ---- Telegram 快捷登录（发起）：302 到 Telegram 官方授权页 ----
     带 bind=1&uid&sid 表示「把 Telegram 身份绑定到当前已登录账号」，凭据非法直接拒绝。
     回跳地址用「路径」承载一次性 state（/tg/<state>），不带查询串：Telegram 会把签名参数
     追加到 return_to 之后，若 return_to 本身已含 "?" 会与追加的 "?" 冲突，导致 id 被并进
     相邻参数而解析不到（曾因此出现回跳后弹「Telegram 登录失败」）。用路径可彻底避免歧义。 */
  if (p === '/api/auth/telegram/start' && req.method === 'GET'){
    const botId = await tgBotId();
    if (!botId) return send(res, 503, 'Telegram 登录未配置');
    let bindUserId = '';
    if (url.searchParams.get('bind') === '1'){
      const tgt = userByCreds(url.searchParams.get('uid'), url.searchParams.get('sid'));
      if (!tgt) return send(res, 401, '登录态已失效，请重新登录后再绑定');
      bindUserId = tgt.id;
    }
    const state = crypto.randomBytes(16).toString('hex');
    TG_STATES.set(state, { createdAt: Date.now(), bindUserId });
    TG_STATES.forEach((rec, k) => { if (Date.now() - rec.createdAt > TG_STATE_TTL) TG_STATES.delete(k); });
    const returnTo = PUBLIC_BASE_URL + '/tg/' + state;
    const qs = new URLSearchParams({ bot_id: botId, origin: PUBLIC_BASE_URL, return_to: returnTo }).toString();
    const oauthUrl = 'https://oauth.telegram.org/auth?' + qs;
    /* ?json=1（手机端唤起 App 流程）：不跳转，返回一次性 state 及两条地址 ——
       appLink 用于唤起 Telegram App 打开本机器人（/start login_<state> 触发 webhook 回复 LoginUrl 登录按钮），
       oauthUrl 为原有网页授权地址，作为未装 App / 唤起失败时的兜底。两条路径共用同一 state。 */
    if (url.searchParams.get('json') === '1'){
      const bot = String(loadSecrets().telegram.botUsername || '').trim().replace(/^@/, '');
      return send(res, 200, { ok:true, state,
        appLink: bot ? ('https://t.me/' + bot + '?start=login_' + state) : '',
        oauthUrl });
    }
    res.writeHead(302, { 'Location': oauthUrl });
    return res.end();
  }
  /* ---- Telegram Bot webhook：手机端唤起 App 后，用户在机器人里 /start login_<state>，
     机器人回复一条带 LoginUrl 按钮的消息；用户在 App 内点按钮确认授权，
     Telegram 即带签名参数（id/first_name/.../hash）打开本站 /tg/<state>，前端解析后走既有 /api/auth/telegram。
     LoginUrl 的域名沿用 BotFather 已为网页授权绑定的本站域名，无需额外配置。 */
  if (p === '/api/tg-webhook' && req.method === 'POST'){
    const body = await readBody(req);
    /* 只认带正确 secret_token 的回调（注册 webhook 时上报给 Telegram 的密钥），伪造请求直接 403 */
    if (tgWebhookSecret() && req.headers['x-telegram-bot-api-secret-token'] !== tgWebhookSecret())
      return send(res, 403, { ok:false });
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}');   // 先快速应答，避免 Telegram 重投
    try {
      const msg = body && body.message;
      const text = String((msg && msg.text) || '');
      const chatId = msg && msg.chat && msg.chat.id;
      if (!chatId || !/^\/start/i.test(text)) return;
      const m = text.match(/^\/start(?:@\S+)?\s+login_([0-9a-f]{32})\s*$/i);
      const g = loadSecrets().telegram;
      if (!g.botToken) return;
      if (!m){
        await tgApi('sendMessage', { chat_id: chatId,
          text: '本机器人用于网站 Telegram 快捷登录。请回到网站，点击 Telegram 登录按钮。\nThis bot signs you into the website. Please go back to the site and tap the Telegram button.' });
        return;
      }
      const st = TG_STATES.get(m[1]);
      if (!st || Date.now() - st.createdAt > TG_STATE_TTL){
        await tgApi('sendMessage', { chat_id: chatId,
          text: '登录链接已失效，请回到网站重新点击 Telegram 登录。\nThis login link has expired. Please go back to the site and tap Telegram sign-in again.' });
        return;
      }
      await tgApi('sendMessage', { chat_id: chatId,
        text: '点击下面按钮，即可登录网站 👇\nTap the button below to sign in 👇',
        reply_markup: { inline_keyboard: [[ { text: '🔐 登录网站 / Sign in / Войти',
          login_url: { url: PUBLIC_BASE_URL + '/tg/' + m[1] } } ]] } });
    } catch(e){ console.error('[Telegram] webhook 处理失败:', e.message); }
    return;
  }
  /* ---- Telegram 快捷登录：校验控件回调签名 → 按 Telegram ID 建/取访客账号 → 返回会话 ----
     Telegram 不提供邮箱，故此类账号 email 为空、注册即激活（status=active），
     以 telegramId 唯一标识；重复登录复用同一账号与其历史会话。
     带 state 时（来自 /api/auth/telegram/start 的绑定意图）不新建账号，而是把该 Telegram 身份绑定到指定账号。 */
  if (p === '/api/auth/telegram' && req.method === 'POST'){
    const body = await readBody(req);
    const v = verifyTelegramAuth(body.user);
    if (!v.ok) return send(res, 401, { ok:false, error: v.error || 'Telegram 登录失败' });
    /* 绑定意图：state 经服务端一次性映射到目标账号，避免把 uid/sid 暴露在回跳地址里 */
    const st = body.state ? TG_STATES.get(String(body.state)) : null;
    if (body.state) TG_STATES.delete(String(body.state));
    if (st && Date.now() - st.createdAt <= TG_STATE_TTL && st.bindUserId){
      const tgt = userById(st.bindUserId);
      if (!tgt) return send(res, 401, { ok:false, error:'登录态已失效，请重新登录后再绑定' });
      if (v.username) tgt.telegramUsername = v.username;
      const name = [v.first, v.last].filter(Boolean).join(' ') || v.username || ('TG' + v.id);
      linkThirdParty(tgt, 'telegram', v.id, { name, photo: v.photo });
      console.log('[Telegram] 绑定成功: ' + v.id + ' → 用户 ' + tgt.id);
      return send(res, 200, { ok:true, bound:true, user: publicUser(tgt) });
    }
    const users = loadUsers().users;
    const existing = users.find(x => String(x.telegramId || '') === v.id);
    /* 拉黑拦截：已拉黑的账号禁止通过 Telegram 登录 */
    if (existing && existing.blocked === true) return send(res, 403, { ok:false, error:'该账号已被禁止登录，如有疑问请联系管理员' });
    let u = existing;
    if (!u){
      u = { id: crypto.randomUUID(), createdAt: Date.now(), provider:'telegram', telegramId: v.id, nickname: telegramNickname(v), status:'active', sessionId: crypto.randomUUID() };
      users.push(u);
    }
    u.telegramId = v.id;
    u.provider = 'telegram';
    if (v.username) u.telegramUsername = v.username;
    if (v.photo) u.photoUrl = v.photo;
    u.status = 'active';   // Telegram 已完成身份验证，无需邮箱激活
    const sid = u.sessionId || crypto.randomUUID();
    u.sessionId = sid; saveUsers();
    return send(res, 200, { ok:true, user: { id:u.id, email:u.email || '', nickname:u.nickname, sessionId:sid, createdAt:u.createdAt, provider:'telegram' } });
  }
  /* ---- 第三方账号绑定：Telegram（复用同一签名校验，原登录接口逻辑不受影响） ----
     已登录用户在「我的账号」里授权 Telegram → 把 telegramId 绑到当前账号。 */
  if (p === '/api/auth/bind/telegram' && req.method === 'POST'){
    const body = await readBody(req);
    const tgt = userByCreds(body.uid, body.sid);
    if (!tgt) return send(res, 401, { ok:false, error:'登录态已失效，请重新登录后再绑定' });
    const v = verifyTelegramAuth(body.user);
    if (!v.ok) return send(res, 401, { ok:false, error: v.error || 'Telegram 校验失败' });
    if (v.username) tgt.telegramUsername = v.username;
    const name = [v.first, v.last].filter(Boolean).join(' ') || v.username || ('TG' + v.id);
    linkThirdParty(tgt, 'telegram', v.id, { name, photo: v.photo });
    console.log('[绑定] Telegram → 用户 ' + tgt.id);
    return send(res, 200, { ok:true, user: publicUser(tgt) });
  }
  /* ---- 绑定状态：「我的账号」展示当前账号已绑定的第三方身份 ---- */
  if (p === '/api/auth/links' && req.method === 'GET'){
    const u = userByCreds(url.searchParams.get('uid'), url.searchParams.get('sid'));
    if (!u) return send(res, 401, { ok:false, error:'登录态已失效，请重新登录' });
    return send(res, 200, { ok:true,
      telegram: { bound: !!u.telegramId, name: u.telegramName || '' } });
  }
  /* ---- 忘记密码：邮箱验证码核验 → 重设密码 ---- */
  if (p === '/api/auth/reset' && req.method === 'POST'){
    const body = await readBody(req);
    const email = normEmail(body.identifier || body.email || '');
    const password = String(body.password || '');
    const code = String(body.code || '').trim();
    if (password.length < 6) return send(res, 400, { ok:false, error:'新密码至少 6 位' });
    const u = findByEmail(email);
    if (!u) return send(res, 404, { ok:false, error:'该邮箱尚未注册' });
    const key = codeKey(email);
    const rec = codeStore.get(key);
    if (!rec || rec.purpose !== 'reset' || rec.expiresAt < Date.now()) return send(res, 400, { ok:false, error:'验证码已失效，请重新获取' });
    rec.tries = (rec.tries || 0) + 1;
    if (rec.tries > 8){ codeStore.delete(key); return send(res, 400, { ok:false, error:'验证码尝试次数过多，请重新获取' }); }
    if (rec.code !== code) return send(res, 400, { ok:false, error:'验证码不正确' });
    codeStore.delete(key);
    u.salt = crypto.randomBytes(16).toString('hex');
    u.hash = hashPwd(u.salt, password);
    saveUsers();
    return send(res, 200, { ok:true });
  }
  /* ---- 用户列表（后台查看，需登录） ---- */
  if (p === '/api/users' && req.method === 'GET'){
    const list = loadUsers().users.slice().sort((a, b) => b.createdAt - a.createdAt)
      .map(u => ({ id:u.id, email:u.email, nickname:u.nickname, createdAt:u.createdAt, provider: u.provider || 'email',
                   blocked: u.blocked === true, note: String(u.note || '') }));
    return send(res, 200, list);
  }
  /* ---- 用户管理（后台，需登录）：拉黑/解除 + 备注 + 删除 ----
     PUT 可只传其中一个字段：{ blocked?:boolean } 拉黑/解除；{ note?:string } 备注（最长 500 字）。
     拉黑后该用户无法再通过邮箱或 Telegram 登录站点；解除后立即恢复登录能力。 */
  if ((m = p.match(/^\/api\/users\/([^/]+)$/)) && req.method === 'PUT'){
    const body = await readBody(req);
    const u = userById(m[1]);
    if (!u) return send(res, 404, { ok:false, error:'用户不存在' });
    if (Object.prototype.hasOwnProperty.call(body, 'blocked')){
      u.blocked = body.blocked === true;
      /* 拉黑时立即让其当前登录会话失效，避免已登录用户继续访问 */
      if (u.blocked) u.sessionId = crypto.randomUUID();
    }
    if (Object.prototype.hasOwnProperty.call(body, 'note')){
      u.note = String(body.note || '').slice(0, 500);
    }
    saveUsers();
    return send(res, 200, { ok:true, id:u.id, blocked:u.blocked === true, note:String(u.note || '') });
  }
  if ((m = p.match(/^\/api\/users\/([^/]+)$/)) && req.method === 'DELETE'){
    const arr = loadUsers().users;
    const idx = arr.findIndex(x => String(x.id) === m[1]);
    if (idx < 0) return send(res, 404, { ok:false, error:'用户不存在' });
    arr.splice(idx, 1);
    saveUsers();
    return send(res, 200, { ok:true });
  }

  /* ---- 全量配置（前端启动拉取） ---- */
  if (p === '/api/config' && req.method === 'GET'){
    const d = loadData();
    return send(res, 200, { quickButtons: d.quickButtons, composerButtons: d.composerButtons || [], fallback: d.fallback, guide: d.guide, placeholder: d.placeholder, menuTexts: d.menuTexts || {} });
  }

  /* ---- 输入框占位提示（按在线状态区分，三语） ---- */
  if (p === '/api/placeholder' && req.method === 'GET'){
    return send(res, 200, loadData().placeholder);
  }
  if (p === '/api/placeholder' && req.method === 'PUT'){
    const body = await readBody(req);
    const d = loadData();
    d.placeholder = { bot: normLabel(body.bot), agent: normLabel(body.agent) };
    saveData(d);
    return send(res, 200, { ok:true, placeholder: d.placeholder });
  }

  /* ---- 首页引导文字（三语，后台自由修改） ---- */
  if (p === '/api/guide' && req.method === 'GET'){
    return send(res, 200, loadData().guide);
  }
  if (p === '/api/guide' && req.method === 'PUT'){
    const body = await readBody(req);
    const d = loadData();
    d.guide = { text: normLabel(body.text) };
    saveData(d);
    return send(res, 200, { ok:true, guide: d.guide });
  }

  /* ---- 左侧菜单文案（5 项名称 + 简介，三语；稀疏存储，留空即用页面默认） ---- */
  if (p === '/api/menu-texts' && req.method === 'GET'){
    return send(res, 200, { texts: loadData().menuTexts || {} });
  }
  if (p === '/api/menu-texts' && req.method === 'PUT'){
    const body = await readBody(req);
    const d = loadData();
    d.menuTexts = normMenuTexts(body && body.texts);
    saveData(d);
    return send(res, 200, { ok:true, texts: d.menuTexts });
  }

  /* ---- 图片媒体：上传（前端已压缩的 dataURL）与读取 ----
     上传开放给游客前端使用；严格限定为图片 dataURL 并限制体积，避免被滥用 */
  if (p === '/api/media' && req.method === 'POST'){
    const body = await readBody(req, 8 * 1024 * 1024);
    if (body && body.__tooLarge) return send(res, 413, { ok:false, error:'图片过大，请压缩后再试' });
    const m = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(body.dataUrl || ''));
    if (!m) return send(res, 400, { ok:false, error:'仅支持图片文件' });
    let buf;
    try { buf = Buffer.from(m[2], 'base64'); } catch(e){ return send(res, 400, { ok:false, error:'仅支持图片文件' }); }
    if (!buf.length || buf.length > MEDIA_MAX) return send(res, 413, { ok:false, error:'图片过大，请压缩后再试' });
    const id = await saveMedia(buf, m[1] === 'image/jpg' ? 'image/jpeg' : m[1]);
    return send(res, 200, { ok:true, id, url:'/api/media/' + id });
  }
  if (p.startsWith('/api/media/') && req.method === 'GET'){
    const id = decodeURIComponent(p.slice('/api/media/'.length));
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return send(res, 404, 'Not Found');   // 限定 id 形态，杜绝路径穿越
    const med = await loadMedia(id);
    if (!med) return send(res, 404, 'Not Found');
    res.writeHead(200, { 'Content-Type': med.mime, 'Content-Length': med.buf.length, 'Cache-Control': 'public, max-age=31536000, immutable' });
    return res.end(med.buf);
  }

  /* ---- 匹配接口（游客前端调用，返回三语数据；带会话时记录消息并支持人工接管） ---- */
  if (p === '/api/match' && req.method === 'POST'){
    const body = await readBody(req);
    const sid = String(body.sessionId || '').slice(0, 64);
    // 旧会话已被后台人工结束：旧会话锁定（不追加任何消息），分配全新会话 ID
    let activeSid = sid;
    let reset = false;
    if (sid && loadChats().sessions[sid] && loadChats().sessions[sid].ended){
      activeSid = crypto.randomUUID();
      reset = true;
    }
    const sess = activeSid ? getSession(activeSid) : null;
    if (sess && (body.lang === 'zh' || body.lang === 'en' || body.lang === 'ru')) sess.lang = body.lang;
    if (sess && body.guest === true) sess.guest = true;   // 游客会话标记（人工接管现已对游客会话开放）
    if (activeSid){
      const vm = { role:'visitor', text:String(body.text || '').slice(0, 2000) };
      const imgId = String(body.imageId || '').trim();
      if (/^[A-Za-z0-9_-]{8,64}$/.test(imgId)) vm.image = '/api/media/' + imgId;   // 图片消息仅存引用，图片本体在 media 集合
      addMsg(activeSid, vm);
    }
    // 人工接管中：暂停机器人自动关键词回复（后台仍可手动发言）
    if (sess && sess.mode === 'agent'){
      return send(res, 200, { reply:{ zh:'', en:'', ru:'' }, quickButtons:[], matched:false, agentMode:true, link:null, sid: activeSid, reset });
    }
    // 机器人总开关关闭：不做任何关键词匹配，不发送任何自动消息（游客消息仍正常入库）
    if (!loadData().agentChat.botEnabled){
      return send(res, 200, { reply:{ zh:'', en:'', ru:'' }, quickButtons:[], matched:false, botDisabled:true, link:null, sid: activeSid, reset });
    }
    const payload = matchPayload(matchInput(body.text, body.lang));
    // 命中规则或兜底回复（任一语种有内容）均入会话流，游客端轮询同步可见
    // 多条消息（卡片 + 主回复 + 追加消息）按配置顺序逐条写入，各自带延时字段
    if (activeSid) pushRuleMsgs(activeSid, payload, loadData().replySeq !== false);
    payload.sid = activeSid || undefined;
    payload.reset = reset;
    return send(res, 200, payload);
  }

  /* ---- 全岛游价格方案配置 ---- */
  /* 公开：游客端打卡点页面读取报价（免拼 4/7/9 座整车价 + 拼团各车型单人价；0 = 未配置，前端占位展示） */
  if (p === '/api/island-config' && req.method === 'GET'){
    const pr = loadData().islandPricing || {};
    const pv = pr.private || {};
    const sh = pr.shared || {};
    return send(res, 200, { ok:true, pricing: {
      private: { seat4: pv.seat4 || 0, seat7: pv.seat7 || 0, seat9: pv.seat9 || 0 },
      shared: { seat4: sh.seat4 || 0, seat7: sh.seat7 || 0, seat9: sh.seat9 || 0 }
    }});
  }
  /* 后台：设置价格方案。seat4/seat7/seat9 为免拼各车型整车价，
     shared4/shared7/shared9 为拼团各车型单人单价；各项 0-999999，填 0 即未配置（游客端该项显示占位） */
  if (p === '/api/admin/island-config' && req.method === 'PUT'){
    const body = await readBody(req);
    function num(v){ const n = Math.round(+v || 0); return (n >= 0 && n <= 999999) ? n : -1; }
    const seat4 = num(body.seat4), seat7 = num(body.seat7), seat9 = num(body.seat9);
    const sh4 = num(body.shared4), sh7 = num(body.shared7), sh9 = num(body.shared9);
    if (seat4 < 0 || seat7 < 0 || seat9 < 0 || sh4 < 0 || sh7 < 0 || sh9 < 0)
      return send(res, 400, { ok:false, error:'价格需为 0-999999 的数字' });
    const d = loadData();
    d.islandPricing = {
      private: { seat4: seat4, seat7: seat7, seat9: seat9 },
      shared: { seat4: sh4, seat7: sh7, seat9: sh9 }
    };
    await saveData(d);
    return send(res, 200, { ok:true, pricing: d.islandPricing });
  }

  /* ---- 全岛游打卡提交（游客子页面调用，免鉴权）----
     游客在打卡点地图选中点位后点「免拼 / 拼团」并填写人数，这里记录：
       · 选中的点位 ID（露营点 + 打卡点）
       · 出行方式（免拼 / 拼团）与出行人数
       · 当前打卡时间（消息自带的 ts）
     不收集任何游客联系方式。提交后前端跳回主站首页，右侧聊天框
     通过既有的消息同步把这条内容按访客消息展示，后台人工也能在实时对话里看到。 */
  if (p === '/api/island/submit' && req.method === 'POST'){
    const body = await readBody(req);
    const lang = ['zh', 'en', 'ru'].indexOf(body.lang) >= 0 ? body.lang : 'zh';
    const campRaw = body.camp && typeof body.camp === 'object' ? body.camp : {};
    const campId = String(campRaw.id || '').trim().slice(0, 64);
    if (!campId) return send(res, 400, { ok:false, error:'请先选择露营点' });
    /* 只保留合法的点位 ID 形态，杜绝注入；spots 为空也允许（只打卡露营点） */
    const spotIds = (Array.isArray(body.spots) ? body.spots : [])
      .map(function (s) { return String(s == null ? '' : s).trim().slice(0, 64); })
      .filter(function (s) { return /^[A-Za-z0-9_-]{2,64}$/.test(s); })
      .slice(0, 30);
    /* 出行人数：可选项，仅接受 1-9 的整数；非法值按未填写处理（不影响提交） */
    const pp = parseInt(body.people, 10);
    const people = (pp >= 1 && pp <= 9) ? pp : 0;
    /* 帐篷数量：可选项，0-9；0 或未填表示未指定 */
    const tp = parseInt(body.tents, 10);
    const tents = (!isNaN(tp) && tp >= 0 && tp <= 9) ? tp : 0;
    /* 帐篷类型：single 单人帐篷 / shared 多人共用大帐篷，其他值按未指定 */
    const tentType = (body.tentType === 'single' || body.tentType === 'shared') ? body.tentType : '';
    /* 出行方式：免拼 private / 拼团 shared，其它值按未选择处理 */
    const tourType = (body.tourType === 'private' || body.tourType === 'shared') ? body.tourType : '';
    /* 所选车型：4/7/9 座（座位含司机，乘客上限 3/6/8）。
       免拼/拼团均带车型（拼团用于取对应车型的单人单价）；
       客户端选的车型坐不下时自动改派最小可坐车型；9 人无适配车型则留空（客服定制） */
    let vehicle = 0;
    {
      const CAPS = { 4:3, 7:6, 9:8 };
      const v = parseInt(body.vehicle, 10);
      if (CAPS[v] && (!people || CAPS[v] >= people)) vehicle = v;
      if (!vehicle && people){
        const order = [4, 7, 9];
        for (let i = 0; i < order.length; i++){
          if (CAPS[order[i]] >= people){ vehicle = order[i]; break; }
        }
      }
    }

    let sid = String(body.sessionId || '').trim().slice(0, 64);
    /* 旧会话已被后台人工结束：改写到全新会话，避免把消息追加进已关闭的对话 */
    if (sid && loadChats().sessions[sid] && loadChats().sessions[sid].ended) sid = crypto.randomUUID();
    if (!sid) sid = crypto.randomUUID();

    const sess = getSession(sid);
    sess.lang = lang;
    const summaryText = islandSummary(lang, { campId: campId, spots: spotIds, people: people, tourType: tourType, vehicle: vehicle, tents: tents, tentType: tentType });
    addMsg(sid, {
      role:'visitor',
      text: summaryText,
      island: { campId: campId, spots: spotIds, tourType: tourType || undefined, people: people || undefined, vehicle: vehicle || undefined, tents: tents || undefined, tentType: tentType || undefined, checkedAt: Date.now() }   // 结构化打卡记录：点位ID + 方式 + 人数 + 车型 + 帐篷 + 打卡时间
    });
    /* 系统整理文本同样走一遍关键词匹配：命中规则（如「出行方式: 拼团」）则自动追加机器人回复/卡片；
       未命中保持静默（不发兜底）；人工接管中或机器人总开关关闭时不自动回复，与 /api/match 行为一致 */
    if (sess.mode !== 'agent' && loadData().agentChat.botEnabled){
      const hit = matchPayload(matchInput(summaryText, lang));
      if (hit.matched) pushRuleMsgs(sid, hit, loadData().replySeq !== false);
    }
    return send(res, 200, { ok:true, sid });
  }

  /* ---- 官网预订成功页【确定】：把所选项目写入客服会话（跨域调用，直接成为一条访客消息） ---- */
  if (p === '/api/booking/note' && req.method === 'POST'){
    const body = await readBody(req);
    const text = String((body && body.text) || '').trim().slice(0, 4000);
    if (!text) return send(res, 400, { ok:false, error:'text required' });
    const db = loadChats();
    /* 会话归属（优先级从高到低）：
       1) sessionId —— 站内体验页从本站菜单跳转时带着本标签页的会话 ID（sessionStorage beisu_sid）。
          该会话可能还没落库（访客没发过消息），这里直接按此 ID 建会话，保证清单回到访客自己的聊天框
       2) visitorKey —— 官网独立域名访问时自己持久化的访客标识，映射为固定的 bk-<key> 会话，
          这样直接访问官网的访客每次预订都会落到同一个会话里，坐席不会看散
       3) 都没有时退回「最近活跃会话」，再没有就新建一个 */
    let sid = '';
    const wantSid = String((body && body.sessionId) || '').trim();
    if (/^[A-Za-z0-9_-]{1,64}$/.test(wantSid)) sid = wantSid;
    if (!sid){
      const vkey = String((body && body.visitorKey) || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
      if (vkey) sid = 'bk-' + vkey;
    }
    if (!sid){
      let latestTs = -1;
      Object.keys(db.sessions || {}).forEach(k => {
        const s = db.sessions && db.sessions[k];
        if (!s || !Array.isArray(s.messages) || !s.messages.length) return;
        const ts = s.messages[s.messages.length - 1].ts || 0;
        if (ts > latestTs){ latestTs = ts; sid = k; }
      });
    }
    if (!sid) sid = getSession('booking').id;   // 还没有任何会话时新建一个，供坐席查看
    const msg = addMsg(sid, { role:'visitor', text, bookingId:String((body && body.bookingId) || '').slice(0, 40) });
    return send(res, 201, { ok:true, sessionId:sid, id:msg.id });
  }

  /* ---- 站内「海南项目体验」预订表单：保存预订记录并返回预订编号 ---- */
  if (p === '/api/bookings' && req.method === 'POST'){
    const body = await readBody(req);
    const name = String((body && body.name) || '').trim().slice(0, 60);
    const contact = String((body && body.contact) || '').trim().slice(0, 80);
    if (!name || !contact) return send(res, 400, { ok:false, error:'请填写姓名与联系方式' });
    const d = loadData();
    if (!Array.isArray(d.bookings)) d.bookings = [];
    const record = {
      id: 'HA-' + (2600 + d.bookings.length + 1),
      name,
      contact,
      date: String((body && body.date) || '').slice(0, 30),
      pax: Math.max(0, Math.min(99, Number((body && body.pax) || 0)) | 0),
      serviceType: (body && body.serviceType) === 'private' ? 'private' : 'group',   // 基础服务购买方式：拼团 / 免拼
      slug: String((body && body.slug) || '').slice(0, 60),
      projectName: String((body && body.projectName) || '').slice(0, 120),
      fromCity: String((body && body.fromCity) || '').slice(0, 60),
      flightNo: String((body && body.flightNo) || '').slice(0, 40),
      arriveTime: String((body && body.arriveTime) || '').slice(0, 20),
      screenshot: String((body && body.screenshot) || '').slice(0, 300),
      remark: String((body && body.remark) || '').slice(0, 800),
      lang: ['zh','en','ru'].indexOf(body && body.lang) >= 0 ? body.lang : 'zh',
      createdAt: Date.now()
    };
    d.bookings.unshift(record);
    if (d.bookings.length > 500) d.bookings.length = 500;
    await saveData(d);
    return send(res, 200, record);
  }

  /* ---- 站内「海南项目体验」页脚联系方式（只读）：与官网 /api/settings 保持同一份字段 ---- */
  if (p === '/api/settings' && req.method === 'GET'){
    const d = loadData();
    const base = { brandIntro:'', email:'hello@example.com', phone:'+86 000 0000 0000', telegram:'', instagram:'', facebook:'' };
    const own = (d.siteSettings && typeof d.siteSettings === 'object') ? d.siteSettings : {};
    return send(res, 200, Object.assign(base, own));
  }

  /* ---- 海南项目体验 · 项目与价格：游客端读取（只读），后台保存（需登录） ---- */
  if (p === '/api/exp/projects' && req.method === 'GET'){
    const d = loadData();
    return send(res, 200, { ok:true, projects: d.expProjects || {} });
  }
  if (p === '/api/exp/projects' && req.method === 'PUT'){
    const body = await readBody(req);
    const d = loadData();
    d.expProjects = normExpProjects(body && body.projects);
    await saveData(d);
    return send(res, 200, { ok:true, projects: d.expProjects });
  }

  /* ---- 人工介入聊天接口 ---- */
  if (p === '/api/chats' && req.method === 'GET'){
    const db = loadChats();
    const list = Object.values(db.sessions)
      .filter(s => s.messages.length)
      .map(s => {
        const last = s.messages[s.messages.length - 1];
        return {
          id: s.id, mode: s.mode, createdAt: s.createdAt, count: s.messages.length,
          last: { role: last.role, text: last.text || (last.image ? '[图片]' : '') || (last.reply && last.reply.zh) || '', ts: last.ts }
        };
      })
      .sort((a, b) => b.last.ts - a.last.ts);
    return send(res, 200, list);
  }
  if (p.startsWith('/api/chat/') && p.endsWith('/messages') && req.method === 'GET'){
    const sid = decodeURIComponent(p.slice('/api/chat/'.length, -'/messages'.length));
    const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
    const s = loadChats().sessions[sid];   // 不主动创建会话
    const msgs = s ? s.messages : [];
    scheduleTrFill(s);   // 异步补齐三语译文，不阻塞本次响应
    return send(res, 200, {
      mode: s ? s.mode : 'bot',
      ended: !!(s && s.ended),
      messages: msgs.filter(m => m.id > since)
    });
  }
  if (p.startsWith('/api/chat/') && p.endsWith('/agent') && req.method === 'POST'){
    const sid = decodeURIComponent(p.slice('/api/chat/'.length, -'/agent'.length));
    const body = await readBody(req);
    const text = String(body.text || '').trim();
    if (!text) return send(res, 400, { error:'empty text' });
    const s = getSession(sid);
    if (s.ended) return send(res, 409, { error:'session ended' });
    // 人工手动发送：总开关开启且客户界面语种非中文时，自动翻译为客户语种
    // （无论会话处于机器人自动回复还是人工接管模式，人工发的消息都走此逻辑；机器人自动回复不经过翻译）
    let out = text, origText = null;
    if (loadData().agentChat.translate && (s.lang === 'en' || s.lang === 'ru')){
      const t = await translateText(text, s.lang);
      if (t && t !== text){ origText = text; out = t; }
    }
    const msg = { role:'agent', text: out.slice(0, 2000) };
    if (origText){
      msg.origText = origText;   // 人工输入的中文原文：客户界面据此展示「中文原文 + 对应语种译文」
      msg.trLang = s.lang;       // text 所属语种（客户切换语种后据此判断能否直接复用 text）
    }
    const m = addMsg(sid, msg);
    return send(res, 200, { ok:true, message:m });
  }
  /* ---- 人工实时对话发送页面卡片：客服在聊天面板选卡片一键发送给游客 ---- */
  if (p.startsWith('/api/chat/') && p.endsWith('/agent-card') && req.method === 'POST'){
    const sid = decodeURIComponent(p.slice('/api/chat/'.length, -'/agent-card'.length));
    const body = await readBody(req);
    const cardId = String(body.cardId || '').trim();
    const c = loadData().cards.filter(function (x) { return x.id === cardId && x.enabled !== false; })[0];
    if (!c) return send(res, 404, { error:'card not found' });
    if (!c.url) return send(res, 400, { error:'该页面尚未配置跳转地址' });
    const s = getSession(sid);
    if (s.ended) return send(res, 409, { error:'session ended' });
    const m = addMsg(sid, { role:'agent', card:{ id:c.id, pageKey:c.pageKey, url:c.url, cover:c.cover, titles:c.titles, descs:c.descs } });
    return send(res, 200, { ok:true, message:m });
  }
  /* ---- 后台人工主动结束会话：硬删除全部消息，服务器不留存；旧会话锁定 ---- */
  if (p.startsWith('/api/chat/') && p.endsWith('/end') && req.method === 'POST'){
    const sid = decodeURIComponent(p.slice('/api/chat/'.length, -'/end'.length));
    const db = loadChats();
    const s = db.sessions[sid];
    if (!s) return send(res, 404, { error:'no session' });
    s.messages = [];            // 硬删除全部聊天消息，删除后不可恢复
    s.ended = true;
    s.endedAt = Date.now();
    saveChats();
    return send(res, 200, { ok:true });
  }
  /* ---- 人工消息自动翻译总开关 ---- */
  if (p === '/api/agent-translate' && req.method === 'GET'){
    return send(res, 200, { translate: loadData().agentChat.translate });
  }
  if (p === '/api/agent-translate' && req.method === 'PUT'){
    const body = await readBody(req);
    const d = loadData();
    d.agentChat.translate = body.translate === true;   // 保留机器人总开关，避免整体覆盖
    saveData(d);
    return send(res, 200, { ok:true, translate: d.agentChat.translate });
  }
  /* ---- 机器人总开关（一键全局关停自动回复） ---- */
  if (p === '/api/bot-switch' && req.method === 'GET'){
    return send(res, 200, { enabled: loadData().agentChat.botEnabled !== false });
  }
  if (p === '/api/bot-switch' && req.method === 'PUT'){
    const body = await readBody(req);
    const d = loadData();
    d.agentChat.botEnabled = body.enabled === true;    // 保留翻译开关，避免整体覆盖
    saveData(d);
    broadcastState(true);
    return send(res, 200, { ok:true, enabled: d.agentChat.botEnabled });
  }
  /* ---- 关键词回复「顺序延时发送」总开关（缺省开启；关闭则追加消息瞬时全部发出） ---- */
  if (p === '/api/reply-seq' && req.method === 'GET'){
    return send(res, 200, { enabled: loadData().replySeq !== false });
  }
  if (p === '/api/reply-seq' && req.method === 'PUT'){
    const body = await readBody(req);
    const d = loadData();
    d.replySeq = body.enabled === true;
    saveData(d);
    return send(res, 200, { ok:true, enabled: d.replySeq });
  }
  if (p.startsWith('/api/chat/') && p.endsWith('/mode') && req.method === 'POST'){
    const sid = decodeURIComponent(p.slice('/api/chat/'.length, -'/mode'.length));
    const body = await readBody(req);
    const s = getSession(sid);
    s.mode = (body.mode === 'agent') ? 'agent' : 'bot';
    saveChats();
    return send(res, 200, { ok:true, mode:s.mode });
  }
  if (p.startsWith('/api/chat/') && req.method === 'GET'){
    const sid = decodeURIComponent(p.slice('/api/chat/'.length));
    const s = getSession(sid);
    scheduleTrFill(s);   // 后台打开会话即触发三语补齐，不阻塞本次响应
    return send(res, 200, { id:s.id, mode:s.mode, lang:s.lang || '', messages:s.messages });
  }

  /* ---- 首页快捷按钮 CRUD ---- */
  if (p === '/api/quick-buttons' && req.method === 'GET'){
    return send(res, 200, loadData().quickButtons);
  }
  if (p === '/api/quick-buttons' && req.method === 'POST'){
    const body = await readBody(req);
    const d = loadData();
    const btn = normalizeHomeButton(body);
    d.quickButtons.push(btn);
    saveData(d);
    return send(res, 201, btn);
  }
  if ((m = p.match(/^\/api\/quick-buttons\/([^/]+)$/)) && req.method === 'PUT'){
    const d = loadData();
    const i = d.quickButtons.findIndex(b => b.id === m[1]);
    if (i < 0) return send(res, 404, { error:'button not found' });
    d.quickButtons[i] = normalizeHomeButton({ id:m[1], ...await readBody(req) });
    saveData(d);
    return send(res, 200, d.quickButtons[i]);
  }
  if ((m = p.match(/^\/api\/quick-buttons\/([^/]+)$/)) && req.method === 'DELETE'){
    const d = loadData();
    d.quickButtons = d.quickButtons.filter(b => b.id !== m[1]);
    saveData(d);
    return send(res, 200, { ok:true });
  }

  /* ---- 输入框快捷按钮（整体读取/保存；空文案按钮由前端隐藏，保留槽位稳定） ---- */
  if (p === '/api/composer-buttons' && req.method === 'GET'){
    return send(res, 200, loadData().composerButtons || []);
  }
  if (p === '/api/composer-buttons' && req.method === 'PUT'){
    const body = await readBody(req);
    const d = loadData();
    const list = Array.isArray(body.buttons) ? body.buttons : [];
    d.composerButtons = list.map(normalizeHomeButton);
    saveData(d);
    return send(res, 200, { ok:true, composerButtons: d.composerButtons });
  }

  /* ---- 文章资讯：前台只返回已发布（草稿不外泄），按发布时间倒序；标题三语一并下发，前端按当前语言渲染 ---- */
  if (p === '/api/articles' && req.method === 'GET'){
    const list = loadData().articles.filter(a => a.status === 'published')
      .sort((x, y) => (y.publishedAt || 0) - (x.publishedAt || 0))
      .map(a => {
        const titles = {};
        ART_LANGS.forEach(l => { titles[l] = String(((a.i18n || {})[l] || {}).title || ''); });
        return { id:a.id, title:a.title, titles, url:articlePath(a), cover:a.cover, publishedAt:a.publishedAt };
      });
    return send(res, 200, list);
  }

  /* ---- 商业活动：前台返回后台录入的图文（标题/正文三语 + 配图），按更新时间倒序 ----
         与文章资讯分开：仅用于前端左侧「商业活动」板块的卡片与详情展示，无独立页面 ---- */
  if (p === '/api/events' && req.method === 'GET'){
    const list = loadData().events.slice()
      .sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0))
      .map(e => {
        const titles = {}, bodies = {};
        ART_LANGS.forEach(l => {
          const cell = (e.i18n || {})[l] || {};
          titles[l] = String(cell.title || '');
          bodies[l] = String(cell.body || '');
        });
        return { id:e.id, title:e.title, titles, body:e.body, bodies, cover:e.cover, updatedAt:e.updatedAt };
      });
    return send(res, 200, list);
  }

  /* ---- 关键词规则 CRUD ---- */
  if (p === '/api/rules' && req.method === 'GET'){
    return send(res, 200, loadData().rules);
  }
  if (p === '/api/rules' && req.method === 'POST'){
    const body = await readBody(req);
    const d = loadData();
    const rule = normalizeRule(body);
    d.rules.push(rule);
    saveData(d);
    return send(res, 201, rule);
  }
  if ((m = p.match(/^\/api\/rules\/([^/]+)$/)) && req.method === 'PUT'){
    const d = loadData();
    const i = d.rules.findIndex(r => r.id === m[1]);
    if (i < 0) return send(res, 404, { error:'rule not found' });
    d.rules[i] = normalizeRule({ id:m[1], ...await readBody(req) });
    saveData(d);
    return send(res, 200, d.rules[i]);
  }
  if ((m = p.match(/^\/api\/rules\/([^/]+)\/toggle$/)) && req.method === 'PATCH'){
    const d = loadData();
    const rule = d.rules.find(r => r.id === m[1]);
    if (!rule) return send(res, 404, { error:'rule not found' });
    rule.enabled = rule.enabled === false ? true : false;
    saveData(d);
    return send(res, 200, rule);
  }
  if ((m = p.match(/^\/api\/rules\/([^/]+)$/)) && req.method === 'DELETE'){
    const d = loadData();
    d.rules = d.rules.filter(r => r.id !== m[1]);
    saveData(d);
    return send(res, 200, { ok:true });
  }

  /* ---- 文章资讯 CRUD（后台；未加入白名单 → 必须携带登录 token） ---- */
  if (p === '/api/admin/articles' && req.method === 'GET'){
    return send(res, 200, loadData().articles);
  }
  if (p === '/api/admin/articles' && req.method === 'POST'){
    const body = await readBody(req);
    if (!artHasTitle(body)) return send(res, 400, { error:'请至少填写一种语言的标题' });
    const d = loadData();
    const art = normArticle({ ...body, id:undefined, createdAt:Date.now(), updatedAt:Date.now() }, d.articles);
    d.articles.unshift(art);
    pruneAliases(d.articles, art);                                                       // 该 slug 已被本文章启用，从其它文章的历史别名里摘除
    saveData(d);
    return send(res, 201, art);
  }
  if ((m = p.match(/^\/api\/admin\/articles\/([^/]+)$/)) && req.method === 'PUT'){
    const body = await readBody(req);
    if (!artHasTitle(body)) return send(res, 400, { error:'请至少填写一种语言的标题' });
    const d = loadData();
    const i = d.articles.findIndex(a => a.id === m[1]);
    if (i < 0) return send(res, 404, { error:'article not found' });
    const prev = d.articles[i];
    const art = normArticle({ ...prev, ...body, id:m[1], createdAt:prev.createdAt, publishedAt:body.status === 'published' ? (prev.publishedAt || Date.now()) : prev.publishedAt, updatedAt:Date.now() }, d.articles);
    if (art.slug !== prev.slug){                                                          // 别名被改动：旧 slug 留存为历史别名，旧链接 301 跳新页
      art.prevSlugs = Array.from(new Set([...(art.prevSlugs || []), prev.slug])).filter(s => s !== art.slug);
    }
    d.articles[i] = art;
    pruneAliases(d.articles, art);
    saveData(d);
    return send(res, 200, d.articles[i]);
  }
  if ((m = p.match(/^\/api\/admin\/articles\/([^/]+)$/)) && req.method === 'DELETE'){
    const d = loadData();
    d.articles = d.articles.filter(a => a.id !== m[1]);
    saveData(d);
    return send(res, 200, { ok:true });
  }

  /* ---- 商业活动 CRUD（后台；与文章资讯分开存储，无独立页面/slug） ---- */
  if (p === '/api/admin/events' && req.method === 'GET'){
    return send(res, 200, loadData().events);
  }
  if (p === '/api/admin/events' && req.method === 'POST'){
    const body = await readBody(req);
    if (!artHasTitle(body)) return send(res, 400, { error:'请至少填写一种语言的标题' });
    const d = loadData();
    const evt = normEvent({ ...body, id:undefined, createdAt:Date.now(), updatedAt:Date.now() });
    d.events.unshift(evt);
    saveData(d);
    return send(res, 201, evt);
  }
  if ((m = p.match(/^\/api\/admin\/events\/([^/]+)$/)) && req.method === 'PUT'){
    const body = await readBody(req);
    if (!artHasTitle(body)) return send(res, 400, { error:'请至少填写一种语言的标题' });
    const d = loadData();
    const i = d.events.findIndex(e => e.id === m[1]);
    if (i < 0) return send(res, 404, { error:'event not found' });
    const prev = d.events[i];
    d.events[i] = normEvent({ ...prev, ...body, id:m[1], createdAt:prev.createdAt, updatedAt:Date.now() });
    saveData(d);
    return send(res, 200, d.events[i]);
  }
  if ((m = p.match(/^\/api\/admin\/events\/([^/]+)$/)) && req.method === 'DELETE'){
    const d = loadData();
    d.events = d.events.filter(e => e.id !== m[1]);
    saveData(d);
    return send(res, 200, { ok:true });
  }

  /* ---- 页面卡片：后台 CRUD（未加入白名单 → 必须带 token） ---- */
  /* 列出全部页面 + 各页面已绑定的卡片；pages 常量一并下发供后台渲染下拉 */
  if (p === '/api/admin/cards' && req.method === 'GET'){
    const d = loadData();
    return send(res, 200, {
      pages: CARD_PAGES.map(function (pg) { return { key:pg.key, url:pg.url, names:pg.names }; }),
      cards: d.cards
    });
  }
  if (p === '/api/admin/cards' && req.method === 'POST'){
    const body = await readBody(req);
    const err = validateCard(body);
    if (err) return send(res, 400, { error:err });
    const d = loadData();
    const card = normCard({ ...body, id:undefined, createdAt:Date.now(), updatedAt:Date.now() });
    d.cards.unshift(card);
    saveData(d);
    return send(res, 201, card);
  }
  if ((m = p.match(/^\/api\/admin\/cards\/([^/]+)$/)) && req.method === 'PUT'){
    const body = await readBody(req);
    const d = loadData();
    const i = d.cards.findIndex(c => c.id === m[1]);
    if (i < 0) return send(res, 404, { error:'card not found' });
    const prev = d.cards[i];
    /* 合并旧数据后再校验：允许只传部分字段（如仅切换 enabled 停用/启用） */
    const err = validateCard({ ...prev, ...body, pageKey: body.pageKey || prev.pageKey });
    if (err) return send(res, 400, { error:err });
    d.cards[i] = normCard({ ...prev, ...body, id:m[1], createdAt:prev.createdAt, updatedAt:Date.now() });
    saveData(d);
    return send(res, 200, d.cards[i]);
  }
  if ((m = p.match(/^\/api\/admin\/cards\/([^/]+)$/)) && req.method === 'DELETE'){
    const d = loadData();
    d.cards = d.cards.filter(c => c.id !== m[1]);
    /* 解除所有关键词规则对这张卡片的绑定，避免留下指向已删卡片的死引用 */
    d.rules.forEach(function (r) { if (r.cardId === m[1]) r.cardId = ''; });
    saveData(d);
    return send(res, 200, { ok:true });
  }

  /* ---- 全岛游地图：游客端两个子页面用的只读接口（已加入白名单，无需登录 token） ---- */
  if (p === '/api/camp-points' && req.method === 'GET'){
    return send(res, 200, { categories:MAP_KINDS, points:mapCampPoints(), landmarks:mapLandmarks() });
  }
  if (p === '/api/play-points' && req.method === 'GET'){
    return send(res, 200, { category:mapPlayKind(), points:mapPlayPoints() });
  }

  /* ---- 全岛游地图：后台点位 CRUD（露营点 / 打卡点共用同一份点位数据；未加入白名单 → 必须带 token） ---- */
  if (p === '/api/admin/map-points' && req.method === 'GET'){
    const d = loadMap();
    return send(res, 200, {
      categories: d.categories,
      campKinds: MAP_KINDS.map(k => ({ key:k.key, names:k.names, color:k.color })),
      points: d.points.map(pt => ({
        id:pt.id, categories:mapCats(pt), name:pt.name || '', names:pt.names || {}, intro:pt.intro || {},
        lng:+pt.lng, lat:+pt.lat, campType:d.campTypes[pt.id] || ''
      }))
    });
  }
  if (p === '/api/admin/map-points' && req.method === 'POST'){
    const body = await readBody(req);
    const d = loadMap();
    const v = validateMapPoint(body, d);
    if (v.error) return send(res, 400, { error:v.error });
    const pt = normMapPoint({ id:'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
                             categories:v.categories, names:v.names, intro:v.intro, lng:v.lng, lat:v.lat });
    d.points.push(pt);
    if (v.campType) d.campTypes[pt.id] = v.campType; else delete d.campTypes[pt.id];
    saveMap(d);
    return send(res, 201, { ok:true, point:pt });
  }
  if ((m = p.match(/^\/api\/admin\/map-points\/([^/]+)$/)) && req.method === 'PUT'){
    const body = await readBody(req);
    const d = loadMap();
    const i = d.points.findIndex(x => x.id === m[1]);
    if (i < 0) return send(res, 404, { error:'点位不存在' });
    const v = validateMapPoint(body, d);
    if (v.error) return send(res, 400, { error:v.error });
    d.points[i] = normMapPoint({ id:m[1], categories:v.categories, names:v.names, intro:v.intro, lng:v.lng, lat:v.lat });
    if (v.campType) d.campTypes[m[1]] = v.campType; else delete d.campTypes[m[1]];
    saveMap(d);
    return send(res, 200, { ok:true, point:d.points[i] });
  }
  if ((m = p.match(/^\/api\/admin\/map-points\/([^/]+)$/)) && req.method === 'DELETE'){
    const d = loadMap();
    const i = d.points.findIndex(x => x.id === m[1]);
    if (i < 0) return send(res, 404, { error:'点位不存在' });
    d.points.splice(i, 1);
    delete d.campTypes[m[1]];              /* 删点位时连带删掉它的露营点子类型 */
    saveMap(d);
    return send(res, 200, { ok:true });
  }

  /* ---- 全岛游地图：后台图层（分类）CRUD（未加入白名单 → 必须带 token） ---- */
  if (p === '/api/admin/map-layers' && req.method === 'GET'){
    const d = loadMap();
    const counts = {};
    d.categories.forEach(c => { counts[c.key] = d.points.filter(pt => mapCats(pt).indexOf(c.key) >= 0).length; });
    return send(res, 200, { categories:d.categories, counts:counts });
  }
  if (p === '/api/admin/map-layers' && req.method === 'POST'){
    const body = await readBody(req);
    const d = loadMap();
    const v = validateLayer(body, d, null);
    if (v.error) return send(res, 400, { error:v.error });
    d.categories.push(v.layer);
    saveMap(d);
    return send(res, 201, { ok:true, category:v.layer });
  }
  if ((m = p.match(/^\/api\/admin\/map-layers\/([^/]+)$/)) && req.method === 'PUT'){
    const body = await readBody(req);
    const key = decodeURIComponent(m[1]);
    const d = loadMap();
    if (!d.categories.some(c => c.key === key)) return send(res, 404, { error:'图层不存在：' + key });
    const v = validateLayer(body, d, key);     /* 编辑时 key 不可改（避免点位失联） */
    if (v.error) return send(res, 400, { error:v.error });
    d.categories = d.categories.map(c => c.key === key ? v.layer : c);
    saveMap(d);
    return send(res, 200, { ok:true, category:v.layer });
  }
  if ((m = p.match(/^\/api\/admin\/map-layers\/([^/]+)$/)) && req.method === 'DELETE'){
    const key = decodeURIComponent(m[1]);
    const d = loadMap();
    if (!d.categories.some(c => c.key === key)) return send(res, 404, { error:'图层不存在：' + key });
    d.categories = d.categories.filter(c => c.key !== key);
    /* 点位若还属于其它类型则保留，仅摘除被删类型；已无类型的点位一并删除（并连带其露营点子类型） */
    const gone = [];
    d.points = d.points.map(pt => {
      const rest = mapCats(pt).filter(k => k !== key);
      if (rest.length === mapCats(pt).length) return pt;
      if (!rest.length){ gone.push(pt.id); return null; }
      return normMapPoint({ id:pt.id, categories:rest, names:pt.names, intro:pt.intro, lng:pt.lng, lat:pt.lat });
    }).filter(Boolean);
    gone.forEach(id => { delete d.campTypes[id]; });
    saveMap(d);
    return send(res, 200, { ok:true, removedPoints:gone.length });
  }

  /* ---- 全岛游地图：驾车路线（高德规划，结果缓存到地图数据的 routes 字段） ---- */
  if (p === '/api/admin/map-routes' && req.method === 'GET'){
    return send(res, 200, { configured: !!amapKey(), routes: loadMap().routes });
  }
  if (p === '/api/admin/map-routes/build' && req.method === 'POST'){
    const key = amapKey();
    if (!key) return send(res, 400, { error:'未配置高德 Web 服务 Key：请在 data/secrets.json 写入 { "amap": { "key": "你的Key" } }，或设置环境变量 AMAP_KEY 后重启服务' });
    return buildMapRoutes(key, (err, out) => {
      if (err) return send(res, 400, { error:err.message });
      return send(res, 200, { ok:true, routes:out });
    });
  }
  /* 后台「路线查询」：{ from, to } 支持地名或 "lng,lat"，返回的 leg 结构与已缓存路线分段一致，
     后台地图可直接用 setRoutes 渲染；仅在本次响应返回，不写入缓存。 */
  if (p === '/api/admin/map-route/query' && req.method === 'POST'){
    const body = await readBody(req);
    const key = amapKey();
    if (!key) return send(res, 400, { error:'未配置高德 Web 服务 Key：请在 data/secrets.json 写入 { "amap": { "key": "你的Key" } }，或设置环境变量 AMAP_KEY 后重启服务' });
    const from = String(body.from || '').trim();
    const to   = String(body.to || '').trim();
    if (!from) return send(res, 400, { error:'请填写起点' });
    if (!to)   return send(res, 400, { error:'请填写终点' });
    if (from === to) return send(res, 400, { error:'起点和终点相同' });
    try {
      /* 三次高德调用（解析起点 → 解析终点 → 规划）全部串行，避开个人 Key 的低 QPS 限制 */
      const a = await geocodePlace(from, key);
      await amapGap();
      const b = await geocodePlace(to, key);
      await amapGap();
      const leg = await fetchDrivingLeg(a, b, key);
      leg.index = 1;
      leg.from = a;
      leg.to = b;
      console.log('[route] 查询：' + a.name + ' → ' + b.name + '  ' + (leg.distance / 1000).toFixed(1) + ' km');
      return send(res, 200, { ok:true, leg:leg });
    } catch(e){ return send(res, 400, { error:e.message }); }
  }

  /* ---- 全岛游地图：路线方案（手动按顺序挑点位留存到地图数据的 plans 字段；不调高德、不渲染到地图） ---- */
  if (p === '/api/admin/map-plans' && req.method === 'GET'){
    return send(res, 200, { plans: loadMap().plans });
  }
  if (p === '/api/admin/map-plans' && req.method === 'POST'){
    const body = await readBody(req);
    const d = loadMap();
    const v = validatePlan(body, d);
    if (v.error) return send(res, 400, { error:v.error });
    const plan = normPlan({ name:body.name, stops:v.stops });
    d.plans.push(plan);
    saveMap(d);
    return send(res, 200, { ok:true, plan:plan, plans:d.plans });
  }
  if ((m = p.match(/^\/api\/admin\/map-plans\/([^/]+)$/)) && req.method === 'PUT'){
    const body = await readBody(req);
    const id = decodeURIComponent(m[1]);
    const d = loadMap();
    const i = d.plans.findIndex(x => x.id === id);
    if (i < 0) return send(res, 404, { error:'方案不存在：' + id });
    const v = validatePlan(body, d);
    if (v.error) return send(res, 400, { error:v.error });
    const plan = normPlan({ name:body.name, stops:v.stops }, d.plans[i]);
    d.plans[i] = plan;
    saveMap(d);
    return send(res, 200, { ok:true, plan:plan, plans:d.plans });
  }
  if ((m = p.match(/^\/api\/admin\/map-plans\/([^/]+)$/)) && req.method === 'DELETE'){
    const id = decodeURIComponent(m[1]);
    const d = loadMap();
    const i = d.plans.findIndex(x => x.id === id);
    if (i < 0) return send(res, 404, { error:'方案不存在：' + id });
    d.plans.splice(i, 1);
    saveMap(d);
    return send(res, 200, { ok:true, plans:d.plans });
  }

  /* ---- 兜底配置 ---- */
  if (p === '/api/fallback' && req.method === 'GET'){
    return send(res, 200, loadData().fallback);
  }
  if (p === '/api/fallback' && req.method === 'PUT'){
    const body = await readBody(req);
    const d = loadData();
    d.fallback = normalizeFallback(body);
    saveData(d);
    return send(res, 200, d.fallback);
  }

  /* ---- 底部链接模板（多条、多类型） ---- */
  if (p === '/api/link' && req.method === 'GET'){
    return send(res, 200, { links: loadData().links });
  }
  if (p === '/api/link' && req.method === 'PUT'){
    const body = await readBody(req);
    const d = loadData();
    d.links = normalizeLinks(body.links, null);
    saveData(d);
    return send(res, 200, { links: d.links });
  }

  /* ---- 文章独立页面（服务端直出 HTML，SEO 友好，供 Yandex 等爬虫抓取）
         草稿不对外：公开访问 404；后台带 ?preview=<登录token> 可预览（页面标注 noindex） ---- */
  if (p.startsWith('/article/') && req.method === 'GET'){
    const slug = decodeURIComponent(p.slice('/article/'.length));
    const q = url.searchParams.get('lang') || '';
    /* 普通访客按 ?lang 显示对应语种（缺省主语言）；识别到 Yandex 爬虫时定向返回俄语版本，HTML lang 固定为 ru */
    const yandex = isYandexBot(req.headers['user-agent']);
    const al = yandex ? 'ru' : (ART_LANGS.includes(q) ? q : '');
    const { art, redirect } = resolveArticleSlug(slug);
    const preview = !!sessionUser(url.searchParams.get('preview') || '');
    if (!art){
      /* 命中历史别名：301 永久跳转到当前地址，保证已收录链接与外部访问不中断
         Yandex 走干净地址（它本就定向取俄语），其余访客保留显式语言参数 */
      if (redirect && !preview){
        const loc = redirect + ((!yandex && al) ? '?lang=' + al : '');
        res.writeHead(301, { Location: loc, 'Cache-Control':'no-cache', 'Vary':'User-Agent' });
        return res.end();
      }
      return sendHtml(req, res, 404, articleNotFoundHtml());
    }
    if (art.status !== 'published' && !preview) return sendHtml(req, res, 404, articleNotFoundHtml());
    return sendHtml(req, res, 200, articlePageHtml(art, art.status !== 'published', al), true);
  }
  /* ---- sitemap.xml / robots.txt：帮助搜索引擎（Yandex 等）发现并收录已发布文章 ---- */
  if (p === '/sitemap.xml' && req.method === 'GET'){
    res.writeHead(200, { 'Content-Type':'application/xml; charset=utf-8', 'Cache-Control':'no-cache' });
    return res.end(sitemapXml());
  }
  if (p === '/robots.txt' && req.method === 'GET'){
    res.writeHead(200, { 'Content-Type':'text/plain; charset=utf-8', 'Cache-Control':'no-cache' });
    return res.end('User-agent: *\nAllow: /\nSitemap: ' + PUBLIC_BASE_URL + '/sitemap.xml\n');
  }

  /* ---- 静态资源 ---- */
  return serveStatic(req, res);
});

/* ---------------- WebSocket 状态推送（零依赖实现） ----------------
   游客前端连上 /ws 后，人工在线 / 机器人开关状态变化会即时推送到前端，
   指示灯无需等待轮询即可熄灭或点亮。 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const wsClients = new Set();
let lastStateKey = '';
function statePayload(){
  return { type:'state', operatorOnline: operatorOnline(), botEnabled: loadData().agentChat.botEnabled !== false };
}
/* 编码为 WebSocket 文本帧（服务端 → 客户端，无需掩码） */
function wsFrame(str){
  const payload = Buffer.from(String(str), 'utf-8');
  const len = payload.length;
  let header;
  if (len < 126){ header = Buffer.from([0x81, len]); }
  else if (len < 65536){ header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
  return Buffer.concat([header, payload]);
}
function wsSend(socket, str){ try { socket.write(wsFrame(str)); } catch(e){ wsClients.delete(socket); } }
/* 广播状态；force=true 时强制推送，否则状态未变化则跳过 */
function broadcastState(force){
  const st = statePayload();
  const key = st.operatorOnline + '|' + st.botEnabled;
  if (!force && key === lastStateKey) return;
  lastStateKey = key;
  const msg = JSON.stringify(st);
  for (const c of wsClients) wsSend(c, msg);
}
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key){ socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  socket.setNoDelay(true);
  socket.setTimeout(0);   // 长连接不因空闲被回收
  wsClients.add(socket);
  wsSend(socket, JSON.stringify(statePayload()));   // 连接即推送当前状态
  socket.on('close', () => wsClients.delete(socket));
  socket.on('end', () => wsClients.delete(socket));
  socket.on('error', () => { wsClients.delete(socket); try { socket.destroy(); } catch(e){} });
  socket.on('data', buf => {
    /* 客户端帧：opcode 位于低 4 位；0x8 为关闭帧，回包后断开 */
    if (buf && buf.length && (buf[0] & 0x0f) === 0x8){
      try { socket.write(Buffer.from([0x88, 0x00])); } catch(e){}
      wsClients.delete(socket);
      try { socket.end(); } catch(e){}
    }
  });
});
/* 启动引导：先接入云库（如已配置），再监听端口；云库不可用则自动回退本地文件存储 */
(async () => {
  try { await initCloud(loadSecrets().mongo.uri); }
  catch(e){ console.error('[cloud] 初始化失败，回退本地 JSON 文件存储:', e.message); }
  ensureDataFile();
  /* 定时巡检：只广播「人工在线」状态变化。
     必须在云库接入之后才启动——巡检会经 statePayload → operatorOnline → loadAuth，
     而 loadAuth 命中一次即永久缓存（authCache）。若在 cloud.enabled 置位前先跑，
     就会把本地 data/auth.json 的旧账号缓存下来，导致云库里的登录态永不加载
     （表现为：重启 / 冷启动后没有点「退出」却被登出）。 */
  setInterval(sweepSessions, 2000);
  tgBotId().catch(() => {});   // 启动即预热 Telegram Bot ID，避免用户首次点击时等待外网请求
  tgSetupWebhook().catch(() => {});   // 线上环境注册 Telegram webhook（手机端唤起 App 登录用）；本地自动跳过
  server.listen(PORT, () => {
    console.log(`[beisu-visitor] server running at http://localhost:${PORT}`);
    console.log(`  游客前端: http://localhost:${PORT}/`);
    console.log(`  后台管理: http://localhost:${PORT}/admin.html`);
  });
})();
