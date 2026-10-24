import hashlib
import http.client
import json
import os
from urllib.parse import urlparse, parse_qs

HOST = 'api.github.com'
REPO = 'Igunis/repo-cassette-pwn'
TOKEN = os.environ['GH_TOKEN']
JSON_ACCEPT = 'application/vnd.github.v3+json'
BINARY_ACCEPT = 'application/octet-stream'


def request(host, path, accepts=(), auth=False):
    conn = http.client.HTTPSConnection(host, timeout=10)
    conn.putrequest('GET', path)
    conn.putheader('User-Agent', 'https://github.com/sindresorhus/gh-got')
    if auth:
        conn.putheader('Authorization', f'token {TOKEN}')
    for value in accepts:
        conn.putheader('Accept', value)
    conn.endheaders()
    response = conn.getresponse()
    body = response.read()
    headers = {name.lower(): value for name, value in response.getheaders()}
    conn.close()
    return response.status, headers, body


def compact(response):
    status, headers, body = response
    location = headers.get('location')
    parsed = urlparse(location) if location else None
    return {
        'status': status,
        'type': headers.get('content-type'),
        'cache': headers.get('cache-control'),
        'vary': headers.get('vary'),
        'location_host': parsed.hostname if parsed else None,
        'location_rsct': parse_qs(parsed.query).get('rsct', [None])[0] if parsed else None,
        'body_bytes': len(body),
        'body_sha12': hashlib.sha256(body).hexdigest()[:12],
        'body_start': body[:32].decode('utf-8', errors='replace'),
    }


def follow(response):
    location = response[1].get('location')
    if not location:
        return None
    parsed = urlparse(location)
    path = parsed.path + ('?' + parsed.query if parsed.query else '')
    return compact(request(parsed.hostname, path))


listing = request(HOST, f'/repos/{REPO}/releases?per_page=100', [JSON_ACCEPT], True)
assets = []
if listing[0] == 200:
    for release in json.loads(listing[2]):
        for asset in release.get('assets', []):
            assets.append({'id': asset['id'], 'name': asset['name'], 'type': asset.get('content_type'), 'size': asset.get('size')})
summary = {'status': listing[0], 'assets': assets[:50]}
output = json.dumps(summary, separators=(',', ':'), ensure_ascii=True)
print('assets', output)
print(f'::notice title=Release assets inventory::{output.replace("%", "%25")}')

candidates = [a for a in assets if '\x85' in (a['type'] or '')]
if not candidates:
    candidates = [a for a in assets if 'json' in (a['type'] or '')]
if not candidates and assets:
    candidates = [assets[0]]
if candidates:
    asset = candidates[0]
    path = f'/repos/{REPO}/releases/assets/{asset["id"]}?cacheprobe=dupaccept-v1'
    probes = {
        'asset': asset,
        'prime': compact(request(HOST, path, [JSON_ACCEPT, BINARY_ACCEPT], True)),
    }
    probes['fixed'] = compact(request(HOST, path, [JSON_ACCEPT], True))
    probes['anonymous'] = compact(request(HOST, path, [JSON_ACCEPT], False))
    path2 = f'/repos/{REPO}/releases/assets/{asset["id"]}?cacheprobe=binary-v1'
    control = request(HOST, path2, [BINARY_ACCEPT], True)
    probes['binary_control'] = compact(control)
    probes['binary_followed'] = follow(control)
    output = json.dumps(probes, separators=(',', ':'), ensure_ascii=True)
    print('probe', output)
    print(f'::notice title=Release duplicate Accept::{output.replace("%", "%25")}')
