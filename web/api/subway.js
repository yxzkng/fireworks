/**
 * 지하철 실시간 도착정보 — 상세 시트를 열 때만 호출한다.
 *
 * GET /api/subway?area=여의도
 *
 * 서울시 실시간 지하철 인증키(SEOUL_SUBWAY_KEY)는 지역 혼잡도에 쓰는
 * SEOUL_API_KEY와 별개 키다(서울시가 지하철만 예외적으로 분리 발급한다).
 * 일일 호출 한도가 1,000회뿐이라, 이 엔드포인트는 세 겹으로 예산을 지킨다.
 *
 *   1. 대상을 발사지점 코앞 두 역으로 한정한다 (여의나루·여의도).
 *      역이 늘면 호출도 그만큼 배로 늘고, 먼 역의 열차 시각은
 *      귀가 동선에 실제로 쓰이지 않는다.
 *   2. 캐시 TTL을 시간대별로 준다. 귀가 러시(18~24시)에만 30초로 두고
 *      나머지 시간은 5분으로 늘린다 — 예산을 필요한 곳에 몰아준다.
 *   3. 하루 850회를 넘으면 새 호출을 멈추고 캐시된 값만 내려준다.
 *      한도를 넘겨 API가 종일 죽는 것이 최악이라 그 앞에서 스스로 멈춘다.
 *
 * 여기에 single-flight 락이 더해진다. 캐시가 만료되는 순간 같은 역을 연
 * 접속자가 전부 동시에 미스를 보기 때문에, 락이 없으면 30초에 1회가 아니라
 * 30초에 접속자 수만큼 나간다 — 위 계산이 통째로 무의미해진다.
 */

/* 장소명 → 실제 지하철역명.
   일일 1,000회 한도를 지키려고 발사지점 코앞 두 역만 남겼다. 관람객이
   실제로 빠져나가는 경로이고, 여기 예산을 몰아줘야 러시 시간대에
   30초 신선도를 유지할 수 있다. 역을 추가하면 그만큼 TTL을 늘려야 한다. */
const STATION_OF = {
  '여의도한강공원': '여의나루',   // 0.4km — 관람 핵심
  '여의도': '여의도',             // 0.8km — 5·9호선 환승
};

/** 이 시각에 쓸 캐시 수명(초).
 *  불꽃은 20:20~20:35이고 귀가 러시는 그 직후 몰린다. 30초 신선도는
 *  그 세 시간에만 쓴다 — 창을 18시로 넓히면 최악의 경우 1,584회가 되어
 *  정작 러시 한복판인 21시쯤 예산이 바닥난다. */
function ttlFor(kst) {
  const h = kst.getUTCHours();
  if (h >= 20 && h < 23) return 30;    // 귀가 러시 — 여기에 예산을 몰아준다
  if (h >= 17 && h < 20) return 120;   // 모여드는 시간
  return 300;
}

const DAILY_BUDGET = 850;   // 한도 1,000에서 예비를 남긴 값

/* 러시 전 시간대에 쓸 수 있는 상한. 낮에 상세를 들락거리는 것만으로
   예산이 말라 정작 20~23시에 못 부르는 일을 막는다. 러시에 필요한
   양(3시간 × 2역 × 120회 = 720)을 남겨두는 값이다. */
const PRE_RUSH_BUDGET = 120;
const isRush = (kst) => { const h = kst.getUTCHours(); return h >= 20 && h < 23; };

/* 노출 창 — 클라이언트(template.html의 SUBWAY_WINDOW)와 같은 값이다.
   화면에서 이미 막지만 서버도 같이 막는다. 클라이언트 게이트는 API를
   직접 부르면 그만이라, 예산을 실제로 지키는 건 이쪽이다.
   축제 날짜가 바뀌면 SHOW_DATE만 고치면 된다(환경변수로도 덮을 수 있다). */
const SHOW_DATE = process.env.SHOW_DATE || '2026-09-05';   // KST 기준 날짜
const WINDOW_FROM_HOUR = 17;
const WINDOW_TO_HOUR = 24;

/** 지금이 도착정보를 내려줄 시간대인가. kst는 KST로 옮겨둔 Date다. */
function inWindow(kst) {
  if (kst.toISOString().slice(0, 10) !== SHOW_DATE) return false;
  const h = kst.getUTCHours();
  return h >= WINDOW_FROM_HOUR && h < WINDOW_TO_HOUR;
}

let kvClientPromise;
async function getKv() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  kvClientPromise ||= import('@vercel/kv').then((m) => m.kv).catch(() => null);
  return kvClientPromise;
}
async function kvGet(key) {
  const client = await getKv();
  if (!client) return null;
  try { return await client.get(key); } catch { return null; }
}
async function kvSet(key, value, options) {
  const client = await getKv();
  if (!client) return;
  try { await client.set(key, value, options); } catch {}
}

/** 없을 때만 넣는다. 참이면 이 요청이 락을 쥔 것이다. */
async function kvSetIfAbsent(key, value, ttlSec) {
  const client = await getKv();
  if (!client) return false;
  try { return (await client.set(key, value, { nx: true, ex: ttlSec })) !== null; }
  catch { return false; }
}

/** 원자적 증가. KV가 없으면 예산을 셀 수 없으니 0을 준다. */
async function kvIncr(key, ttlSec) {
  const client = await getKv();
  if (!client) return 0;
  try {
    const n = await client.incr(key);
    if (n === 1 && ttlSec) await client.expire(key, ttlSec);
    return n;
  } catch { return 0; }
}

/** 도착 메시지 하나를 화면에 쓸 형태로 줄인다. */
function distillArrival(a) {
  return {
    line: a.subwayId,
    dir: a.updnLine,               // '상행' | '하행'
    to: a.trainLineNm,             // 예: '방화행 - 여의도방면'
    msg: a.arvlMsg2,                // 예: '9분 후 (충정로)', '전역 도착'
    lastcar: a.lstcarAt === '1',
  };
}

async function fetchArrivals(station, key) {
  const url = `http://swopenAPI.seoul.go.kr/api/subway/${key}` +
              `/json/realtimeStationArrival/0/10/${encodeURIComponent(station)}`;
  // 접속자 요청 경로다. 8초를 기다리면 함수 제한(Hobby 10초)에 바짝 붙어
  // 응답 자체를 못 줄 수 있다. 빨리 포기하고 묵은 값으로 답하는 편이 낫다.
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;
  const raw = await res.json();
  const code = raw?.errorMessage?.code;
  if (code && code !== 'INFO-000') return null;
  const list = raw?.realtimeArrivalList || [];
  return list.map(distillArrival);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const area = req.query?.area;
  const station = STATION_OF[area];
  if (!station) return res.status(404).json({ error: 'no_station_for_area' });

  const key = process.env.SEOUL_SUBWAY_KEY;
  if (!key) return res.status(503).json({ error: 'subway_key_not_configured' });

  const kst = new Date(Date.now() + 9 * 3600 * 1000);

  // 창 밖에서는 서울시를 부르지 않는다. 캐시가 남아 있으면 그건 내려준다
  // (호출이 늘지 않으므로 막을 이유가 없다).
  if (!inWindow(kst)) {
    const cached = await kvGet(`subway:${station}`) || await kvGet(`subway:stale:${station}`);
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1200');
    if (cached) return res.json({ station, arrivals: cached, stale: true, outsideWindow: true });
    return res.status(503).json({ error: 'outside_window', from: WINDOW_FROM_HOUR, to: WINDOW_TO_HOUR });
  }

  const ttl = ttlFor(kst);

  const cacheKey = `subway:${station}`;
  // 만료된 뒤에도 한동안 남겨두는 사본. 락을 못 잡은 요청과 예산이 바닥난
  // 뒤의 요청이 빈손으로 돌아가지 않도록 받쳐준다.
  const staleKey = `subway:stale:${station}`;

  const send = (arrivals, extra) => {
    res.setHeader('Cache-Control', `s-maxage=${ttl}, stale-while-revalidate=${ttl * 2}`);
    return res.json({ station, arrivals, ...extra });
  };

  const cached = await kvGet(cacheKey);
  if (cached) return send(cached, { cached: true });

  // 캐시가 비었다 — 여기서부터가 실제 호출이 나가는 유일한 경로다.
  // 락을 잡은 요청 하나만 서울시를 부르고, 나머지는 묵은 값으로 답한다.
  const gotLock = await kvSetIfAbsent(`subway:lock:${station}`, 1, 15);
  if (!gotLock) {
    // 묵은 값이 있으면 그걸 준다 — 몇 초 지난 도착정보는 여전히 쓸 만하다.
    const stale = await kvGet(staleKey);
    if (stale) return send(stale, { stale: true });

    // 캐시가 통째로 빈 첫 조회라면 줄 게 없다. 여기서 503을 내면
    // 러시 시작 순간 먼저 연 수십 명이 전부 실패 화면을 본다.
    // 락을 쥔 요청이 채워 넣을 때까지 잠깐 기다렸다가 그 값을 쓴다.
    // 락 보유자가 최대 5초(타임아웃) 걸리므로 그보다 넉넉히 기다린다.
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const filled = await kvGet(cacheKey);
      if (filled) return send(filled, { waited: true });
    }
    return res.status(503).json({ error: 'busy' });
  }

  const day = kst.toISOString().slice(0, 10);
  const used = await kvIncr(`subway:calls:${day}`, 172800);
  const cap = isRush(kst) ? DAILY_BUDGET : PRE_RUSH_BUDGET;
  if (used > cap) {
    const stale = await kvGet(staleKey);
    if (stale) return send(stale, { stale: true, budgetExhausted: true });
    return res.status(503).json({ error: 'daily_budget_exhausted' });
  }

  try {
    const arrivals = await fetchArrivals(station, key);
    if (!arrivals) {
      const stale = await kvGet(staleKey);
      if (stale) return send(stale, { stale: true });
      return res.status(502).json({ error: 'upstream_error' });
    }
    await kvSet(cacheKey, arrivals, { ex: ttl });
    await kvSet(staleKey, arrivals, { ex: 1800 });
    return send(arrivals);
  } catch (e) {
    const stale = await kvGet(staleKey);
    if (stale) return send(stale, { stale: true });
    return res.status(502).json({ error: 'fetch_failed', message: String(e).slice(0, 100) });
  }
}
