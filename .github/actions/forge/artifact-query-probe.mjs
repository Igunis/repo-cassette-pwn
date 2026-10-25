import https from 'node:https';

const repo = 'Igunis/repo-cassette-pwn';
const repoId = 1432329048;
const artifactId = 12569682558;
const assetId = 672783444;
const headers = {
  authorization: `token ${process.env.GH_TOKEN}`,
  accept: 'application/vnd.github.v3+json',
  'user-agent': 'https://github.com/sindresorhus/gh-got',
};

function request(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {headers}, res => {
      res.resume();
      res.on('end', () => resolve({status: res.statusCode, headers: res.headers}));
    });
    req.on('error', reject);
    req.setTimeout(7000, () => req.destroy(new Error('timeout')));
  });
}

const routes = [
  ['artifact-named', `/repos/${repo}/actions/artifacts/${artifactId}/zip`],
  ['artifact-numeric', `/repositories/${repoId}/actions/artifacts/${artifactId}/zip`],
  ['asset-named', `/repos/${repo}/releases/assets/${assetId}`],
  ['asset-numeric', `/repositories/${repoId}/releases/assets/${assetId}`],
];

const rows = [];
for (const [label, path] of routes) {
  try {
    const result = await request(`https://api.github.com${path}`);
    const target = result.headers.location ? new URL(result.headers.location) : null;
    rows.push({
      label,
      status: result.status,
      contentType: result.headers['content-type'] || null,
      locationHost: target?.hostname || null,
      locationPath: target?.pathname || null,
      rsct: target?.searchParams.get('rsct') || null,
    });
  } catch (error) {
    rows.push({label, error: String(error?.message || error).slice(0, 100)});
  }
}
console.log(`::notice title=Numeric repository download routes::${JSON.stringify(rows).replaceAll('%', '%25')}`);
