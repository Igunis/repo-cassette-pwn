import https from 'node:https';

const runtime = process.env.ACTIONS_RUNTIME_TOKEN;
const results = process.env.ACTIONS_RESULTS_URL;
const repo = process.env.GITHUB_REPOSITORY;
const ghToken = process.env.GITHUB_TOKEN;
const claims = JSON.parse(Buffer.from(runtime.split('.')[1], 'base64url'));
const scope = claims.scp.split(' ').find(x => x.startsWith('Actions.Results:'));
const [, run, job] = scope.split(':');
const service = new URL('/twirp/github.actions.results.api.v1.ArtifactService/', results);
const nel = '\u0085application/json';
const body = Buffer.from('{}');

function request(url, options = {}, payload) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, res => {
      const parts = [];
      res.on('data', x => parts.push(x));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(parts)}));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

async function rpc(method, doc) {
  const payload = Buffer.from(JSON.stringify(doc));
  const res = await request(new URL(method, service), {
    method: 'POST', headers: {
      authorization: `Bearer ${runtime}`,
      'content-type': 'application/json',
      'content-length': String(payload.length),
    },
  }, payload);
  let data;
  try { data = JSON.parse(res.body); } catch { data = {}; }
  return {status: res.status, data};
}

async function one(mime, index) {
  const name = `default-mime-${process.env.GITHUB_RUN_ID}-${index}`;
  const common = {workflow_run_backend_id: run, workflow_job_run_backend_id: job, name};
  const created = await rpc('CreateArtifact', {...common, version: 7, mime_type: mime});
  if (created.status !== 200) return {mime, create: created.status, error: created.data.msg || created.data.message};
  const put = await request(created.data.signed_upload_url, {
    method: 'PUT', headers: {
      'x-ms-version': '2023-11-03',
      'x-ms-blob-type': 'BlockBlob',
      'x-ms-blob-content-type': nel,
      'content-type': 'application/octet-stream',
      'content-length': String(body.length),
    },
  }, body);
  if (put.status !== 201) return {mime, create: created.status, put: put.status};
  const finished = await rpc('FinalizeArtifact', {...common, size: String(body.length)});
  const id = finished.data.artifact_id;
  if (finished.status !== 200 || !id) return {mime, create: created.status, put: put.status, finalize: finished.status};
  const api = await request(`https://api.github.com/repos/${repo}/actions/artifacts/${id}/zip`, {
    headers: {
      authorization: `Bearer ${ghToken}`,
      accept: 'application/vnd.github.v3+json',
      'user-agent': 'repo-cassette-default-mime-probe',
    },
  });
  let rsct = null;
  let final = null;
  if (api.headers.location) {
    rsct = new URL(api.headers.location).searchParams.get('rsct');
    const blob = await request(api.headers.location);
    final = {status: blob.status, type: blob.headers['content-type'], bodyMatch: blob.body.equals(body)};
  }
  return {mime, id, api: api.status, rsct, final};
}

const variants = [
  'application/json',
  'application/octet-stream',
  'binary/octet-stream',
  'application/zip',
  'application/x-zip-compressed',
  'text/plain',
  'application/x-binary',
  'application/vnd.github+json',
  'image/png',
];
for (let start = 0; start < variants.length; start += 3) {
  const rows = await Promise.all(variants.slice(start, start + 3).map((mime, n) => one(mime, start + n)));
  for (const row of rows) {
    console.log('DEFAULT_MIME', JSON.stringify(row));
    console.log(`::notice title=DEFAULT_MIME::${JSON.stringify(row)}`);
  }
}
