import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

type Step =
  | { action: "waitFor"; selector: string; timeoutMs?: number }
  | { action: "waitForText"; text: string; timeoutMs?: number }
  | { action: "wait"; ms: number }
  | { action: "fill"; selector: string; value: string }
  | { action: "click"; selector: string }
  | { action: "press"; key: string }
  | { action: "expectText"; text: string }
  | { action: "expectUrl"; includes: string }
  | { action: "screenshot"; label: string; fullPage?: boolean };

type StepFile = {
  steps: Step[];
};

type RunReport = {
  ok: boolean;
  appUrl: string;
  outputDir: string;
  startedAt: string;
  finishedAt: string;
  checkpoints: Array<{ name: string; path: string }>;
  errors: string[];
  videoPath?: string;
};

function resolveChromePath(): string {
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
  throw new Error("No supported browser executable found. Set BROWSER_EXECUTABLE_PATH.");
}

function nowIso() {
  return new Date().toISOString();
}

function sanitizeLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

async function run() {
  const appUrl = process.env.APP_URL || "http://localhost:3010/app";
  const requiredPath = process.env.PROOF_REQUIRE_PATH || "/app";
  const enforceEntryFlow = process.env.PROOF_ENFORCE_ENTRY_FLOW !== "0";
  const entryMarkers = (
    process.env.PROOF_ENTRY_MARKERS ||
    "build your learning journey|welcome to ai tutor|sign in to continue your learning journey|question 1 of|assessment mode"
  )
    .split("|")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const outputDir = path.resolve(process.env.PROOF_OUT_DIR || `artifacts/proof/run-${Date.now()}`);
  const stepFilePath = process.env.PROOF_STEPS_FILE
    ? path.resolve(process.env.PROOF_STEPS_FILE)
    : "";
  const disallowComingSoon = process.env.ALLOW_COMING_SOON !== "1";
  const report: RunReport = {
    ok: false,
    appUrl,
    outputDir,
    startedAt: nowIso(),
    finishedAt: nowIso(),
    checkpoints: [],
    errors: [],
  };

  fs.mkdirSync(outputDir, { recursive: true });
  const screenshotsDir = path.join(outputDir, "screenshots");
  const videoDir = path.join(outputDir, "video");
  fs.mkdirSync(screenshotsDir, { recursive: true });
  fs.mkdirSync(videoDir, { recursive: true });

  const steps: Step[] = [];
  if (stepFilePath) {
    const parsed = JSON.parse(fs.readFileSync(stepFilePath, "utf8")) as StepFile;
    if (!Array.isArray(parsed.steps)) {
      throw new Error(`Invalid step file: ${stepFilePath}`);
    }
    steps.push(...parsed.steps);
  }

  const browser = await chromium.launch({
    executablePath: resolveChromePath(),
    headless: true,
    args: ["--no-default-browser-check", "--disable-features=TranslateUI"],
  });

  const context = await browser.newContext({
    viewport: { width: 1728, height: 1117 },
    recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
  });
  const page = await context.newPage();

  const checkpoint = async (name: string, fullPage = true) => {
    const file = path.join(
      screenshotsDir,
      `${String(report.checkpoints.length + 1).padStart(2, "0")}-${sanitizeLabel(name)}.png`,
    );
    await page.screenshot({ path: file, fullPage });
    report.checkpoints.push({ name, path: file });
  };

  try {
    await page.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(800);
    await checkpoint("landing");

    const html = (await page.content()).toLowerCase();
    const currentUrl = page.url();
    if (requiredPath && !currentUrl.includes(requiredPath)) {
      throw new Error(
        `Entry URL mismatch. Expected URL to include '${requiredPath}', got '${currentUrl}'`,
      );
    }
    if (disallowComingSoon && html.includes("coming soon")) {
      throw new Error(`Landing page contains 'Coming Soon' at ${appUrl}`);
    }
    if (enforceEntryFlow && steps.length === 0) {
      const hasExpectedMarker = entryMarkers.some((marker) => html.includes(marker));
      if (!hasExpectedMarker) {
        throw new Error(
          `Entry flow assertion failed. Expected auth/onboarding/question markers, got URL '${currentUrl}'.`,
        );
      }
    }

    for (const step of steps) {
      if (step.action === "waitFor") {
        await page.waitForSelector(step.selector, { timeout: step.timeoutMs ?? 20_000 });
      } else if (step.action === "waitForText") {
        await page
          .getByText(step.text, { exact: false })
          .first()
          .waitFor({ timeout: step.timeoutMs ?? 20_000 });
      } else if (step.action === "wait") {
        await page.waitForTimeout(step.ms);
      } else if (step.action === "fill") {
        await page.locator(step.selector).first().fill(step.value);
      } else if (step.action === "click") {
        await page.locator(step.selector).first().click();
      } else if (step.action === "press") {
        await page.keyboard.press(step.key);
      } else if (step.action === "expectText") {
        const visible = await page.getByText(step.text, { exact: false }).first().isVisible();
        if (!visible) {
          throw new Error(`Expected text not visible: ${step.text}`);
        }
      } else if (step.action === "expectUrl") {
        const current = page.url();
        if (!current.includes(step.includes)) {
          throw new Error(`Expected URL to include '${step.includes}', got '${current}'`);
        }
      } else if (step.action === "screenshot") {
        await checkpoint(step.label, step.fullPage ?? true);
      }
      await page.waitForTimeout(300);
    }

    if (enforceEntryFlow && steps.length > 0) {
      const postStepHtml = (await page.content()).toLowerCase();
      const hasExpectedMarker = entryMarkers.some((marker) => postStepHtml.includes(marker));
      if (!hasExpectedMarker) {
        throw new Error(
          `Entry flow assertion failed after scripted steps. Expected auth/onboarding/question markers at URL '${page.url()}'.`,
        );
      }
    }

    await checkpoint("final");
    report.ok = true;
  } catch (err) {
    report.errors.push(err instanceof Error ? err.message : String(err));
    try {
      await checkpoint("failure-state");
    } catch {
      // ignore screenshot failure
    }
  } finally {
    await context.close();
    await browser.close();
  }

  const videos = fs.readdirSync(videoDir).filter((f) => f.endsWith(".webm"));
  if (videos.length > 0) {
    report.videoPath = path.join(videoDir, videos[0] || "");
  }
  report.finishedAt = nowIso();

  const reportPath = path.join(outputDir, "proof-report.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...report, reportPath }, null, 2));
  process.exit(report.ok ? 0 : 1);
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
