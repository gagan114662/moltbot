#!/usr/bin/env bash
# moltbot-qa-hook
set -uo pipefail
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')
cd "$CWD"

CONTEXT=""
FEEDBACK_FILE=".moltbot/copilot-feedback.json"
if [ -f "$FEEDBACK_FILE" ]; then
  FEEDBACK_OK=$(jq -r '.ok // true' "$FEEDBACK_FILE" 2>/dev/null)
  if [ "$FEEDBACK_OK" = "false" ]; then
    FEEDBACK_SUMMARY=$(jq -r '.summary // "unknown issues"' "$FEEDBACK_FILE" 2>/dev/null)
    CONTEXT="[MOLTBOT QA FAILED] ${FEEDBACK_SUMMARY}
Read QA-FEEDBACK.md for detailed findings and fix instructions."
  fi
fi

if [ -n "$CONTEXT" ]; then
  echo "$CONTEXT"
fi
exit 0
