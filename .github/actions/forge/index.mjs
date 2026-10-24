import https from 'node:https';

const artifactEntry = import.meta.resolve('@actions/artifact');
const artifactLib = new URL('.', artifactEntry);
const [{ internalArtifactTwirpClient }, { getBackendIdsFromToken }, { StringValue }] = await Promise.all([
  import(new URL('internal/shared/artifact-twirp-client.js', artifactLib)),
  import(new URL('internal/shared/util.js', artifactLib)),
  import(new URL('generated/index.js', artifactLib)),
]);
const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({ maxAttempts: 1 });

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

const candidates = [
  ['v0-fs', 0, `application/json${String.fromCharCode(0x1c)}`],
  ['v0-gs', 0, `application/json${String.fromCharCode(0x1d)}`],
  ['v0-nel', 0, 'application/json\u0085'],
  ['v0-json', 0, 'application/json'],
  ['v6-fs', 6, `application/json${String.fromCharCode(0x1c)}`],
  ['v6-nel', 6, 'application/json\u0085'],
  ['v6-json', 6, 'application/json'],
];
const payload = Buffer.from('{}');
const results = [];
for (const [label, version, mime] of candidates) {
  const name = `legacy-mime-${process.env.GITHUB_RUN_ID}-${label}.json`;
  try {
    const created = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      mimeType: StringValue.create({ value: mime }),
      version,
    });
    const upload = await request(created.signedUploadUrl, {
      method: 'PUT', headers: { 'x-ms-blob-type': 'BlockBlob', 'content-type': 'application/x-probe', 'content-length': '2' },
    }, payload);
    const finalized = await client.FinalizeArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      size: '2',
    });
    const first = await request(
      `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${finalized.artifactId}/zip`,
      { headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: 'application/vnd.github.v3+json', 'user-agent': 'repo-cassette-probe' } },
    );
    const location = first.headers.location || '';
    const followed = location ? await request(location) : null;
    results.push({
      label, version,
      inputMimeHex: Buffer.from(mime, 'latin1').toString('hex'),
      uploadStatus: upload.status,
      artifactId: finalized.artifactId,
      restStatus: first.status,
      rsctHex: location ? Buffer.from(new URL(location).searchParams.get('rsct') || '', 'latin1').toString('hex') : null,
      outputStatus: followed?.status || null,
      outputTypeHex: followed ? Buffer.from(followed.headers['content-type'] || '', 'latin1').toString('hex') : null,
      payload: Boolean(followed?.body.equals(payload)),
    });
  } catch (error) {
    results.push({ label, version, inputMimeHex: Buffer.from(mime, 'latin1').toString('hex'), error: String(error?.message || error).slice(0, 300) });
  }
}

const report = JSON.stringify(results);
console.log(report);
console.log(`::notice title=Legacy artifact MIME probe::${report.replaceAll('%', '%25')}`);
