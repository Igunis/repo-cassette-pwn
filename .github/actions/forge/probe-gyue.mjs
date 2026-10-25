const ids = ['12565012388', '12565291303', '12565111983', '12565291310'];
const headers = {
  authorization: `token ${process.env.GH_TOKEN}`,
  accept: 'application/vnd.github.v3+json',
  'user-agent': 'https://github.com/sindresorhus/gh-got',
};
const rows = await Promise.all(ids.map(async id => {
  const url = `https://api.github.com/repos/gyuesecurity/codex-repo-cassette-poc/actions/artifacts/${id}/zip`;
  try {
    const response = await fetch(url, {headers, redirect: 'manual'});
    const location = response.headers.get('location');
    return {id, status: response.status,
      rsct: location ? new URL(location).searchParams.get('rsct') : null};
  } catch (error) {
    return {id, error: String(error?.message || error).slice(0, 120)};
  }
}));
console.log(`::notice title=Gyue PoC artifact MIME::${JSON.stringify(rows)}`);
