import { describe, expect, it } from "vitest";
import { validateConfigObject } from "./validation.js";

describe("config: tools.subagents.allowNestedSpawn", () => {
  it("accepts boolean toggle", () => {
    const res = validateConfigObject({
      tools: {
        subagents: {
          allowNestedSpawn: true,
        },
      },
    });
    expect(res.ok).toBe(true);
  });

  it("rejects non-boolean values", () => {
    const res = validateConfigObject({
      tools: {
        subagents: {
          allowNestedSpawn: "yes",
        },
      },
    });
    expect(res.ok).toBe(false);
  });
});
