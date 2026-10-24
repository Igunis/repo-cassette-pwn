import https from 'node:https';

function request(url, options = {}) {
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
    req.end();
  });
}

const jobId = '120933913998';
const baseHeaders = {
  authorization: `Bearer ${process.env.GH_TOKEN}`,
  accept: 'application/vnd.github.v3+json',
  'user-agent': 'repo-cassette-probe',
};
const detail = await request(
  `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/jobs/${jobId}`,
  { headers: baseHeaders },
);
let detailJson;
try { detailJson = JSON.parse(detail.body.toString()); } catch {}
const stepNumbers = (detailJson?.steps || []).map(step => step.number);
const versions = [null, '2022-11-28', '2026-03-10'];
const results = [];
for (const version of versions) {
  const headers = { ...baseHeaders };
  if (version) headers['x-github-api-version'] = version;
  for (const step of stepNumbers) {
    const response = await request(
      `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/jobs/${jobId}/steps/${step}/logs`,
      { method: 'GET', headers },
    );
    const location = response.headers.location;
    const url = location ? new URL(location) : null;
    results.push({
      version: version || 'default',
      step,
      status: response.status,
      rsct: url?.searchParams.get('rsct') || null,
      keys: url ? [...url.searchParams.keys()] : null,
      error: location ? null : response.body.toString().slice(0, 100),
    });
  }
}

const output = JSON.stringify({ detailStatus: detail.status, stepNumbers, results });
console.log(output);
console.log(`::notice title=Step log GET probe::${output.replaceAll('%', '%25')}`);
