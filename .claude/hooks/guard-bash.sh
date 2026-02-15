#!/usr/bin/env bash
# PreToolUse hook: block destructive bash commands.
# Safety net — prevents catastrophic mistakes.
# Autonomous mode (OPENCLAW_AUTONOMOUS_MODE=1) relaxes restrictions for daemon/cron agents.
set -uo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if [ -z "$COMMAND" ]; then
  exit 0
fi

AUTONOMOUS="${OPENCLAW_AUTONOMOUS_MODE:-0}"

deny() {
  jq -n --arg reason "$1" '{
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": $reason
    }
  }'
  exit 0
}

# ── ALWAYS blocked (even in autonomous mode) ──────────────────────────────────
# Block recursive deletion of root or home
if echo "$COMMAND" | grep -qE 'rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|rf|-[a-zA-Z]*f[a-zA-Z]*r)\s+(/|~/)\s*$'; then
  deny "Blocked: recursive deletion of root/home is NEVER allowed"
fi

# Block force push to main/master
if echo "$COMMAND" | grep -qE 'git\s+push\s+.*--force.*\s+(main|master)\b'; then
  deny "Blocked: force push to main/master. Use a feature branch."
fi
if echo "$COMMAND" | grep -qE 'git\s+push\s+-f\s+.*\s+(main|master)\b'; then
  deny "Blocked: force push to main/master. Use a feature branch."
fi

# Block DROP TABLE/DATABASE on production
if echo "$COMMAND" | grep -qiE 'DROP\s+(TABLE|DATABASE)\s'; then
  deny "Blocked: DROP TABLE/DATABASE requires explicit approval."
fi

# Block editing node_modules
if echo "$COMMAND" | grep -qE '(vim|nano|sed|cat\s*>)\s+.*node_modules/'; then
  deny "Blocked: never edit node_modules. Updates overwrite changes."
fi

# ── Relaxed in autonomous mode ────────────────────────────────────────────────
if [ "$AUTONOMOUS" != "1" ]; then
  # Block rm -rf of cwd (still allowed in autonomous mode for sandbox cleanup)
  if echo "$COMMAND" | grep -qE 'rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|rf|-[a-zA-Z]*f[a-zA-Z]*r)\s+(\.\s|\./)?\s*$'; then
    deny "Blocked: recursive deletion of cwd is not allowed"
  fi

  # Block git reset --hard without explicit file
  if echo "$COMMAND" | grep -qE 'git\s+reset\s+--hard\s*$'; then
    deny "Blocked: git reset --hard discards all changes. Be specific or stash first."
  fi

  # Block npm publish without OTP
  if echo "$COMMAND" | grep -qE 'npm\s+publish' && ! echo "$COMMAND" | grep -qE '--otp'; then
    deny "Blocked: npm publish requires --otp flag. See CLAUDE.md release section."
  fi
fi

# Allow everything else
exit 0
