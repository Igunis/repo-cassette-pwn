import json
import os
from urllib.parse import urlparse

import requests


ROOT = 'https://api.github.com'
TARGET = 'https://example.com/repo-cassette-marker'
PATHS = [
    f'/login?return_to={TARGET}',
    f'/login?redirect_to={TARGET}',
    f'/logout?return_to={TARGET}',
    f'/redirect?url={TARGET}',
    f'/redirect?redirect_uri={TARGET}',
    f'/api/redirect?url={TARGET}',
    f'/oauth/authorize?redirect_uri={TARGET}',
    f'/login/oauth/authorize?redirect_uri={TARGET}',
    f'/sessions/redirect?return_to={TARGET}',
    f'/sso?return_to={TARGET}',
    f'/?return_to={TARGET}',
    f'/repos/Igunis/repo-cassette-pwn?redirect_uri={TARGET}',
    '/zen?callback=foo',
    '/rate_limit?callback=foo',
    '/rate_limit?callback=',
    '/rate_limit?callback=%85',
]

session = requests.Session()
session.headers.update({
    'Accept': 'application/vnd.github.v3+json',
    'Authorization': f'Bearer {os.environ["GH_TOKEN"]}',
    'User-Agent': 'https://github.com/sindresorhus/gh-got',
})

rows = []
for path in PATHS:
    try:
        response = session.get(ROOT + path, allow_redirects=False, timeout=10)
        location = urlparse(response.headers.get('Location', ''))
        rows.append({
            'path': path,
            'status': response.status_code,
            'type': response.headers.get('Content-Type', ''),
            'location_host': location.hostname,
            'location_path': location.path[:80],
            'body_prefix': response.content[:24].hex(),
        })
    except requests.RequestException as error:
        rows.append({'path': path, 'error': type(error).__name__})

print('::notice title=API redirect and JSONP probe::' + json.dumps(rows, separators=(',', ':')).replace('%', '%25'))
