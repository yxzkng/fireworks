#!/usr/bin/env python3
"""
두 배포본의 HTML을 생성한다.

    python3 build.py

  template.html      ──┐
                       ├── shared.css 주입 ──> index.html            (아티팩트)
  web/template.html  ──┘                   └─> web/public/index.html (Vercel)

지도 좌표(geo.json, area-coords.json)는 크기가 있어서 아티팩트 쪽 템플릿에만
placeholder로 두고 빌드 때 끼워 넣는다. Vercel 쪽은 카카오맵을 쓰므로 필요 없다.

두 배포본은 지도 엔진과 저장소가 달라 HTML/JS는 각자 유지하고,
공통 UI(카드·레일·시트·제보 폼)의 CSS만 shared.css 한 곳에서 관리한다.
"""
import json, pathlib

root = pathlib.Path(__file__).parent
shared = (root / 'shared.css').read_text().strip()


def build(src, dst, subs=()):
    html = (root / src).read_text()
    for placeholder, value in subs:
        assert placeholder in html, f'{src}: {placeholder} 없음'
        html = html.replace(placeholder, value)
    assert '/*__SHARED_CSS__*/' in html, f'{src}: shared.css placeholder 없음'
    html = html.replace('/*__SHARED_CSS__*/', shared)
    (root / dst).write_text(html)
    print(f'{dst} 생성: {len(html):,} bytes')


def compact(path):
    return json.dumps(json.load(open(root / path)),
                      ensure_ascii=False, separators=(',', ':'))


# 아티팩트판 — 자체 캔버스 지도라 좌표 데이터를 심는다
build('template.html', 'index.html', subs=[
    ('/*__GEO__*/null', compact('geo.json')),
    ('/*__COORDS__*/null', compact('area-coords.json')),
])

# Vercel판 — 카카오맵이 좌표를 알아서 다룬다
build('web/template.html', 'web/public/index.html')
