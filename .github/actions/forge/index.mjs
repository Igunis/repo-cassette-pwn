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

const priorRunId = '40119900419';
const base = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${priorRunId}`;
const headers = {
  authorization: `Bearer ${process.env.GH_TOKEN}`,
  accept: 'application/vnd.github.v3+json',
  'user-agent': 'https://github.com/sindresorhus/gh-got',
};
const variants = [
  ['run-logs', `${base}/logs`],
  ['attempt-1-logs', `${base}/attempts/1/logs`],
  ['run-logs-raw-query', `${base}/logs?format=raw`],
  ['attempt-logs-raw-query', `${base}/attempts/1/logs?format=raw`],
];
const results = [];
for (const [label, url] of variants) {
  const record = { label };
  try {
    const first = await request(url, headers);
    record.status = first.status;
    if (first.headers.location) {
      const location = first.headers.location;
      const parsed = new URL(location);
      record.host = parsed.host;
      record.rsct = parsed.searchParams.get('rsct');
      record.rscd = parsed.searchParams.get('rscd');
      record.locationKeys = [...parsed.searchParams.keys()];
      const followed = await request(location, {
        accept: headers.accept,
        'user-agent': headers['user-agent'],
      });
      record.finalStatus = followed.status;
      record.finalTypeHex = Buffer.from(followed.headers['content-type'] || '', 'latin1').toString('hex');
      record.finalBytes = followed.body.length;
      record.finalPrefixHex = followed.body.subarray(0, 12).toString('hex');
    } else {
      record.errorPrefix = first.body.toString('utf8').slice(0, 120);
    }
  } catch (error) {
    record.error = String(error?.message || error).slice(0, 160);
  }
  results.push(record);
}
const output = JSON.stringify(results);
console.log(output);
console.log(`::notice title=Completed workflow log MIME probe::${output.replaceAll('%', '%25')}`);
