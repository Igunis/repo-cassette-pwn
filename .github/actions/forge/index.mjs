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

const uuid = '1b198410-a9ee-4fc7-9bac-1f3bf86ad6b8';
const fixedAccept = 'application/vnd.github.v3+json';
const userAgent = 'https://github.com/sindresorhus/gh-got';
const variants = [
  ['internal-auth-fixed', `/internal/user-attachments/assets/${uuid}`, true, fixedAccept],
  ['internal-anon-fixed', `/internal/user-attachments/assets/${uuid}`, false, fixedAccept],
  ['internal-auth-any', `/internal/user-attachments/assets/${uuid}`, true, '*/*'],
  ['internal-auth-download', `/internal/user-attachments/assets/${uuid}/download`, true, fixedAccept],
  ['public-auth-fixed', `/user-attachments/assets/${uuid}`, true, fixedAccept],
];
const results = [];
for (const [label, path, auth, accept] of variants) {
  const record = { label };
  try {
    const headers = { accept, 'user-agent': userAgent };
    if (auth) headers.authorization = `token ${process.env.GH_TOKEN}`;
    const first = await request(`https://api.github.com${path}`, headers);
    record.status = first.status;
    record.typeHex = Buffer.from(first.headers['content-type'] || '', 'latin1').toString('hex');
    record.bytes = first.body.length;
    record.prefix = first.body.subarray(0, 80).toString('utf8');
    if (first.headers.location) {
      const redirect = new URL(first.headers.location);
      record.redirectHost = redirect.hostname;
      record.redirectPath = redirect.pathname;
      record.redirectKeys = [...redirect.searchParams.keys()];
      const followed = await request(first.headers.location, { accept, 'user-agent': userAgent });
      record.finalStatus = followed.status;
      record.finalTypeHex = Buffer.from(followed.headers['content-type'] || '', 'latin1').toString('hex');
      record.finalBytes = followed.body.length;
      record.finalSha12 = createHash('sha256').update(followed.body).digest('hex').slice(0, 12);
      record.finalPrefixHex = followed.body.subarray(0, 12).toString('hex');
    }
  } catch (error) {
    record.error = String(error?.message || error).slice(0, 150);
  }
  results.push(record);
}
const output = JSON.stringify(results);
console.log(output);
console.log(`::notice title=Internal attachment API route probe::${output.replaceAll('%', '%25')}`);
