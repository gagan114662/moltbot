#!/usr/bin/env bash
# ============================================================================
# Endless Mode — Claude Code never stops working
#
# Runs Claude Code in a loop. When one session ends (context exhaustion,
# completion, or error), it checks CHECKPOINT.md. If work remains, a new
# session starts automatically with full context of what was done and what's
# next.
#
# Usage:
#   ./scripts/endless.sh "Build the payment integration"
#   ./scripts/endless.sh                          # continues from CHECKPOINT.md
#   MAX_SESSIONS=100 ./scripts/endless.sh         # raise session limit
#   ENDLESS_MODEL=opus ./scripts/endless.sh       # use specific model
#   ENDLESS_BUDGET=5.00 ./scripts/endless.sh      # per-session budget cap
#
# The script writes a log to .endless/sessions.log and stores per-session
# transcripts in .endless/session-N.log.
# ============================================================================
set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

# --- Configuration ---
MAX_SESSIONS="${MAX_SESSIONS:-30}"
ENDLESS_MODEL="${ENDLESS_MODEL:-sonnet}"
ENDLESS_BUDGET="${ENDLESS_BUDGET:-}"
COOLDOWN="${ENDLESS_COOLDOWN:-5}"
CHECKPOINT="$PROJECT_DIR/CHECKPOINT.md"
ENDLESS_DIR="$PROJECT_DIR/.endless"
SESSION_LOG="$ENDLESS_DIR/sessions.log"
INITIAL_PROMPT="${*:-}"

# --- Setup ---
mkdir -p "$ENDLESS_DIR"
echo "" >> "$SESSION_LOG"
echo "========================================" >> "$SESSION_LOG"
echo "Endless mode started: $(date '+%Y-%m-%d %H:%M:%S')" >> "$SESSION_LOG"
echo "Model: $ENDLESS_MODEL | Max sessions: $MAX_SESSIONS" >> "$SESSION_LOG"
echo "Initial prompt: ${INITIAL_PROMPT:-<continue from checkpoint>}" >> "$SESSION_LOG"
echo "========================================" >> "$SESSION_LOG"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║        ENDLESS MODE — Claude Code        ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo -e "${BLUE}Model:${NC}        $ENDLESS_MODEL"
echo -e "${BLUE}Max sessions:${NC} $MAX_SESSIONS"
echo -e "${BLUE}Cooldown:${NC}     ${COOLDOWN}s between sessions"
[ -n "$ENDLESS_BUDGET" ] && echo -e "${BLUE}Budget/session:${NC} \$$ENDLESS_BUDGET"
echo ""

# --- Helper: check if work is complete ---
is_work_complete() {
  if [ ! -f "$CHECKPOINT" ]; then
    return 1  # No checkpoint = not complete
  fi

  # Check for explicit completion marker
  if grep -qi "STATUS:[[:space:]]*COMPLETE" "$CHECKPOINT" 2>/dev/null; then
    return 0
  fi

  # Check if all action items are checked off
  local unchecked
  unchecked=$(grep -cE '^[[:space:]]*[0-9]+\.[[:space:]]*\[ \]' "$CHECKPOINT" 2>/dev/null || echo "0")
  if [ "$unchecked" = "0" ]; then
    # All items checked — but only if there ARE items
    local total
    total=$(grep -cE '^[[:space:]]*[0-9]+\.[[:space:]]*\[' "$CHECKPOINT" 2>/dev/null || echo "0")
    if [ "$total" -gt 0 ]; then
      return 0
    fi
  fi

  return 1
}

# --- Helper: build the prompt for session N ---
build_prompt() {
  local session_num="$1"

  if [ "$session_num" -eq 1 ] && [ -n "$INITIAL_PROMPT" ]; then
    # First session: use the user's prompt, but prepend endless mode context
    cat <<PROMPT
[ENDLESS MODE — Session $session_num/$MAX_SESSIONS]

You are running in ENDLESS MODE. This means:
1. Work continuously until ALL tasks in CHECKPOINT.md are complete
2. Before your context fills up, ALWAYS update CHECKPOINT.md with your progress
3. When all work is done, add "STATUS: COMPLETE" to the top of CHECKPOINT.md
4. If you cannot complete everything in this session, update CHECKPOINT.md with what you did and what's next — another session will automatically continue

Your task: $INITIAL_PROMPT
PROMPT
  else
    # Continuation session
    local last_log="$ENDLESS_DIR/session-$((session_num - 1)).log"
    local last_summary=""
    if [ -f "$last_log" ]; then
      last_summary=$(tail -50 "$last_log" | head -30)
    fi

    cat <<PROMPT
[ENDLESS MODE — Session $session_num/$MAX_SESSIONS — AUTO-CONTINUATION]

You are an automatic continuation of a previous Claude Code session that ran out of context.

CRITICAL INSTRUCTIONS:
1. Read CHECKPOINT.md FIRST — it has everything you need to know
2. Continue working on the NEXT unchecked item in CHECKPOINT.md
3. Work continuously until ALL tasks are complete
4. Before your context fills up, ALWAYS update CHECKPOINT.md with progress
5. When ALL work is done, add "STATUS: COMPLETE" to the top of CHECKPOINT.md
6. Do NOT ask the user questions — work autonomously from the checkpoint
7. Commit your work frequently with descriptive messages

Previous session ended. Pick up where it left off.
PROMPT
  fi
}

# --- Main loop ---
SESSION_NUM=0
TOTAL_START=$(date +%s)

for i in $(seq 1 "$MAX_SESSIONS"); do
  SESSION_NUM=$i

  # Check completion before starting
  if is_work_complete; then
    echo -e "${GREEN}All work complete! (checked before session $i)${NC}"
    echo "$(date '+%Y-%m-%d %H:%M:%S') | COMPLETE before session $i" >> "$SESSION_LOG"
    break
  fi

  echo -e "${YELLOW}━━━ Session $i/$MAX_SESSIONS starting ━━━${NC}"
  echo "$(date '+%Y-%m-%d %H:%M:%S') | Session $i starting" >> "$SESSION_LOG"

  SESSION_START=$(date +%s)
  SESSION_FILE="$ENDLESS_DIR/session-${i}.log"
  PROMPT=$(build_prompt "$i")

  # Build claude command
  CLAUDE_CMD=(claude -p --model "$ENDLESS_MODEL" --permission-mode dontAsk)

  if [ -n "$ENDLESS_BUDGET" ]; then
    CLAUDE_CMD+=(--max-budget-usd "$ENDLESS_BUDGET")
  fi

  # Run Claude Code
  echo "$PROMPT" | "${CLAUDE_CMD[@]}" 2>&1 | tee "$SESSION_FILE" || true

  SESSION_END=$(date +%s)
  SESSION_DURATION=$(( SESSION_END - SESSION_START ))
  SESSION_MINS=$(( SESSION_DURATION / 60 ))

  echo -e "${BLUE}Session $i ended after ${SESSION_MINS}m${SESSION_DURATION}s${NC}"
  echo "$(date '+%Y-%m-%d %H:%M:%S') | Session $i ended (${SESSION_MINS}m${SESSION_DURATION}s)" >> "$SESSION_LOG"

  # Check completion after session
  if is_work_complete; then
    echo -e "${GREEN}╔══════════════════════════════════════════╗${NC}"
    echo -e "${GREEN}║           ALL WORK COMPLETE!             ║${NC}"
    echo -e "${GREEN}╚══════════════════════════════════════════╝${NC}"
    echo "$(date '+%Y-%m-%d %H:%M:%S') | COMPLETE after session $i" >> "$SESSION_LOG"
    break
  fi

  # Not done — cool down and continue
  echo -e "${YELLOW}Work remains. Next session in ${COOLDOWN}s...${NC}"
  sleep "$COOLDOWN"
done

TOTAL_END=$(date +%s)
TOTAL_DURATION=$(( TOTAL_END - TOTAL_START ))
TOTAL_MINS=$(( TOTAL_DURATION / 60 ))

echo ""
echo -e "${CYAN}Endless mode finished after $SESSION_NUM sessions (${TOTAL_MINS}m total)${NC}"
echo "$(date '+%Y-%m-%d %H:%M:%S') | Endless mode finished: $SESSION_NUM sessions, ${TOTAL_MINS}m" >> "$SESSION_LOG"

# Final status
if is_work_complete; then
  echo -e "${GREEN}Result: ALL TASKS COMPLETE${NC}"
else
  echo -e "${RED}Result: INCOMPLETE (hit session limit $MAX_SESSIONS)${NC}"
  echo -e "${YELLOW}Run again to continue: ./scripts/endless.sh${NC}"
fi
