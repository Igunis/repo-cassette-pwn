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
  ['nel', '\u0085'],
  ['latin_extended', '\u0185'],
  ['ipa', '\u0285'],
  ['greek', '\u0385'],
  ['cyrillic', '\u0485'],
  ['armenian', '\u0585'],
  ['georgian', '\u1085'],
  ['enclosed', '\u2485'],
  ['cjk', '\u3085'],
  ['halfwidth', '\uff85'],
];

const rows = [];
for (const [label, suffix] of cases) {
  const mime = `application/json${suffix}`;
  const name = `unicode-mime-${process.env.GITHUB_RUN_ID}-${label}`;
  const row = { label, codepoint: suffix.codePointAt(0).toString(16) };
  try {
    const created = await client.CreateArtifact({
      workflowRunBackendId: ids.workflowRunBackendId,
      workflowJobRunBackendId: ids.workflowJobRunBackendId,
      name,
      mimeType: StringValue.create({ value: mime }),
      version: 7,
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
console.log('::notice title=Unicode MIME probe::' + JSON.stringify(rows).replaceAll('%', '%25'));
