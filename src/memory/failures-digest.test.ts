import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  parseFailuresJsonl,
  normalizeError,
  clusterFailures,
  generateDigest,
  writeDigestIfChanged,
  refreshFailuresDigest,
  type FailureEntry,
} from "./failures-digest.js";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "failures-digest-test-"));
}

describe("parseFailuresJsonl", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("parses pretty-printed multi-line JSON objects", () => {
    const content = `{
  "timestamp": "2026-02-07T17:07:18Z",
  "tool": "Read",
  "error": "EISDIR: illegal operation on a directory",
  "input": { "file_path": "/foo/bar" }
}
{
  "timestamp": "2026-02-07T17:37:28Z",
  "tool": "Bash",
  "error": "Exit code 1",
  "input": { "command": "ls" }
}`;
    const file = path.join(dir, "failures.jsonl");
    fs.writeFileSync(file, content);
    const entries = parseFailuresJsonl(file);
    expect(entries).toHaveLength(2);
    expect(entries[0].tool).toBe("Read");
    expect(entries[1].tool).toBe("Bash");
  });

  it("parses compact JSONL", () => {
    const content = `{"timestamp":"2026-02-07T17:07:18Z","tool":"Read","error":"EISDIR","input":{}}
{"timestamp":"2026-02-07T17:37:28Z","tool":"Bash","error":"exit 1","input":{}}`;
    const file = path.join(dir, "failures.jsonl");
    fs.writeFileSync(file, content);
    const entries = parseFailuresJsonl(file);
    expect(entries).toHaveLength(2);
  });

  it("returns empty array for missing file", () => {
    expect(parseFailuresJsonl("/nonexistent/path")).toEqual([]);
  });

  it("skips malformed entries", () => {
    const content = `{"timestamp":"2026-02-07T17:07:18Z","tool":"Read","error":"ok","input":{}}
{not valid json}
{"timestamp":"2026-02-07T17:37:28Z","tool":"Bash","error":"ok","input":{}}`;
    const file = path.join(dir, "failures.jsonl");
    fs.writeFileSync(file, content);
    const entries = parseFailuresJsonl(file);
    expect(entries).toHaveLength(2);
  });
});

describe("normalizeError", () => {
  it("strips absolute paths to <path>/basename", () => {
    expect(normalizeError("EISDIR: /Users/foo/bar/baz.ts")).toContain("<path>/baz.ts");
  });

  it("strips hex IDs", () => {
    expect(normalizeError("error at 0xdeadbeef")).toContain("<hex>");
  });

  it("strips UUIDs", () => {
    expect(normalizeError("session 7f9ea217-7ef4-48e1-99c4-e058cd101f60 failed")).toContain(
      "<uuid>",
    );
  });

  it("strips ANSI codes", () => {
    expect(normalizeError("\x1b[31mError\x1b[0m: failed")).toBe("Error: failed");
  });

  it("collapses whitespace", () => {
    expect(normalizeError("error   at   line")).toBe("error at line");
  });

  it("truncates to 120 chars", () => {
    const long = "x".repeat(200);
    expect(normalizeError(long)).toHaveLength(120);
  });

  it("takes first line only", () => {
    expect(normalizeError("Exit code 1\nsome details\nmore")).toBe("Exit code 1");
  });
});

describe("clusterFailures", () => {
  it("groups entries by tool + normalized error", () => {
    const entries: FailureEntry[] = [
      {
        timestamp: "2026-02-07T10:00:00Z",
        tool: "Read",
        error: "EISDIR: illegal operation on a directory, read",
        input: {},
      },
      {
        timestamp: "2026-02-07T11:00:00Z",
        tool: "Read",
        error: "EISDIR: illegal operation on a directory, read",
        input: {},
      },
      { timestamp: "2026-02-08T12:00:00Z", tool: "Bash", error: "exit 1", input: {} },
    ];
    const clusters = clusterFailures(entries);
    expect(clusters).toHaveLength(2);
    const readCluster = clusters.find((c) => c.tool === "Read");
    expect(readCluster!.count).toBe(2);
    expect(readCluster!.distinctDays).toBe(1);
  });

  it("tracks distinct days across entries", () => {
    const entries: FailureEntry[] = [
      { timestamp: "2026-02-07T10:00:00Z", tool: "Read", error: "EISDIR", input: {} },
      { timestamp: "2026-02-08T10:00:00Z", tool: "Read", error: "EISDIR", input: {} },
      { timestamp: "2026-02-09T10:00:00Z", tool: "Read", error: "EISDIR", input: {} },
    ];
    const clusters = clusterFailures(entries);
    expect(clusters[0].distinctDays).toBe(3);
  });

  it("sorts by count descending", () => {
    const entries: FailureEntry[] = [
      { timestamp: "2026-02-07T10:00:00Z", tool: "Read", error: "EISDIR", input: {} },
      { timestamp: "2026-02-07T11:00:00Z", tool: "Bash", error: "exit 1", input: {} },
      { timestamp: "2026-02-07T12:00:00Z", tool: "Bash", error: "exit 1", input: {} },
      { timestamp: "2026-02-07T13:00:00Z", tool: "Bash", error: "exit 1", input: {} },
    ];
    const clusters = clusterFailures(entries);
    expect(clusters[0].tool).toBe("Bash");
    expect(clusters[0].count).toBe(3);
  });
});

describe("generateDigest", () => {
  it("produces markdown with tool sections", () => {
    const clusters = [
      {
        tool: "Read",
        pattern: "EISDIR",
        count: 12,
        recent: ["EISDIR"],
        firstSeen: "2026-02-07T10:00:00Z",
        lastSeen: "2026-02-09T10:00:00Z",
        distinctDays: 3,
      },
    ];
    const md = generateDigest(clusters, 12);
    expect(md).toContain("# Failure Patterns (auto-generated)");
    expect(md).toContain("## Read (12 failures)");
    expect(md).toContain("**EISDIR** (12x, last: 2026-02-09, 3 days)");
  });
});

describe("writeDigestIfChanged", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes new file and returns true", () => {
    const p = path.join(dir, "digest.md");
    expect(writeDigestIfChanged(p, "hello")).toBe(true);
    expect(fs.readFileSync(p, "utf-8")).toBe("hello");
  });

  it("skips write if content unchanged", () => {
    const p = path.join(dir, "digest.md");
    fs.writeFileSync(p, "hello");
    expect(writeDigestIfChanged(p, "hello")).toBe(false);
  });

  it("writes if content changed", () => {
    const p = path.join(dir, "digest.md");
    fs.writeFileSync(p, "hello");
    expect(writeDigestIfChanged(p, "world")).toBe(true);
    expect(fs.readFileSync(p, "utf-8")).toBe("world");
  });
});

describe("refreshFailuresDigest", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("end-to-end: parses, clusters, writes digest", () => {
    const jsonl = path.join(dir, "failures.jsonl");
    const digest = path.join(dir, "failures-digest.md");
    fs.writeFileSync(
      jsonl,
      `{"timestamp":"2026-02-07T10:00:00Z","tool":"Read","error":"EISDIR","input":{}}
{"timestamp":"2026-02-08T10:00:00Z","tool":"Read","error":"EISDIR","input":{}}
{"timestamp":"2026-02-07T11:00:00Z","tool":"Bash","error":"exit 1","input":{}}`,
    );
    const result = refreshFailuresDigest(jsonl, digest);
    expect(result.entries).toBe(3);
    expect(result.clusters).toBe(2);
    expect(result.written).toBe(true);
    expect(fs.existsSync(digest)).toBe(true);
    const content = fs.readFileSync(digest, "utf-8");
    expect(content).toContain("## Read (2 failures)");
    expect(content).toContain("## Bash (1 failures)");
  });
});
