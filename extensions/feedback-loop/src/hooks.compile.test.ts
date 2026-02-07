import { describe, expect, it } from "vitest";
import { registerFeedbackLoopHooks } from "./hooks.js";

describe("feedback loop hooks module", () => {
  it("loads and exports registerFeedbackLoopHooks", () => {
    expect(typeof registerFeedbackLoopHooks).toBe("function");
  });
});
