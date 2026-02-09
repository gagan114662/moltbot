#!/usr/bin/env bash
# Stop hook: verify code quality before allowing Claude to finish.
# Prevents premature "done" — the #1 failure mode in autonomous engineering.
set -uo pipefail

INPUT=$(cat)

# Prevent infinite loops: if a Stop hook already triggered continuation, allow stop.
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
  exit 0
fi

CWD=$(echo "$INPUT" | jq -r '.cwd // "."')
cd "$CWD"

# Count changed .ts/.tsx files (staged + unstaged vs HEAD)
CHANGED=$(( $(git diff --name-only HEAD 2>/dev/null | grep -cE '\.(ts|tsx)$' || true) + \
             $(git diff --cached --name-only 2>/dev/null | grep -cE '\.(ts|tsx)$' || true) ))

if [ "$CHANGED" -eq 0 ]; then
  # No source files changed — research/question session, allow stop.
  exit 0
fi

# Run the fast verification suite (typecheck + lint + changed-file tests)
VERIFY_LOG="$(mktemp)"
if bash scripts/verify-autonomous.sh fast > "$VERIFY_LOG" 2>&1; then
  rm -f "$VERIFY_LOG"
  exit 0
fi

# Verification failed — extract what failed and block the stop.
FAILED=$(jq -r '.checks[]? | select(.passed == false) | "- \(.name)"' "$VERIFY_LOG" 2>/dev/null || tail -20 "$VERIFY_LOG")
rm -f "$VERIFY_LOG"

jq -n --arg reason "Verification FAILED. Fix before finishing:
${FAILED}

Run 'scripts/verify-autonomous.sh fast' to re-check." \
  '{ "decision": "block", "reason": $reason }'
