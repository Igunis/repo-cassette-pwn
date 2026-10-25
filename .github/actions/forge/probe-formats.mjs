const root = 'https://api.github.com/repos/Igunis/repo-cassette-pwn/actions/artifacts/12590816408';
const paths = [
  '/zip',
  '/raw',
  '/download',
  '/file',
  '/json',
  '/blob',
  '/content',
  '/archive',
  '/zip/raw',
  '/zip/download',
  '?format=raw',
  '?download=1',
];
const headers = {
  authorization: `token ${process.env.GITHUB_TOKEN}`,
  accept: 'application/vnd.github.v3+json',
  'user-agent': 'https://github.com/sindresorhus/gh-got',
};
for (const path of paths) {
  try {
    const response = await fetch(root + path, {headers, redirect: 'manual'});
    const location = response.headers.get('location');
    const destination = location ? new URL(location) : null;
    console.log(`::notice title=Artifact format route::${JSON.stringify({
      path, status: response.status, contentType: response.headers.get('content-type'),
      redirectHost: destination?.host, rsct: destination?.searchParams.get('rsct'),
    })}`);
  } catch (error) {
    console.log(`::notice title=Artifact format route::${JSON.stringify({path, error: String(error?.message || error).slice(0, 120)})}`);
  }
}
