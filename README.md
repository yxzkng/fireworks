  # 여의도 불꽃 지도

2026 서울세계불꽃축제(9/5 토, 20:00~21:10) 관람 명당별 실시간 혼잡도 + 현장 사진 제보.

**사이트**: https://claude.ai/code/artifact/2bf93fbc-4f20-4e3d-a6b3-ab33f2956aee

지금 상태로도 **제보 기능은 바로 동작**합니다. 아래는 공공데이터(서울시 혼잡도·예측)를
추가로 켜는 절차입니다. 안 해도 사이트는 정상 작동합니다.

---

## 왜 프록시가 필요한가

서울시 실시간 도시데이터 API는 **HTTP 전용**입니다. 사이트는 HTTPS라서
브라우저가 mixed content로 차단합니다. 공공데이터포털에도 HTTPS 대체 경로가 없고
(LINK 타입 등록), 무료 공개 CORS 프록시는 장애가 확인됐습니다.
→ Cloudflare Worker를 직접 띄우는 것이 유일하게 안정적입니다. 무료입니다.

## 1. 서울시 인증키 발급 (2분)

1. https://data.seoul.go.kr 회원가입
2. 상단 **Open API** → **인증키 신청**
3. 신청 즉시 발급 (심사 없음)

## 2. 장소명 확인 (1분)

API가 실제로 지원하는 장소명인지 확인합니다. 샘플키로는 검증할 수 없어서
(무엇을 넣어도 광화문만 반환) 발급받은 키가 필요합니다.

```bash
cd proxy
./verify-areas.sh 발급받은키
```

`OK`와 함께 **서로 다른 AREA_CD**가 나오면 유효한 이름입니다.
실패한 이름은 `worker.js`의 `ALLOWED`와 `index.html`의 `PLACES`에서
해당 항목의 `area`를 `null`로 바꾸면 제보 전용 장소가 됩니다.

## 3. Worker 배포 (5분)

```bash
cd proxy
npx wrangler login
npx wrangler secret put SEOUL_API_KEY    # 발급받은 키 붙여넣기
npx wrangler deploy
```

배포되면 `https://fireworks-congestion.<계정>.workers.dev` 주소가 출력됩니다.

동작 확인:
```bash
curl "https://fireworks-congestion.<계정>.workers.dev/?area=여의도한강공원"
```

## 4. 사이트에 연결

`index.html` 상단의 상수에 위 주소를 넣습니다.

```js
const WORKER_URL = 'https://fireworks-congestion.<계정>.workers.dev';
```

저장한 뒤 Claude Code에서 "재배포해줘"라고 하면 같은 링크에 반영됩니다.

---

## 구조

```
[사이트] ──HTTPS──> [Cloudflare Worker] ──HTTP──> [서울시 API]
    │                 인증키는 여기 보관 (클라이언트 노출 없음)
    │                 응답 171KB → 1.3KB로 축소, 60초 캐시
    └── claude.use('db') ──> 제보·사진 (모든 접속자 실시간 공유)
```

## 설계 메모

- **공공데이터와 제보를 평균내지 않고 따로 표시**합니다. 기지국 추정은 광역 흐름에,
  현장 제보는 "돗자리 깔 자리 있나" 같은 미시 정보에 강해서 섞으면 둘 다 흐려집니다.
- **제보는 최근 30분만 집계**하고 최신일수록 가중치를 높입니다. 현장은 빠르게 변합니다.
- **유입/유출 방향** — 지하철 30분내 승하차를 비교해 "몰려드는 중 / 빠져나가는 중"을
  표시합니다. 혼잡도 숫자만으로는 안 보이는 정보이고, 종료 후 귀가 러시 판단에 쓰입니다.
- **사진은 1024px·q0.7로 자동 압축** (저장소 문서 한도 256KiB, base64는 +33%).
  테스트에서 1.4MB 사진이 138KB로 줄었습니다. 초과 시 단계적으로 더 줄입니다.
- **GPS를 수집하지 않습니다.** 위치는 목록에서 고른 장소만 저장됩니다.
- 신고 3건이면 자동으로 가려집니다.
- Worker가 죽어도 제보 기능은 정상 동작합니다 (테스트로 확인).

## 파일

| 파일 | 설명 |
|---|---|
| `index.html` | 사이트 본체 (Artifact로 배포됨) |
| `proxy/worker.js` | HTTPS 프록시 |
| `proxy/wrangler.toml` | Worker 설정 |
| `proxy/verify-areas.sh` | 장소명 검증 스크립트 |
