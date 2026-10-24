import https from 'node:https';
import { BlobClient } from '@azure/storage-blob';

const artifactEntry = import.meta.resolve('@actions/artifact');
const artifactLib = new URL('.', artifactEntry);
const [{ internalArtifactTwirpClient }, { getBackendIdsFromToken }, generated] = await Promise.all([
  import(new URL('internal/shared/artifact-twirp-client.js', artifactLib)),
  import(new URL('internal/shared/util.js', artifactLib)),
  import(new URL('generated/index.js', artifactLib)),
]);
const { CreateArtifactRequest, CreateArtifactResponse, StringValue } = generated;
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
    if (body) req.write(body);
    req.end();
  });
}

function outerField(value) {
  const nested = Buffer.from(StringValue.toBinary(StringValue.create({ value })));
  if (nested.length >= 128) throw new Error('Unexpected wrapper length');
  return Buffer.concat([Buffer.from([0x32, nested.length]), nested]);
}

function innerField(value) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length >= 128) throw new Error('Unexpected inner length');
  return Buffer.concat([Buffer.from([0x0a, bytes.length]), bytes]);
}

function mergedWrapper(first, second) {
  const nested = Buffer.concat([innerField(first), innerField(second)]);
  if (nested.length >= 128) throw new Error('Unexpected merged length');
  return Buffer.concat([Buffer.from([0x32, nested.length]), nested]);
}

const cases = [
  ['outer-valid-then-nel', name => [outerField('application/json'), outerField(nel)]],
  ['outer-nel-then-valid', name => [outerField(nel), outerField('application/json')]],
  ['inner-valid-then-nel', name => [mergedWrapper('application/json', nel)]],
  ['inner-nel-then-valid', name => [mergedWrapper(nel, 'application/json')]],
];
const endpoint = `${new URL(process.env.ACTIONS_RESULTS_URL).origin}/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact`;
const ghHeaders = {
  authorization: `Bearer ${process.env.GH_TOKEN}`,
  accept: 'application/vnd.github.v3+json',
  'user-agent': 'repo-cassette-probe',
};
const results = [];
for (const [label, fields] of cases) {
  const name = `dup-mime-${process.env.GITHUB_RUN_ID}-${label}.json`;
  const base = Buffer.from(CreateArtifactRequest.toBinary(CreateArtifactRequest.create({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    version: 7,
  })));
  const body = Buffer.concat([base, ...fields(name)]);
  const record = { label };
  try {
    const response = await request(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.ACTIONS_RUNTIME_TOKEN}`,
        'content-type': 'application/protobuf',
        accept: 'application/protobuf',
        'content-length': String(body.length),
      },
    }, body);
    record.createStatus = response.status;
    if (response.status !== 200) {
      record.createError = response.body.toString('utf8').slice(0, 220);
      results.push(record);
      continue;
    }
    const created = CreateArtifactResponse.fromBinary(response.body);
    record.created = Boolean(created.ok && created.signedUploadUrl);
    if (!record.created) {
      results.push(record);
      continue;
    }
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
    record.artifactId = finalized.artifactId;
    const rest = await request(
      `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${finalized.artifactId}/zip`,
      { headers: ghHeaders },
    );
    record.restStatus = rest.status;
    record.rsct = rest.headers.location ? new URL(rest.headers.location).searchParams.get('rsct') : null;
    if (rest.headers.location) {
      const downloaded = await request(rest.headers.location);
      record.downloadTypeHex = Buffer.from(downloaded.headers['content-type'] || '', 'latin1').toString('hex');
      record.downloadBodyMatches = downloaded.body.equals(payload);
    }
  } catch (error) {
    record.error = String(error?.message || error).slice(0, 240);
  }
  results.push(record);
}
const output = JSON.stringify(results);
console.log(output);
console.log(`::notice title=Duplicate protobuf MIME fields::${output.replaceAll('%', '%25')}`);
