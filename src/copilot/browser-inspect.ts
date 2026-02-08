/**
 * Browser inspection stage for the copilot pipeline.
 *
 * Opens the app in a headless browser, captures console errors,
 * uncaught exceptions, network failures, and a screenshot.
 * Feeds structured findings back as a StageResult so the agent
 * can fix runtime issues.
 */

import fs from "node:fs";
import path from "node:path";
import type { StageResult } from "./types.js";
import { truncateError } from "./feedback.js";
import { detectDevServer } from "./video-verify.js";

type ConsoleEntry = {
  level: "error" | "warning";
  text: string;
  url?: string;
  line?: number;
};

type NetworkFailure = {
  url: string;
  status?: number;
  statusText?: string;
  method: string;
};

type PageError = {
  message: string;
  stack?: string;
};

export type BrowserInspectResult = {
  appUrl: string;
  consoleErrors: ConsoleEntry[];
  consoleWarnings: ConsoleEntry[];
  networkFailures: NetworkFailure[];
  pageErrors: PageError[];
  screenshotPath?: string;
  pageTitle: string;
  isBlankPage: boolean;
};

/** URLs to ignore in network failure tracking */
const IGNORED_URL_PATTERNS = [
  /favicon\.ico/,
  /hot-update/,
  /\/__webpack_hmr/,
  /\/__vite_ping/,
  /\/sockjs-node\//,
  /ws:\/\//,
  /chrome-extension:/,
  /^data:/,
];

/** Console messages to ignore (dev noise) */
const IGNORED_CONSOLE_PATTERNS = [
  /Download the React DevTools/i,
  /React does not recognize the .* prop/i,
  /Warning: Each child in a list/i,
  /\[HMR\]/,
  /\[vite\]/i,
  /Hot Module Replacement/i,
  /favicon\.ico/i,
];

function shouldIgnoreUrl(url: string): boolean {
  return IGNORED_URL_PATTERNS.some((p) => p.test(url));
}

function shouldIgnoreConsole(text: string): boolean {
  return IGNORED_CONSOLE_PATTERNS.some((p) => p.test(text));
}

/** Resolve Chrome/Chromium executable path */
export function resolveChromePath(): string | undefined {
  const candidates = [
    process.env.BROWSER_EXECUTABLE_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }
  return undefined;
}

/** Format browser findings into an error string for the agent */
export function formatFindings(result: BrowserInspectResult): string {
  const lines: string[] = [];

  if (result.isBlankPage) {
    lines.push("BLANK PAGE: the app rendered no visible content");
  }

  if (result.pageErrors.length > 0) {
    lines.push(`\n${result.pageErrors.length} uncaught exception(s):`);
    for (const err of result.pageErrors.slice(0, 5)) {
      lines.push(`  ${err.message}`);
      if (err.stack) {
        const stackLines = err.stack.split("\n").slice(0, 3);
        for (const sl of stackLines) {
          lines.push(`    ${sl}`);
        }
      }
    }
  }

  if (result.consoleErrors.length > 0) {
    lines.push(`\n${result.consoleErrors.length} console error(s):`);
    for (const entry of result.consoleErrors.slice(0, 10)) {
      const loc = entry.url ? ` (${entry.url}${entry.line ? `:${entry.line}` : ""})` : "";
      lines.push(`  ${entry.text}${loc}`);
    }
  }

  if (result.consoleWarnings.length > 0) {
    lines.push(`\n${result.consoleWarnings.length} console warning(s):`);
    for (const entry of result.consoleWarnings.slice(0, 5)) {
      lines.push(`  ${entry.text}`);
    }
  }

  if (result.networkFailures.length > 0) {
    lines.push(`\n${result.networkFailures.length} network failure(s):`);
    for (const nf of result.networkFailures.slice(0, 10)) {
      const status = nf.status ? ` → ${nf.status} ${nf.statusText ?? ""}` : " → failed";
      lines.push(`  ${nf.method} ${nf.url}${status}`);
    }
  }

  return lines.join("\n");
}

/** Run browser inspection against a running dev server */
export async function runBrowserInspectStage(ctx: {
  cwd: string;
  signal: AbortSignal;
  appUrl?: string;
}): Promise<{ result: StageResult; inspect?: BrowserInspectResult }> {
  const start = Date.now();

  // Detect dev server
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

  // Resolve browser executable
  const chromePath = resolveChromePath();
  if (!chromePath) {
    return {
      result: {
        stage: "browser",
        passed: true,
        durationMs: Date.now() - start,
        error: "No browser executable found (skipped)",
      },
    };
  }

  // Lazy-import playwright-core
  let chromium: (typeof import("playwright-core"))["chromium"];
  try {
    const pw = await import("playwright-core");
    chromium = pw.chromium;
  } catch {
    return {
      result: {
        stage: "browser",
        passed: true,
        durationMs: Date.now() - start,
        error: "playwright-core not available (skipped)",
      },
    };
  }

  const consoleErrors: ConsoleEntry[] = [];
  const consoleWarnings: ConsoleEntry[] = [];
  const networkFailures: NetworkFailure[] = [];
  const pageErrors: PageError[] = [];

  const evidenceDir = path.join(ctx.cwd, ".moltbot", "evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });

  let browser;
  try {
    browser = await chromium.launch({
      executablePath: chromePath,
      headless: true,
      args: ["--no-default-browser-check", "--disable-features=TranslateUI"],
    });

    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

    // Capture console messages
    page.on("console", (msg) => {
      const type = msg.type();
      const text = msg.text();
      const location = msg.location();
      if (shouldIgnoreConsole(text) || shouldIgnoreUrl(location.url ?? "")) {
        return;
      }

      if (type === "error") {
        consoleErrors.push({
          level: "error",
          text: text.slice(0, 500),
          url: location.url || undefined,
          line: location.lineNumber || undefined,
        });
      } else if (type === "warning") {
        consoleWarnings.push({
          level: "warning",
          text: text.slice(0, 300),
          url: location.url || undefined,
          line: location.lineNumber || undefined,
        });
      }
    });

    // Capture uncaught exceptions
    page.on("pageerror", (error) => {
      pageErrors.push({
        message: error.message.slice(0, 500),
        stack: error.stack?.slice(0, 1000),
      });
    });

    // Capture failed network requests
    page.on("requestfailed", (request) => {
      const url = request.url();
      if (shouldIgnoreUrl(url)) {
        return;
      }
      networkFailures.push({
        url: url.slice(0, 200),
        method: request.method(),
      });
    });

    // Capture 4xx/5xx responses
    page.on("response", (response) => {
      const status = response.status();
      if (status >= 400) {
        const url = response.url();
        if (shouldIgnoreUrl(url)) {
          return;
        }
        networkFailures.push({
          url: url.slice(0, 200),
          status,
          statusText: response.statusText(),
          method: response.request().method(),
        });
      }
    });

    // Navigate to the app
    await page.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

    // Wait for app to settle (renders, async data loads)
    await page.waitForTimeout(3000);

    // Check for blank page
    const bodyText = await page.evaluate(() => document.body?.innerText?.trim() ?? "");
    const isBlankPage = bodyText.length === 0;
    const pageTitle = await page.title();

    // Take screenshot
    const screenshotPath = path.join(evidenceDir, "browser-inspect.png");
    await page.screenshot({ path: screenshotPath, fullPage: true });

    await page.close();

    const inspect: BrowserInspectResult = {
      appUrl,
      consoleErrors,
      consoleWarnings,
      networkFailures,
      pageErrors,
      screenshotPath,
      pageTitle,
      isBlankPage,
    };

    // Fail on: uncaught exceptions, console errors, network failures, blank page
    // Warnings are reported but don't fail
    const hasErrors =
      pageErrors.length > 0 ||
      consoleErrors.length > 0 ||
      networkFailures.length > 0 ||
      isBlankPage;

    const errorText = hasErrors ? formatFindings(inspect) : undefined;

    return {
      result: {
        stage: "browser",
        passed: !hasErrors,
        durationMs: Date.now() - start,
        error: errorText ? truncateError(errorText) : undefined,
      },
      inspect,
    };
  } catch (err) {
    if (ctx.signal.aborted) {
      return {
        result: {
          stage: "browser",
          passed: false,
          durationMs: Date.now() - start,
          error: "Cancelled",
        },
      };
    }
    return {
      result: {
        stage: "browser",
        passed: false,
        durationMs: Date.now() - start,
        error: truncateError(String(err)),
      },
    };
  } finally {
    try {
      await browser?.close();
    } catch {
      // ignore close errors
    }
  }
}
