import io
import json
import os
import urllib.error
import urllib.parse
import urllib.request
import zipfile

HEADERS = {
    'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'repo-cassette-blob-preempt-audit',
}


def fetch(url, *, stop_redirect=False):
    if stop_redirect:
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args):
                return None
        opener = urllib.request.build_opener(NoRedirect)
    else:
        opener = urllib.request.build_opener()
    request = urllib.request.Request(url, headers=HEADERS)
    try:
        return opener.open(request, timeout=30)
    except urllib.error.HTTPError as error:
        return error


repo = 'slslslslsk/repo-cassette-wire-fuzz-170747'
for run_id in [40176035217, 40176029960, 40176028769, 40176027489]:
    row = {'repository': repo, 'run': run_id}
    try:
        with fetch(f'https://api.github.com/repos/{repo}/actions/runs/{run_id}/logs') as response:
            data = response.read(25_000_001)
        summaries = []
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for path in archive.namelist():
                if not path.endswith('.txt'):
                    continue
                for line in archive.read(path).decode('utf-8', errors='replace').splitlines():
                    if 'BLOBMAPSUMMARY ' in line:
                        payload = line.split('BLOBMAPSUMMARY ', 1)[1]
                        try:
                            summary = json.loads(payload)
                            summaries.append({k: summary.get(k) for k in ('total', 'accepted', 'mappingCount')})
                            summaries[-1]['winners'] = summary.get('winners', [])[:2]
                            summaries[-1]['mappings'] = summary.get('mappings', [])[:3]
                        except json.JSONDecodeError:
                            summaries.append({'parseError': payload[:150]})
        row['summaries'] = summaries[:2]
    except Exception as error:
        row['error'] = f'{type(error).__name__}: {str(error)[:150]}'
    print('::notice title=Blob MIME byte map::' + json.dumps(row, separators=(',', ':')), flush=True)


repo = 'l8BL/repo-cassette-carrier-lab'
for run_id in [40176037526, 40175848459]:
    row = {'repository': repo, 'run': run_id}
    try:
        with fetch(f'https://api.github.com/repos/{repo}/actions/runs/{run_id}/jobs?per_page=100') as response:
            jobs = json.load(response)['jobs']
        row['jobs'] = []
        for job in jobs:
            url = f'https://api.github.com/repos/{repo}/actions/jobs/{job["id"]}/logs'
            with fetch(url, stop_redirect=True) as response:
                location = response.headers.get('Location', '')
                signed_type = urllib.parse.parse_qs(urllib.parse.urlsplit(location).query).get('rsct', [None])[0]
                result = {'id': job['id'], 'apiStatus': response.status, 'rsct': signed_type}
            if location:
                with urllib.request.urlopen(location, timeout=25) as response:
                    result.update(finalStatus=response.status,
                                  contentType=response.headers.get('Content-Type'),
                                  contentEncoding=response.headers.get('Content-Encoding'),
                                  prefixHex=response.read(24).hex())
            row['jobs'].append(result)
    except Exception as error:
        row['error'] = f'{type(error).__name__}: {str(error)[:150]}'
    print('::notice title=Preempted job log REST::' + json.dumps(row, separators=(',', ':')), flush=True)
