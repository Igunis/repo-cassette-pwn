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
const payload = Buffer.from('{}');
const ghHeaders = {
  authorization: `Bearer ${process.env.GH_TOKEN}`,
  accept: 'application/vnd.github.v3+json',
  'user-agent': 'repo-cassette-probe',
};

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

async function probeRest(id) {
  const response = await request(
    `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${id}/zip`,
    ghHeaders,
  );
  const location = response.headers.location;
  const downloaded = location ? await request(location) : null;
  return {
    status: response.status,
    rsct: location ? new URL(location).searchParams.get('rsct') : null,
    contentType: downloaded?.headers['content-type'] || null,
    matches: Boolean(downloaded?.body.equals(payload)),
  };
}

async function probeListing(name) {
  const response = await request(
    `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/artifacts`,
    ghHeaders,
  );
  let ids = [];
  try {
    ids = JSON.parse(response.body.toString()).artifacts
      .filter(item => item.name === name)
      .map(item => item.id);
  } catch {}
  return { status: response.status, ids };
}

const results = [];
for (const version of [6, 7]) {
  const name = `unfinalized-${process.env.GITHUB_RUN_ID}-v${version}.json`;
  const result = { version };
  try {
    const created = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      version,
      mimeType: StringValue.create({ value: version === 7 ? 'application/json' : nel }),
    });
    await new BlobClient(created.signedUploadUrl).getBlockBlobClient().uploadData(payload, {
      blobHTTPHeaders: { blobContentType: nel },
    });
    try {
      const listed = await client.ListArtifacts({
        workflowRunBackendId: ids.workflowRunBackendId,
        workflowJobRunBackendId: ids.workflowJobRunBackendId,
        nameFilter: StringValue.create({ value: name }),
      });
      result.internalIds = listed.artifacts.map(item => item.databaseId);
    } catch (error) {
      result.internalListError = String(error?.message || error).slice(0, 120);
    }
    result.restListBefore = await probeListing(name);
    const allIds = [...new Set([...(result.internalIds || []), ...result.restListBefore.ids])];
    result.preFinalizeDownloads = [];
    for (const id of allIds) result.preFinalizeDownloads.push({ id, ...await probeRest(id) });
    try {
      const signed = await client.GetSignedArtifactURL({
        workflowRunBackendId: ids.workflowRunBackendId,
        workflowJobRunBackendId: ids.workflowJobRunBackendId,
        name,
      });
      const direct = await request(signed.signedUrl);
      result.internalDownload = {
        rsct: new URL(signed.signedUrl).searchParams.get('rsct'),
        status: direct.status,
        typeHex: Buffer.from(direct.headers['content-type'] || '', 'latin1').toString('hex'),
        matches: direct.body.equals(payload),
      };
    } catch (error) {
      result.internalDownloadError = String(error?.message || error).slice(0, 120);
    }
    const finalized = await client.FinalizeArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      size: String(payload.length),
    });
    result.finalizedId = finalized.artifactId;
    result.restAfter = await probeRest(finalized.artifactId);
  } catch (error) {
    result.error = String(error?.message || error).slice(0, 220);
  }
  results.push(result);
}
const output = JSON.stringify(results);
console.log(output);
console.log(`::notice title=Unfinalized artifact visibility::${output.replaceAll('%', '%25')}`);
