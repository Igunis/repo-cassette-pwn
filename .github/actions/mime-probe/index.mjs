import { createHash } from 'node:crypto';

import { BlobClient } from '@azure/storage-blob';

const latin1 = bytes => Buffer.from(bytes).toString('latin1');
const base = [...Buffer.from('application/json', 'ascii')];
const candidates = [
  ['trail-85', latin1([...base, 0x85])],
  ['lead-85', latin1([0x85, ...base])],
  ['trail-1c', latin1([...base, 0x1c])],
  ['trail-1d', latin1([...base, 0x1d])],
  ['trail-1e', latin1([...base, 0x1e])],
  ['trail-1f', latin1([...base, 0x1f])],
  ['lead-1c', latin1([0x1c, ...base])],
  ['lead-1d', latin1([0x1d, ...base])],
  ['lead-1e', latin1([0x1e, ...base])],
  ['lead-1f', latin1([0x1f, ...base])],
  ['space-trail-85', latin1([...base, 0x20, 0x85])],
  ['tab-trail-85', latin1([...base, 0x09, 0x85])],
  ['85-before-param', latin1([...base, 0x85, ...Buffer.from(';x=y')])],
  ['85-after-semi', latin1([...base, ...Buffer.from(';'), 0x85, ...Buffer.from('x=y')])],
  ['85-param-value', latin1([...base, ...Buffer.from(';x="'), 0x85, ...Buffer.from('"')])],
  ['percent-85', 'application/json%85'],
  ['percent-c2-85', 'application/json%C2%85'],
  ['plain-parameter', 'application/json;x=y'],
  ['plain-json', 'application/json'],
];

const artifactEntry = import.meta.resolve('@actions/artifact');
const artifactLib = new URL('.', artifactEntry);
const [{ internalArtifactTwirpClient }, { getBackendIdsFromToken }, { StringValue }] = await Promise.all([
  import(new URL('internal/shared/artifact-twirp-client.js', artifactLib)),
  import(new URL('internal/shared/util.js', artifactLib)),
  import(new URL('generated/index.js', artifactLib)),
]);
const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({ maxAttempts: 1 });
const results = [];

for (const [label, mime] of candidates) {
  const name = `probe-${process.env.GITHUB_RUN_ID}-${label}.json`;
  try {
    const created = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      mimeType: StringValue.create({ value: mime }),
      version: 7,
    });
    if (!created.ok) throw new Error('CreateArtifact returned ok=false');
    const bytes = Buffer.from('{}');
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
    const response = await fetch(signedUrl);
    const responseType = response.headers.get('content-type') || '';
    results.push({
      label,
      accepted: true,
      artifactId: finalized.artifactId,
      inputHex: Buffer.from(mime, 'latin1').toString('hex'),
      outputHex: Buffer.from(responseType, 'latin1').toString('hex'),
    });
  } catch (error) {
    results.push({ label, accepted: false });
  }
}

const report = JSON.stringify(results);
console.log(report);
console.log(`::notice title=MIME probe::${report.replaceAll('%', '%25')}`);
