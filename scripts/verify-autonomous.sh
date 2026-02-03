#!/usr/bin/env bash
set -uo pipefail

MODE="${1:-fast}"
RESULTS_TSV="$(mktemp)"
LOG_DIR="${TMPDIR:-/tmp}/openclaw-verify-$(date +%s)"
mkdir -p "${LOG_DIR}"

declare -a COMMANDS=()
case "${MODE}" in
  fast)
    COMMANDS=(
      "pnpm check"
      "pnpm test --run --passWithNoTests"
    )
    ;;
  full)
    COMMANDS=(
      "pnpm check"
      "pnpm build"
      "pnpm test --run --passWithNoTests"
    )
    ;;
  *)
    echo "Usage: scripts/verify-autonomous.sh [fast|full]" >&2
    exit 2
    ;;
esac

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
