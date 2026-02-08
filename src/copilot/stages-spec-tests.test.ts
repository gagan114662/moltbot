import { describe, expect, it } from "vitest";
import { augmentTaskWithSpecs } from "./stages-spec-tests.js";

describe("augmentTaskWithSpecs", () => {
  it("appends test file paths to the task", () => {
    const task = "Add a login form";
    const files = ["src/login.test.ts", "src/auth.test.ts"];
    const augmented = augmentTaskWithSpecs(task, files);

    expect(augmented).toContain("Add a login form");
    expect(augmented).toContain("ACCEPTANCE TESTS");
    expect(augmented).toContain("src/login.test.ts");
    expect(augmented).toContain("src/auth.test.ts");
    expect(augmented).toContain("make these acceptance tests pass");
  });

  it("returns task unchanged when no test files", () => {
    const task = "Add a login form";
    const augmented = augmentTaskWithSpecs(task, []);
    expect(augmented).toBe(task);
  });
});
