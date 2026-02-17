#!/usr/bin/env node --import tsx
/**
 * wa-bot — Persistent WhatsApp bot using Baileys.
 *
 * Stays connected, listens for incoming messages, and responds.
 * Uses existing credentials at ~/.openclaw/credentials/whatsapp/default/
 *
 * Commands:
 *   /ping         — Check if bot is alive
 *   /scan <url>   — Quick security scan (headers, tech detection)
 *   /endpoints <url> — Extract API endpoints from JS bundles
 *   /status       — Show bot uptime and stats
 *   /help         — List commands
 *
 * Usage:
 *   node --import tsx tools/wa-bot.ts
 *
 * Keep it running in a tmux/screen session for persistence.
 */

import { Boom } from "@hapi/boom";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";
import path from "node:path";

const CREDS_DIR = path.join(
  process.env.HOME ?? "/tmp",
  ".openclaw",
  "credentials",
  "whatsapp",
  "default",
);

// Only respond to these numbers (prevent abuse)
const ALLOWED_SENDERS = new Set([
  "14379878666@s.whatsapp.net", // Gagan
]);

const startTime = Date.now();
let messagesReceived = 0;
let messagesResponded = 0;

// Suppress Baileys verbose logging
const logger = {
  info: () => {},
  warn: () => {},
  error: (...args: unknown[]) => console.error("[wa]", ...args),
  debug: () => {},
  trace: () => {},
  child: () => logger,
  level: "error" as const,
  fatal: (...args: unknown[]) => console.error("[wa-fatal]", ...args),
  silent: () => {},
};

async function quickHeaderScan(url: string): Promise<string> {
  try {
    const resp = await fetch(url, {
      method: "HEAD",
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
      redirect: "follow",
    });

    const secHeaders = [
      "strict-transport-security",
      "content-security-policy",
      "x-frame-options",
      "x-content-type-options",
      "x-xss-protection",
      "referrer-policy",
      "permissions-policy",
    ];

    const lines: string[] = [`*Scan: ${url}*`, `Status: ${resp.status}`];

    const missing: string[] = [];
    const present: string[] = [];

    for (const h of secHeaders) {
      const val = resp.headers.get(h);
      if (val) {
        present.push(`${h}: ${val.slice(0, 60)}`);
      } else {
        missing.push(h);
      }
    }

    // Server info
    const server = resp.headers.get("server");
    if (server) {
      lines.push(`Server: ${server}`);
    }

    const poweredBy = resp.headers.get("x-powered-by");
    if (poweredBy) {
      lines.push(`X-Powered-By: ${poweredBy}`);
    }

    if (present.length > 0) {
      lines.push(`\n*Security headers (${present.length}/${secHeaders.length}):*`);
      for (const p of present) {
        lines.push(`  ${p}`);
      }
    }
    if (missing.length > 0) {
      lines.push(`\n*Missing headers (${missing.length}):*`);
      for (const m of missing) {
        lines.push(`  ${m}`);
      }
    }

    return lines.join("\n");
  } catch (err) {
    return `Scan failed: ${err instanceof Error ? err.message : "unknown error"}`;
  }
}

function handleCommand(text: string): Promise<string> | string {
  const trimmed = text.trim();
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg = parts.slice(1).join(" ");

  switch (cmd) {
    case "/ping":
      return "pong";

    case "/help":
      return [
        "*Moltbot WhatsApp Commands:*",
        "",
        "/ping — Check if bot is alive",
        "/scan <url> — Quick security header scan",
        "/status — Bot uptime and stats",
        "/help — This message",
        "",
        "Or just send a message and I'll echo it back.",
      ].join("\n");

    case "/status": {
      const uptimeMs = Date.now() - startTime;
      const uptimeMin = Math.round(uptimeMs / 60000);
      const uptimeHr = Math.floor(uptimeMin / 60);
      const uptime = uptimeHr > 0 ? `${uptimeHr}h ${uptimeMin % 60}m` : `${uptimeMin}m`;
      return [
        "*Moltbot Status:*",
        `Uptime: ${uptime}`,
        `Messages received: ${messagesReceived}`,
        `Messages responded: ${messagesResponded}`,
        `Memory: ${Math.round(process.memoryUsage.rss() / 1024 / 1024)}MB`,
      ].join("\n");
    }

    case "/scan": {
      if (!arg) {
        return "Usage: /scan <url>\nExample: /scan https://example.com";
      }
      let url = arg;
      if (!url.startsWith("http")) {
        url = "https://" + url;
      }
      return quickHeaderScan(url);
    }

    default:
      if (trimmed.startsWith("/")) {
        return `Unknown command: ${cmd}\nType /help for available commands.`;
      }
      // Echo non-command messages with a note
      return `Got your message. Type /help for commands.`;
  }
}

async function handleMessage(sock: WASocket, msg: WAMessage): Promise<void> {
  // Skip status messages, reactions, etc.
  if (!msg.message || msg.key.fromMe) {
    return;
  }
  if (msg.key.remoteJid === "status@broadcast") {
    return;
  }

  const sender = msg.key.remoteJid;
  if (!sender) {
    return;
  }

  // Only respond to allowed senders
  if (!ALLOWED_SENDERS.has(sender)) {
    console.log(`[wa] Ignoring message from ${sender} (not in allow list)`);
    return;
  }

  messagesReceived++;

  // Extract text from various message types
  const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";

  if (!text) {
    return;
  }

  console.log(`[wa] ${sender}: ${text.slice(0, 100)}`);

  try {
    const response = await handleCommand(text);
    await sock.sendMessage(sender, { text: response });
    messagesResponded++;
    console.log(`[wa] Replied to ${sender}`);
  } catch (err) {
    console.error(`[wa] Failed to reply:`, err);
  }
}

async function startBot(): Promise<void> {
  const { state, saveCreds } = await useMultiFileAuthState(CREDS_DIR);

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(
        state.keys,
        logger as unknown as Parameters<typeof makeCacheableSignalKeyStore>[1],
      ),
    },
    logger: logger as unknown as Parameters<typeof makeWASocket>[0]["logger"],
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      console.log(`[wa-bot] Connected as: ${sock.user?.name ?? sock.user?.id}`);
      console.log(`[wa-bot] Listening for messages...`);
      console.log(`[wa-bot] Allowed senders: ${[...ALLOWED_SENDERS].join(", ")}`);
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;

      if (statusCode === DisconnectReason.loggedOut) {
        console.error("[wa-bot] Logged out. Run wa-send.ts --relink to re-authenticate.");
        process.exit(1);
      }

      // Reconnect on any other disconnect
      console.log(`[wa-bot] Disconnected (code ${statusCode}), reconnecting in 5s...`);
      setTimeout(() => startBot(), 5000);
    }
  });

  // Listen for incoming messages
  sock.ev.on("messages.upsert", async ({ messages }) => {
    for (const msg of messages) {
      await handleMessage(sock, msg);
    }
  });
}

console.log("[wa-bot] Starting Moltbot WhatsApp bot...");
startBot().catch((err) => {
  console.error("[wa-bot] Fatal:", err);
  process.exit(1);
});
