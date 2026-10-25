import https from 'node:https';

const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
const resultsBase = process.env.ACTIONS_RESULTS_URL;
const repo = process.env.GITHUB_REPOSITORY;
const apiToken = process.env.GITHUB_TOKEN;
const claims = JSON.parse(Buffer.from(runtimeToken.split('.')[1], 'base64url'));
const scope = claims.scp.split(' ').find(x => x.startsWith('Actions.Results:'));
const [, run, job] = scope.split(':');
const service = new URL('/twirp/github.actions.results.api.v1.ArtifactService/', resultsBase);
const nel = '\u0085application/json';

function request(url, options = {}, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)}));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

async function rpc(method, doc) {
  const body = Buffer.from(JSON.stringify(doc));
  const response = await request(new URL(method, service), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${runtimeToken}`,
      'content-type': 'application/json',
      'content-length': String(body.length),
    },
  }, body);
  let data;
  try { data = JSON.parse(response.body.toString()); } catch { data = {}; }
  return {status: response.status, data};
}

async function upload(url) {
  if (!url) return null;
  const body = Buffer.from('{}');
  const response = await request(url, {
    method: 'PUT',
    headers: {
      'x-ms-version': '2023-11-03',
      'x-ms-blob-type': 'BlockBlob',
      'x-ms-blob-content-type': nel,
      'content-type': 'application/octet-stream',
      'content-length': String(body.length),
    },
  }, body);
  return response.status;
}

async function inspect(id) {
  if (!id) return null;
  const api = await request(`https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`, {
    headers: {
      authorization: `Bearer ${apiToken}`,
      accept: 'application/vnd.github.v3+json',
      'user-agent': 'repo-cassette-migration-probe',
    },
  });
  const location = api.headers.location;
  let rsct = null;
  let final = null;
  if (location) {
    rsct = new URL(location).searchParams.get('rsct');
    const blob = await request(location);
    final = {status: blob.status, type: blob.headers['content-type'], body: blob.body.toString('utf8')};
  }
  return {apiStatus: api.status, rsct, final};
}

const common = {workflow_run_backend_id: run, workflow_job_run_backend_id: job};
const cases = [
  {label: 'migrate-only', creators: ['migrate'], finalizer: 'migrated'},
  {label: 'migrate-to-normal', creators: ['migrate'], finalizer: 'normal'},
  {label: 'normal-to-migrated', creators: ['normal'], finalizer: 'migrated'},
  {label: 'normal-migrate-to-normal', creators: ['normal', 'migrate'], finalizer: 'normal'},
  {label: 'normal-migrate-to-migrated', creators: ['normal', 'migrate'], finalizer: 'migrated'},
  {label: 'migrate-normal-to-normal', creators: ['migrate', 'normal'], finalizer: 'normal'},
  {label: 'migrate-normal-to-migrated', creators: ['migrate', 'normal'], finalizer: 'migrated'},
];

for (const item of cases) {
  const name = `migration-mime-${item.label}-${process.env.GITHUB_RUN_ID}`;
  const creates = [];
  for (const kind of item.creators) {
    const method = kind === 'migrate' ? 'MigrateArtifact' : 'CreateArtifact';
    const args = kind === 'migrate'
      ? {workflow_run_backend_id: run, name}
      : {...common, name, version: 6, mime_type: nel};
    const result = await rpc(method, args);
    const url = result.data.signed_upload_url || result.data.signedUploadUrl;
    const put = result.status === 200 ? await upload(url) : null;
    creates.push({kind, status: result.status, code: result.data.code, message: result.data.msg || result.data.message, put});
  }
  const method = item.finalizer === 'migrated' ? 'FinalizeMigratedArtifact' : 'FinalizeArtifact';
  const args = item.finalizer === 'migrated'
    ? {workflow_run_backend_id: run, name, size: '2'}
    : {...common, name, size: '2'};
  const result = await rpc(method, args);
  const id = result.data.artifact_id || result.data.artifactId;
  const response = await inspect(id);
  console.log('MIGRATION_PROBE', JSON.stringify({label: item.label, creates, finalize: {status: result.status, code: result.data.code, message: result.data.msg || result.data.message, id}, response}));
}
