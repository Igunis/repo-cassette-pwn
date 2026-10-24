import https from 'node:https';

const apiBase = 'https://api.github.com';
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
const tag = `cassette-probe-${process.env.GITHUB_RUN_ID}`;
const fixedAccept = 'application/vnd.github.v3+json';

function commonHeaders(auth = true) {
  return {
    Accept: fixedAccept,
    ...(auth ? { Authorization: `Bearer ${token}` } : {}),
    'User-Agent': 'repo-cassette-probe',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function api(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: { ...commonHeaders(true), ...options.headers },
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error(`${options.method || 'GET'} ${path}: HTTP ${response.status}: ${bytes.toString('utf8')}`);
  }
  return { response, bytes };
}

function uploadAsset(uploadUrl, name, contentType, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(uploadUrl.replace('{?name,label}', `?name=${encodeURIComponent(name)}`));
    const request = https.request(target, {
      method: 'POST',
      headers: {
        ...commonHeaders(true),
        'Content-Type': contentType,
        'Content-Length': String(body.length),
      },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const bytes = Buffer.concat(chunks);
        if ((response.statusCode || 0) < 200 || (response.statusCode || 0) >= 300) {
          reject(new Error(`asset upload HTTP ${response.statusCode}: ${bytes.toString('utf8')}`));
          return;
        }
        resolve(JSON.parse(bytes.toString('utf8')));
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

const created = await api(`/repos/${repository}/releases`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ tag_name: tag, name: tag, draft: false, prerelease: true }),
});
const release = JSON.parse(created.bytes.toString('utf8'));

const nelType = Buffer.concat([
  Buffer.from('application/json', 'ascii'),
  Buffer.from([0x85]),
]).toString('latin1');
const payload = Buffer.from('{"probe":"release-asset"}');
const assets = [];
for (const [name, type] of [
  ['nel.json', nelType],
  ['vendor.json', fixedAccept],
  ['plain.json', 'application/json'],
]) {
  assets.push(await uploadAsset(release.upload_url, name, type, payload));
}

const paths = [];
for (const asset of assets) {
  const base = `/repos/${repository}/releases/assets/${asset.id}`;
  for (const suffix of ['', '?download=1', '?download=true', '?raw=1', '?raw=true', '/download']) {
    paths.push([asset.name, `${base}${suffix}`]);
  }
  paths.push([asset.name, `/repos/${repository}/releases/download/${tag}/${asset.name}`]);
  paths.push([asset.name, `/repos/${repository}/releases/latest/download/${asset.name}`]);
}

const results = [];
for (const auth of [true, false]) {
  for (const [asset, path] of paths) {
    const response = await fetch(`${apiBase}${path}`, {
      headers: commonHeaders(auth),
      redirect: 'follow',
    });
    const body = Buffer.from(await response.arrayBuffer());
    results.push({
      auth,
      asset,
      path: path.slice(path.indexOf('/releases/')),
      status: response.status,
      host: new URL(response.url).host,
      typeHex: Buffer.from(response.headers.get('content-type') || '', 'latin1').toString('hex'),
      bytes: body.length,
      payload: body.equals(payload),
    });
  }
}

const report = JSON.stringify({ tag, assets: assets.map(({ id, name, content_type }) => ({ id, name, content_type })), results });
console.log(report);
console.log(`::notice title=Release route probe::${report.replaceAll('%', '%25')}`);
