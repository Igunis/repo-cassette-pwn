import io
import json
import os
import urllib.request
import zipfile

REPO = 'slslslslsk/repo-cassette-wire-fuzz-170747'
RUN = 40176035217
url = f'https://api.github.com/repos/{REPO}/actions/runs/{RUN}/logs'
request = urllib.request.Request(url, headers={
    'Authorization': 'Bearer ' + os.environ['GH_TOKEN'],
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'repo-cassette-blob-map-details',
})
with urllib.request.urlopen(request, timeout=30) as response:
    data = response.read(25_000_001)

rows = {}
with zipfile.ZipFile(io.BytesIO(data)) as archive:
    for path in archive.namelist():
        if not path.endswith('.txt'):
            continue
        for line in archive.read(path).decode('utf-8', errors='replace').splitlines():
            if ' BLOBMAP ' not in line:
                continue
            try:
                row = json.loads(line.split(' BLOBMAP ', 1)[1])
            except json.JSONDecodeError:
                continue
            rows[row['label']] = row

target = '856170706c69636174696f6e2f6a736f6e'
for label in ('prefix-85', 'suffix-85', 'utf8-nel', 'prefix-80', 'prefix-83'):
    row = rows.get(label)
    print('::notice title=Blob MIME sample::' + json.dumps({'label': label, 'row': row}, separators=(',', ':')), flush=True)

version_winners = []
status_counts = {}
for row in rows.values():
    status = row.get('oldStatus')
    status_counts[str(status)] = status_counts.get(str(status), 0) + 1
    for version, observed in row.get('versionMap', {}).items():
        if observed.split(':', 1)[-1].startswith(target):
            version_winners.append({'label': row['label'], 'version': version, 'result': observed})
print('::notice title=Blob MIME map status::' + json.dumps({
    'rows': len(rows), 'oldStatusCounts': status_counts, 'versionWinners': version_winners,
}, separators=(',', ':')), flush=True)
