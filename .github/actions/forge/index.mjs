import https from 'node:https';

const artifactEntry = import.meta.resolve('@actions/artifact');
const artifactLib = new URL('.', artifactEntry);
const [{ internalArtifactTwirpClient }, { getBackendIdsFromToken }] = await Promise.all([
  import(new URL('internal/shared/artifact-twirp-client.js', artifactLib)),
  import(new URL('internal/shared/util.js', artifactLib)),
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

const name = `format-${process.env.GITHUB_RUN_ID}.json`;
const created = await client.CreateArtifact({
  workflowRunBackendId: ids.workflowRunBackendId,
  workflowJobRunBackendId: ids.workflowJobRunBackendId,
  name,
  version: 0,
});
const payload = Buffer.from('{}');
await request(created.signedUploadUrl, {
  method: 'PUT', headers: { 'x-ms-blob-type': 'BlockBlob', 'content-type': 'application/x-probe', 'content-length': '2' },
}, payload);
const finalized = await client.FinalizeArtifact({
  workflowRunBackendId: ids.workflowRunBackendId,
  workflowJobRunBackendId: ids.workflowJobRunBackendId,
  name,
  size: '2',
});

const base = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${finalized.artifactId}`;
const formats = [
  'zip', 'json', 'raw', 'download', 'zip.json', 'zip%2Ejson',
  'application%2Fjson', 'zip%85', 'zip%C2%85', 'zip%1C',
  'zip%0A', 'zip%0D%0A', 'zip;json', 'zip?archive_format=json',
  'zip?format=json', 'zip?response-content-type=application%2Fjson%85',
];
const headers = {
  authorization: `Bearer ${process.env.GH_TOKEN}`,
  accept: 'application/vnd.github.v3+json',
  'user-agent': 'repo-cassette-probe',
  'x-github-api-version': '2022-11-28',
};
const results = [];
for (const format of formats) {
  try {
    const first = await request(`${base}/${format}`, { headers });
    const location = first.headers.location || '';
    const followed = location ? await request(location) : null;
    results.push({
      format,
      status: first.status,
      firstType: first.headers['content-type'] || null,
      hasLocation: Boolean(location),
      rsctHex: location ? Buffer.from(new URL(location).searchParams.get('rsct') || '', 'latin1').toString('hex') : null,
      outputStatus: followed?.status || null,
      outputTypeHex: followed ? Buffer.from(followed.headers['content-type'] || '', 'latin1').toString('hex') : null,
      payload: Boolean(followed?.body.equals(payload)),
      errorBody: location ? null : first.body.toString().slice(0, 160),
    });
  } catch (error) {
    results.push({ format, error: String(error?.message || error).slice(0, 300) });
  }
}

const report = JSON.stringify({ artifactId: finalized.artifactId, results });
console.log(report);
console.log(`::notice title=Artifact archive-format probe::${report.replaceAll('%', '%25')}`);
