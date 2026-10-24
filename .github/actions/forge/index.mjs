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
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const candidates = [
  ['amp-subtype', 'application/json&api-version=2012-02-12'],
  ['question-subtype', 'application/json?api-version=2012-02-12'],
  ['hash-subtype', 'application/json#api-version=2012-02-12'],
  ['quoted-amp', 'application/json;foo="&api-version=2012-02-12"'],
  ['token-amp', 'application/json;foo=x&api-version=2012-02-12'],
  ['quoted-percent-amp', 'application/json;foo="%26api-version=2012-02-12"'],
  ['plain-json', 'application/json'],
];

const results = [];
for (const [label, mime] of candidates) {
  const name = `mime-${process.env.GITHUB_RUN_ID}-${label}.json`;
  try {
    const created = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      mimeType: StringValue.create({ value: mime }),
      version: 7,
    });
    const uploaded = await request(created.signedUploadUrl, {
      method: 'PUT',
      headers: {
        'x-ms-blob-type': 'BlockBlob',
        'Content-Type': 'application/octet-stream',
        'Content-Length': '2',
      },
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
      label,
      mime,
      artifactId: finalized.artifactId,
      uploadStatus: uploaded.status,
      restStatus: rest.status,
      queryKeys: redirect ? [...redirect.searchParams.keys()] : [],
      rsct: redirect?.searchParams.get('rsct') || null,
      apiVersion: redirect?.searchParams.get('api-version') || null,
      outputStatus: downloaded?.status || null,
      outputTypeHex: [...(downloaded?.headers['content-type'] || '')].map(c => c.codePointAt(0).toString(16)).join(','),
      outputBytes: downloaded?.body.length || 0,
    });
  } catch (error) {
    results.push({ label, mime, error: String(error?.message || error).slice(0, 500) });
  }
}

const report = JSON.stringify(results);
console.log(report);
console.log(`::notice title=MIME URL probe::${report.replaceAll('%', '%25')}`);
