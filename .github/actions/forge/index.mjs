import https from 'node:https';

function request(url, options = {}, body = undefined) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const apiHeaders = {
  authorization: `Bearer ${process.env.GH_TOKEN}`,
  accept: 'application/vnd.github.v3+json',
  'user-agent': 'repo-cassette-probe',
  'x-github-api-version': '2022-11-28',
};
const tag = `accept-probe-${process.env.GITHUB_RUN_ID}`;
const releaseBody = Buffer.from(JSON.stringify({
  tag_name: tag,
  name: tag,
  draft: false,
  prerelease: true,
}));
const releaseResponse = await request(
  `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/releases`,
  {
    method: 'POST',
    headers: {
      ...apiHeaders,
      'content-type': 'application/json',
      'content-length': String(releaseBody.length),
    },
  },
  releaseBody,
);
if (releaseResponse.status !== 201) {
  throw new Error(`Release creation failed: ${releaseResponse.status} ${releaseResponse.body.toString().slice(0, 300)}`);
}
const release = JSON.parse(releaseResponse.body.toString());
const uploadBase = release.upload_url.replace('{?name,label}', '');
const types = [
  'application/vnd.github.v3+json',
  'application/vnd.github+json',
  'application/vnd.github.raw+json',
  'application/json',
];
const results = [];
for (let index = 0; index < types.length; index++) {
  const type = types[index];
  const payload = Buffer.from(JSON.stringify({ probe: index, type }));
  const upload = await request(`${uploadBase}?name=${encodeURIComponent(`match-${index}.json`)}`, {
    method: 'POST',
    headers: {
      ...apiHeaders,
      'content-type': type,
      'content-length': String(payload.length),
    },
  }, payload);
  let asset;
  try { asset = JSON.parse(upload.body.toString()); } catch {}
  if (!asset?.id) {
    results.push({ type, uploadStatus: upload.status, uploadError: upload.body.toString().slice(0, 160) });
    continue;
  }
  const response = await request(
    `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/releases/assets/${asset.id}`,
    { headers: apiHeaders },
  );
  const followed = response.headers.location ? await request(response.headers.location) : null;
  results.push({
    type,
    assetId: asset.id,
    storedType: asset.content_type,
    status: response.status,
    responseType: response.headers['content-type'] || null,
    redirect: Boolean(response.headers.location),
    payload: response.body.equals(payload) || Boolean(followed?.body.equals(payload)),
    followedType: followed?.headers['content-type'] || null,
  });
}

const output = JSON.stringify(results);
console.log(output);
console.log(`::notice title=Release Accept matching probe::${output.replaceAll('%', '%25')}`);
