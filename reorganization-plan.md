# Full Codebase Reorganization Plan

## Goal: Every file lives in a logical folder. Nothing floating loose.

---

## PART 1: ROOT LEVEL

### Files that MUST stay at root (tooling demands it)

These break builds/CI/deploys if moved. Non-negotiable:

```
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
tsconfig.json
.pre-commit-config.yaml
.secrets.baseline
.npmrc
.gitignore
.gitattributes
openclaw.mjs
LICENSE
CHANGELOG.md
```

### Move 1: `persona/` — AI identity & soul files

```
BEFORE (root):              AFTER:
  SOUL.md                     persona/SOUL.md
  IDENTITY.md                 persona/IDENTITY.md
  USER.md                     persona/USER.md
  TOOLS.md                    persona/TOOLS.md
  AGENTS.md                   persona/AGENTS.md
  CLAUDE.md (symlink)         persona/CLAUDE.md → AGENTS.md
```

Risk: LOW — not referenced by build tooling
Updates: Symlink path, .claude/CLAUDE.md reference

### Move 2: `docker/` — All container configs

```
BEFORE (root):                    AFTER:
  Dockerfile                        docker/Dockerfile
  Dockerfile.sandbox                docker/Dockerfile.sandbox
  Dockerfile.sandbox-browser        docker/Dockerfile.sandbox-browser
  docker-compose.yml                docker/docker-compose.yml
  docker-setup.sh                   docker/docker-setup.sh
```

Risk: MEDIUM
Updates: fly.toml `build.dockerfile`, render.yaml, CI workflows, dev docs

### Move 3: `deploy/` — Deployment configs

```
BEFORE (root):              AFTER:
  fly.toml                    deploy/fly.toml
  fly.private.toml            deploy/fly.private.toml
  render.yaml                 deploy/render.yaml
  zizmor.yml                  deploy/zizmor.yml
```

Risk: MEDIUM-HIGH (fly CLI expects fly.toml at root by default)
Workaround: `fly deploy --config deploy/fly.toml` or alias

### Move 4: `config/` — All config files consolidated

```
BEFORE (root):                        AFTER:
  tsconfig.plugin-sdk.dts.json          config/ts/tsconfig.plugin-sdk.dts.json
  tsconfig.test.json                    config/ts/tsconfig.test.json
  tsdown.config.ts                      config/build/tsdown.config.ts
  vitest.config.ts                      config/test/vitest.config.ts
  vitest.e2e.config.ts                  config/test/vitest.e2e.config.ts
  vitest.extensions.config.ts           config/test/vitest.extensions.config.ts
  vitest.gateway.config.ts              config/test/vitest.gateway.config.ts
  vitest.live.config.ts                 config/test/vitest.live.config.ts
  vitest.unit.config.ts                 config/test/vitest.unit.config.ts
  .oxlintrc.json                        config/lint/.oxlintrc.json
  .oxfmtrc.jsonc                        config/lint/.oxfmtrc.jsonc
  .markdownlint-cli2.jsonc              config/lint/.markdownlint-cli2.jsonc
  .shellcheckrc                         config/lint/.shellcheckrc
  .swiftlint.yml                        config/lint/.swiftlint.yml
  .swiftformat                          config/lint/.swiftformat
  .detect-secrets.cfg                   config/lint/.detect-secrets.cfg
  .env.example                          config/.env.example
```

Risk: MEDIUM-HIGH — many package.json scripts, CI refs, extends paths to update
Note: tsdown.config.ts and vitest.config.ts may be picky about root location.
If they break, keep those 2 at root and move the rest.

### Move 5: Cleanup strays

```
tmp-refactoring-strategy.md  →  DELETE or archives/
.DS_Store                    →  DELETE (already gitignored)
```

### Proposed root AFTER all moves:

```
openclaw/
  ── folders ──
  .claude/
  .github/
  config/
    build/
    lint/
    test/
    ts/
    .env.example
  deploy/
  docker/
  persona/
  archives/
  extensions/
  git-hooks/
  guides/
  library/
  memory/
  node_modules/
  packages/
  patches/
  projects/
  scripts/
  src/
  ── must-stay files ──
  .gitattributes
  .gitignore
  .npmrc
  .pre-commit-config.yaml
  .secrets.baseline
  CHANGELOG.md
  LICENSE
  openclaw.mjs
  package.json
  pnpm-lock.yaml
  pnpm-workspace.yaml
  tsconfig.json
```

Root files: 12 (down from 25+). Everything else in folders.

---

## PART 2: GUIDES/ — Reorganize docs structure

Current state: guides/ has a flat mix of project management docs and a massive docs/ subfolder.

### Problem

```
guides/
  CONTRIBUTING.md        ← project management
  DoD.md                 ← project management
  GOALS.md               ← project management
  PROGRESS.md            ← project management
  QA-FEEDBACK.md         ← QA
  README.md              ← overview
  SECURITY.md            ← security
  docs.acp.md            ← random doc
  docs/                  ← ENTIRE documentation site (200+ files)
    CNAME
    style.css
    docs.json
    index.md
    assets/
    automation/          (8 docs)
    channels/            (24 docs)
    cli/                 (35 docs)
    concepts/            (22 docs)
    gateway/             (19 docs)
    help/                (8 docs)
    install/             (14 docs)
    nodes/               (8 docs)
    platforms/           (8 docs)
    plugins/             (4 docs)
    providers/           (25 docs)
    reference/           (9 docs)
    refactor/            (5 docs)
    security/            (4 docs)
    start/               (11 docs)
    tools/               (20 docs)
    web/                 (4 docs)
    ja-JP/               (i18n)
    zh-CN/               (i18n)
```

### Proposed structure

```
guides/
  README.md
  project/                    ← project management grouped
    CONTRIBUTING.md
    DoD.md
    GOALS.md
    PROGRESS.md
    SECURITY.md
    docs.acp.md
  qa/                         ← QA stuff grouped
    QA-FEEDBACK.md
  docs/                       ← keep as-is, it's already well-organized
    (no changes needed inside — it's a proper docs site)
```

Risk: LOW — these are reference docs, not build artifacts

---

## PART 3: MEMORY/ — Split by type

Current state: logs, digests, insights, and data all mixed together.

```
BEFORE:
  memory/
    FEEDBACK-HISTORY.md
    HEARTBEAT.md
    INSIGHTS.md
    LEARNED.md
    bridge.log
    failures-digest.md
    failures.jsonl
    insights-cron.log
    session-digest.md
    shared/discoveries.md

AFTER:
  memory/
    knowledge/               ← what the system has learned
      INSIGHTS.md
      LEARNED.md
      shared/
        discoveries.md
    feedback/                ← feedback & history
      FEEDBACK-HISTORY.md
      HEARTBEAT.md
    logs/                    ← log files
      bridge.log
      insights-cron.log
    digests/                 ← summaries & reports
      failures-digest.md
      failures.jsonl
      session-digest.md
```

Risk: LOW-MEDIUM — check if any scripts write to specific memory/ paths

---

## PART 4: LIBRARY/ — Already fine, minor tweak

Current state is okay:

```
library/
  appcast.xml
  verified-bundle.json
  assets/
    avatar-placeholder.svg
    dmg-background.png
    dmg-background-small.png
    chrome-extension/
```

No changes needed. It's small and organized.

---

## PART 5: HIDDEN FOLDERS — Consolidate agent configs

Current problem: There are FOUR overlapping agent/AI config directories:

```
.agent/       ← workflows & skills (13 skills)
.agents/      ← more skills & PR workflow (5 skills)
.openclaw/    ← workspace with clawdstrike skill
.moltbot/     ← evidence & copilot feedback
.claude/      ← Claude Code hooks & settings
.pi/          ← prompt injector extensions
.clawhub/     ← hub lock file
.feedback-loop/  ← session archives
```

### Proposed consolidation

```
.claude/                     ← keep as-is (Claude Code needs this)
.openclaw/                   ← keep as-is (runtime state)

.agents/                     ← MERGE .agent/ into .agents/
  skills/                    ← combine all 18 skills from both dirs
    prepare-pr/
    review-pr/
    merge-pr/
    mintlify/
    clawdstrike/
    docs-update/
    ci-fix/
    taskmaster/
    slack-qa-investigate/
    scheduler/
    seo-aeo-audit/
    web-accessibility-audit/
    create-pull-request/
    webapp-testing/
    web-performance-audit/
    mcp-builder/
    github-bug-report-triage/
    github-issue-dedupe/
    terraform-style-check/
  workflows/
    update_clawdbot.md
    PR_WORKFLOW.md

DELETE .agent/               ← merged into .agents/

.moltbot/                    ← keep (runtime evidence)
.pi/                         ← keep (separate concern)
.clawhub/                    ← keep (hub config)
.feedback-loop/              ← move to archives/feedback-sessions/
```

Risk: MEDIUM — need to check if any scripts reference `.agent/` specifically

---

## PART 6: ARCHIVES/ — Add structure

Current state: flat dump of snapshots and artifacts.

```
BEFORE:
  archives/
    .entire/
      logs/
      metadata/     (8 UUID dirs)
      tmp/
    artifacts/
      proof/        (4 run artifacts)
    dist/           (entire old build output)

AFTER:
  archives/
    snapshots/               ← renamed from .entire/
      logs/
      metadata/
      tmp/
    artifacts/               ← keep
      proof/
    dist/                    ← keep (old builds)
    feedback-sessions/       ← moved from .feedback-loop/
```

Risk: LOW

---

## PART 7: PROJECTS/OPENCLAW/ — Already well-structured

This is actually in good shape:

```
projects/openclaw/
  apps/           ← mobile & desktop (android, ios, macos, shared)
  extensions/     ← 39 channel extensions (each self-contained)
  packages/       ← core packages (clawdbot, moltbot)
  skills/         ← 58 skills (each self-contained)
  src/            ← main source (76 modules, organized by domain)
  test/           ← test infra (fixtures, helpers, mocks)
  ui/             ← web UI
  the-surface/    ← 3D interface
  Swabble/        ← Swift build system
  vendor/         ← third-party code
  scripts/        ← build/utility scripts
```

No changes needed. This is properly organized already.

---

## PART 8: SRC/ — Already well-structured

76 directories organized by domain (channels, agents, gateway, cli, etc.).
No changes needed.

---

## SUMMARY: All changes at a glance

| Change                      | Files moved | Risk     | Priority |
| --------------------------- | ----------- | -------- | -------- |
| Root → persona/             | 5           | LOW      | 1        |
| Root → docker/              | 5           | MED      | 2        |
| Root → config/              | 17          | MED-HIGH | 3        |
| Root → deploy/              | 4           | MED-HIGH | 4        |
| guides/ restructure         | 7           | LOW      | 5        |
| memory/ restructure         | 10          | LOW-MED  | 6        |
| .agent/ → .agents/ merge    | ~15         | MED      | 7        |
| archives/ rename            | 1           | LOW      | 8        |
| .feedback-loop/ → archives/ | 3 dirs      | LOW      | 9        |
| Delete tmp files            | 2           | ZERO     | 10       |

### Things left alone (already clean):

- projects/openclaw/ — well-structured monorepo
- src/ — 76 domain modules, fine
- extensions/ — 39 self-contained extensions
- skills/ — 58 self-contained skills
- library/ — small, organized
- scripts/ — build utilities
- .github/ — proper CI/CD structure
- .claude/ — Claude Code config
- .vscode/ — editor config

---

## EXECUTION ORDER

1. persona/ (zero risk warmup)
2. docker/ (medium risk, big visual win)
3. deploy/ (medium risk)
4. config/ (biggest change — do carefully, test build after)
5. guides/ restructure
6. memory/ restructure
7. .agent/ → .agents/ merge
8. archives/ cleanup
9. delete tmp files
10. update all references (package.json, CI, docs)
11. run full build + test suite to verify nothing broke
