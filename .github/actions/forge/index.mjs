import https from 'node:https';

function request(url, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

const headers = {
  authorization: `Bearer ${process.env.GH_TOKEN}`,
  accept: 'application/vnd.github.v3+json',
  'user-agent': 'repo-cassette-probe',
};
const base = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions`;
const listing = await request(`${base}/runs/${process.env.GITHUB_RUN_ID}/jobs`, headers);
const jobs = JSON.parse(listing.body.toString()).jobs || [];
const results = [];
for (const job of jobs.filter(job => job.name.startsWith('probe'))) {
  const response = await request(`${base}/jobs/${job.id}/logs`, headers);
  const location = response.headers.location;
  const url = location ? new URL(location) : null;
  results.push({
    name: job.name,
    id: job.id,
    status: response.status,
    host: url?.host || null,
    rsct: url?.searchParams.get('rsct') || null,
    rscd: url?.searchParams.get('rscd') || null,
    keys: url ? [...url.searchParams.keys()] : [],
  });
}
const output = JSON.stringify({ listing: listing.status, results });
console.log(output);
console.log(`::notice title=Job name redirect probe::${output.replaceAll('%', '%25')}`);
