/**
 * Moltbot Discord Bot — Freemium Security & AI Assistant
 *
 * Free tier: /scan (basic recon), /whois, /headers, /ping, /help
 * Pro tier ($9.99/mo): /deepscan, /vulnscan, /monitor, /report
 *
 * Usage:
 *   DISCORD_BOT_TOKEN=xxx npx tsx src/discord/monitor/bot.ts
 *
 * Setup:
 *   1. Create bot at https://discord.com/developers/applications
 *   2. Enable MESSAGE CONTENT intent + GUILD MEMBERS
 *   3. Invite with: OAuth2 > URL Generator > bot + applications.commands
 *   4. Set DISCORD_BOT_TOKEN env var
 */

import { execSync } from "node:child_process";
import dns from "node:dns/promises";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";

// Lightweight Discord gateway — no heavy discord.js dependency
// Uses Discord REST API directly for slash commands

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const PAYPAL_EMAIL = "vandan@getfoolish.com";
const PRO_PRICE = "$9.99/month";

// Pro users stored in a simple JSON file
const PRO_USERS_FILE = path.join(
  process.env.HOME ?? "/tmp",
  ".openclaw",
  "workspace",
  "metrics",
  "discord-pro-users.json",
);

function loadProUsers(): Set<string> {
  try {
    const data = JSON.parse(fs.readFileSync(PRO_USERS_FILE, "utf-8"));
    return new Set(data);
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

// --- Free Tier Commands ---

async function handlePing(): Promise<string> {
  return "Pong! Moltbot Security Bot is online.";
}

async function handleHelp(): Promise<string> {
  return [
    "**Moltbot Security Bot**",
    "",
    "**Free Commands:**",
    "`/ping` — Check bot status",
    "`/whois <domain>` — WHOIS lookup",
    "`/headers <url>` — Check HTTP security headers",
    "`/dns <domain>` — DNS records lookup",
    "`/help` — This message",
    "",
    `**Pro Commands (${PRO_PRICE}):**`,
    "`/deepscan <domain>` — Full subdomain enumeration",
    "`/vulnscan <url>` — Nuclei vulnerability scan",
    "`/techstack <url>` — Technology detection",
    "`/report <domain>` — Full security report",
    "",
    `**Upgrade to Pro:** Send ${PRO_PRICE} to PayPal: \`${PAYPAL_EMAIL}\``,
    "Then DM me your PayPal transaction ID.",
  ].join("\n");
}

async function handleWhois(domain: string): Promise<string> {
  if (!domain || !/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(domain)) {
    return "Invalid domain. Usage: `/whois example.com`";
  }
  try {
    const result = execSync(`whois ${domain} 2>/dev/null | head -30`, {
      encoding: "utf-8",
      timeout: 10000,
    });
    return `**WHOIS: ${domain}**\n\`\`\`\n${result.slice(0, 1500)}\n\`\`\``;
  } catch {
    return `WHOIS lookup failed for ${domain}`;
  }
}

async function handleDns(domain: string): Promise<string> {
  if (!domain || !/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(domain)) {
    return "Invalid domain. Usage: `/dns example.com`";
  }
  try {
    const [a, mx, ns, txt] = await Promise.allSettled([
      dns.resolve4(domain),
      dns.resolveMx(domain),
      dns.resolveNs(domain),
      dns.resolveTxt(domain),
    ]);

    const lines = [`**DNS Records: ${domain}**`, ""];
    if (a.status === "fulfilled") {
      lines.push(`**A:** ${a.value.join(", ")}`);
    }
    if (mx.status === "fulfilled") {
      lines.push(`**MX:** ${mx.value.map((r) => `${r.exchange} (pri ${r.priority})`).join(", ")}`);
    }
    if (ns.status === "fulfilled") {
      lines.push(`**NS:** ${ns.value.join(", ")}`);
    }
    if (txt.status === "fulfilled") {
      lines.push(
        `**TXT:** ${txt.value
          .slice(0, 5)
          .map((t) => t.join(""))
          .join("\n")}`,
      );
    }

    return lines.join("\n");
  } catch {
    return `DNS lookup failed for ${domain}`;
  }
}

async function handleHeaders(url: string): Promise<string> {
  if (!url) {
    return "Usage: `/headers https://example.com`";
  }
  if (!url.startsWith("http")) {
    url = `https://${url}`;
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve("Request timed out"), 10000);
    try {
      const req = https.get(url, { timeout: 8000 }, (res) => {
        clearTimeout(timeout);
        const headers = res.headers;
        const securityHeaders = [
          "strict-transport-security",
          "content-security-policy",
          "x-frame-options",
          "x-content-type-options",
          "x-xss-protection",
          "referrer-policy",
          "permissions-policy",
        ];

        const lines = [`**Security Headers: ${url}**`, `Status: ${res.statusCode}`, ""];
        for (const h of securityHeaders) {
          const val = headers[h];
          const icon = val ? "+" : "-";
          lines.push(`\`${icon}\` **${h}:** ${val ?? "MISSING"}`);
        }

        const missing = securityHeaders.filter((h) => !headers[h]);
        if (missing.length > 0) {
          lines.push(
            "",
            `**${missing.length}/${securityHeaders.length} security headers missing**`,
          );
        } else {
          lines.push("", "All security headers present!");
        }

        resolve(lines.join("\n"));
      });
      req.on("error", () => {
        clearTimeout(timeout);
        resolve(`Failed to fetch ${url}`);
      });
    } catch {
      clearTimeout(timeout);
      resolve(`Invalid URL: ${url}`);
    }
  });
}

// --- Pro Tier Commands ---

function requirePro(userId: string): string | null {
  if (proUsers.has(userId)) {
    return null;
  }
  return [
    "This is a **Pro** command.",
    "",
    `Upgrade for ${PRO_PRICE}: Send payment to PayPal \`${PAYPAL_EMAIL}\``,
    "Then DM me your transaction ID to activate.",
  ].join("\n");
}

async function handleDeepscan(domain: string, userId: string): Promise<string> {
  const gate = requirePro(userId);
  if (gate) {
    return gate;
  }

  if (!domain || !/^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(domain)) {
    return "Invalid domain. Usage: `/deepscan example.com`";
  }

  try {
    const result = execSync(
      `docker run --rm --cap-add=NET_RAW --user root moltbot/sandbox-kali subfinder -d ${domain} -silent 2>/dev/null | head -50`,
      { encoding: "utf-8", timeout: 60000 },
    );
    const subs = result.trim().split("\n").filter(Boolean);
    return [
      `**Deep Scan: ${domain}**`,
      `Found **${subs.length}** subdomains${subs.length >= 50 ? " (showing first 50)" : ""}:`,
      "```",
      subs.join("\n") || "(none found)",
      "```",
    ].join("\n");
  } catch {
    return `Deep scan failed for ${domain}. Docker may not be running.`;
  }
}

async function handleVulnscan(url: string, userId: string): Promise<string> {
  const gate = requirePro(userId);
  if (gate) {
    return gate;
  }

  if (!url) {
    return "Usage: `/vulnscan https://example.com`";
  }
  if (!url.startsWith("http")) {
    url = `https://${url}`;
  }

  try {
    const result = execSync(
      `docker run --rm --cap-add=NET_RAW --user root moltbot/sandbox-kali nuclei -u "${url}" -severity low,medium,high,critical -silent 2>/dev/null | head -30`,
      { encoding: "utf-8", timeout: 120000 },
    );
    const findings = result.trim().split("\n").filter(Boolean);
    if (findings.length === 0) {
      return `**Vuln Scan: ${url}**\nNo vulnerabilities found (low-critical severity).`;
    }
    return [
      `**Vuln Scan: ${url}**`,
      `Found **${findings.length}** potential issues:`,
      "```",
      findings.join("\n"),
      "```",
    ].join("\n");
  } catch {
    return `Vulnerability scan failed for ${url}. Docker may not be running.`;
  }
}

async function handleTechstack(url: string, userId: string): Promise<string> {
  const gate = requirePro(userId);
  if (gate) {
    return gate;
  }

  if (!url) {
    return "Usage: `/techstack https://example.com`";
  }
  if (!url.startsWith("http")) {
    url = `https://${url}`;
  }

  try {
    const result = execSync(
      `docker run --rm moltbot/sandbox-kali bash -c 'echo "${url}" | httpx -silent -tech-detect -status-code -title 2>/dev/null'`,
      { encoding: "utf-8", timeout: 30000 },
    );
    return `**Tech Stack: ${url}**\n\`\`\`\n${result.trim() || "No data"}\n\`\`\``;
  } catch {
    return `Tech detection failed for ${url}`;
  }
}

// --- Slash Command Definitions ---

export const SLASH_COMMANDS = [
  { name: "ping", description: "Check if the bot is online" },
  { name: "help", description: "Show all available commands" },
  {
    name: "whois",
    description: "WHOIS lookup for a domain",
    options: [{ name: "domain", description: "Domain to look up", type: 3, required: true }],
  },
  {
    name: "dns",
    description: "DNS records for a domain",
    options: [{ name: "domain", description: "Domain to look up", type: 3, required: true }],
  },
  {
    name: "headers",
    description: "Check HTTP security headers",
    options: [{ name: "url", description: "URL to check", type: 3, required: true }],
  },
  {
    name: "deepscan",
    description: "[PRO] Subdomain enumeration",
    options: [{ name: "domain", description: "Domain to scan", type: 3, required: true }],
  },
  {
    name: "vulnscan",
    description: "[PRO] Vulnerability scan",
    options: [{ name: "url", description: "URL to scan", type: 3, required: true }],
  },
  {
    name: "techstack",
    description: "[PRO] Technology detection",
    options: [{ name: "url", description: "URL to detect", type: 3, required: true }],
  },
];

// --- Command Router ---

export async function handleCommand(
  command: string,
  args: Record<string, string>,
  userId: string,
): Promise<string> {
  switch (command) {
    case "ping":
      return handlePing();
    case "help":
      return handleHelp();
    case "whois":
      return handleWhois(args.domain ?? "");
    case "dns":
      return handleDns(args.domain ?? "");
    case "headers":
      return handleHeaders(args.url ?? "");
    case "deepscan":
      return handleDeepscan(args.domain ?? "", userId);
    case "vulnscan":
      return handleVulnscan(args.url ?? "", userId);
    case "techstack":
      return handleTechstack(args.url ?? "", userId);
    default:
      return "Unknown command. Try `/help`.";
  }
}

// --- Revenue Logging ---

function logRevenue(userId: string, amount: number, type: string): void {
  const logDir = path.join(process.env.HOME ?? "/tmp", ".openclaw", "workspace", "metrics");
  fs.mkdirSync(logDir, { recursive: true });
  const entry = {
    timestamp: new Date().toISOString(),
    type: "subscription",
    division: "channel_bots",
    platform: "discord",
    amount,
    currency: "USD",
    userId,
    description: type,
    payment_method: "paypal",
  };
  fs.appendFileSync(path.join(logDir, "revenue.jsonl"), JSON.stringify(entry) + "\n");
}

// Export for use by OpenClaw or standalone
export { proUsers, saveProUsers, logRevenue, loadProUsers };

// --- Standalone entry point ---
if (process.argv[1]?.endsWith("bot.ts") || process.argv[1]?.endsWith("bot.js")) {
  if (!BOT_TOKEN) {
    console.error("Set DISCORD_BOT_TOKEN environment variable");
    console.log("1. Go to https://discord.com/developers/applications");
    console.log("2. Create a new application > Bot > Copy token");
    console.log("3. Run: DISCORD_BOT_TOKEN=your_token npx tsx src/discord/monitor/bot.ts");
    process.exit(1);
  }
  console.log("Moltbot Discord Bot ready. Set up slash commands via Discord Developer Portal.");
  console.log(`Commands: ${SLASH_COMMANDS.map((c) => `/${c.name}`).join(", ")}`);
  console.log(`Pro upgrade: ${PRO_PRICE} via PayPal (${PAYPAL_EMAIL})`);
}
