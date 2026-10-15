/* =====================================================================
   /api/law — 법제처 국가법령정보 Open API 중계 함수 (Vercel 서버리스)

   왜 필요한가요?
   - 법제처 인증값(OC)을 화면 코드에 넣으면 누구나 볼 수 있어요. 이 함수가 서버에서 대신 호출해요.
   - 브라우저에서 법제처를 직접 부르면 보안 정책(CORS)으로 막혀요.

   Vercel 환경변수 (Settings → Environment Variables)
   - LAW_OC          (필수) open.law.go.kr에 신청한 OC 값 (보통 가입 이메일의 @ 앞부분)
   - LAW_REFERER     (선택) 법제처가 "사용자 정보 검증 실패"를 낼 때, 신청 시 등록한 도메인 주소로 지정
   - LAW_USER_AGENT  (선택) 기본값은 일반 브라우저 형식

   사용 예: /api/law?law=근로기준법&jo=제60조   /api/law?law=근로기준법&jo=제76조의2
            /api/law?law=근로기준법&full=1 → 법령 전체 조문 목록 (장·절 제목 포함, '법령 전문 보기' 화면용)
            /api/law?admrul=최저임금   → 고시·훈령 등 행정규칙 최신 발령 목록 (첫 화면 변경 확인용)
            /api/law?health=1 → 환경변수 설정 여부만 확인
   ===================================================================== */

const BASE = 'https://www.law.go.kr/DRF';
const UA_DEFAULT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const TIMEOUT_MS = 8000;
const lawIdCache = new Map(); // 함수가 살아 있는 동안 법령명 → 법령ID 기억

/* '제60조' → '006000', '제76조의2' → '007602' (법제처 JO 형식: 조번호 4자리 + 가지번호 2자리) */
export function joCode(no) {
  const m = /^제(\d{1,4})조(?:의(\d{1,2}))?$/.exec(String(no || '').trim());
  if (!m) return null;
  return m[1].padStart(4, '0') + String(m[2] || '0').padStart(2, '0');
}

const normName = s => String(s || '').replace(/\s+/g, '').replace(/[·ㆍ・‧]/g, 'ㆍ');
const asArray = v => (v == null ? [] : Array.isArray(v) ? v : [v]);

function upstreamError(message, raw) {
  const e = new Error(message);
  e.status = 502;
  if (raw) {
    let hint = String(raw).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (process.env.LAW_OC) hint = hint.split(process.env.LAW_OC).join('***');
    e.hint = hint;
  }
  return e;
}

async function callLaw(endpoint, params) {
  const qs = new URLSearchParams({ OC: process.env.LAW_OC, type: 'JSON', ...params });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${BASE}/${endpoint}?${qs.toString()}`, {
      signal: ctrl.signal,
      headers: {
        // 법제처는 Node 기본 User-Agent나 Referer가 없는 요청을 "사용자 정보 검증 실패"로 거부하는 경우가 있어요.
        'User-Agent': process.env.LAW_USER_AGENT || UA_DEFAULT,
        'Referer': process.env.LAW_REFERER || 'https://www.law.go.kr/',
        'Accept': 'application/json, text/plain, */*'
      }
    });
    const body = await r.text();
    if (!r.ok) throw upstreamError(`법제처 응답 오류(${r.status})예요.`, body);
    const t = body.trim();
    if (!t) throw upstreamError('법제처가 빈 응답을 보냈어요. 잠시 뒤 다시 시도하세요.');
    if (t[0] !== '{' && t[0] !== '[') {
      if (/검증|IP|도메인|미신청|권한/.test(t)) {
        throw upstreamError('법제처 사용자 인증에 실패했어요. LAW_OC 값, 신청한 서비스(법령 본문·목록), 등록 도메인을 확인하세요.', t);
      }
      throw upstreamError('법제처가 JSON이 아닌 응답을 보냈어요. 점검 중일 수 있어요.', t);
    }
    try { return JSON.parse(t); } catch (e) { throw upstreamError('법제처 응답을 읽지 못했어요.', t); }
  } catch (e) {
    if (e.name === 'AbortError') throw upstreamError('법제처 응답 시간이 초과됐어요.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* 법령명으로 법령ID 찾기 (검색 결과 중 이름이 정확히 같은 현행 법령) */
async function resolveLaw(name) {
  const key = normName(name);
  if (lawIdCache.has(key)) return lawIdCache.get(key);
  const json = await callLaw('lawSearch.do', { target: 'law', query: name, display: '50' });
  const items = [];
  (function walk(o) {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    if (o['법령ID'] && o['법령명한글']) items.push(o);
    Object.values(o).forEach(walk);
  })(json);
  const same = items.filter(i => normName(i['법령명한글']) === key);
  const hit = same.find(i => !i['현행연혁코드'] || i['현행연혁코드'] === '현행') || same[0];
  if (!hit) { const e = new Error(`'${name}' 법령을 찾지 못했어요. 법령명이 바뀌었는지 확인하세요.`); e.status = 404; throw e; }
  const info = { id: String(hit['법령ID']), name: String(hit['법령명한글']) };
  lawIdCache.set(key, info);
  return info;
}

/* 조문 단위에서 본문 글자만 모으기 (조문내용 → 항 → 호 → 목) */
function collectText(unit) {
  const lines = [];
  const push = v => {
    if (typeof v === 'string') { if (v.trim()) lines.push(v.trim()); }
    else if (Array.isArray(v)) v.forEach(push);
  };
  push(unit['조문내용']);
  asArray(unit['항']).forEach(h => {
    if (!h || typeof h !== 'object') return;
    push(h['항내용']);
    asArray(h['호']).forEach(ho => {
      if (!ho || typeof ho !== 'object') return;
      push(ho['호내용']);
      asArray(ho['목']).forEach(mok => { if (mok && typeof mok === 'object') push(mok['목내용']); });
    });
  });
  return lines.join('\n');
}

/* 조문 원문 속 <개정 2012.2.1, 2026.2.19>, 삭제 <2017.11.28>, [본조신설 2019.1.15] 표시 중 가장 늦은 날짜
   → '이 조문'이 마지막으로 개정된 날 (법제처의 조문시행일자 항목은 법령 전체 시행일과 같아서 조문별 판단에 못 씀) */
export function latestAmendDate(text) {
  let max = '';
  const blocks = String(text || '').match(/[<\[][^<>\[\]]*\d{4}\.\s*\d{1,2}\.\s*\d{1,2}[^<>\[\]]*[>\]]/g) || [];
  blocks.forEach(b => {
    const re = /(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})/g;
    let m;
    while ((m = re.exec(b))) {
      const d = m[1] + m[2].padStart(2, '0') + m[3].padStart(2, '0');
      if (d > max) max = d;
    }
  });
  return max;
}

function pickUnits(raw, jo) {
  const list = asArray(raw).filter(u => u && typeof u === 'object' && (u['조문여부'] === undefined || u['조문여부'] === '조문'));
  if (!jo) return list;
  const num = String(parseInt(jo.slice(0, 4), 10));
  const sub = parseInt(jo.slice(4), 10);
  const hit = list.filter(u => String(u['조문번호']).replace(/^0+/, '') === num && (parseInt(u['조문가지번호'] || '0', 10) || 0) === sub);
  if (hit.length) return hit;
  return list.length === 1 ? list : [];
}

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(body);
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const q = req.query || {};

  if (q.health !== undefined || /[?&]health(?:[=&]|$)/.test(String(req.url || ''))) return send(res, 200, { ok: true, configured: !!process.env.LAW_OC });
  if (req.method !== 'GET') return send(res, 405, { error: 'GET 요청만 지원해요.' });
  if (!process.env.LAW_OC) return send(res, 500, { error: '서버에 LAW_OC 환경변수가 설정되지 않았어요. Vercel 설정에서 추가한 뒤 다시 배포하세요.' });

  if (q.admrul !== undefined) {
    const kw = String(q.admrul || '').trim();
    if (!/^[가-힣0-9\s]{2,40}$/.test(kw)) return send(res, 400, { error: '고시 검색어가 올바르지 않아요.' });
    try {
      const json = await callLaw('lawSearch.do', { target: 'admrul', query: kw, display: '50' });
      const items = [];
      (function walk(o) {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) { o.forEach(walk); return; }
        if (o['행정규칙명']) items.push({
          name: String(o['행정규칙명']),
          issued: String(o['발령일자'] || '').replace(/\D/g, ''),
          effective: String(o['시행일자'] || '').replace(/\D/g, ''),
          kind: String(o['행정규칙종류'] || ''),
          org: String(o['소관부처명'] || '')
        });
        Object.values(o).forEach(walk);
      })(json);
      items.sort((x, y) => (y.issued || y.effective).localeCompare(x.issued || x.effective));
      res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
      return res.status(200).json({ query: kw, items: items.slice(0, 20), source: '법제처 국가법령정보 Open API' });
    } catch (e) {
      return send(res, e.status || 500, { error: e.message || '알 수 없는 오류가 났어요.', hint: e.hint });
    }
  }

  const law = String(q.law || '').trim();
  const no = String(q.jo || '').trim();
  if (!/^[가-힣ㆍ·\s]{2,60}$/.test(law)) return send(res, 400, { error: '법령명이 올바르지 않아요.' });
  const jo = (no === '' || no === '전문') ? null : joCode(no);
  if (no && no !== '전문' && !jo) return send(res, 400, { error: '조문 번호 형식이 올바르지 않아요. 예: 제60조, 제76조의2' });

  try {
    const info = await resolveLaw(law);

    /* 법령 전체 조문 (법령 전문 보기) */
    if (q.full !== undefined) {
      const fj = await callLaw('lawService.do', { target: 'law', ID: info.id });
      const froot = fj['법령'] || fj;
      const fbasic = froot['기본정보'] || {};
      const items = [];
      asArray(froot['조문'] && froot['조문']['조문단위']).forEach(u => {
        if (!u || typeof u !== 'object') return;
        const isArticle = u['조문여부'] === undefined || u['조문여부'] === '조문';
        if (!isArticle) {
          const h = collectText(u).replace(/\s+/g, ' ').trim();
          if (h) items.push({ type: 'heading', text: h });
          return;
        }
        const num = String(u['조문번호'] || '').replace(/^0+/, '');
        if (!num) return;
        const sub = parseInt(u['조문가지번호'] || '0', 10) || 0;
        const text = collectText(u);
        items.push({ type: 'article', no: '제' + num + '조' + (sub ? '의' + sub : ''), title: String(u['조문제목'] || ''), text, amended: latestAmendDate(text) });
      });
      const count = items.filter(i => i.type === 'article').length;
      if (!count) return send(res, 404, { error: '이 법령의 조문을 찾지 못했어요.' });
      res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
      return res.status(200).json({
        law: fbasic['법령명_한글'] || info.name, lawId: info.id, count, items,
        effectiveDate: String(fbasic['시행일자'] || ''), promulgationDate: String(fbasic['공포일자'] || ''),
        source: '법제처 국가법령정보 Open API'
      });
    }

    const params = { target: 'law', ID: info.id };
    if (jo) params.JO = jo;
    const json = await callLaw('lawService.do', params);
    const root = json['법령'] || json;
    const basic = root['기본정보'] || {};
    const units = pickUnits(root['조문'] && root['조문']['조문단위'], jo);
    if (!units.length) return send(res, 404, { error: '해당 조문을 찾지 못했어요. 조문 번호가 바뀌었는지 확인하세요.' });
    const text = units.map(collectText).filter(Boolean).join('\n\n');

    // 같은 조문은 하루 동안 Vercel이 저장해 두고 재사용 → 법제처 호출 횟수 절약
    res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).json({
      law: basic['법령명_한글'] || info.name,
      lawId: info.id,
      no: no || '전문',
      title: units.length === 1 ? String(units[0]['조문제목'] || '') : '',
      text,
      effectiveDate: String(basic['시행일자'] || ''),
      joEffectiveDate: units.length === 1 ? String(units[0]['조문시행일자'] || '').replace(/\D/g, '') : '',
      joAmendedDate: latestAmendDate(text),
      promulgationDate: String(basic['공포일자'] || ''),
      source: '법제처 국가법령정보 Open API'
    });
  } catch (e) {
    return send(res, e.status || 500, { error: e.message || '알 수 없는 오류가 났어요.', hint: e.hint });
  }
}
