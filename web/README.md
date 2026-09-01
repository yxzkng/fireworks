# 여의도 불꽃 지도 — Vercel 버전

카카오맵을 쓰는 웹 배포 버전입니다. 아티팩트 버전(`../index.html`)은 그대로 유지되니
이쪽 배포가 늦어져도 축제 당일 쓸 것은 확보돼 있습니다.

## 왜 Vercel인가

아티팩트는 주소가 매번 바뀌는 UUID라 **카카오맵 도메인 등록이 불가능**합니다.
고정 도메인이 생기면 카카오맵을 정상적으로 등록해 쓸 수 있습니다.

| | 아티팩트 버전 | Vercel 버전 |
|---|---|---|
| 지도 | 직접 그린 한강·여의도 윤곽 | **카카오맵** |
| 저장소 | `claude.use('db')` | **Supabase** |
| 사진 | 256KB 제한 (1024px 압축) | **제한 없음** (1600px) |
| 배포 | 즉시 | 설정 필요 |

---

## 배포 절차

### 1. Supabase (제보·사진 저장소)

1. https://supabase.com 가입 → 새 프로젝트
2. **SQL Editor**에 [`schema.sql`](schema.sql) 붙여넣고 실행
3. **Storage** → 새 버킷 `photos` 생성 → **Public** 체크
4. **Settings → API**에서 `Project URL`과 `anon public` 키 복사

### 2. 카카오맵 키

1. https://developers.kakao.com → 애플리케이션 추가
2. **앱 키 → JavaScript 키** 복사
3. **플랫폼 → Web → 사이트 도메인**에 배포 주소 등록
   (Vercel 배포 후 나오는 `https://xxx.vercel.app`)

> 도메인 등록을 빠뜨리면 지도만 안 뜹니다. 카드 목록은 정상 동작합니다.

### 3. 서울시 인증키

https://data.seoul.go.kr 가입 → **Open API → 인증키 신청** (즉시 발급)

> ⚠️ 이 키는 서버에서만 씁니다. 절대 공유하지 마세요.

### 4. Vercel 배포

```bash
cd web
npx vercel            # 첫 배포 (프로젝트 생성)
```

Vercel 대시보드 → **Storage → KV** 생성 후 프로젝트에 연결합니다.

**Settings → Environment Variables**에 등록:

| 이름 | 값 | 노출 |
|---|---|---|
| `SEOUL_API_KEY` | 서울시 인증키 | 서버 전용 |
| `CRON_SECRET` | 아무 긴 문자열 | 서버 전용 |
| `NEXT_PUBLIC_KAKAO_KEY` | 카카오 JavaScript 키 | 공개 |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project URL | 공개 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon 키 | 공개 |

```bash
npx vercel --prod     # 환경변수 반영해 재배포
```

### 5. 첫 데이터 채우기

Cron은 5분 뒤부터 도니 처음 한 번은 직접 채웁니다.

```bash
curl -H "Authorization: Bearer <CRON_SECRET>" \
  "https://<주소>.vercel.app/api/congestion?cron=1&all=1"

curl "https://<주소>.vercel.app/api/congestion" | head -c 300
```

---

## API 호출 예산 — 하루 988 / 1,000회

서울시 인증키는 **하루 1,000회** 제한입니다. 거리별로 갱신 주기를 나눠 맞췄습니다.

| 등급 | 장소 | 축제 시간대(12~24시) | 그 외 |
|---|---|---|---|
| HOT | 여의도, 여의도한강공원, 여의서로, 노들섬 | **5분** | 60분 / 심야 4시간 |
| WARM | 이촌·반포·양화·망원한강공원, 노량진, 용산역, 영등포, 합정역 | 20분 | 2시간 |
| COLD | 서울역, 홍대, 신촌·이대역, 고속터미널, 잠실·뚝섬한강공원, 강남역 | 60분 | — |

주기를 바꾸면 `api/congestion.js`의 `tiersToFetch()`를 고치고,
`../proxy/check-budget.mjs`로 한도를 확인하세요.

> **한도 늘리기**: 열린데이터광장 **활용사례(갤러리)**에 등록하면 제한이 풀립니다.

---

## 설계 메모

**지도 다크 처리** — 카카오맵에 공식 다크 타입이 없습니다. CSS `invert` 필터로 반전시키는
방법이 흔하지만 **지도 이미지 변형은 약관 위반 소지**가 있어(실제 API 차단 사례 존재)
쓰지 않았습니다. 대신 어두운 반투명 막을 위에 덮어 원본은 그대로 두고 화면만 가라앉힙니다.

**마커** — 원 크기가 인원(제곱근이라 면적이 인원에 비례), 색이 혼잡도입니다.
겹치면 카카오 클러스터러가 묶고, 확대하면 풀립니다.

**정렬** — '붐비는 순'은 관람 가능한 곳을 먼저 놓습니다. 안 그러면 늘 붐비는 강남역이
1위가 되어 자리 찾는 사람에게 쓸모없는 순서가 됩니다.

**사진** — Supabase Storage에 올리므로 아티팩트의 256KB 제한이 없습니다.
1600px·q0.82로만 줄여 현장 업로드 속도를 확보합니다.

**신고** — `update` 정책을 열면 남의 제보 내용을 고칠 수 있어, `report_flag()` 함수로만
`flags`를 올립니다. 3건이면 자동으로 가려집니다.

**단계적 축소** — 키가 하나씩 없어도 나머지는 동작합니다.
카카오 키 없음 → 지도만 안내 문구, 카드는 정상. Supabase 없음 → 제보만 비활성.
혼잡도 API 실패 → 카드는 '정보 없음'으로 표시되고 제보는 정상. (모두 테스트로 확인)

---

## 파일

| 파일 | 설명 |
|---|---|
| `public/index.html` | 사이트 본체 |
| `public/area-coords.json` | 장소 19곳 좌표 + 발사지점 거리 |
| `api/congestion.js` | 서울시 혼잡도 수집(Cron) + 배포 |
| `api/config.js` | 공개 키를 브라우저에 전달 |
| `schema.sql` | Supabase 테이블·정책·신고 함수 |
| `vercel.json` | Cron 5분 주기 설정 |
