const ids = (() => {
  const parts = process.env.ACTIONS_RUNTIME_TOKEN.split('.')[1];
  const payload = JSON.parse(Buffer.from(parts, 'base64url').toString('utf8'));
  const scope = payload.scp?.split(' ').find(item => item.startsWith('Actions.Results:'));
  return {
    workflowRunBackendId: scope?.split(':')[1],
    workflowJobRunBackendId: scope?.split(':')[2],
  };
})();
if (!ids.workflowRunBackendId || !ids.workflowJobRunBackendId) {
  throw new Error('Could not decode artifact backend IDs');
}

const endpoint = new URL(
  '/twirp/github.actions.results.api.v1.ArtifactService/CreateArtifact',
  process.env.ACTIONS_RESULTS_URL,
);
const variants = [
  ['raw85-json', Buffer.from([0x85]), 'application/json'],
  ['raw85-latin1', Buffer.from([0x85]), 'application/json; charset=iso-8859-1'],
  ['raw85-windows', Buffer.from([0x85]), 'application/json; charset=windows-1252'],
  ['utf8-nel', Buffer.from([0xc2, 0x85]), 'application/json'],
  ['overlong-nel', Buffer.from([0xc1, 0x85]), 'application/json'],
  ['escaped-nel', Buffer.from('\\u0085', 'ascii'), 'application/json'],
];
const results = [];

for (const [label, suffix, contentType] of variants) {
  const name = `raw-json-${process.env.GITHUB_RUN_ID}-${label}.json`;
  const prefix = Buffer.from(JSON.stringify({
    workflow_run_backend_id: ids.workflowRunBackendId,
    workflow_job_run_backend_id: ids.workflowJobRunBackendId,
    name,
    version: 7,
  }).slice(0, -1) + ',"mime_type":"application/json', 'ascii');
  const body = Buffer.concat([prefix, suffix, Buffer.from('"}', 'ascii')]);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.ACTIONS_RUNTIME_TOKEN}`,
      'Content-Type': contentType,
      'User-Agent': 'repo-cassette-raw-probe',
    },
    body,
  });
  const responseBody = await response.text();
  let parsed;
  try { parsed = JSON.parse(responseBody); } catch {}
  results.push({
    label,
    status: response.status,
    ok: parsed?.ok === true,
    message: String(parsed?.msg || parsed?.message || responseBody).slice(0, 180),
  });
}

const report = JSON.stringify(results);
console.log(report);
console.log(`::notice title=Raw artifact JSON probe::${report.replaceAll('%', '%25')}`);
