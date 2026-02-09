import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  resolveSharedDir,
  readSharedLearned,
  readDiscoveries,
  appendDiscovery,
  appendSharedRule,
  rotateDiscoveriesIfNeeded,
} from "./shared-context.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "shared-context-test-"));
}

describe("resolveSharedDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates shared directory if it doesn't exist", () => {
    const sharedDir = resolveSharedDir(dir);
    expect(sharedDir).toBe(path.join(dir, "shared"));
    expect(fs.existsSync(sharedDir)).toBe(true);
  });

  it("returns existing shared directory", () => {
    const sharedDir = path.join(dir, "shared");
    fs.mkdirSync(sharedDir);
    expect(resolveSharedDir(dir)).toBe(sharedDir);
  });
});

describe("readSharedLearned", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty string when file doesn't exist", () => {
    expect(readSharedLearned(dir)).toBe("");
  });

  it("returns full content when no limit", () => {
    const sharedDir = path.join(dir, "shared");
    fs.mkdirSync(sharedDir);
    fs.writeFileSync(path.join(sharedDir, "SHARED-LEARNED.md"), "line1\nline2\nline3");
    expect(readSharedLearned(dir)).toBe("line1\nline2\nline3");
  });

  it("caps to last N lines when limit set", () => {
    const sharedDir = path.join(dir, "shared");
    fs.mkdirSync(sharedDir);
    fs.writeFileSync(
      path.join(sharedDir, "SHARED-LEARNED.md"),
      "line1\nline2\nline3\nline4\nline5",
    );
    expect(readSharedLearned(dir, 2)).toBe("line4\nline5");
  });

  it("returns full content when lines <= limit", () => {
    const sharedDir = path.join(dir, "shared");
    fs.mkdirSync(sharedDir);
    fs.writeFileSync(path.join(sharedDir, "SHARED-LEARNED.md"), "line1\nline2");
    expect(readSharedLearned(dir, 5)).toBe("line1\nline2");
  });
});

describe("readDiscoveries", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty string when file doesn't exist", () => {
    expect(readDiscoveries(dir)).toBe("");
  });

  it("only returns lines starting with '- ['", () => {
    const sharedDir = path.join(dir, "shared");
    fs.mkdirSync(sharedDir);
    fs.writeFileSync(
      path.join(sharedDir, "discoveries.md"),
      "# Discoveries\n- [2026-02-08 10:00] (main) Finding 1\n- [2026-02-08 11:00] (main) Finding 2\n",
    );
    const result = readDiscoveries(dir);
    expect(result).toContain("Finding 1");
    expect(result).toContain("Finding 2");
    expect(result).not.toContain("# Discoveries");
  });

  it("caps to last N entries", () => {
    const sharedDir = path.join(dir, "shared");
    fs.mkdirSync(sharedDir);
    const entries = Array.from(
      { length: 15 },
      (_, i) => `- [2026-02-08 ${String(i).padStart(2, "0")}:00] (main) Finding ${i}`,
    );
    fs.writeFileSync(
      path.join(sharedDir, "discoveries.md"),
      `# Discoveries\n${entries.join("\n")}\n`,
    );
    const result = readDiscoveries(dir, 5);
    const lines = result.split("\n");
    expect(lines).toHaveLength(5);
    expect(lines[0]).toContain("Finding 10");
    expect(lines[4]).toContain("Finding 14");
  });
});

describe("appendDiscovery", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates file with header on first append", () => {
    appendDiscovery(dir, "main", "Test finding");
    const filePath = path.join(dir, "shared", "discoveries.md");
    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("# Discoveries");
    expect(content).toContain("(main) Test finding");
  });

  it("appends to existing file", () => {
    appendDiscovery(dir, "main", "First finding");
    appendDiscovery(dir, "researcher", "Second finding");
    const content = fs.readFileSync(path.join(dir, "shared", "discoveries.md"), "utf-8");
    expect(content).toContain("(main) First finding");
    expect(content).toContain("(researcher) Second finding");
  });

  it("collapses newlines in text", () => {
    appendDiscovery(dir, "main", "multi\nline\nfinding");
    const content = fs.readFileSync(path.join(dir, "shared", "discoveries.md"), "utf-8");
    expect(content).toContain("multi line finding");
  });

  it("includes timestamp in entry", () => {
    appendDiscovery(dir, "main", "timestamped finding");
    const content = fs.readFileSync(path.join(dir, "shared", "discoveries.md"), "utf-8");
    // Verify format: - [YYYY-MM-DD HH:MM] (agent) text
    expect(content).toMatch(/- \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] \(main\) timestamped finding/);
  });
});

describe("appendSharedRule", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates file with header on first rule", () => {
    const added = appendSharedRule(dir, "- Always verify paths before editing");
    expect(added).toBe(true);
    const content = fs.readFileSync(path.join(dir, "shared", "SHARED-LEARNED.md"), "utf-8");
    expect(content).toContain("# Shared Rules");
    expect(content).toContain("- Always verify paths before editing");
  });

  it("appends non-duplicate rule", () => {
    appendSharedRule(dir, "- Always verify file paths before editing any source files");
    const added = appendSharedRule(
      dir,
      "- Run vitest coverage after refactoring to catch regressions",
    );
    expect(added).toBe(true);
    const content = fs.readFileSync(path.join(dir, "shared", "SHARED-LEARNED.md"), "utf-8");
    expect(content).toContain("verify file paths");
    expect(content).toContain("vitest coverage");
  });

  it("rejects duplicate rule (Jaccard > 0.7)", () => {
    appendSharedRule(dir, "- Always verify file paths before editing files");
    const added = appendSharedRule(dir, "- Always verify file paths before editing");
    expect(added).toBe(false);
  });

  it("accepts sufficiently different rule", () => {
    appendSharedRule(dir, "- Always verify file paths before editing files");
    const added = appendSharedRule(dir, "- Run tests after every code change to catch regressions");
    expect(added).toBe(true);
  });
});

describe("rotateDiscoveriesIfNeeded", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does nothing when file doesn't exist", () => {
    expect(rotateDiscoveriesIfNeeded(dir)).toBe(false);
  });

  it("does nothing when under limit", () => {
    const sharedDir = path.join(dir, "shared");
    fs.mkdirSync(sharedDir);
    const entries = Array.from(
      { length: 50 },
      (_, i) => `- [2026-02-08 ${i}:00] (main) Finding ${i}`,
    );
    fs.writeFileSync(
      path.join(sharedDir, "discoveries.md"),
      `# Discoveries\n${entries.join("\n")}\n`,
    );
    expect(rotateDiscoveriesIfNeeded(dir)).toBe(false);
  });

  it("rotates when over limit (201 entries)", () => {
    const sharedDir = path.join(dir, "shared");
    fs.mkdirSync(sharedDir);
    const entries = Array.from(
      { length: 201 },
      (_, i) => `- [2026-02-08 00:${String(i).padStart(2, "0")}] (main) Finding ${i}`,
    );
    fs.writeFileSync(
      path.join(sharedDir, "discoveries.md"),
      `# Discoveries\n${entries.join("\n")}\n`,
    );

    expect(rotateDiscoveriesIfNeeded(dir)).toBe(true);

    // Main file should have 100 entries (MAX/2)
    const mainContent = fs.readFileSync(path.join(sharedDir, "discoveries.md"), "utf-8");
    const mainEntries = mainContent.split("\n").filter((l) => l.startsWith("- ["));
    expect(mainEntries).toHaveLength(100);
    // Should keep the LAST 100
    expect(mainEntries[0]).toContain("Finding 101");
    expect(mainEntries[99]).toContain("Finding 200");

    // Archive should have 101 entries
    const archiveContent = fs.readFileSync(path.join(sharedDir, "discoveries.archive.md"), "utf-8");
    const archiveEntries = archiveContent.split("\n").filter((l) => l.startsWith("- ["));
    expect(archiveEntries).toHaveLength(101);
    expect(archiveEntries[0]).toContain("Finding 0");
  });
});
