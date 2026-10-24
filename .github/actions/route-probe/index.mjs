const routes = [
  '/repos/cli/cli/releases/download/v2.103.2/gh_2.103.2_checksums.txt',
  '/repos/cli/cli/releases/latest/download/gh_2.103.2_checksums.txt',
];
const results = [];

for (const route of routes) {
  const response = await fetch(`https://api.github.com${route}`, {
    headers: {
      Accept: 'application/vnd.github.v3+json',
      Authorization: `Bearer ${process.env.GH_TOKEN}`,
      'User-Agent': 'repo-cassette-probe',
    },
    redirect: 'follow',
  });
  const body = Buffer.from(await response.arrayBuffer());
  results.push({
    route,
    status: response.status,
    finalHost: new URL(response.url).host,
    type: response.headers.get('content-type'),
    bytes: body.length,
    prefix: body.subarray(0, 32).toString('hex'),
  });
}

const report = JSON.stringify(results);
console.log(report);
console.log(`::notice title=Route probe::${report.replaceAll('%', '%25')}`);
