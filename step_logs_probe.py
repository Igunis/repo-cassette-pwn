import json
import os
from urllib.parse import parse_qs, urlparse

import requests


job_id = '120958551216'
root = 'https://api.github.com/repos/Igunis/repo-cassette-pwn/actions/jobs/' + job_id
session = requests.Session()
session.headers.update({
    'Accept': 'application/vnd.github.v3+json',
    'Authorization': f'Bearer {os.environ["GH_TOKEN"]}',
    'User-Agent': 'https://github.com/sindresorhus/gh-got',
})

rows = []
for version in (None, '2026-03-10'):
    headers = {} if version is None else {'X-GitHub-Api-Version': version}
    for label, suffix in [('job', '')] + [(f'step_{n}', f'/steps/{n}/logs') for n in range(1, 9)]:
        try:
            response = session.get(root + suffix, headers=headers, allow_redirects=False, timeout=10)
            location = urlparse(response.headers.get('Location', ''))
            query = parse_qs(location.query)
            row = {
                'version': version or 'default',
                'label': label,
                'status': response.status_code,
                'type': response.headers.get('Content-Type', ''),
                'location_host': location.hostname,
                'location_keys': sorted(query),
                'rsct': query.get('rsct', [None])[0],
            }
            if label == 'job' and response.ok:
                detail = response.json()
                row['steps'] = [step.get('number') for step in detail.get('steps', [])]
            rows.append(row)
        except requests.RequestException as error:
            rows.append({'version': version or 'default', 'label': label, 'error': type(error).__name__})

print('::notice title=Step log download probe::' + json.dumps(rows, separators=(',', ':')).replace('%', '%25'))
