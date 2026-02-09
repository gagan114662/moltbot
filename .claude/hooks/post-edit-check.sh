#!/usr/bin/env bash
# PostToolUse hook (async): lint/typecheck after every file write/edit.
# Catches issues immediately so they don't compound.
set -uo pipefail

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

# Only check TypeScript/JavaScript files
case "$FILE_PATH" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.mts) ;;
  *) exit 0 ;;
esac

# Skip node_modules, dist, generated files
case "$FILE_PATH" in
  */node_modules/*|*/dist/*|*/.bundle.hash) exit 0 ;;
esac

CWD=$(echo "$INPUT" | jq -r '.cwd // "."')
cd "$CWD"

ISSUES=""

# Quick lint check on the specific file (fast — ~2s)
LINT_OUT=$(pnpm exec oxlint "$FILE_PATH" 2>&1) || {
  ISSUES="${ISSUES}Lint issues in ${FILE_PATH}:
${LINT_OUT}

"
}

# Check for common quality violations in the changed file
if [ -f "$FILE_PATH" ]; then
  VIOLATIONS=""
  # console.log left behind
  if grep -n 'console\.log\b' "$FILE_PATH" 2>/dev/null | head -5 | grep -q .; then
    VIOLATIONS="${VIOLATIONS}- console.log found (remove before commit)
"
  fi
  # debugger statements
  if grep -n '^\s*debugger' "$FILE_PATH" 2>/dev/null | head -3 | grep -q .; then
    VIOLATIONS="${VIOLATIONS}- debugger statement found
"
  fi
  # @ts-ignore without justification
  if grep -n '@ts-ignore' "$FILE_PATH" 2>/dev/null | grep -v '// @ts-ignore —' | head -3 | grep -q .; then
    VIOLATIONS="${VIOLATIONS}- @ts-ignore without justification (use '// @ts-ignore — reason')
"
  fi
  # 'any' type (rough check — not perfect)
  if grep -nP ':\s*any\b' "$FILE_PATH" 2>/dev/null | head -3 | grep -q .; then
    VIOLATIONS="${VIOLATIONS}- 'any' type used (prefer strict typing)
"
  fi

  if [ -n "$VIOLATIONS" ]; then
    ISSUES="${ISSUES}Quality violations in ${FILE_PATH}:
${VIOLATIONS}"
  fi
fi

if [ -n "$ISSUES" ]; then
  jq -n --arg msg "$ISSUES" '{ "systemMessage": $msg }'
else
  exit 0
fi
