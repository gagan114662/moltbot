import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverTestFiles } from "./stages.js";

describe("stages", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "copilot-stages-"));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  describe("discoverTestFiles", () => {
    it("finds colocated test files for changed source files", async () => {
      // Create source and test files
      await fsp.writeFile(path.join(tmpDir, "foo.ts"), "export const x = 1;");
      await fsp.writeFile(path.join(tmpDir, "foo.test.ts"), "test('x', () => {});");

      const tests = discoverTestFiles(["foo.ts"], tmpDir);
      expect(tests).toEqual(["foo.test.ts"]);
    });

    it("ignores source files without colocated tests", async () => {
      await fsp.writeFile(path.join(tmpDir, "bar.ts"), "export const y = 2;");

      const tests = discoverTestFiles(["bar.ts"], tmpDir);
      expect(tests).toEqual([]);
    });

    it("includes directly changed test files", async () => {
      await fsp.writeFile(path.join(tmpDir, "baz.test.ts"), "test('z', () => {});");

      const tests = discoverTestFiles(["baz.test.ts"], tmpDir);
      expect(tests).toEqual(["baz.test.ts"]);
    });

    it("skips non-TypeScript files", () => {
      const tests = discoverTestFiles(["readme.md", "config.json"], tmpDir);
      expect(tests).toEqual([]);
    });

    it("skips e2e test files", () => {
      const tests = discoverTestFiles(["foo.e2e.test.ts"], tmpDir);
      expect(tests).toEqual([]);
    });

    it("deduplicates test files", async () => {
      await fsp.writeFile(path.join(tmpDir, "foo.ts"), "");
      await fsp.writeFile(path.join(tmpDir, "foo.test.ts"), "");

      // Both source and test file changed — should only appear once
      const tests = discoverTestFiles(["foo.ts", "foo.test.ts"], tmpDir);
      expect(tests).toEqual(["foo.test.ts"]);
    });

    it("handles nested paths", async () => {
      const dir = path.join(tmpDir, "src", "utils");
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, "helper.ts"), "");
      await fsp.writeFile(path.join(dir, "helper.test.ts"), "");

      const tests = discoverTestFiles(["src/utils/helper.ts"], tmpDir);
      expect(tests).toEqual(["src/utils/helper.test.ts"]);
    });
  });
});
