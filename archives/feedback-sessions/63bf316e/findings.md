# Findings

## Requirements

- pnpm tsc --noEmit passes with zero errors
- pnpm build completes successfully
- NO files named \*Demo.tsx exist for this feature
- NO routes containing /demo/ are added to index.tsx
- Component is imported and used in an EXISTING page (LessonPage, QuestionDisplay, etc.)
- All imports use @/\* alias (not relative paths like ../../../)
- Uses Shadcn Button/Card components from @/components/ui/ (not custom HTML)
- Props interface is exported alongside component
- Component has at least one test file that passes
- tldraw dependency is in package.json dependencies (not devDependencies)

## Research

No research recorded yet.

## Discoveries

No discoveries yet.

---

_Last updated: 2026-02-04T00:36:23.444Z_
