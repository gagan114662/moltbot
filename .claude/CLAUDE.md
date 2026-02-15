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

## Moltbot QA Integration

When `QA-FEEDBACK.md` exists in this project, read it FIRST before responding.
It contains automated QA test results. Address all CRITICAL and MAJOR issues before other work.
After fixing issues, delete or rename the file to signal completion.
