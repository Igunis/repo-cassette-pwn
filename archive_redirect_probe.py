import hashlib
import http.client
import json
import os
from urllib.parse import parse_qs, urlsplit


HOST = 'api.github.com'
REPO = 'Igunis/repo-cassette-pwn'
TOKEN = os.environ['GH_TOKEN']
ACCEPT = 'application/vnd.github.v3+json'


def probe(path):
    conn = http.client.HTTPSConnection(HOST, timeout=10)
    conn.putrequest('GET', path)
    conn.putheader('User-Agent', 'https://github.com/sindresorhus/gh-got')
    conn.putheader('Accept', ACCEPT)
    conn.putheader('Authorization', f'token {TOKEN}')
    conn.endheaders()
    response = conn.getresponse()
    body = response.read()
    headers = {key.lower(): value for key, value in response.getheaders()}
    conn.close()
    location = urlsplit(headers.get('location', ''))
    return {
        'status': response.status,
        'type': headers.get('content-type'),
        'location_host': location.hostname,
        'location_path': location.path,
        'location_query_keys': list(parse_qs(location.query)),
        'body_len': len(body),
        'body_sha12': hashlib.sha256(body).hexdigest()[:12],
    }


suffixes = [
    'codex-cacheprobe',
    'codex-cacheprobe?probe=hello',
    'codex-cacheprobe%3Fprobe%3Dhello',
    'codex-cacheprobe%23fragment',
    'codex-cacheprobe%2F..%2F..%2F..%2Ffoo',
    'codex-cacheprobe%5C%5Cexample.com',
    'codex-cacheprobe%253Fprobe%253Dhello',
]
results = {}
for kind in ('tarball', 'zipball'):
    for suffix in suffixes:
        path = f'/repos/{REPO}/{kind}/{suffix}'
        results[f'{kind}/{suffix}'] = probe(path)

output = json.dumps(results, separators=(',', ':'), ensure_ascii=True)
print(output)
print(f'::notice title=Archive ref redirect::{output.replace("%", "%25")}')
