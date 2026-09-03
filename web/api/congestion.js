/**
 * 서울시 혼잡도 — 접속자 요청을 트리거 삼아 수집하는 엔드포인트
 *
 *   GET /api/congestion   접속자용. 캐시가 신선하면 그대로, 등급별로
 *                         만료됐으면 이 요청이 락을 잡고 서울시를 불러 채운다.
 *
 * Hobby 플랜은 Cron이 하루 1회로 제한되어 5분 주기 폴링을 못 쓴다(Pro부터
 * 분 단위 Cron 허용). 그래서 "누군가 접속했을 때 캐시가 오래됐으면 그
 * 요청이 대신 갱신한다" 방식으로 바꿨다 — subway.js와 같은 패턴이다.
 *
 * 서울시 API는 HTTP 전용이라 브라우저에서 직접 못 부른다(mixed content).
 * 게다가 인증키가 하루 1,000회 제한이라, 접속자마다 부르면 금방 넘긴다.
 * 그래서 등급별 TTL(HOT 5분·WARM 20분·COLD 60분)로 캐시하고, 만료된
 * 등급만 락을 쥔 요청 하나가 갱신해 접속자 수와 호출량을 분리한다.
 */

/* 등급별 장소 — 전부 실호출로 검증된 이름이다(각각 다른 POI 코드 반환).
   HOT은 관람 핵심, WARM은 주변·귀가 경로.
   불꽃이 보이지 않는 원거리 환승 거점(서울역·홍대 관광특구·신촌·이대역·
   고속터미널역·잠실한강공원·뚝섬한강공원·강남역·용산역·영등포 타임스퀘어)은
   COLD 등급째로 제외했다 — 관람 판단에 쓸모가 없는데 예산만 쓴다. */
const HOT  = ['여의도', '여의도한강공원', '여의서로', '노들섬'];
const WARM = ['이촌한강공원', '반포한강공원', '양화한강공원', '노량진', '합정역', '망원한강공원'];
const COLD = [];
const ALL = [...new Set([...HOT, ...WARM, ...COLD])];

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

/** 여러 키를 한 번의 왕복으로 읽는다. 개별 kvGet을 Promise.all로 병렬
 *  호출해도 각각 별도의 HTTP 요청이 나가므로(REST 기반 KV라 커넥션 재사용이
 *  안 됨), 키가 여럿일 때는 이쪽이 훨씬 빠르다. */
async function kvMget(keys) {
  if (!keys.length) return [];
  const client = await getKv();
  if (!client) return keys.map(() => null);
  try { return await client.mget(...keys); } catch { return keys.map(() => null); }
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

/* 등급별 캐시 수명(초). 짧을수록 자주 갱신되지만 그만큼 서울시 호출도
   늘어난다 — HOT(관람 핵심)에 예산을 몰아주고 WARM(주변·귀가 경로)은 느슨하게.
   Cron이 없으므로 이 TTL이 곧 "최대 이만큼 묵을 수 있다"는 약속이다.
   트래픽이 끊이지 않는다는 최악의 가정으로 하루 예산(900회) 안에
   들어오도록 잡은 값이다(HOT 12분·WARM 45분 하한).
   실제로는 DAILY_BUDGET 체크가 한 번 더 막아주므로 여유를 더 뒀다.
   COLD는 더 이상 쓰지 않지만(불꽃 안 보이는 원거리 거점을 뺐다),
   staleTier 탐색이 빈 배열을 자연스럽게 건너뛰므로 값만 남겨둔다. */
const TTL = { HOT: 420, WARM: 1500, COLD: 4500 };
const TIER_OF = new Map([
  ...HOT.map((a) => [a, 'HOT']),
  ...WARM.map((a) => [a, 'WARM']),
  ...COLD.map((a) => [a, 'COLD']),
]);
const AREAS_OF_TIER = { HOT, WARM, COLD };

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

async function fetchLive(area, key, timeoutMs) {
  const url = `http://openapi.seoul.go.kr:8088/${key}/json/citydata/1/5/${encodeURIComponent(area)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) return null;
  const raw = await res.json();
  // 서울시는 실패도 HTTP 200으로 주고 RESULT.CODE로만 알린다.
  // 등록되지 않은 장소명에도 ERROR-500을 준다(서버 장애가 아니다).
  const code = raw?.RESULT?.['RESULT.CODE'];
  if (code && code !== 'INFO-000') return null;
  return distill(raw?.CITYDATA);
}

/** 서울시를 불러 캐시를 채운다. 등급의 TTL만큼 살려두고, 하루짜리 사본을
 *  stale로 따로 남겨 예산 초과로 못 채울 때도 완전히 빈 화면은 막는다. */
async function collect(area, key, timeoutMs = 6000) {
  try {
    const data = await fetchLive(area, key, timeoutMs);
    if (!data) return { area, ok: false, why: 'no data' };
    const ttl = TTL[TIER_OF.get(area)] || TTL.COLD;
    await kvSet(`area:${area}`, data, { ex: ttl });
    await kvSet(`area:stale:${area}`, data, { ex: 86400 });
    return { area, ok: true, data };
  } catch (e) {
    return { area, ok: false, why: String(e).slice(0, 60) };
  }
}

const DAILY_BUDGET = 900;   // 한도 1,000에서 예비를 남긴 값

async function bumpCallCount(kst, n) {
  const day = kst.toISOString().slice(0, 10);
  const used = (await kvGet(`calls:${day}`)) || 0;
  await kvSet(`calls:${day}`, used + n, { ex: 172800 });
  return used + n;
}

async function callsUsedToday(kst) {
  return (await kvGet(`calls:${kst.toISOString().slice(0, 10)}`)) || 0;
}

/**
 * 만료된(=null로 돌아온) 등급 하나를 골라 락을 잡고 갱신한다.
 *
 * 락을 놓친 요청은 빈손으로 돌아가지 않는다 — 락 보유자가 채울 때까지
 * 잠깐 기다렸다가 그 값을 areas에 채워 넣는다. 그렇지 않으면 배포 직후나
 * 등급이 막 만료된 순간 동시에 들어온 요청 대부분이 회색 화면을 보게 된다
 * (fetch가 병렬이라도 왕복에 1~2초는 걸리고, 그사이 도착하는 모든 요청이
 *  락 없이 빈 응답을 받기 때문).
 */
async function refreshOneStaleTier(areas, kst, key) {
  const staleTier = ['HOT', 'WARM', 'COLD'].find(
    (t) => AREAS_OF_TIER[t].some((a) => !areas[a]));
  if (!staleTier) return null;

  const gotLock = await kvSetIfAbsent(`fill:lock:${staleTier}`, 1, 20);

  if (!gotLock) {
    // 남이 채우는 중이다. 대표로 그 등급 첫 장소 하나만 폴링해 채워지면
    // 나머지도 같이 채워졌다고 보고 한 번에 읽어온다(등급을 통째로 부르므로).
    // 락 보유자는 병렬 호출이라 보통 1~2초, 느려도 6초(fetch 타임아웃) 안에 끝난다.
    const probe = AREAS_OF_TIER[staleTier][0];
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const filled = await kvGet(`area:${probe}`);
      if (filled) {
        const rest = await kvMget(AREAS_OF_TIER[staleTier].map((a) => `area:${a}`));
        AREAS_OF_TIER[staleTier].forEach((a, i2) => { if (rest[i2]) areas[a] = rest[i2]; });
        return null; // meta는 락 보유자가 이미 갱신했으므로 새로 쓸 필요 없다
      }
    }
    return null; // 너무 오래 걸리면 포기 — 이후 stale 폴백이 화면을 채운다
  }

  const used = await callsUsedToday(kst);
  const targets = AREAS_OF_TIER[staleTier];
  if (used + targets.length > DAILY_BUDGET) return null;

  // 함수 제한(Hobby 10초) 안에서 끝나야 하므로 등급 내부는 병렬로 부른다.
  // HOT(4곳)·WARM(8곳)·COLD(7곳) 모두 여유 있게 끝난다.
  const results = await Promise.all(targets.map((a) => collect(a, key)));
  results.forEach((r) => { if (r.ok && r.data) areas[r.area] = r.data; });
  await bumpCallCount(kst, targets.length);
  return { tier: staleTier, failed: results.filter((r) => !r.ok) };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const kst = new Date(Date.now() + 9 * 3600 * 1000);
  const key = process.env.SEOUL_API_KEY;

  let values = [], meta = null;
  try {
    [values, meta] = await Promise.all([
      kvMget(ALL.map((a) => `area:${a}`)),
      kvGet('meta'),
    ]);
  } catch (e) {
    if (!key) {
      return res.status(503).json({
        error: 'kv_unavailable',
        message: 'Vercel KV 연결을 확인하세요.',
      });
    }
    values = [];
    meta = { updatedAt: null, kvUnavailable: true };
  }
  const areas = {};
  ALL.forEach((a, i) => { if (values[i]) areas[a] = values[i]; });

  // 등급 TTL이 지나 비어버린 곳이 있으면, 이 요청이 락을 잡고 그 등급 하나를
  // 갱신한다. 락을 놓친 동시 요청들은 그냥 넘어가고(다음 등급은 다음 요청이
  // 채운다), 캐시에 남아 있던 다른 등급 값으로 화면은 정상적으로 뜬다.
  if (key) {
    const refreshed = await refreshOneStaleTier(areas, kst, key);
    if (refreshed) {
      meta = {
        updatedAt: new Date().toISOString(),
        failed: refreshed.failed,
        callsToday: await callsUsedToday(kst),
        refreshedTier: refreshed.tier,
      };
      await kvSet('meta', meta);
    }
  }

  // 락을 못 잡았거나 예산이 바닥나 못 채운 곳은 하루 묵은 stale 사본으로
  // 메운다 — 비어 있는 것보다 몇 시간 지난 값이라도 있는 편이 낫다.
  const missing = ALL.filter((a) => !areas[a]);
  if (missing.length) {
    const stale = await kvMget(missing.map((a) => `area:stale:${a}`));
    missing.forEach((a, i) => { if (stale[i]) areas[a] = stale[i]; });
  }

  // ?area=<이름> 이면 그 장소의 전체(예측 포함)를 준다. 상세 화면을 열 때만 쓴다.
  const one = req.query?.area;
  if (one){
    if (!areas[one] && ALL.includes(one) && key) {
      const live = await collect(one, key);
      if (live.ok) { areas[one] = live.data; await bumpCallCount(kst, 1); }
      else { const stale = await kvGet(`area:stale:${one}`); if (stale) areas[one] = stale; }
    }
    if (!areas[one]) return res.status(404).json({ error: 'not_found' });
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.json({ area: areas[one] });
  }

  // 기본 응답은 목록·지도에 필요한 것만 담는다.
  // 12시간 예측(forecast)은 상세에서만 쓰이면서 응답의 65%를 차지한다.
  // 모든 접속자가 1분마다 받아 가면 그게 전송량의 대부분이 된다.
  const slim = {};
  for (const [name, d] of Object.entries(areas)){
    slim[name] = {
      area: d.area,
      congestion: d.congestion,
      flow: d.flow,
      road: d.road,
      bikes: d.bikes,
    };
  }

  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
  return res.json({ areas: slim, meta: meta || null });
}
