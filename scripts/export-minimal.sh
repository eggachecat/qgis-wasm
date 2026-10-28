#!/usr/bin/env bash
# The minimal open-source branch: what compiles the QGIS desktop to WebAssembly and shows it, nothing else —
# toolchain scripts, the patch, vcpkg overlay ports, web/minimal (one static page), docs/BUILD.md, the minimal smoke test.
#
#   scripts/export-minimal.sh [branch = github/minimal]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
BRANCH=${1:-github/minimal}
SRC=$(git rev-parse --short HEAD)
WT=$(mktemp -d)
trap 'git worktree remove --force "$WT" 2>/dev/null; git branch -D -q "$BRANCH.tmp" 2>/dev/null; true' EXIT
git worktree add --detach -q "$WT" HEAD
(
  cd "$WT"
  git checkout -q --orphan "$BRANCH.tmp"
  KEEP=(.gitignore .gitmodules LICENSE vcpkg.json patches build/vcpkg-ports build/vcpkg-triplets build/vcpkg-toolchains
        scripts/bootstrap.sh scripts/env.sh scripts/build-deps.sh scripts/build-qgis.sh scripts/apply-patches.sh scripts/export-patches.sh
        scripts/compress-bundle.mjs scripts/stage-web.sh scripts/serve.mjs scripts/build-errors.py scripts/make-demo-project.py
        web/minimal web/fonts web/OpenSans-OFL.txt web/qgis_global_settings.ini web/demo docs/BUILD.md tests/e2e/minimal.py external/QGIS)
  git ls-files -z | while IFS= read -r -d '' f; do
    keep=0; for k in "${KEEP[@]}"; do case "$f" in "$k"|"$k"/*) keep=1; break;; esac; done
    [ "$keep" = 1 ] || { git rm -q --cached "$f"; rm -f "$f"; }
  done
  find . -type d -empty -not -path './.git*' -not -path './external*' -delete
  git mv web/minimal/README.md README.md
  # the minimal AGENTS.md: the build and patch rules of the full one, nothing about the web layers
  awk '/^## 1\. Layout/{skip=1} /^## 2\. Build/{skip=0} !skip' "$ROOT/AGENTS.md" > AGENTS.md
  node "$ROOT/tests/oss-guard.mjs" . --files
  git add -A
  # the submodule is not checked out in a temporary worktree; keep its link (external/QGIS at the pinned upstream commit)
  git update-index --add --cacheinfo "160000,$(git -C "$ROOT" rev-parse HEAD:external/QGIS),external/QGIS"
  TREE=$(git write-tree)
  PARENT=$(git -C "$ROOT" rev-parse -q --verify "refs/heads/$BRANCH" || true)   # on top of the previous export: pushes stay fast-forward
  NEW=$(GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-$(git config user.name || echo export)}" GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-$(git config user.email || echo export@localhost)}" GIT_COMMITTER_NAME="${GIT_AUTHOR_NAME:-$(git config user.name || echo export)}" GIT_COMMITTER_EMAIL="${GIT_AUTHOR_EMAIL:-$(git config user.email || echo export@localhost)}" git commit-tree "$TREE" ${PARENT:+-p "$PARENT"} -m "qgis-wasm minimal: the compiled QGIS desktop and one page, from $SRC")
  git -C "$ROOT" branch -f "$BRANCH" "$NEW"
  git checkout -q --detach "$NEW"
  git branch -D -q "$BRANCH.tmp" 2>/dev/null || true   # (the orphan ref exists only if something was committed on it)
)
echo "branch $BRANCH: $(git rev-parse --short "$BRANCH") ($(git ls-tree -r --name-only "$BRANCH" | wc -l) files)"
