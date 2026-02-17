## Knowledge Workspace (~/.openclaw/workspace/)

Moltbot has a persistent knowledge workspace at `~/.openclaw/workspace/`. Check it for context before starting work:

- `~/.openclaw/workspace/projects/` — Per-project context (scratchpad, moltbot). Read `context.md` for architecture & known bugs.
- `~/.openclaw/workspace/research/` — Tech research (gemini-api, playwright, emdash, agentic-loops)
- `~/.openclaw/workspace/memory/` — Patterns that work (`patterns.md`), mistakes to avoid (`mistakes.md`), diagnosis effectiveness
- `~/.openclaw/workspace/skills/` — Skill playbooks (voice-qa, visual-qa, security, pr-workflow)
- `~/.openclaw/workspace/docs/runbooks/` — Step-by-step procedures (e.g., voice-qa-loop.md)

When you learn something new, file it in the appropriate `~/.openclaw/workspace/` directory.

## Cross-Session Checkpoint Protocol (MANDATORY)

### On Session Start

1. Read `CHECKPOINT.md` at project root FIRST — it tells you what phase, what was done, what's next
2. Read the master plan: `~/.claude/plans/serene-enchanting-pumpkin.md`
3. Check `guides/project/GOALS.md` for active goals and success criteria
4. Check `guides/project/PROGRESS.md` for recent work session history

### During Work

- Work on the NEXT ACTION listed in `CHECKPOINT.md`
- When you complete a task, check it off in `CHECKPOINT.md`
- Create git commits frequently (every meaningful unit of work)

### On Session End (BEFORE stopping)

1. Update `CHECKPOINT.md` with:
   - What you did this session (Last Session section)
   - Check off completed Next Actions
   - Add new Next Actions if you discovered work
   - Update Current Phase if a phase completed
   - Note any new blockers
2. Append to `guides/project/PROGRESS.md` with a work session entry
3. Git commit the checkpoint: `git add CHECKPOINT.md guides/project/PROGRESS.md && git commit -m "checkpoint: <summary>"`
4. Entire.io will auto-save a checkpoint on the shadow branch

### Phase Definitions (from master plan)

- **Phase -1:** Remove Bottlenecks — DONE
- **Phase 0:** First Blood (first dollar from bug bounty or channel bot) — CURRENT
- **Phase 1:** Swarm Expands (50+ programs, 20+ bots, voice MVP)
- **Phase 2:** Compound Machine (100+ scans, 100+ bots, agents building agents)
- **Phase 3:** The Army (self-sustaining, $20K+/month)

## Endless Mode Protocol

When you see `[ENDLESS MODE]` in your prompt, you are running autonomously in a loop:

1. **Read CHECKPOINT.md first** — it's your only link to previous sessions
2. **Work on the next unchecked item** — don't re-do completed work
3. **Update CHECKPOINT.md frequently** — every completed task, every 10-15 minutes of work
4. **Commit often** — small, descriptive commits so nothing is lost
5. **When ALL items are done** — add `STATUS: COMPLETE` at the very top of CHECKPOINT.md
6. **Don't ask questions** — work autonomously; if blocked, note the blocker in CHECKPOINT.md and move to the next item
7. **Before context fills up** — save your progress to CHECKPOINT.md so the next session can continue

The Stop hook will block you from exiting if CHECKPOINT.md hasn't been updated recently.

## Subagent Scaling Rules

Scale the number of parallel subagents based on task complexity:

| Task Type               | Subagents | Examples                                 |
| ----------------------- | --------- | ---------------------------------------- |
| Simple fix / lookup     | 0         | Typo fix, read a file, one-liner         |
| Medium (1-2 files)      | 1-2       | Add a function, fix a bug, small feature |
| Large (3+ files)        | 3-4       | New tool, multi-file feature, refactor   |
| Research / architecture | 4-5       | Codebase exploration, design decisions   |

## Tools-First Rule

For every user request, **default to building a reusable tool** — not a one-off script.

- Tools go in `projects/openclaw/tools/`
- Each tool works as both a CLI script (`node --import tsx tools/X.ts '{...}'`) and an importable module
- Tools output structured JSON for composability
- Name tools by what they DO: `http-probe`, `idor-scan`, `race-test`, not `helper` or `utils`

## Agent Tool Design Principles (from DeepAgents/Codex research)

Apply these when building any tool or agent harness:

### 1. Context Engineering for Agents

- Onboard every tool with context: what directory structure to expect, what other tools exist, known pitfalls
- Include problem-solving strategies in tool headers (not just API docs)
- Reduce the error surface by providing examples of correct usage in the tool's help text

### 2. Self-Verification Built In

- Every tool MUST verify its own output before returning results
- Don't trust the first plausible result — run sanity checks (e.g., IDOR scanner should verify baseline works before testing IDs)
- Tools should include a `--verify` or `--dry-run` mode where practical
- When a tool finds something, it should attempt to confirm (e.g., re-request with different timing)

### 3. Tracing as Feedback

- Every tool outputs structured JSON with timing, request/response details, and evidence
- Include enough context in results for the agent to debug failures (not just "failed" — WHY it failed)
- Log what was tried, what worked, what didn't — so the next run can learn from it

### 4. Detect and Fix Bad Patterns

- No blind retries — if a request fails, diagnose WHY before retrying
- Validate inputs before making network requests (is the URL valid? is the auth token present?)
- Include rate-limit awareness — back off when getting 429s, don't hammer endpoints
- Timeout handling — every network call has a timeout, every tool has a max runtime

### 5. Composability Over Monoliths

- Tools should be small and composable — `http-probe` feeds into `idor-scan` which feeds into `auth-matrix`
- Export types and functions so tools can import each other
- Each tool handles ONE concern well, not everything poorly

## Moltbot QA Integration

When `QA-FEEDBACK.md` exists in this project, read it FIRST before responding.
It contains automated QA test results. Address all CRITICAL and MAJOR issues before other work.
After fixing issues, delete or rename the file to signal completion.
