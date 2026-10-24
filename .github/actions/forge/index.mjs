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
    req.setTimeout(10000, () => req.destroy(new Error('request timeout')));
    req.end();
  });
}

async function create(name, version) {
  return client.CreateArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    version,
    mimeType: StringValue.create({ value: version === 7 ? 'application/json' : nel }),
  });
}

const results = [];
for (const [label, firstVersion, secondVersion] of [
  ['v7-then-v6', 7, 6],
  ['v6-then-v7', 6, 7],
]) {
  const name = `${label}-${process.env.GITHUB_RUN_ID}.json`;
  const record = { label, firstVersion, secondVersion };
  try {
    const first = await create(name, firstVersion);
    record.firstCreated = Boolean(first.ok && first.signedUploadUrl);
    try {
      const second = await create(name, secondVersion);
      record.secondCreated = Boolean(second.ok && second.signedUploadUrl);
    } catch (error) {
      record.secondError = String(error?.message || error).slice(0, 250);
    }
    const blob = new BlobClient(first.signedUploadUrl).getBlockBlobClient();
    await blob.uploadData(Buffer.from('{}'), {
      blobHTTPHeaders: { blobContentType: nel },
    });
    const finalized = await client.FinalizeArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      size: '2',
    });
    record.artifactId = finalized.artifactId;
    const rest = await request(
      `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${finalized.artifactId}/zip`,
      {
        authorization: `Bearer ${process.env.GH_TOKEN}`,
        accept: 'application/vnd.github.v3+json',
        'user-agent': 'repo-cassette-probe',
      },
    );
    record.restStatus = rest.status;
    if (rest.headers.location) {
      const redirect = new URL(rest.headers.location);
      record.rsct = redirect.searchParams.get('rsct');
      const followed = await request(rest.headers.location);
      record.downloadStatus = followed.status;
      record.downloadTypeHex = Buffer.from(followed.headers['content-type'] || '', 'latin1').toString('hex');
      record.downloadBodyHex = followed.body.toString('hex');
    }
  } catch (error) {
    record.error = String(error?.message || error).slice(0, 300);
  }
  results.push(record);
}

const output = JSON.stringify(results);
console.log(output);
console.log(`::notice title=Artifact MIME registration order::${output.replaceAll('%', '%25')}`);
