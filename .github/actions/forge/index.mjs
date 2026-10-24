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

const assetId = '672842245';
const headers = {
  authorization: `Bearer ${process.env.GH_TOKEN}`,
  accept: 'application/vnd.github.v3+json',
  'user-agent': 'https://github.com/sindresorhus/gh-got',
};
const suffixes = [
  '', '.json', '.zip', '.raw', '.bin', '.octet-stream', '.download',
  '.tar', '.gz', '?format=zip', '?format=octet-stream', '?format=download',
  '?download=true', '?download=1', '?archive_format=zip',
];
const results = [];
for (const suffix of suffixes) {
  const response = await request(
    `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/releases/assets/${assetId}${suffix}`,
    { method: 'GET', headers },
  );
  results.push({
    suffix: suffix || 'plain',
    status: response.status,
    type: response.headers['content-type'] || null,
    redirect: Boolean(response.headers.location),
    bytes: response.body.length,
  });
}

const output = JSON.stringify(results);
console.log(output);
console.log(`::notice title=Release format routes::${output.replaceAll('%', '%25')}`);
