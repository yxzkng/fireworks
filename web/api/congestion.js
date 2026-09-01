/**
 * 서울시 혼잡도 — 수집 겸 배포 엔드포인트
 *
 *   GET /api/congestion          접속자용. 캐시된 값만 내려준다.
 *   GET /api/congestion?cron=1   Vercel Cron이 5분마다 호출해 실제 수집을 한다.
 *
 * 서울시 API는 HTTP 전용이라 브라우저에서 직접 못 부른다(mixed content).
 * 게다가 인증키가 하루 1,000회 제한이라, 접속자마다 부르면 금방 넘긴다.
 * 그래서 서버가 5분에 한 번만 모아두고 접속자에게는 그 값을 나눠준다.
 */

import { kv } from '@vercel/kv';

/* 등급별 장소 — 전부 실호출로 검증된 이름이다(각각 다른 POI 코드 반환).
   HOT은 관람 핵심, WARM은 주변·귀가 경로, COLD는 지도 맥락용. */
const HOT  = ['여의도', '여의도한강공원', '여의서로', '노들섬'];
const WARM = ['이촌한강공원', '반포한강공원', '양화한강공원', '노량진',
              '용산역', '영등포 타임스퀘어', '합정역', '망원한강공원'];
const COLD = ['서울역', '홍대 관광특구', '신촌·이대역', '고속터미널역',
              '잠실한강공원', '뚝섬한강공원', '강남역'];
const ALL = [...new Set([...HOT, ...WARM, ...COLD])];

/** 이번 분에 어떤 등급을 갱신할지. 하루 총량이 1,000회를 넘지 않게 맞춰져 있다. */
function tiersToFetch(kst) {
  const h = kst.getUTCHours(), m = kst.getUTCMinutes();
  const list = [];
  if (h >= 12 && h < 24) {            // 축제 시간대 — 예산을 몰아준다
    list.push(...HOT);                                  // 5분
    if (m % 20 === 0) list.push(...WARM);               // 20분
    if (m % 60 === 0) list.push(...COLD);               // 60분
  } else if (h >= 8) {                // 오전
    if (m % 60 === 0) list.push(...HOT);
    if (h % 2 === 0 && m % 60 === 0) list.push(...WARM);
  } else {                            // 심야 — 사람도 데이터도 안 움직인다
    if (m === 0 && h % 4 === 0) list.push(...HOT);
  }
  return [...new Set(list)];
}

const range = (a, b) => {
  const x = Number(a), y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) ? { min: x, max: y } : null;
};

/** 171KB 원본에서 실제로 쓰는 것만 뽑는다. 필드가 비어 오는 일이 잦아 전부 옵셔널. */
function distill(cd) {
  const live = cd?.LIVE_PPLTN_STTS?.[0];
  if (!live) return null;

  const sub = cd.LIVE_SUB_PPLTN;
  const road = cd.ROAD_TRAFFIC_STTS?.AVG_ROAD_DATA;

  return {
    area: cd.AREA_NM,
    areaCode: cd.AREA_CD,
    congestion: {
      level: live.AREA_CONGEST_LVL,
      message: live.AREA_CONGEST_MSG,
      ppltn: range(live.AREA_PPLTN_MIN, live.AREA_PPLTN_MAX),
      time: live.PPLTN_TIME,
    },
    // 12시간 예측 — "지금"보다 "20시에 어디가 붐빌지"가 자리 잡는 데 중요하다
    forecast: (live.FCST_PPLTN || []).map((f) => ({
      time: f.FCST_TIME,
      level: f.FCST_CONGEST_LVL,
      ppltn: range(f.FCST_PPLTN_MIN, f.FCST_PPLTN_MAX),
    })),
    // 지하철 30분내 승하차 — 혼잡도 숫자에 안 나타나는 "방향".
    // 하차≫승차 = 몰려드는 중, 승차≫하차 = 빠져나가는 중(종료 후 귀가 러시).
    flow: sub ? {
      in:  range(sub.SUB_30WTHN_GTOFF_PPLTN_MIN, sub.SUB_30WTHN_GTOFF_PPLTN_MAX),
      out: range(sub.SUB_30WTHN_GTON_PPLTN_MIN,  sub.SUB_30WTHN_GTON_PPLTN_MAX),
    } : null,
    road: road ? { level: road.ROAD_TRAFFIC_IDX, message: road.ROAD_MSG } : null,
    bikes: (cd.SBIKE_STTS || []).reduce((s, b) => s + (Number(b.SBIKE_PARKING_CNT) || 0), 0),
    fetchedAt: new Date().toISOString(),
  };
}

async function collect(area, key) {
  const url = `http://openapi.seoul.go.kr:8088/${key}/json/citydata/1/5/${encodeURIComponent(area)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return { area, ok: false, why: `status ${res.status}` };
    const raw = await res.json();

    // 서울시는 실패도 HTTP 200으로 주고 RESULT.CODE로만 알린다.
    // 등록되지 않은 장소명에도 ERROR-500을 준다(서버 장애가 아니다).
    const code = raw?.RESULT?.['RESULT.CODE'];
    if (code && code !== 'INFO-000') return { area, ok: false, why: code };

    const data = distill(raw?.CITYDATA);
    if (!data) return { area, ok: false, why: 'no data' };
    await kv.set(`area:${area}`, data);
    return { area, ok: true };
  } catch (e) {
    return { area, ok: false, why: String(e).slice(0, 60) };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const isCron = req.query?.cron === '1';

  if (isCron) {
    // Vercel Cron만 부를 수 있게 막는다. 열어두면 누구나 예산을 태울 수 있다.
    const secret = process.env.CRON_SECRET;
    const auth = req.headers.authorization || '';
    if (secret && auth !== `Bearer ${secret}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }

    const kst = new Date(Date.now() + 9 * 3600 * 1000);
    // ?all=1 이면 등급 무시하고 전부 — 배포 직후 첫 데이터를 채울 때 쓴다
    const targets = req.query?.all === '1' ? ALL : tiersToFetch(kst);
    if (!targets.length) return res.json({ skipped: true });

    // 서울시를 한꺼번에 때리지 않도록 4개씩 나눠 부른다
    const results = [];
    for (let i = 0; i < targets.length; i += 4) {
      results.push(...await Promise.all(targets.slice(i, i + 4).map((a) => collect(a, process.env.SEOUL_API_KEY))));
    }

    const day = kst.toISOString().slice(0, 10);
    const used = (await kv.get(`calls:${day}`)) || 0;
    await kv.set(`calls:${day}`, used + targets.length, { ex: 172800 });
    await kv.set('meta', {
      updatedAt: new Date().toISOString(),
      failed: results.filter((r) => !r.ok),
      callsToday: used + targets.length,
    });

    return res.json({ fetched: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok) });
  }

  // 접속자 요청 — 저장된 값만 읽는다. 서울시 API는 부르지 않는다.
  const [values, meta] = await Promise.all([
    Promise.all(ALL.map((a) => kv.get(`area:${a}`))),
    kv.get('meta'),
  ]);
  const areas = {};
  ALL.forEach((a, i) => { if (values[i]) areas[a] = values[i]; });

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
  return res.json({ areas, meta: meta || null });
}
