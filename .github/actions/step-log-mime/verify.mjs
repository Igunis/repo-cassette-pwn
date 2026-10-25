import https from 'node:https';

const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const job = process.env.CARRIER_JOB_ID;
const step = process.env.CARRIER_STEP_NO;
function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, res => {
      const parts = [];
      res.on('data', x => parts.push(x));
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(parts)}));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}
for (const [label, path] of [['step', `/actions/jobs/${job}/steps/${step}/logs`], ['job', `/actions/jobs/${job}/logs`]]) {
  for (const version of ['2026-03-10', '2022-11-28']) {
    const api = await request(`https://api.github.com/repos/${repo}${path}`, {headers: {
      authorization: `Bearer ${token}`, accept: 'application/vnd.github.v3+json',
      'x-github-api-version': version, 'user-agent': 'step-log-mime-probe',
    }});
    let rsct = null;
    let final = null;
    if (api.headers.location) {
      rsct = new URL(api.headers.location).searchParams.get('rsct');
      const blob = await request(api.headers.location);
      final = {status: blob.status, type: blob.headers['content-type'], bodyStart: blob.body.subarray(0, 45).toString()};
    }
    const row = {label, version, api: api.status, rsct, final};
    console.log('STEP_LOG_VERIFY', JSON.stringify(row));
    console.log(`::notice title=STEP_LOG_VERIFY::${JSON.stringify(row)}`);
  }
}
