import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  findColocatedTests,
  gateChangedFileTests,
  gateCompileCheck,
  gateDevServerHealth,
  gateScoreRegression,
  runValidationPipeline,
} from "./validation-gates.js";

// ---------------------------------------------------------------------------
// Mock child_process and fs
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  default: {
    existsSync: vi.fn(),
  },
}));

import { execSync } from "node:child_process";
import fs from "node:fs";

const mockExecSync = vi.mocked(execSync);
const mockExistsSync = vi.mocked(fs.existsSync);

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// gateCompileCheck
// ---------------------------------------------------------------------------

describe("gateCompileCheck", () => {
  it("passes when tsc succeeds", () => {
    mockExecSync.mockReturnValue("");
    const result = gateCompileCheck("/tmp/project");
    expect(result.passed).toBe(true);
  });

  it("fails with errors when tsc throws", () => {
    const err = new Error("tsc failed") as Error & { stdout: string; stderr: string };
    err.stdout =
      "src/App.tsx(10,5): error TS2322: Type 'string' is not assignable to type 'number'.";
    err.stderr = "";
    mockExecSync.mockImplementation(() => {
      throw err;
    });

    const result = gateCompileCheck("/tmp/project");
    expect(result.passed).toBe(false);
    expect(result.reason).toBe("TypeScript compilation failed");
    expect(result.errors).toHaveLength(1);
    expect(result.errors![0]).toContain("TS2322");
  });
});

// ---------------------------------------------------------------------------
// gateDevServerHealth
// ---------------------------------------------------------------------------

describe("gateDevServerHealth", () => {
  it("passes when server returns clean HTML", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        text: () => Promise.resolve("<html><body>App</body></html>"),
      }),
    );
    const result = await gateDevServerHealth("http://localhost:3000");
    expect(result.passed).toBe(true);
    vi.unstubAllGlobals();
  });

  it("fails when Vite error overlay is present", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        text: () =>
          Promise.resolve(
            "<html><body><vite-error-overlay>Error</vite-error-overlay></body></html>",
          ),
      }),
    );
    const result = await gateDevServerHealth("http://localhost:3000");
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("Vite error overlay");
    vi.unstubAllGlobals();
  });

  it("fails when server is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const result = await gateDevServerHealth("http://localhost:3000");
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("unreachable");
    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// findColocatedTests
// ---------------------------------------------------------------------------

describe("findColocatedTests", () => {
  it("finds colocated test files", () => {
    mockExistsSync.mockImplementation((p) => {
      const s = String(p);
      // Only match the direct colocated file, not __tests__/ variant
      return s.endsWith("hooks/useScratchpadAI.test.ts");
    });

    const tests = findColocatedTests("/tmp/project", ["src/hooks/useScratchpadAI.ts"]);
    expect(tests).toHaveLength(1);
    expect(tests[0]).toContain("useScratchpadAI.test.ts");
  });

  it("returns empty when no tests exist", () => {
    mockExistsSync.mockReturnValue(false);
    const tests = findColocatedTests("/tmp/project", ["src/hooks/useScratchpadAI.ts"]);
    expect(tests).toHaveLength(0);
  });

  it("skips non-ts files", () => {
    mockExistsSync.mockReturnValue(true);
    const tests = findColocatedTests("/tmp/project", ["package.json", "README.md"]);
    expect(tests).toHaveLength(0);
  });

  it("skips files that are already test files", () => {
    mockExistsSync.mockReturnValue(true);
    const tests = findColocatedTests("/tmp/project", ["src/hooks/useScratchpadAI.test.ts"]);
    expect(tests).toHaveLength(0);
  });

  it("deduplicates test files", () => {
    mockExistsSync.mockImplementation((p) => {
      const s = String(p);
      // Only match the direct colocated file, not __tests__/ variant
      return s.endsWith("src/App.test.tsx") && !s.includes("__tests__");
    });

    const tests = findColocatedTests("/tmp/project", [
      "src/App.tsx",
      "src/App.tsx", // duplicate
    ]);
    expect(tests).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// gateChangedFileTests
// ---------------------------------------------------------------------------

describe("gateChangedFileTests", () => {
  it("passes when no test files exist for changed files", () => {
    mockExistsSync.mockReturnValue(false);
    const result = gateChangedFileTests("/tmp/project", ["src/App.tsx"]);
    expect(result.passed).toBe(true);
    expect(result.reason).toContain("No colocated test files");
  });

  it("passes when vitest succeeds", () => {
    mockExistsSync.mockImplementation((p) => String(p).endsWith("App.test.tsx"));
    mockExecSync.mockReturnValue("Tests passed");

    const result = gateChangedFileTests("/tmp/project", ["src/App.tsx"]);
    expect(result.passed).toBe(true);
  });

  it("fails when vitest fails", () => {
    mockExistsSync.mockImplementation((p) => String(p).endsWith("App.test.tsx"));
    const err = new Error("vitest failed") as Error & { stdout: string; stderr: string };
    err.stdout = "FAIL src/App.test.tsx\n  Expected: true\n  Received: false";
    err.stderr = "";
    mockExecSync.mockImplementation((cmd) => {
      if (String(cmd).includes("vitest")) {
        throw err;
      }
      return "";
    });

    const result = gateChangedFileTests("/tmp/project", ["src/App.tsx"]);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("Unit tests failed");
  });
});

// ---------------------------------------------------------------------------
// gateScoreRegression
// ---------------------------------------------------------------------------

describe("gateScoreRegression", () => {
  it("passes when no scores available", () => {
    expect(gateScoreRegression(null, null).passed).toBe(true);
    expect(gateScoreRegression(5, null).passed).toBe(true);
    expect(gateScoreRegression(null, 5).passed).toBe(true);
  });

  it("passes when score improves", () => {
    expect(gateScoreRegression(6, 5).passed).toBe(true);
  });

  it("passes when score stays the same", () => {
    expect(gateScoreRegression(5, 5).passed).toBe(true);
  });

  it("passes for small drops within threshold", () => {
    expect(gateScoreRegression(4.6, 5).passed).toBe(true);
  });

  it("fails when score drops beyond threshold", () => {
    const result = gateScoreRegression(4, 5, 0.5);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("regressed");
    expect(result.reason).toContain("5");
    expect(result.reason).toContain("4");
  });

  it("respects custom threshold", () => {
    expect(gateScoreRegression(4, 5, 2).passed).toBe(true);
    expect(gateScoreRegression(2, 5, 2).passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runValidationPipeline
// ---------------------------------------------------------------------------

describe("runValidationPipeline", () => {
  it("runs compile gate and reports result", async () => {
    mockExecSync.mockReturnValue(""); // compile passes
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        text: () => Promise.resolve("<html></html>"),
      }),
    );

    const result = await runValidationPipeline({
      targetCwd: "/tmp/project",
      appUrl: "http://localhost:3000",
      changedFiles: [],
      diff: "",
      nudge: "",
      projectWarnings: [],
      currentScore: null,
      previousScore: null,
    });

    expect(result.allPassed).toBe(true);
    expect(result.results.has("compile")).toBe(true);
    vi.unstubAllGlobals();
  });

  it("skips dev server check when compile fails", async () => {
    const err = new Error("tsc") as Error & { stdout: string; stderr: string };
    err.stdout = "error TS2322";
    err.stderr = "";
    mockExecSync.mockImplementation(() => {
      throw err;
    });

    const result = await runValidationPipeline({
      targetCwd: "/tmp/project",
      appUrl: "http://localhost:3000",
      changedFiles: [],
      diff: "",
      nudge: "",
      projectWarnings: [],
      currentScore: null,
      previousScore: null,
    });

    expect(result.allPassed).toBe(false);
    expect(result.results.has("compile")).toBe(true);
    expect(result.results.has("dev-server")).toBe(false);
  });
});
