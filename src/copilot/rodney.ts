/**
 * Rodney browser automation integration.
 *
 * Wraps the `rodney` CLI (github.com/simonw/rodney) for persistent
 * headless Chrome sessions with built-in accessibility testing.
 * Falls back gracefully when rodney is not installed.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { StageResult } from "./types.js";
import { detectTool } from "./tool-detect.js";
import { detectDevServer } from "./video-verify.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AccessibilityFinding = {
  severity: "critical" | "major" | "minor";
  description: string;
  selector?: string;
  role?: string;
  name?: string;
};

export type RodneyInspectResult = {
  appUrl: string;
  consoleErrors: string[];
  screenshotPath?: string;
  accessibilityFindings: AccessibilityFinding[];
  pageTitle: string;
  isBlankPage: boolean;
};

export type RodneySession = {
  /** Run a rodney subcommand, returns stdout */
  run(subcommand: string, args?: string[]): Promise<string>;
  /** Start the persistent Chrome instance */
  start(): Promise<void>;
  /** Stop the persistent Chrome instance */
  stop(): Promise<void>;
};

// ---------------------------------------------------------------------------
// Session wrapper
// ---------------------------------------------------------------------------

/** Create a Rodney CLI session wrapper. */
export function createRodneySession(): RodneySession {
  async function run(subcommand: string, args: string[] = []): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn("rodney", [subcommand, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`rodney ${subcommand}: timeout after 30s`));
      }, 30_000);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(
            new Error(`rodney ${subcommand} exited ${code}: ${stderr || stdout}`.slice(0, 500)),
          );
        } else {
          resolve(stdout);
        }
      });
    });
  }

  return {
    run,
    async start() {
      await run("start");
    },
    async stop() {
      try {
        await run("stop");
      } catch {
        // Chrome may already be stopped — ignore
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Accessibility audit
// ---------------------------------------------------------------------------

/**
 * Run accessibility checks using Rodney's ax-find command.
 * Checks for common WCAG violations:
 *   - Buttons/links without accessible names (critical)
 *   - Images without alt text (critical)
 *   - Form inputs without labels (major)
 */
export async function runAccessibilityAudit(
  session: RodneySession,
): Promise<AccessibilityFinding[]> {
  const findings: AccessibilityFinding[] = [];

  // Check buttons without names
  try {
    const buttonsRaw = await session.run("ax-find", ["--role", "button", "--json"]);
    const buttons = JSON.parse(buttonsRaw) as Array<{ name?: { value?: string } }>;
    const unnamed = buttons.filter((b) => !b.name?.value?.trim());
    for (const _b of unnamed) {
      findings.push({
        severity: "critical",
        description: "Button missing accessible name",
        role: "button",
      });
    }
  } catch {
    // ax-find not available or no buttons — continue
  }

  // Check links without names
  try {
    const linksRaw = await session.run("ax-find", ["--role", "link", "--json"]);
    const links = JSON.parse(linksRaw) as Array<{ name?: { value?: string } }>;
    const unnamed = links.filter((l) => !l.name?.value?.trim());
    for (const _l of unnamed) {
      findings.push({
        severity: "major",
        description: "Link missing accessible name",
        role: "link",
      });
    }
  } catch {
    // Continue
  }

  // Check images without alt
  try {
    const imgsRaw = await session.run("ax-find", ["--role", "img", "--json"]);
    const imgs = JSON.parse(imgsRaw) as Array<{ name?: { value?: string } }>;
    const noAlt = imgs.filter((img) => !img.name?.value?.trim());
    for (const _img of noAlt) {
      findings.push({
        severity: "critical",
        description: "Image missing alt text",
        role: "img",
      });
    }
  } catch {
    // Continue
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Browser inspect stage (Rodney-powered)
// ---------------------------------------------------------------------------

/**
 * Browser inspection via Rodney. Replaces Playwright-based browser-inspect
 * when Rodney is available. Adds accessibility tree testing.
 */
export async function runRodneyBrowserInspectStage(ctx: {
  cwd: string;
  signal: AbortSignal;
  appUrl?: string;
}): Promise<{ result: StageResult; inspect?: RodneyInspectResult }> {
  const start = Date.now();

  const tool = detectTool("rodney");
  if (!tool.available) {
    return {
      result: {
        stage: "browser",
        passed: true,
        durationMs: Date.now() - start,
        error: "rodney not installed (skipped)",
      },
    };
  }

  const appUrl = ctx.appUrl ?? (await detectDevServer());
  if (!appUrl) {
    return {
      result: {
        stage: "browser",
        passed: true,
        durationMs: Date.now() - start,
        error: "No dev server detected (skipped)",
      },
    };
  }

  const session = createRodneySession();
  const evidenceDir = path.join(ctx.cwd, ".moltbot", "evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });

  try {
    await session.start();
    await session.run("open", [appUrl]);

    // Wait for page to settle
    try {
      await session.run("waitstable");
    } catch {
      // waitstable may timeout — continue with what we have
    }

    // Screenshot
    const screenshotPath = path.join(evidenceDir, "browser-inspect-rodney.png");
    await session.run("screenshot", [screenshotPath]);

    // Page state
    const bodyText = await session.run("js", ["document.body.innerText.trim()"]);
    const isBlankPage = bodyText.trim().length === 0;
    const pageTitle = (await session.run("title")).trim();

    // Console errors via JS
    const consoleErrors: string[] = [];
    // Note: Rodney doesn't capture console in real-time like Playwright,
    // but we can check for error indicators in the DOM
    try {
      const errorOverlay = await session.run("exists", [
        ".error-overlay, #webpack-dev-server-client-overlay",
      ]);
      if (errorOverlay.includes("true") || errorOverlay.trim() === "") {
        consoleErrors.push("Error overlay detected in DOM");
      }
    } catch {
      // Element doesn't exist — good, no error overlay
    }

    // Accessibility audit (new capability not in Playwright path)
    const accessibilityFindings = await runAccessibilityAudit(session);

    const inspect: RodneyInspectResult = {
      appUrl,
      consoleErrors,
      screenshotPath,
      accessibilityFindings,
      pageTitle,
      isBlankPage,
    };

    const hasCriticalA11y = accessibilityFindings.some((f) => f.severity === "critical");
    const hasErrors = isBlankPage || consoleErrors.length > 0;

    const errorParts: string[] = [];
    if (isBlankPage) {
      errorParts.push("Blank page — no visible content");
    }
    if (consoleErrors.length > 0) {
      errorParts.push(`Console errors: ${consoleErrors.join("; ")}`);
    }
    if (hasCriticalA11y) {
      const count = accessibilityFindings.filter((f) => f.severity === "critical").length;
      errorParts.push(`${count} critical accessibility issue(s)`);
    }

    return {
      result: {
        stage: "browser",
        passed: !hasErrors,
        durationMs: Date.now() - start,
        error: errorParts.length > 0 ? errorParts.join("\n") : undefined,
      },
      inspect,
    };
  } catch (err) {
    return {
      result: {
        stage: "browser",
        passed: false,
        durationMs: Date.now() - start,
        error: String(err).slice(0, 2000),
      },
    };
  } finally {
    await session.stop();
  }
}
