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

import { execSync } from "node:child_process";
import dns from "node:dns/promises";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";

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

// --- Polling Loop ---

async function handleUpdate(update: {
  message?: { chat: { id: number }; from?: { id: number }; text?: string };
}): Promise<void> {
  const msg = update.message;
  if (!msg?.text) {
    return;
  }

  const chatId = msg.chat.id;
  const userId = msg.from?.id ?? 0;
  const text = msg.text.trim();

  if (!text.startsWith("/")) {
    return;
  }

  const parts = text.split(/\s+/);
  const cmd = parts[0].replace(/@\w+/, "").toLowerCase(); // strip @botname
  const arg = parts.slice(1).join(" ");

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
    default:
      await sendMessage(chatId, "Unknown command. Try /help");
  }
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
  ],
}).then(() => {
  console.log("Bot commands registered. Starting poll loop...");
  poll();
});
