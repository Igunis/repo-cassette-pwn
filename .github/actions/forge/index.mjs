import { createHash } from 'node:crypto';
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
const metadataType = 'application/octet-stream';
const payload = Buffer.from('{"probe":"raw-tls"}');

function rawPut(url, protocolVersion, suffix) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const socket = tls.connect({ host: target.hostname, port: 443, servername: target.hostname });
    const chunks = [];
    socket.on('secureConnect', () => {
      const lines = [
        `PUT ${target.pathname}${target.search} HTTP/1.1`,
        `Host: ${target.host}`,
        'x-ms-blob-type: BlockBlob',
      ];
      if (protocolVersion) lines.push(`x-ms-version: ${protocolVersion}`);
      const before = Buffer.from(lines.join('\r\n') + '\r\n', 'ascii');
      const property = Buffer.from('x-ms-blob-content-type: application/json', 'ascii');
      const afterLines = ['Content-Type: application/octet-stream'];
      const after = Buffer.from(
        `\r\n${afterLines.length ? `${afterLines.join('\r\n')}\r\n` : ''}` +
        `Content-Length: ${payload.length}\r\nConnection: close\r\n\r\n`,
        'ascii',
      );
      socket.write(Buffer.concat([before, property, suffix, after, payload]));
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

const results = [];
const variants = [
  ['current-raw', null, Buffer.from([0x85])],
  ['2012-raw', '2012-02-12', Buffer.from([0x85])],
  ['2011-raw', '2011-08-18', Buffer.from([0x85])],
  ['2009-raw', '2009-09-19', Buffer.from([0x85])],
  ['2012-utf8', '2012-02-12', Buffer.from([0xc2, 0x85])],
  ['2011-utf8', '2011-08-18', Buffer.from([0xc2, 0x85])],
  ['2009-utf8', '2009-09-19', Buffer.from([0xc2, 0x85])],
];
for (const [label, protocolVersion, suffix] of variants) {
  const name = `raw-tls-${process.env.GITHUB_RUN_ID}-${label}.json`;
  try {
    const created = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      mimeType: StringValue.create({ value: metadataType }),
      version: 7,
    });
    const uploaded = await rawPut(created.signedUploadUrl, protocolVersion, suffix);
    if (uploaded.status !== 201) {
      results.push({ label, uploadStatus: uploaded.status, response: uploaded.response.toString('latin1').slice(0, 300) });
      continue;
    }
    const finalized = await client.FinalizeArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      size: String(payload.length),
      hash: StringValue.create({ value: `sha256:${createHash('sha256').update(payload).digest('hex')}` }),
    });
    const { signedUrl } = await client.GetSignedArtifactURL({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
    });
    const old = await coreGet(`${signedUrl}&api-version=2012-02-12`);
    results.push({
      label,
      uploadStatus: uploaded.status,
      artifactId: finalized.artifactId,
      downloadStatus: old.status,
      typeCodePoints: [...old.type].map(char => char.codePointAt(0).toString(16)).join(','),
      payload: old.body.equals(payload),
    });
  } catch (error) {
    results.push({ label, error: String(error?.stack || error).slice(0, 300) });
  }
}

const report = JSON.stringify(results);
console.log(report);
console.log(`::notice title=Raw TLS blob header probe::${report.replaceAll('%', '%25')}`);
