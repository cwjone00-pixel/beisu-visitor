/* Telegram 登录鉴权链路自测（零依赖）
   覆盖：回跳参数解析 + 编码处理（base64url / 标准 base64 / padding / 空白 / 明文 / 平铺）+
         后端签名校验（正/负向）+ 解析→验签 的端到端串联。
   关键点：本脚本不复制实现，而是直接从 index.html / server.js 的标记区间**提取真实源码**执行，
          一旦实现被改动或标记丢失，测试会立刻失败 —— 避免「测试与实现漂移」。
   运行：node test-tg-auth.js   （或 npm test） */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = __dirname;
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra){
  if (cond) { pass++; console.log('  \u2705 ' + name); }
  else { fail++; failures.push(name + (extra ? '  → ' + extra : '')); console.log('  \u274c ' + name + (extra ? '  → ' + extra : '')); }
}
function eq(name, actual, expected){
  ok(name, actual === expected, 'got=' + JSON.stringify(actual) + ' want=' + JSON.stringify(expected));
}

/* ---------- 从真实源码提取待测函数 ---------- */
function sliceBetween(file, begin, end){
  const src = fs.readFileSync(path.join(DIR, file), 'utf8');
  const i = src.indexOf(begin), j = src.indexOf(end);
  if (i < 0 || j < 0 || j <= i) throw new Error('无法从 ' + file + ' 提取标记 ' + begin + '（标记被删/改名？）');
  return src.slice(i + begin.length, j);
}
const PARSE_SRC = sliceBetween('index.html', '/*==TG_PARSE_BEGIN==*/', '/*==TG_PARSE_END==*/');
const VERIFY_SRC = sliceBetween('server.js', '/*==TG_VERIFY_BEGIN==*/', '/*==TG_VERIFY_END==*/');

const FRONT = new Function(PARSE_SRC + '\nreturn { tgDecodeAuthResult, tgParseCallback };')();
const TEST_TOKEN = '123456:TEST_bot_token_for_self_test';
const loadSecretsStub = () => ({ telegram: { botToken: TEST_TOKEN } });
const BACK = new Function('loadSecrets', 'crypto', VERIFY_SRC + '\nreturn { verifyTelegramAuth, TG_AUTH_TTL };')(loadSecretsStub, crypto);

const { tgDecodeAuthResult, tgParseCallback } = FRONT;
const { verifyTelegramAuth } = BACK;

/* ---------- 用与 Telegram 相同算法自签测试数据 ---------- */
const testSecret = crypto.createHash('sha256').update(TEST_TOKEN).digest();
function sign(fields){
  const dcs = Object.keys(fields).sort().map(k => k + '=' + fields[k]).join('\n');
  const hash = crypto.createHmac('sha256', testSecret).update(dcs).digest('hex');
  return Object.assign({}, fields, { hash: hash });
}
function b64url(obj){
  return Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8')
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64std(obj){ return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64'); }
const HEX = 'f350038739a24049b32c24e093b01272';   // 32 位 state 形态
const NOW = Math.floor(Date.now() / 1000);
const FIELDS = sign({ id: '8866500867', first_name: 'chen', last_name: 'weijie',
  photo_url: 'https://t.me/i/userpic/320/x.jpg', auth_date: String(NOW) });

console.log('\n[1] 回跳参数解析 + 编码处理（前端）');

/* 1. 实测的 Telegram 真实格式：#tgAuthResult = base64url(JSON) */
let p = tgParseCallback({ pathname: '/tg/' + HEX, search: '', hash: '#tgAuthResult=' + b64url(FIELDS) });
eq('tgAuthResult(base64url) → state 正确', p && p.state, HEX);
eq('tgAuthResult(base64url) → id 正确', p && p.user.id, '8866500867');
eq('tgAuthResult(base64url) → 全部签名字段不丢', p && p.user.hash, FIELDS.hash);
ok('tgAuthResult(base64url) → first/last/photo 齐全',
  p && p.user.first_name === 'chen' && p.user.last_name === 'weijie' && !!p.user.photo_url);

/* 2. padding 的 = 不能被 `&`/`=` 解析截断（关键回归点） */
p = tgParseCallback({ pathname: '/tg/' + HEX, search: '', hash: '#tgAuthResult=' + b64std(FIELDS) });
eq('tgAuthResult(标准 base64 + padding) → id 正确', p && p.user.id, '8866500867');
eq('  同一 payload 的 hash 与 base64url 版一致', p && p.user.hash, FIELDS.hash);

/* 3. base64 中的空白字符应被容忍 */
p = tgParseCallback({ pathname: '/tg/' + HEX, search: '', hash: '#tgAuthResult=' + b64url(FIELDS).slice(0, 8) + '\n ' + b64url(FIELDS).slice(8) });
eq('tgAuthResult(含换行/空白的 base64) → id 正确', p && p.user.id, '8866500867');

/* 4. 直接给明文 JSON 也要能解 */
p = tgParseCallback({ pathname: '/tg/' + HEX, search: '', hash: '#tgAuthResult=' + encodeURIComponent(JSON.stringify(FIELDS)) });
eq('tgAuthResult(明文 JSON) → id 正确', p && p.user.id, '8866500867');

/* 5. 参数平铺在 search（旧式 ?tg=1&s=<state>&id=..&hash=..） */
p = tgParseCallback({ pathname: '/', search: '?tg=1&s=' + HEX + '&id=1&hash=abc', hash: '' });
eq('平铺( search ) → state 正确', p && p.state, HEX);
eq('平铺( search ) → id 正确', p && p.user.id, '1');
eq('平铺( search ) → hash 正确', p && p.user.hash, 'abc');
ok('平铺( search ) → 我们注入的 tg/s 不混入签名字段',
  p && p.user.tg === undefined && p.user.s === undefined && p.user.state === undefined);

/* 6. 参数平铺在片段（无问号：/tg/<state>#id=..&hash=..） */
p = tgParseCallback({ pathname: '/tg/' + HEX, search: '', hash: '#id=2&hash=def' });
eq('平铺( # 片段 ) → id 正确', p && p.user.id, '2');

/* 7. 直接追加在路径尾巴后（/tg/<state>&id=..&hash=..，无 ? 无 #） */
p = tgParseCallback({ pathname: '/tg/' + HEX + '&id=3&hash=ghi', search: '', hash: '' });
eq('平铺( 路径尾巴追加 ) → id 正确', p && p.user.id, '3');
eq('平铺( 路径尾巴追加 ) → state 仍取到', p && p.state, HEX);

/* 8. 带问号追加在路径后（/tg/<state>?id=..&hash=..） */
p = tgParseCallback({ pathname: '/tg/' + HEX, search: '?id=4&hash=jkl', hash: '' });
eq('平铺( ? 追加 ) → id 正确', p && p.user.id, '4');

/* 9. 非 TG 回跳必须返回 null（避免误吞普通访问） */
ok('非 TG 地址( / ) → null', tgParseCallback({ pathname: '/', search: '', hash: '' }) === null);
ok('非 TG 地址( /admin.html ) → null', tgParseCallback({ pathname: '/admin.html', search: '?a=1', hash: '' }) === null);

/* 10. 垃圾输入不抛异常、不误判 */
ok('损坏 base64 → 不抛异常', (() => { try { tgDecodeAuthResult('!!!not-base64!!!'); return true; } catch(e){ return false; } })());
eq('损坏 base64 → 返回空对象', Object.keys(tgDecodeAuthResult('!!!not-base64!!!')).length, 0);
eq('空 tgAuthResult → 返回空对象', Object.keys(tgDecodeAuthResult('')).length, 0);
eq('base64 解出的非对象(数组) → 返回空对象', Object.keys(tgDecodeAuthResult(b64url('[1,2,3]'))).length, 0);
eq('base64 解出的非 JSON → 返回空对象', Object.keys(tgDecodeAuthResult(b64url('hello'))).length, 0);
p = tgParseCallback({ pathname: '/tg/' + HEX, search: '', hash: '#tgAuthResult=@@@' });
ok('解析失败时 user 无 id（前端据此弹兜底提示，不误登录）', p && !p.user.id);

/* 11. UTF-8 编码：俄文/中文昵称必须原样还原 */
const ru = sign({ id: '555', first_name: 'Иван', last_name: 'Петров\u{1F600}', auth_date: String(NOW) });
p = tgParseCallback({ pathname: '/tg/' + HEX, search: '', hash: '#tgAuthResult=' + b64url(ru) });
eq('base64 中的俄文名字 → 正确还原', p && p.user.first_name, 'Иван');
eq('base64 中的 emoji 名字 → 正确还原', p && p.user.last_name, 'Петров\u{1F600}');

/* 12. state 缺失/不匹配不影响解析出签名字段（state 仅用于绑定意图） */
p = tgParseCallback({ pathname: '/', search: '?tg=1&id=9&hash=zzz', hash: '' });
eq('state 缺失 → 仍能解析出 id', p && p.user.id, '9');

console.log('\n[2] 签名校验（后端）');

let v = verifyTelegramAuth(FIELDS);
ok('自签 payload → 校验通过', v.ok, v.error);
eq('校验通过 → 返回 id', v.ok && v.id, '8866500867');
eq('校验通过 → 返回 first', v.ok && v.first, 'chen');
eq('校验通过 → 返回 photo', v.ok && v.photo, 'https://t.me/i/userpic/320/x.jpg');

const tampered = Object.assign({}, FIELDS, { first_name: 'hacker' });
ok('篡改 first_name → 校验失败', !verifyTelegramAuth(tampered).ok);
ok('篡改 id（hash 不变）→ 校验失败', !verifyTelegramAuth(Object.assign({}, FIELDS, { id: '1' })).ok);
ok('缺 hash → 登录数据不完整', !verifyTelegramAuth({ id: '8866500867' }).ok);
ok('缺 id → 登录数据不完整', !verifyTelegramAuth({ hash: FIELDS.hash }).ok);
ok('非对象入参 → 校验失败', !verifyTelegramAuth(null).ok && !verifyTelegramAuth('x').ok);

/* auth_date 过期（>24h）必须拒绝，防止重放 */
const old = sign({ id: '7', first_name: 'old', auth_date: String(NOW - 25 * 60 * 60) });
const oldV = verifyTelegramAuth(old);
ok('auth_date 超 24h → 过期拒绝', !oldV.ok && /过期/.test(oldV.error || ''), oldV.error);
const fresh = sign({ id: '7', first_name: 'fresh', auth_date: String(NOW - 60) });
ok('auth_date 在 24h 内 → 通过', verifyTelegramAuth(fresh).ok);

/* 字段集差异（Telegram 有时不给 username/photo_url）：按实收字段计算，必须都能过 */
ok('字段少(仅 id+auth_date) → 通过', verifyTelegramAuth(sign({ id: '9', auth_date: String(NOW) })).ok);
ok('字段多(含 username) → 通过', verifyTelegramAuth(sign({ id: '9', auth_date: String(NOW), username: 'alice' })).ok);

/* 用错误 token 验签 → 必须失败 */
const otherSecret = crypto.createHash('sha256').update('wrong:token').digest();
const dcs = Object.keys({ id: '5', auth_date: String(NOW) }).sort().map(k => k + '=' + ({ id: '5', auth_date: String(NOW) })[k]).join('\n');
const wrongSigned = { id: '5', auth_date: String(NOW), hash: crypto.createHmac('sha256', otherSecret).update(dcs).digest('hex') };
ok('别的 bot token 签的 payload → 校验失败', !verifyTelegramAuth(wrongSigned).ok);

console.log('\n[3] 端到端串联：解析 → 验签（真实链路）');

/* 模拟 Telegram 真实回跳：/tg/<state>#tgAuthResult=<base64url(签名JSON)> → 解析 → 后端验签 */
const url = { pathname: '/tg/' + HEX, search: '', hash: '#tgAuthResult=' + b64url(FIELDS) };
const parsed = tgParseCallback(url);
const verified = parsed && verifyTelegramAuth(parsed.user);
ok('真实格式回跳：解析到的字段能通过后端验签', !!(verified && verified.ok), verified && verified.error);
eq('端到端 → 落到正确账号', verified && verified.id, '8866500867');
ok('端到端 → state 一并带回（供绑定意图）', parsed && parsed.state === HEX);

/* 回归：线上真实抓到的那条 Telegram 回跳原文（2026-10-14 从线上日志采集，
   即用户成功登录时 Telegram 实际回传的 #tgAuthResult 原文）。
   直接存 base64 原文、交给被测代码自己解码，避免任何人工转录误差。
   本地有真 token 时验签必须通过；无 data/secrets.json（如 CI）则跳过该项。 */
const REAL_B64 = 'eyJpZCI6ODg2NjUwMDg2NywiZmlyc3RfbmFtZSI6ImNoZW4iLCJsYXN0X25hbWUiOiJ3ZWlqaWUiLCJwaG90b191cmwiOiJodHRwczpcL1wvdC5tZVwvaVwvdXNlcnBpY1wvMzIwXC80SUFwbVR0VzJ5dlA2QWwxTmdDeTIwTEVFY3BBSFRsZXFBV3J2RjJtWm5Nd01ITVY3cEptTHI2dDFJVHpXWW1ILmpwZyIsImF1dGhfZGF0ZSI6MTc5MTk4NzEwOSwiaGFzaCI6ImZlYjFkYjlmODM0NTIzOWM1YmUwNjI1ZjVmZDFmMzJhYTQ4NjNhODg4YjU0MDk5MzM0MTViZTRkY2YxYzQ5NDgifQ';
let realToken = '';
try {
  const s = JSON.parse(fs.readFileSync(path.join(DIR, 'data', 'secrets.json'), 'utf8'));
  realToken = (s.telegram && s.telegram.botToken) || '';
} catch(e){}
const realParsed = tgParseCallback({ pathname: '/tg/' + HEX, search: '', hash: '#tgAuthResult=' + REAL_B64 });
ok('回归：真实回跳原文经前端解析出 id', realParsed && String(realParsed.user.id) === '8866500867',
  JSON.stringify(realParsed && realParsed.user));
ok('回归：真实回跳原文解析出昵称/照片字段',
  realParsed && realParsed.user.last_name === 'weijie' && /t\.me\/i\/userpic/.test(realParsed.user.photo_url || ''));
if (realToken){
  const realBack = new Function('loadSecrets', 'crypto', VERIFY_SRC + '\nreturn { verifyTelegramAuth };')(
    () => ({ telegram: { botToken: realToken } }), crypto);
  const rv = realBack.verifyTelegramAuth(realParsed.user);
  ok('回归：真实回跳原文用真 token 验签通过', rv.ok, rv.error);
} else {
  console.log('  \u26a0\ufe0f 跳过真 token 验签回归（本地无 data/secrets.json，属预期）');
}

console.log('\n' + '='.repeat(52));
console.log('TG 鉴权链路自测：' + pass + ' 通过 / ' + fail + ' 失败（共 ' + (pass + fail) + ' 项）');
if (fail){ console.log('失败项：\n  - ' + failures.join('\n  - ')); process.exit(1); }
console.log('全部通过 ✅');
