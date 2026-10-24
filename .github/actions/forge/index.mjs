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
const nel = `application/json${String.fromCharCode(0x85)}`;

function request(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

const name = `redirect-${process.env.GITHUB_RUN_ID}.json`;
const created = await client.CreateArtifact({
  workflowRunBackendId: ids.workflowRunBackendId,
  workflowJobRunBackendId: ids.workflowJobRunBackendId,
  name,
  version: 6,
  mimeType: StringValue.create({ value: nel }),
});
if (!created.ok || !created.signedUploadUrl) throw new Error('CreateArtifact failed');
const payload = Buffer.from('{}');
await new BlobClient(created.signedUploadUrl).getBlockBlobClient().uploadData(payload, {
  blobHTTPHeaders: { blobContentType: nel },
});
const finalized = await client.FinalizeArtifact({
  workflowRunBackendId: ids.workflowRunBackendId,
  workflowJobRunBackendId: ids.workflowJobRunBackendId,
  name,
  size: String(payload.length),
});
const base = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${finalized.artifactId}/zip`;
const headers = {
  authorization: `Bearer ${process.env.GH_TOKEN}`,
  accept: 'application/vnd.github.v3+json',
  'user-agent': 'https://github.com/sindresorhus/gh-got',
};
const results = [];
for (const query of [
  '', '?redirect=false', '?redirect=0', '?follow=false',
  '?follow_redirects=false', '?stream=true', '?raw=true',
  '?no_redirect=true', '?response_type=raw', '?api-version=2012-02-12',
]) {
  try {
    const first = await request(`${base}${query}`, headers);
    const location = first.headers.location;
    const followed = location ? await request(location, {
      accept: headers.accept,
      'user-agent': headers['user-agent'],
    }) : null;
    results.push({
      query: query || 'control',
      status: first.status,
      sourceType: first.headers['content-type'] || null,
      rsct: location ? new URL(location).searchParams.get('rsct') : null,
      bodyMatches: first.body.equals(payload),
      followedStatus: followed?.status || null,
      followedTypeHex: followed ? Buffer.from(followed.headers['content-type'] || '', 'latin1').toString('hex') : null,
      followedBodyMatches: Boolean(followed?.body.equals(payload)),
    });
  } catch (error) {
    results.push({ query, error: String(error?.message || error).slice(0, 160) });
  }
}
const output = JSON.stringify({ artifactId: finalized.artifactId, results });
console.log(output);
console.log(`::notice title=Artifact redirect query probe::${output.replaceAll('%', '%25')}`);
