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
const name = `azure-version-${process.env.GITHUB_RUN_ID}.json`;
const metadataType = 'application/octet-stream';
const blobType = Buffer.concat([
  Buffer.from('application/json', 'ascii'),
  Buffer.from([0x85]),
]).toString('latin1');
const bytes = Buffer.from('{"probe":"azure-version"}');

const created = await client.CreateArtifact({
  workflowRunBackendId: ids.workflowRunBackendId,
  workflowJobRunBackendId: ids.workflowJobRunBackendId,
  name,
  mimeType: StringValue.create({ value: metadataType }),
  version: 7,
});
const blob = new BlobClient(created.signedUploadUrl).getBlockBlobClient();
await blob.uploadData(bytes, { blobHTTPHeaders: { blobContentType: blobType } });
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

const variants = [
  ['none', signedUrl],
  ['2012-02-12', `${signedUrl}&api-version=2012-02-12`],
  ['2011-08-18', `${signedUrl}&api-version=2011-08-18`],
  ['2009-09-19', `${signedUrl}&api-version=2009-09-19`],
  ['dollar-2012', `${signedUrl}&$api-version=2012-02-12`],
];
const results = [];
for (const [label, url] of variants) {
  const response = await fetch(url);
  const body = Buffer.from(await response.arrayBuffer());
  results.push({
    label,
    status: response.status,
    typeHex: Buffer.from(response.headers.get('content-type') || '', 'latin1').toString('hex'),
    payload: body.equals(bytes),
    length: body.length,
  });
}

const report = JSON.stringify({ artifactId: finalized.artifactId, results });
console.log(report);
console.log(`::notice title=Azure protocol version probe::${report.replaceAll('%', '%25')}`);
