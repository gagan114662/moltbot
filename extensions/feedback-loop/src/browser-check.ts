import type { FeedbackLoopBrowserConfig } from "../../../src/config/types.agent-defaults.js";
import type { TerminalStreamer } from "./terminal-stream.js";

// Import browser client functions
import { browserOpenTab, browserSnapshot, browserStatus, browserTabs } from "../../../src/browser/client.js";
import {
  browserConsoleMessages,
  browserPageErrors,
  browserRequests,
} from "../../../src/browser/client-actions-observe.js";
import {
  browserNavigate,
  browserAct,
  browserScreenshotAction,
} from "../../../src/browser/client-actions-core.js";

export type BrowserCheckResult = {
  url: string;
  status: "ok" | "error";
  errors: string[];
  consoleErrors?: string[];
  networkErrors?: string[];
  pageErrors?: string[];
  screenshotPath?: string;
  snapshot?: string;
};

export type BrowserCheckSummary = {
  passed: boolean;
  errors: string[];
  results: BrowserCheckResult[];
};

type MediaProbeEntry = {
  selector: string;
  hasSource: boolean;
  readyState: number;
  duration: number | null;
};

type MediaProbeResult = {
  audio: MediaProbeEntry[];
  video: MediaProbeEntry[];
};

// Default browser service URL (gateway)
const DEFAULT_BROWSER_URL = "http://127.0.0.1:18789";

/**
 * Run browser-based verification checks.
 * Uses the browser tool to:
 * - Navigate to configured URLs
 * - Check browser console for errors
 * - Check network for failed requests
 * - Capture DOM snapshots
 */
export async function runBrowserChecks(
  config: FeedbackLoopBrowserConfig,
  terminal: TerminalStreamer,
): Promise<BrowserCheckSummary> {
  const results: BrowserCheckResult[] = [];
  const allErrors: string[] = [];

  const urls = config.urls ?? [];
  if (urls.length === 0) {
    return { passed: true, errors: [], results: [] };
  }

  // Check if browser is available
  const browserBaseUrl = config.browserUrl ?? DEFAULT_BROWSER_URL;
  const browserProfile = config.profile ?? "openclaw";

  try {
    const status = await browserStatus(browserBaseUrl, { profile: browserProfile });
    if (!status.running) {
      terminal.log("Browser not running, falling back to HTTP checks");
      return await runHttpFallbackChecks(urls, terminal);
    }
  } catch {
    terminal.log("Browser service unavailable, falling back to HTTP checks");
    return await runHttpFallbackChecks(urls, terminal);
  }

  for (const url of urls) {
    terminal.browserCheck(url, "ok", "Checking...");

    try {
      const result = await checkUrlWithBrowser(url, browserBaseUrl, browserProfile, config);
      results.push(result);

      if (result.status === "error") {
        terminal.browserCheck(url, "error", result.errors.join("; "));
        allErrors.push(...result.errors.map((e) => `${url}: ${e}`));
      } else {
        terminal.browserCheck(url, "ok");
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      terminal.browserCheck(url, "error", error);
      results.push({
        url,
        status: "error",
        errors: [error],
      });
      allErrors.push(`${url}: ${error}`);
    }
  }

  return {
    passed: allErrors.length === 0,
    errors: allErrors,
    results,
  };
}

/**
 * Check a URL using the browser service
 */
async function checkUrlWithBrowser(
  url: string,
  browserBaseUrl: string,
  profile: string,
  config: FeedbackLoopBrowserConfig,
): Promise<BrowserCheckResult> {
  const errors: string[] = [];
  const consoleErrors: string[] = [];
  const networkErrors: string[] = [];
  const pageErrors: string[] = [];

  try {
    // Open or navigate to URL
    let targetId: string | undefined;

    // Check if there's already a tab with this URL
    const tabs = await browserTabs(browserBaseUrl, { profile });
    const existingTab = tabs.find((t) => t.url === url || t.url.startsWith(url));

    if (existingTab) {
      targetId = existingTab.targetId;
      // Refresh the page to get fresh state
      await browserNavigate(browserBaseUrl, { url, profile });
    } else {
      // Open new tab
      const newTab = await browserOpenTab(browserBaseUrl, url, { profile });
      targetId = newTab.targetId;
    }

    // Wait for page to load
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Check console for errors
    if (config.checkConsole !== false) {
      try {
        const consoleResult = await browserConsoleMessages(browserBaseUrl, {
          level: "error",
          targetId,
          profile,
        });
        for (const msg of consoleResult.messages) {
          consoleErrors.push(`[${msg.type}] ${msg.text}`);
        }
      } catch {
        // Console check failed, not critical
      }
    }

    // Check for page errors (uncaught exceptions)
    try {
      const pageErrorResult = await browserPageErrors(browserBaseUrl, {
        targetId,
        profile,
      });
      for (const err of pageErrorResult.errors) {
        pageErrors.push(err.message ?? String(err));
      }
    } catch {
      // Page errors check failed, not critical
    }

    // Check network for failed requests
    if (config.checkNetwork !== false) {
      try {
        const networkResult = await browserRequests(browserBaseUrl, {
          targetId,
          profile,
        });
        for (const req of networkResult.requests) {
          if (req.status && req.status >= 400) {
            networkErrors.push(`${req.method} ${req.url} -> ${req.status}`);
          }
          if (req.failure) {
            networkErrors.push(`${req.method} ${req.url} -> ${req.failure}`);
          }
        }
      } catch {
        // Network check failed, not critical
      }
    }

    // Get DOM snapshot for context
    let snapshot: string | undefined;
    try {
      const snapshotResult = await browserSnapshot(browserBaseUrl, {
        format: "ai",
        profile,
      });
      if (snapshotResult.ok && snapshotResult.format === "ai") {
        snapshot = snapshotResult.snapshot;
      }
    } catch {
      // Snapshot failed, not critical
    }

    // Take screenshot as proof of verification
    let screenshotPath: string | undefined;
    if (config.captureScreenshots !== false) {
      try {
        const screenshotResult = await browserScreenshotAction(browserBaseUrl, {
          targetId,
          fullPage: false, // Page viewport, not full scroll
          profile,
          type: "png",
        });
        if (screenshotResult.path) {
          screenshotPath = screenshotResult.path;
        }
      } catch {
        // Screenshot failed, not critical
      }
    }

    // Evaluate custom check if provided
    if (config.customCheck) {
      try {
        const evalResult = await browserAct(
          browserBaseUrl,
          {
            kind: "evaluate",
            fn: config.customCheck,
            targetId,
          },
          { profile },
        );
        if (evalResult.ok && evalResult.result === false) {
          errors.push("Custom check failed");
        }
      } catch (evalErr) {
        errors.push(`Custom check error: ${evalErr}`);
      }
    }

    if (config.media?.enabled) {
      try {
        const mediaProbeResult = await browserAct(
          browserBaseUrl,
          {
            kind: "evaluate",
            targetId,
            fn: buildMediaProbeFunction(config.media),
          },
          { profile },
        );
        const mediaProbe = parseMediaProbeResult(mediaProbeResult.result);
        const mediaErrors = validateMediaProbe(mediaProbe, config.media);
        errors.push(...mediaErrors);
      } catch (err) {
        const message = err instanceof Error ? err.message : "media check failed";
        errors.push(`Media check failed: ${message}`);
      }
    }

    // Compile all errors
    const allErrors = [
      ...errors,
      ...consoleErrors.map((e) => `Console: ${e}`),
      ...pageErrors.map((e) => `Page error: ${e}`),
      ...networkErrors.map((e) => `Network: ${e}`),
    ];

    return {
      url,
      status: allErrors.length > 0 ? "error" : "ok",
      errors: allErrors,
      consoleErrors: consoleErrors.length > 0 ? consoleErrors : undefined,
      networkErrors: networkErrors.length > 0 ? networkErrors : undefined,
      pageErrors: pageErrors.length > 0 ? pageErrors : undefined,
      snapshot,
      screenshotPath,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      url,
      status: "error",
      errors: [error],
    };
  }
}

function buildMediaProbeFunction(config: NonNullable<FeedbackLoopBrowserConfig["media"]>): string {
  const payload = {
    audioSelectors: config.audioSelectors ?? [],
    videoSelectors: config.videoSelectors ?? [],
  };
  return `() => {
    const cfg = ${JSON.stringify(payload)};
    const pick = (selectors, tag) => {
      if (Array.isArray(selectors) && selectors.length > 0) {
        return selectors.flatMap((selector) => {
          try {
            return Array.from(document.querySelectorAll(selector));
          } catch {
            return [];
          }
        });
      }
      return Array.from(document.querySelectorAll(tag));
    };
    const toEntry = (element, fallback) => ({
      selector: element.id ? "#" + element.id : fallback,
      hasSource: Boolean(element.currentSrc || element.src),
      readyState: Number(element.readyState ?? 0),
      duration: Number.isFinite(element.duration) ? Number(element.duration) : null,
    });
    const audio = pick(cfg.audioSelectors, "audio").map((element, index) => toEntry(element, "audio:nth-of-type(" + (index + 1) + ")"));
    const video = pick(cfg.videoSelectors, "video").map((element, index) => toEntry(element, "video:nth-of-type(" + (index + 1) + ")"));
    return { audio, video };
  }`;
}

function parseMediaProbeResult(value: unknown): MediaProbeResult {
  if (!value || typeof value !== "object") {
    return { audio: [], video: [] };
  }
  const payload = value as Record<string, unknown>;
  return {
    audio: readProbeEntries(payload.audio),
    video: readProbeEntries(payload.video),
  };
}

function readProbeEntries(value: unknown): MediaProbeEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const entry = item as Record<string, unknown>;
      return {
        selector: typeof entry.selector === "string" ? entry.selector : "media",
        hasSource: entry.hasSource === true,
        readyState: typeof entry.readyState === "number" ? entry.readyState : 0,
        duration: typeof entry.duration === "number" ? entry.duration : null,
      };
    });
}

export function validateMediaProbe(
  probe: MediaProbeResult,
  mediaConfig: NonNullable<FeedbackLoopBrowserConfig["media"]>,
): string[] {
  const errors: string[] = [];
  const required = mediaConfig.required ?? true;
  const minReadyState = mediaConfig.minReadyState ?? 1;
  const requirePlayable = mediaConfig.requirePlayable ?? true;
  const minDuration = mediaConfig.minDurationSeconds;

  const all = [...probe.audio, ...probe.video];
  if (required && all.length === 0) {
    errors.push("No audio/video elements detected for media checks.");
    return errors;
  }

  for (const entry of all) {
    if (!entry.hasSource) {
      errors.push(`Media source missing for ${entry.selector}.`);
    }
    if (entry.readyState < minReadyState) {
      errors.push(
        `Media not loaded enough for ${entry.selector} (readyState=${entry.readyState}, expected>=${minReadyState}).`,
      );
    }
    if (requirePlayable && entry.readyState < 2) {
      errors.push(`Media not playable for ${entry.selector} (readyState=${entry.readyState}).`);
    }
    if (
      typeof minDuration === "number" &&
      entry.duration !== null &&
      Number.isFinite(entry.duration) &&
      entry.duration < minDuration
    ) {
      errors.push(
        `Media duration too short for ${entry.selector} (${entry.duration}s < ${minDuration}s).`,
      );
    }
  }

  return errors;
}

/**
 * Fallback to HTTP-only checks when browser is unavailable
 */
async function runHttpFallbackChecks(
  urls: string[],
  terminal: TerminalStreamer,
): Promise<BrowserCheckSummary> {
  const results: BrowserCheckResult[] = [];
  const allErrors: string[] = [];

  for (const url of urls) {
    terminal.browserCheck(url, "ok", "HTTP check...");

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch(url, {
        signal: controller.signal,
        method: "GET",
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const error = `HTTP ${response.status}: ${response.statusText}`;
        terminal.browserCheck(url, "error", error);
        results.push({ url, status: "error", errors: [error] });
        allErrors.push(`${url}: ${error}`);
      } else {
        terminal.browserCheck(url, "ok");
        results.push({ url, status: "ok", errors: [] });
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      let userError = error;

      if (error.includes("ECONNREFUSED")) {
        userError = "Connection refused - is the server running?";
      } else if (error.includes("aborted")) {
        userError = "Request timed out after 10s";
      }

      terminal.browserCheck(url, "error", userError);
      results.push({ url, status: "error", errors: [userError] });
      allErrors.push(`${url}: ${userError}`);
    }
  }

  return {
    passed: allErrors.length === 0,
    errors: allErrors,
    results,
  };
}

/**
 * Inject console error capture script into page.
 * This can be called via browser.evaluate() to set up error capture.
 */
export const CONSOLE_CAPTURE_SCRIPT = `
(function() {
  window.__consoleErrors = [];
  window.__consoleWarnings = [];
  window.__failedRequests = [];

  // Capture console.error
  const origError = console.error;
  console.error = function(...args) {
    window.__consoleErrors.push(args.map(a => String(a)).join(' '));
    origError.apply(console, args);
  };

  // Capture console.warn
  const origWarn = console.warn;
  console.warn = function(...args) {
    window.__consoleWarnings.push(args.map(a => String(a)).join(' '));
    origWarn.apply(console, args);
  };

  // Capture failed fetch requests
  const origFetch = window.fetch;
  window.fetch = async function(...args) {
    try {
      const response = await origFetch.apply(window, args);
      if (!response.ok) {
        window.__failedRequests.push({
          url: args[0],
          status: response.status,
          statusText: response.statusText,
        });
      }
      return response;
    } catch (err) {
      window.__failedRequests.push({
        url: args[0],
        error: err.message,
      });
      throw err;
    }
  };

  // Capture unhandled errors
  window.onerror = function(msg, url, line, col, error) {
    window.__consoleErrors.push(\`\${msg} at \${url}:\${line}:\${col}\`);
  };

  // Capture unhandled promise rejections
  window.onunhandledrejection = function(event) {
    window.__consoleErrors.push(\`Unhandled rejection: \${event.reason}\`);
  };
})();
`;
