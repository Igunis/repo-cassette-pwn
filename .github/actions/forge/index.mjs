import https from 'node:https';
import { BlobClient } from '@azure/storage-blob';

const artifactEntry = import.meta.resolve('@actions/artifact');
const artifactLib = new URL('.', artifactEntry);
const [{ internalArtifactTwirpClient }, { getBackendIdsFromToken }, generated] = await Promise.all([
  import(new URL('internal/shared/artifact-twirp-client.js', artifactLib)),
  import(new URL('internal/shared/util.js', artifactLib)),
  import(new URL('generated/index.js', artifactLib)),
]);
const { FinalizeArtifactRequest, FinalizeArtifactResponse, StringValue } = generated;
const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({ maxAttempts: 1 });
const nel = `application/json${String.fromCharCode(0x85)}`;

function request(url, options = {}, body = undefined) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, response => {
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
    req.end(body);
  });
}

const name = `finalize-mime-${process.env.GITHUB_RUN_ID}.json`;
const common = { ...ids, name };
const result = { name };
try {
  const created = await client.CreateArtifact({
    ...common,
    version: 7,
    mimeType: StringValue.create({ value: 'application/json' }),
  });
  result.created = Boolean(created.ok && created.signedUploadUrl);
  if (!result.created) throw new Error('CreateArtifact returned no signed upload URL');

  const payload = Buffer.from('{}');
  await new BlobClient(created.signedUploadUrl).getBlockBlobClient().uploadData(payload, {
    blobHTTPHeaders: { blobContentType: nel },
  });

  const base = Buffer.from(FinalizeArtifactRequest.toBinary(FinalizeArtifactRequest.create({
    ...common,
    size: String(payload.length),
  })));
  const wrapped = Buffer.from(StringValue.toBinary(StringValue.create({ value: nel })));
  if (wrapped.length >= 128) throw new Error('Unexpected wrapper size');
  const body = Buffer.concat([base, Buffer.from([0x32, wrapped.length]), wrapped]);
  const endpoint = `${new URL(process.env.ACTIONS_RESULTS_URL).origin}/twirp/github.actions.results.api.v1.ArtifactService/FinalizeArtifact`;
  const finalized = await request(endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.ACTIONS_RUNTIME_TOKEN}`,
      'content-type': 'application/protobuf',
      accept: 'application/protobuf',
      'content-length': String(body.length),
    },
  }, body);
  result.finalizeStatus = finalized.status;
  if (finalized.status !== 200) {
    result.finalizeError = finalized.body.toString('utf8').slice(0, 240);
  } else {
    const parsed = FinalizeArtifactResponse.fromBinary(finalized.body);
    result.artifactId = parsed.artifactId;
    result.finalized = parsed.ok;
    const rest = await request(
      `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${parsed.artifactId}/zip`,
      { headers: {
        authorization: `Bearer ${process.env.GH_TOKEN}`,
        accept: 'application/vnd.github.v3+json',
        'user-agent': 'https://github.com/sindresorhus/gh-got',
      } },
    );
    result.restStatus = rest.status;
    if (rest.headers.location) {
      result.rsct = new URL(rest.headers.location).searchParams.get('rsct');
      const followed = await request(rest.headers.location);
      result.downloadStatus = followed.status;
      result.downloadTypeHex = Buffer.from(followed.headers['content-type'] || '', 'latin1').toString('hex');
      result.bodyMatches = followed.body.equals(payload);
    }
  }
} catch (error) {
  result.error = String(error?.message || error).slice(0, 300);
}

const output = JSON.stringify(result);
console.log(output);
console.log(`::notice title=Finalize artifact MIME override::${output.replaceAll('%', '%25')}`);
