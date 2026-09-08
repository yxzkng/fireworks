# 여의도 불꽃 지도 — 웹 애플리케이션

Vercel에 배포되는 실제 서비스 코드입니다. 프로젝트 개요와 동시 접속 대응 내역은
[루트 README](../README.md), 부하 분석 상세는 [`docs/scaling-plan.md`](../docs/scaling-plan.md)를 참고하세요.

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
차단됩니다. 그래서 브라우저가 아닌 서버 함수(`api/congestion.js`)에서 호출하며, 인증키도
클라이언트에 노출되지 않습니다.
