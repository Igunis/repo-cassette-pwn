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

const uuid = '1b198410-a9ee-4fc7-9bac-1f3bf86ad6b8';
const base = `https://api.github.com/internal/user-attachments/assets/${uuid}`;
const fixedAccept = 'application/vnd.github.v3+json';
const userAgent = 'https://github.com/sindresorhus/gh-got';
const variants = [
  ['normal', base, fixedAccept],
  ['accept-octet', base, 'application/octet-stream'],
  ['raw-1', `${base}?raw=1`, fixedAccept],
  ['download-1', `${base}?download=1`, fixedAccept],
  ['redirect-true', `${base}?redirect=true`, fixedAccept],
  ['format-raw', `${base}?format=raw`, fixedAccept],
  ['mode-redirect', `${base}?mode=redirect`, fixedAccept],
  ['response-type-raw', `${base}?response_type=raw`, fixedAccept],
  ['direct-1', `${base}?direct=1`, fixedAccept],
  ['alt-media', `${base}?alt=media`, fixedAccept],
  ['suffix-raw', `${base}/raw`, fixedAccept],
  ['suffix-blob', `${base}/blob`, fixedAccept],
];
const results = [];
for (const [label, url, accept] of variants) {
  const record = { label };
  try {
    const first = await request(url, {
      authorization: `token ${process.env.GH_TOKEN}`,
      accept,
      'user-agent': userAgent,
    });
    record.status = first.status;
    record.typeHex = Buffer.from(first.headers['content-type'] || '', 'latin1').toString('hex');
    record.bytes = first.body.length;
    if (first.headers.location) {
      const redirect = new URL(first.headers.location);
      record.locationHost = redirect.hostname;
      record.locationKeys = [...redirect.searchParams.keys()];
      const followed = await request(first.headers.location, { accept, 'user-agent': userAgent });
      record.followStatus = followed.status;
      record.followTypeHex = Buffer.from(followed.headers['content-type'] || '', 'latin1').toString('hex');
      record.followPrefixHex = followed.body.subarray(0, 10).toString('hex');
    } else {
      try {
        const body = JSON.parse(first.body.toString('utf8'));
        record.keys = Object.keys(body);
        record.urlHost = typeof body.url === 'string' ? new URL(body.url).hostname : null;
        record.contentType = body.content_type || body.contentType || null;
        record.name = body.name || null;
      } catch {
        record.prefix = first.body.subarray(0, 80).toString('utf8');
      }
    }
  } catch (error) {
    record.error = String(error?.message || error).slice(0, 130);
  }
  results.push(record);
}
const output = JSON.stringify(results);
console.log(output);
console.log(`::notice title=Internal attachment direct modes::${output.replaceAll('%', '%25')}`);
