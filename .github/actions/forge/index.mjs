import tls from 'node:tls';
import https from 'node:https';

const artifactEntry = import.meta.resolve('@actions/artifact');
const artifactLib = new URL('.', artifactEntry);
const [{ internalArtifactTwirpClient }, { getBackendIdsFromToken }, { StringValue }] = await Promise.all([
  import(new URL('internal/shared/artifact-twirp-client.js', artifactLib)),
  import(new URL('internal/shared/util.js', artifactLib)),
  import(new URL('generated/index.js', artifactLib)),
]);
const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({ maxAttempts: 1 });
const source = 'https://httpbingo.org/response-headers?Content-Type=application%2Fjson%85';

function rawCopy(url, mode) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const socket = tls.connect({ host: target.hostname, port: 443, servername: target.hostname });
    const chunks = [];
    socket.on('secureConnect', () => {
      const lines = [
        `PUT ${target.pathname}${target.search} HTTP/1.1`,
        `Host: ${target.host}`,
        'x-ms-version: 2023-11-03',
        `x-ms-copy-source: ${source}`,
        ...(mode === 'put-url' ? ['x-ms-blob-type: BlockBlob'] : []),
        ...(mode === 'sync-copy' ? ['x-ms-requires-sync: true'] : []),
        'Content-Length: 0',
        'Connection: close',
        '',
        '',
      ];
      socket.write(Buffer.from(lines.join('\r\n'), 'ascii'));
    });
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('end', () => {
      const response = Buffer.concat(chunks);
      const line = response.subarray(0, response.indexOf('\r\n')).toString('latin1');
      resolve({ status: Number(line.split(' ')[1]), line, response });
    });
    socket.on('error', reject);
  });
}

function coreGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        type: response.headers['content-type'] || '',
        body: Buffer.concat(chunks),
      }));
    }).on('error', reject);
  });
}

const sourceResponse = await coreGet(source);
const results = [{
  mode: 'source',
  status: sourceResponse.status,
  typeCodePoints: [...sourceResponse.type].map(char => char.codePointAt(0).toString(16)).join(','),
  bytes: sourceResponse.body.length,
}];

for (const mode of ['put-url', 'copy', 'sync-copy']) {
  const name = `server-copy-${process.env.GITHUB_RUN_ID}-${mode}.json`;
  try {
    const created = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      mimeType: StringValue.create({ value: 'application/octet-stream' }),
      version: 7,
    });
    const copied = await rawCopy(created.signedUploadUrl, mode);
    if (copied.status !== 201 && copied.status !== 202) {
      results.push({ mode, copyStatus: copied.status, response: copied.response.toString('latin1').slice(0, 500) });
      continue;
    }
    const finalized = await client.FinalizeArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      size: String(sourceResponse.body.length),
    });
    const { signedUrl } = await client.GetSignedArtifactURL({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
    });
    const old = await coreGet(`${signedUrl}&api-version=2012-02-12`);
    results.push({
      mode,
      copyStatus: copied.status,
      artifactId: finalized.artifactId,
      downloadStatus: old.status,
      typeCodePoints: [...old.type].map(char => char.codePointAt(0).toString(16)).join(','),
      bytes: old.body.length,
      sourceBody: old.body.equals(sourceResponse.body),
    });
  } catch (error) {
    results.push({ mode, error: String(error?.stack || error).slice(0, 500) });
  }
}

const report = JSON.stringify(results);
console.log(report);
console.log(`::notice title=Azure server-side source probe::${report.replaceAll('%', '%25')}`);
