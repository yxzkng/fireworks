#!/usr/bin/env python3
"""
배포용 HTML을 생성한다.

    python3 build.py

  web/template.html + shared.css ──> web/public/index.html

정적 자산(교통통제 안내도·배너·마커)과 area-coords.json은 web/public/으로
복사해 소스와 배포본이 어긋나지 않게 한다.
"""
import pathlib, shutil

root = pathlib.Path(__file__).parent
shared = (root / 'shared.css').read_text().strip()

ASSETS = [
    root / 'assets' / 'traffic_control_2026.webp',
    root / 'assets' / 'banner_image.webp',
    root / 'assets' / 'toilet.webp',
    root / 'assets' / 'firework_marker.png',
]

html = (root / 'web' / 'template.html').read_text()
assert '/*__SHARED_CSS__*/' in html, 'web/template.html: shared.css placeholder 없음'
html = html.replace('/*__SHARED_CSS__*/', shared)
(root / 'web' / 'public' / 'index.html').write_text(html)
print(f'web/public/index.html 생성: {len(html):,} bytes')

public = root / 'web' / 'public'
for asset in ASSETS:
    shutil.copyfile(asset, public / asset.name)
    print(f'web/public/{asset.name} 복사')

shutil.copyfile(root / 'area-coords.json', public / 'area-coords.json')
print('web/public/area-coords.json 복사')
