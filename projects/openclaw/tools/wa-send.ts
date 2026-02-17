#!/usr/bin/env node --import tsx
/**
 * wa-send — Standalone WhatsApp message sender using Baileys.
 *
 * Uses existing OpenClaw credentials at ~/.openclaw/credentials/whatsapp/default/
 * If session is expired, prints QR code for re-linking.
 *
 * Usage:
 *   node --import tsx tools/wa-send.ts "Hello from moltbot!" [+14379878666]
 *   node --import tsx tools/wa-send.ts --status    # check connection status
 *   node --import tsx tools/wa-send.ts --relink    # force re-link with QR
 */

import { Boom } from "@hapi/boom";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import fs from "node:fs";
import path from "node:path";

const CREDS_DIR = path.join(
  process.env.HOME ?? "/tmp",
  ".openclaw",
  "credentials",
  "whatsapp",
  "default",
);

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

async function connect(opts: { forceRelink?: boolean; timeoutMs?: number }): Promise<{
  sock: ReturnType<typeof makeWASocket>;
  cleanup: () => void;
}> {
  const { state, saveCreds } = await useMultiFileAuthState(CREDS_DIR);
  const timeout = opts.timeoutMs ?? 30000;

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger as any),
    },
    logger: logger as any,
    printQRInTerminal: true,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
  });

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sock.end(undefined);
      reject(
        new Error(`Connection timeout after ${timeout}ms. May need to re-link: run with --relink`),
      );
    }, timeout);

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("\n--- SCAN THIS QR CODE WITH WHATSAPP ---");
        console.log("Open WhatsApp > Settings > Linked Devices > Link a Device");
        console.log("QR will appear in terminal above.\n");
      }

      if (connection === "open") {
        clearTimeout(timer);
        console.log("[wa] Connected as:", sock.user?.name ?? sock.user?.id);
        resolve({
          sock,
          cleanup: () => {
            sock.end(undefined);
          },
        });
      }

      if (connection === "close") {
        clearTimeout(timer);
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const reason = DisconnectReason;

        if (statusCode === reason.loggedOut) {
          // Clear creds and ask for re-link
          console.log("[wa] Session logged out. Deleting credentials...");
          try {
            fs.unlinkSync(path.join(CREDS_DIR, "creds.json"));
          } catch {}
          reject(new Error("Logged out. Run with --relink to re-authenticate."));
        } else if (statusCode === reason.restartRequired) {
          console.log("[wa] Restart required, reconnecting...");
          sock.end(undefined);
          connect(opts).then(resolve).catch(reject);
        } else {
          reject(
            new Error(
              `Connection closed: status=${statusCode}, error=${lastDisconnect?.error?.message ?? "unknown"}`,
            ),
          );
        }
      }
    });
  });
}

function formatJid(phone: string): string {
  // Remove +, spaces, dashes
  const clean = phone.replace(/[\s+\-()]/g, "");
  if (clean.includes("@")) {
    return clean;
  } // already a JID
  return `${clean}@s.whatsapp.net`;
}

async function sendMessage(text: string, to: string): Promise<void> {
  console.log(`[wa] Connecting...`);
  const { sock, cleanup } = await connect({ timeoutMs: 30000 });

  try {
    const jid = formatJid(to);
    console.log(`[wa] Sending to ${jid}...`);
    const result = await sock.sendMessage(jid, { text });
    console.log(`[wa] Sent! Message ID: ${result?.key?.id}`);
  } finally {
    // Wait a moment for the message to actually send
    await new Promise((r) => setTimeout(r, 2000));
    cleanup();
  }
}

async function checkStatus(): Promise<void> {
  console.log(`[wa] Checking connection status...`);
  console.log(`[wa] Credentials dir: ${CREDS_DIR}`);

  const credsPath = path.join(CREDS_DIR, "creds.json");
  if (!fs.existsSync(credsPath)) {
    console.log("[wa] No credentials found. Run with --relink to authenticate.");
    return;
  }

  const creds = JSON.parse(fs.readFileSync(credsPath, "utf-8"));
  console.log(`[wa] Account: ${creds.me?.name ?? "unknown"} (${creds.me?.id ?? "no id"})`);
  console.log(`[wa] Registered: ${creds.registered}`);

  try {
    const { sock, cleanup } = await connect({ timeoutMs: 15000 });
    console.log(`[wa] Status: CONNECTED`);
    console.log(`[wa] User: ${sock.user?.name} (${sock.user?.id})`);
    cleanup();
  } catch (err) {
    console.log(`[wa] Status: DISCONNECTED — ${(err as Error).message}`);
  }
}

// --- CLI entry ---
const args = process.argv.slice(2);

if (args.includes("--status")) {
  checkStatus().catch((e) => {
    console.error("[wa] Error:", e.message);
    process.exit(1);
  });
} else if (args.includes("--relink")) {
  console.log("[wa] Starting re-link process...");
  connect({ timeoutMs: 120000 })
    .then(({ cleanup }) => {
      console.log("[wa] Re-linked successfully!");
      cleanup();
    })
    .catch((e) => {
      console.error("[wa] Re-link failed:", e.message);
      process.exit(1);
    });
} else if (args.length >= 1) {
  const message = args[0];
  const to = args[1] ?? "+14379878666"; // default: self-chat
  sendMessage(message, to).catch((e) => {
    console.error("[wa] Send failed:", e.message);
    process.exit(1);
  });
} else {
  console.log(`Usage:
  wa-send "message text" [+phone]    Send a message
  wa-send --status                   Check connection
  wa-send --relink                   Re-link with QR code

Default recipient: +14379878666 (self-chat)`);
}
