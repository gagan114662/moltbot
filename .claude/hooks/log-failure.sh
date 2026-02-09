#!/usr/bin/env bash
# PostToolUseFailure hook (async): log failures for pattern detection.
# Over time, reveals recurring issues and informs LEARNED.md updates.
set -uo pipefail

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')
cd "$CWD"

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"')
ERROR=$(echo "$INPUT" | jq -r '.error // "unknown error"')
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}')
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Ensure log directory exists
mkdir -p memory

# Append to failures log (JSONL format for easy parsing)
jq -n \
  --arg ts "$TIMESTAMP" \
  --arg tool "$TOOL_NAME" \
  --arg error "$ERROR" \
  --argjson input "$TOOL_INPUT" \
  '{ "timestamp": $ts, "tool": $tool, "error": $error, "input": $input }' \
  >> memory/failures.jsonl

# Track failure counts per tool (for pattern detection)
FAIL_COUNT="$(grep -c "\"tool\":\"${TOOL_NAME}\"" memory/failures.jsonl 2>/dev/null)" || true
FAIL_COUNT="${FAIL_COUNT##*$'\n'}"
FAIL_COUNT="${FAIL_COUNT:-0}"

# If a tool has failed 5+ times, surface it as a system message
if [ "$FAIL_COUNT" -ge 5 ]; then
  RECENT=$(tail -3 memory/failures.jsonl | jq -r '.error' 2>/dev/null | head -3)
  jq -n --arg msg "Tool '${TOOL_NAME}' has failed ${FAIL_COUNT} times. Recent errors: ${RECENT}. Consider adding a workaround to LEARNED.md." \
    '{ "systemMessage": $msg }'
else
  exit 0
fi

# Refresh failures digest so memory index stays current (async, non-blocking)
npx tsx scripts/memory-bridge.ts refresh-digest >> memory/bridge.log 2>&1 &

# Auto-suggest rules from recurring failure patterns (Phase B)
npx tsx scripts/memory-bridge.ts suggest-rules >> memory/bridge.log 2>&1 &
