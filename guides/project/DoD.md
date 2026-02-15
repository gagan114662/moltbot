# Definition of Done (DoD)

Per-task checklist that must pass before any work is considered complete.
Enforced by `verify-before-stop.sh` and the copilot worker pipeline.

## Definitions

- **Changed files:** `git diff --name-only HEAD` (unstaged) + `git diff --cached --name-only` (staged). This is the union of all uncommitted modifications vs the last commit.
- **UX eval pass/fail:** The browser-based UX evaluation passes when all interaction steps complete without errors, no console errors are captured, and the page renders without visual regressions. A failure is any unhandled exception, missing element, or interaction timeout during the scripted flow.

## Gates

### Gate 1: Typecheck

- **Command:** `pnpm tsgo`
- **Required:** always
- **Scope:** all `.ts`/`.tsx` files

### Gate 2: Lint + Format

- **Command:** `pnpm check`
- **Required:** always
- **Scope:** all source files

### Gate 3: Changed-file Tests

- **Command:** `pnpm exec vitest run <file.test.ts>` for each changed source file
- **Required:** when `.ts`/`.tsx` files changed
- **Scope:** colocated `*.test.ts` files for every modified source file

### Gate 4: Coverage Diff

- **Command:** copilot `coverage-diff` stage
- **Required:** when `--no-coverage` is not set
- **Scope:** coverage must not decrease for changed files

### Gate 5: Screenshot Diff

- **Command:** copilot `screenshot-diff` stage
- **Required:** when UI files changed and `--no-screenshot-diff` is not set
- **Scope:** visual regression check against baseline

### Gate 6: Review Agent

- **Command:** copilot `review-agent` stage
- **Required:** when `--no-review` is not set
- **Scope:** automated code review of diff

### Gate 7: Spec Tests

- **Command:** copilot `spec-tests` stage
- **Required:** for new features when `--no-spec-tests` is not set
- **Scope:** TDD-style spec verification

### Gate 8: UX Evaluation

- **Command:** copilot `ux-eval` stage
- **Required:** for user-facing changes when `--no-ux-eval` is not set
- **Scope:** browser-based interaction testing

## Enforcement

| Context                   | Gates enforced    | Mechanism                                    |
| ------------------------- | ----------------- | -------------------------------------------- |
| Every Claude Code session | 1, 2, 3           | `verify-before-stop.sh` (stop hook)          |
| `/work` pipeline (fast)   | 1, 2, 3           | `verify-autonomous.sh fast`                  |
| `/work` pipeline (full)   | 1-8               | `verify-autonomous.sh full` + copilot stages |
| PR merge                  | 1, 2, 3 (minimum) | Manual or CI                                 |

## Rules

1. **No skipping gates without flag.** Each optional gate has an explicit `--no-*` flag. Disabling a gate must be intentional.
2. **Failures block completion.** The stop hook prevents the agent from finishing until gates 1-3 pass.
3. **Fix forward, not around.** When a gate fails, fix the code. Do not disable the gate or add `@ts-ignore`/`any` to pass.
4. **Tests are memory.** Every bug fix must include a regression test. Tests encode correctness permanently.
5. **Small tasks, tight loops.** Prefer scoped tasks with fast verification. The faster the loop, the less drift.

## Exit Criteria (when is "done" done?)

A task is complete when:

- [ ] All required gates pass
- [ ] Changed files have colocated tests
- [ ] No new `any`, `@ts-ignore`, `console.log`, or `debugger` in committed code
- [ ] Commit message describes the change accurately
- [ ] Memory updated if a reusable lesson was learned
