import { describe, it, expect } from "vitest";
import type { BrowserInspectResult } from "./browser-inspect.js";
import { formatFindings, resolveChromePath } from "./browser-inspect.js";

describe("formatFindings", () => {
  const baseResult: BrowserInspectResult = {
    appUrl: "http://localhost:3000",
    consoleErrors: [],
    consoleWarnings: [],
    networkFailures: [],
    pageErrors: [],
    pageTitle: "Test App",
    isBlankPage: false,
  };

  it("reports blank page", () => {
    const result = { ...baseResult, isBlankPage: true };
    const output = formatFindings(result);

    expect(output).toContain("BLANK PAGE");
    expect(output).toContain("no visible content");
  });

  it("reports uncaught exceptions with stack traces", () => {
    const result: BrowserInspectResult = {
      ...baseResult,
      pageErrors: [
        {
          message: "TypeError: Cannot read property 'map' of undefined",
          stack:
            "at Component (src/App.tsx:15)\nat renderWithHooks\nat mountIndeterminateComponent",
        },
      ],
    };
    const output = formatFindings(result);

    expect(output).toContain("1 uncaught exception(s)");
    expect(output).toContain("Cannot read property 'map'");
    expect(output).toContain("src/App.tsx:15");
  });

  it("reports console errors with source location", () => {
    const result: BrowserInspectResult = {
      ...baseResult,
      consoleErrors: [
        {
          level: "error",
          text: "Failed to load resource: net::ERR_CONNECTION_REFUSED",
          url: "http://localhost:3000/api/data",
          line: undefined,
        },
        {
          level: "error",
          text: "Uncaught ReferenceError: foo is not defined",
          url: "http://localhost:3000/assets/main.js",
          line: 42,
        },
      ],
    };
    const output = formatFindings(result);

    expect(output).toContain("2 console error(s)");
    expect(output).toContain("ERR_CONNECTION_REFUSED");
    expect(output).toContain("/api/data");
    expect(output).toContain("main.js:42");
  });

  it("reports console warnings separately", () => {
    const result: BrowserInspectResult = {
      ...baseResult,
      consoleWarnings: [{ level: "warning", text: "Deprecation warning: use newMethod instead" }],
    };
    const output = formatFindings(result);

    expect(output).toContain("1 console warning(s)");
    expect(output).toContain("Deprecation warning");
  });

  it("reports network failures with status codes", () => {
    const result: BrowserInspectResult = {
      ...baseResult,
      networkFailures: [
        {
          url: "http://localhost:3000/api/users",
          status: 500,
          statusText: "Internal Server Error",
          method: "GET",
        },
        {
          url: "http://localhost:3000/api/auth",
          status: 404,
          statusText: "Not Found",
          method: "POST",
        },
        { url: "http://localhost:3000/api/timeout", method: "GET" },
      ],
    };
    const output = formatFindings(result);

    expect(output).toContain("3 network failure(s)");
    expect(output).toContain("GET http://localhost:3000/api/users → 500 Internal Server Error");
    expect(output).toContain("POST http://localhost:3000/api/auth → 404 Not Found");
    expect(output).toContain("GET http://localhost:3000/api/timeout → failed");
  });

  it("combines multiple finding types", () => {
    const result: BrowserInspectResult = {
      ...baseResult,
      isBlankPage: true,
      pageErrors: [{ message: "ReferenceError: x is not defined" }],
      consoleErrors: [{ level: "error", text: "load error" }],
      networkFailures: [
        { url: "/api/foo", status: 503, statusText: "Service Unavailable", method: "GET" },
      ],
    };
    const output = formatFindings(result);

    expect(output).toContain("BLANK PAGE");
    expect(output).toContain("uncaught exception");
    expect(output).toContain("console error");
    expect(output).toContain("network failure");
  });

  it("limits output to first N entries per category", () => {
    const errors = Array.from({ length: 20 }, (_, i) => ({
      level: "error" as const,
      text: `error ${i}`,
    }));
    const result: BrowserInspectResult = {
      ...baseResult,
      consoleErrors: errors,
    };
    const output = formatFindings(result);

    // Should show first 10, not all 20
    expect(output).toContain("error 0");
    expect(output).toContain("error 9");
    expect(output).not.toContain("error 10");
    expect(output).toContain("20 console error(s)");
  });

  it("returns empty string when no findings", () => {
    const output = formatFindings(baseResult);
    expect(output).toBe("");
  });
});

describe("resolveChromePath", () => {
  it("returns a string or undefined", () => {
    const result = resolveChromePath();
    // On CI, Chrome may not exist — just check the return type
    expect(result === undefined || typeof result === "string").toBe(true);
  });
});
