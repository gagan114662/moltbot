import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("feedback loop hook events", () => {
  it("does not register unsupported legacy hook names", () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const hooksPath = path.resolve(dir, "hooks.ts");
    const source = fs.readFileSync(hooksPath, "utf8");

    expect(source).not.toContain('"PreToolUse"');
    expect(source).not.toContain('"PostToolUse"');
    expect(source).not.toContain('"SessionStart"');
    expect(source).not.toContain('"SubagentStart"');
    expect(source).not.toContain('"SubagentStop"');
    expect(source).not.toContain('"Stop"');
  });
});
