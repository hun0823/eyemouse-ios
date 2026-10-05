#!/usr/bin/env bash
# Requires GH_TOKEN in env (repo + workflow). Run on Linux or Mac.
set -euo pipefail

REPO="${GITHUB_REPOSITORY:-hun0823/eyemouse-ios}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "GH_TOKEN이 없습니다. Cursor Secrets 또는 export GH_TOKEN=... 후 다시 실행하세요."
  exit 1
fi

export GH_TOKEN
gh auth setup-git 2>/dev/null || true

if ! gh repo view "$REPO" >/dev/null 2>&1; then
  echo "Creating public repo $REPO ..."
  gh repo create "$REPO" --public --source=. --remote=github --push --description "아이마우스 iOS (WebGazer wg10) · Capacitor"
else
  git remote remove github 2>/dev/null || true
  git remote add github "https://github.com/${REPO}.git"
  git push -u github main
fi

echo "Dispatching ios-sideload workflow ..."
gh workflow run "ios-sideload.yml" --repo "$REPO" -f bundle_id=com.zio.eyemouse

sleep 3
RUN_URL=$(gh run list --repo "$REPO" --workflow=ios-sideload.yml --limit 1 --json url -q '.[0].url')
echo "Actions run: ${RUN_URL:-https://github.com/${REPO}/actions/workflows/ios-sideload.yml}"
