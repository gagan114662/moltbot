/**
 * Deep UX evaluation stage for the copilot pipeline.
 *
 * Uses Playwright headless to capture browser state (screenshots, text,
 * console errors, loading times), then sends the evidence to an AI agent
 * for evaluation against acceptance criteria.
 *
 * No Chrome extension needed — runs fully autonomously.
 *
 * Used by both `/work` (autonomous fix loop) and `/qa` (standalone QA).
 */

import fs from "node:fs";
import path from "node:path";
import type { StageResult } from "./types.js";
import { agentCliCommand } from "../commands/agent-via-gateway.js";
import { defaultRuntime } from "../runtime.js";
import { resolveChromePath } from "./browser-inspect.js";
import { truncateError } from "./feedback.js";
import { detectDevServer } from "./video-verify.js";

const DEFAULT_STEPS = 10;
const DEFAULT_SAMPLE = 5;
const UX_EVAL_TIMEOUT_S = 300;
const PAGE_LOAD_TIMEOUT = 30_000;
const SETTLE_WAIT = 3000;
const LOADING_CHECK_INTERVAL = 2000;
const LOADING_MAX_WAIT = 60_000;
const STEP_TIMEOUT = 60_000;

export type UxEvalContext = {
  /** Working directory */
  cwd: string;
  /** The task / acceptance criteria to evaluate against */
  criteria: string;
  /** App URL (auto-detected if omitted) */
  appUrl?: string;
  /** Abort signal */
  signal: AbortSignal;
  /** Max interaction steps (clicks, navigations, form fills) */
  maxSteps?: number;
  /** Sample size for matrix testing */
  sample?: number;
  /** Agent ID */
  agentId?: string;
  /** Run locally (not via gateway) */
  local: boolean;
  /** Run browser in headed mode (visible window) */
  headed?: boolean;
};

export type UxFinding = {
  severity: "critical" | "major" | "minor";
  description: string;
};

export type UxEvalResult = {
  verdict: "pass" | "fail" | "partial";
  findings: UxFinding[];
  summary: string;
};

/** Parse the structured output from the UX eval agent */
export function parseUxEvalOutput(output: string): UxEvalResult {
  let verdict: UxEvalResult["verdict"] = "fail";
  const findings: UxFinding[] = [];
  let summary = "";

  // Parse VERDICT line
  const verdictMatch = output.match(/^VERDICT:\s*(pass|fail|partial)/im);
  if (verdictMatch) {
    verdict = verdictMatch[1].toLowerCase() as UxEvalResult["verdict"];
  }

  // Parse FINDING lines
  const findingRe = /^FINDING:\s*\[(critical|major|minor)]\s*-\s*(.+)$/gim;
  let match = findingRe.exec(output);
  while (match) {
    findings.push({
      severity: match[1].toLowerCase() as UxFinding["severity"],
      description: match[2].trim(),
    });
    match = findingRe.exec(output);
  }

  // Parse SUMMARY (everything after "SUMMARY:" until end or next section)
  const summaryMatch = output.match(/^SUMMARY:\s*(.+(?:\n(?!VERDICT:|FINDING:).+)*)/im);
  if (summaryMatch) {
    summary = summaryMatch[1].trim();
  }

  // If no structured output, use the raw text as summary
  if (!summary && !verdictMatch && findings.length === 0) {
    summary = output.slice(0, 1000).trim();
    // Try to infer verdict from raw text
    if (/\b(fail|broken|error|crash|hang|stuck|timeout)\b/i.test(output)) {
      verdict = "fail";
    } else if (/\b(partial|some|intermittent)\b/i.test(output)) {
      verdict = "partial";
    }
  }

  return { verdict, findings, summary };
}

/** Format UX eval result as a human-readable report */
export function formatUxReport(result: UxEvalResult): string {
  const lines: string[] = [];

  const verdictLabel =
    result.verdict === "pass"
      ? "PASS"
      : result.verdict === "partial"
        ? `PARTIAL (${result.findings.length} issue${result.findings.length !== 1 ? "s" : ""} found)`
        : `FAIL (${result.findings.length} issue${result.findings.length !== 1 ? "s" : ""} found)`;
  lines.push(`VERDICT: ${verdictLabel}`);

  if (result.findings.length > 0) {
    lines.push("");
    for (const f of result.findings) {
      lines.push(`${f.severity.toUpperCase()}: ${f.description}`);
    }
  }

  if (result.summary) {
    lines.push("", `SUMMARY: ${result.summary}`);
  }

  // Add "What to fix" section for critical/major findings
  const actionable = result.findings.filter((f) => f.severity !== "minor");
  if (actionable.length > 0) {
    lines.push("", "What to fix:");
    for (let i = 0; i < actionable.length; i++) {
      lines.push(`${i + 1}. ${actionable[i].description}`);
    }
  }

  return lines.join("\n");
}

// ── Playwright capture ────────────────────────────────────────────────

type CapturedPage = {
  url: string;
  title: string;
  bodyText: string;
  consoleErrors: string[];
  networkFailures: string[];
  loadTimeMs: number;
  stuckOnLoading: boolean;
  hasLoginGate: boolean;
  screenshotPath: string;
  interactiveElements: string[];
};

/** Extract test routes from criteria — both full URLs and bare paths */
export function extractTestRoutes(appUrl: string, criteria: string): string[] {
  const base = new URL(appUrl);
  const routes = [appUrl];

  // Parse explicit full URLs (http://localhost:5173/app) — normalize to base host/port
  for (const m of criteria.matchAll(/https?:\/\/[^\s,)]+/g)) {
    try {
      const parsed = new URL(m[0]);
      const normalized = new URL(parsed.pathname + parsed.search, base).href;
      if (!routes.includes(normalized)) {
        routes.push(normalized);
      }
    } catch {
      // skip malformed URLs
    }
  }

  // Parse bare paths: "/app", "/dashboard", "/tutor"
  for (const m of criteria.matchAll(/(?<=\s|^)(\/[\w-]+(?:\/[\w-]+)*)/g)) {
    const full = new URL(m[0], base).href;
    if (!routes.includes(full)) {
      routes.push(full);
    }
  }

  return routes;
}

/** Check if criteria imply the page should be publicly accessible (no auth) */
function impliesNoAuth(criteria: string): boolean {
  return /\b(public|no.?login|no.?auth|landing|unauthenticated|without.?login)\b/i.test(criteria);
}

/** Capture a single page state using Playwright headless */
async function capturePage(
  page: import("playwright-core").Page,
  url: string,
  evidenceDir: string,
  label: string,
): Promise<CapturedPage> {
  const consoleErrors: string[] = [];
  const networkFailures: string[] = [];

  // Listen for errors during this navigation
  const onConsole = (msg: import("playwright-core").ConsoleMessage) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text().slice(0, 300));
    }
  };
  const onRequestFailed = (req: import("playwright-core").Request) => {
    networkFailures.push(`${req.method()} ${req.url().slice(0, 200)} → failed`);
  };
  const onResponse = (res: import("playwright-core").Response) => {
    if (res.status() >= 400) {
      networkFailures.push(
        `${res.request().method()} ${res.url().slice(0, 200)} → ${res.status()}`,
      );
    }
  };

  page.on("console", onConsole);
  page.on("requestfailed", onRequestFailed);
  page.on("response", onResponse);

  const loadStart = Date.now();

  try {
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_LOAD_TIMEOUT,
    });
  } catch {
    // Navigation timeout — still capture what we can
  }

  // Wait for app to settle
  await page.waitForTimeout(SETTLE_WAIT);

  // Inject CSS to disable animations
  await page
    .addStyleTag({
      content:
        "* { animation: none !important; transition: none !important; caret-color: transparent !important; }",
    })
    .catch(() => {});

  // Check for stuck loading states (spinner, "Preparing...", "Loading...")
  let stuckOnLoading = false;
  const loadingPatterns = /preparing|loading|please wait|spinner|generating/i;

  const initialText = await page
    .evaluate(() => document.body?.innerText?.trim() ?? "")
    .catch(() => "");

  if (loadingPatterns.test(initialText)) {
    // Wait up to LOADING_MAX_WAIT for loading to resolve
    let waited = 0;
    while (waited < LOADING_MAX_WAIT) {
      await page.waitForTimeout(LOADING_CHECK_INTERVAL);
      waited += LOADING_CHECK_INTERVAL;
      const currentText = await page
        .evaluate(() => document.body?.innerText?.trim() ?? "")
        .catch(() => "");
      if (!loadingPatterns.test(currentText)) {
        break;
      }
      if (waited >= LOADING_MAX_WAIT) {
        stuckOnLoading = true;
      }
    }
  }

  const loadTimeMs = Date.now() - loadStart;

  // Capture final state
  const bodyText = await page
    .evaluate(() => document.body?.innerText?.trim() ?? "")
    .catch(() => "");
  const title = await page.title().catch(() => "");

  // Get interactive elements summary
  const interactiveElements = await page
    .evaluate(() => {
      const elements: string[] = [];
      const buttons = document.querySelectorAll("button, [role=button]");
      for (const btn of Array.from(buttons).slice(0, 20)) {
        const text = (btn as HTMLElement).innerText?.trim();
        if (text) {
          elements.push(`button: "${text.slice(0, 50)}"`);
        }
      }
      const inputs = document.querySelectorAll("input, textarea, select");
      for (const inp of Array.from(inputs).slice(0, 20)) {
        const el = inp as HTMLInputElement;
        elements.push(
          `${el.tagName.toLowerCase()}[${el.type || "text"}]: ${el.placeholder || el.name || "(unnamed)"}`,
        );
      }
      const links = document.querySelectorAll("a[href]");
      for (const link of Array.from(links).slice(0, 20)) {
        const text = (link as HTMLElement).innerText?.trim();
        if (text) {
          elements.push(
            `link: "${text.slice(0, 50)}" → ${(link as HTMLAnchorElement).href.slice(0, 80)}`,
          );
        }
      }
      return elements;
    })
    .catch(() => [] as string[]);

  // Detect login gate (password/email inputs without app content)
  const hasLoginGate = await page
    .evaluate(() => {
      const inputs = document.querySelectorAll(
        'input[type="password"], input[type="email"], input[name="password"]',
      );
      return inputs.length > 0;
    })
    .catch(() => false);

  // Take screenshot
  const safeName = label.replace(/[^a-zA-Z0-9-_]/g, "_").slice(0, 50);
  const screenshotPath = path.join(evidenceDir, `ux-eval-${safeName}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});

  // Clean up listeners
  page.removeListener("console", onConsole);
  page.removeListener("requestfailed", onRequestFailed);
  page.removeListener("response", onResponse);

  return {
    url,
    title,
    bodyText: bodyText.slice(0, 3000),
    consoleErrors,
    networkFailures,
    loadTimeMs,
    stuckOnLoading,
    hasLoginGate,
    screenshotPath,
    interactiveElements,
  };
}

/** Build evidence text from captured pages for AI evaluation */
function buildEvidenceReport(captures: CapturedPage[]): string {
  const sections: string[] = [];

  for (const cap of captures) {
    const lines: string[] = [];
    lines.push(`── Page: ${cap.url} ──`);
    lines.push(`Title: ${cap.title || "(empty)"}`);
    lines.push(`Load time: ${cap.loadTimeMs}ms`);

    if (cap.stuckOnLoading) {
      lines.push(
        `⚠ STUCK ON LOADING: Page showed loading state for >${LOADING_MAX_WAIT / 1000}s and never resolved`,
      );
    }

    if (cap.hasLoginGate) {
      lines.push("⚠ LOGIN GATE: Page shows login/signup form — app content behind auth");
    }

    if (cap.bodyText.length === 0) {
      lines.push("⚠ BLANK PAGE: No visible text content");
    } else {
      lines.push(`\nVisible text (first 3000 chars):\n${cap.bodyText}`);
    }

    if (cap.consoleErrors.length > 0) {
      lines.push(
        `\nConsole errors (${cap.consoleErrors.length}):\n${cap.consoleErrors.map((e) => `  - ${e}`).join("\n")}`,
      );
    }

    if (cap.networkFailures.length > 0) {
      lines.push(
        `\nNetwork failures (${cap.networkFailures.length}):\n${cap.networkFailures.map((e) => `  - ${e}`).join("\n")}`,
      );
    }

    if (cap.interactiveElements.length > 0) {
      lines.push(
        `\nInteractive elements:\n${cap.interactiveElements.map((e) => `  - ${e}`).join("\n")}`,
      );
    }

    lines.push(`Screenshot: ${cap.screenshotPath}`);
    sections.push(lines.join("\n"));
  }

  return sections.join("\n\n");
}

function buildEvalPrompt(criteria: string, evidence: string, sample: number): string {
  return [
    "You are a QA engineer evaluating a web app against acceptance criteria.",
    "Below is the CAPTURED EVIDENCE from the app (page text, errors, timing, elements).",
    "Evaluate HONESTLY — does the actual user experience match what was promised?",
    "",
    "ACCEPTANCE CRITERIA:",
    criteria,
    "",
    "CAPTURED EVIDENCE:",
    evidence,
    "",
    "Instructions:",
    "1. Compare the captured page text against what the criteria promise",
    "2. Check for loading issues, stuck states, timeouts",
    "3. Check for error messages, console errors, network failures",
    "4. Evaluate if content is appropriate (e.g., age-appropriate questions)",
    "5. Be SPECIFIC about what works and what doesn't",
    `6. If criteria mention a matrix (ages/topics/etc), evaluate the ${sample} sampled combos`,
    "",
    "Report format (use EXACTLY this structure):",
    "VERDICT: pass|fail|partial",
    "FINDING: [critical|major|minor] - <description>",
    "FINDING: [critical|major|minor] - <description>",
    "SUMMARY: <plain-English honest assessment>",
    "",
    "CRITICAL = crashes, hangs >60s, broken flows, missing core functionality",
    "MAJOR = wrong content, poor UX, accessibility failures, slow loads >10s",
    "MINOR = visual glitches, alignment, non-blocking cosmetic issues",
  ].join("\n");
}

/** Run deep UX evaluation stage */
export async function runUxEvalStage(
  ctx: UxEvalContext,
): Promise<StageResult & { uxResult?: UxEvalResult }> {
  const start = Date.now();
  const maxSteps = ctx.maxSteps ?? DEFAULT_STEPS;
  const sample = ctx.sample ?? DEFAULT_SAMPLE;

  // Detect app URL
  const appUrl = ctx.appUrl ?? (await detectDevServer());
  if (!appUrl) {
    return {
      stage: "ux-eval",
      passed: true,
      durationMs: Date.now() - start,
      error: "No dev server detected (skipped)",
    };
  }

  // Resolve browser
  const chromePath = resolveChromePath();
  if (!chromePath) {
    return {
      stage: "ux-eval",
      passed: true,
      durationMs: Date.now() - start,
      error: "No browser executable found (skipped)",
    };
  }

  let chromium: (typeof import("playwright-core"))["chromium"];
  try {
    const pw = await import("playwright-core");
    chromium = pw.chromium;
  } catch {
    return {
      stage: "ux-eval",
      passed: true,
      durationMs: Date.now() - start,
      error: "playwright-core not available (skipped)",
    };
  }

  const evidenceDir = path.join(ctx.cwd, ".moltbot", "evidence");
  fs.mkdirSync(evidenceDir, { recursive: true });

  let browser: import("playwright-core").Browser | undefined;

  try {
    browser = await chromium.launch({
      executablePath: chromePath,
      headless: !ctx.headed,
      args: ["--no-default-browser-check", "--disable-features=TranslateUI"],
      slowMo: ctx.headed ? 300 : 0,
    });

    const page = await browser.newPage({
      viewport: { width: 1280, height: 720 },
    });

    const captures: CapturedPage[] = [];

    // Step 1: Navigate to each route extracted from criteria
    const routes = extractTestRoutes(appUrl, ctx.criteria);
    let stepsUsed = 0;

    for (const route of routes) {
      if (ctx.signal.aborted || stepsUsed >= maxSteps) {
        break;
      }
      stepsUsed++;

      const stepStart = Date.now();
      const label = stepsUsed === 1 ? "main" : `route-${stepsUsed}-${new URL(route).pathname}`;
      const cap = await capturePage(page, route, evidenceDir, label);
      captures.push(cap);

      // Per-step 60s hard timebox
      if (Date.now() - stepStart > STEP_TIMEOUT) {
        break;
      }
    }

    // Step 2: If we have budget left, click interesting elements on the last captured page
    if (stepsUsed < maxSteps && !ctx.signal.aborted) {
      const clickTargets = await page
        .evaluate(() => {
          const targets: Array<{ text: string }> = [];
          const clickables = document.querySelectorAll("button, a[href], [role=button], [onclick]");
          for (const el of Array.from(clickables).slice(0, 30)) {
            const text = (el as HTMLElement).innerText?.trim() ?? "";
            if (text && text.length < 100 && !text.match(/^(close|cancel|dismiss|x)$/i)) {
              targets.push({ text });
            }
          }
          return targets;
        })
        .catch(() => [] as Array<{ text: string }>);

      const sampled = clickTargets.slice(0, Math.min(sample, maxSteps - stepsUsed));
      for (const target of sampled) {
        if (ctx.signal.aborted) {
          break;
        }
        stepsUsed++;

        try {
          const locator = page.getByText(target.text, { exact: false }).first();
          const isVisible = await locator.isVisible().catch(() => false);
          if (isVisible) {
            await locator.click({ timeout: 5000 });
            await page.waitForTimeout(SETTLE_WAIT);

            const stepCapture = await capturePage(
              page,
              page.url(),
              evidenceDir,
              `step-${stepsUsed}-${target.text.slice(0, 20)}`,
            );
            captures.push(stepCapture);
          }
        } catch {
          // Click failed, continue
        }
      }
    }

    await page.close();

    // Step 3: Send evidence to AI for evaluation
    const evidence = buildEvidenceReport(captures);
    const evalPrompt = buildEvalPrompt(ctx.criteria, evidence, sample);

    // Quick programmatic pre-check — find obvious failures
    const noAuth = impliesNoAuth(ctx.criteria);
    const preFindings: UxFinding[] = [];
    for (const cap of captures) {
      if (cap.stuckOnLoading) {
        preFindings.push({
          severity: "critical",
          description: `${cap.url} stuck on loading state for >${LOADING_MAX_WAIT / 1000}s`,
        });
      }
      if (cap.bodyText.length === 0) {
        preFindings.push({
          severity: "critical",
          description: `${cap.url} rendered a blank page`,
        });
      }
      if (cap.hasLoginGate) {
        preFindings.push({
          severity: noAuth ? "critical" : "major",
          description: noAuth
            ? `${cap.url} shows login page but criteria expect public/no-auth access`
            : `${cap.url} login gate blocks UX eval — cannot test app behind auth`,
        });
      }
      if (cap.loadTimeMs > 10_000 && !cap.stuckOnLoading) {
        preFindings.push({
          severity: "major",
          description: `${cap.url} took ${(cap.loadTimeMs / 1000).toFixed(1)}s to load`,
        });
      }
      for (const err of cap.consoleErrors.slice(0, 3)) {
        preFindings.push({
          severity: "major",
          description: `Console error on ${cap.url}: ${err.slice(0, 100)}`,
        });
      }
    }

    // Send to AI agent for deep evaluation (uses gateway model, not API key)
    let aiText = "";
    try {
      const sessionId = `ux-eval-${Date.now()}`;
      const response = await agentCliCommand(
        {
          message: evalPrompt,
          agent: ctx.agentId,
          sessionId,
          thinking: "low",
          timeout: String(UX_EVAL_TIMEOUT_S),
          local: ctx.local,
          json: true,
        },
        defaultRuntime,
      );

      const result = response as
        | {
            result?: { payloads?: Array<{ text?: string }> };
            summary?: string;
          }
        | undefined;
      aiText =
        result?.result?.payloads
          ?.map((p) => p.text)
          .filter(Boolean)
          .join("\n") ??
        result?.summary ??
        "";
    } catch {
      // AI eval failed — fall back to programmatic findings only
    }

    // Merge AI findings with programmatic pre-check
    let uxResult: UxEvalResult;
    if (aiText) {
      uxResult = parseUxEvalOutput(aiText);
      // Add any programmatic findings the AI missed
      for (const pf of preFindings) {
        const alreadyFound = uxResult.findings.some((f) =>
          f.description.toLowerCase().includes(pf.description.slice(0, 30).toLowerCase()),
        );
        if (!alreadyFound) {
          uxResult.findings.push(pf);
        }
      }
      // If programmatic checks found critical issues but AI said pass, override
      if (uxResult.verdict === "pass" && preFindings.some((f) => f.severity === "critical")) {
        uxResult.verdict = "fail";
      }
    } else {
      // No AI response — use programmatic findings only
      const hasCritical = preFindings.some((f) => f.severity === "critical");
      const hasMajor = preFindings.some((f) => f.severity === "major");
      uxResult = {
        verdict: hasCritical ? "fail" : hasMajor ? "partial" : "pass",
        findings: preFindings,
        summary:
          preFindings.length > 0
            ? `Programmatic check found ${preFindings.length} issue(s). AI evaluation unavailable.`
            : "Page loaded successfully. AI evaluation unavailable for deep content check.",
      };
    }

    const passed = uxResult.verdict === "pass";

    return {
      stage: "ux-eval",
      passed,
      durationMs: Date.now() - start,
      error: !passed ? formatUxReport(uxResult) : undefined,
      uxResult,
    };
  } catch (err) {
    if (ctx.signal.aborted) {
      return {
        stage: "ux-eval",
        passed: false,
        durationMs: Date.now() - start,
        error: "Cancelled",
      };
    }
    return {
      stage: "ux-eval",
      passed: false,
      durationMs: Date.now() - start,
      error: truncateError(`UX eval failed: ${String(err)}`),
    };
  } finally {
    try {
      await browser?.close();
    } catch {
      // ignore close errors
    }
  }
}
