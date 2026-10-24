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

function summarize(response) {
  return {
    status: response.status,
    typeHex: Buffer.from(response.headers['content-type'] || '', 'latin1').toString('hex'),
    cache: response.headers['cache-control'] || null,
    age: response.headers.age || null,
    etag: response.headers.etag || null,
    bodyHex: response.body.subarray(0, 8).toString('hex'),
  };
}

const ghHeaders = {
  authorization: `Bearer ${process.env.GH_TOKEN}`,
  accept: 'application/vnd.github.v3+json',
  'user-agent': 'https://github.com/sindresorhus/gh-got',
};
const blobHeaders = {
  accept: ghHeaders.accept,
  'user-agent': ghHeaders['user-agent'],
};
const ids = [
  ['v7-json-metadata', '12569584437'],
  ['v6-zip-metadata', '12569739244'],
];
const results = [];
for (const [label, artifactId] of ids) {
  const record = { label, artifactId };
  try {
    const api = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${artifactId}/zip`;
    const rest = await request(api, ghHeaders);
    record.restStatus = rest.status;
    if (rest.headers.location) {
      const signed = rest.headers.location;
      record.rsct = new URL(signed).searchParams.get('rsct');
      const old = signed + '&api-version=2012-02-12';
      record.downgraded = summarize(await request(old, blobHeaders));
      record.plainAfterDowngrade = summarize(await request(signed, blobHeaders));
      record.plainRepeat = summarize(await request(signed, blobHeaders));
    } else {
      record.errorPrefix = rest.body.toString('utf8').slice(0, 90);
    }
  } catch (error) {
    record.error = String(error?.message || error).slice(0, 160);
  }
  results.push(record);
}
const output = JSON.stringify(results);
console.log(output);
console.log(`::notice title=Azure MIME cache reuse probe::${output.replaceAll('%', '%25')}`);
