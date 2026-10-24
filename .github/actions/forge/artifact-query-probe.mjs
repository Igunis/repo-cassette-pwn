import https from 'node:https';

const base = 'https://api.github.com/repos/Igunis/repo-cassette-pwn/actions/artifacts/12569682558/zip';
const names = [
  'mime_type', 'mimeType', 'content_type', 'contentType', 'response_content_type',
  'responseContentType', 'response-content-type', 'download_content_type',
  'downloadContentType', 'rsct', 'type', 'format', 'archive', 'filename',
];
const values = ['application/json', 'application/json\u0085'];
const headers = {
  authorization: `token ${process.env.GH_TOKEN}`,
  accept: 'application/vnd.github.v3+json',
  'user-agent': 'https://github.com/sindresorhus/gh-got',
};

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, res => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location }));
    });
    req.on('error', reject);
    req.setTimeout(7000, () => req.destroy(new Error('timeout')));
  });
}

const jobs = [['control', base]];
for (const name of names) {
  for (let i = 0; i < values.length; i++) {
    const url = new URL(base);
    url.searchParams.set(name, values[i]);
    jobs.push([`${name}-${i}`, url.href]);
  }
}

const rows = await Promise.all(jobs.map(async ([label, url]) => {
  try {
    const response = await get(url);
    const redirect = response.location ? new URL(response.location) : null;
    return { label, status: response.status, rsct: redirect?.searchParams.get('rsct') || null };
  } catch (error) {
    return { label, error: String(error?.message || error).slice(0, 80) };
  }
}));
const output = JSON.stringify(rows);
console.log(`::notice title=Artifact MIME query parameters::${output.replaceAll('%', '%25')}`);
