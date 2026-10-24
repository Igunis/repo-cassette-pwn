import https from 'node:https';

function request(url, options = {}, body = undefined) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, rawHeaders: response.rawHeaders, body: Buffer.concat(chunks) }));
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
const tag = `probe-${process.env.GITHUB_RUN_ID}`;
const releaseBody = Buffer.from(JSON.stringify({ tag_name: tag, name: tag, draft: false, prerelease: true }));
const release = await request(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/releases`, {
  method: 'POST', headers: { ...apiHeaders, 'content-type': 'application/json', 'content-length': String(releaseBody.length) },
}, releaseBody);
if (release.status !== 201) throw new Error(`release create ${release.status}: ${release.body.toString().slice(0, 500)}`);
const releaseJson = JSON.parse(release.body);
const uploadBase = releaseJson.upload_url.replace('{?name,label}', '');

const assetResults = [];
for (const [label, type] of [
  ['normal', 'application/octet-stream'],
  ['raw85', `application/json${String.fromCharCode(0x85)}`],
  ['raw1c', `application/json${String.fromCharCode(0x1c)}`],
]) {
  const payload = Buffer.from(JSON.stringify({ probe: label }));
  try {
    const uploaded = await request(`${uploadBase}?name=${encodeURIComponent(`${label}.json`)}`, {
      method: 'POST',
      headers: { ...apiHeaders, accept: 'application/vnd.github.v3+json', 'content-type': type, 'content-length': String(payload.length) },
    }, payload);
    let asset = null;
    try { asset = JSON.parse(uploaded.body); } catch {}
    const variants = [];
    if (asset?.id) {
      const endpoint = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/releases/assets/${asset.id}`;
      for (const [variant, suffix, accept] of [
        ['default', '', 'application/vnd.github.v3+json'],
        ['download', '?download=1', 'application/vnd.github.v3+json'],
        ['raw', '?raw=1', 'application/vnd.github.v3+json'],
        ['octet', '', 'application/octet-stream'],
      ]) {
        const first = await request(`${endpoint}${suffix}`, { headers: { ...apiHeaders, accept } });
        let followed = null;
        if (first.headers.location) followed = await request(first.headers.location);
        variants.push({
          variant,
          status: first.status,
          firstTypeHex: Buffer.from(first.headers['content-type'] || '', 'latin1').toString('hex'),
          locationHost: first.headers.location ? new URL(first.headers.location).host : null,
          followedStatus: followed?.status || null,
          followedTypeHex: followed ? Buffer.from(followed.headers['content-type'] || '', 'latin1').toString('hex') : null,
          payload: Boolean(followed?.body.equals(payload) || first.body.equals(payload)),
        });
      }
      const browser = await request(asset.browser_download_url);
      variants.push({
        variant: 'browser', status: browser.status,
        firstTypeHex: Buffer.from(browser.headers['content-type'] || '', 'latin1').toString('hex'),
        locationHost: browser.headers.location ? new URL(browser.headers.location).host : null,
        payload: browser.body.equals(payload),
      });
    }
    assetResults.push({
      label,
      uploadStatus: uploaded.status,
      assetId: asset?.id || null,
      storedTypeHex: asset?.content_type ? Buffer.from(asset.content_type, 'latin1').toString('hex') : null,
      response: asset?.id ? null : uploaded.body.toString().slice(0, 500),
      variants,
    });
  } catch (error) {
    assetResults.push({ label, error: String(error?.message || error).slice(0, 500) });
  }
}

const report = JSON.stringify({ releaseId: releaseJson.id, tag, assets: assetResults });
console.log(report);
console.log(`::notice title=Release asset raw header probe::${report.replaceAll('%', '%25')}`);
