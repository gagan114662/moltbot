import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("browser reliability schema", () => {
  it("accepts browser extension reliability keys", () => {
    const res = OpenClawSchema.safeParse({
      browser: {
        extension: {
          autoAttachMode: "always",
          fallbackOnAttachFailure: true,
          fallbackProfile: "openclaw",
          attachRetryAttempts: 3,
          attachRetryDelayMs: 0,
        },
      },
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      return;
    }

    expect(res.data.browser?.extension).toEqual({
      autoAttachMode: "always",
      fallbackOnAttachFailure: true,
      fallbackProfile: "openclaw",
      attachRetryAttempts: 3,
      attachRetryDelayMs: 0,
    });
  });

  it("accepts preferBrowserFirst under tools.web.search", () => {
    const res = OpenClawSchema.safeParse({
      tools: {
        web: {
          search: {
            enabled: true,
            preferBrowserFirst: true,
          },
        },
      },
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      return;
    }

    expect(res.data.tools?.web?.search?.preferBrowserFirst).toBe(true);
  });

  it("rejects invalid extension autoAttachMode", () => {
    const res = OpenClawSchema.safeParse({
      browser: {
        extension: {
          autoAttachMode: "auto",
        },
      },
    });

    expect(res.success).toBe(false);
    if (res.success) {
      return;
    }

    expect(
      res.error.issues.some((issue) => issue.path.join(".") === "browser.extension.autoAttachMode"),
    ).toBe(true);
  });
});
