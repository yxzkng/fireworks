#!/bin/bash
# 서울시 API가 실제로 지원하는 장소명인지 확인한다.
# 샘플키로는 무엇을 넣어도 광화문만 돌아오므로 발급받은 실제 키가 필요하다.
#
#   ./verify-areas.sh <인증키>
#
# AREA_CD가 서로 다르게 나오면 유효한 이름이다.
#
# 주의: 서울시는 '등록되지 않은 장소명'에도 ERROR-500("서버 오류입니다")를
# 반환한다. 실제 서버 장애가 아니라 그런 이름이 없다는 뜻이므로,
# 다른 이름이 정상 응답하는데 특정 이름만 ERROR-500이면 이름 문제다.
#
# 전체 121개 장소 목록은 아래에서 볼 수 있다:
#   https://data.seoul.go.kr/SeoulRtd/

KEY="$1"
[ -z "$KEY" ] && { echo "사용법: ./verify-areas.sh <인증키>"; exit 1; }

for a in 여의도 여의도한강공원 여의서로 노들섬 \
         이촌한강공원 반포한강공원 양화한강공원 노량진 \
         용산역 "영등포 타임스퀘어" 합정역 망원한강공원 \
         서울역 "홍대 관광특구" "신촌·이대역" 고속터미널역 \
         잠실한강공원 뚝섬한강공원 강남역; do
  printf '%-16s ' "$a"
  enc=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$a")
  curl -s -m 15 "http://openapi.seoul.go.kr:8088/$KEY/json/citydata/1/5/$enc" \
  | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    c=d.get('CITYDATA')
    if c:
        l=c['LIVE_PPLTN_STTS'][0]
        print('OK  %-8s %-6s %s~%s' % (c['AREA_CD'], l['AREA_CONGEST_LVL'], l['AREA_PPLTN_MIN'], l['AREA_PPLTN_MAX']))
    else:
        print('--  ', (d.get('RESULT') or {}).get('RESULT.MESSAGE', str(d)[:60]))
except Exception as e:
    print('err', e)
"
done
