import https from 'node:https';

const artifactEntry = import.meta.resolve('@actions/artifact');
const artifactLib = new URL('.', artifactEntry);
const { getBackendIdsFromToken } = await import(new URL('internal/shared/util.js', artifactLib));
const ids = getBackendIdsFromToken();

function request(url, options = {}, body = undefined) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const receiver = new URL(
  'twirp/results.services.receiver.Receiver/GetJobLogsSignedBlobURL',
  process.env.ACTIONS_RESULTS_URL,
);
const requestBody = Buffer.from(JSON.stringify({
  workflow_job_run_backend_id: ids.workflowJobRunBackendId,
  workflow_run_backend_id: ids.workflowRunBackendId,
}));
const signedResponse = await request(receiver, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${process.env.ACTIONS_RUNTIME_TOKEN}`,
    accept: 'application/json',
    'content-type': 'application/json',
    'content-length': String(requestBody.length),
  },
}, requestBody);

let signedUrl;
let signedJson;
try {
  signedJson = JSON.parse(signedResponse.body.toString());
  signedUrl = signedJson.logs_url;
} catch {}

const apiHeaders = {
  authorization: `Bearer ${process.env.GH_TOKEN}`,
  accept: 'application/vnd.github.v3+json',
  'user-agent': 'repo-cassette-probe',
  'x-github-api-version': '2022-11-28',
};
const jobsResponse = await request(
  `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}/jobs`,
  { headers: apiHeaders },
);
let jobId;
try {
  const jobs = JSON.parse(jobsResponse.body.toString()).jobs || [];
  jobId = jobs.find(job => job.name === process.env.GITHUB_JOB)?.id || jobs[0]?.id;
} catch {}

const blobHead = signedUrl ? await request(signedUrl, { method: 'HEAD' }) : null;
const completedJobId = '120931475098';
const logQueries = [
  '',
  '?api-version=2012-02-12',
  '?rsct=application%2Fjson%C2%85',
  '?response-content-type=application%2Fjson%C2%85',
  '?download=1',
];
const logResults = [];
for (const query of logQueries) {
  const response = await request(
    `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/jobs/${completedJobId}/logs${query}`,
    { method: 'HEAD', headers: apiHeaders },
  );
  const location = response.headers.location;
  const url = location ? new URL(location) : null;
  logResults.push({
    query: query || 'default',
    status: response.status,
    keys: url ? [...url.searchParams.keys()] : null,
    rsct: url?.searchParams.get('rsct') || null,
    apiVersion: url?.searchParams.get('api-version') || null,
  });
}

const releasesResponse = await request(
  `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/releases?per_page=20`,
  { headers: apiHeaders },
);
let asset;
try {
  asset = JSON.parse(releasesResponse.body.toString()).flatMap(release => release.assets || [])[0];
} catch {}
const assetSuffixes = [
  '', '/download', '.raw', '.bin', '?format=raw', '?media=raw',
  '?download=1', '?raw=1', '?accept=application%2Foctet-stream',
  '?response-content-type=application%2Foctet-stream',
];
const assetResults = [];
if (asset?.id) {
  for (const suffix of assetSuffixes) {
    const response = await request(
      `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/releases/assets/${asset.id}${suffix}`,
      { method: 'HEAD', headers: apiHeaders },
    );
    assetResults.push({
      suffix: suffix || 'default',
      status: response.status,
      type: response.headers['content-type'] || null,
      redirect: Boolean(response.headers.location),
    });
  }
}
const report = {
  signedStatus: signedResponse.status,
  signedStorage: signedJson?.blob_storage_type || null,
  signedQueryKeys: signedUrl ? [...new URL(signedUrl).searchParams.keys()] : null,
  signedRsct: signedUrl ? new URL(signedUrl).searchParams.get('rsct') : null,
  blobHeadStatus: blobHead?.status || null,
  blobType: blobHead?.headers['content-type'] || null,
  jobsStatus: jobsResponse.status,
  jobId: jobId || null,
  logResults,
  assetId: asset?.id || null,
  assetType: asset?.content_type || null,
  assetResults,
};

const output = JSON.stringify(report);
console.log(output);
console.log(`::notice title=Job log redirect probe::${output.replaceAll('%', '%25')}`);
