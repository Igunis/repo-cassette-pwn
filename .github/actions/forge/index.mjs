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

const versions = [-2147483648, -65536, -1, 0, 1, 2, 3, 4, 5, 6, 8, 65536, 2147483647];
const results = [];
for (const version of versions) {
  const name = `version-${process.env.GITHUB_RUN_ID}-${String(version).replace('-', 'n')}.json`;
  try {
    const created = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      version,
    });
    const uploaded = await request(created.signedUploadUrl, {
      method: 'PUT',
      headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': 'application/x-probe', 'Content-Length': '2' },
    }, Buffer.from('{}'));
    const finalized = await client.FinalizeArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      size: '2',
    });
    const rest = await request(
      `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${finalized.artifactId}/zip`,
      { headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'repo-cassette-probe' } },
    );
    const location = rest.headers.location || '';
    const redirect = location ? new URL(location) : null;
    const downloaded = location ? await request(location) : null;
    results.push({
      version,
      artifactId: finalized.artifactId,
      uploadStatus: uploaded.status,
      restStatus: rest.status,
      hasRsct: redirect?.searchParams.has('rsct') || false,
      rsct: redirect?.searchParams.get('rsct') || null,
      outputType: downloaded?.headers['content-type'] || null,
      outputBytes: downloaded?.body.length || 0,
      prefixHex: downloaded?.body.subarray(0, 8).toString('hex') || null,
    });
  } catch (error) {
    results.push({ version, error: String(error?.message || error).slice(0, 500) });
  }
}

const report = JSON.stringify(results);
console.log(report);
console.log(`::notice title=Artifact version boundary probe::${report.replaceAll('%', '%25')}`);
