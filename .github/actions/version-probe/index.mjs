import { createHash } from 'node:crypto';

import { BlobClient } from '@azure/storage-blob';

const versions = [-2147483648, -2147483641, -1, 0, 1, 4, 5, 6, 7, 8, 2147483647];
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
const results = [];

for (const version of versions) {
  const label = version < 0 ? `neg${-version}` : String(version);
  const name = `version-${process.env.GITHUB_RUN_ID}-${label}.json`;
  try {
    const created = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      mimeType: StringValue.create({ value: contentType }),
      version,
    });
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
    const responseType = response.headers.get('content-type') || '';
    results.push({
      version,
      accepted: true,
      artifactId: finalized.artifactId,
      outputHex: Buffer.from(responseType, 'latin1').toString('hex'),
    });
  } catch (error) {
    results.push({ version, accepted: false });
  }
}

const report = JSON.stringify(results);
console.log(report);
console.log(`::notice title=Version probe::${report.replaceAll('%', '%25')}`);
