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

const jobId = '120936234407';
const baseHeaders = {
  authorization: `Bearer ${process.env.GH_TOKEN}`,
  accept: 'application/vnd.github.v3+json',
  'user-agent': 'https://github.com/sindresorhus/gh-got',
};
const suffixes = [
  '', '.json', '.raw', '.txt', '%C2%85', '.json%C2%85',
  ';json', '?apiVersion=2026-03-10', '?api-version=2026-03-10',
  '?format=json', '?format=raw', '?callback=', '?callback=x',
];
const versions = [null, '2022-11-28', '2026-03-10'];
const results = [];
for (const version of versions) {
  const headers = { ...baseHeaders };
  if (version) headers['x-github-api-version'] = version;
  for (const suffix of suffixes) {
    const response = await request(
      `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/jobs/${jobId}/logs${suffix}`,
      { method: 'GET', headers },
    );
    const location = response.headers.location;
    const url = location ? new URL(location) : null;
    results.push({
      version: version || 'default',
      suffix: suffix || 'plain',
      status: response.status,
      rsct: url?.searchParams.get('rsct') || null,
      apiVersion: url?.searchParams.get('api-version') || null,
    });
  }
}

const output = JSON.stringify(results);
console.log(output);
console.log(`::notice title=Job log route variants::${output.replaceAll('%', '%25')}`);
