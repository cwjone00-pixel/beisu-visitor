/* ============================================================
   悖速游客端 · 后端服务（Node.js 内置模块，零依赖）
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

const PORT = process.env.PORT || 3210;
const ROOT = __dirname;
const DATA_FILE = path.join(ROOT, 'data', 'rules.json');
/* 邮件里激活链接的对外基础地址：固定为线上域名，避免本地联调时邮件指向 localhost；可用环境变量 PUBLIC_BASE_URL 覆盖 */
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || 'https://beisu-visitor.onrender.com').trim().replace(/\/+$/, '');

/* ---------------- 云存储（MongoDB Atlas 免费集群） ----------------
   配置 MONGODB_URI（环境变量或 secrets.json 的 mongo.uri）后，
   4 个数据集合（rules/chats/auth/users）持久化到云端，Render 重启不再丢数据；
   未配置时完全退回本地 JSON 文件模式，本地开发零影响。
   读取走内存缓存（同步），写入内存后防抖回写云端（replaceOne upsert）。 */
const CLOUD_DOCS = ['rules', 'chats', 'auth', 'users'];
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
  const file = { rules:DATA_FILE, chats:CHAT_FILE, auth:AUTH_FILE, users:USER_FILE }[name];
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
  cloud.col = client.db(process.env.MONGODB_DB || 'beisu').collection('singleton');
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
    /* 人工消息自动翻译总开关（缺省开启）+ 机器人总开关（缺省开启） */
    if (!d.agentChat || typeof d.agentChat !== 'object') d.agentChat = {};
    d.agentChat.translate = d.agentChat.translate !== false;
    d.agentChat.botEnabled = d.agentChat.botEnabled !== false;
    return d;
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

/* ---------------- 校验与归一化 ---------------- */
function normLabel(l){
  l = (l && typeof l === 'object') ? l : {};
  return { zh:String(l.zh||'').trim(), en:String(l.en||'').trim(), ru:String(l.ru||'').trim() };
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
function normalizeRule(r){
  const type = (r.type === 'fuzzy') ? 'fuzzy' : 'exact';
  const keywords = normKeywordMap(r.keywords);
  const reply = normLabel(r.reply);
  const quickButtons = normButtons(r.quickButtons, 4);
  const enabled = r.enabled === false ? false : true;
  const appendLink = r.appendLink === true;   // 是否附加底部链接，默认关闭
  return { id: r.id || crypto.randomUUID(), type, keywords, reply, quickButtons, enabled, appendLink };
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
  // 仅当该规则/兜底开启 appendLink 且链接模板已配置时，返回链接
  let link = null;
  if (hit.appendLink === true && data.link && data.link.url){
    link = { text: data.link.text, url: data.link.url };
  }
  return {
    reply: hit.reply || { zh:'', en:'', ru:'' },
    quickButtons: hit.quickButtons || [],
    matched: !hit.isFallback,
    link
  };
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
function readBody(req){
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); }
      catch { resolve({}); }
    });
  });
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
  if (urlPath === '/') urlPath = '/index.html';
  /* 安全：禁止通过静态资源访问 data 目录（users/auth/secrets 等敏感数据），杜绝密钥泄露 */
  if (/^\/data(\/|$)/i.test(urlPath)) return send(res, 404, 'Not Found');
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, 'Not Found');
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
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

/* ---------------- 人工客服账号与在线状态 ----------------
   在线判定：后台登录成功且持续上报心跳 → operatorOnline=true。
   页面关闭 / 心跳超时（10s）→ 自动销毁会话并置为离线，避免免登录重入后台。 */
const AUTH_FILE = path.join(ROOT, 'data', 'auth.json');
const PRESET_USER = 'operator';
const PRESET_PASS = 'Beisu2026';   // 初始预设密码，可在后台修改
const HEARTBEAT_TIMEOUT = 10 * 1000;   // 超过此时长未收到心跳 → 视为离线并销毁会话
const CLOSE_GRACE = 4 * 1000;          // 页面关闭宽限期：期内若重新上报心跳则判定为刷新而非关闭
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
/* 会话是否仍存活（有心跳且在超时窗口内） */
function sessionLive(s){ return !!s && !!s.lastSeen && (Date.now() - s.lastSeen) < HEARTBEAT_TIMEOUT; }
/* 人工在线：存在任一「存活且未被标记为已关闭」的会话 */
function operatorOnline(){ return loadAuth().sessions.some(s => sessionLive(s) && s.closing !== true); }
/* 校验 token；任何带 token 的真实请求都刷新心跳（内存更新，不落盘），并清除关闭标记 */
function sessionUser(token){
  if (!token) return null;
  const s = loadAuth().sessions.find(x => x.token === String(token));
  if (!sessionLive(s)) return null;
  s.lastSeen = Date.now();
  s.closing = false;
  return s.username;
}
/* 会话回收：心跳超时 或 关闭宽限期已过 → 销毁会话并广播离线 */
function sweepSessions(){
  const db = loadAuth();
  const now = Date.now();
  let changed = false;
  const keep = db.sessions.filter(s => {
    const expired = !s.lastSeen || (now - s.lastSeen) > HEARTBEAT_TIMEOUT;
    const closed = s.closing === true && (now - (s.closingAt || 0)) > CLOSE_GRACE;
    if (expired || closed) changed = true;
    return !(expired || closed);
  });
  if (changed){ db.sessions = keep; saveAuth(); broadcastState(true); }
}

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
  resend:    { apiKey: '', fromEmail: '', fromName: 'Beisu' },
  recaptcha: { version: 'v2', siteKey: '', secretKey: '' },
  telegram:  { botUsername: '', botToken: '' },   // Telegram 登录：botUsername 公开（前端控件用），botToken 仅后端校验用
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
    resend:    { apiKey: pick(str(s.resend, 'apiKey'), 'RESEND_API_KEY'), fromEmail: pick(str(s.resend, 'fromEmail'), 'RESEND_FROM_EMAIL'), fromName: pick(str(s.resend, 'fromName'), 'RESEND_FROM_NAME') || 'Beisu' },
    recaptcha: { version: (str(s.recaptcha, 'version') || str(env, 'RECAPTCHA_VERSION')) === 'v3' ? 'v3' : 'v2',
                 siteKey: pick(str(s.recaptcha, 'siteKey'), 'RECAPTCHA_SITE_KEY'), secretKey: pick(str(s.recaptcha, 'secretKey'), 'RECAPTCHA_SECRET_KEY') },
    telegram:  { botUsername: pick(str(s.telegram, 'botUsername'), 'TELEGRAM_BOT_USERNAME'), botToken: pick(str(s.telegram, 'botToken'), 'TELEGRAM_BOT_TOKEN') },
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
    const subject = purpose === 'reset' ? '【悖速】重置密码验证码' : '【悖速】注册验证码';
    const html = '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;color:#1c2330;line-height:1.7">'
      + '<p>您好，</p><p>您的验证码为：<b style="font-size:22px;letter-spacing:3px;color:#2f7cf6">' + code + '</b></p>'
      + '<p>验证码 10 分钟内有效，请勿向他人泄露。如非本人操作，请忽略本邮件。</p>'
      + '<p style="color:#8b94a0;font-size:12px">— 悖速团队</p></div>';
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
    const subject = '【悖速】邮箱激活';
    const html = '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;color:#1c2330;line-height:1.7">'
      + '<p>您好，</p><p>感谢注册悖速。请点击下方按钮完成邮箱激活：</p>'
      + '<p><a href="' + link + '" style="display:inline-block;padding:10px 22px;background:#2f7cf6;color:#ffffff;border-radius:8px;text-decoration:none">激活邮箱</a></p>'
      + '<p>该链接 24 小时内有效，且只能使用一次。若按钮无法点击，请复制以下地址到浏览器打开：</p>'
      + '<p style="color:#8b94a0;font-size:12px;word-break:break-all">' + link + '</p>'
      + '<p style="color:#8b94a0;font-size:12px">如非本人操作，请忽略本邮件。— 悖速团队</p></div>';
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
/* Telegram 昵称：优先「名 姓」，其次用户名，最后回退；与站内已用昵称冲突时自动加序号 */
function telegramNickname(v){
  const base = ([v.first, v.last].filter(Boolean).join(' ') || v.username || ('TG' + v.id)).slice(0, 20);
  let nick = base;
  for (let i = 2; nicknameTaken(nick) && i < 1000; i++) nick = base + ' ' + i;
  return nick.slice(0, 24);
}

/* ---------------- 路由 ---------------- */
const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, '');
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  /* ---- 后台管理接口鉴权 ----
     除白名单（游客前端 / 登录流程所需）外，所有 /api/* 必须携带有效登录 token，
     否则统一 401，防止绕过登录页直接调用后台接口。
     token 来源：请求头 X-Op-Token（后台页面自动附带）或 ?token= 查询参数 */
  if (p.startsWith('/api/')){
    const open =
      p === '/api/auth/status' || p === '/api/auth/login' || p === '/api/auth/logout' ||
      p === '/api/auth/heartbeat' || p === '/api/auth/close' ||
      p === '/api/config' || p === '/api/match' ||
      p === '/api/auth/check' || p === '/api/auth/send-code' ||
      p === '/api/auth/register' || p === '/api/auth/login-email' || p === '/api/auth/reset' ||
      p === '/api/auth/activate' || p === '/api/auth/telegram' ||
      (p === '/api/auth/config' && req.method === 'GET') ||
      (p === '/api/bot-switch' && req.method === 'GET') ||
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
  /* ---- 心跳上报：后台坐席页面每 3 秒调用，维持在线；超时未上报即自动离线 ---- */
  if (p === '/api/auth/heartbeat' && req.method === 'POST'){
    const body = await readBody(req);
    const token = body.token || req.headers['x-op-token'] || url.searchParams.get('token') || '';
    const username = sessionUser(token);
    if (!username) return send(res, 401, { ok:false, error:'登录态已失效，请重新登录' });
    broadcastState();   // 状态未变化时内部自动跳过广播
    return send(res, 200, { ok:true, operatorOnline: operatorOnline() });
  }
  /* ---- 页面关闭：标记会话待关闭并立即广播离线（宽限期内若重新心跳则视为刷新，不销毁） ---- */
  if (p === '/api/auth/close' && req.method === 'POST'){
    const body = await readBody(req);
    const db = loadAuth();
    const s = db.sessions.find(x => x.token === String(body.token || ''));
    if (s){ s.closing = true; s.closingAt = Date.now(); broadcastState(true); }
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
    const sid = u.sessionId || crypto.randomUUID();
    u.sessionId = sid; saveUsers();
    return send(res, 200, { ok:true, user: { id:u.id, email:u.email, nickname:u.nickname, sessionId:sid, createdAt:u.createdAt } });
  }
  /* ---- Telegram 快捷登录：校验控件回调签名 → 按 Telegram ID 建/取访客账号 → 返回会话 ----
     Telegram 不提供邮箱，故此类账号 email 为空、注册即激活（status=active），
     以 telegramId 唯一标识；重复登录复用同一账号与其历史会话。 */
  if (p === '/api/auth/telegram' && req.method === 'POST'){
    const body = await readBody(req);
    const v = verifyTelegramAuth(body.user);
    if (!v.ok) return send(res, 401, { ok:false, error: v.error || 'Telegram 登录失败' });
    const users = loadUsers().users;
    let u = users.find(x => String(x.telegramId || '') === v.id);
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
      .map(u => ({ id:u.id, email:u.email, nickname:u.nickname, createdAt:u.createdAt, provider: u.provider || 'email' }));
    return send(res, 200, list);
  }

  /* ---- 全量配置（前端启动拉取） ---- */
  if (p === '/api/config' && req.method === 'GET'){
    const d = loadData();
    return send(res, 200, { quickButtons: d.quickButtons, composerButtons: d.composerButtons || [], fallback: d.fallback, guide: d.guide, placeholder: d.placeholder });
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
    if (activeSid) addMsg(activeSid, { role:'visitor', text:String(body.text || '').slice(0, 2000) });
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
    const _reply = payload.reply || {};
    if (activeSid && (_reply.zh || _reply.en || _reply.ru)){
      addMsg(activeSid, { role:'bot', reply:payload.reply, quickButtons:payload.quickButtons, link:payload.link });
    }
    payload.sid = activeSid || undefined;
    payload.reset = reset;
    return send(res, 200, payload);
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
          last: { role: last.role, text: last.text || (last.reply && last.reply.zh) || '', ts: last.ts }
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
    // 人工消息自动翻译开启时，为访客消息后台补齐中文译文（不阻塞本次响应，完成后的下次轮询可见）
    const TR_INFLIGHT = (global.__trInflight = global.__trInflight || new Set());
    if (s && !s.ended && loadData().agentChat.translate){
      const need = msgs.filter(m => m.role === 'visitor' && m.text && !m.transZh);
      if (need.length && !TR_INFLIGHT.has(s.id)){
        TR_INFLIGHT.add(s.id);
        Promise.all(need.map(async m => {
          const t = await translateText(m.text, 'zh-CN');
          if (t && t !== m.text) m.transZh = t;
        })).then(() => saveChats()).catch(() => {}).finally(() => TR_INFLIGHT.delete(s.id));
      }
    }
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
    if (origText) msg.origText = origText;   // 人工输入的原文（后台展示用，客户不可见）
    const m = addMsg(sid, msg);
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
    return send(res, 200, { id:s.id, mode:s.mode, messages:s.messages });
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
  let m;
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

  /* ---- 底部链接模板 ---- */
  if (p === '/api/link' && req.method === 'GET'){
    return send(res, 200, loadData().link);
  }
  if (p === '/api/link' && req.method === 'PUT'){
    const body = await readBody(req);
    const d = loadData();
    d.link = normalizeLinkTemplate(body);
    saveData(d);
    return send(res, 200, d.link);
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
/* 会话回收定时器：心跳超时与页面关闭宽限的兜底销毁 */
setInterval(sweepSessions, 2000);

/* 启动引导：先接入云库（如已配置），再监听端口；云库不可用则自动回退本地文件存储 */
(async () => {
  try { await initCloud(loadSecrets().mongo.uri); }
  catch(e){ console.error('[cloud] 初始化失败，回退本地 JSON 文件存储:', e.message); }
  ensureDataFile();
  server.listen(PORT, () => {
    console.log(`[beisu-visitor] server running at http://localhost:${PORT}`);
    console.log(`  游客前端: http://localhost:${PORT}/`);
    console.log(`  后台管理: http://localhost:${PORT}/admin.html`);
  });
})();
