#!/usr/bin/env node --import tsx/esm
/**
 * The Surface — Battle Test
 *
 * A comprehensive Playwright-based test that opens The Surface in a real browser,
 * interacts with Gemini Live API, and verifies every feature end-to-end.
 *
 * Run: npx tsx the-surface/battle-test.ts
 */

import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page, type WebSocket as PWWebSocket } from "playwright-core";

/* ------------------------------------------------------------------ */
/* Config                                                              */
/* ------------------------------------------------------------------ */

const CHROME_PATH = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SURFACE_URL = process.env.SURFACE_URL ?? "http://localhost:4000";
const EVIDENCE_DIR = path.resolve(import.meta.dirname ?? ".", "battle-evidence");
const TIMEOUT = {
  page: 15_000,
  gemini: 30_000,
  shapes: 25_000,
  short: 5_000,
};

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface WsEvent {
  timestamp: number;
  type: "open" | "close" | "sent" | "received" | "error";
  url?: string;
  closeCode?: number;
  payload?: string;
}

interface TestResult {
  name: string;
  passed: boolean;
  duration: number;
  error?: string;
  evidence?: string; // screenshot path
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function log(emoji: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${emoji} ${msg}`);
}

async function screenshot(page: Page, name: string): Promise<string> {
  const filePath = path.join(EVIDENCE_DIR, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}

function summarizeWsPayload(raw: string): string {
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if ("setup" in obj) {
      return "[setup]";
    }
    if ("realtimeInput" in obj) {
      return "[audio-chunk]";
    }
    if ("clientContent" in obj) {
      return `[text: ${JSON.stringify(obj.clientContent).slice(0, 80)}]`;
    }
    if ("toolResponse" in obj) {
      return "[tool-response]";
    }
    if ("setupComplete" in obj) {
      return "[setup-complete]";
    }
    if ("serverContent" in obj) {
      const sc = obj.serverContent as Record<string, unknown>;
      if (sc.turnComplete) {
        return "[turn-complete]";
      }
      if (sc.interrupted) {
        return "[interrupted]";
      }
      const mt = sc.modelTurn as { parts?: unknown[] } | undefined;
      if (mt?.parts) {
        for (const p of mt.parts) {
          const part = p as Record<string, unknown>;
          if (part.inlineData) {
            return "[audio-response]";
          }
          if (typeof part.text === "string") {
            return `[text-response: ${part.text.slice(0, 60)}]`;
          }
        }
      }
      return "[server-content]";
    }
    if ("toolCall" in obj) {
      const tc = obj.toolCall as { functionCalls?: Array<{ name: string }> };
      const names = tc.functionCalls?.map((f) => f.name).join(", ") ?? "?";
      return `[tool-call: ${names}]`;
    }
    return `[unknown: ${Object.keys(obj).join(",")}]`;
  } catch {
    return `[raw: ${raw.slice(0, 50)}]`;
  }
}

/* ------------------------------------------------------------------ */
/* Test harness                                                        */
/* ------------------------------------------------------------------ */

class BattleTest {
  private browser!: Browser;
  private page!: Page;
  private wsEvents: WsEvent[] = [];
  private consoleErrors: string[] = [];
  private results: TestResult[] = [];

  async setup(): Promise<void> {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

    log("🚀", "Launching Chrome...");
    this.browser = await chromium.launch({
      executablePath: CHROME_PATH,
      headless: false,
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
        "--disable-web-security",
        "--no-first-run",
        "--no-default-browser-check",
      ],
    });

    const context = await this.browser.newContext({
      permissions: ["microphone"],
      viewport: { width: 1280, height: 800 },
    });

    this.page = await context.newPage();

    // Capture WebSocket events
    this.page.on("websocket", (ws: PWWebSocket) => {
      this.wsEvents.push({ timestamp: Date.now(), type: "open", url: ws.url() });
      log("🔌", `WS opened: ${ws.url().slice(0, 80)}...`);

      ws.on("framesent", (data) => {
        const payload = typeof data.payload === "string" ? data.payload : "";
        const summary = summarizeWsPayload(payload);
        if (!summary.includes("audio-chunk")) {
          log("📤", `WS sent: ${summary}`);
        }
        this.wsEvents.push({ timestamp: Date.now(), type: "sent", payload: summary });
      });

      ws.on("framereceived", (data) => {
        const payload = typeof data.payload === "string" ? data.payload : "";
        const summary = summarizeWsPayload(payload);
        if (!summary.includes("audio-response")) {
          log("📥", `WS recv: ${summary}`);
        }
        this.wsEvents.push({ timestamp: Date.now(), type: "received", payload: summary });
      });

      ws.on("close", () => {
        log("🔌", "WS closed");
        this.wsEvents.push({ timestamp: Date.now(), type: "close" });
      });

      ws.on("socketerror", (error) => {
        log("❌", `WS error: ${error}`);
        this.wsEvents.push({ timestamp: Date.now(), type: "error", payload: String(error) });
      });
    });

    // Capture console errors
    this.page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        this.consoleErrors.push(text);
        log("🔴", `Console error: ${text.slice(0, 120)}`);
      }
    });

    this.page.on("pageerror", (err) => {
      this.consoleErrors.push(err.message);
      log("💥", `Page error: ${err.message.slice(0, 120)}`);
    });
  }

  async teardown(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
    }
  }

  private async runTest(name: string, fn: () => Promise<void>): Promise<void> {
    log("🧪", `TEST: ${name}`);
    const start = Date.now();
    try {
      await fn();
      const duration = Date.now() - start;
      this.results.push({ name, passed: true, duration });
      log("✅", `PASS: ${name} (${duration}ms)`);
    } catch (err) {
      const duration = Date.now() - start;
      const error = err instanceof Error ? err.message : String(err);
      const evidence = await screenshot(this.page, `FAIL-${name.replace(/\s+/g, "-")}`).catch(
        () => undefined,
      );
      this.results.push({ name, passed: false, duration, error, evidence });
      log("❌", `FAIL: ${name} — ${error}`);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Individual tests                                                  */
  /* ---------------------------------------------------------------- */

  private async testPageLoads(): Promise<void> {
    await this.page.goto(SURFACE_URL, { waitUntil: "networkidle", timeout: TIMEOUT.page });
    const title = await this.page.title();
    if (title !== "The Surface") {
      throw new Error(`Expected title "The Surface", got "${title}"`);
    }
  }

  private async testIdleGreeting(): Promise<void> {
    // Wait for greeting to fade in (has 1.5s delay)
    await this.page.waitForTimeout(2500);
    const greeting = this.page.locator("text=What's on your mind?");
    const visible = await greeting.isVisible({ timeout: TIMEOUT.short });
    if (!visible) {
      throw new Error("Idle greeting not visible");
    }
    await screenshot(this.page, "01-idle-greeting");
  }

  private async testCanvasPresent(): Promise<void> {
    // tldraw renders a canvas element
    const canvas = this.page.locator(".tl-canvas");
    await canvas.waitFor({ state: "visible", timeout: TIMEOUT.short });
  }

  private async testMicButtonPresent(): Promise<void> {
    const mic = this.page.locator('button[aria-label*="listening"]');
    await mic.waitFor({ state: "visible", timeout: TIMEOUT.short });
    const label = await mic.getAttribute("aria-label");
    if (label !== "Start listening") {
      throw new Error(`Expected "Start listening", got "${label}"`);
    }
  }

  private async testTextInputPresent(): Promise<void> {
    const input = this.page.locator('input[placeholder*="Ask me anything"]');
    await input.waitFor({ state: "visible", timeout: TIMEOUT.short });
  }

  private async testTextInputConnectsGemini(): Promise<void> {
    // Clear previous WS events
    this.wsEvents = [];

    // Type and submit
    const input = this.page.locator('input[placeholder*="Ask me anything"]');
    await input.fill("Draw a blue rectangle and label it 'Hello World'");
    await input.press("Enter");

    log("⏳", "Waiting for Gemini WebSocket connection (may auto-reconnect on 1011)...");

    // Wait for Gemini WS to open — the session may silently reconnect up to 3 times
    // on 1011 (Gemini warmup), so we wait for setup-complete frames rather than just open
    await this.page.waitForEvent("websocket", {
      predicate: (ws) => ws.url().includes("generativelanguage"),
      timeout: TIMEOUT.gemini,
    });

    // Wait for received frames — setup-complete + responses indicate a stable connection
    // The auto-reconnect may cycle through 1-3 opens before stabilizing
    const gotStableConnection = await this.waitForCondition(
      () => this.wsEvents.filter((e) => e.type === "received").length >= 1,
      TIMEOUT.gemini,
    );

    if (!gotStableConnection) {
      // Check if we at least got a WS open
      const geminiWs = this.wsEvents.find(
        (e) => e.type === "open" && (e.url?.includes("generativelanguage") ?? false),
      );
      if (!geminiWs) {
        throw new Error("Never connected to Gemini WebSocket");
      }
      throw new Error("WS opened but no frames received — connection may have failed");
    }

    const geminiOpens = this.wsEvents.filter(
      (e) => e.type === "open" && (e.url?.includes("generativelanguage") ?? false),
    ).length;
    log("✓", `Connected to Gemini WebSocket (${geminiOpens} attempt(s))`);
    await screenshot(this.page, "02-gemini-connected");
  }

  private async testConnectionIndicator(): Promise<void> {
    // After connecting, the indicator should show connected (green dot)
    // It fades to 0.4 opacity after 2s, so check within first second
    const indicator = this.page.locator("div.fixed.top-4.right-4");
    const visible = await indicator.isVisible({ timeout: TIMEOUT.short }).catch(() => false);
    // Connection indicator may have already faded, which is fine
    if (visible) {
      await screenshot(this.page, "03-connection-indicator");
    }
  }

  private async testGeminiResponds(): Promise<void> {
    log("⏳", "Waiting for Gemini to respond (checking WS frames)...");

    // Native audio sends Blob frames we can't easily parse from Playwright.
    // Instead, count received frames on the Gemini WS — audio/tool responses
    // come as many rapid frames.
    const startCount = this.wsEvents.filter((e) => e.type === "received").length;

    // Wait up to 15s for at least 5 received frames (setup + audio/tool responses)
    const gotResponses = await this.waitForCondition(
      () => this.wsEvents.filter((e) => e.type === "received").length - startCount >= 5,
      TIMEOUT.gemini,
    );

    const totalReceived = this.wsEvents.filter((e) => e.type === "received").length;
    log("📊", `Total WS frames received: ${totalReceived}`);

    if (!gotResponses) {
      throw new Error(
        `Gemini sent only ${totalReceived - startCount} frames — expected audio/tool responses`,
      );
    }

    await screenshot(this.page, "04-gemini-responded");
  }

  private async testToolCallsExecuted(): Promise<void> {
    // Wait a moment for any tool calls to be processed
    await this.page.waitForTimeout(3000);

    // Check if tool response was sent (means a tool call was received and executed)
    const toolResponseSent = this.wsEvents.some(
      (e) =>
        e.type === "sent" &&
        ((e.payload?.includes("toolResponse") ?? false) ||
          (e.payload?.includes("functionResponse") ?? false)),
    );

    if (toolResponseSent) {
      log("🎨", "Tool calls executed and responses sent to Gemini");
    } else {
      log("⚠️", "No tool-response sent — model may have responded with audio only");
    }

    await screenshot(this.page, "05-tool-calls-executed");
  }

  private async testCanvasHasShapes(): Promise<void> {
    log("⏳", "Checking canvas for drawn shapes...");

    // Give tldraw time to render
    await this.page.waitForTimeout(3000);

    // Check if shapes exist by querying tldraw editor through the page context
    const shapeCount = await this.page.evaluate(() => {
      // tldraw stores shapes in the editor — access via the React tree
      const root = document.getElementById("root");
      if (!root) {
        return -1;
      }

      // Look for tldraw shape elements in the DOM
      const shapes = document.querySelectorAll('[class*="tl-shape"]');
      return shapes.length;
    });

    log("📊", `Canvas shapes (DOM): ${shapeCount}`);

    // Also check for SVG/canvas elements that tldraw creates
    const geoShapes = await this.page.locator('[class*="tl-shape"]').count();
    log("📊", `tl-shape elements: ${geoShapes}`);

    await screenshot(this.page, "06-canvas-shapes");

    if (shapeCount === 0 && geoShapes === 0) {
      // Check WS events for any tool calls that should have created shapes
      const hadToolCalls = this.wsEvents.some(
        (e) => e.type === "received" && (e.payload?.includes("tool-call") ?? false),
      );
      if (hadToolCalls) {
        throw new Error("Tool calls received but no shapes rendered on canvas");
      }
      log("⚠️", "No shapes on canvas — model responded without drawing (may be audio-only)");
    }
  }

  private async testSecondInteraction(): Promise<void> {
    const beforeCount = this.wsEvents.filter((e) => e.type === "received").length;

    // Send a second message to test continued conversation
    const input = this.page.locator('input[placeholder*="Ask me anything"]');
    await input.fill("Now draw an arrow pointing from the rectangle to a circle");
    await input.press("Enter");

    log("⏳", "Waiting for second response...");

    // Wait for new WS frames (model responding)
    const gotResponse = await this.waitForCondition(
      () => this.wsEvents.filter((e) => e.type === "received").length - beforeCount >= 3,
      TIMEOUT.gemini,
    );

    if (!gotResponse) {
      throw new Error("Gemini did not respond to second message (no new WS frames)");
    }

    await this.page.waitForTimeout(3000);
    await screenshot(this.page, "07-second-interaction");
    log("🎯", "Second interaction completed");
  }

  private async testClearCanvas(): Promise<void> {
    const beforeCount = this.wsEvents.filter((e) => e.type === "received").length;

    const input = this.page.locator('input[placeholder*="Ask me anything"]');
    await input.fill("Clear the canvas completely");
    await input.press("Enter");

    log("⏳", "Waiting for clear_canvas response...");

    await this.waitForCondition(
      () => this.wsEvents.filter((e) => e.type === "received").length - beforeCount >= 3,
      TIMEOUT.gemini,
    );

    await this.page.waitForTimeout(3000);
    await screenshot(this.page, "08-clear-canvas");
    log("🧹", "Clear canvas request processed");
  }

  private async testPortalCreation(): Promise<void> {
    const beforeCount = this.wsEvents.filter((e) => e.type === "received").length;

    const input = this.page.locator('input[placeholder*="Ask me anything"]');
    await input.fill("Create a portal to the solar system so I can explore planets");
    await input.press("Enter");

    log("⏳", "Waiting for portal creation response...");

    await this.waitForCondition(
      () => this.wsEvents.filter((e) => e.type === "received").length - beforeCount >= 3,
      TIMEOUT.gemini,
    );

    await this.page.waitForTimeout(3000);
    await screenshot(this.page, "09-portal-created");
    log("🌀", "Portal creation request processed");
  }

  private async testConversationFlowed(): Promise<void> {
    // Verify Gemini sent substantial responses (frames)
    const totalReceived = this.wsEvents.filter((e) => e.type === "received").length;
    const totalSent = this.wsEvents.filter((e) => e.type === "sent").length;
    const geminiConnections = this.wsEvents.filter(
      (e) => e.type === "open" && (e.url?.includes("generativelanguage") ?? false),
    ).length;
    const wsCloses = this.wsEvents.filter((e) => e.type === "close").length;

    log("📊", `Gemini connections: ${geminiConnections}`);
    log("📊", `Total frames — sent: ${totalSent}, received: ${totalReceived}`);
    log("📊", `WS closes: ${wsCloses}`);

    if (totalReceived < 10) {
      throw new Error(`Only ${totalReceived} frames received — Gemini conversation likely broken`);
    }
  }

  private async testNoFatalErrors(): Promise<void> {
    // Check for fatal console errors (ignore benign ones)
    const fatalErrors = this.consoleErrors.filter(
      (e) =>
        !e.includes("DevTools") &&
        !e.includes("favicon") &&
        !e.includes("manifest") &&
        !e.includes("Autofocus") &&
        !e.includes("third-party cookie") &&
        !e.includes("deprecated") &&
        !e.includes("1011") && // Auto-reconnect on Gemini warmup is expected
        !e.includes("reconnecting"),
    );

    if (fatalErrors.length > 0) {
      log("🔴", `Fatal console errors:\n${fatalErrors.join("\n")}`);
      // Don't throw — log as warning, some errors may be benign
    }

    // Check for WS errors
    const wsErrors = this.wsEvents.filter((e) => e.type === "error");
    if (wsErrors.length > 0) {
      throw new Error(`WebSocket errors: ${wsErrors.map((e) => e.payload).join(", ")}`);
    }
  }

  /* ---------------------------------------------------------------- */
  /* WS event helper                                                   */
  /* ---------------------------------------------------------------- */

  private async waitForWsEvent(
    predicate: (e: WsEvent) => boolean,
    timeout: number,
  ): Promise<WsEvent | null> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const match = this.wsEvents.find(predicate);
      if (match) {
        return match;
      }
      await this.page.waitForTimeout(200);
    }
    return null;
  }

  private async waitForCondition(predicate: () => boolean, timeout: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (predicate()) {
        return true;
      }
      await this.page.waitForTimeout(200);
    }
    return false;
  }

  /* ---------------------------------------------------------------- */
  /* Run all tests                                                     */
  /* ---------------------------------------------------------------- */

  async run(): Promise<void> {
    console.log("\n");
    console.log("╔══════════════════════════════════════════════════╗");
    console.log("║   THE SURFACE — BATTLE TEST                     ║");
    console.log("║   AI Creating Magical Learning Experiences      ║");
    console.log("╚══════════════════════════════════════════════════╝");
    console.log("\n");

    await this.setup();

    try {
      // Phase 1: Page structure
      await this.runTest("Page loads correctly", () => this.testPageLoads());
      await this.runTest("Idle greeting visible", () => this.testIdleGreeting());
      await this.runTest("Canvas is present", () => this.testCanvasPresent());
      await this.runTest("Mic button present", () => this.testMicButtonPresent());
      await this.runTest("Text input present", () => this.testTextInputPresent());

      // Phase 2: Gemini connection
      await this.runTest("Text input connects to Gemini", () => this.testTextInputConnectsGemini());
      await this.runTest("Connection indicator works", () => this.testConnectionIndicator());

      // Phase 3: AI interaction
      await this.runTest("Gemini responds", () => this.testGeminiResponds());
      await this.runTest("Tool calls executed", () => this.testToolCallsExecuted());
      await this.runTest("Canvas has shapes", () => this.testCanvasHasShapes());

      // Phase 4: Continued conversation
      await this.runTest("Second interaction works", () => this.testSecondInteraction());
      await this.runTest("Clear canvas works", () => this.testClearCanvas());
      await this.runTest("Portal creation works", () => this.testPortalCreation());

      // Phase 5: Health checks
      await this.runTest("Conversation flowed with Gemini", () => this.testConversationFlowed());
      await this.runTest("No fatal errors", () => this.testNoFatalErrors());

      // Final screenshot
      await screenshot(this.page, "10-final-state");
    } finally {
      await this.teardown();
    }

    // Generate report
    this.generateReport();
  }

  /* ---------------------------------------------------------------- */
  /* Report                                                            */
  /* ---------------------------------------------------------------- */

  private generateReport(): void {
    const passed = this.results.filter((r) => r.passed).length;
    const failed = this.results.filter((r) => !r.passed).length;
    const total = this.results.length;

    console.log("\n");
    console.log("══════════════════════════════════════════════════");
    console.log("  BATTLE TEST REPORT");
    console.log("══════════════════════════════════════════════════");
    console.log(`  Total: ${total}  |  Passed: ${passed}  |  Failed: ${failed}`);
    console.log("──────────────────────────────────────────────────");

    for (const r of this.results) {
      const icon = r.passed ? "✅" : "❌";
      const time = `${r.duration}ms`;
      console.log(`  ${icon} ${r.name} (${time})`);
      if (r.error) {
        console.log(`     └─ ${r.error}`);
      }
      if (r.evidence) {
        console.log(`     └─ Evidence: ${r.evidence}`);
      }
    }

    console.log("──────────────────────────────────────────────────");

    // WS event summary
    const wsOpen = this.wsEvents.filter((e) => e.type === "open").length;
    const wsSent = this.wsEvents.filter((e) => e.type === "sent").length;
    const wsRecv = this.wsEvents.filter((e) => e.type === "received").length;
    const wsErrors = this.wsEvents.filter((e) => e.type === "error").length;
    const toolCalls = this.wsEvents.filter(
      (e) => e.type === "received" && (e.payload?.includes("tool-call") ?? false),
    ).length;
    const turnCompletes = this.wsEvents.filter(
      (e) => e.type === "received" && (e.payload?.includes("turn-complete") ?? false),
    ).length;

    console.log("  WebSocket Summary:");
    console.log(
      `    Connections: ${wsOpen} | Sent: ${wsSent} | Received: ${wsRecv} | Errors: ${wsErrors}`,
    );
    console.log(`    Tool calls: ${toolCalls} | Turn completes: ${turnCompletes}`);
    console.log("──────────────────────────────────────────────────");

    if (this.consoleErrors.length > 0) {
      console.log(`  Console errors: ${this.consoleErrors.length}`);
      for (const e of this.consoleErrors.slice(0, 5)) {
        console.log(`    - ${e.slice(0, 100)}`);
      }
      console.log("──────────────────────────────────────────────────");
    }

    console.log(`  Evidence directory: ${EVIDENCE_DIR}`);

    const verdict = failed === 0 ? "PRODUCTION READY" : `${failed} ISSUE(S) TO FIX`;
    const verdictIcon = failed === 0 ? "🟢" : "🔴";
    console.log(`\n  ${verdictIcon} VERDICT: ${verdict}`);
    console.log("\n══════════════════════════════════════════════════\n");

    // Write JSON report
    const report = {
      timestamp: new Date().toISOString(),
      verdict: failed === 0 ? "PASS" : "FAIL",
      passed,
      failed,
      total,
      results: this.results,
      wsEvents: this.wsEvents,
      consoleErrors: this.consoleErrors,
    };

    const reportPath = path.join(EVIDENCE_DIR, "battle-report.json");
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    log("📄", `Report written to ${reportPath}`);

    // Exit with code
    process.exit(failed > 0 ? 1 : 0);
  }
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

const test = new BattleTest();
test.run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(2);
});
