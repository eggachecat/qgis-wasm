#!/usr/bin/env bash
# The open-source branches, produced from this checkout (which may carry a deployment overlay in internal/):
#
#   github/main     everything except internal/ — the default branch of the public repository (full: shell, cloud
#                   mounts, sharing, MCP server, Web Agent, Python plugins; the plain brand, presets without keys)
#   github/minimal  only what compiles QGIS to WebAssembly and shows it (scripts/export-minimal.sh)
#
# Each run adds one commit on top of the branch (the whole tree as of the current HEAD; pushes stay fast-forward) and
# refuses to export a tree that still names the overlay's hosts, products or keys (tests/oss-guard.mjs).
#
#   scripts/export-oss.sh [main branch = github/main] [--no-minimal]
#   git push <github remote> github/main:main github/minimal:minimal github/pages:gh-pages
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
BRANCH=${1:-github/main}; [ "${1:-}" = --no-minimal ] && BRANCH=github/main
SRC=$(git rev-parse --short HEAD)
[ -z "$(git status --porcelain --untracked-files=no --ignore-submodules=all -- . ':!docs/screenshots')" ] || { echo "commit or stash your changes first (the export is made from HEAD)" >&2; exit 1; }
WT=$(mktemp -d)
trap 'git worktree remove --force "$WT" 2>/dev/null; git branch -D -q "$BRANCH.tmp" 2>/dev/null; true' EXIT
git worktree add --detach -q "$WT" HEAD
(
  cd "$WT"
  git checkout -q --orphan "$BRANCH.tmp"
  git rm -rfq --cached internal >/dev/null 2>&1 || true
  rm -rf internal
  node "$ROOT/tests/oss-guard.mjs" . --files
  git add -A
  # the submodule is not checked out in a temporary worktree; keep its link (external/QGIS at the pinned upstream commit)
  git update-index --add --cacheinfo "160000,$(git -C "$ROOT" rev-parse HEAD:external/QGIS),external/QGIS"
  TREE=$(git write-tree)
  PARENT=$(git -C "$ROOT" rev-parse -q --verify "refs/heads/$BRANCH" || true)   # on top of the previous export: pushes stay fast-forward
  NEW=$(GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-$(git config user.name || echo export)}" GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-$(git config user.email || echo export@localhost)}" GIT_COMMITTER_NAME="${GIT_AUTHOR_NAME:-$(git config user.name || echo export)}" GIT_COMMITTER_EMAIL="${GIT_AUTHOR_EMAIL:-$(git config user.email || echo export@localhost)}" git commit-tree "$TREE" ${PARENT:+-p "$PARENT"} -m "qgis-wasm: open-source tree from $SRC")
  git -C "$ROOT" branch -f "$BRANCH" "$NEW"
  git checkout -q --detach "$NEW"
  git branch -D -q "$BRANCH.tmp" 2>/dev/null || true   # (the orphan ref exists only if something was committed on it)
)
echo "branch $BRANCH: $(git rev-parse --short "$BRANCH") ($(git ls-tree -r --name-only "$BRANCH" | wc -l) files)"
[ "${1:-}" = --no-minimal ] || [ "${2:-}" = --no-minimal ] || "$ROOT/scripts/export-minimal.sh"
