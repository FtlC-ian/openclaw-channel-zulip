#!/usr/bin/env bash
set -euo pipefail

if [[ "$DISPATCH_REPOSITORY" != "FtlC-ian/openclaw-channel-zulip" || "$DISPATCH_REF" != "refs/heads/main" ]]; then
  echo "Live credentials are available only to workflows dispatched from this repository's main branch" >&2
  exit 1
fi
if [[ "$DISPATCH_ACTOR" != "FtlC-ian" ]]; then
  echo "Live candidates may be dispatched only by the repository owner" >&2
  exit 1
fi

candidate="${REQUESTED_SHA:-$GITHUB_SHA}"
candidate_ref="${REQUESTED_REF:-main}"
if [[ ! "$candidate" =~ ^[0-9a-f]{40}$ ]]; then
  echo "candidate_sha must be a full lowercase commit SHA" >&2
  exit 1
fi
if ! git check-ref-format --branch "$candidate_ref" >/dev/null; then
  echo "candidate_ref must be a valid branch name" >&2
  exit 1
fi

git fetch --no-tags origin "refs/heads/$candidate_ref:refs/remotes/origin/$candidate_ref"
git cat-file -e "$candidate^{commit}"
if ! git merge-base --is-ancestor "$candidate" "refs/remotes/origin/$candidate_ref"; then
  echo "Refusing to expose live credentials to a commit not reachable from candidate_ref" >&2
  exit 1
fi
echo "sha=$candidate" >> "$GITHUB_OUTPUT"
