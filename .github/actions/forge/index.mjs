import https from 'node:https';
import { createHash } from 'node:crypto';

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

const base = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/contents/payload.json`;
const ref = 'ref=codex-cacheprobe';
const headers = {
  authorization: `Bearer ${process.env.GH_TOKEN}`,
  accept: 'application/vnd.github.v3+json',
  'user-agent': 'https://github.com/sindresorhus/gh-got',
};
const variants = [
  ['normal', `${base}?${ref}`],
  ['raw-1', `${base}?${ref}&raw=1`],
  ['raw-true', `${base}?${ref}&raw=true`],
  ['format-raw', `${base}?${ref}&format=raw`],
  ['download-1', `${base}?${ref}&download=1`],
  ['accept-raw', `${base}?${ref}&accept=application%2Fvnd.github.v3.raw`],
  ['media-type-raw', `${base}?${ref}&media_type=raw`],
  ['response-type-raw', `${base}?${ref}&response_type=raw`],
  ['type-raw', `${base}?${ref}&type=raw`],
  ['alt-media', `${base}?${ref}&alt=media`],
  ['suffix-raw', `${base}.raw?${ref}`],
  ['suffix-encoded-raw', `${base}%2Eraw?${ref}`],
  ['suffix-semicolon-raw', `${base};raw?${ref}`],
  ['slash-raw', `${base}/raw?${ref}`],
];
const results = [];
for (const [label, url] of variants) {
  const record = { label };
  try {
    const first = await request(url, headers);
    record.status = first.status;
    record.typeHex = Buffer.from(first.headers['content-type'] || '', 'latin1').toString('hex');
    record.bytes = first.body.length;
    record.sha12 = createHash('sha256').update(first.body).digest('hex').slice(0, 12);
    record.prefix = first.body.subarray(0, 45).toString('utf8');
    if (first.headers.location) {
      record.locationHost = new URL(first.headers.location).hostname;
      const followed = await request(first.headers.location, {
        accept: headers.accept,
        'user-agent': headers['user-agent'],
      });
      record.followStatus = followed.status;
      record.followTypeHex = Buffer.from(followed.headers['content-type'] || '', 'latin1').toString('hex');
      record.followBytes = followed.body.length;
      record.followSha12 = createHash('sha256').update(followed.body).digest('hex').slice(0, 12);
    }
  } catch (error) {
    record.error = String(error?.message || error).slice(0, 130);
  }
  results.push(record);
}
const output = JSON.stringify(results);
console.log(output);
console.log(`::notice title=Contents URL raw media override probe::${output.replaceAll('%', '%25')}`);
