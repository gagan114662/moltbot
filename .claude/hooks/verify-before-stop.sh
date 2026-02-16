#!/usr/bin/env bash
# Stop hook: Taskmaster + code quality verification.
# Two-layer defense against premature "done":
#   1. Taskmaster — checks for incomplete tasks, unresolved errors, pending requests
#   2. Verification — runs typecheck + lint + changed-file tests
# In autonomous mode (OPENCLAW_AUTONOMOUS_MODE=1), skip all checks — agents self-verify.
set -uo pipefail

INPUT=$(cat)

# Autonomous mode bypass — daemon/cron agents manage their own quality gates
if [ "${OPENCLAW_AUTONOMOUS_MODE:-0}" = "1" ]; then
  exit 0
fi

# Endless mode: remind Claude to save checkpoint before stopping
# (The actual checkpoint save happens inside Claude's session via CLAUDE.md instructions)
if [ -f "$CWD/.endless/sessions.log" ] 2>/dev/null || [ -f "${CLAUDE_PROJECT_DIR:-.}/.endless/sessions.log" ] 2>/dev/null; then
  CHECKPOINT_FILE="${CLAUDE_PROJECT_DIR:-$CWD}/CHECKPOINT.md"
  if [ -f "$CHECKPOINT_FILE" ]; then
    # Check if checkpoint was updated recently (within last 60 seconds)
    CHECKPOINT_AGE=$(( $(date +%s) - $(stat -f%m "$CHECKPOINT_FILE" 2>/dev/null || stat -c%Y "$CHECKPOINT_FILE" 2>/dev/null || echo 0) ))
    if [ "$CHECKPOINT_AGE" -gt 120 ]; then
      jq -n '{ "decision": "block", "reason": "ENDLESS MODE: You must update CHECKPOINT.md before stopping. Write what you accomplished and what is next so the next session can continue." }'
      exit 0
    fi
  fi
fi

# Prevent infinite loops: if a Stop hook already triggered continuation, allow stop.
STOP_HOOK_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
  exit 0
fi

CWD=$(echo "$INPUT" | jq -r '.cwd // "."')
# Prefer CLAUDE_PROJECT_DIR (set by Claude Code) over CWD from input
cd "${CLAUDE_PROJECT_DIR:-$CWD}"

# ---------------------------------------------------------------------------
# Taskmaster: track continuation count to prevent infinite loops
# ---------------------------------------------------------------------------
TASKMASTER_MAX="${TASKMASTER_MAX:-10}"
COUNTER_FILE="${TMPDIR:-/tmp}/taskmaster_counter_$$"

# Read or init counter
if [ -f "$COUNTER_FILE" ]; then
  COUNT=$(cat "$COUNTER_FILE")
else
  COUNT=0
fi

# If we've hit the max, allow stop
if [ "$COUNT" -ge "$TASKMASTER_MAX" ]; then
  rm -f "$COUNTER_FILE"
  exit 0
fi

# ---------------------------------------------------------------------------
# Taskmaster: scan for incomplete work signals in transcript context
# ---------------------------------------------------------------------------
TRANSCRIPT_CONTEXT=$(echo "$INPUT" | jq -r '.transcript_suffix // ""')

# Check for signals that work is incomplete
INCOMPLETE_SIGNALS=0
REASONS=""

# Check for unresolved errors / test failures mentioned in recent context
if echo "$TRANSCRIPT_CONTEXT" | grep -qiE '(FAIL|ERROR|failed|broken|crash|bug|fix.*(needed|required)|not.*(working|passing))'; then
  # Only flag if the last message doesn't indicate these were resolved
  if ! echo "$TRANSCRIPT_CONTEXT" | tail -5 | grep -qiE '(fixed|resolved|passing|all.*pass|done|complete)'; then
    INCOMPLETE_SIGNALS=$((INCOMPLETE_SIGNALS + 1))
    REASONS="${REASONS}\n- Unresolved errors/failures detected in recent context"
  fi
fi

# Check for TODO/FIXME introduced in this session (exclude hooks/skills which mention these words in detection logic)
TODO_COUNT=$(git diff HEAD -- ':!.claude/hooks/' ':!.agent/skills/' 2>/dev/null | grep -c '^\+.*TODO\|^\+.*FIXME\|^\+.*HACK\|^\+.*XXX' || true)
if [ "$TODO_COUNT" -gt 0 ]; then
  INCOMPLETE_SIGNALS=$((INCOMPLETE_SIGNALS + 1))
  REASONS="${REASONS}\n- ${TODO_COUNT} new TODO/FIXME items in source code"
fi

# If this is the first block attempt AND there are incomplete signals, block
if [ "$INCOMPLETE_SIGNALS" -gt 0 ] && [ "$COUNT" -eq 0 ]; then
  COUNT=$((COUNT + 1))
  echo "$COUNT" > "$COUNTER_FILE"
  jq -n --arg reason "$(printf "Taskmaster: incomplete work detected:\n%b\n\nFinish all tasks before stopping. If work is genuinely complete, try stopping again." "$REASONS")" \
    '{ "decision": "block", "reason": $reason }'
  exit 0
fi

# ---------------------------------------------------------------------------
# Code quality verification (existing logic)
# ---------------------------------------------------------------------------

# Count changed .ts/.tsx files (staged + unstaged vs HEAD)
CHANGED=$(( $(git diff --name-only HEAD 2>/dev/null | grep -cE '\.(ts|tsx)$' || true) + \
             $(git diff --cached --name-only 2>/dev/null | grep -cE '\.(ts|tsx)$' || true) ))

if [ "$CHANGED" -eq 0 ]; then
  # No source files changed — research/question session, allow stop.
  rm -f "$COUNTER_FILE"
  exit 0
fi

# Run the fast verification suite (typecheck + lint + changed-file tests)
VERIFY_LOG="$(mktemp)"
if bash scripts/verify-autonomous.sh fast > "$VERIFY_LOG" 2>&1; then
  rm -f "$VERIFY_LOG" "$COUNTER_FILE"
  exit 0
fi

# Verification failed — increment counter and block the stop.
COUNT=$((COUNT + 1))
echo "$COUNT" > "$COUNTER_FILE"

FAILED=$(jq -r '.checks[]? | select(.passed == false) | "- \(.name)"' "$VERIFY_LOG" 2>/dev/null || tail -20 "$VERIFY_LOG")
rm -f "$VERIFY_LOG"

jq -n --arg reason "Verification FAILED (attempt ${COUNT}/${TASKMASTER_MAX}). Fix before finishing:
${FAILED}

Run 'scripts/verify-autonomous.sh fast' to re-check." \
  '{ "decision": "block", "reason": $reason }'
