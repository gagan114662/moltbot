---
name: integrate-component
description: Integrate a React component into production app flow (NOT demo pages)
metadata:
  {
    "openclaw": { "emoji": "🔌", "requires": { "anyBins": ["pnpm", "npm"] } },
  }
---

# Integrate Component

Properly integrate a React component into a production application - **NOT demo pages**.

## Usage

```
/integrate-component <component-name> in <project-path>
```

Example:
```
/integrate-component ScratchpadTeacher in /Users/gaganarora/clawd/aitutor-homework
```

## What This Skill Does

1. **Finds the component** in the project
2. **Identifies integration points** - existing pages where the component belongs
3. **Adds the component** to real production routes (NOT /demo/*)
4. **Updates imports and exports**
5. **Runs build** to verify no errors
6. **Runs tests** if they exist

## Rules

### NEVER DO:
- Create `/demo/*` routes
- Create standalone demo pages
- Add new routes just for testing a component
- Create `*Demo.tsx` files

### ALWAYS DO:
- Find existing pages where the component fits
- Add component to real user flows
- Use existing UI library (Shadcn, MUI, etc.)
- Respect existing patterns in the codebase
- Run `pnpm build` or `npm run build` to verify

## Integration Checklist

Before saying "done", verify:

- [ ] Component is imported in at least one production page
- [ ] Component is visible in real user flow (not /demo)
- [ ] `pnpm tsc --noEmit` passes
- [ ] `pnpm build` passes
- [ ] Component uses existing design system components
- [ ] Props are properly typed

## Example: ScratchpadTeacher in aitutor-homework

**BAD** (what NOT to do):
```tsx
// src/index.tsx - WRONG
<Route path="/app/demo/scratchpad-teacher" component={ScratchpadTeacherDemo} />
```

**GOOD** (proper integration):
```tsx
// src/components/QuestionDisplay.tsx - RIGHT
import { ScratchpadTeacher } from '@/components/scratchpad';

export function QuestionDisplay({ question, showSolution }) {
  return (
    <div>
      {/* Existing question content */}
      <QuestionContent question={question} />

      {/* ScratchpadTeacher integrated into real flow */}
      {showSolution && (
        <ScratchpadTeacher
          strokes={question.solutionStrokes}
          title="Step-by-step solution"
          autoPlay={true}
        />
      )}
    </div>
  );
}
```

## Finding Integration Points

Ask these questions:
1. What user action triggers this component?
2. What existing page handles that action?
3. What state/context does the component need?
4. Which existing components should contain it?

For ScratchpadTeacher:
- Triggered by: User wants to see step-by-step solution
- Existing page: LessonPage, QuestionDisplay
- State needed: Solution strokes data
- Container: QuestionDisplay or a new "ShowSolution" section in LessonPage

## Verification Commands

```bash
# TypeScript check
cd frontend && pnpm tsc --noEmit

# Full build (catches everything)
cd frontend && pnpm build

# Run tests
cd frontend && pnpm test --run

# Dev server to visually verify
cd frontend && pnpm dev
# Then navigate to the REAL page where component is integrated
```
