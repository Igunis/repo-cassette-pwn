import { createHash } from 'node:crypto';

import { BlobClient } from '@azure/storage-blob';

const artifactEntry = import.meta.resolve('@actions/artifact');
const artifactLib = new URL('.', artifactEntry);
const [{ internalArtifactTwirpClient }, { getBackendIdsFromToken }, { StringValue }] = await Promise.all([
  import(new URL('internal/shared/artifact-twirp-client.js', artifactLib)),
  import(new URL('internal/shared/util.js', artifactLib)),
  import(new URL('generated/index.js', artifactLib)),
]);
const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({ maxAttempts: 1 });
const name = `query-probe-${process.env.GITHUB_RUN_ID}.json`;
const mime = 'application/octet-stream';
const bytes = Buffer.from('{"probe":"artifact-query"}');

const created = await client.CreateArtifact({
  workflowRunBackendId: ids.workflowRunBackendId,
  workflowJobRunBackendId: ids.workflowJobRunBackendId,
  name,
  mimeType: StringValue.create({ value: mime }),
  version: 7,
});
if (!created.ok) throw new Error('CreateArtifact returned ok=false');
const blob = new BlobClient(created.signedUploadUrl).getBlockBlobClient();
await blob.uploadData(bytes, { blobHTTPHeaders: { blobContentType: mime } });
const finalized = await client.FinalizeArtifact({
  workflowRunBackendId: ids.workflowRunBackendId,
  workflowJobRunBackendId: ids.workflowJobRunBackendId,
  name,
  size: String(bytes.length),
  hash: StringValue.create({ value: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }),
});
const { signedUrl } = await client.GetSignedArtifactURL({
  workflowRunBackendId: ids.workflowRunBackendId,
  workflowJobRunBackendId: ids.workflowJobRunBackendId,
  name,
});

const apiPath = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${finalized.artifactId}/zip`;
const variants = [
  ['api-none', apiPath],
  ['api-byte85', `${apiPath}?rsct=application/json%85`],
  ['api-utf8nel', `${apiPath}?rsct=application/json%C2%85`],
  ['api-double', `${apiPath}?download=1&rsct=application/json%85`],
  ['signed-none', signedUrl],
  ['signed-append-byte85', `${signedUrl}&rsct=application/json%85`],
  ['signed-append-utf8nel', `${signedUrl}&rsct=application/json%C2%85`],
];
const results = [];
for (const [label, url] of variants) {
  const response = await fetch(url, {
    headers: label.startsWith('api-') ? {
      Accept: 'application/vnd.github.v3+json',
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      'User-Agent': 'repo-cassette-probe',
    } : {},
    redirect: 'follow',
  });
  const body = Buffer.from(await response.arrayBuffer());
  results.push({
    label,
    status: response.status,
    host: new URL(response.url).host,
    typeHex: Buffer.from(response.headers.get('content-type') || '', 'latin1').toString('hex'),
    payload: body.equals(bytes),
    length: body.length,
  });
}

const report = JSON.stringify({ artifactId: finalized.artifactId, results });
console.log(report);
console.log(`::notice title=Artifact query probe::${report.replaceAll('%', '%25')}`);
