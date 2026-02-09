import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootstrapQaHooks } from "./qa-bootstrap.js";

describe("qa-bootstrap", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "qa-bootstrap-test-"));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  describe("bootstrapQaHooks", () => {
    it("creates all expected files in a fresh directory", async () => {
      await bootstrapQaHooks(tmpDir);

      expect(fs.existsSync(path.join(tmpDir, ".claude/hooks/qa-feedback.sh"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, ".claude/settings.json"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, ".claude/CLAUDE.md"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, ".gitignore"))).toBe(true);
    });

    it("installs hook script with marker and executable mode", async () => {
      await bootstrapQaHooks(tmpDir);

      const script = await fsp.readFile(path.join(tmpDir, ".claude/hooks/qa-feedback.sh"), "utf-8");
      expect(script).toContain("# moltbot-qa-hook");
      expect(script).toContain("copilot-feedback.json");

      const stat = await fsp.stat(path.join(tmpDir, ".claude/hooks/qa-feedback.sh"));
      // Check owner-executable bit
      expect(stat.mode & 0o100).toBeTruthy();
    });

    it("creates valid settings.json with UserPromptSubmit hook", async () => {
      await bootstrapQaHooks(tmpDir);

      const raw = await fsp.readFile(path.join(tmpDir, ".claude/settings.json"), "utf-8");
      const settings = JSON.parse(raw);
      expect(settings.hooks.UserPromptSubmit).toEqual([
        { type: "command", command: ".claude/hooks/qa-feedback.sh" },
      ]);
    });

    it("creates CLAUDE.md with integration section", async () => {
      await bootstrapQaHooks(tmpDir);

      const content = await fsp.readFile(path.join(tmpDir, ".claude/CLAUDE.md"), "utf-8");
      expect(content).toContain("## Moltbot QA Integration");
      expect(content).toContain("QA-FEEDBACK.md");
    });

    it("creates gitignore with both entries", async () => {
      await bootstrapQaHooks(tmpDir);

      const content = await fsp.readFile(path.join(tmpDir, ".gitignore"), "utf-8");
      expect(content).toContain(".moltbot/");
      expect(content).toContain("QA-FEEDBACK.md");
    });
  });

  describe("idempotency", () => {
    it("calling twice does not duplicate hook script", async () => {
      await bootstrapQaHooks(tmpDir);
      await bootstrapQaHooks(tmpDir);

      const script = await fsp.readFile(path.join(tmpDir, ".claude/hooks/qa-feedback.sh"), "utf-8");
      const markerCount = (script.match(/# moltbot-qa-hook/g) ?? []).length;
      // One in the shebang area (the marker line)
      expect(markerCount).toBe(1);
    });

    it("calling twice does not duplicate settings.json entries", async () => {
      await bootstrapQaHooks(tmpDir);
      await bootstrapQaHooks(tmpDir);

      const raw = await fsp.readFile(path.join(tmpDir, ".claude/settings.json"), "utf-8");
      const settings = JSON.parse(raw);
      expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    });

    it("calling twice does not duplicate CLAUDE.md section", async () => {
      await bootstrapQaHooks(tmpDir);
      await bootstrapQaHooks(tmpDir);

      const content = await fsp.readFile(path.join(tmpDir, ".claude/CLAUDE.md"), "utf-8");
      const markerCount = (content.match(/## Moltbot QA Integration/g) ?? []).length;
      expect(markerCount).toBe(1);
    });

    it("calling twice does not duplicate gitignore entries", async () => {
      await bootstrapQaHooks(tmpDir);
      await bootstrapQaHooks(tmpDir);

      const content = await fsp.readFile(path.join(tmpDir, ".gitignore"), "utf-8");
      const moltbotCount = (content.match(/\.moltbot\//g) ?? []).length;
      expect(moltbotCount).toBe(1);
    });
  });

  describe("settings.json merge", () => {
    it("preserves existing settings when merging", async () => {
      const settingsPath = path.join(tmpDir, ".claude/settings.json");
      await fsp.mkdir(path.dirname(settingsPath), { recursive: true });
      await fsp.writeFile(
        settingsPath,
        JSON.stringify({
          permissions: { allow: ["Read"] },
          hooks: { Stop: [{ type: "command", command: "echo stop" }] },
        }),
        "utf-8",
      );

      await bootstrapQaHooks(tmpDir);

      const raw = await fsp.readFile(settingsPath, "utf-8");
      const settings = JSON.parse(raw);
      expect(settings.permissions).toEqual({ allow: ["Read"] });
      expect(settings.hooks.Stop).toEqual([{ type: "command", command: "echo stop" }]);
      expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    });

    it("preserves existing UserPromptSubmit hooks", async () => {
      const settingsPath = path.join(tmpDir, ".claude/settings.json");
      await fsp.mkdir(path.dirname(settingsPath), { recursive: true });
      await fsp.writeFile(
        settingsPath,
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [{ type: "command", command: "echo existing" }],
          },
        }),
        "utf-8",
      );

      await bootstrapQaHooks(tmpDir);

      const raw = await fsp.readFile(settingsPath, "utf-8");
      const settings = JSON.parse(raw);
      expect(settings.hooks.UserPromptSubmit).toHaveLength(2);
      expect(settings.hooks.UserPromptSubmit[0].command).toBe("echo existing");
      expect(settings.hooks.UserPromptSubmit[1].command).toBe(".claude/hooks/qa-feedback.sh");
    });
  });

  describe("gitignore", () => {
    it("appends to existing gitignore without clobbering", async () => {
      const gitignorePath = path.join(tmpDir, ".gitignore");
      await fsp.writeFile(gitignorePath, "node_modules/\ndist/\n", "utf-8");

      await bootstrapQaHooks(tmpDir);

      const content = await fsp.readFile(gitignorePath, "utf-8");
      expect(content).toContain("node_modules/");
      expect(content).toContain("dist/");
      expect(content).toContain(".moltbot/");
      expect(content).toContain("QA-FEEDBACK.md");
    });

    it("skips entries already present in gitignore", async () => {
      const gitignorePath = path.join(tmpDir, ".gitignore");
      await fsp.writeFile(gitignorePath, "node_modules/\n.moltbot/\n", "utf-8");

      await bootstrapQaHooks(tmpDir);

      const content = await fsp.readFile(gitignorePath, "utf-8");
      const moltbotCount = (content.match(/\.moltbot\//g) ?? []).length;
      expect(moltbotCount).toBe(1);
      expect(content).toContain("QA-FEEDBACK.md");
    });

    it("handles gitignore without trailing newline", async () => {
      const gitignorePath = path.join(tmpDir, ".gitignore");
      await fsp.writeFile(gitignorePath, "node_modules/", "utf-8");

      await bootstrapQaHooks(tmpDir);

      const content = await fsp.readFile(gitignorePath, "utf-8");
      // Should not have entries concatenated to last line
      expect(content).not.toContain("node_modules/.moltbot");
    });
  });

  describe("CLAUDE.md append", () => {
    it("appends to existing CLAUDE.md content", async () => {
      const claudeMdPath = path.join(tmpDir, ".claude/CLAUDE.md");
      await fsp.mkdir(path.dirname(claudeMdPath), { recursive: true });
      await fsp.writeFile(claudeMdPath, "# My Project\n\nExisting instructions.\n", "utf-8");

      await bootstrapQaHooks(tmpDir);

      const content = await fsp.readFile(claudeMdPath, "utf-8");
      expect(content).toContain("# My Project");
      expect(content).toContain("Existing instructions.");
      expect(content).toContain("## Moltbot QA Integration");
    });
  });
});
