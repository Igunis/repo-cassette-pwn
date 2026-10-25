import io
import json
import os
import urllib.request
import zipfile
from collections import Counter


TARGETS = [
    ('sonotri/HITCON_Repo-cassette', 40108554651),
    ('ksyang/repo-cassette-solver', 40152190198),
    ('ksyang/repo-cassette-solver', 40152032545),
    ('vincegl/repo-cassette-src', 40168515734),
    ('vincegl/repo-cassette-src', 40167085962),
]
MARKERS = ('PROTO_MATRIX', 'VERSION_MATRIX', 'CROSSJOB', 'DELETE_SUMMARY',
           'RACE_SUMMARY', 'WINNER', 'RESULT', 'CANDIDATE')


def download_logs(repository, run_id):
    url = f'https://api.github.com/repos/{repository}/actions/runs/{run_id}/logs'
    request = urllib.request.Request(url, headers={
        'Authorization': f'Bearer {os.environ["GH_TOKEN"]}',
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'repo-cassette-log-audit',
    })
    with urllib.request.urlopen(request, timeout=30) as response:
        data = response.read(20_000_001)
        if len(data) > 20_000_000:
            raise ValueError('log archive exceeds 20 MB')
        return data


def object_after(line, marker):
    position = line.find(marker)
    if position < 0:
        return None
    position = line.find('{', position + len(marker))
    if position < 0:
        return None
    try:
        value, _ = json.JSONDecoder().raw_decode(line[position:])
        return value if isinstance(value, dict) else None
    except json.JSONDecodeError:
        return None


for repository, run_id in TARGETS:
    row = {'repository': repository, 'run': run_id}
    try:
        archive = zipfile.ZipFile(io.BytesIO(download_logs(repository, run_id)))
        markers = Counter()
        content_types = Counter()
        anomalies = []
        odd_count = 0
        matched = 0
        for name in archive.namelist():
            if not name.endswith('.txt'):
                continue
            with archive.open(name) as stream:
                for raw_line in stream:
                    line = raw_line.decode('utf-8', errors='replace')
                    for marker in MARKERS:
                        if marker not in line:
                            continue
                        markers[marker] += 1
                        record = object_after(line, marker)
                        if not record:
                            continue
                        matched += 1
                        value = record.get('rsct') or record.get('finalContentType') or record.get('view', {}).get('rsct')
                        if value is not None:
                            content_types[str(value)] += 1
                        if marker == 'DELETE_SUMMARY':
                            odd_count += int(record.get('odd', 0))
                        if '\u0085' in str(value) or (marker == 'WINNER'):
                            anomalies.append({'marker': marker, 'type': str(value), 'id': record.get('artifactId') or record.get('id')})
        row.update(files=len(archive.namelist()), markers=dict(markers), parsed=matched,
                   contentTypes=dict(content_types), odd=odd_count, anomalies=anomalies[:8])
    except Exception as error:
        row['error'] = f'{type(error).__name__}: {str(error)[:140]}'
    print(f'::notice title=Foreign race log audit::{json.dumps(row, separators=(",", ":"))}', flush=True)
