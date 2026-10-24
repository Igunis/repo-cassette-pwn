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

const artifactId = '12569584437';
const base = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/`;
const headers = {
  authorization: `Bearer ${process.env.GH_TOKEN}`,
  accept: 'application/vnd.github.v3+json',
  'user-agent': 'https://github.com/sindresorhus/gh-got',
};
const suffixes = [
  '',
  ';api-version=2012-02-12',
  '%3Bapi-version=2012-02-12',
  '%3Fapi-version=2012-02-12',
  '%253Fapi-version%3D2012-02-12',
  '%26api-version=2012-02-12',
  '%23api-version=2012-02-12',
  '.json',
  '.zip',
  '%00',
  '%2F..%2F',
];
const results = [];
for (const suffix of suffixes) {
  const record = { suffix };
  try {
    const first = await request(`${base}${artifactId}${suffix}/zip`, headers);
    record.status = first.status;
    const location = first.headers.location;
    if (location) {
      const url = new URL(location);
      record.host = url.hostname;
      record.rsct = url.searchParams.get('rsct');
      record.apiVersion = url.searchParams.get('api-version');
      const followed = await request(location, {
        accept: headers.accept,
        'user-agent': headers['user-agent'],
      });
      record.finalStatus = followed.status;
      record.finalTypeHex = Buffer.from(followed.headers['content-type'] || '', 'latin1').toString('hex');
      record.finalBodyHex = followed.body.subarray(0, 8).toString('hex');
    } else {
      record.errorPrefix = first.body.toString('utf8').slice(0, 60);
    }
  } catch (error) {
    record.error = String(error?.message || error).slice(0, 100);
  }
  results.push(record);
}
const output = JSON.stringify(results);
console.log(output);
console.log(`::notice title=Artifact ID path suffix probe::${output.replaceAll('%', '%25')}`);
