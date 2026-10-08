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
   clean feature disablement and preserved fallback paths.
4. Merge, then publish from a clean checkout of `main` at the release commit with
   `npm publish`. Run `npm logout` afterwards on shared machines.
5. Confirm the registry tarball matches a local `npm pack` of the same commit, then
   create the `v<version>` tag and GitHub release from the changelog section.
