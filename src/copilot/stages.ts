/**
 * Individual verification stage runners for the copilot pipeline.
 *
 * Each stage spawns child processes and captures output.
 * Stages are designed to be composable and cancellable via AbortSignal.
 */

import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ProjectToolchain, TestDiscovery } from "./toolchain.js";
import type { StageResult } from "./types.js";
import { truncateError } from "./feedback.js";
import { presets } from "./toolchain.js";

export type StageContext = {
  /** Files that triggered this run (relative paths) */
  changedFiles: string[];
  /** Working directory */
  cwd: string;
  /** Signal to cancel the stage */
  signal: AbortSignal;
};

/** Run a shell command and capture output. Returns exit code and combined output. */
export async function runCommand(
  command: string,
  args: string[],
  opts: { cwd: string; signal: AbortSignal; timeoutMs: number },
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    if (opts.signal.aborted) {
      reject(new Error("Aborted"));
      return;
    }

    const child = spawn(command, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });

    let output = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
    }, opts.timeoutMs);

    const onAbort = () => {
      child.kill("SIGTERM");
    };
    opts.signal.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      opts.signal.removeEventListener("abort", onAbort);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      opts.signal.removeEventListener("abort", onAbort);
      resolve({ code: code ?? 1, output });
    });
  });
}

/** Stage 1: Lint changed files */
export async function runLintStage(
  ctx: StageContext,
  toolchain?: ProjectToolchain,
): Promise<StageResult> {
  const start = Date.now();
  const tc = toolchain ?? presets["typescript-pnpm"];

  // No lint command configured → auto-pass
  if (!tc.lint) {
    return { stage: "lint", passed: true, durationMs: Date.now() - start, files: [] };
  }

  // Filter files by source extensions
  const extSet = new Set(tc.sourceExtensions);
  const sourceFiles =
    extSet.size > 0
      ? ctx.changedFiles.filter((f) => extSet.has(path.extname(f)))
      : ctx.changedFiles;

  if (sourceFiles.length === 0) {
    return { stage: "lint", passed: true, durationMs: Date.now() - start, files: [] };
  }

  const args = tc.lint.fileArgs ? [...tc.lint.args, ...sourceFiles] : tc.lint.args;

  try {
    const { code, output } = await runCommand(tc.lint.command, args, {
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeoutMs: 30_000,
    });

    return {
      stage: "lint",
      passed: code === 0,
      durationMs: Date.now() - start,
      error: code !== 0 ? truncateError(output) : undefined,
      files: sourceFiles,
    };
  } catch (err) {
    if (ctx.signal.aborted) {
      return { stage: "lint", passed: false, durationMs: Date.now() - start, error: "Cancelled" };
    }
    return {
      stage: "lint",
      passed: false,
      durationMs: Date.now() - start,
      error: truncateError(String(err)),
    };
  }
}

/** Stage 2: Type checking */
export async function runTypecheckStage(
  ctx: StageContext,
  toolchain?: ProjectToolchain,
): Promise<StageResult> {
  const start = Date.now();
  const tc = toolchain ?? presets["typescript-pnpm"];

  // No typecheck command configured → auto-pass
  if (!tc.typecheck) {
    return { stage: "typecheck", passed: true, durationMs: Date.now() - start };
  }

  try {
    const { code, output } = await runCommand(tc.typecheck.command, tc.typecheck.args, {
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeoutMs: 60_000,
    });

    return {
      stage: "typecheck",
      passed: code === 0,
      durationMs: Date.now() - start,
      error: code !== 0 ? truncateError(output) : undefined,
    };
  } catch (err) {
    if (ctx.signal.aborted) {
      return {
        stage: "typecheck",
        passed: false,
        durationMs: Date.now() - start,
        error: "Cancelled",
      };
    }
    return {
      stage: "typecheck",
      passed: false,
      durationMs: Date.now() - start,
      error: truncateError(String(err)),
    };
  }
}

/**
 * Check if a file is a pure re-export barrel (every non-empty, non-comment line
 * is `export * from` or `export {`). Falls back to filename heuristic when the
 * file cannot be read.
 */
export function isBarrelOnly(filePath: string, cwd: string): boolean {
  try {
    const fullPath = path.join(cwd, filePath);
    const content = fs.readFileSync(fullPath, "utf-8");
    const lines = content.split("\n");
    let hasExports = false;

    for (const raw of lines) {
      const line = raw.trim();
      // Skip blanks and single-line comments
      if (line === "" || line.startsWith("//") || line.startsWith("/*") || line.startsWith("*")) {
        continue;
      }
      // Re-export patterns
      if (/^export\s+\*\s+from\s/.test(line) || /^export\s*\{/.test(line)) {
        hasExports = true;
        continue;
      }
      // Any other real code → not a barrel
      return false;
    }

    return hasExports;
  } catch {
    // File unreadable — fall back to filename heuristic
    return /\/index\.tsx?$/.test(filePath) || filePath === "index.ts" || filePath === "index.tsx";
  }
}

/**
 * Check whether a file's changes are whitespace-only by running `git diff -w`.
 * Returns true when the only differences are whitespace (the diff ignoring
 * whitespace is empty).
 */
export function isWhitespaceOnlyChange(file: string, cwd: string): boolean {
  try {
    const output = execSync(`git diff -w HEAD -- "${file}"`, {
      cwd,
      encoding: "utf-8",
      timeout: 5_000,
    });
    return output.trim() === "";
  } catch {
    // If git fails, assume the change is substantive
    return false;
  }
}

/** Convert a source file path to its expected colocated test path. */
export function expectedTestPath(file: string, discovery?: TestDiscovery): string {
  if (discovery?.colocatedSuffix) {
    const ext = path.extname(file);
    return file.slice(0, -ext.length) + discovery.colocatedSuffix;
  }
  // Default TS convention
  return file.replace(/\.(ts|tsx)$/, ".test.$1");
}

/** Check if a source file should have colocated tests */
export function needsTests(file: string, cwd?: string, toolchain?: ProjectToolchain): boolean {
  const tc = toolchain ?? presets["typescript-pnpm"];
  const ext = path.extname(file);

  // Not a source file for this toolchain
  if (tc.sourceExtensions.length > 0 && !tc.sourceExtensions.includes(ext)) {
    return false;
  }

  // Check toolchain skip patterns
  for (const pat of tc.testDiscovery.skipPatterns) {
    if (pat.test(file)) {
      return false;
    }
  }

  // Already a test file
  for (const testExt of tc.testDiscovery.testExtensions) {
    if (file.endsWith(testExt)) {
      return false;
    }
  }
  // Also check common test patterns
  if (/\.(test|e2e\.test|spec)\.[^.]+$/.test(file)) {
    return false;
  }

  // TS-specific: type declarations, type-only files, barrels
  if (ext === ".ts" || ext === ".tsx") {
    if (file.endsWith(".d.ts")) {
      return false;
    }
    if (/[-/]types?\.(ts|tsx)$/.test(file)) {
      return false;
    }
    if (cwd && isBarrelOnly(file, cwd)) {
      return false;
    }
    if (!cwd && (/\/index\.tsx?$/.test(file) || file === "index.ts" || file === "index.tsx")) {
      return false;
    }
  }

  // Config files
  if (/\.config\.[^.]+$/.test(file)) {
    return false;
  }

  // Non-code files
  if (/\.(json|md|css|scss|svg|toml|cfg|ini|txt|yaml|yml)$/.test(file)) {
    return false;
  }

  return true;
}

/** Stage 3: Run tests for changed files (smart discovery) */
export async function runTestStage(
  ctx: StageContext,
  toolchain?: ProjectToolchain,
): Promise<StageResult> {
  const start = Date.now();
  const tc = toolchain ?? presets["typescript-pnpm"];

  // No test command configured → auto-pass
  if (!tc.test) {
    return { stage: "test", passed: true, durationMs: Date.now() - start, files: [] };
  }

  const testFiles = discoverTestFiles(ctx.changedFiles, ctx.cwd, tc.testDiscovery);

  if (testFiles.length === 0) {
    // Filter out whitespace-only changes before enforcing test coverage
    const substantiveFiles = ctx.changedFiles.filter((f) => !isWhitespaceOnlyChange(f, ctx.cwd));

    // Check if there are source files that SHOULD have tests
    const sourceFilesNeedingTests = substantiveFiles.filter((f) => needsTests(f, ctx.cwd, tc));
    if (sourceFilesNeedingTests.length > 0) {
      const listing = sourceFilesNeedingTests
        .map((f) => `  ${f} → expected: ${expectedTestPath(f, tc.testDiscovery)}`)
        .join("\n");
      return {
        stage: "test",
        passed: false,
        durationMs: Date.now() - start,
        error: `No tests found for changed source files:\n${listing}\n\nWrite tests following the project's conventions.`,
        files: [],
      };
    }
    return { stage: "test", passed: true, durationMs: Date.now() - start, files: [] };
  }

  const args = [...tc.test.args, ...testFiles];

  try {
    const { code, output } = await runCommand(tc.test.command, args, {
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeoutMs: 120_000,
    });

    return {
      stage: "test",
      passed: code === 0,
      durationMs: Date.now() - start,
      error: code !== 0 ? truncateError(output) : undefined,
      files: testFiles,
    };
  } catch (err) {
    if (ctx.signal.aborted) {
      return { stage: "test", passed: false, durationMs: Date.now() - start, error: "Cancelled" };
    }
    return {
      stage: "test",
      passed: false,
      durationMs: Date.now() - start,
      error: truncateError(String(err)),
    };
  }
}

/** Stage 4: Build */
export async function runBuildStage(
  ctx: StageContext,
  toolchain?: ProjectToolchain,
): Promise<StageResult> {
  const start = Date.now();
  const tc = toolchain ?? presets["typescript-pnpm"];

  // No build command configured → auto-pass
  if (!tc.build) {
    return { stage: "build", passed: true, durationMs: Date.now() - start };
  }

  try {
    const { code, output } = await runCommand(tc.build.command, tc.build.args, {
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeoutMs: 180_000,
    });

    return {
      stage: "build",
      passed: code === 0,
      durationMs: Date.now() - start,
      error: code !== 0 ? truncateError(output) : undefined,
    };
  } catch (err) {
    if (ctx.signal.aborted) {
      return { stage: "build", passed: false, durationMs: Date.now() - start, error: "Cancelled" };
    }
    return {
      stage: "build",
      passed: false,
      durationMs: Date.now() - start,
      error: truncateError(String(err)),
    };
  }
}

/**
 * Discover test files for changed source files.
 * Supports colocated tests (TS, Go) and directory-based tests (Python).
 */
export function discoverTestFiles(
  changedFiles: string[],
  cwd: string,
  discovery?: TestDiscovery,
): string[] {
  const testFiles = new Set<string>();
  const testExtSet = new Set(discovery?.testExtensions ?? [".test.ts", ".test.tsx"]);

  // Helper: is this file already a test file?
  const isTestFile = (file: string): boolean => {
    for (const ext of testExtSet) {
      if (file.endsWith(ext)) {
        return true;
      }
    }
    return false;
  };

  for (const file of changedFiles) {
    if (isTestFile(file)) {
      continue;
    }

    // Colocated discovery (e.g. foo.ts → foo.test.ts, foo.go → foo_test.go)
    if (discovery?.colocatedSuffix) {
      const ext = path.extname(file);
      const base = file.slice(0, -ext.length);
      const candidate = base + discovery.colocatedSuffix;
      if (fs.existsSync(path.join(cwd, candidate))) {
        testFiles.add(candidate);
      }
    } else {
      // Default TS convention
      const base = file.replace(/\.tsx?$/, "");
      if (base !== file) {
        for (const candidate of [`${base}.test.ts`, `${base}.test.tsx`]) {
          if (fs.existsSync(path.join(cwd, candidate))) {
            testFiles.add(candidate);
          }
        }
      }
    }

    // Directory-based discovery (e.g. src/foo.py → tests/test_foo.py)
    if (discovery?.testDir) {
      const basename = path.basename(file, path.extname(file));
      const prefix = discovery.testPrefix ?? "test_";
      const testCandidate = path.join(
        discovery.testDir,
        `${prefix}${basename}${path.extname(file)}`,
      );
      if (fs.existsSync(path.join(cwd, testCandidate))) {
        testFiles.add(testCandidate);
      }
    }
  }

  // Also include test files that were directly changed
  for (const file of changedFiles) {
    if (isTestFile(file) && !/\.e2e\.test\.[^.]+$/.test(file)) {
      if (fs.existsSync(path.join(cwd, file))) {
        testFiles.add(file);
      }
    }
  }

  return Array.from(testFiles);
}
