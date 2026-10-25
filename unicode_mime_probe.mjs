const artifactEntry = import.meta.resolve('@actions/artifact');
const artifactLib = new URL('.', artifactEntry);
const [{ internalArtifactTwirpClient }, { getBackendIdsFromToken }, { StringValue }] = await Promise.all([
  import(new URL('internal/shared/artifact-twirp-client.js', artifactLib)),
  import(new URL('internal/shared/util.js', artifactLib)),
  import(new URL('generated/index.js', artifactLib)),
]);

const ids = getBackendIdsFromToken();
const client = internalArtifactTwirpClient({ maxAttempts: 1 });
const cases = [
  ['v7_leading_nel', 7, '\u0085application/json'],
  ['v7_trailing_nel', 7, 'application/json\u0085'],
  ['v6_leading_nel', 6, '\u0085application/json'],
  ['v7_plain_json_control', 7, 'application/json'],
];

const rows = [];
for (const [label, version, mime] of cases) {
  const name = `unicode-mime-${process.env.GITHUB_RUN_ID}-${label}`;
  const row = { label, version, mime_hex: Buffer.from(mime, 'latin1').toString('hex') };
  try {
    const created = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      mimeType: StringValue.create({ value: mime }),
      version,
    });
    row.created = Boolean(created.ok);
    if (created.ok) {
      const signed = await client.GetSignedArtifactURL({
        workflowRunBackendId: ids.workflowRunBackendId,
        workflowJobRunBackendId: ids.workflowJobRunBackendId,
        name,
      });
      row.rsct = new URL(signed.signedUrl).searchParams.get('rsct');
    }
  } catch (error) {
    row.error = String(error?.message || error).slice(0, 140);
  }
  rows.push(row);
}
console.log('::notice title=Leading NEL delivery probe::' + JSON.stringify(rows).replaceAll('%', '%25'));
