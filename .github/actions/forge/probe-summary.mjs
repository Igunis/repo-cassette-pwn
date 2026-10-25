const repository = process.env.GITHUB_REPOSITORY;
const runId = process.env.PROBE_RUN_ID || process.env.GITHUB_RUN_ID;
const base = `https://api.github.com/repos/${repository}`;
const headers = {
  authorization: `token ${process.env.GH_TOKEN}`,
  accept: 'application/vnd.github.v3+json',
  'user-agent': 'https://github.com/sindresorhus/gh-got',
};

let jobId;
for (let retry = 0; retry < 12 && !jobId; retry++) {
  const response = await fetch(`${base}/actions/runs/${runId}/jobs?filter=all`, {headers});
  if (response.ok) {
    const document = await response.json();
    jobId = document.jobs?.find(job => job.name === 'forge')?.id || document.jobs?.[0]?.id;
  }
  if (!jobId) await new Promise(resolve => setTimeout(resolve, 500));
}
if (!jobId) throw new Error('Job ID unavailable');

const paths = [
  `/actions/runs/${runId}/summary`,
  `/actions/runs/${runId}/attempts/1/summary`,
  `/actions/runs/${runId}/job-summary`,
  `/actions/runs/${runId}/jobs/${jobId}/summary`,
  `/actions/jobs/${jobId}/summary`,
  `/actions/jobs/${jobId}/job-summary`,
  `/actions/jobs/${jobId}/step-summary`,
  `/actions/jobs/${jobId}/steps/1/summary`,
  `/check-runs/${jobId}/summary`,
];
const rows = await Promise.all(paths.map(async path => {
  try {
    const response = await fetch(base + path, {headers, redirect: 'manual'});
    const location = response.headers.get('location');
    const target = location ? new URL(location) : null;
    return {path, status: response.status, type: response.headers.get('content-type'),
      host: target?.host, rsct: target?.searchParams.get('rsct')};
  } catch (error) {
    return {path, error: String(error?.message || error).slice(0, 120)};
  }
}));
console.log(`::notice title=Actions summary API routes::${JSON.stringify({runId, jobId, rows})}`);
