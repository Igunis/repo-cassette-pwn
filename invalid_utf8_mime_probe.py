import base64
import json
import os
import urllib.error
import urllib.parse
import urllib.request


def varint(n):
    out = bytearray()
    while n >= 128:
        out.append((n & 127) | 128)
        n >>= 7
    out.append(n)
    return bytes(out)


def field(number, value):
    return varint((number << 3) | 2) + varint(len(value)) + value


def text_field(number, value):
    return field(number, value.encode())


def first_string_field(payload):
    if not payload or payload[0] != 0x0a:
        return None
    pos = 1
    length = 0
    shift = 0
    while True:
        byte = payload[pos]
        pos += 1
        length |= (byte & 127) << shift
        if byte < 128:
            break
        shift += 7
    return payload[pos:pos + length].decode()


token = os.environ['ACTIONS_RUNTIME_TOKEN']
claims = json.loads(base64.urlsafe_b64decode(token.split('.')[1] + '==='))
scope = next(value for value in claims['scp'].split() if value.startswith('Actions.Results:'))
_, run_backend_id, job_backend_id = scope.split(':')
parts = urllib.parse.urlsplit(os.environ['ACTIONS_RESULTS_URL'])
base = f'{parts.scheme}://{parts.netloc}/twirp/github.actions.results.api.v1.ArtifactService/'


def call(method, payload):
    req = urllib.request.Request(
        base + method,
        data=payload,
        headers={
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/protobuf',
            'Accept': 'application/protobuf',
        },
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=12) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


results = {}
for label, mime in [
    ('invalid_raw_85', b'application/json\x85'),
    ('valid_utf8_nel', b'application/json\xc2\x85'),
    ('control', b'application/json'),
]:
    name = f'utf8-mime-{label}-{os.environ["GITHUB_RUN_ID"]}.json'
    common = (
        text_field(1, run_backend_id)
        + text_field(2, job_backend_id)
        + text_field(3, name)
    )
    payload = common + bytes([0x28, 7]) + field(6, field(1, mime))
    status, body = call('CreateArtifact', payload)
    record = {'create_status': status}
    if status == 200:
        record['create_body_len'] = len(body)
        signed_status, signed_body = call('GetSignedArtifactURL', common)
        record['signed_status'] = signed_status
        if signed_status == 200:
            url = first_string_field(signed_body)
            record['rsct'] = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query).get('rsct', [None])[0]
        else:
            record['signed_body_prefix'] = signed_body[:160].decode(errors='replace')
    results[label] = record
    if status != 200:
        record['create_body_prefix'] = body[:160].decode(errors='replace')

output = json.dumps(results, separators=(',', ':'), ensure_ascii=True)
print(output)
print(f'::notice title=Invalid UTF8 artifact MIME::{output.replace("%", "%25")}')
