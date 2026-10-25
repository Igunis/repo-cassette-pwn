const base = 'https://api.github.com/repos/Igunis/repo-cassette-pwn/actions/artifacts/12591220029/zip';
const suffixes = [
  '',
  '?rsct=%85application%2Fjson',
  '?response-content-type=%85application%2Fjson',
  '?response_content_type=%85application%2Fjson',
  '?api-version=2012-02-12',
  '?raw=1',
  '?download=1',
  '?redirect=0',
  '?archive_format=json',
];
const headers = {
  authorization: `token ${process.env.GH_TOKEN}`,
  accept: 'application/vnd.github.v3+json',
  'user-agent': 'https://github.com/sindresorhus/gh-got',
};
for (const suffix of suffixes) {
  try {
    const response = await fetch(base + suffix, {headers, redirect: 'manual'});
    const location = response.headers.get('location');
    const signed = location ? new URL(location) : null;
    console.log(`::notice title=Artifact query probe::${JSON.stringify({
      suffix, status: response.status, host: signed?.host,
      rsct: signed?.searchParams.get('rsct'),
      contentType: response.headers.get('content-type'),
    })}`);
  } catch (error) {
    console.log(`::notice title=Artifact query probe::${JSON.stringify({suffix, error: String(error?.message || error).slice(0, 120)})}`);
  }
}
