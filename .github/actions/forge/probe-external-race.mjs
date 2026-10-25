const ids = [
  '12569346732', '12569451283', '12569601354', '12569686292',
  '12569806782', '12569916228', '12569916229', '12569991695',
  '12570201652', '12570216201', '12570306695', '12570366148',
  '12570436132', '12570555036', '12570600044', '12570620039',
];
const headers = {
  authorization: `token ${process.env.GH_TOKEN}`,
  accept: 'application/vnd.github.v3+json',
  'user-agent': 'https://github.com/sindresorhus/gh-got',
};
const rows = await Promise.all(ids.map(async id => {
  try {
    const url = `https://api.github.com/repos/yeee3642/repo-cassette-ctf-temp/actions/artifacts/${id}/zip`;
    const response = await fetch(url, {headers, redirect: 'manual'});
    const location = response.headers.get('location');
    return {id, status: response.status,
      rsct: location ? new URL(location).searchParams.get('rsct') : null};
  } catch (error) {
    return {id, error: String(error?.message || error).slice(0, 120)};
  }
}));
console.log(`::notice title=Public cross-job race artifacts::${JSON.stringify(rows)}`);
