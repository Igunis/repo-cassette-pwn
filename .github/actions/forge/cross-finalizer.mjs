import https from 'node:https';

const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
const resultsBase = process.env.ACTIONS_RESULTS_URL;
const repositoryName = process.env.GITHUB_REPOSITORY;
const githubToken = process.env.GITHUB_TOKEN;
if (!runtimeToken || !resultsBase || !repositoryName || !githubToken) {
  throw new Error('missing GitHub Actions runtime environment');
}

const claims = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url'));
const scope = String(claims.scp || '').split(' ').find(value => value.startsWith('Actions.Results:'));
if (!scope) throw new Error('runtime token has no Actions.Results scope');
const scopeParts = scope.split(':');
const runId = scopeParts[1];
const jobId = scopeParts[2];
if (!runId || !jobId) throw new Error(`unexpected Actions.Results scope: ${scope}`);

const service = new URL('/twirp/github.actions.results.api.v1.ArtifactService/', resultsBase);
const nelType = '\u0085application/json';
const placeholder = Buffer.from('{}');
const eventSummary = [];
const candidateSummary = [];

function request(url, options = {}, body = undefined) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        rawHeaders: response.rawHeaders,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('request timeout')));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function rpc(method, document) {
  const body = Buffer.from(JSON.stringify(document));
  const response = await request(new URL(method, service), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${runtimeToken}`,
      accept: 'application/json',
      'content-type': 'application/json',
      'content-length': String(body.length),
    },
  }, body);
  let json = null;
  try { json = JSON.parse(response.body); } catch {}
  return {...response, json};
}

function summarizeRpc(response) {
  return {
    status: response.status,
    ok: response.json?.ok,
    artifactId: response.json?.artifact_id,
    code: response.json?.code,
    msg: response.json?.msg || response.json?.message,
  };
}

async function createNormal(name) {
  return rpc('CreateArtifact', {
    workflow_run_backend_id: runId,
    workflow_job_run_backend_id: jobId,
    name,
    version: 6,
    mime_type: nelType,
  });
}

async function createMigrated(name) {
  return rpc('MigrateArtifact', {
    workflow_run_backend_id: runId,
    name,
  });
}

async function finalizeNormal(name, size = placeholder.length) {
  return rpc('FinalizeArtifact', {
    workflow_run_backend_id: runId,
    workflow_job_run_backend_id: jobId,
    name,
    size: String(size),
  });
}

async function finalizeMigrated(name, size = placeholder.length) {
  return rpc('FinalizeMigratedArtifact', {
    workflow_run_backend_id: runId,
    name,
    size: String(size),
  });
}

function uploadUrl(response) {
  return response.json?.signed_upload_url || response.json?.signedUploadUrl || null;
}

async function upload(url, body, contentType = nelType) {
  if (!url) return {status: 0, error: 'no upload URL'};
  try {
    return await request(url, {
      method: 'PUT',
      headers: {
        'x-ms-version': '2023-11-03',
        'x-ms-blob-type': 'BlockBlob',
        'x-ms-blob-content-type': contentType,
        'content-type': 'application/octet-stream',
        'content-length': String(body.length),
      },
    }, body);
  } catch (error) {
    return {status: 0, error: String(error)};
  }
}

function payloadFor(artifactId) {
  const repository = `${repositoryName}/actions/artifacts/${artifactId}/zip`;
  const body = Buffer.from(JSON.stringify({
    full_name: repository,
    owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
    description: 'Repo Cassette carrier',
    stargazers_count: 0,
  }));
  return {repository, body};
}

function headerHex(response, name) {
  const value = response?.headers?.[name.toLowerCase()] || '';
  return Buffer.from(String(value), 'latin1').toString('hex');
}

async function inspectArtifact(label, artifactId, urls) {
  if (!artifactId) return;
  const {repository, body} = payloadFor(artifactId);
  const writes = [];
  for (let i = 0; i < urls.length; i++) {
    const result = await upload(urls[i], body);
    writes.push({index: i, status: result.status, error: result.error});
  }

  const apiUrl = `https://api.github.com/repos/${repositoryName}/actions/artifacts/${artifactId}/zip`;
  const redirect = await request(apiUrl, {headers: {
    authorization: `Bearer ${githubToken}`,
    accept: 'application/vnd.github.v3+json',
    'user-agent': 'repo-cassette-cross-finalizer',
  }});
  const location = redirect.headers.location || '';
  let final = null;
  if (location) final = await request(location);
  let rsct = null;
  try { rsct = new URL(location).searchParams.get('rsct'); } catch {}
  const candidate = {
    label,
    artifactId: String(artifactId),
    repository,
    writes,
    redirectStatus: redirect.status,
    rsct,
    finalStatus: final?.status,
    contentType: final?.headers?.['content-type'],
    contentTypeHex: headerHex(final, 'content-type'),
    bodyLength: final?.body.length,
    bodyMatch: final?.body.equals(body),
    bodyPrefixHex: final?.body.subarray(0, 16).toString('hex'),
  };
  candidateSummary.push(candidate);
  console.log('CANDIDATE', JSON.stringify(candidate));
}

async function runCase(label, creators, finalizers) {
  const name = `cross-${label}-${process.env.GITHUB_RUN_ID}-${Date.now()}`;
  const created = [];
  const urls = [];
  for (const kind of creators) {
    const response = kind === 'normal' ? await createNormal(name) : await createMigrated(name);
    const url = uploadUrl(response);
    created.push({kind, ...summarizeRpc(response), hasUrl: Boolean(url)});
    if (url) {
      urls.push(url);
      const marker = Buffer.from(JSON.stringify({kind, name}));
      const written = await upload(url, marker);
      created[created.length - 1].uploadStatus = written.status;
      created[created.length - 1].uploadError = written.error;
    }
  }
  console.log('CREATED', JSON.stringify({label, name, created, urlCount: urls.length,
    urlsEqual: urls.length > 1 ? urls.every(url => url === urls[0]) : null}));
  eventSummary.push({label, created: created.map(({kind, status, code, msg, hasUrl}) =>
    ({kind, status, code, msg, hasUrl})), urlCount: urls.length});

  for (let i = 0; i < finalizers.length; i++) {
    const kind = finalizers[i];
    const response = kind === 'normal' ? await finalizeNormal(name) : await finalizeMigrated(name);
    const artifactId = response.json?.artifact_id || response.json?.artifactId;
    console.log('FINALIZED', JSON.stringify({label, name, order: i, kind, ...summarizeRpc(response)}));
    eventSummary.push({label, kind, finalize: summarizeRpc(response)});
    if (artifactId) await inspectArtifact(`${label}-${i}-${kind}`, artifactId, urls);
  }
}

const cases = [
  ['a-normal-to-migrated', ['normal'], ['migrated']],
  ['b-migrated-to-normal', ['migrated'], ['normal']],
  ['c-normal-migrated-fm-fn', ['normal', 'migrated'], ['migrated', 'normal']],
  ['c2-normal-migrated-fn', ['normal', 'migrated'], ['normal']],
  ['c3-normal-migrated-fm', ['normal', 'migrated'], ['migrated']],
  ['d-migrated-normal-fn-fm', ['migrated', 'normal'], ['normal', 'migrated']],
  ['d2-migrated-normal-fm', ['migrated', 'normal'], ['migrated']],
  ['d3-migrated-normal-fn', ['migrated', 'normal'], ['normal']],
];

for (const [label, creators, finalizers] of cases) {
  try {
    await runCase(label, creators, finalizers);
  } catch (error) {
    console.log('CASE_ERROR', JSON.stringify({label, message: String(error), stack: error?.stack}));
  }
}
console.log('::notice title=Cross-finalizer events::' + JSON.stringify(eventSummary));
console.log('::notice title=Cross-finalizer candidates::' + JSON.stringify(candidateSummary));
