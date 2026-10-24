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
const nel = Buffer.concat([Buffer.from('application/json'), Buffer.from([0x85])]).toString('latin1');
const variants = [
  [8, nel], [8, 'application/json'],
  [9, nel], [10, nel], [255, nel], [2147483647, nel],
];
const rows = [];

for (const [version, mime] of variants) {
  const name = `future-v${version}-${mime === nel ? 'nel' : 'plain'}-${process.env.GITHUB_RUN_ID}`;
  const row = { version, mimeHex: Buffer.from(mime, 'latin1').toString('hex') };
  try {
    const created = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      mimeType: StringValue.create({ value: mime }),
      version,
    });
    row.created = created.ok;
    if (created.ok) {
      const bytes = Buffer.from('{}');
      const blob = new BlobClient(created.signedUploadUrl).getBlockBlobClient();
      await blob.uploadData(bytes, { blobHTTPHeaders: { blobContentType: nel } });
      const finalized = await client.FinalizeArtifact({
        workflowRunBackendId: ids.workflowRunBackendId,
        workflowJobRunBackendId: ids.workflowJobRunBackendId,
        name,
        size: String(bytes.length),
        hash: StringValue.create({ value: `sha256:${createHash('sha256').update(bytes).digest('hex')}` }),
      });
      row.artifactId = finalized.artifactId;
      const { signedUrl } = await client.GetSignedArtifactURL({
        workflowRunBackendId: ids.workflowRunBackendId,
        workflowJobRunBackendId: ids.workflowJobRunBackendId,
        name,
      });
      row.rsct = new URL(signedUrl).searchParams.getAll('rsct');
      const response = await fetch(signedUrl);
      row.status = response.status;
      row.typeHex = Buffer.from(response.headers.get('content-type') || '', 'latin1').toString('hex');
      row.bodyHex = Buffer.from(await response.arrayBuffer()).toString('hex');
    }
  } catch (error) {
    row.error = String(error?.message || error).slice(0, 180);
  }
  rows.push(row);
}

const output = JSON.stringify(rows);
console.log(`::notice title=Future artifact versions::${output.replaceAll('%', '%25')}`);
