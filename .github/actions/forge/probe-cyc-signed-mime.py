import json
import os
import urllib.error
import urllib.parse
import urllib.request

REPO = 'CYC4D/repo-cassette-solve'
RUNS = (40175076646, 40175289088)
HEADERS = {
    'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'repo-cassette-cyc-mime-audit',
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


opener = urllib.request.build_opener(NoRedirect)

for run in RUNS:
    url = f'https://api.github.com/repos/{REPO}/actions/runs/{run}/artifacts?per_page=100'
    with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=20) as response:
        artifacts = json.load(response)['artifacts']
    rows = []
    for artifact in artifacts:
        asset_url = f'https://api.github.com/repos/{REPO}/actions/artifacts/{artifact["id"]}/zip'
        try:
            response = opener.open(urllib.request.Request(asset_url, headers=HEADERS), timeout=20)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            location = response.headers.get('Location', '')
            signed_type = urllib.parse.parse_qs(urllib.parse.urlsplit(location).query).get('rsct', [None])[0]
            row = {'id': artifact['id'], 'name': artifact['name'],
                   'status': response.status, 'rsct': signed_type,
                   'rsctHex': signed_type.encode('utf-8').hex() if signed_type else None}
            if location and signed_type is None:
                with urllib.request.urlopen(location, timeout=20) as raw:
                    row['blobContentType'] = raw.headers.get('Content-Type')
                    row['blobPrefixHex'] = raw.read(20).hex()
            rows.append(row)
    print('::notice title=CYC signed MIME::' + json.dumps({'run': run, 'artifacts': rows}, separators=(',', ':')), flush=True)
