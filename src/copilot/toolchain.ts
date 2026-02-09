/**
 * Project toolchain detection and presets.
 *
 * Auto-detects the build/test/lint toolchain from workspace files
 * so the copilot pipeline works with any project type.
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolchainCommand = {
  command: string;
  args: string[];
  /** Append matching files to args (lint stage only) */
  fileArgs?: boolean;
};

export type TestDiscovery = {
  /** Suffix appended to source path for colocated tests (e.g. ".test.ts") */
  colocatedSuffix?: string;
  /** Directory containing tests (e.g. "tests", "__tests__") */
  testDir?: string;
  /** Prefix for test files in testDir (e.g. "test_") */
  testPrefix?: string;
  /** Extensions considered test files */
  testExtensions: string[];
  /** Patterns for files that should NOT require tests */
  skipPatterns: RegExp[];
};

export type PromptHints = {
  testFramework: string;
  testPlacement: string;
  runTests: string;
  runLint: string;
  codeStyle: string;
};

export type ProjectToolchain = {
  /** Human-readable label: "TypeScript (pnpm + vitest)" */
  name: string;
  /** Source file extensions (e.g. [".ts", ".tsx"]) */
  sourceExtensions: string[];
  /** Lint command — undefined means skip */
  lint?: ToolchainCommand;
  /** Type check command — undefined means skip */
  typecheck?: ToolchainCommand;
  /** Test runner command — test files appended at end */
  test?: ToolchainCommand;
  /** Build command — undefined means skip */
  build?: ToolchainCommand;
  /** Coverage command — undefined means skip */
  coverage?: ToolchainCommand;
  /** How to discover test files for changed source files */
  testDiscovery: TestDiscovery;
  /** Fragments injected into the agent system prompt */
  promptHints: PromptHints;
};

// ---------------------------------------------------------------------------
// Skip patterns shared across presets
// ---------------------------------------------------------------------------

const tsSkipPatterns: RegExp[] = [
  /\.d\.ts$/,
  /[-/]types?\.(ts|tsx)$/,
  /\.config\.(ts|tsx|js|mjs)$/,
  /\.(json|md|css|scss|svg)$/,
];

const pySkipPatterns: RegExp[] = [
  /\/__init__\.py$/,
  /\/conftest\.py$/,
  /\/setup\.py$/,
  /\.(json|md|toml|cfg|ini|txt)$/,
];

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export const presets: Record<string, ProjectToolchain> = {
  "typescript-pnpm": {
    name: "TypeScript (pnpm + vitest)",
    sourceExtensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts"],
    lint: { command: "pnpm", args: ["exec", "oxlint"], fileArgs: true },
    typecheck: { command: "pnpm", args: ["tsgo"] },
    test: { command: "pnpm", args: ["exec", "vitest", "run"] },
    build: { command: "pnpm", args: ["build"] },
    coverage: {
      command: "pnpm",
      args: [
        "exec",
        "vitest",
        "run",
        "--coverage",
        "--coverage.provider=v8",
        "--coverage.reporter=lcov",
      ],
    },
    testDiscovery: {
      colocatedSuffix: ".test.ts",
      testExtensions: [".test.ts", ".test.tsx"],
      skipPatterns: tsSkipPatterns,
    },
    promptHints: {
      testFramework: "vitest (describe, it, expect)",
      testPlacement: "colocated *.test.ts files next to source",
      runTests: "pnpm test",
      runLint: "pnpm check (lint + format)",
      codeStyle: "clean, typed TypeScript (no `any`)",
    },
  },

  "typescript-npm": {
    name: "TypeScript (npm + jest)",
    sourceExtensions: [".ts", ".tsx", ".js", ".jsx"],
    lint: { command: "npx", args: ["eslint"], fileArgs: true },
    typecheck: { command: "npx", args: ["tsc", "--noEmit"] },
    test: { command: "npx", args: ["jest", "--passWithNoTests"] },
    build: { command: "npm", args: ["run", "build"] },
    coverage: { command: "npx", args: ["jest", "--coverage", "--passWithNoTests"] },
    testDiscovery: {
      colocatedSuffix: ".test.ts",
      testDir: "__tests__",
      testExtensions: [".test.ts", ".test.tsx", ".test.js", ".test.jsx"],
      skipPatterns: tsSkipPatterns,
    },
    promptHints: {
      testFramework: "jest (describe, it, expect)",
      testPlacement: "colocated *.test.ts files or __tests__/ directory",
      runTests: "npm test",
      runLint: "npm run lint",
      codeStyle: "clean, typed TypeScript (no `any`)",
    },
  },

  "typescript-bun": {
    name: "TypeScript (bun)",
    sourceExtensions: [".ts", ".tsx", ".js", ".jsx"],
    lint: { command: "bunx", args: ["oxlint"], fileArgs: true },
    typecheck: { command: "bun", args: ["run", "tsc", "--noEmit"] },
    test: { command: "bun", args: ["test"] },
    build: { command: "bun", args: ["run", "build"] },
    testDiscovery: {
      colocatedSuffix: ".test.ts",
      testExtensions: [".test.ts", ".test.tsx"],
      skipPatterns: tsSkipPatterns,
    },
    promptHints: {
      testFramework: "bun:test (describe, it, expect)",
      testPlacement: "colocated *.test.ts files next to source",
      runTests: "bun test",
      runLint: "bunx oxlint",
      codeStyle: "clean, typed TypeScript (no `any`)",
    },
  },

  python: {
    name: "Python (pytest)",
    sourceExtensions: [".py"],
    lint: { command: "ruff", args: ["check"], fileArgs: true },
    typecheck: { command: "mypy", args: ["."] },
    test: { command: "pytest", args: ["-x", "--tb=short"] },
    build: undefined,
    coverage: { command: "pytest", args: ["--cov", "--cov-report=lcov"] },
    testDiscovery: {
      testDir: "tests",
      testPrefix: "test_",
      testExtensions: [".py"],
      skipPatterns: pySkipPatterns,
    },
    promptHints: {
      testFramework: "pytest (def test_*, assert)",
      testPlacement: "tests/ directory with test_*.py files, or colocated test_*.py",
      runTests: "pytest",
      runLint: "ruff check",
      codeStyle: "clean Python with type hints",
    },
  },

  rust: {
    name: "Rust (cargo)",
    sourceExtensions: [".rs"],
    lint: { command: "cargo", args: ["clippy", "--", "-D", "warnings"] },
    typecheck: { command: "cargo", args: ["check"] },
    test: { command: "cargo", args: ["test"] },
    build: { command: "cargo", args: ["build"] },
    testDiscovery: {
      testExtensions: [".rs"],
      skipPatterns: [/\/build\.rs$/],
    },
    promptHints: {
      testFramework: "built-in #[test] and assert! macros",
      testPlacement: "inline #[cfg(test)] mod tests in the same file, or tests/ directory",
      runTests: "cargo test",
      runLint: "cargo clippy",
      codeStyle: "idiomatic Rust — handle errors with Result, avoid unwrap() in production code",
    },
  },

  go: {
    name: "Go",
    sourceExtensions: [".go"],
    lint: { command: "golangci-lint", args: ["run"] },
    typecheck: { command: "go", args: ["vet", "./..."] },
    test: { command: "go", args: ["test", "./..."] },
    build: { command: "go", args: ["build", "./..."] },
    coverage: { command: "go", args: ["test", "-coverprofile=coverage.out", "./..."] },
    testDiscovery: {
      colocatedSuffix: "_test.go",
      testExtensions: ["_test.go"],
      skipPatterns: [/\/vendor\//, /\.pb\.go$/],
    },
    promptHints: {
      testFramework: "testing package (func TestXxx(t *testing.T), t.Run for subtests)",
      testPlacement: "colocated *_test.go files in the same package",
      runTests: "go test ./...",
      runLint: "golangci-lint run",
      codeStyle: "idiomatic Go — check errors, keep functions short",
    },
  },

  generic: {
    name: "Generic project",
    sourceExtensions: [],
    testDiscovery: {
      testExtensions: [],
      skipPatterns: [],
    },
    promptHints: {
      testFramework: "the project's configured test framework",
      testPlacement: "follow existing test patterns in the codebase",
      runTests: "the project's test command",
      runLint: "the project's lint command",
      codeStyle: "follow existing code patterns and conventions",
    },
  },
};

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function fileExists(cwd: string, name: string): boolean {
  try {
    fs.accessSync(path.join(cwd, name));
    return true;
  } catch {
    return false;
  }
}

function readJson(cwd: string, name: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, name), "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hasDep(pkg: Record<string, unknown>, dep: string): boolean {
  const deps = pkg.dependencies as Record<string, string> | undefined;
  const devDeps = pkg.devDependencies as Record<string, string> | undefined;
  return !!(deps?.[dep] || devDeps?.[dep]);
}

/**
 * Detect the project toolchain from workspace files.
 * Returns a preset that matches the project, or the generic fallback.
 */
export function detectToolchain(cwd: string): ProjectToolchain {
  // 1. Explicit override via .moltbot.json
  const overrideCfg = readJson(cwd, ".moltbot.json");
  if (overrideCfg?.toolchain && typeof overrideCfg.toolchain === "string") {
    const preset = presets[overrideCfg.toolchain];
    if (preset) {
      return preset;
    }
  }

  // 2. Rust
  if (fileExists(cwd, "Cargo.toml")) {
    return presets.rust;
  }

  // 3. Go
  if (fileExists(cwd, "go.mod")) {
    return presets.go;
  }

  // 4. Python
  if (
    fileExists(cwd, "pyproject.toml") ||
    fileExists(cwd, "requirements.txt") ||
    fileExists(cwd, "setup.py") ||
    fileExists(cwd, "Pipfile")
  ) {
    return presets.python;
  }

  // 5. JavaScript/TypeScript — inspect package.json for toolchain
  const pkg = readJson(cwd, "package.json");
  if (pkg) {
    // Detect package manager
    const hasPnpm = fileExists(cwd, "pnpm-lock.yaml");
    const hasBun = fileExists(cwd, "bun.lockb") || fileExists(cwd, "bun.lock");

    // Detect test framework
    const hasVitest = hasDep(pkg, "vitest");
    const hasJest = hasDep(pkg, "jest");

    // pnpm + vitest (this repo's setup)
    if (hasPnpm && hasVitest) {
      const hasTsgo = hasDep(pkg, "@anthropic-ai/tsgo") || hasDep(pkg, "tsgo");
      if (!hasTsgo) {
        // Fall back to tsc if tsgo not installed in this project
        return {
          ...presets["typescript-pnpm"],
          typecheck: hasDep(pkg, "typescript")
            ? { command: "pnpm", args: ["exec", "tsc", "--noEmit"] }
            : undefined,
        };
      }
      return presets["typescript-pnpm"];
    }

    // bun
    if (hasBun) {
      return presets["typescript-bun"];
    }

    // npm/yarn + jest
    if (hasJest) {
      return presets["typescript-npm"];
    }

    // npm/yarn + vitest
    if (hasVitest) {
      // Use pnpm preset shape but with npm commands
      return {
        ...presets["typescript-pnpm"],
        name: "TypeScript (npm + vitest)",
        lint: { command: "npx", args: ["oxlint"], fileArgs: true },
        typecheck: { command: "npx", args: ["tsc", "--noEmit"] },
        test: { command: "npx", args: ["vitest", "run"] },
        build: { command: "npm", args: ["run", "build"] },
        coverage: {
          command: "npx",
          args: [
            "vitest",
            "run",
            "--coverage",
            "--coverage.provider=v8",
            "--coverage.reporter=lcov",
          ],
        },
        promptHints: {
          ...presets["typescript-pnpm"].promptHints,
          runTests: "npm test",
          runLint: "npx oxlint",
        },
      };
    }

    // Generic JS project — try npm scripts
    const scripts = pkg.scripts as Record<string, string> | undefined;
    return {
      ...presets.generic,
      name: "JavaScript/TypeScript (npm)",
      sourceExtensions: [".ts", ".tsx", ".js", ".jsx", ".mjs"],
      lint: scripts?.lint ? { command: "npm", args: ["run", "lint"] } : undefined,
      typecheck: fileExists(cwd, "tsconfig.json")
        ? { command: "npx", args: ["tsc", "--noEmit"] }
        : undefined,
      test: scripts?.test ? { command: "npm", args: ["test"] } : undefined,
      build: scripts?.build ? { command: "npm", args: ["run", "build"] } : undefined,
      testDiscovery: {
        colocatedSuffix: ".test.ts",
        testExtensions: [".test.ts", ".test.tsx", ".test.js", ".test.jsx", ".spec.ts", ".spec.js"],
        skipPatterns: tsSkipPatterns,
      },
      promptHints: {
        testFramework: "the project's configured test framework",
        testPlacement: "follow existing test patterns in the codebase",
        runTests: scripts?.test ? "npm test" : "the project's test command",
        runLint: scripts?.lint ? "npm run lint" : "the project's lint command",
        codeStyle: fileExists(cwd, "tsconfig.json")
          ? "clean, typed TypeScript"
          : "clean JavaScript",
      },
    };
  }

  // 6. Fallback
  return presets.generic;
}
