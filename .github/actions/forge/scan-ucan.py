import io
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
import zipfile

REPOSITORY = 'ucan-ca/repo-cassette-ctf-a6fe41a973'
TOKEN = os.environ['GH_TOKEN']
BASE = f'https://api.github.com/repos/{REPOSITORY}'


def get(path, *, no_redirect=False):
    request = urllib.request.Request(BASE + path, headers={
        'Authorization': f'Bearer {TOKEN}',
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'repo-cassette-ucan-audit',
    })
    if no_redirect:
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args):
                return None
        opener = urllib.request.build_opener(NoRedirect)
        try:
            return opener.open(request, timeout=25)
        except urllib.error.HTTPError as error:
            return error
    return urllib.request.urlopen(request, timeout=25)


with get('/actions/runs?per_page=100') as response:
    runs = json.load(response)['workflow_runs']

for run in runs:
    row = {'run': run['id'], 'sha': run['head_sha'][:8], 'status': run['conclusion']}
    try:
        with get(f"/actions/runs/{run['id']}/logs") as response:
            data = response.read(10_000_001)
        lines = []
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for name in archive.namelist():
                if not name.endswith('.txt'):
                    continue
                for raw_line in archive.read(name).splitlines():
                    line = raw_line.decode('utf-8', errors='replace')
                    if re.search(r'legacy_create_status|create_http|create_error|after_create|after_upload|after_finalize|artifact_id|github_artifact_verified|blob_content_type|rsct|actual_ct|HTTP 4|HTTP 2|ERROR|error:', line, re.I):
                        lines.append(line[-360:])
        row['log'] = lines[:55]
    except Exception as error:
        row['log_error'] = f'{type(error).__name__}: {str(error)[:120]}'
    try:
        with get(f"/actions/runs/{run['id']}/artifacts?per_page=100") as response:
            artifacts = json.load(response).get('artifacts', [])
        row['artifact_count'] = len(artifacts)
        types = {}
        unusual = []
        for artifact in artifacts:
            response = get(f"/actions/artifacts/{artifact['id']}/zip", no_redirect=True)
            location = response.headers.get('Location', '')
            rsct = urllib.parse.parse_qs(urllib.parse.urlsplit(location).query).get('rsct', [''])[0]
            key = rsct or str(response.status)
            types[key] = types.get(key, 0) + 1
            if key not in ('application/json', 'application/zip'):
                unusual.append({'id': artifact['id'], 'type': key})
        row['types'] = types
        if unusual:
            row['unusual'] = unusual[:10]
    except Exception as error:
        row['artifact_error'] = f'{type(error).__name__}: {str(error)[:120]}'
    print('::notice title=ucan repo audit::' + json.dumps(row, separators=(',', ':')), flush=True)
