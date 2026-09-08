# 여의도 불꽃 지도 — Vercel 배포판

실제 서비스로 운영되는 배포본입니다. 프로젝트 전체 개요와 동시 접속 대응 내역은
[루트 README](../README.md), 부하 분석 상세는 [`docs/scaling-plan.md`](../docs/scaling-plan.md)를 참고하세요.

Claude Artifact 배포판(`../index.html`)과 UI 스타일(`../shared.css`)을 공유하지만,
지도 엔진과 저장소가 다릅니다.

| | Artifact 버전 | Vercel 버전 |
|---|---|---|
| 지도 | 한강·여의도 윤곽을 좌표로 직접 렌더링 | 카카오맵 JS SDK |
| 저장소 | Artifact 내장 DB | Supabase (Postgres + Storage) |
| 사진 | 256KB 제한 (1024px) | 1280px 원본 + 240px 썸네일 |

Artifact는 주소가 매번 바뀌는 UUID라 카카오맵 도메인 등록이 불가능합니다.
고정 도메인이 필요해서 Vercel 배포판을 따로 두었습니다.

## 파일

| 파일 | 설명 |
|---|---|
| `template.html` | 사이트 원본 — **수정은 여기서** |
| `public/index.html` | `python3 ../build.py` 산출물 — 직접 고치지 않음 |
| `public/area-coords.json` | 관람 장소 좌표 + 발사지점 거리 |
| `api/congestion.js` | 서울시 혼잡도 수집·캐싱 (KV 락 + TTL, 접속자 요청 트리거) |
| `api/subway.js` | 지하철 실시간 도착정보 (single-flight 캐싱) |
| `api/admin.js` | 관리자 인증 후 제보 조회/삭제 (`service_role` 키는 서버 전용) |
| `api/config.js` | 공개 키를 클라이언트에 전달 |
| `schema.sql` | 테이블 · RLS 정책 · 신고 함수 · 속도 제한 트리거 |
| `vercel.json` | 함수별 `maxDuration` 설정 (Hobby 플랜 실행 상한을 명시해, 플랫폼 기본값이 바뀌어도 동작이 같도록) |

## 환경 변수

값은 Vercel 대시보드에서 관리합니다. 형식은 [`.env.example`](.env.example) 참고.

| 이름 | 노출 |
|---|---|
| `SEOUL_API_KEY` | 서버 전용 |
| `SEOUL_SUBWAY_KEY` | 서버 전용 (일반 인증키와 별도 발급) |
| `SUPABASE_SERVICE_ROLE_KEY` | 서버 전용 |
| `ADMIN_PASSWORD` | 서버 전용 |
| `NEXT_PUBLIC_KAKAO_KEY` | 공개 |
| `NEXT_PUBLIC_SUPABASE_URL` | 공개 |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 공개 |

서울시 실시간 도시데이터 API는 **HTTP 전용**이라 HTTPS 사이트에서 직접 호출하면 mixed content로
차단됩니다. 그래서 서버 함수(또는 `../proxy`의 Cloudflare Worker)를 거치고, 인증키는 클라이언트에
노출되지 않습니다.
