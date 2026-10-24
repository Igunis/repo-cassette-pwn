import https from 'node:https';

function request(url, headers, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('request timeout')));
    req.end(body);
  });
}

const runtimeUrl = process.env.ACTIONS_RUNTIME_URL;
const runtimeToken = process.env.ACTIONS_RUNTIME_TOKEN;
const results = [];
if (!runtimeUrl || !runtimeToken) {
  results.push({ error: 'Legacy runtime URL or token is missing' });
} else {
  for (const [label, apiVersion, extra] of [
    ['control-v6', '6.0-preview', {}],
    ['nel-version7-v6', '6.0-preview', { Version: 7, MimeType: `application/json${String.fromCharCode(0x85)}` }],
    ['nel-version7-v7', '7.0-preview', { Version: 7, MimeType: `application/json${String.fromCharCode(0x85)}` }],
  ]) {
    const name = `legacy-probe-${process.env.GITHUB_RUN_ID}-${label}.json`;
    const url = `${runtimeUrl}_apis/pipelines/workflows/${process.env.GITHUB_RUN_ID}/artifacts?api-version=${apiVersion}`;
    const body = Buffer.from(JSON.stringify({ Type: 'actions_storage', Name: name, ...extra }));
    const record = { label };
    try {
      const response = await request(url, {
        authorization: `Bearer ${runtimeToken}`,
        accept: `application/json;api-version=${apiVersion}`,
        'content-type': 'application/json',
        'content-length': String(body.length),
        'user-agent': '@actions/artifact-upload',
      }, body);
      record.status = response.status;
      record.type = response.headers['content-type'] || null;
      let data = null;
      try { data = JSON.parse(response.body.toString('utf8')); } catch {}
      if (data) {
        record.responseKeys = Object.keys(data);
        record.id = data.id || data.Id || null;
        record.fileContainerHost = data.fileContainerResourceUrl
          ? new URL(data.fileContainerResourceUrl).host : null;
        record.message = data.message || data.Message || null;
      } else {
        record.errorPrefix = response.body.toString('utf8').slice(0, 200);
      }
    } catch (error) {
      record.error = String(error?.message || error).slice(0, 180);
    }
    results.push(record);
  }
}
const output = JSON.stringify(results);
console.log(output);
console.log(`::notice title=Legacy artifact service create probe::${output.replaceAll('%', '%25')}`);
