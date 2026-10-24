import https from 'node:https';

const artifactEntry = import.meta.resolve('@actions/artifact');
const artifactLib = new URL('.', artifactEntry);
const { getBackendIdsFromToken } = await import(new URL('internal/shared/util.js', artifactLib));

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

const apiHeaders = {
  authorization: `Bearer ${process.env.GH_TOKEN}`,
  accept: 'application/vnd.github.v3+json',
  'user-agent': 'repo-cassette-probe',
  'x-github-api-version': '2022-11-28',
};
const tag = `accept-probe-${process.env.GITHUB_RUN_ID}`;
const releaseBody = Buffer.from(JSON.stringify({
  tag_name: tag,
  name: tag,
  draft: false,
  prerelease: true,
}));
const releaseResponse = await request(
  `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/releases`,
  {
    method: 'POST',
    headers: {
      ...apiHeaders,
      'content-type': 'application/json',
      'content-length': String(releaseBody.length),
    },
  },
  releaseBody,
);
if (releaseResponse.status !== 201) {
  throw new Error(`Release creation failed: ${releaseResponse.status} ${releaseResponse.body.toString().slice(0, 300)}`);
}
const release = JSON.parse(releaseResponse.body.toString());
const uploadBase = release.upload_url.replace('{?name,label}', '');
const types = [
  'application/vnd.github.v3+json',
  'application/vnd.github+json',
  'application/vnd.github.raw+json',
  'application/json',
];
const results = [];
for (let index = 0; index < types.length; index++) {
  const type = types[index];
  const payload = Buffer.from(JSON.stringify({ probe: index, type }));
  const upload = await request(`${uploadBase}?name=${encodeURIComponent(`match-${index}.json`)}`, {
    method: 'POST',
    headers: {
      ...apiHeaders,
      'content-type': type,
      'content-length': String(payload.length),
    },
  }, payload);
  let asset;
  try { asset = JSON.parse(upload.body.toString()); } catch {}
  if (!asset?.id) {
    results.push({ type, uploadStatus: upload.status, uploadError: upload.body.toString().slice(0, 160) });
    continue;
  }
  const response = await request(
    `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/releases/assets/${asset.id}`,
    { headers: apiHeaders },
  );
  const followed = response.headers.location ? await request(response.headers.location) : null;
  results.push({
    type,
    assetId: asset.id,
    storedType: asset.content_type,
    status: response.status,
    responseType: response.headers['content-type'] || null,
    redirect: Boolean(response.headers.location),
    payload: response.body.equals(payload) || Boolean(followed?.body.equals(payload)),
    followedType: followed?.headers['content-type'] || null,
  });
}

const output = JSON.stringify(results);
console.log(output);
console.log(`::notice title=Release Accept matching probe::${output.replaceAll('%', '%25')}`);

const ids = getBackendIdsFromToken();
const createUrl = new URL(
  'twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact',
  process.env.ACTIONS_RESULTS_URL,
);
const finalizeUrl = new URL(
  'twirp/github.actions.results.api.v1.ArtifactService/FinalizeArtifact',
  process.env.ACTIONS_RESULTS_URL,
);
const invalid = 'application/json\\u0085';
const valid = 'application/json';
const cases = [
  ['plain-invalid', `"mime_type":"${invalid}"`],
  ['dup-valid-invalid', `"mime_type":"${valid}","mime_type":"${invalid}"`],
  ['dup-invalid-valid', `"mime_type":"${invalid}","mime_type":"${valid}"`],
  ['alias-invalid-valid', `"mime_type":"${invalid}","mimeType":"${valid}"`],
  ['alias-valid-invalid', `"mime_type":"${valid}","mimeType":"${invalid}"`],
  ['wrapper-invalid', `"mime_type":{"value":"${invalid}"}`],
];
const twirpHeaders = {
  authorization: `Bearer ${process.env.ACTIONS_RUNTIME_TOKEN}`,
  accept: 'application/json',
  'content-type': 'application/json',
};
const mimeResults = [];
for (const [label, mimeFields] of cases) {
  const name = `json-conflict-${process.env.GITHUB_RUN_ID}-${label}.json`;
  const createText = `{` +
    `"workflow_run_backend_id":${JSON.stringify(ids.workflowRunBackendId)},` +
    `"workflow_job_run_backend_id":${JSON.stringify(ids.workflowJobRunBackendId)},` +
    `"name":${JSON.stringify(name)},"version":7,${mimeFields}}`;
  const createBody = Buffer.from(createText);
  let created;
  try {
    created = await request(createUrl, {
      method: 'POST',
      headers: { ...twirpHeaders, 'content-length': String(createBody.length) },
    }, createBody);
  } catch (error) {
    mimeResults.push({ label, requestError: String(error?.message || error) });
    continue;
  }
  let createdJson;
  try { createdJson = JSON.parse(created.body.toString()); } catch {}
  const result = {
    label,
    createStatus: created.status,
    createOk: createdJson?.ok || false,
    error: created.status === 200 ? null : created.body.toString().slice(0, 140),
  };
  if (createdJson?.signed_upload_url) {
    const payload = Buffer.from('{}');
    result.uploadStatus = (await request(createdJson.signed_upload_url, {
      method: 'PUT',
      headers: {
        'x-ms-blob-type': 'BlockBlob',
        'content-type': 'application/x-probe',
        'content-length': String(payload.length),
      },
    }, payload)).status;
    const finalizeBody = Buffer.from(JSON.stringify({
      workflow_run_backend_id: ids.workflowRunBackendId,
      workflow_job_run_backend_id: ids.workflowJobRunBackendId,
      name,
      size: '2',
    }));
    const finalized = await request(finalizeUrl, {
      method: 'POST',
      headers: { ...twirpHeaders, 'content-length': String(finalizeBody.length) },
    }, finalizeBody);
    let finalizedJson;
    try { finalizedJson = JSON.parse(finalized.body.toString()); } catch {}
    result.finalizeStatus = finalized.status;
    result.artifactId = finalizedJson?.artifact_id || null;
    if (result.artifactId) {
      const download = await request(
        `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${result.artifactId}/zip`,
        { method: 'HEAD', headers: apiHeaders },
      );
      result.restStatus = download.status;
      result.rsct = download.headers.location
        ? new URL(download.headers.location).searchParams.get('rsct')
        : null;
    }
  }
  mimeResults.push(result);
}

const redirectPaths = [
  '///example.com/a',
  '//example.com/a',
  '/%2f%2fexample.com/a',
  '/%5c%5cexample.com/a',
];
const redirectResults = [];
for (const candidate of redirectPaths) {
  try {
    const response = await request(`https://api.github.com${candidate}`, { method: 'HEAD', headers: apiHeaders });
    redirectResults.push({
      candidate,
      status: response.status,
      location: response.headers.location || null,
    });
  } catch (error) {
    redirectResults.push({ candidate, requestError: String(error?.message || error) });
  }
}
const completedJobId = '120933913998';
const stepLogResults = [];
for (let step = 1; step <= 9; step++) {
  const response = await request(
    `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/jobs/${completedJobId}/steps/${step}/logs`,
    { method: 'HEAD', headers: apiHeaders },
  );
  const location = response.headers.location;
  const url = location ? new URL(location) : null;
  stepLogResults.push({
    step,
    status: response.status,
    rsct: url?.searchParams.get('rsct') || null,
    keys: url ? [...url.searchParams.keys()] : null,
  });
}
const backendOutput = JSON.stringify({ mimeResults, redirectResults, stepLogResults });
console.log(backendOutput);
console.log(`::notice title=Artifact JSON conflict probe::${backendOutput.replaceAll('%', '%25')}`);
