import io
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
import zipfile

REPOS = [
    'l8BL/repo-cassette-carrier-lab',
    'CYC4D/repo-cassette-solve',
    'slslslslsk/repo-cassette-wire-fuzz-170747',
    'slslslslsk/repo-cassette-xf-d914c3c1',
    'EthanYangTW/repo-cassette-ctf-temp-20261024',
]
SELECT = re.compile(r'BLOBMAPSUMMARY|CARRIER_(?:FINAL_TYPE|PREEMPT_STATUS|COPY_STATUS)|PENDING_(?:LIST|GET)|LEGACY_(?:REST|ROUTE)|WINNER\s*\{|No stress race winner|QUERY\s*\{')
HEADERS = {
    'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'repo-cassette-fresh-carrier-audit',
}


def request(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=25)


for repository in REPOS:
    row = {'repository': repository, 'runs': []}
    try:
        with request(f'https://api.github.com/repos/{repository}/actions/runs?per_page=4') as response:
            runs = json.load(response)['workflow_runs']
        for run in runs:
            item = {'id': run['id'], 'sha': run['head_sha'][:8],
                    'status': run['status'], 'conclusion': run['conclusion']}
            if run['status'] == 'completed':
                try:
                    with request(f'https://api.github.com/repos/{repository}/actions/runs/{run["id"]}/logs') as response:
                        archive_bytes = response.read(12_000_001)
                    selected = []
                    with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
                        for name in archive.namelist():
                            if not name.endswith('.txt'):
                                continue
                            for line in archive.read(name).decode('utf-8', errors='replace').splitlines():
                                if SELECT.search(line):
                                    selected.append(line[-1100:])
                    item['selected'] = selected[:6]
                except Exception as error:
                    item['logError'] = f'{type(error).__name__}: {str(error)[:100]}'
            row['runs'].append(item)
    except Exception as error:
        row['error'] = f'{type(error).__name__}: {str(error)[:140]}'
    print('::notice title=Fresh carrier audit::' + json.dumps(row, separators=(',', ':')), flush=True)


repository = 'l8BL/repo-cassette-carrier-lab'
job_id = 121115798808
path = f'/actions/jobs/{job_id}/steps/3/logs'
url = f'https://api.github.com/repos/{repository}{path}'
try:
    with request(url) as response:
        report = {'status': response.status, 'type': response.headers.get('Content-Type'),
                  'prefix': response.read(32).hex()}
except urllib.error.HTTPError as error:
    report = {'status': error.code, 'type': error.headers.get('Content-Type')}
print('::notice title=Step log REST route::' + json.dumps(report, separators=(',', ':')), flush=True)
