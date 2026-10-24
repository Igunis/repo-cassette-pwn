import hashlib
import http.client
import json
import os
from urllib.parse import urlsplit


TOKEN = os.environ['GH_TOKEN']
UUID = '1b198410-a9ee-4fc7-9bac-1f3bf86ad6b8'
PATHS = [
    f'/user-attachments/assets/{UUID}',
    f'/repos/Igunis/repo-cassette-pwn/user-attachments/assets/{UUID}',
    f'/repos/Igunis/repo-cassette-pwn/issues/1/attachments/{UUID}',
]


def probe(path):
    conn = http.client.HTTPSConnection('api.github.com', timeout=10)
    conn.putrequest('GET', path)
    conn.putheader('User-Agent', 'https://github.com/sindresorhus/gh-got')
    conn.putheader('Accept', 'application/vnd.github.v3+json')
    conn.putheader('Authorization', f'token {TOKEN}')
    conn.endheaders()
    response = conn.getresponse()
    body = response.read()
    headers = {key.lower(): value for key, value in response.getheaders()}
    conn.close()
    return {
        'status': response.status,
        'type': headers.get('content-type'),
        'location_host': urlsplit(headers.get('location', '')).hostname,
        'body_len': len(body),
        'body_sha12': hashlib.sha256(body).hexdigest()[:12],
        'body_prefix': body[:100].decode(errors='replace'),
    }


results = {path: probe(path) for path in PATHS}
output = json.dumps(results, separators=(',', ':'), ensure_ascii=True)
print(output)
print(f'::notice title=Attachment API route::{output.replace("%", "%25")}')
