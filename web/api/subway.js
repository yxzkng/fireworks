/**
 * 지하철 실시간 도착정보 — 상세 시트를 열 때, 사용자가 새로고침을 누를 때 호출한다.
 *
 * GET /api/subway?area=여의도
 *
 * 서울시 실시간 지하철 인증키(SEOUL_SUBWAY_KEY)는 지역 혼잡도에 쓰는
 * SEOUL_API_KEY와 별개 키다(서울시가 지하철만 예외적으로 분리 발급한다).
 * 활용사례 등록·승인을 받아 호출 횟수 제한이 없으므로, 예산 관리 없이
 * 요청이 올 때마다 바로 서울시를 부른다. 캐시는 같은 순간 몰리는 동시
 * 요청을 한 번의 호출로 묶기 위한 짧은 single-flight TTL(10초)만 둔다.
 */

/* 장소명 → 실제 지하철역명. 발사지점 코앞 두 역만 다룬다(관람객이
   실제로 빠져나가는 경로). 필요하면 역을 더 추가해도 된다. */
const STATION_OF = {
  '여의도한강공원': '여의나루',   // 0.4km — 관람 핵심
  '여의도': '여의도',             // 0.8km — 5·9호선 환승
};

const TTL = 10;   // single-flight용 짧은 캐시. 신선도가 핵심이라 길게 두지 않는다.

/* 노출 창 — 클라이언트(template.html의 SUBWAY_WINDOW)와 같은 값이다.
   화면에서 이미 막지만 창 밖 요청까지 서울시로 보내지 않도록 서버도 같이 막는다.
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

  const cacheKey = `subway:${station}`;
  // 만료된 뒤에도 한동안 남겨두는 사본. 락을 못 잡은 요청이 빈손으로
  // 돌아가지 않도록 받쳐준다.
  const staleKey = `subway:stale:${station}`;

  const send = (arrivals, extra) => {
    res.setHeader('Cache-Control', `s-maxage=${TTL}, stale-while-revalidate=${TTL * 2}`);
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

  try {
    const arrivals = await fetchArrivals(station, key);
    if (!arrivals) {
      const stale = await kvGet(staleKey);
      if (stale) return send(stale, { stale: true });
      return res.status(502).json({ error: 'upstream_error' });
    }
    await kvSet(cacheKey, arrivals, { ex: TTL });
    await kvSet(staleKey, arrivals, { ex: 1800 });
    return send(arrivals);
  } catch (e) {
    const stale = await kvGet(staleKey);
    if (stale) return send(stale, { stale: true });
    return res.status(502).json({ error: 'fetch_failed', message: String(e).slice(0, 100) });
  }
}
