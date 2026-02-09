#!/usr/bin/env bash
# SubagentStart hook: inject quality guidelines and learned rules into every subagent.
# Ensures subagents don't repeat mistakes the main agent already learned from.
set -uo pipefail

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')
cd "$CWD"

CONTEXT=""

# Inject learned rules
if [ -f "memory/LEARNED.md" ]; then
  CONTEXT="## Engineering Rules (from LEARNED.md)
$(cat memory/LEARNED.md)

"
fi

# Inject shared context (cross-agent knowledge)
if [ -f "memory/shared/SHARED-LEARNED.md" ]; then
  SHARED=$(tail -50 memory/shared/SHARED-LEARNED.md)
  CONTEXT="${CONTEXT}## Shared Rules (cross-agent)
${SHARED}

"
fi
if [ -f "memory/shared/discoveries.md" ]; then
  DISC=$(tail -10 memory/shared/discoveries.md)
  CONTEXT="${CONTEXT}## Recent Discoveries
${DISC}

"
fi

# Inject quality standards
CONTEXT="${CONTEXT}## Quality Standards
- No console.log, debugger, or TODO in production code
- No @ts-ignore without justification comment
- No 'any' type — use strict typing
- Run tests for changed files before declaring done
- Preserve existing code patterns and naming conventions
- Keep files under 500 LOC when feasible
"

if [ -n "$CONTEXT" ]; then
  jq -n --arg ctx "$CONTEXT" '{
    "hookSpecificOutput": {
      "hookEventName": "SubagentStart",
      "additionalContext": $ctx
    }
  }'
else
  exit 0
fi
