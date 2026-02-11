import { describe, it, expect } from "vitest";
import { detectTool } from "./tool-detect.js";

// We can't mock execSync easily without module-level patching,
// so test against real system binaries.

describe("detectTool", () => {
  it("detects a binary that exists (node)", () => {
    const result = detectTool("node");
    expect(result.available).toBe(true);
    expect(result.path).toBeTruthy();
    expect(result.path).toContain("node");
  });

  it("returns unavailable for a nonexistent binary", () => {
    const result = detectTool("__this_binary_does_not_exist_xyz__");
    expect(result.available).toBe(false);
    expect(result.path).toBeUndefined();
  });

  it("returns unavailable for empty name", () => {
    const result = detectTool("");
    expect(result.available).toBe(false);
  });
});
