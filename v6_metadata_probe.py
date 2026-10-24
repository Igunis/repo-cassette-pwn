import json
import os
from urllib.parse import urlparse, parse_qs

import requests


base = 'https://api.github.com/repos/Igunis/repo-cassette-pwn/actions/artifacts/12569682558'
cases = [
    ('metadata', base),
    ('download', base + '?download=1'),
    ('raw', base + '?raw=true'),
    ('archive_format', base + '?archive_format=zip'),
    ('format', base + '?format=raw'),
    ('redirect', base + '?redirect=1'),
    ('signed', base + '?include_signed_url=1'),
    ('media_type', base + '?media_type=raw'),
    ('alt', base + '?alt=media'),
    ('response_type', base + '?response_type=raw'),
    ('suffix_download', base + '/download'),
    ('suffix_raw', base + '/raw'),
    ('suffix_content', base + '/content'),
    ('suffix_blob', base + '/blob'),
    ('suffix_file', base + '/file'),
    ('suffix_archive', base + '/archive'),
    ('zip_control', base + '/zip'),
]

session = requests.Session()
session.headers.update({
    'Accept': 'application/vnd.github.v3+json',
    'Authorization': f'Bearer {os.environ["GH_TOKEN"]}',
    'User-Agent': 'https://github.com/sindresorhus/gh-got',
})
rows = []
for label, url in cases:
    try:
        response = session.get(url, allow_redirects=False, timeout=10)
        location = urlparse(response.headers.get('Location', ''))
        query = parse_qs(location.query)
        rows.append({
            'label': label,
            'status': response.status_code,
            'type': response.headers.get('Content-Type', ''),
            'location_host': location.hostname,
            'location_keys': sorted(query),
            'rsct': query.get('rsct', [None])[0],
            'body_bytes': len(response.content),
        })
    except requests.RequestException as error:
        rows.append({'label': label, 'error': type(error).__name__})

print('::notice title=V6 artifact metadata routes::' + json.dumps(rows, separators=(',', ':')).replace('%', '%25'))
