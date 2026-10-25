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
const body = Buffer.from('{}');
const hash = `sha256:${createHash('sha256').update(body).digest('hex')}`;
const cases = [
  ['u0185_lead', '\u0185application/json'],
  ['u0185_tail', 'application/json\u0185'],
  ['u0285_tail', 'application/json\u0285'],
  ['u1085_tail', 'application/json\u1085'],
  ['u011c_tail', 'application/json\u011c'],
  ['u011d_tail', 'application/json\u011d'],
  ['u011e_tail', 'application/json\u011e'],
  ['u011f_tail', 'application/json\u011f'],
];

const rows = [];
for (const [label, mime] of cases) {
  const name = `highbyte-${process.env.GITHUB_RUN_ID}-${label}`;
  const row = { label, mimeUtf8Hex: Buffer.from(mime).toString('hex') };
  try {
    const created = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      version: 7,
      mimeType: StringValue.create({ value: mime }),
    });
    row.created = Boolean(created.ok);
    if (!created.ok) throw new Error('CreateArtifact returned ok=false');
    await new BlobClient(created.signedUploadUrl).getBlockBlobClient().uploadData(body, {
      blobHTTPHeaders: { blobContentType: 'application/octet-stream' },
    });
    const finalized = await client.FinalizeArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      size: String(body.length),
      hash: StringValue.create({ value: hash }),
    });
    row.id = String(finalized.artifactId);
    const signed = await client.GetSignedArtifactURL({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
    });
    row.rsct = new URL(signed.signedUrl).searchParams.get('rsct');
    const response = await fetch(signed.signedUrl);
    row.status = response.status;
    row.contentTypeLatin1Hex = Buffer.from(response.headers.get('content-type') || '', 'latin1').toString('hex');
    row.bodyMatch = Buffer.from(await response.arrayBuffer()).equals(body);
  } catch (error) {
    row.error = String(error?.message || error).slice(0, 130);
  }
  rows.push(row);
}

console.log('::notice title=High-byte artifact MIME probe::' + JSON.stringify(rows).replaceAll('%', '%25'));
