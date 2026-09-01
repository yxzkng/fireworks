/**
 * 지하철 실시간 도착정보 — 상세 시트를 열 때만 호출한다.
 *
 * GET /api/subway?area=여의도
 *
 * 서울시 실시간 지하철 인증키(SEOUL_SUBWAY_KEY)는 지역 혼잡도에 쓰는
 * SEOUL_API_KEY와 별개 키다(서울시가 지하철만 예외적으로 분리 발급한다).
 * 일일 호출 한도가 있어 전체 폴링 대신, 사용자가 상세를 열 때만 부르고
 * 짧게(30초) 캐시해 같은 역을 여러 명이 동시에 열어도 호출을 아낀다.
 */

/* 장소명 → 실제 지하철역명. 도보로 바로 닿지 않는 한강공원 등은 뺐다
   (가장 가까운 역이 애매해 오히려 혼란을 준다). */
const STATION_OF = {
  '여의도한강공원': '여의나루',
  '여의도': '여의도',
  '노량진': '노량진',
  '용산역': '용산',
  '영등포 타임스퀘어': '영등포시장',
  '합정역': '합정',
  '서울역': '서울역',
  '홍대 관광특구': '홍대입구',
  '신촌·이대역': '신촌',
  '고속터미널역': '고속터미널',
  '강남역': '강남',
};

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
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
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

  const cacheKey = `subway:${station}`;
  const cached = await kvGet(cacheKey);
  if (cached) {
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.json({ station, arrivals: cached, cached: true });
  }

  try {
    const arrivals = await fetchArrivals(station, key);
    if (!arrivals) return res.status(502).json({ error: 'upstream_error' });
    await kvSet(cacheKey, arrivals, { ex: 30 });
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    return res.json({ station, arrivals });
  } catch (e) {
    return res.status(502).json({ error: 'fetch_failed', message: String(e).slice(0, 100) });
  }
}
