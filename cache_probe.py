import hashlib
import http.client
import json
import os
from pathlib import Path

HOST = 'api.github.com'
REPO = 'Igunis/repo-cassette-pwn'
BASE = f'/repos/{REPO}/contents/payload.json?ref=codex-cacheprobe&v='
TOKEN = os.environ['GH_TOKEN']
EXPECTED = Path('payload.json').read_bytes()
JSON_ACCEPT = 'application/vnd.github.v3+json'
RAW_ACCEPT = 'application/vnd.github.v3.raw'
NEL_ACCEPT = 'application/json\x85'


def get(path, accepts, auth=True):
    conn = http.client.HTTPSConnection(HOST, timeout=10)
    conn.putrequest('GET', path)
    conn.putheader('User-Agent', 'repo-cassette-probe')
    conn.putheader('Accept-Encoding', 'identity')
    if auth:
        conn.putheader('Authorization', f'Bearer {TOKEN}')
    for value in accepts:
        conn.putheader('Accept', value)
    conn.endheaders()
    response = conn.getresponse()
    body = response.read()
    headers = {name.lower(): value for name, value in response.getheaders()}
    conn.close()
    return {
        'status': response.status,
        'type': headers.get('content-type'),
        'type_hex': headers.get('content-type', '').encode('latin1').hex(),
        'media': headers.get('x-github-media-type'),
        'cache': headers.get('cache-control'),
        'vary': headers.get('vary'),
        'age': headers.get('age'),
        'etag': headers.get('etag'),
        'request_id': headers.get('x-github-request-id'),
        'remaining': headers.get('x-ratelimit-remaining'),
        'bytes': len(body),
        'expected_body': body == EXPECTED,
        'sha12': hashlib.sha256(body).hexdigest()[:12],
        'body_start': body[:28].decode('latin1'),
    }


cases = [
    ('single_raw', [RAW_ACCEPT]),
    ('dup_json_raw', [JSON_ACCEPT, RAW_ACCEPT]),
    ('dup_nel_raw', [NEL_ACCEPT, RAW_ACCEPT]),
    ('dup_raw_nel', [RAW_ACCEPT, NEL_ACCEPT]),
    ('triple_json_nel_raw', [JSON_ACCEPT, NEL_ACCEPT, RAW_ACCEPT]),
]
for label, accepts in cases:
    path = BASE + label
    records = {
        'prime': get(path, accepts),
        'fixed': get(path, [JSON_ACCEPT]),
        'anonymous': get(path, [JSON_ACCEPT], False),
    }
    output = json.dumps(records, separators=(',', ':'), ensure_ascii=True)
    print(label, output)
    print(f'::notice title=Media cache {label}::{output.replace("%", "%25")}')

sha = '789e29e5c7489cffdd63ceb8a36487eb53cd30e6'
probes = {}
for spec in ['HEAD', 'main', sha[:4], sha[:7], sha[:12], sha]:
    path = f'/repos/{REPO}/git/blobs/{spec}'
    result = get(path, [JSON_ACCEPT])
    probes[spec] = {
        'status': result['status'],
        'type': result['type'],
        'bytes': result['bytes'],
        'body_start': result['body_start'],
    }
output = json.dumps(probes, separators=(',', ':'), ensure_ascii=True)
print('blob refs', output)
print(f'::notice title=Blob refs::{output.replace("%", "%25")}')
