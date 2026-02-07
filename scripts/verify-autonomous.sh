#!/usr/bin/env bash
set -uo pipefail

MODE="${1:-fast}"
RESULTS_TSV="$(mktemp)"
LOG_DIR="${TMPDIR:-/tmp}/openclaw-verify-$(date +%s)"
mkdir -p "${LOG_DIR}"

declare -a COMMANDS=()
read_commands_from_env() {
  local raw="$1"
  if [[ -z "${raw}" ]]; then
    return 1
  fi
  while IFS= read -r line; do
    [[ -z "${line}" ]] && continue
    COMMANDS+=("${line}")
  done <<<"${raw}"
  return 0
}

# Discover test files related to changed source files (git diff vs HEAD).
# For each changed .ts file, look for colocated *.test.ts files.
discover_changed_tests() {
  local changed_files
  changed_files="$(git diff --name-only HEAD 2>/dev/null; git diff --name-only --cached HEAD 2>/dev/null)"
  if [[ -z "${changed_files}" ]]; then
    return
  fi

  local seen_tests=""
  while IFS= read -r file; do
    [[ -z "${file}" ]] && continue
    # Skip non-ts files and test files themselves
    [[ "${file}" != *.ts ]] && continue
    [[ "${file}" == *.test.ts ]] && continue
    [[ "${file}" == *.e2e.test.ts ]] && continue

    # Look for colocated test file
    local base="${file%.ts}"
    for test_candidate in "${base}.test.ts" "${base}.e2e.test.ts"; do
      if [[ -f "${test_candidate}" ]]; then
        # Deduplicate
        if [[ "${seen_tests}" != *"${test_candidate}"* ]]; then
          echo "${test_candidate}"
          seen_tests="${seen_tests} ${test_candidate}"
        fi
      fi
    done
  done <<<"${changed_files}"
}

if [[ "${MODE}" == "fast" ]]; then
  if ! read_commands_from_env "${VERIFY_COMMANDS_FAST:-}"; then
    COMMANDS=(
      "pnpm exec tsc -p tsconfig.json --noEmit"
      "pnpm check"
    )
    # Add tests for changed files
    while IFS= read -r test_file; do
      [[ -z "${test_file}" ]] && continue
      COMMANDS+=("pnpm exec vitest run ${test_file}")
    done < <(discover_changed_tests)
    # If no changed-file tests found, run the baseline suite
    if [[ ${#COMMANDS[@]} -eq 2 ]]; then
      COMMANDS+=(
        "pnpm exec vitest run src/web/auto-reply/monitor/durable-inbound-queue.test.ts"
        "pnpm exec vitest run src/agents/auth-profiles.auth-profile-cooldowns.test.ts"
        "pnpm exec vitest run src/auto-reply/reply/agent-runner.heartbeat-typing.runreplyagent-typing-heartbeat.resets-corrupted-gemini-sessions-deletes-transcripts.test.ts"
      )
    fi
  fi
elif [[ "${MODE}" == "full" ]]; then
  if ! read_commands_from_env "${VERIFY_COMMANDS_FULL:-}"; then
    COMMANDS=(
      "pnpm exec tsc -p tsconfig.json --noEmit"
      "pnpm check"
      "pnpm build"
    )
    # Count changed files to decide test scope
    changed_count="$(git diff --name-only HEAD 2>/dev/null | wc -l | tr -d ' ')"
    if [[ "${changed_count}" -gt 5 ]]; then
      # Many files changed — run full test suite
      COMMANDS+=("pnpm test")
    else
      # Few files changed — run changed-file tests + baseline
      while IFS= read -r test_file; do
        [[ -z "${test_file}" ]] && continue
        COMMANDS+=("pnpm exec vitest run ${test_file}")
      done < <(discover_changed_tests)
      COMMANDS+=(
        "pnpm exec vitest run src/web/auto-reply/monitor/durable-inbound-queue.test.ts"
        "pnpm exec vitest run src/agents/auth-profiles.auth-profile-cooldowns.test.ts"
        "pnpm exec vitest run src/auto-reply/reply/agent-runner.heartbeat-typing.runreplyagent-typing-heartbeat.resets-corrupted-gemini-sessions-deletes-transcripts.test.ts"
      )
    fi
  fi
else
  echo "Usage: scripts/verify-autonomous.sh [fast|full]" >&2
  exit 2
fi

overall=0
index=0

for cmd in "${COMMANDS[@]}"; do
  index=$((index + 1))
  log_path="${LOG_DIR}/check-${index}.log"
  start_ts="$(date +%s)"

  if bash -lc "${cmd}" >"${log_path}" 2>&1; then
    status=0
  else
    status=$?
    overall=1
  fi

  end_ts="$(date +%s)"
  duration=$((end_ts - start_ts))
  printf "%s\t%s\t%s\t%s\n" "${cmd}" "${status}" "${duration}" "${log_path}" >>"${RESULTS_TSV}"
done

python3 - "${RESULTS_TSV}" "${overall}" <<'PY'
import json
import pathlib
import sys

rows = pathlib.Path(sys.argv[1]).read_text().strip().splitlines()
overall = int(sys.argv[2])
checks = []
for row in rows:
    if not row.strip():
        continue
    command, status, duration, log_path = row.split("\t")
    checks.append({
        "name": command,
        "passed": status == "0",
        "evidence": f"exit={status}, duration={duration}s, log={log_path}",
        "logPath": log_path,
    })

print(json.dumps({"ok": overall == 0, "checks": checks}, indent=2))
PY

rm -f "${RESULTS_TSV}"
exit "${overall}"
