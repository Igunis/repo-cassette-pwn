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

const name = `valid-then-rejected-${process.env.GITHUB_RUN_ID}.json`;
const common = { ...ids, name };
const result = { name };
try {
  const first = await client.CreateArtifact({
    ...common,
    version: 7,
    mimeType: StringValue.create({ value: 'application/json' }),
  });
  result.firstCreated = Boolean(first.ok && first.signedUploadUrl);
  if (!result.firstCreated) throw new Error('First CreateArtifact failed');

  try {
    const second = await client.CreateArtifact({
      ...common,
      version: 7,
      mimeType: StringValue.create({ value: nel }),
    });
    result.secondCreated = Boolean(second.ok && second.signedUploadUrl);
  } catch (error) {
    result.secondError = String(error?.message || error).slice(0, 240);
  }

  const payload = Buffer.from('{}');
  await new BlobClient(first.signedUploadUrl).getBlockBlobClient().uploadData(payload, {
    blobHTTPHeaders: { blobContentType: nel },
  });
  const finalized = await client.FinalizeArtifact({ ...common, size: String(payload.length) });
  result.artifactId = finalized.artifactId;
  const rest = await request(
    `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${finalized.artifactId}/zip`,
    {
      authorization: `Bearer ${process.env.GH_TOKEN}`,
      accept: 'application/vnd.github.v3+json',
      'user-agent': 'https://github.com/sindresorhus/gh-got',
    },
  );
  result.restStatus = rest.status;
  if (rest.headers.location) {
    result.rsct = new URL(rest.headers.location).searchParams.get('rsct');
    const followed = await request(rest.headers.location);
    result.downloadStatus = followed.status;
    result.downloadTypeHex = Buffer.from(followed.headers['content-type'] || '', 'latin1').toString('hex');
    result.bodyMatches = followed.body.equals(payload);
  }
} catch (error) {
  result.error = String(error?.message || error).slice(0, 300);
}

const output = JSON.stringify(result);
console.log(output);
console.log(`::notice title=Valid then rejected artifact MIME::${output.replaceAll('%', '%25')}`);
