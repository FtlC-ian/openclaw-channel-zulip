# Release checklist

Supported hosts: **OpenClaw >=2026.9.3** and **Node.js >=24.16.0 <25 or >=26.1.0**.
The development SDK and lockfile stay pinned to the reviewed OpenClaw baseline in
`package.json`.

1. Open a release pull request from a `release/<version>` branch that bumps
   `package.json`, moves the `Unreleased` changelog entries under the new version,
   and updates this checklist if the requirements changed.
2. Confirm **CI** passes on Node 24.16 and Node 26 for the release commit: build,
   full test suite, `git diff --check`, and the packed-artifact install against the
   locked OpenClaw host.
3. Exercise the changes that matter for the release on a real test gateway,
   installing the packed tarball, and note what was checked in the release PR.
   Check SDK exports and import the built plugin against the newest targeted host
   (including betas), not only the pinned development SDK. `npm run sdk:check --
   /path/to/openclaw/package.json` audits every built SDK specifier. Optional guarded
   imports may be absent on that host only if an import/start smoke test proves
   clean feature disablement and preserved fallback paths. Reaction approvals must
   be enabled on the supported host matrix: run `OPENCLAW_HOST_FIXTURES=/path/to/hosts
   npm run test:hosts` after building, with npm-extracted `<version>/package` hosts.
4. Merge, then publish from a clean checkout of `main` at the release commit with
   `npm publish`. Run `npm logout` afterwards on shared machines.
5. Confirm the registry tarball matches a local `npm pack` of the same commit, then
   create the `v<version>` tag and GitHub release from the changelog section.

## ClawHub publication

ClawHub plugins are separate from ClawHub skills. Before preparing a new release,
keep `openclaw.compat` aligned with the supported host matrix and
`openclaw.build` aligned with the pinned development SDK used for the build.
ClawHub requires `openclaw.compat.pluginApi` and
`openclaw.build.openclawVersion` inside the published package.

Use the standalone ClawHub CLI, verify the publisher with `clawhub whoami`, and
dry-run the exact verified release tarball before uploading it. Include the source
repository, full release commit SHA, and release tag with the CLI source flags.
For a scoped catalog name, the package name inside the archive must use the same
scope as the selected owner. Resolve any package rename and consumer migration
explicitly before releasing; do not substitute a catalog-only name for the npm
artifact name.

Never overwrite or silently replace an already-published npm artifact. The npm
`2026.10.13` artifact predates these required fields and cannot pass current
ClawHub validation unchanged.

### Authorized ClawHub-only artifact for 2026.10.13

The npm name remains `openclaw-channel-zulip`. The owner separately authorized
the catalog artifact `@ftlc-ian/openclaw-channel-zulip@2026.10.13`, derived from
the original npm tarball at release commit
`26a717007c5e2c9e20bca488fecbc69c6fe77fd7`. This is not an npm name migration
or an npm republish. Its root manifest id remains `zulip`.

Download that npm version without running scripts, then use Python 3's standard
library to create the separate artifact (both destinations must be fresh):

    npm pack openclaw-channel-zulip@2026.10.13 --ignore-scripts --pack-destination /path/to/input
    python3 scripts/package-clawhub-2026.10.13.py /path/to/input/openclaw-channel-zulip-2026.10.13.tgz /path/to/output/ftlc-ian-openclaw-channel-zulip-2026.10.13.tgz

The recipe rejects any input other than the verified release SHA-256 and refuses
to overwrite its output. It changes only `package.json.name`,
`openclaw.compat.pluginApi`, and `openclaw.build.openclawVersion`. Every other
file, including all runtime JavaScript, maps, declarations, and the plugin
manifest, is copied byte-for-byte. Archive ordering, timestamps, and ownership
are normalized; the resulting archive has its own digest, not the npm digest.
Compare complete extracted file inventories and contents, semantic package JSON
differences, and two independent recipe outputs before publication.

Use the actual ClawHub CLI on this exact derived tarball, with `--owner ftlc-ian`,
`--source-repo FtlC-ian/openclaw-channel-zulip`, the full release SHA via
`--source-commit`, and `--source-ref v2026.10.13`. Run `--dry-run --json` first.
Only a verified account controlling `ftlc-ian` (or its authorized publisher
manager) may upload. Keep the original npm archive and the separate catalog
archive receipts distinct. Do not change npm versions/tags or installed state.
After publication, verify the catalog version and exact downloaded artifact
identity; pending security review is not installation approval.
