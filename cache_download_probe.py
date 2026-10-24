import json
import os
import time
from urllib.parse import urlparse

import requests


repo = os.environ['GITHUB_REPOSITORY']
key = os.environ['CACHE_KEY']
base = f'https://api.github.com/repos/{repo}/actions/caches'
session = requests.Session()
session.headers.update({
    'Accept': 'application/vnd.github.v3+json',
    'Authorization': f'Bearer {os.environ["GH_TOKEN"]}',
    'User-Agent': 'https://github.com/sindresorhus/gh-got',
})

listed = None
for attempt in range(5):
    response = session.get(base, params={'key': key}, timeout=10)
    if response.ok:
        matches = [item for item in response.json().get('actions_caches', []) if item.get('key') == key]
        if matches:
            listed = matches[0]
            break
    time.sleep(2)

if not listed:
    print('::notice title=Cache download API::' + json.dumps({
        'list_status': response.status_code,
        'cache_found': False,
        'body_prefix': response.text[:120],
    }).replace('%', '%25'))
    raise SystemExit(0)

cache_id = listed['id']
paths = [
    f'{base}/{cache_id}',
    f'{base}/{cache_id}/download',
    f'{base}/{cache_id}/archive',
    f'{base}/{cache_id}/content',
    f'{base}/{cache_id}/zip',
    f'{base}/{cache_id}?download=1',
    f'{base}/{cache_id}?raw=1',
]
rows = []
for url in paths:
    try:
        response = session.get(url, allow_redirects=False, timeout=10)
        location = urlparse(response.headers.get('Location', ''))
        rows.append({
            'suffix': url.split(f'/{cache_id}', 1)[-1],
            'status': response.status_code,
            'type': response.headers.get('Content-Type', ''),
            'location_host': location.hostname,
            'location_keys': sorted(set(location.query.split('&')[i].split('=', 1)[0] for i in range(len(location.query.split('&'))))) if location.query else [],
            'bytes': len(response.content),
            'body_prefix': response.content[:8].hex(),
        })
    except requests.RequestException as error:
        rows.append({'url': url, 'error': type(error).__name__})

report = {'cache_id': cache_id, 'size': listed.get('size_in_bytes'), 'rows': rows}
print('::notice title=Cache download API::' + json.dumps(report, separators=(',', ':')).replace('%', '%25'))
