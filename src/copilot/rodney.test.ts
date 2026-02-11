import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock child_process and tool-detect before importing module
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}));

vi.mock("./tool-detect.js", () => ({
  detectTool: vi.fn(),
}));

vi.mock("./video-verify.js", () => ({
  detectDevServer: vi.fn(),
}));

describe("rodney", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe("runRodneyBrowserInspectStage", () => {
    it("skips gracefully when rodney is not installed", async () => {
      const { detectTool } = await import("./tool-detect.js");
      vi.mocked(detectTool).mockReturnValue({ available: false });

      const { runRodneyBrowserInspectStage } = await import("./rodney.js");
      const { result } = await runRodneyBrowserInspectStage({
        cwd: "/tmp/test",
        signal: new AbortController().signal,
      });

      expect(result.stage).toBe("browser");
      expect(result.passed).toBe(true);
      expect(result.error).toContain("not installed");
    });

    it("skips when no dev server detected", async () => {
      const { detectTool } = await import("./tool-detect.js");
      const { detectDevServer } = await import("./video-verify.js");
      vi.mocked(detectTool).mockReturnValue({ available: true, path: "/usr/bin/rodney" });
      vi.mocked(detectDevServer).mockResolvedValue(undefined as unknown as string);

      const { runRodneyBrowserInspectStage } = await import("./rodney.js");
      const { result } = await runRodneyBrowserInspectStage({
        cwd: "/tmp/test",
        signal: new AbortController().signal,
      });

      expect(result.passed).toBe(true);
      expect(result.error).toContain("No dev server");
    });
  });

  describe("runAccessibilityAudit", () => {
    it("detects buttons without accessible names", async () => {
      const { runAccessibilityAudit } = await import("./rodney.js");

      const mockSession = {
        run: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };

      // Buttons with one unnamed
      mockSession.run.mockImplementation(async (cmd: string, args?: string[]) => {
        if (cmd === "ax-find" && args?.[1] === "button") {
          return JSON.stringify([
            { name: { value: "Submit" } },
            { name: { value: "" } },
            { name: {} },
          ]);
        }
        // Links — all named
        if (cmd === "ax-find" && args?.[1] === "link") {
          return JSON.stringify([{ name: { value: "Home" } }]);
        }
        // Images — none
        if (cmd === "ax-find" && args?.[1] === "img") {
          return JSON.stringify([]);
        }
        return "";
      });

      const findings = await runAccessibilityAudit(mockSession);
      const criticalButtons = findings.filter(
        (f) => f.severity === "critical" && f.role === "button",
      );
      expect(criticalButtons.length).toBe(2);
    });

    it("returns empty when all elements are accessible", async () => {
      const { runAccessibilityAudit } = await import("./rodney.js");

      const mockSession = {
        run: vi.fn().mockImplementation(async () => JSON.stringify([])),
        start: vi.fn(),
        stop: vi.fn(),
      };

      const findings = await runAccessibilityAudit(mockSession);
      expect(findings).toHaveLength(0);
    });

    it("handles ax-find failures gracefully", async () => {
      const { runAccessibilityAudit } = await import("./rodney.js");

      const mockSession = {
        run: vi.fn().mockRejectedValue(new Error("rodney not running")),
        start: vi.fn(),
        stop: vi.fn(),
      };

      const findings = await runAccessibilityAudit(mockSession);
      expect(findings).toHaveLength(0);
    });
  });
});
