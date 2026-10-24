import { createHash } from 'node:crypto';

import { BlobClient } from '@azure/storage-blob';

const contentType = Buffer.concat([
  Buffer.from('application/json', 'ascii'),
  Buffer.from([0x85]),
]).toString('latin1');

const artifactEntry = import.meta.resolve('@actions/artifact');
const artifactLib = new URL('.', artifactEntry);
const [{ internalArtifactTwirpClient }, { getBackendIdsFromToken }, { StringValue }] = await Promise.all([
  import(new URL('internal/shared/artifact-twirp-client.js', artifactLib)),
  import(new URL('internal/shared/util.js', artifactLib)),
  import(new URL('generated/index.js', artifactLib)),
]);
const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({ maxAttempts: 1 });
const variants = [
  ['omitted', request => request],
  ['undefined', request => ({ ...request, mimeType: undefined })],
  ['null', request => ({ ...request, mimeType: null })],
  ['empty-object', request => ({ ...request, mimeType: StringValue.create({}) })],
  ['empty-string', request => ({ ...request, mimeType: StringValue.create({ value: '' }) })],
];
const results = [];

for (const [label, makeRequest] of variants) {
  const name = `empty-mime-${process.env.GITHUB_RUN_ID}-${label}.json`;
  try {
    const created = await client.CreateArtifact(makeRequest({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      version: 7,
    }));
    if (!created.ok) throw new Error('CreateArtifact returned ok=false');
    const bytes = Buffer.from('{}');
    const blob = new BlobClient(created.signedUploadUrl).getBlockBlobClient();
    await blob.uploadData(bytes, { blobHTTPHeaders: { blobContentType: contentType } });
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
    const response = await fetch(signedUrl);
    results.push({
      label,
      accepted: true,
      artifactId: finalized.artifactId,
      outputHex: Buffer.from(response.headers.get('content-type') || '', 'latin1').toString('hex'),
      rsct: new URL(signedUrl).searchParams.getAll('rsct'),
    });
  } catch (error) {
    results.push({ label, accepted: false, error: String(error?.message || error).slice(0, 160) });
  }
}

const report = JSON.stringify(results);
console.log(report);
console.log(`::notice title=Empty artifact MIME probe::${report.replaceAll('%', '%25')}`);
