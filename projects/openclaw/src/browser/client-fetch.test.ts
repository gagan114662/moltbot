import { afterEach, describe, expect, it, vi } from "vitest";

const browserControlMocks = vi.hoisted(() => ({
  startBrowserControlServiceFromConfig: vi.fn(),
  createBrowserControlContext: vi.fn(),
}));

const dispatcherMocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
}));

vi.mock("./control-service.js", () => browserControlMocks);
vi.mock("./routes/dispatcher.js", () => ({
  createBrowserRouteDispatcher: vi.fn(() => ({ dispatch: dispatcherMocks.dispatch })),
}));

import { fetchBrowserJson } from "./client-fetch.js";

describe("fetchBrowserJson", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("preserves actionable tab errors instead of masking as service outage", async () => {
    browserControlMocks.startBrowserControlServiceFromConfig.mockResolvedValue(true);
    dispatcherMocks.dispatch.mockResolvedValue({
      status: 404,
      body: { error: "tab not found" },
    });

    await expect(fetchBrowserJson("/tabs/abc", { method: "DELETE" })).rejects.toThrow(
      /tab not found/i,
    );
    await expect(fetchBrowserJson("/tabs/abc", { method: "DELETE" })).rejects.not.toThrow(
      /can't reach the openclaw browser control service/i,
    );
  });

  it("preserves HTTP 404 browser route errors instead of masking as service outage", async () => {
    browserControlMocks.startBrowserControlServiceFromConfig.mockResolvedValue(true);
    dispatcherMocks.dispatch.mockResolvedValue({
      status: 500,
      body: { error: "Error: HTTP 404" },
    });

    await expect(fetchBrowserJson("/tabs/open", { method: "POST" })).rejects.toThrow(/http 404/i);
    await expect(fetchBrowserJson("/tabs/open", { method: "POST" })).rejects.not.toThrow(
      /can't reach the openclaw browser control service/i,
    );
  });

  it("still returns service-unreachable messaging for non-route failures", async () => {
    browserControlMocks.startBrowserControlServiceFromConfig.mockResolvedValue(false);

    await expect(fetchBrowserJson("/tabs", { method: "GET" })).rejects.toThrow(
      /can't reach the openclaw browser control service/i,
    );
  });
});
