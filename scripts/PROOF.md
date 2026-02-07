# Deterministic Proof Run

Use `proof-run.sh` to reduce false proof runs caused by wrong tab/route/service drift.

## Quick run

```bash
bash scripts/proof-run.sh fast
```

Notes:
- If `APP_URL` is not set, `proof-run.sh` auto-detects a live app from:
  - `http://localhost:3010/app`
  - `http://localhost:3000/app`
  - `http://localhost:5173/app`
  - `http://localhost:5174/app`
- Override candidates:
  - `APP_CANDIDATES="http://localhost:3000/app,http://localhost:8080/app"`

## Optional scripted journey

Set `PROOF_STEPS_FILE` to a JSON file:

```json
{
  "steps": [
    { "action": "waitFor", "selector": "input[name='age']" },
    { "action": "fill", "selector": "input[name='age']", "value": "12" },
    { "action": "fill", "selector": "input[name='learning_goal']", "value": "python basics" },
    { "action": "click", "selector": "button[type='submit']" },
    { "action": "screenshot", "label": "onboarding-submitted" }
  ]
}
```

Run:

```bash
APP_URL="http://localhost:3010/app" \
PROOF_STEPS_FILE="/absolute/path/to/proof-steps.json" \
bash scripts/proof-run.sh full
```

Auto-start app if none is live:

```bash
APP_START_CMD="npm --prefix /path/to/frontend run dev -- --port 3000" \
bash scripts/proof-run.sh fast
```

Outputs:
- `artifacts/proof/run-*/proof-report.json`
- `artifacts/proof/run-*/video/*.webm`
- `artifacts/proof/run-*/screenshots/*.png`
- `artifacts/proof/run-*/evidence.json`
