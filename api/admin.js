/* =====================================================================
   /api/admin — 웹에서 첫 화면 숫자·조문 요약을 고치는 관리자 기능 (Vercel 서버리스)

   필요한 설정 (Vercel → Settings → Environment Variables)
   - EDITORS : 수정할 수 있는 사람과 암호.  예)  이재선:암호1, 김철수:암호2
               (쉼표 또는 줄바꿈으로 구분, 암호에는 쉼표를 쓰지 마세요)
   - 저장소  : Vercel Storage 탭에서 Upstash Redis를 연결하면 아래 값이 자동으로 생겨요.
               KV_REST_API_URL / KV_REST_API_TOKEN  (또는 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)
   - ADMIN_SECRET (선택) : 로그인 표 서명용 비밀값. 없으면 EDITORS 등에서 자동으로 만들어요.

   GET  /api/admin?health=1     → 저장소·관리자 설정 여부
   GET  /api/admin?overrides=1  → 웹에서 고친 내용 (누구나 읽기 가능, 화면에 반영용, 1분 단위로 새로 읽음)
   POST /api/admin  { action: 'login',  password }
                    { action: 'save',   token, target: 'cell'|'article', id, data, memo }
                    { action: 'log',    token }
                    { action: 'revert', token, at }
   ===================================================================== */
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

const KEY_OV = 'nomu:overrides';
const KEY_LOG = 'nomu:log';
const TOKEN_HOURS = 8;
const MAX_FAILS = 10;
const LOCK_SEC = 900;

const rUrl = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const rTok = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const hasStorage = () => !!(rUrl() && rTok());

export function parseEditors(raw) {
  return String(raw || '').split(/[\n,]/).map(x => x.trim()).filter(Boolean).map(x => {
    const i = x.indexOf(':');
    if (i < 1) return null;
    return { name: x.slice(0, i).trim(), pw: x.slice(i + 1).trim() };
  }).filter(e => e && e.name && e.pw);
}
const sha = s => createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => timingSafeEqual(sha(a), sha(b));
const secret = () => process.env.ADMIN_SECRET || createHash('sha256').update('nomu|' + (process.env.EDITORS || '') + '|' + rTok()).digest('hex');

export function signToken(name, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ n: name, e: now + TOKEN_HOURS * 3600 * 1000 })).toString('base64url');
  return payload + '.' + createHmac('sha256', secret()).update(payload).digest('base64url');
}
export function verifyToken(tok, now = Date.now()) {
  const [payload, sig] = String(tok || '').split('.');
  if (!payload || !sig) return null;
  if (!safeEq(sig, createHmac('sha256', secret()).update(payload).digest('base64url'))) return null;
  let d;
  try { d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!d || typeof d.e !== 'number' || d.e < now) return null;
  if (!parseEditors(process.env.EDITORS).some(e => e.name === d.n)) return null;   // 명단에서 빠지면 바로 무효
  return { name: d.n, exp: d.e };
}

async function redis(cmd) {
  const r = await fetch(rUrl(), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + rTok(), 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  if (!r.ok || !j || j.error) {
    const e = new Error('저장소 오류' + (j && j.error ? ': ' + j.error : ' (' + r.status + ')'));
    e.status = 502; throw e;
  }
  return j.result;
}
async function getOverrides() {
  const v = await redis(['GET', KEY_OV]);
  if (!v) return { cells: {}, articles: {} };
  try {
    const o = JSON.parse(v);
    return { cells: o.cells || {}, articles: o.articles || {}, updatedAt: o.updatedAt || '', updatedBy: o.updatedBy || '' };
  } catch (e) { return { cells: {}, articles: {} }; }
}

/* 입력값 정리: 제어문자 제거, 길이 제한, 날짜 형식 확인 */
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
export function sanitizeCell(o) {
  if (!o || typeof o !== 'object') return null;
  const out = {};
  [['val', 20], ['brief', 60], ['sub', 500], ['note', 500]].forEach(([k, max]) => { if (o[k] != null && o[k] !== '') out[k] = clean(o[k], max); });
  if (Array.isArray(o.steps)) {
    out.steps = o.steps.slice(0, 30).filter(s => s && isDate(s.from)).map(s => {
      const x = { from: s.from, val: clean(s.val, 20), sub: clean(s.sub, 300) };
      if (s.brief) x.brief = clean(s.brief, 60);
      return x;
    }).filter(s => s.val).sort((a, b) => a.from.localeCompare(b.from));
    if (!out.steps.length) delete out.steps;
  }
  if (o.checked && typeof o.checked === 'object') {
    const c = {};
    Object.entries(o.checked).slice(0, 10).forEach(([k, v]) => { if (isDate(v)) c[clean(k, 200)] = v; });
    if (Object.keys(c).length) out.checked = c;
  }
  return Object.keys(out).length ? out : null;
}
export function sanitizeArticle(o) {
  if (!o || typeof o !== 'object') return null;
  const out = {};
  if (o.sum) out.sum = clean(o.sum, 1000);
  if (Array.isArray(o.pts)) {
    const pts = o.pts.map(p => clean(p, 500)).filter(Boolean).slice(0, 10);
    if (pts.length) out.pts = pts;
  }
  return Object.keys(out).length ? out : null;
}

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(body);
}
function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch (e) { return {}; }
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const q = req.query || {};
  const url = String(req.url || '');
  const editors = parseEditors(process.env.EDITORS);

  try {
    if (req.method === 'GET') {
      if (q.health !== undefined || /[?&]health(?:[=&]|$)/.test(url)) {
        return send(res, 200, { ok: true, storage: hasStorage(), editors: editors.length > 0 });
      }
      if (!hasStorage()) return send(res, 200, { cells: {}, articles: {}, storage: false, editors: editors.length > 0 });
      const ov = await getOverrides();
      // 복사본을 1분 동안 재사용 → 저장소 읽기 횟수 절약 (다른 사람 화면 반영은 최대 1분 정도 늦어짐)
      res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=60');
      return res.status(200).json(Object.assign(ov, { storage: true, editors: editors.length > 0 }));
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'GET 또는 POST만 지원해요.' });

    const b = readBody(req);
    if (!editors.length) return send(res, 503, { error: '관리자(EDITORS)가 아직 설정되지 않았어요. 배포 가이드 6장(웹 수정 기능 켜기)을 확인하세요.' });
    if (!hasStorage()) return send(res, 503, { error: '저장소가 아직 연결되지 않았어요. 배포 가이드 6장(웹 수정 기능 켜기)을 확인하세요.' });

    if (b.action === 'login') {
      const ip = String(req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip']) || 'unknown').split(',')[0].trim();
      const failKey = 'nomu:fail:' + ip;
      const fails = Number(await redis(['GET', failKey]) || 0);
      if (fails >= MAX_FAILS) return send(res, 429, { error: '암호를 여러 번 틀려서 잠겼어요. 15분 뒤 다시 시도하세요.' });
      const pw = String(b.password || '');
      const hit = pw && editors.find(e => safeEq(e.pw, pw));
      if (!hit) {
        const n = await redis(['INCR', failKey]);
        if (Number(n) === 1) await redis(['EXPIRE', failKey, LOCK_SEC]);
        return send(res, 401, { error: '암호가 맞지 않아요.' + (Number(n) >= MAX_FAILS - 3 ? ' (남은 시도 ' + Math.max(0, MAX_FAILS - Number(n)) + '번)' : '') });
      }
      await redis(['DEL', failKey]);
      const token = signToken(hit.name);
      return send(res, 200, { ok: true, token, name: hit.name, exp: verifyToken(token).exp });
    }

    const who = verifyToken(b.token);
    if (!who) return send(res, 401, { error: '로그인이 만료됐어요. 다시 로그인하세요.' });

    if (b.action === 'log') {
      const rows = await redis(['LRANGE', KEY_LOG, 0, 49]) || [];
      return send(res, 200, { ok: true, log: rows.map(r => { try { return JSON.parse(r); } catch (e) { return null; } }).filter(Boolean) });
    }

    if (b.action === 'save' || b.action === 'revert') {
      let target = b.target, id = String(b.id || ''), after, memo = clean(b.memo, 200);
      if (b.action === 'revert') {
        const rows = (await redis(['LRANGE', KEY_LOG, 0, 199]) || []).map(r => { try { return JSON.parse(r); } catch (e) { return null; } }).filter(Boolean);
        const entry = rows.find(r => r.at === b.at);
        if (!entry) return send(res, 404, { error: '되돌릴 기록을 찾지 못했어요.' });
        target = entry.target; id = entry.id; after = entry.before || null;
        memo = '되돌리기: ' + (entry.memo || entry.at);
      } else {
        if (target !== 'cell' && target !== 'article') return send(res, 400, { error: '수정 대상이 올바르지 않아요.' });
        after = target === 'cell' ? sanitizeCell(b.data) : sanitizeArticle(b.data);
      }
      if (!/^[a-z0-9-]{1,30}$/.test(id)) return send(res, 400, { error: '항목 이름이 올바르지 않아요.' });
      const now = new Date().toISOString();
      const ov = await getOverrides();
      const bucket = target === 'cell' ? ov.cells : ov.articles;
      const before = bucket[id] || null;
      if (after) bucket[id] = Object.assign({}, after, { by: who.name, at: now });
      else delete bucket[id];
      ov.updatedAt = now; ov.updatedBy = who.name;
      await redis(['SET', KEY_OV, JSON.stringify(ov)]);
      const strip = o => { if (!o) return null; const c = Object.assign({}, o); delete c.by; delete c.at; return c; };
      await redis(['LPUSH', KEY_LOG, JSON.stringify({ at: now, by: who.name, action: b.action, target, id, before: strip(before), after: strip(bucket[id] || null), memo })]);
      await redis(['LTRIM', KEY_LOG, 0, 199]);
      return send(res, 200, { ok: true, overrides: ov });
    }
    return send(res, 400, { error: '알 수 없는 요청이에요.' });
  } catch (e) {
    return send(res, e.status || 500, { error: e.message || '알 수 없는 오류가 났어요.' });
  }
}
