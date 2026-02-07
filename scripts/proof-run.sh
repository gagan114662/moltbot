#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-fast}"
APP_URL="${APP_URL:-}"
OUT_DIR="${PROOF_OUT_DIR:-artifacts/proof/run-$(date +%Y%m%d-%H%M%S)}"
EVIDENCE_JSON="${OUT_DIR}/evidence.json"
STEP_FILE="${PROOF_STEPS_FILE:-}"
STRICT_APP_URL="${STRICT_APP_URL:-1}"
CHECK_PLUGINS_FIX="${CHECK_PLUGINS_FIX:-1}"
APP_START_CMD="${APP_START_CMD:-}"
APP_START_TIMEOUT_SEC="${APP_START_TIMEOUT_SEC:-90}"
APP_CANDIDATES="${APP_CANDIDATES:-http://localhost:3010/app,http://localhost:3000/app,http://localhost:5173/app,http://localhost:5174/app}"
PROOF_REQUIRE_PATH="${PROOF_REQUIRE_PATH:-/app}"
PROOF_ENFORCE_ENTRY_FLOW="${PROOF_ENFORCE_ENTRY_FLOW:-1}"
PROOF_ENTRY_MARKERS="${PROOF_ENTRY_MARKERS:-build your learning journey|welcome to ai tutor|sign in to continue your learning journey|question 1 of|assessment mode}"
QA_PROFILE="${QA_PROFILE:-auth-smoke}"
MIN_CHECKPOINTS_FAST="${MIN_CHECKPOINTS_FAST:-2}"
MIN_CHECKPOINTS_FULL="${MIN_CHECKPOINTS_FULL:-5}"
MIN_VIDEO_SEC_FAST="${MIN_VIDEO_SEC_FAST:-2}"
MIN_VIDEO_SEC_FULL="${MIN_VIDEO_SEC_FULL:-8}"
REQUIRE_STEPS_IN_FULL="${REQUIRE_STEPS_IN_FULL:-1}"

mkdir -p "${OUT_DIR}"

tmp_verify="$(mktemp)"
tmp_plugins="$(mktemp)"
tmp_browser="$(mktemp)"
started_pid=""
plugin_status=0
browser_status=0
verify_status=0

cleanup() {
  if [[ -n "${started_pid}" ]]; then
    kill "${started_pid}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

is_reachable() {
  local url="$1"
  curl -fsSL --max-time 3 "${url}" >/dev/null 2>&1
}

find_live_url() {
  local candidates_csv="$1"
  local strict="$2"
  local IFS=','
  for url in ${candidates_csv}; do
    [[ -z "${url}" ]] && continue
    if ! is_reachable "${url}"; then
      continue
    fi
    if [[ "${strict}" == "1" ]]; then
      local body
      body="$(curl -fsSL --max-time 3 "${url}" || true)"
      if [[ -z "${body}" ]]; then
        continue
      fi
      if echo "${body}" | tr '[:upper:]' '[:lower:]' | grep -q "coming soon"; then
        continue
      fi
    fi
    echo "${url}"
    return 0
  done
  return 1
}

echo "[proof-run] mode=${MODE}"
echo "[proof-run] out_dir=${OUT_DIR}"

if [[ -z "${STEP_FILE}" ]]; then
  case "${QA_PROFILE}" in
    auth-smoke)
      if [[ -f "scripts/proof-steps-auth-flow.json" ]]; then
        STEP_FILE="scripts/proof-steps-auth-flow.json"
      fi
      ;;
  esac
fi

if [[ "${MODE}" == "full" && "${REQUIRE_STEPS_IN_FULL}" == "1" && -z "${STEP_FILE}" ]]; then
  echo "[proof-run] ERROR: full mode requires a scripted journey (PROOF_STEPS_FILE)." >&2
  echo "[proof-run] Hint: set PROOF_STEPS_FILE=scripts/proof-steps-auth-flow.json" >&2
  exit 1
fi

# 1) Environment drift guard (route sanity + no coming soon) with auto-discovery
if [[ -z "${APP_URL}" ]]; then
  APP_URL="$(find_live_url "${APP_CANDIDATES}" "${STRICT_APP_URL}" || true)"
fi

if [[ -z "${APP_URL}" && -n "${APP_START_CMD}" ]]; then
  echo "[proof-run] no live app found; starting app via APP_START_CMD"
  /bin/zsh -lc "${APP_START_CMD}" >"${OUT_DIR}/app-start.log" 2>&1 &
  started_pid="$!"
  deadline=$((SECONDS + APP_START_TIMEOUT_SEC))
  while (( SECONDS < deadline )); do
    APP_URL="$(find_live_url "${APP_CANDIDATES}" "${STRICT_APP_URL}" || true)"
    if [[ -n "${APP_URL}" ]]; then
      break
    fi
    sleep 2
  done
fi

if [[ -z "${APP_URL}" ]]; then
  echo "[proof-run] ERROR: no reachable app URL found." >&2
  echo "[proof-run] tried: ${APP_CANDIDATES}" >&2
  echo "[proof-run] set APP_URL explicitly or APP_START_CMD to auto-start your app." >&2
  exit 1
fi
echo "[proof-run] app_url=${APP_URL}"

# 2) Plugin health guard (+ auto-disable broken plugins to reduce runtime drift)
if [[ "${CHECK_PLUGINS_FIX}" == "1" ]]; then
  if node --import tsx scripts/plugins-health.ts --fix >"${tmp_plugins}"; then
    plugin_status=0
  else
    plugin_status=$?
  fi
else
  if node --import tsx scripts/plugins-health.ts >"${tmp_plugins}"; then
    plugin_status=0
  else
    plugin_status=$?
  fi
fi

# 3) Deterministic browser proof capture (video + screenshots)
if ALLOW_COMING_SOON=0 \
  APP_URL="${APP_URL}" \
  PROOF_OUT_DIR="${OUT_DIR}" \
  PROOF_STEPS_FILE="${STEP_FILE}" \
  PROOF_REQUIRE_PATH="${PROOF_REQUIRE_PATH}" \
  PROOF_ENFORCE_ENTRY_FLOW="${PROOF_ENFORCE_ENTRY_FLOW}" \
  PROOF_ENTRY_MARKERS="${PROOF_ENTRY_MARKERS}" \
  node --import tsx scripts/proof-browser.ts >"${tmp_browser}"; then
  browser_status=0
else
  browser_status=$?
fi

quality_status=0
tmp_quality="$(mktemp)"
if python3 - "${tmp_browser}" "${MODE}" "${MIN_CHECKPOINTS_FAST}" "${MIN_CHECKPOINTS_FULL}" "${MIN_VIDEO_SEC_FAST}" "${MIN_VIDEO_SEC_FULL}" >"${tmp_quality}" <<'PY'
import json
import subprocess
import sys
from pathlib import Path

browser = {}
try:
    raw = Path(sys.argv[1]).read_text().strip()
    browser = json.loads(raw) if raw else {}
except Exception:
    browser = {}

mode = sys.argv[2]
min_checkpoints_fast = int(sys.argv[3])
min_checkpoints_full = int(sys.argv[4])
min_video_sec_fast = float(sys.argv[5])
min_video_sec_full = float(sys.argv[6])

min_checkpoints = min_checkpoints_full if mode == "full" else min_checkpoints_fast
min_video_sec = min_video_sec_full if mode == "full" else min_video_sec_fast

checkpoints = browser.get("checkpoints", [])
video_path = browser.get("videoPath")
video_duration_sec = 0.0
if video_path:
    try:
        out = subprocess.check_output(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                video_path,
            ],
            text=True,
        ).strip()
        video_duration_sec = float(out or "0")
    except Exception:
        video_duration_sec = 0.0

errors = []
if len(checkpoints) < min_checkpoints:
    errors.append(
        f"checkpoint_count={len(checkpoints)} below min={min_checkpoints}"
    )
if video_duration_sec < min_video_sec:
    errors.append(
        f"video_duration_sec={video_duration_sec:.2f} below min={min_video_sec:.2f}"
    )

print(
    json.dumps(
        {
            "ok": len(errors) == 0,
            "minCheckpoints": min_checkpoints,
            "actualCheckpoints": len(checkpoints),
            "minVideoSec": min_video_sec,
            "actualVideoSec": video_duration_sec,
            "errors": errors,
        }
    )
)
sys.exit(0 if len(errors) == 0 else 1)
PY
then
  quality_status=0
else
  quality_status=$?
fi

# 4) Command verification lane
if scripts/verify-autonomous.sh "${MODE}" >"${tmp_verify}"; then
  verify_status=0
else
  verify_status=$?
fi

python3 - "${tmp_plugins}" "${tmp_browser}" "${tmp_verify}" "${tmp_quality}" "${EVIDENCE_JSON}" "${APP_URL}" "${OUT_DIR}" "${plugin_status}" "${browser_status}" "${quality_status}" "${verify_status}" <<'PY'
import json
import pathlib
import sys
from datetime import datetime, timezone

def safe_read_json(path_str: str, fallback: dict):
    p = pathlib.Path(path_str)
    if not p.exists():
        return fallback
    raw = p.read_text().strip()
    if not raw:
        return fallback
    try:
        return json.loads(raw)
    except Exception:
        return fallback

plugins = safe_read_json(sys.argv[1], {"ok": False, "error": "plugins-health output missing"})
browser = safe_read_json(sys.argv[2], {"ok": False, "errors": ["proof-browser output missing"]})
verify = safe_read_json(sys.argv[3], {"ok": False, "checks": [], "error": "verify output missing"})
quality = safe_read_json(sys.argv[4], {"ok": False, "errors": ["quality gate output missing"]})
evidence_path = pathlib.Path(sys.argv[5])
app_url = sys.argv[6]
out_dir = sys.argv[7]
plugin_status = int(sys.argv[8])
browser_status = int(sys.argv[9])
quality_status = int(sys.argv[10])
verify_status = int(sys.argv[11])

ok = (
    bool(browser.get("ok"))
    and bool(quality.get("ok"))
    and bool(verify.get("ok"))
    and int(plugins.get("brokenEnabledCount", 0)) == 0
    and plugin_status == 0
    and browser_status == 0
    and quality_status == 0
    and verify_status == 0
)
bundle = {
    "ok": ok,
    "generatedAt": datetime.now(timezone.utc).isoformat(),
    "target": {"appUrl": app_url, "outDir": out_dir},
    "checks": {
        "pluginHealth": plugins,
        "browserProof": browser,
        "proofQuality": quality,
        "verify": verify,
        "exitCodes": {
            "pluginsHealth": plugin_status,
            "browserProof": browser_status,
            "proofQuality": quality_status,
            "verify": verify_status,
        },
    },
    "artifacts": {
        "video": browser.get("videoPath"),
        "screenshots": [c.get("path") for c in browser.get("checkpoints", []) if c.get("path")],
        "browserReport": str(pathlib.Path(out_dir) / "proof-report.json"),
    },
}
evidence_path.write_text(json.dumps(bundle, indent=2) + "\n")
print(json.dumps(bundle, indent=2))
PY

echo "[proof-run] evidence: ${EVIDENCE_JSON}"
if [[ "${verify_status}" != "0" ]]; then
  echo "[proof-run] verify-autonomous failed; see evidence JSON for details."
fi
if [[ "${browser_status}" != "0" ]]; then
  echo "[proof-run] browser proof failed; see evidence JSON for details."
fi
if [[ "${quality_status}" != "0" ]]; then
  echo "[proof-run] proof quality gate failed; see evidence JSON for details."
fi
if [[ "${plugin_status}" != "0" ]]; then
  echo "[proof-run] plugin health had failures; see evidence JSON for details."
fi

if [[ "${plugin_status}" != "0" || "${browser_status}" != "0" || "${quality_status}" != "0" || "${verify_status}" != "0" ]]; then
  exit 1
fi
