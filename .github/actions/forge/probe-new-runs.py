import io
import json
import os
import re
import urllib.error
import urllib.request
import zipfile

RUNS = [
    ('slslslslsk/repo-cassette-wire-fuzz-170747', 40175466466),
    ('CYC4D/repo-cassette-solve', 40175412397),
    ('CYC4D/repo-cassette-solve', 40175626537),
    ('ncves/repo-cassette-carrier', 40175574050),
]
SELECT = re.compile(r'WIRE-FUZZ-SUMMARY|DELETE_SUMMARY|WINNER|QUERY\s*\{|MINT\s*\{|No differential winner', re.I)
HEADERS = {'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
           'Accept': 'application/vnd.github.v3+json',
           'User-Agent': 'repo-cassette-public-run-audit'}

for repository, run in RUNS:
    row = {'repository': repository, 'run': run}
    url = f'https://api.github.com/repos/{repository}/actions/runs/{run}/logs'
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=25) as response:
            archive_bytes = response.read(12_000_001)
        selected = []
        with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
            for path in archive.namelist():
                if not path.endswith('.txt'):
                    continue
                for line in archive.read(path).decode('utf-8', errors='replace').splitlines():
                    if SELECT.search(line):
                        selected.append(line[-3000:])
        row['matchedLines'] = selected[:12]
    except Exception as error:
        row['error'] = f'{type(error).__name__}: {str(error)[:170]}'
    print('::notice title=Public carrier run::' + json.dumps(row, separators=(',', ':')), flush=True)
