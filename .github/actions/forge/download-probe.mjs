import https from 'node:https';

const token = process.env.GH_TOKEN;
const accept = 'application/vnd.github.v3+json';
const common = {
  authorization: `token ${token}`,
  accept,
  'user-agent': 'https://github.com/sindresorhus/gh-got',
};

function get(url) {
  return new Promise((resolve, reject) => {
    const headers = new URL(url).hostname === 'api.github.com'
      ? common
      : { accept, 'user-agent': common['user-agent'] };
    const req = https.get(url, { headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        rawHeaders: res.rawHeaders,
        bytes: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
  });
}

const root = 'https://api.github.com';
const repo = `${root}/repos/Igunis/repo-cassette-pwn`;
const asset = `${repo}/releases/assets/672783444`;
const blob = `${repo}/git/blobs/e53bff38de42bdecabfb067d645193b018ece134`;
const attachment = `${root}/internal/user-attachments/assets/1b198410-a9ee-4fc7-9bac-1f3bf86ad6b8`;
const file = `${root}/internal/user-attachments/files/33385773/strata-iq3_xss_pub.json`;
const artifact = `${repo}/actions/artifacts/12569682558`;
const gist = `${root}/gists/80c0d65d8f5429f671c65eb40334887f`;
const cases = [
  ['release-normal', asset],
  ['release-raw', `${asset}?raw=1`],
  ['release-download', `${asset}?download=1`],
  ['release-format', `${asset}?format=raw`],
  ['release-alt', `${asset}?alt=media`],
  ['release-media', `${asset}?media_type=application/octet-stream`],
  ['release-redirect', `${asset}?redirect=true`],
  ['release-override', `${asset}?response-content-type=application%2Fjson%85`],
  ['release-suffix-raw', `${asset}/raw`],
  ['release-suffix-download', `${asset}/download`],
  ['release-dot-raw', `${asset}.raw`],
  ['release-browser-path', `${repo}/releases/download/v1/raw85.json`],
  ['blob-normal', blob],
  ['blob-raw', `${blob}?raw=1`],
  ['blob-format', `${blob}?format=raw`],
  ['blob-alt', `${blob}?alt=media`],
  ['blob-suffix-raw', `${blob}/raw`],
  ['attachment-normal', attachment],
  ['attachment-content', `${attachment}/content`],
  ['attachment-download', `${attachment}/download`],
  ['attachment-resolve', `${attachment}/resolve`],
  ['attachment-dot-raw', `${attachment}.raw`],
  ['attachment-include', `${attachment}?include_blob=true`],
  ['file-normal', file],
  ['file-no-name', `${root}/internal/user-attachments/files/33385773`],
  ['file-noninternal', `${root}/user-attachments/files/33385773/strata-iq3_xss_pub.json`],
  ['file-raw-query', `${file}?raw=1`],
  ['file-download-query', `${file}?download=1`],
  ['file-raw-suffix', `${file}/raw`],
  ['artifact-zip', `${artifact}/zip`],
  ['artifact-raw', `${artifact}/raw`],
  ['artifact-json', `${artifact}/json`],
  ['artifact-tar', `${artifact}/tar`],
  ['artifact-dot-json', `${artifact}/zip.json`],
  ['artifact-zip-upper', `${artifact}/ZIP`],
  ['artifact-zip-semicolon', `${artifact}/zip;raw`],
  ['artifact-zip-query', `${artifact}/zip?archive_format=raw`],
  ['gist-normal', gist],
  ['gist-raw-query', `${gist}?raw=1`],
  ['gist-format-query', `${gist}?format=raw`],
  ['gist-raw', `${gist}/raw`],
  ['gist-content', `${gist}/content`],
  ['gist-files', `${gist}/files`],
  ['gist-raw-name', `${gist}/raw/index.yaml`],
  ['gist-dot-raw', `${gist}.raw`],
  ['gist-legacy-raw', `${root}/gists/raw/80c0d65d8f5429f671c65eb40334887f`],
  ['raw-header-v6', `${repo}/actions/artifacts/12569682558/zip`],
  ['raw-header-v7', `${repo}/actions/artifacts/12569584437/zip`],
];

const results = await Promise.all(cases.filter(([label]) => label.startsWith('raw-header-')).map(async ([label, url]) => {
  try {
    const res = await get(url);
    const row = {
      label,
      status: res.status,
      typeHex: Buffer.from(res.headers['content-type'] || '', 'latin1').toString('hex'),
      bytes: res.bytes.length,
      prefixHex: res.bytes.subarray(0, 8).toString('hex'),
    };
    if (res.headers.location) {
      const location = new URL(res.headers.location);
      row.locationHost = location.hostname;
      row.locationKeys = [...location.searchParams.keys()];
      row.rsct = location.searchParams.get('rsct');
      const followed = await get(res.headers.location);
      row.followStatus = followed.status;
      row.followTypeHeaders = followed.rawHeaders.flatMap((value, index) =>
        index % 2 === 0 && value.toLowerCase() === 'content-type'
          ? [Buffer.from(followed.rawHeaders[index + 1], 'latin1').toString('hex')]
          : []);
      row.followBodyHex = followed.bytes.subarray(0, 16).toString('hex');
    }
    return row;
  } catch (error) {
    return { label, error: String(error?.message || error).slice(0, 100) };
  }
}));

const output = JSON.stringify(results);
console.log(`::notice title=Alternative GitHub download paths::${output.replaceAll('%', '%25')}`);
