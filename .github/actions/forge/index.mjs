import https from 'node:https';

const artifactEntry = import.meta.resolve('@actions/artifact');
const artifactLib = new URL('.', artifactEntry);
const [{ getBackendIdsFromToken }, generated] = await Promise.all([
  import(new URL('internal/shared/util.js', artifactLib)),
  import(new URL('generated/index.js', artifactLib)),
]);
const { CreateArtifactRequest, CreateArtifactResponse, StringValue } = generated;
const ids = getBackendIdsFromToken();

function request(url, options = {}, body = undefined) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function protobufWithRawMime(name, byte) {
  const marker = 'application/jsonX';
  const encoded = Buffer.from(CreateArtifactRequest.toBinary(CreateArtifactRequest.create({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    mimeType: StringValue.create({ value: marker }),
    version: 7,
  })));
  const position = encoded.lastIndexOf(Buffer.from(marker));
  if (position < 0) throw new Error('marker missing');
  encoded[position + marker.length - 1] = byte;
  return encoded;
}

const resultsUrl = new URL(process.env.ACTIONS_RESULTS_URL).origin;
const endpoint = `${resultsUrl}/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact`;
const results = [];
for (const [label, byte] of [['raw85', 0x85], ['raw1c', 0x1c], ['raw1d', 0x1d], ['raw1e', 0x1e], ['raw1f', 0x1f], ['rawff', 0xff]]) {
  const name = `protobuf-${process.env.GITHUB_RUN_ID}-${label}.json`;
  try {
    const body = protobufWithRawMime(name, byte);
    const response = await request(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.ACTIONS_RUNTIME_TOKEN}`,
        'content-type': 'application/protobuf',
        accept: 'application/protobuf',
        'content-length': String(body.length),
      },
    }, body);
    let parsed = null;
    try { parsed = CreateArtifactResponse.fromBinary(response.body); } catch {}
    results.push({
      label,
      byte,
      status: response.status,
      responseType: response.headers['content-type'] || null,
      parsedOk: parsed?.ok ?? null,
      hasUploadUrl: Boolean(parsed?.signedUploadUrl),
      errorHex: parsed ? null : response.body.subarray(0, 300).toString('hex'),
    });
  } catch (error) {
    results.push({ label, byte, error: String(error?.stack || error).slice(0, 500) });
  }
}

const report = JSON.stringify(results);
console.log(report);
console.log(`::notice title=Raw protobuf MIME probe::${report.replaceAll('%', '%25')}`);
