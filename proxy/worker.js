/**
 * 서울시 실시간 도시데이터 수집기 + HTTPS 배포
 *
 * 두 가지 일을 한다:
 *  1) Cron 트리거로 5분마다 스스로 서울시 API를 호출해 KV에 저장한다.
 *  2) 접속자에게는 KV에 저장된 값만 내려준다 (API를 다시 부르지 않는다).
 *
 * 이렇게 하는 이유: 서울시 인증키는 하루 1,000회 제한이다.
 * 접속자마다 호출하면 수백 명만 몰려도 한도를 넘긴다.
 * 수집을 서버 쪽으로 옮기면 API 호출 수가 접속자 수와 완전히 무관해진다.
 *
 * 한도 배분 (하루 약 900회):
 *   HOT   6곳 × 5분  = 1,728회/일 ...는 초과라서, 축제 시간대에만 5분으로 좁힌다.
 *   실제로는 아래 tierOf()가 시간대에 따라 주기를 바꾼다.
 */

/* ── 장소 등급 ──────────────────────────────────────────
   HOT  : 관람 핵심. 가장 자주 갱신한다.
   WARM : 여의도 주변·귀가 경로.
   COLD : 나머지 서울 전역. 지도 맥락용이라 느려도 된다.
   전부 실호출로 검증된 이름이다(각각 다른 POI 코드 반환). */
const HOT = ['여의도', '여의도한강공원', '여의서로', '노들섬'];

const WARM = ['이촌한강공원', '반포한강공원', '양화한강공원', '노량진',
              '용산역', '영등포 타임스퀘어', '합정역', '망원한강공원'];

const COLD = ['서울역', '홍대 관광특구', '신촌·이대역', '고속터미널역',
              '잠실한강공원', '뚝섬한강공원', '반포한강공원', '강남역'];

const ALL = [...new Set([...HOT, ...WARM, ...COLD])];

/* 시간대별 갱신 주기. 하루 총 호출이 1,000회를 넘지 않게 맞춰져 있다
   (검증: check-budget.mjs — 현재 약 900회).

   활용사례(갤러리) 등록으로 한도가 풀리면 여기 숫자만 키우면 된다.
   예를 들어 심야 조건을 없애고 WARM을 10분으로 당기는 식. */
function tiersToFetch(nowKst) {
  const h = nowKst.getUTCHours();          // 호출부에서 KST로 보정해 넘긴다
  const m = nowKst.getUTCMinutes();

  const list = [];
  if (h >= 12 && h < 24) {
    // 축제 시간대 — 여기에 예산을 몰아준다
    list.push(...HOT);                                  // 5분
    if (m % 20 === 0) list.push(...WARM);               // 20분
    if (m % 60 === 0) list.push(...COLD);               // 60분
  } else if (h >= 8) {
    // 오전 — 자리 잡으러 나서는 시간대라 최소한은 갱신한다
    if (m % 60 === 0) list.push(...HOT);
    if (h % 2 === 0 && m % 60 === 0) list.push(...WARM);
  } else {
    // 심야·새벽(0~8시) — 사람도 데이터도 움직이지 않는다. 예산을 아낀다.
    if (m === 0 && h % 4 === 0) list.push(...HOT);
  }
  return [...new Set(list)];
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });

const range = (min, max) => {
  const a = Number(min), b = Number(max);
  return Number.isFinite(a) && Number.isFinite(b) ? { min: a, max: b } : null;
};

/** 171KB 원본에서 실제로 쓰는 것만 뽑는다. 필드가 비어 오는 일이 잦아 전부 옵셔널. */
function distill(citydata) {
  const live = citydata?.LIVE_PPLTN_STTS?.[0];
  if (!live) return null;

  const forecast = (live.FCST_PPLTN || []).map((f) => ({
    time: f.FCST_TIME,
    level: f.FCST_CONGEST_LVL,
    ppltn: range(f.FCST_PPLTN_MIN, f.FCST_PPLTN_MAX),
  }));

  // 지하철 30분내 승하차 — 혼잡도 숫자에는 안 나타나는 "방향".
  // 하차≫승차 = 몰려드는 중, 승차≫하차 = 빠져나가는 중(종료 후 귀가 러시).
  const sub = citydata.LIVE_SUB_PPLTN;
  const flow = sub ? {
    in:  range(sub.SUB_30WTHN_GTOFF_PPLTN_MIN, sub.SUB_30WTHN_GTOFF_PPLTN_MAX),
    out: range(sub.SUB_30WTHN_GTON_PPLTN_MIN,  sub.SUB_30WTHN_GTON_PPLTN_MAX),
  } : null;

  const road = citydata.ROAD_TRAFFIC_STTS?.AVG_ROAD_DATA;
  const bikes = (citydata.SBIKE_STTS || [])
    .reduce((s, b) => s + (Number(b.SBIKE_PARKING_CNT) || 0), 0);

  return {
    area: citydata.AREA_NM,
    areaCode: citydata.AREA_CD,
    congestion: {
      level: live.AREA_CONGEST_LVL,
      message: live.AREA_CONGEST_MSG,
      ppltn: range(live.AREA_PPLTN_MIN, live.AREA_PPLTN_MAX),
      time: live.PPLTN_TIME,
    },
    forecast, flow,
    road: road ? { level: road.ROAD_TRAFFIC_IDX, message: road.ROAD_MSG } : null,
    bikes,
    fetchedAt: new Date().toISOString(),
  };
}

/** 한 장소를 불러 KV에 저장한다. 실패해도 이전 값은 그대로 남는다. */
async function collect(area, env) {
  const url = `http://openapi.seoul.go.kr:8088/${env.SEOUL_API_KEY}` +
              `/json/citydata/1/5/${encodeURIComponent(area)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return { area, ok: false, why: `status ${res.status}` };
    const raw = await res.json();

    // 서울시는 실패도 200으로 주고 RESULT.CODE로만 알린다.
    // 등록되지 않은 장소명에도 ERROR-500을 준다(서버 장애가 아님).
    const code = raw?.RESULT?.['RESULT.CODE'];
    if (code && code !== 'INFO-000') return { area, ok: false, why: code };

    const data = distill(raw?.CITYDATA);
    if (!data) return { area, ok: false, why: 'no data' };

    await env.CITY.put(`area:${area}`, JSON.stringify(data));
    return { area, ok: true };
  } catch (e) {
    return { area, ok: false, why: String(e).slice(0, 60) };
  }
}

export default {
  /** Cron: 5분마다 실행되며, 이번 분에 해당하는 등급만 수집한다. */
  async scheduled(event, env, ctx) {
    const kst = new Date(Date.now() + 9 * 3600 * 1000);
    const targets = tiersToFetch(kst);
    if (!targets.length) return;

    // 서울시를 한꺼번에 때리지 않도록 4개씩 나눠 부른다.
    const results = [];
    for (let i = 0; i < targets.length; i += 4) {
      results.push(...await Promise.all(
        targets.slice(i, i + 4).map((a) => collect(a, env))));
    }

    // 오늘 사용량을 세어둔다(한도 관리용). 자정에 자연히 새 키로 넘어간다.
    const day = kst.toISOString().slice(0, 10);
    const used = Number(await env.CITY.get(`calls:${day}`)) || 0;
    await env.CITY.put(`calls:${day}`, String(used + targets.length),
                       { expirationTtl: 172800 });

    await env.CITY.put('meta', JSON.stringify({
      updatedAt: new Date().toISOString(),
      fetched: results.filter((r) => r.ok).map((r) => r.area),
      failed: results.filter((r) => !r.ok),
      callsToday: used + targets.length,
    }));
  },

  /** 접속자 요청: KV만 읽는다. 서울시 API는 절대 부르지 않는다. */
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);

    const { pathname, searchParams } = new URL(request.url);

    // 관리용: 수집 상태와 오늘 호출 수 확인
    if (pathname === '/meta') {
      const meta = await env.CITY.get('meta');
      return json(meta ? JSON.parse(meta) : { error: 'not_collected_yet' });
    }

    // 수동 수집 트리거 (배포 직후 첫 데이터를 채울 때)
    if (pathname === '/collect') {
      if (searchParams.get('key') !== env.ADMIN_KEY) return json({ error: 'forbidden' }, 403);
      const results = [];
      for (let i = 0; i < ALL.length; i += 4) {
        results.push(...await Promise.all(ALL.slice(i, i + 4).map((a) => collect(a, env))));
      }
      return json({ collected: results });
    }

    // 기본: 전체 장소를 한 번에 내려준다.
    // 접속자가 장소마다 따로 요청하면 왕복이 늘어 현장 네트워크에서 느리다.
    const entries = await Promise.all(ALL.map(async (a) => {
      const v = await env.CITY.get(`area:${a}`);
      return v ? [a, JSON.parse(v)] : null;
    }));

    const areas = Object.fromEntries(entries.filter(Boolean));
    const meta = await env.CITY.get('meta');

    return json(
      { areas, meta: meta ? JSON.parse(meta) : null },
      200,
      // 접속자 쪽 캐시 60초. 원본이 5분 주기라 더 자주 받을 이유가 없다.
      { 'Cache-Control': 'public, max-age=60' },
    );
  },
};
