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

/* 등급별 장소 — 전부 실호출로 검증된 이름이다(각각 다른 POI 코드 반환).
   HOT은 관람 핵심, WARM은 주변·귀가 경로, COLD는 지도 맥락용. */
const HOT  = ['여의도', '여의도한강공원', '여의서로', '노들섬'];
const WARM = ['이촌한강공원', '반포한강공원', '양화한강공원', '노량진',
              '용산역', '영등포 타임스퀘어', '합정역', '망원한강공원'];
const COLD = ['서울역', '홍대 관광특구', '신촌·이대역', '고속터미널역',
              '잠실한강공원', '뚝섬한강공원', '강남역'];
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
    // cron도 같은 10초 제한을 받는다. 정시에는 19곳을 부르므로
    // 한 곳이 오래 붙들면 나머지가 통째로 날아간다.
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return { area, ok: false, why: `status ${res.status}` };
    const raw = await res.json();

    // 서울시는 실패도 HTTP 200으로 주고 RESULT.CODE로만 알린다.
    // 등록되지 않은 장소명에도 ERROR-500을 준다(서버 장애가 아니다).
    const code = raw?.RESULT?.['RESULT.CODE'];
    if (code && code !== 'INFO-000') return { area, ok: false, why: code };

    const data = distill(raw?.CITYDATA);
    if (!data) return { area, ok: false, why: 'no data' };
    await kvSet(`area:${area}`, data);
    return { area, ok: true, data };
  } catch (e) {
    return { area, ok: false, why: String(e).slice(0, 60) };
  }
}

async function fetchLive(area, key) {
  const url = `http://openapi.seoul.go.kr:8088/${key}/json/citydata/1/5/${encodeURIComponent(area)}`;
  // 접속자 요청 경로에서 쓰인다. 12초를 기다리면 함수 제한(10초)에 걸려
  // 응답 자체를 못 준다. 여기서는 빨리 포기하고 빈손으로 돌아가는 편이 낫다.
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return null;
  const raw = await res.json();
  const code = raw?.RESULT?.['RESULT.CODE'];
  if (code && code !== 'INFO-000') return null;
  return distill(raw?.CITYDATA);
}

async function collectBestEffort(area, key) {
  const data = await fetchLive(area, key);
  if (!data) return { area, ok: false, why: 'no data' };
  await kvSet(`area:${area}`, data);
  return { area, ok: true, data };
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

    // 서울시를 한꺼번에 때리지 않도록 나눠 부르되, 배치가 너무 잘게 쪼개지면
    // 왕복이 쌓여 10초 제한에 걸린다(19곳을 4개씩이면 5배치 = 최악 30초).
    // 10개씩 2배치면 최악 12초대이고, 실제로는 병렬이라 6초 안팎에서 끝난다.
    const results = [];
    for (let i = 0; i < targets.length; i += 10) {
      results.push(...await Promise.all(targets.slice(i, i + 10).map((a) => collect(a, process.env.SEOUL_API_KEY))));
    }

    const day = kst.toISOString().slice(0, 10);
    const used = (await kvGet(`calls:${day}`)) || 0;
    await kvSet(`calls:${day}`, used + targets.length, { ex: 172800 });
    await kvSet('meta', {
      updatedAt: new Date().toISOString(),
      failed: results.filter((r) => !r.ok),
      callsToday: used + targets.length,
    });

    return res.json({ fetched: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok) });
  }

  // 접속자 요청 — 평소에는 저장된 값만 읽는다.
  // 배포 직후나 KV가 비어 있는 상태에서는 첫 화면이 전부 회색이 되므로,
  // 서버에서 한 번만 서울시 API를 호출해 캐시를 채운다.
  let values = [], meta = null;
  try {
    [values, meta] = await Promise.all([
      Promise.all(ALL.map((a) => kvGet(`area:${a}`))),
      kvGet('meta'),
    ]);
  } catch (e) {
    if (!process.env.SEOUL_API_KEY) {
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

  // 캐시가 통째로 비었을 때만 서버가 직접 채운다(배포 직후, KV 장애 복구 직후 등).
  //
  // 이 경로는 반드시 한 번에 한 요청만 지나가야 한다. 락이 없으면 접속자
  // 50명이 각자 19곳을 부르는 950회가 되어, 하루 1,000회 예산이 한순간에
  // 사라진다 — 하필 캐시가 비어 있는 최악의 순간에.
  if (!Object.keys(areas).length && process.env.SEOUL_API_KEY) {
    const gotLock = await kvSetIfAbsent('fill:lock', 1, 60);

    if (!gotLock) {
      // 남이 채우는 중이다. 채워질 때까지 기다렸다 그 값을 쓴다.
      // 락 보유자는 HOT 4곳을 병렬로 부르므로 보통 1~2초, 느려도 5초(타임아웃)면
      // 끝난다. 그보다 짧게 기다리면 다 같이 빈손으로 돌아가 화면이 회색이 된다.
      // 매번 19곳을 확인하면 KV 명령만 늘어나니, 대표로 HOT 한 곳만 본다.
      const probe = HOT[0];
      for (let i = 0; i < 24; i++) {
        await new Promise((r) => setTimeout(r, 250));
        if (await kvGet(`area:${probe}`)) {
          const filled = await Promise.all(ALL.map((a) => kvGet(`area:${a}`)));
          ALL.forEach((a, i2) => { if (filled[i2]) areas[a] = filled[i2]; });
          meta = (await kvGet('meta')) || meta;
          break;
        }
      }
    } else {
      // 함수 제한(Hobby 10초) 안에 끝나야 한다. 19곳을 4개씩 5배치로 부르면
      // 서울시가 느릴 때 15초가 넘어 함수가 통째로 죽는다 — 그러면 락만
      // 남고 아무도 캐시를 못 채운다. 그래서 여기서는 HOT만 채운다.
      // 나머지는 5분 주기 cron이 채우고, 첫 화면에 가장 중요한 것도 HOT이다.
      const targets = HOT;
      const results = await Promise.all(
        targets.map((a) => collectBestEffort(a, process.env.SEOUL_API_KEY)));
      results.forEach((r) => { if (r.ok && r.data) areas[r.area] = r.data; });
      meta = {
        updatedAt: new Date().toISOString(),
        failed: results.filter((r) => !r.ok),
        callsToday: results.length,
        filledFromEmptyCache: true,
      };
      await kvSet('meta', meta);
    }
  }

  // ?area=<이름> 이면 그 장소의 전체(예측 포함)를 준다. 상세 화면을 열 때만 쓴다.
  const one = req.query?.area;
  if (one){
    if (!areas[one] && ALL.includes(one) && process.env.SEOUL_API_KEY) {
      const live = await collectBestEffort(one, process.env.SEOUL_API_KEY);
      if (live.ok) areas[one] = live.data;
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
