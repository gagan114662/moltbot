#!/usr/bin/env bun
// One-time migration: add version timestamps to LEARNED.md rules.
//
// Before: - Verify full file paths before editing
// After:  - [2026-02-09] Verify full file paths before editing (source: manual, migrated)
//
// Usage:
//   npx tsx scripts/migrate-learned.ts              # apply migration
//   npx tsx scripts/migrate-learned.ts --dry-run    # preview only

import fs from "node:fs";
import path from "node:path";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const LEARNED_PATH = path.join(PROJECT_ROOT, "memory", "LEARNED.md");
const TODAY = new Date().toISOString().slice(0, 10);
const DRY_RUN = process.argv.includes("--dry-run");

// Already-versioned line: starts with "- [YYYY-MM-DD]"
const VERSIONED_RE = /^- \[\d{4}-\d{2}-\d{2}\]/;

function migrateLine(line: string): string {
  const trimmed = line.trimStart();

  // Skip non-rule lines (headings, blank lines, comments)
  if (!trimmed.startsWith("- ")) {
    return line;
  }

  // Skip already-versioned lines
  if (VERSIONED_RE.test(trimmed)) {
    return line;
  }

  // Extract leading whitespace to preserve indentation
  const indent = line.slice(0, line.length - trimmed.length);
  const ruleText = trimmed.slice(2); // remove "- " prefix

  return `${indent}- [${TODAY}] ${ruleText} (source: manual, migrated)`;
}

function main(): void {
  if (!fs.existsSync(LEARNED_PATH)) {
    console.error(`File not found: ${LEARNED_PATH}`);
    process.exit(1);
  }

  const content = fs.readFileSync(LEARNED_PATH, "utf-8");
  const lines = content.split("\n");
  const migrated = lines.map(migrateLine);
  const result = migrated.join("\n");

  if (DRY_RUN) {
    console.log("=== DRY RUN (no changes written) ===\n");
    console.log(result);
    return;
  }

  if (result === content) {
    console.log("No changes needed — all rules already versioned.");
    return;
  }

  fs.writeFileSync(LEARNED_PATH, result, "utf-8");
  const ruleCount = lines.filter(
    (l) => l.trimStart().startsWith("- ") && !VERSIONED_RE.test(l.trimStart()),
  ).length;
  console.log(`Migrated ${ruleCount} rules. Backup: use git to revert if needed.`);
}

main();
