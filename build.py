#!/usr/bin/env python3
"""
index.html 생성 — 지도 좌표 데이터를 페이지에 심는다.

geo.json(한강·여의도·다리 윤곽)과 좌표 목록은 크기가 있어서
템플릿에 placeholder로 두고 빌드 때 끼워 넣는다.

    python3 build.py
"""
import json, pathlib

root = pathlib.Path(__file__).parent
geo = json.load(open(root / 'geo.json'))
coords = json.load(open(root / 'area-coords.json'))

tpl = (root / 'template.html').read_text()
out = (tpl
       .replace('/*__GEO__*/null', json.dumps(geo, ensure_ascii=False, separators=(',', ':')))
       .replace('/*__COORDS__*/null', json.dumps(coords, ensure_ascii=False, separators=(',', ':'))))
(root / 'index.html').write_text(out)
print(f'index.html 생성: {len(out):,} bytes')
