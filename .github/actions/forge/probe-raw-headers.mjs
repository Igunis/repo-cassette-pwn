import https from 'node:https';
import {createHash} from 'node:crypto';
import ghGot from 'gh-got';

const cases = [
  {name: 'v5-nel-blob', artifactId: '12591220029'},
  {name: 'v7-json-registration-nel-blob', artifactId: '12590816408'},
];
const userAgent = 'https://github.com/sindresorhus/gh-got';

function request(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {headers}, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        rawHeaders: response.rawHeaders,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

function rawTypes(response) {
  const values = [];
  for (let i = 0; i < response.rawHeaders.length; i += 2) {
    if (response.rawHeaders[i].toLowerCase() === 'content-type') {
      values.push(Buffer.from(response.rawHeaders[i + 1], 'latin1').toString('hex'));
    }
  }
  return values;
}

for (const item of cases) {
  try {
    const path = `repos/Igunis/repo-cassette-pwn/actions/artifacts/${item.artifactId}/zip`;
    const api = await request(`https://api.github.com/${path}`, {
      authorization: `token ${process.env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github.v3+json',
      'user-agent': userAgent,
    });
    if (api.status !== 302 || !api.headers.location) {
      throw new Error(`API returned ${api.status} without a redirect`);
    }
    const destination = new URL(api.headers.location);
    const blob = await request(destination, {
      accept: 'application/vnd.github.v3+json',
      'user-agent': userAgent,
    });
    const got = await ghGot(path, {
      responseType: 'buffer',
      timeout: {request: 6000},
      retry: {limit: 0},
    });
    const hash = bytes => createHash('sha256').update(bytes).digest('hex');
    console.log(`::notice title=Raw artifact headers::${JSON.stringify({
      name: item.name,
      apiStatus: api.status,
      rsct: destination.searchParams.get('rsct'),
      blobStatus: blob.status,
      rawContentTypeHex: rawTypes(blob),
      parsedContentType: blob.headers['content-type'],
      ghGotContentType: got.headers['content-type'],
      sameBody: hash(blob.body) === hash(got.body),
    })}`);
  } catch (error) {
    console.log(`::notice title=Raw artifact headers::${JSON.stringify({name: item.name, error: String(error?.message || error).slice(0, 200)})}`);
  }
}
