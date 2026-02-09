import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectToolchain, presets } from "./toolchain.js";

describe("detectToolchain", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolchain-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Helper to create files
  function writeFile(name: string, content = "") {
    const full = path.join(tmpDir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  it("detects Rust projects from Cargo.toml", () => {
    writeFile("Cargo.toml", '[package]\nname = "myapp"');
    const tc = detectToolchain(tmpDir);
    expect(tc.name).toBe("Rust (cargo)");
    expect(tc.lint?.command).toBe("cargo");
    expect(tc.test?.command).toBe("cargo");
  });

  it("detects Go projects from go.mod", () => {
    writeFile("go.mod", "module example.com/app\n\ngo 1.22");
    const tc = detectToolchain(tmpDir);
    expect(tc.name).toBe("Go");
    expect(tc.test?.args).toContain("./...");
  });

  it("detects Python from pyproject.toml", () => {
    writeFile("pyproject.toml", '[project]\nname = "myapp"');
    const tc = detectToolchain(tmpDir);
    expect(tc.name).toBe("Python (pytest)");
    expect(tc.test?.command).toBe("pytest");
  });

  it("detects Python from requirements.txt", () => {
    writeFile("requirements.txt", "flask\npytest");
    const tc = detectToolchain(tmpDir);
    expect(tc.name).toBe("Python (pytest)");
  });

  it("detects TypeScript pnpm + vitest", () => {
    writeFile(
      "package.json",
      JSON.stringify({ devDependencies: { vitest: "^1.0.0", typescript: "^5.0.0" } }),
    );
    writeFile("pnpm-lock.yaml", "lockfileVersion: 9");
    const tc = detectToolchain(tmpDir);
    expect(tc.name).toBe("TypeScript (pnpm + vitest)");
    expect(tc.lint?.command).toBe("pnpm");
    expect(tc.test?.args).toContain("vitest");
  });

  it("detects TypeScript bun", () => {
    writeFile("package.json", JSON.stringify({ devDependencies: { typescript: "^5.0.0" } }));
    writeFile("bun.lockb", "");
    const tc = detectToolchain(tmpDir);
    expect(tc.name).toBe("TypeScript (bun)");
    expect(tc.test?.command).toBe("bun");
  });

  it("detects npm + jest", () => {
    writeFile(
      "package.json",
      JSON.stringify({ devDependencies: { jest: "^29.0.0", typescript: "^5.0.0" } }),
    );
    writeFile("package-lock.json", "{}");
    const tc = detectToolchain(tmpDir);
    expect(tc.name).toBe("TypeScript (npm + jest)");
    expect(tc.test?.command).toBe("npx");
    expect(tc.test?.args).toContain("jest");
  });

  it("detects npm + vitest (without pnpm)", () => {
    writeFile("package.json", JSON.stringify({ devDependencies: { vitest: "^1.0.0" } }));
    writeFile("package-lock.json", "{}");
    const tc = detectToolchain(tmpDir);
    expect(tc.name).toBe("TypeScript (npm + vitest)");
    expect(tc.test?.command).toBe("npx");
    expect(tc.test?.args).toContain("vitest");
  });

  it("falls back to generic JS when package.json has no known framework", () => {
    writeFile(
      "package.json",
      JSON.stringify({ scripts: { test: "node test.js", lint: "eslint ." } }),
    );
    const tc = detectToolchain(tmpDir);
    expect(tc.name).toBe("JavaScript/TypeScript (npm)");
    expect(tc.test?.command).toBe("npm");
    expect(tc.lint?.command).toBe("npm");
  });

  it("adds typecheck for JS projects with tsconfig.json", () => {
    writeFile("package.json", JSON.stringify({ scripts: { test: "node test.js" } }));
    writeFile("tsconfig.json", "{}");
    const tc = detectToolchain(tmpDir);
    expect(tc.typecheck?.command).toBe("npx");
    expect(tc.typecheck?.args).toContain("--noEmit");
  });

  it("returns generic fallback for empty directory", () => {
    const tc = detectToolchain(tmpDir);
    expect(tc.name).toBe("Generic project");
    expect(tc.lint).toBeUndefined();
    expect(tc.test).toBeUndefined();
  });

  it("respects .moltbot.json toolchain override", () => {
    writeFile(".moltbot.json", JSON.stringify({ toolchain: "rust" }));
    writeFile("package.json", JSON.stringify({ devDependencies: { vitest: "^1.0.0" } }));
    const tc = detectToolchain(tmpDir);
    expect(tc.name).toBe("Rust (cargo)");
  });

  it("ignores invalid .moltbot.json override and falls back to detection", () => {
    writeFile(".moltbot.json", JSON.stringify({ toolchain: "nonexistent" }));
    writeFile("go.mod", "module example.com/app");
    const tc = detectToolchain(tmpDir);
    expect(tc.name).toBe("Go");
  });

  it("Rust takes priority over package.json", () => {
    writeFile("Cargo.toml", "[package]");
    writeFile("package.json", JSON.stringify({ devDependencies: { vitest: "^1.0.0" } }));
    const tc = detectToolchain(tmpDir);
    expect(tc.name).toBe("Rust (cargo)");
  });

  it("presets are all structurally valid", () => {
    for (const [key, preset] of Object.entries(presets)) {
      expect(preset.name, `${key} should have name`).toBeTruthy();
      expect(preset.testDiscovery, `${key} should have testDiscovery`).toBeDefined();
      expect(preset.promptHints, `${key} should have promptHints`).toBeDefined();
      expect(
        preset.promptHints.testFramework,
        `${key} should have testFramework hint`,
      ).toBeTruthy();
    }
  });

  it("Python testDiscovery uses tests/ directory", () => {
    const tc = presets.python;
    expect(tc.testDiscovery.testDir).toBe("tests");
    expect(tc.testDiscovery.testPrefix).toBe("test_");
  });

  it("Go testDiscovery uses _test.go suffix", () => {
    const tc = presets.go;
    expect(tc.testDiscovery.colocatedSuffix).toBe("_test.go");
  });
});
