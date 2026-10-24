import { createHash } from 'node:crypto';
import https from 'node:https';

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
const metadataType = 'application/octet-stream';
const blobType = Buffer.concat([
  Buffer.from('application/json', 'ascii'),
  Buffer.from([0x85]),
]).toString('latin1');
const bytes = Buffer.from('{"probe":"artifact-name"}');

function coreGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        location: response.headers.location,
        type: response.headers['content-type'] || '',
        body: Buffer.concat(chunks),
      }));
    }).on('error', reject);
  });
}

const names = [
  ['plain', `name-${process.env.GITHUB_RUN_ID}.json`],
  ['encoded-query', `name-${process.env.GITHUB_RUN_ID}%3Fapi-version=2012-02-12.json`],
  ['double-query', `name-${process.env.GITHUB_RUN_ID}%253Fapi-version%253D2012-02-12.json`],
  ['encoded-amp', `name-${process.env.GITHUB_RUN_ID}%26api-version%3D2012-02-12.json`],
  ['hash', `name-${process.env.GITHUB_RUN_ID}#api-version=2012-02-12.json`],
  ['semicolon', `name-${process.env.GITHUB_RUN_ID};api-version=2012-02-12.json`],
];
const results = [];

for (const [label, name] of names) {
  try {
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

    const api = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${finalized.artifactId}/zip`;
    const apiHeaders = {
      Accept: 'application/vnd.github.v3+json',
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      'User-Agent': 'repo-cassette-probe',
    };
    const redirect = await coreGet(`${api}?api-version=2012-02-12`, apiHeaders);
    const followed = redirect.location ? await coreGet(redirect.location) : redirect;
    const oldProtocol = await coreGet(`${signedUrl}&api-version=2012-02-12`);
    const parsedSigned = new URL(signedUrl);
    results.push({
      label,
      accepted: true,
      id: finalized.artifactId,
      redirectHasApiVersion: redirect.location?.includes('api-version') || false,
      followedStatus: followed.status,
      followedTypeCodePoints: [...followed.type].map(char => char.codePointAt(0).toString(16)).join(','),
      oldTypeCodePoints: [...oldProtocol.type].map(char => char.codePointAt(0).toString(16)).join(','),
      signedPathTail: decodeURIComponent(parsedSigned.pathname).slice(-90),
      signedRscd: parsedSigned.searchParams.get('rscd'),
    });
  } catch (error) {
    results.push({ label, accepted: false, error: String(error?.message || error).slice(0, 180) });
  }
}

const report = JSON.stringify(results);
console.log(report);
console.log(`::notice title=Artifact name URL probe::${report.replaceAll('%', '%25')}`);
