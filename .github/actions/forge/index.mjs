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

function details(response) {
  return {
    status: response.status,
    typeHex: Buffer.from(response.headers['content-type'] || '', 'latin1').toString('hex'),
    bytes: response.body.length,
    prefixHex: response.body.subarray(0, 10).toString('hex'),
  };
}

const priorRunId = '40119900419';
const repo = process.env.GITHUB_REPOSITORY;
const ghHeaders = {
  authorization: `Bearer ${process.env.GH_TOKEN}`,
  accept: 'application/vnd.github.v3+json',
  'user-agent': 'https://github.com/sindresorhus/gh-got',
};
const blobHeaders = { accept: ghHeaders.accept, 'user-agent': ghHeaders['user-agent'] };
const results = [];
for (const [label, path] of [
  ['run', `runs/${priorRunId}/logs`],
  ['attempt', `runs/${priorRunId}/attempts/1/logs`],
]) {
  const record = { label };
  try {
    const first = await request(`https://api.github.com/repos/${repo}/actions/${path}`, ghHeaders);
    record.restStatus = first.status;
    if (first.headers.location) {
      const signed = new URL(first.headers.location);
      record.path = signed.pathname;
      record.filename = signed.searchParams.get('filename');
      record.queryKeys = [...signed.searchParams.keys()];
      const variants = [
        ['original', u => u],
        ['filename-json', u => { u.searchParams.set('filename', 'probe.json'); return u; }],
        ['duplicate-filename', u => { u.searchParams.append('filename', 'probe.json'); return u; }],
        ['content-type-override', u => { u.searchParams.append('response-content-type', 'application/json\u0085'); return u; }],
        ['api-version', u => { u.searchParams.append('api-version', '2012-02-12'); return u; }],
      ];
      record.variants = [];
      for (const [variant, mutate] of variants) {
        try {
          const url = mutate(new URL(signed));
          record.variants.push({ variant, ...details(await request(url, blobHeaders)) });
        } catch (error) {
          record.variants.push({ variant, error: String(error?.message || error).slice(0, 90) });
        }
      }
    } else {
      record.errorPrefix = first.body.toString('utf8').slice(0, 90);
    }
  } catch (error) {
    record.error = String(error?.message || error).slice(0, 140);
  }
  results.push(record);
}
const output = JSON.stringify(results);
console.log(output);
console.log(`::notice title=Workflow log signed URL controls::${output.replaceAll('%', '%25')}`);
