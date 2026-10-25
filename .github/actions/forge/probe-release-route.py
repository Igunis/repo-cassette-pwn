import json
import os
import urllib.error
import urllib.parse
import urllib.request

TOKEN = os.environ['GH_TOKEN']
ROOT = 'https://api.github.com/repos/actions/runner'


def request(url, accept, method='GET'):
    req = urllib.request.Request(url, method=method, headers={
        'Authorization': f'Bearer {TOKEN}',
        'Accept': accept,
        'User-Agent': 'repo-cassette-release-probe',
    })
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args):
            return None
    opener = urllib.request.build_opener(NoRedirect)
    try:
        return opener.open(req, timeout=20)
    except urllib.error.HTTPError as error:
        return error


with request(ROOT + '/releases/latest', 'application/vnd.github.v3+json') as response:
    latest = json.load(response)
asset = next((a for a in latest.get('assets', []) if a.get('size', 0) > 0), None)
if not asset:
    raise RuntimeError('No release asset found')
print(f'::notice title=release asset chosen::{json.dumps({"id":asset["id"],"type":asset["content_type"],"size":asset["size"]})}')

suffixes = ['', '?download=1', '?download=true', '?raw=1', '?raw=true',
            '?accept=application%2Foctet-stream', '?media_type=application%2Foctet-stream',
            '?content_type=application%2Foctet-stream', '?format=raw', '/raw', '/download']
for accept in ('application/vnd.github.v3+json', 'application/octet-stream'):
    for suffix in suffixes:
        url = ROOT + f'/releases/assets/{asset["id"]}' + suffix
        with request(url, accept) as response:
            row = {'suffix': suffix, 'accept': accept, 'status': response.status,
                   'type': response.headers.get('Content-Type'),
                   'redirect': bool(response.headers.get('Location'))}
            if response.status == 302:
                row['host'] = urllib.parse.urlparse(response.headers['Location']).hostname
            elif response.status != 200:
                row['message'] = response.read(150).decode(errors='replace')
            print(f'::notice title=release route::{json.dumps(row, separators=(",", ":"))}', flush=True)
