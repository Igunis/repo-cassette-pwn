import https from 'node:https';

function request(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { headers }, response => {
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

const artifactId = '12569642533';
const base = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${artifactId}/`;
const headers = {
  authorization: `Bearer ${process.env.GH_TOKEN}`,
  accept: 'application/vnd.github.v3+json',
  'user-agent': 'https://github.com/sindresorhus/gh-got',
};
const formats = [
  'zip',
  'zip%3Fapi-version=2012-02-12',
  'zip%3Fapi-version%3D2012-02-12',
  'zip%253Fapi-version%3D2012-02-12',
  'zip%26api-version=2012-02-12',
  'zip%3Bapi-version=2012-02-12',
  'zip%23api-version=2012-02-12',
  'zip%2F%3Fapi-version=2012-02-12',
  'zip%5C%3Fapi-version=2012-02-12',
  'zip%00%3Fapi-version=2012-02-12',
];
const results = [];
for (const format of formats) {
  const record = { format };
  try {
    const first = await request(`${base}${format}`, headers);
    record.status = first.status;
    const location = first.headers.location;
    if (location) {
      const url = new URL(location);
      record.rsct = url.searchParams.get('rsct');
      record.apiVersion = url.searchParams.get('api-version');
      record.keys = [...url.searchParams.keys()];
      const followed = await request(location, {
        accept: headers.accept,
        'user-agent': headers['user-agent'],
      });
      record.finalStatus = followed.status;
      record.finalTypeHex = Buffer.from(followed.headers['content-type'] || '', 'latin1').toString('hex');
      record.finalBodyHex = followed.body.subarray(0, 8).toString('hex');
    } else {
      record.errorPrefix = first.body.toString('utf8').slice(0, 80);
    }
  } catch (error) {
    record.error = String(error?.message || error).slice(0, 160);
  }
  results.push(record);
}
const output = JSON.stringify(results);
console.log(output);
console.log(`::notice title=Encoded artifact format query probe::${output.replaceAll('%', '%25')}`);
