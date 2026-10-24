import http.client
import json
import os

HOST = 'api.github.com'
REPO = 'Igunis/repo-cassette-pwn'
REF = 'codex-cacheprobe'
TOKEN = os.environ['GH_TOKEN']


def get(path, accept='application/vnd.github.v3+json'):
    conn = http.client.HTTPSConnection(HOST, timeout=10)
    conn.putrequest('GET', path)
    conn.putheader('User-Agent', 'https://github.com/sindresorhus/gh-got')
    conn.putheader('Accept', accept)
    conn.putheader('Authorization', f'token {TOKEN}')
    conn.endheaders()
    response = conn.getresponse()
    body = response.read()
    headers = {name.lower(): value for name, value in response.getheaders()}
    conn.close()
    return {
        'status': response.status,
        'type': headers.get('content-type'),
        'location': headers.get('location'),
        'bytes': len(body),
        'prefix': body[:80].decode('utf-8', errors='replace'),
    }


results = {}
for name in ['payload.json', 'payload-link', 'external-link', 'README.md']:
    path = f'/repos/{REPO}/contents/{name}?ref={REF}'
    results[name] = get(path)
results['readme'] = get(f'/repos/{REPO}/readme?ref={REF}')
results['readme_raw'] = get(f'/repos/{REPO}/readme?ref={REF}', 'application/vnd.github.v3.raw')
output = json.dumps(results, separators=(',', ':'), ensure_ascii=True)
print(output)
print(f'::notice title=Contents symlink readme::{output.replace("%", "%25")}')
