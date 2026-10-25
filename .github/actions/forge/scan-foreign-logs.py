import io
import json
import os
import re
import urllib.request
import urllib.error
import urllib.parse
import zipfile
from collections import Counter


TARGETS = [
    ('slslslslsk/repo-cassette-xf-d914c3c1', 40174360116),
]
MARKERS = ('XJOB_CREATE', 'XJOB_FINAL', 'XJOB_CANDIDATE', 'XJOB_DISCOVERY', 'XJOB_REWRITE')


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


def github_json(repository, path):
    request = urllib.request.Request(f'https://api.github.com/repos/{repository}{path}', headers={
        'Authorization': f'Bearer {os.environ["GH_TOKEN"]}',
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'repo-cassette-log-audit',
    })
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def artifact_types(repository, run_id):
    listing = github_json(repository, f'/actions/runs/{run_id}/artifacts?per_page=100')
    ids = [item['id'] for item in listing.get('artifacts', [])]
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, request, response, code, message, headers, newurl):
            return None
    opener = urllib.request.build_opener(NoRedirect)
    counts = Counter()
    unusual = []
    for artifact_id in ids:
        request = urllib.request.Request(
            f'https://api.github.com/repos/{repository}/actions/artifacts/{artifact_id}/zip',
            headers={'Authorization': f'Bearer {os.environ["GH_TOKEN"]}',
                     'Accept': 'application/vnd.github.v3+json',
                     'User-Agent': 'repo-cassette-log-audit'},
        )
        try:
            response = opener.open(request, timeout=20)
        except urllib.error.HTTPError as error:
            response = error
        location = response.headers.get('Location')
        value = urllib.parse.parse_qs(urllib.parse.urlsplit(location).query).get('rsct', [None])[0] if location else None
        key = value if response.code == 302 else str(response.code)
        counts[key] += 1
        if key not in ('application/json', 'application/zip'):
            unusual.append({'id': artifact_id, 'status': response.code, 'rsct': value})
    return {'count': len(ids), 'types': dict(counts), 'unusual': unusual[:8]}


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
        examples = []
        summaries = []
        odd_count = 0
        matched = 0
        for name in archive.namelist():
            if not name.endswith('.txt'):
                continue
            with archive.open(name) as stream:
                for raw_line in stream:
                    line = raw_line.decode('utf-8', errors='replace')
                    for marker in MARKERS:
                        if f'{marker} ' not in line:
                            continue
                        markers[marker] += 1
                        record = object_after(line, marker)
                        if not record:
                            if marker == 'CANDIDATE' and len(examples) < 4:
                                examples.append(re.sub(r'https?://\S+', '[url]',
                                                       line[line.find(marker):].strip())[:220])
                            continue
                        matched += 1
                        value = (record.get('rsct') or record.get('finalContentType') or
                                 record.get('view', {}).get('rsct') or
                                 record.get('signedType', {}).get('value') or
                                 record.get('finalType') or record.get('servedTypeHex') or
                                 record.get('contentType'))
                        if value is not None:
                            content_types[str(value)] += 1
                        if marker == 'DELETE_SUMMARY':
                            odd_count += int(record.get('odd', 0))
                        if marker in ('XJOB_FINAL', 'XJOB_CANDIDATE'):
                            summaries.append({key: record[key] for key in
                                              ('side', 'label', 'target', 'foreignTarget', 'status',
                                               'ok', 'artifactId', 'code', 'msg', 'redirectStatus',
                                               'rsct', 'contentType', 'bodyMatch')
                                              if key in record})
                        if '\u0085' in str(value) or (marker == 'WINNER'):
                            anomalies.append({'marker': marker, 'type': str(value), 'id': record.get('artifactId') or record.get('id')})
        row.update(files=len(archive.namelist()), markers=dict(markers), parsed=matched,
                   contentTypes=dict(content_types), odd=odd_count, anomalies=anomalies[:8],
                   summaries=summaries[:40], candidateExamples=examples)
        if repository.startswith('slslslslsk/'):
            row['artifactDownloads'] = artifact_types(repository, run_id)
    except Exception as error:
        row['error'] = f'{type(error).__name__}: {str(error)[:140]}'
    print(f'::notice title=Foreign race log audit::{json.dumps(row, separators=(",", ":"))}', flush=True)
