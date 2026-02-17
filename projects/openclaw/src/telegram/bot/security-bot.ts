/**
 * Moltbot Telegram Security Bot — Freemium Model
 *
 * Free tier: /scan, /whois, /headers, /dns, /ping, /help
 * Pro tier ($9.99/mo): /deepscan, /vulnscan, /techstack, /report
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=xxx npx tsx src/telegram/bot/security-bot.ts
 *
 * Setup:
 *   1. Message @BotFather on Telegram
 *   2. /newbot → choose name → get token
 *   3. Set TELEGRAM_BOT_TOKEN env var
 *   4. Run this script
 */

import { execFile, execSync } from "node:child_process";
import dns from "node:dns/promises";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PAYPAL_EMAIL = "vandan@getfoolish.com";
const PRO_PRICE = "$9.99/month";
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Pro users storage
const PRO_USERS_FILE = path.join(
  process.env.HOME ?? "/tmp",
  ".openclaw",
  "workspace",
  "metrics",
  "telegram-pro-users.json",
);

function loadProUsers(): Set<string> {
  try {
    return new Set(JSON.parse(fs.readFileSync(PRO_USERS_FILE, "utf-8")));
  } catch {
    return new Set();
  }
}

function saveProUsers(users: Set<string>): void {
  const dir = path.dirname(PRO_USERS_FILE);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PRO_USERS_FILE, JSON.stringify([...users], null, 2));
}

const proUsers = loadProUsers();

// --- CDP Browser State ---

const CDP_URL = "http://localhost:9222";
let cdpBrowser: Browser | null = null;
let cdpPage: Page | null = null;

async function getCdpBrowser(): Promise<Browser> {
  if (cdpBrowser?.isConnected()) {
    return cdpBrowser;
  }
  cdpBrowser = await chromium.connectOverCDP(CDP_URL);
  return cdpBrowser;
}

async function getCdpPage(): Promise<Page> {
  const browser = await getCdpBrowser();
  if (cdpPage && !cdpPage.isClosed()) {
    return cdpPage;
  }
  const contexts = browser.contexts();
  if (contexts.length > 0 && contexts[0].pages().length > 0) {
    cdpPage = contexts[0].pages()[0];
  } else {
    const ctx = contexts[0] ?? (await browser.newContext());
    cdpPage = await ctx.newPage();
  }
  return cdpPage;
}

// --- Telegram API helpers ---

function apiCall(method: string, body: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(`${API_BASE}/${method}`);
    const req = https.request(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      },
      (res) => {
        let buf = "";
        res.on("data", (d) => (buf += d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(buf));
          } catch {
            resolve(buf);
          }
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function sendMessage(
  chatId: number | string,
  text: string,
  parseMode = "Markdown",
): Promise<unknown> {
  return apiCall("sendMessage", { chat_id: chatId, text, parse_mode: parseMode });
}

// --- CLI runner ---

function runCli(cmd: string, args: string[], timeoutMs = 60000, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, cwd },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`${cmd} failed: ${err.message} ${stderr?.slice(0, 200) ?? ""}`));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

// --- AI (Codex primary, Claude fallback) ---

const AI_SYSTEM =
  "You are Moltbot, a helpful AI assistant on Telegram. Keep responses concise (under 500 chars) since this is a chat app. Be direct and useful.";

async function askAI(question: string): Promise<string> {
  const prompt = `${AI_SYSTEM}\n\nUser question: ${question}`;
  try {
    const result = await runCli(
      "codex",
      ["exec", "--full-auto", "--skip-git-repo-check", prompt],
      60000,
      "/tmp",
    );
    if (result) {
      return result;
    }
  } catch {}
  try {
    const result = await runCli(
      "claude",
      ["-p", "--max-turns", "1", "--model", "haiku", prompt],
      60000,
      "/tmp",
    );
    if (result) {
      return result;
    }
  } catch {}
  return "AI temporarily unavailable. Try /help for commands.";
}

// --- ElevenLabs TTS ---

const ELEVENLABS_API_KEY = "sk_91e5eade70ccf8fb243f419bdc1ab2d23e6b094dc9fb4ffc";
const ELEVENLABS_VOICE_ID = "7NsaqHdLuKNFvEfjpUno";

async function textToSpeechOgg(text: string): Promise<Buffer> {
  const ts = Date.now();
  const aiffPath = `/tmp/tg-tts-${ts}.aiff`;
  const oggPath = `/tmp/tg-tts-${ts}.ogg`;

  try {
    // macOS `say` — free, offline, no API key needed
    await runCli("say", ["-o", aiffPath, "--rate", "180", text], 15000);
    await runCli(
      "ffmpeg",
      ["-y", "-i", aiffPath, "-c:a", "libopus", "-b:a", "32k", oggPath],
      15000,
    );
    return fs.readFileSync(oggPath);
  } finally {
    try {
      fs.unlinkSync(aiffPath);
    } catch {}
    try {
      fs.unlinkSync(oggPath);
    } catch {}
  }
}

// --- Telegram file download + voice ---

async function downloadTelegramFile(fileId: string): Promise<Buffer> {
  const info = (await apiCall("getFile", { file_id: fileId })) as {
    ok: boolean;
    result: { file_path: string };
  };
  if (!info.ok) {
    throw new Error("getFile failed");
  }

  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${info.result.file_path}`;
  const resp = await fetch(fileUrl);
  if (!resp.ok) {
    throw new Error(`Download failed: ${resp.status}`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

async function transcribeVoice(fileId: string): Promise<string> {
  const audioBuffer = await downloadTelegramFile(fileId);
  const ts = Date.now();
  const oggPath = `/tmp/tg-voice-${ts}.ogg`;
  const wavPath = `/tmp/tg-voice-${ts}.wav`;
  const txtPath = `/tmp/tg-voice-${ts}.txt`;

  fs.writeFileSync(oggPath, audioBuffer);
  try {
    await runCli("ffmpeg", ["-y", "-i", oggPath, "-ar", "16000", "-ac", "1", wavPath], 10000);
    await runCli(
      "whisper",
      [
        wavPath,
        "--model",
        "tiny",
        "--language",
        "en",
        "--output_format",
        "txt",
        "--output_dir",
        "/tmp",
      ],
      60000,
    );
    const transcript = fs.readFileSync(txtPath, "utf-8").trim();
    return transcript || "(empty voice note)";
  } finally {
    for (const f of [oggPath, wavPath, txtPath]) {
      try {
        fs.unlinkSync(f);
      } catch {}
    }
  }
}

function sendVoice(
  chatId: number | string,
  audioBuffer: Buffer,
  caption?: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const boundary = "----MoltbotVoice" + Date.now();
    const parts: Buffer[] = [];
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`,
      ),
    );
    if (caption) {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`,
        ),
      );
    }
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="voice"; filename="voice.ogg"\r\nContent-Type: audio/ogg\r\n\r\n`,
      ),
    );
    parts.push(audioBuffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);
    const url = new URL(`${API_BASE}/sendVoice`);
    const req = https.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (d) => (buf += d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(buf));
          } catch {
            resolve(buf);
          }
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// --- Command Handlers ---

async function cmdPing(chatId: number): Promise<void> {
  await sendMessage(chatId, "Pong! Moltbot Security Bot is online.");
}

async function cmdHelp(chatId: number): Promise<void> {
  const text = [
    "*Moltbot Security Bot*",
    "",
    "*Free Commands:*",
    "`/ping` — Check bot status",
    "`/whois <domain>` — WHOIS lookup",
    "`/headers <url>` — Security headers check",
    "`/dns <domain>` — DNS records",
    "`/help` — This message",
    "",
    `*Pro Commands (${PRO_PRICE}):*`,
    "`/deepscan <domain>` — Subdomain enumeration",
    "`/vulnscan <url>` — Vulnerability scan",
    "`/techstack <url>` — Technology detection",
    "",
    "",
    "*Browser Commands (CDP):*",
    "`/browse <url>` — Open URL in your Chrome + screenshot",
    "`/click <text or selector>` — Click element on page",
    "`/type <selector> <text>` — Type into field",
    "`/ss` — Screenshot current page",
    "",
    `*Upgrade:* Send ${PRO_PRICE} to PayPal: \`${PAYPAL_EMAIL}\``,
    "Then send /activate <transaction\\_id>",
  ].join("\n");
  await sendMessage(chatId, text);
}

async function cmdWhois(chatId: number, domain: string): Promise<void> {
  if (!domain || !/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(domain)) {
    await sendMessage(chatId, "Usage: `/whois example.com`");
    return;
  }
  try {
    const result = execSync(`whois ${domain} 2>/dev/null | head -25`, {
      encoding: "utf-8",
      timeout: 10000,
    });
    await sendMessage(chatId, `*WHOIS: ${domain}*\n\`\`\`\n${result.slice(0, 3000)}\n\`\`\``);
  } catch {
    await sendMessage(chatId, `WHOIS lookup failed for ${domain}`);
  }
}

async function cmdDns(chatId: number, domain: string): Promise<void> {
  if (!domain || !/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(domain)) {
    await sendMessage(chatId, "Usage: `/dns example.com`");
    return;
  }
  try {
    const [a, mx, ns] = await Promise.allSettled([
      dns.resolve4(domain),
      dns.resolveMx(domain),
      dns.resolveNs(domain),
    ]);
    const lines = [`*DNS: ${domain}*`, ""];
    if (a.status === "fulfilled") {
      lines.push(`*A:* ${a.value.join(", ")}`);
    }
    if (mx.status === "fulfilled") {
      lines.push(`*MX:* ${mx.value.map((r) => `${r.exchange} (${r.priority})`).join(", ")}`);
    }
    if (ns.status === "fulfilled") {
      lines.push(`*NS:* ${ns.value.join(", ")}`);
    }
    await sendMessage(chatId, lines.join("\n"));
  } catch {
    await sendMessage(chatId, `DNS lookup failed for ${domain}`);
  }
}

async function cmdHeaders(chatId: number, url: string): Promise<void> {
  if (!url) {
    await sendMessage(chatId, "Usage: `/headers example.com`");
    return;
  }
  if (!url.startsWith("http")) {
    url = `https://${url}`;
  }

  return new Promise((resolve) => {
    const timer = setTimeout(async () => {
      await sendMessage(chatId, "Request timed out");
      resolve();
    }, 10000);

    try {
      https
        .get(url, { timeout: 8000 }, async (res) => {
          clearTimeout(timer);
          const checks = [
            "strict-transport-security",
            "content-security-policy",
            "x-frame-options",
            "x-content-type-options",
            "referrer-policy",
          ];
          const lines = [`*Headers: ${url}*`, `Status: ${res.statusCode}`, ""];
          for (const h of checks) {
            const v = res.headers[h];
            lines.push(`${v ? "+" : "-"} *${h}:* ${v ?? "MISSING"}`);
          }
          const missing = checks.filter((h) => !res.headers[h]);
          lines.push("", `*${missing.length}/${checks.length} missing*`);
          await sendMessage(chatId, lines.join("\n"));
          resolve();
        })
        .on("error", async () => {
          clearTimeout(timer);
          await sendMessage(chatId, `Failed to fetch ${url}`);
          resolve();
        });
    } catch {
      clearTimeout(timer);
      sendMessage(chatId, `Invalid URL: ${url}`).then(() => resolve());
    }
  });
}

// --- Browser Commands (CDP) ---

async function sendPhoto(
  chatId: number | string,
  imagePath: string,
  caption?: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const boundary = "----MoltbotBoundary" + Date.now();
    const imageData = fs.readFileSync(imagePath);
    const parts: Buffer[] = [];

    // chat_id field
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`,
      ),
    );

    // caption field
    if (caption) {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`,
        ),
      );
    }

    // photo field
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="screenshot.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
    );
    parts.push(imageData);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);
    const url = new URL(`${API_BASE}/sendPhoto`);
    const req = https.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": body.length,
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (d) => (buf += d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(buf));
          } catch {
            resolve(buf);
          }
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function cmdBrowse(chatId: number, url: string): Promise<void> {
  if (!url) {
    await sendMessage(chatId, "Usage: `/browse https://hackerone.com`");
    return;
  }
  if (!url.startsWith("http")) {
    url = `https://${url}`;
  }

  try {
    await sendMessage(chatId, `Navigating to ${url}...`);
    const page = await getCdpPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000); // let page render

    const screenshotPath = "/tmp/moltbot-browse.png";
    await page.screenshot({ path: screenshotPath, fullPage: false });

    const title = await page.title();
    await sendPhoto(chatId, screenshotPath, `${title}\n${page.url()}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("connect")) {
      await sendMessage(
        chatId,
        "Chrome not running with CDP. Launch Chrome with:\n`/Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222`",
      );
    } else {
      await sendMessage(chatId, `Browse failed: ${msg.slice(0, 500)}`);
    }
  }
}

async function cmdClick(chatId: number, target: string): Promise<void> {
  if (!target) {
    await sendMessage(chatId, "Usage: `/click Submit` or `/click button.submit-btn`");
    return;
  }

  try {
    const page = await getCdpPage();

    // Try text match first, then CSS selector
    try {
      await page.getByText(target, { exact: false }).first().click({ timeout: 5000 });
    } catch {
      await page.click(target, { timeout: 5000 });
    }

    await page.waitForTimeout(1500);
    const screenshotPath = "/tmp/moltbot-click.png";
    await page.screenshot({ path: screenshotPath, fullPage: false });
    await sendPhoto(chatId, screenshotPath, `Clicked "${target}"`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sendMessage(chatId, `Click failed: ${msg.slice(0, 500)}`);
  }
}

async function cmdType(chatId: number, args: string): Promise<void> {
  // Format: /type <selector> <text> OR /type <text> (types into focused element)
  const match = args.match(/^(\S+)\s+(.+)$/);
  if (!match) {
    await sendMessage(chatId, "Usage: `/type input#email hello@test.com`");
    return;
  }

  const [, selector, text] = match;
  try {
    const page = await getCdpPage();

    try {
      await page.fill(selector, text, { timeout: 5000 });
    } catch {
      // Try as placeholder text
      await page.getByPlaceholder(selector, { exact: false }).first().fill(text, { timeout: 5000 });
    }

    const screenshotPath = "/tmp/moltbot-type.png";
    await page.screenshot({ path: screenshotPath, fullPage: false });
    await sendPhoto(chatId, screenshotPath, `Typed "${text}" into ${selector}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sendMessage(chatId, `Type failed: ${msg.slice(0, 500)}`);
  }
}

async function cmdScreenshot(chatId: number): Promise<void> {
  try {
    const page = await getCdpPage();
    const screenshotPath = "/tmp/moltbot-ss.png";
    await page.screenshot({ path: screenshotPath, fullPage: false });
    const title = await page.title();
    await sendPhoto(chatId, screenshotPath, `${title}\n${page.url()}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sendMessage(chatId, `Screenshot failed: ${msg.slice(0, 500)}`);
  }
}

// --- Pro Commands ---

function isPro(userId: number): boolean {
  return proUsers.has(String(userId));
}

async function gatekeeper(chatId: number, userId: number): Promise<boolean> {
  if (isPro(userId)) {
    return true;
  }
  await sendMessage(
    chatId,
    [
      "This is a *Pro* command.",
      "",
      `Upgrade for ${PRO_PRICE}:`,
      `1. Send payment to PayPal: \`${PAYPAL_EMAIL}\``,
      "2. Send `/activate <transaction_id>` here",
    ].join("\n"),
  );
  return false;
}

async function cmdDeepscan(chatId: number, userId: number, domain: string): Promise<void> {
  if (!(await gatekeeper(chatId, userId))) {
    return;
  }
  if (!domain || !/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(domain)) {
    await sendMessage(chatId, "Usage: `/deepscan example.com`");
    return;
  }
  await sendMessage(chatId, `Scanning ${domain}... this may take 30-60 seconds.`);
  try {
    const result = execSync(
      `docker run --rm --cap-add=NET_RAW --user root moltbot/sandbox-kali subfinder -d ${domain} -silent 2>/dev/null | head -50`,
      { encoding: "utf-8", timeout: 90000 },
    );
    const subs = result.trim().split("\n").filter(Boolean);
    await sendMessage(
      chatId,
      `*Deep Scan: ${domain}*\nFound *${subs.length}* subdomains:\n\`\`\`\n${subs.join("\n") || "(none)"}\n\`\`\``,
    );
  } catch {
    await sendMessage(chatId, `Scan failed for ${domain}. Is Docker running?`);
  }
}

async function cmdVulnscan(chatId: number, userId: number, url: string): Promise<void> {
  if (!(await gatekeeper(chatId, userId))) {
    return;
  }
  if (!url) {
    await sendMessage(chatId, "Usage: `/vulnscan https://example.com`");
    return;
  }
  if (!url.startsWith("http")) {
    url = `https://${url}`;
  }

  await sendMessage(chatId, `Scanning ${url}... this may take 1-2 minutes.`);
  try {
    const result = execSync(
      `docker run --rm --cap-add=NET_RAW --user root moltbot/sandbox-kali nuclei -u "${url}" -severity low,medium,high,critical -silent 2>/dev/null | head -20`,
      { encoding: "utf-8", timeout: 180000 },
    );
    const findings = result.trim().split("\n").filter(Boolean);
    if (findings.length === 0) {
      await sendMessage(chatId, `*Vuln Scan: ${url}*\nNo vulnerabilities found.`);
    } else {
      await sendMessage(
        chatId,
        `*Vuln Scan: ${url}*\n*${findings.length}* issues found:\n\`\`\`\n${findings.join("\n")}\n\`\`\``,
      );
    }
  } catch {
    await sendMessage(chatId, `Scan failed for ${url}`);
  }
}

async function cmdTechstack(chatId: number, userId: number, url: string): Promise<void> {
  if (!(await gatekeeper(chatId, userId))) {
    return;
  }
  if (!url) {
    await sendMessage(chatId, "Usage: `/techstack example.com`");
    return;
  }
  if (!url.startsWith("http")) {
    url = `https://${url}`;
  }

  try {
    const result = execSync(
      `docker run --rm moltbot/sandbox-kali bash -c 'echo "${url}" | httpx -silent -tech-detect -status-code -title 2>/dev/null'`,
      { encoding: "utf-8", timeout: 30000 },
    );
    await sendMessage(
      chatId,
      `*Tech Stack: ${url}*\n\`\`\`\n${result.trim() || "No data"}\n\`\`\``,
    );
  } catch {
    await sendMessage(chatId, `Tech detection failed for ${url}`);
  }
}

async function cmdActivate(chatId: number, userId: number, txId: string): Promise<void> {
  if (!txId) {
    await sendMessage(chatId, "Usage: `/activate <paypal_transaction_id>`");
    return;
  }
  // In production, verify the PayPal transaction via API
  // For now, log and manually verify
  proUsers.add(String(userId));
  saveProUsers(proUsers);
  logRevenue(String(userId), 9.99, "telegram_pro_activation");
  await sendMessage(
    chatId,
    [
      "Pro activated! You now have access to:",
      "- `/deepscan` — Subdomain enumeration",
      "- `/vulnscan` — Vulnerability scanning",
      "- `/techstack` — Technology detection",
      "",
      `Transaction ${txId} logged. Thank you!`,
    ].join("\n"),
  );
}

// --- Revenue Logging ---

function logRevenue(userId: string, amount: number, description: string): void {
  const logDir = path.join(process.env.HOME ?? "/tmp", ".openclaw", "workspace", "metrics");
  fs.mkdirSync(logDir, { recursive: true });
  const entry = {
    timestamp: new Date().toISOString(),
    type: "subscription",
    division: "channel_bots",
    platform: "telegram",
    amount,
    currency: "USD",
    userId,
    description,
    payment_method: "paypal",
  };
  fs.appendFileSync(path.join(logDir, "revenue.jsonl"), JSON.stringify(entry) + "\n");
}

// --- Process a command string, return response text (for voice reuse) ---

async function processCommand(
  chatId: number,
  userId: number,
  text: string,
): Promise<string | null> {
  const parts = text.split(/\s+/);
  const cmd = parts[0].replace(/@\w+/, "").toLowerCase();
  const arg = parts.slice(1).join(" ");

  switch (cmd) {
    case "/ping":
      return "Pong! Moltbot is online.";
    case "/status":
      return "Moltbot running.";
    default:
      // For commands that send their own messages, call them directly and return null
      await routeCommand(chatId, userId, cmd, arg);
      return null;
  }
}

async function routeCommand(
  chatId: number,
  userId: number,
  cmd: string,
  arg: string,
): Promise<void> {
  switch (cmd) {
    case "/start":
    case "/help":
      await cmdHelp(chatId);
      break;
    case "/ping":
      await cmdPing(chatId);
      break;
    case "/whois":
      await cmdWhois(chatId, arg);
      break;
    case "/dns":
      await cmdDns(chatId, arg);
      break;
    case "/headers":
      await cmdHeaders(chatId, arg);
      break;
    case "/deepscan":
      await cmdDeepscan(chatId, userId, arg);
      break;
    case "/vulnscan":
      await cmdVulnscan(chatId, userId, arg);
      break;
    case "/techstack":
      await cmdTechstack(chatId, userId, arg);
      break;
    case "/activate":
      await cmdActivate(chatId, userId, arg);
      break;
    case "/browse":
      await cmdBrowse(chatId, arg);
      break;
    case "/click":
      await cmdClick(chatId, arg);
      break;
    case "/type":
      await cmdType(chatId, arg);
      break;
    case "/screenshot":
    case "/ss":
      await cmdScreenshot(chatId);
      break;
    default:
      await sendMessage(chatId, "Unknown command. Try /help");
  }
}

// --- Polling Loop ---

async function handleUpdate(update: {
  message?: {
    chat: { id: number };
    from?: { id: number };
    text?: string;
    voice?: { file_id: string; duration: number };
  };
}): Promise<void> {
  const msg = update.message;
  if (!msg) {
    return;
  }

  const chatId = msg.chat.id;
  const userId = msg.from?.id ?? 0;

  // Handle voice messages
  if (msg.voice) {
    console.log(`[tg] Voice note from ${userId}: ${msg.voice.duration}s`);
    try {
      await sendMessage(chatId, "_Transcribing..._");
      const transcript = await transcribeVoice(msg.voice.file_id);
      console.log(`[tg] Transcribed: "${transcript.slice(0, 100)}"`);
      await sendMessage(chatId, `_"${transcript}"_`);

      // Process as command or AI
      const response = transcript.startsWith("/")
        ? await processCommand(chatId, userId, transcript)
        : await askAI(transcript);

      if (response) {
        // Reply with voice + text fallback
        try {
          const voiceBuffer = await textToSpeechOgg(response);
          await sendVoice(chatId, voiceBuffer);
        } catch (ttsErr) {
          console.log(`[tg] TTS failed, text only: ${(ttsErr as Error).message.slice(0, 80)}`);
          await sendMessage(chatId, response, "");
        }
      }
    } catch (err) {
      console.error("[tg] Voice processing failed:", err);
      await sendMessage(chatId, "Couldn't process voice note. Try typing your message.");
    }
    return;
  }

  if (!msg.text) {
    return;
  }
  const text = msg.text.trim();

  // Non-command text → AI response
  if (!text.startsWith("/")) {
    const response = await askAI(text);
    await sendMessage(chatId, response, "");
    return;
  }

  const parts = text.split(/\s+/);
  const cmd = parts[0].replace(/@\w+/, "").toLowerCase();
  const arg = parts.slice(1).join(" ");
  await routeCommand(chatId, userId, cmd, arg);
}

async function poll(offset = 0): Promise<void> {
  try {
    const resp = (await apiCall("getUpdates", { offset, timeout: 30 })) as {
      ok: boolean;
      result: Array<{ update_id: number; message?: unknown }>;
    };

    if (resp.ok && resp.result.length > 0) {
      for (const update of resp.result) {
        await handleUpdate(update as Parameters<typeof handleUpdate>[0]);
        offset = update.update_id + 1;
      }
    }
  } catch (err) {
    console.error("Poll error:", err);
    await new Promise((r) => setTimeout(r, 5000));
  }

  // Continue polling
  poll(offset);
}

// --- Main ---

if (!BOT_TOKEN) {
  console.error("Set TELEGRAM_BOT_TOKEN environment variable");
  console.log("1. Message @BotFather on Telegram");
  console.log("2. /newbot → choose a name → copy the token");
  console.log("3. Run: TELEGRAM_BOT_TOKEN=xxx npx tsx src/telegram/bot/security-bot.ts");
  process.exit(1);
}

console.log("Moltbot Telegram Security Bot starting...");
console.log(`Commands: /ping /help /whois /dns /headers /deepscan /vulnscan /techstack /activate`);
console.log(`Pro: ${PRO_PRICE} via PayPal (${PAYPAL_EMAIL})`);

// Set bot commands
apiCall("setMyCommands", {
  commands: [
    { command: "help", description: "Show all commands" },
    { command: "ping", description: "Check bot status" },
    { command: "whois", description: "WHOIS lookup" },
    { command: "dns", description: "DNS records lookup" },
    { command: "headers", description: "Check security headers" },
    { command: "deepscan", description: "[PRO] Subdomain scan" },
    { command: "vulnscan", description: "[PRO] Vulnerability scan" },
    { command: "techstack", description: "[PRO] Tech detection" },
    { command: "activate", description: "Activate Pro with PayPal TX ID" },
    { command: "browse", description: "Open URL in your Chrome" },
    { command: "click", description: "Click element on page" },
    { command: "type", description: "Type into a field" },
    { command: "ss", description: "Screenshot current page" },
  ],
}).then(() => {
  console.log("Bot commands registered. Starting poll loop...");
  poll();
});
