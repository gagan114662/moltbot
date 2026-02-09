#!/usr/bin/env bash
# UserPromptSubmit hook: auto-enrich prompts with relevant context.
# Adds git diff summary so the agent always knows current state.
set -uo pipefail

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')
PROMPT=$(echo "$INPUT" | jq -r '.prompt // ""')
cd "$CWD"

# Only enrich for task-like prompts (skip greetings, questions)
WORD_COUNT=$(echo "$PROMPT" | wc -w | tr -d ' ')
if [ "$WORD_COUNT" -lt 3 ]; then
  exit 0
fi

CONTEXT=""

# Show current dirty state (if any) so agent knows what's already changed
DIFF_STAT=$(git diff --stat HEAD 2>/dev/null | tail -5)
if [ -n "$DIFF_STAT" ]; then
  CONTEXT="Current uncommitted changes:
${DIFF_STAT}
"
fi

# Check for recent test failures
if [ -f "memory/failures.jsonl" ]; then
  RECENT_FAILS=$(tail -5 memory/failures.jsonl 2>/dev/null | jq -r '"- \(.tool): \(.error)"' 2>/dev/null | head -5)
  if [ -n "$RECENT_FAILS" ]; then
    CONTEXT="${CONTEXT}
Recent tool failures (be aware):
${RECENT_FAILS}
"
  fi
fi

# Copilot feedback injection (from background verification daemon)
FEEDBACK_FILE=".moltbot/copilot-feedback.json"
if [ -f "$FEEDBACK_FILE" ]; then
  FEEDBACK_OK=$(jq -r '.ok // true' "$FEEDBACK_FILE" 2>/dev/null)
  FEEDBACK_TS=$(jq -r '.timestamp // empty' "$FEEDBACK_FILE" 2>/dev/null)
  STALE=""

  # Check staleness (>5min = stale)
  if [ -n "$FEEDBACK_TS" ]; then
    EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${FEEDBACK_TS%%.*}" "+%s" 2>/dev/null || echo "0")
    AGE=$(( $(date "+%s") - EPOCH ))
    if [ "$AGE" -gt 300 ]; then
      STALE=" (stale: ${AGE}s ago)"
    fi
  fi

  if [ "$FEEDBACK_OK" = "false" ]; then
    FEEDBACK_SUMMARY=$(jq -r '.summary // "unknown issues"' "$FEEDBACK_FILE" 2>/dev/null)
    CONTEXT="${CONTEXT}
Copilot verification FAILED${STALE}:
${FEEDBACK_SUMMARY}
"
  fi
fi

# Keyword search over indexed memory (FTS-like, 3s timeout)
FIRST_WORDS=$(echo "$PROMPT" | head -1 | cut -c1-120)
MEMORY_HITS=$(timeout 3 npx tsx scripts/memory-bridge.ts search "$FIRST_WORDS" 2>>memory/bridge.log) || true
if [ -n "$MEMORY_HITS" ]; then
  CONTEXT="${CONTEXT}
Related Memory (keyword search):
${MEMORY_HITS}
"
fi

if [ -n "$CONTEXT" ]; then
  echo "$CONTEXT"
fi

exit 0
