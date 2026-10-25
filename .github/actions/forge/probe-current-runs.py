import io
import json
import os
import urllib.request
import zipfile

RUNS = [
    ('slslslslsk/repo-cassette-wire-fuzz-170747', 40176181882),
    ('CYC4D/repo-cassette-solve', 40176141937),
    ('EthanYangTW/repo-cassette-ctf-temp-20261024', 40176435865),
]
HEADERS = {
    'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'repo-cassette-current-run-audit',
}


for repository, run in RUNS:
    row = {'repository': repository, 'run': run}
    try:
        url = f'https://api.github.com/repos/{repository}/actions/runs/{run}/logs'
        request = urllib.request.Request(url, headers=HEADERS)
        with urllib.request.urlopen(request, timeout=30) as response:
            data = response.read(20_000_001)
        selected = []
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for name in archive.namelist():
                if not name.endswith('.txt'):
                    continue
                for line in archive.read(name).decode('utf-8', errors='replace').splitlines():
                    for marker in ('H2MAP ', 'FORMAT ', 'Content-Type was ', 'No NEL winner:'):
                        if marker in line:
                            value = line.split(marker, 1)[1]
                            if marker in ('H2MAP ', 'FORMAT '):
                                try:
                                    value = json.loads(value)
                                except json.JSONDecodeError:
                                    value = value[:250]
                            selected.append({'kind': marker.strip(), 'value': value})
                            break
        if repository.startswith('slslslslsk/'):
            rows = [x['value'] for x in selected if x['kind'] == 'H2MAP' and isinstance(x['value'], dict)]
            row['h2'] = {'count': len(rows),
                         'nelOld': [x for x in rows if x.get('old', '').startswith('856170706c69636174696f6e2f6a736f6e')],
                         'samples': [x for x in rows if x.get('label') in ('h2-u0085', 'h1-raw85-header-2012-02-12', 'h1-raw85-query-2012-02-12')]}
        elif repository.startswith('EthanYangTW/'):
            row['formats'] = [x['value'] for x in selected if x['kind'] == 'FORMAT' and isinstance(x['value'], dict)]
        else:
            row['failures'] = [x['value'] for x in selected if x['kind'] == 'Content-Type was' or x['kind'] == 'No NEL winner:'][:4]
    except Exception as error:
        row['error'] = f'{type(error).__name__}: {str(error)[:150]}'
    print('::notice title=Current carrier experiment::' + json.dumps(row, separators=(',', ':')), flush=True)
