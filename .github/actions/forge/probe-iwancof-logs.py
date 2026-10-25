import json
import os
import urllib.error
import urllib.parse
import urllib.request

REPO = 'Iwancof/hitcon2026-cassette-20261024-153445'
RUN_ID = 40107805236
JOB_ID = 120913034877


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


opener = urllib.request.build_opener(NoRedirect)
for label, path in [
    ('job', f'/actions/jobs/{JOB_ID}/logs'),
    ('run', f'/actions/runs/{RUN_ID}/logs'),
]:
    api = 'https://api.github.com/repos/' + REPO + path
    request = urllib.request.Request(api, headers={
        'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'repo-cassette-iwancof-audit',
    })
    try:
        response = opener.open(request, timeout=20)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        row = {'kind': label, 'apiStatus': response.status}
        location = response.headers.get('Location')
        if location:
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(location).query)
            row['signedRsct'] = query.get('rsct', [None])[0]
            row['signedHost'] = urllib.parse.urlsplit(location).hostname
            with urllib.request.urlopen(location, timeout=20) as download:
                raw = download.read(1_000_001)
                row.update(
                    downloadStatus=download.status,
                    contentType=download.headers.get('Content-Type'),
                    contentTypeHex=download.headers.get('Content-Type', '').encode('latin1').hex(),
                    contentEncoding=download.headers.get('Content-Encoding'),
                    bytesRead=len(raw),
                    prefixHex=raw[:24].hex(),
                    gzipMagic=raw.startswith(b'\x1f\x8b'),
                )
        else:
            row['bodyPrefix'] = response.read(160).decode(errors='replace')
    print('::notice title=Iwancof log carrier::' +
          json.dumps(row, separators=(',', ':')), flush=True)
