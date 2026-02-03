#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "${ROOT}" ]; then
  exit 0
fi
cd "${ROOT}"

if [ "${ALLOW_UNVERIFIED_PUSH:-0}" = "1" ]; then
  echo "[pre-push] WARNING: skipping verification because ALLOW_UNVERIFIED_PUSH=1"
  exit 0
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "[pre-push] ERROR: working tree is not clean."
  echo "[pre-push] Commit or stash all changes so pushed SHA matches what you verified."
  exit 1
fi

SHA="$(git rev-parse --short HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "[pre-push] Verifying ${BRANCH} @ ${SHA}"

if [ -x "./scripts/verify-autonomous.sh" ]; then
  ./scripts/verify-autonomous.sh fast
else
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "[pre-push] ERROR: pnpm is required."
    exit 1
  fi
  pnpm check
  pnpm test --run --passWithNoTests
fi

echo "[pre-push] PASS ${BRANCH} @ ${SHA}"
