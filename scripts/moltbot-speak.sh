#!/bin/bash
# Usage: moltbot-speak.sh "text to speak"
# Requires: jq, curl, afplay (macOS) or ffplay/aplay (Linux)
set -euo pipefail

command -v jq >/dev/null 2>&1 || { echo "Error: jq is required (brew install jq)" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { echo "Error: curl is required" >&2; exit 1; }

TEXT="${1:?Usage: moltbot-speak.sh \"text to speak\"}"
ENDPOINT="${CHATTERBOX_URL:-http://localhost:4123}/v1/audio/speech"
OUTFILE="/tmp/moltbot-speech-$$.wav"
trap 'rm -f "$OUTFILE"' EXIT

# Safe JSON escaping via jq
JSON=$(jq -n --arg text "$TEXT" '{"input":$text,"model":"chatterbox","response_format":"wav"}')

curl -sf -X POST "$ENDPOINT" \
  -H 'Content-Type: application/json' \
  -d "$JSON" \
  --output "$OUTFILE"

# macOS: afplay, Linux: ffplay or aplay
if command -v afplay >/dev/null 2>&1; then
  afplay "$OUTFILE"
elif command -v ffplay >/dev/null 2>&1; then
  ffplay -nodisp -autoexit "$OUTFILE" 2>/dev/null
elif command -v aplay >/dev/null 2>&1; then
  aplay "$OUTFILE"
else
  echo "Error: no audio player found (afplay/ffplay/aplay)" >&2; exit 1
fi
