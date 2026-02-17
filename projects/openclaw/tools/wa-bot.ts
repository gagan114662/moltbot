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
  downloadContentFromMessage,
  type WASocket,
  type WAMessage,
} from "@whiskeysockets/baileys";
import { execFile } from "node:child_process";
import { writeFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import qrcode from "qrcode-terminal";

const CREDS_DIR = path.join(
  process.env.HOME ?? "/tmp",
  ".openclaw",
  "credentials",
  "whatsapp",
  "default",
);

// Only respond to these numbers (prevent abuse)
const ALLOWED_SENDERS = new Set([
  "14379878666@s.whatsapp.net", // Gagan (phone JID)
  "185512858005522@lid", // Gagan (linked identity)
]);

const startTime = Date.now();
let messagesReceived = 0;
let messagesResponded = 0;
// Track message IDs we sent to avoid infinite loops
const sentByBot = new Set<string>();

// --- AI via CLI tools (codex primary, claude fallback) ---
const SYSTEM_PROMPT =
  "You are Moltbot, a helpful AI assistant on WhatsApp. Keep responses concise (under 500 chars) since this is a chat app. Be direct and useful.";

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

async function askAI(question: string): Promise<string> {
  const prompt = `${SYSTEM_PROMPT}\n\nUser question: ${question}`;

  // Try Codex first
  try {
    const result = await runCli(
      "codex",
      ["exec", "--full-auto", "--skip-git-repo-check", prompt],
      60000,
      "/tmp",
    );
    if (result) {
      console.log("[wa-bot] Answered via Codex");
      return result;
    }
  } catch (err) {
    console.log(`[wa-bot] Codex failed: ${(err as Error).message.slice(0, 100)}`);
  }

  // Fall back to Claude
  try {
    const result = await runCli(
      "claude",
      ["-p", "--max-turns", "1", "--model", "haiku", prompt],
      60000,
      "/tmp",
    );
    if (result) {
      console.log("[wa-bot] Answered via Claude");
      return result;
    }
  } catch (err) {
    console.log(`[wa-bot] Claude failed: ${(err as Error).message.slice(0, 100)}`);
  }

  return "AI temporarily unavailable. Try /help for commands.";
}

async function transcribeVoiceNote(msg: WAMessage): Promise<string> {
  const audioMsg = msg.message?.audioMessage;
  if (!audioMsg) {
    throw new Error("No audio message");
  }

  // Download & decrypt audio from WhatsApp servers
  const stream = await downloadContentFromMessage(
    { mediaKey: audioMsg.mediaKey!, directPath: audioMsg.directPath!, url: audioMsg.url! },
    "audio",
  );
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }
  const audioBuffer = Buffer.concat(chunks);

  // Save to temp file
  const tmpFile = `/tmp/wa-voice-${Date.now()}`;
  await writeFile(`${tmpFile}.ogg`, audioBuffer);

  // Transcribe with local whisper (no API key needed)
  try {
    await runCli(
      "whisper",
      [
        `${tmpFile}.ogg`,
        "--model",
        "tiny",
        "--language",
        "en",
        "--output_format",
        "txt",
        "--output_dir",
        "/tmp",
      ],
      30000,
    );

    const transcript = (await readFile(`${tmpFile}.txt`, "utf-8")).trim();
    return transcript || "(empty voice note)";
  } finally {
    // Clean up temp files
    for (const ext of [".ogg", ".txt"]) {
      await unlink(`${tmpFile}${ext}`).catch(() => {});
    }
  }
}

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
        "Or just ask me anything — powered by AI.",
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
      // AI-powered response (Codex first, Claude fallback)
      return askAI(trimmed);
  }
}

async function handleMessage(sock: WASocket, msg: WAMessage): Promise<void> {
  const jid = msg.key.remoteJid ?? "unknown";
  const fromMe = msg.key.fromMe ?? false;
  const msgType = msg.message ? Object.keys(msg.message).join(",") : "none";
  console.log(`[wa-debug] msg from=${jid} fromMe=${fromMe} type=${msgType} id=${msg.key.id}`);

  // Skip status messages, reactions, etc.
  if (!msg.message) {
    return;
  }
  if (jid === "status@broadcast") {
    return;
  }
  // Skip messages the bot itself sent (prevents infinite loops)
  if (fromMe && msg.key.id && sentByBot.has(msg.key.id)) {
    console.log(`[wa-debug] Skipping own bot message ${msg.key.id}`);
    return;
  }

  const sender = jid;

  // Only respond to allowed senders
  if (!ALLOWED_SENDERS.has(sender)) {
    console.log(`[wa] Ignoring message from ${sender} (not in allow list)`);
    return;
  }

  messagesReceived++;

  // Handle voice notes — transcribe then process as text
  if (msg.message.audioMessage?.ptt) {
    console.log(`[wa] Voice note from ${sender}: ${msg.message.audioMessage.seconds}s`);
    try {
      const transcript = await transcribeVoiceNote(msg);
      console.log(`[wa] Transcribed: "${transcript.slice(0, 100)}"`);
      const response = await handleCommand(transcript);
      const sent = await sock.sendMessage(sender, { text: `_${transcript}_\n\n${response}` });
      if (sent?.key?.id) {
        sentByBot.add(sent.key.id);
      }
      messagesResponded++;
      return;
    } catch (err) {
      console.error(`[wa] Voice transcription failed:`, err);
      const sent = await sock.sendMessage(sender, {
        text: "Couldn't transcribe that voice note. Try again or type your message.",
      });
      if (sent?.key?.id) {
        sentByBot.add(sent.key.id);
      }
      return;
    }
  }

  // Extract text from various message types
  const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
  console.log(`[wa-debug] Extracted text: "${text.slice(0, 100)}"`);

  if (!text) {
    return;
  }

  console.log(`[wa] ${sender}: ${text.slice(0, 100)}`);

  try {
    const response = await handleCommand(text);
    const sent = await sock.sendMessage(sender, { text: response });
    if (sent?.key?.id) {
      sentByBot.add(sent.key.id);
    }
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
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\n\n=== SCAN THIS QR CODE WITH WHATSAPP ===");
      console.log("Open WhatsApp > Settings > Linked Devices > Link a Device\n");
      qrcode.generate(qr, { small: true });
      console.log("\n========================================\n");
    }

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
