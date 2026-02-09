#!/usr/bin/env bash
# SessionStart hook: load engineering context so every session starts informed.
set -uo pipefail

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')
cd "$CWD"

CONTEXT=""

# Git state — what branch, what's changed, recent work
BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
CONTEXT="${CONTEXT}## Git State
Branch: ${BRANCH}
"

CHANGED_FILES=$(git diff --name-only HEAD 2>/dev/null | head -20)
STAGED_FILES=$(git diff --cached --name-only 2>/dev/null | head -20)
if [ -n "$CHANGED_FILES" ] || [ -n "$STAGED_FILES" ]; then
  CONTEXT="${CONTEXT}Uncommitted changes:
${CHANGED_FILES}${STAGED_FILES}
"
fi

RECENT_COMMITS=$(git log --oneline -5 2>/dev/null || echo "none")
CONTEXT="${CONTEXT}Recent commits:
${RECENT_COMMITS}
"

# Definition of Done — the gates that must pass before "done"
if [ -f "DoD.md" ]; then
  DOD=$(cat DoD.md)
  CONTEXT="${CONTEXT}
${DOD}
"
fi

# Learned rules — accumulated engineering wisdom
if [ -f "memory/LEARNED.md" ]; then
  LEARNED=$(cat memory/LEARNED.md)
  CONTEXT="${CONTEXT}
## Learned Rules (from past sessions)
${LEARNED}
"
fi

# Active goals
if [ -f "GOALS.md" ]; then
  GOALS=$(head -60 GOALS.md)
  CONTEXT="${CONTEXT}
## Active Goals
${GOALS}
"
fi

# Test health snapshot (fast — just counts)
if command -v pnpm &>/dev/null; then
  TEST_COUNT=$(find src extensions -name '*.test.ts' 2>/dev/null | wc -l | tr -d ' ')
  CONTEXT="${CONTEXT}
## Project Stats
Test files: ${TEST_COUNT}
"
fi

# Refresh digests (PID-based lock to avoid double-run, 10min TTL)
LOCKFILE="/tmp/moltbot-digest.lock"
RUN_REFRESH=false
if [ -f "$LOCKFILE" ]; then
  OLDPID=$(cat "$LOCKFILE" 2>/dev/null)
  LOCK_AGE=$(( $(date +%s) - $(stat -f%m "$LOCKFILE" 2>/dev/null || echo 0) ))
  if [ "$LOCK_AGE" -gt 600 ]; then
    rm -f "$LOCKFILE"
    RUN_REFRESH=true
  elif [ -n "$OLDPID" ] && kill -0 "$OLDPID" 2>/dev/null; then
    : # already running, skip
  else
    rm -f "$LOCKFILE"
    RUN_REFRESH=true
  fi
else
  RUN_REFRESH=true
fi
if [ "$RUN_REFRESH" = true ]; then
  echo $$ > "$LOCKFILE"
  npx tsx scripts/memory-bridge.ts refresh-digest >> memory/bridge.log 2>&1 || true
  rm -f "$LOCKFILE"
fi

# Inject shared context (capped)
if [ -f "memory/shared/SHARED-LEARNED.md" ]; then
  SHARED=$(tail -50 memory/shared/SHARED-LEARNED.md)
  CONTEXT="${CONTEXT}
## Shared Rules (cross-agent)
${SHARED}
"
fi
if [ -f "memory/shared/discoveries.md" ]; then
  DISC=$(tail -10 memory/shared/discoveries.md)
  CONTEXT="${CONTEXT}
## Recent Discoveries
${DISC}
"
fi

echo "$CONTEXT"
