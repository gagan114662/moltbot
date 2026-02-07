import type { AnyMessageContent } from "@whiskeysockets/baileys";
import fs from "node:fs/promises";
import path from "node:path";
import type { WebInboundMessage } from "../../inbound/types.js";
import { requireActiveWebListener } from "../../active-listener.js";

type SerializableInboundMessage = Omit<WebInboundMessage, "sendComposing" | "reply" | "sendMedia">;

type QueueItem = {
  id: string;
  messageKey: string;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
  msg: SerializableInboundMessage;
};

type QueueFile = {
  version: 1;
  items: QueueItem[];
};

const QUEUE_VERSION = 1;

function buildMessageKey(msg: SerializableInboundMessage): string {
  const id = msg.id?.trim();
  if (id) {
    return `${msg.accountId}:${msg.chatId}:${id}`;
  }
  const ts = typeof msg.timestamp === "number" ? msg.timestamp : Date.now();
  const body = msg.body.slice(0, 128);
  return `${msg.accountId}:${msg.chatId}:${ts}:${body}`;
}

function toSerializable(msg: WebInboundMessage): SerializableInboundMessage {
  const { sendComposing: _sendComposing, reply: _reply, sendMedia: _sendMedia, ...rest } = msg;
  return rest;
}

function backoffMs(attempt: number, backoffSec: number[]): number {
  const idx = Math.max(0, Math.min(attempt - 1, backoffSec.length - 1));
  const sec = backoffSec[idx] ?? 30;
  return sec * 1000;
}

async function readQueueFile(queuePath: string): Promise<QueueFile> {
  try {
    const raw = await fs.readFile(queuePath, "utf-8");
    const parsed = JSON.parse(raw) as QueueFile;
    if (parsed.version !== QUEUE_VERSION || !Array.isArray(parsed.items)) {
      return { version: QUEUE_VERSION, items: [] };
    }
    return parsed;
  } catch {
    return { version: QUEUE_VERSION, items: [] };
  }
}

async function writeQueueFile(queuePath: string, data: QueueFile): Promise<void> {
  await fs.mkdir(path.dirname(queuePath), { recursive: true });
  const tmpPath = `${queuePath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  await fs.rename(tmpPath, queuePath);
}

function hydrateInboundMessage(msg: SerializableInboundMessage): WebInboundMessage {
  return {
    ...msg,
    sendComposing: async () => {
      const { listener } = requireActiveWebListener(msg.accountId);
      await listener.sendComposingTo(msg.from);
    },
    reply: async (text: string) => {
      const { listener } = requireActiveWebListener(msg.accountId);
      await listener.sendMessage(msg.from, text, undefined, undefined, {
        accountId: msg.accountId,
      });
    },
    sendMedia: async (payload: AnyMessageContent) => {
      const { listener } = requireActiveWebListener(msg.accountId);
      const caption =
        "caption" in payload && typeof payload.caption === "string" ? payload.caption : "";
      const mimetype =
        "mimetype" in payload && typeof payload.mimetype === "string"
          ? payload.mimetype
          : undefined;
      if ("image" in payload && payload.image instanceof Buffer) {
        await listener.sendMessage(msg.from, caption, payload.image, mimetype ?? "image/png", {
          accountId: msg.accountId,
        });
        return;
      }
      if ("video" in payload && payload.video instanceof Buffer) {
        const gifPlayback =
          "gifPlayback" in payload && typeof payload.gifPlayback === "boolean"
            ? payload.gifPlayback
            : false;
        await listener.sendMessage(msg.from, caption, payload.video, mimetype ?? "video/mp4", {
          accountId: msg.accountId,
          ...(gifPlayback ? { gifPlayback: true } : {}),
        });
        return;
      }
      if ("audio" in payload && payload.audio instanceof Buffer) {
        await listener.sendMessage(msg.from, caption, payload.audio, mimetype ?? "audio/ogg", {
          accountId: msg.accountId,
        });
        return;
      }
      if ("document" in payload && payload.document instanceof Buffer) {
        await listener.sendMessage(
          msg.from,
          caption,
          payload.document,
          mimetype ?? "application/octet-stream",
          { accountId: msg.accountId },
        );
        return;
      }
      throw new Error("Unsupported media payload for durable replay.");
    },
  };
}

export function resolveDurableQueuePath(authDir: string, accountId: string): string {
  return path.join(authDir, `inbound-recovery-queue.${accountId}.json`);
}

export function createDurableInboundQueue(params: {
  queuePath: string;
  backoffSec: number[];
  maxAttempts: number;
  onWarn: (message: string) => void;
}) {
  let draining = false;

  const enqueue = async (msg: WebInboundMessage): Promise<string> => {
    const state = await readQueueFile(params.queuePath);
    const serial = toSerializable(msg);
    const messageKey = buildMessageKey(serial);
    const existing = state.items.find((item) => item.messageKey === messageKey);
    if (existing) {
      return existing.id;
    }
    const now = Date.now();
    const id = `${now}-${Math.random().toString(36).slice(2, 10)}`;
    state.items.push({
      id,
      messageKey,
      createdAt: now,
      updatedAt: now,
      attempts: 0,
      nextAttemptAt: now,
      msg: serial,
    });
    await writeQueueFile(params.queuePath, state);
    return id;
  };

  const ack = async (id: string) => {
    const state = await readQueueFile(params.queuePath);
    const next = state.items.filter((item) => item.id !== id);
    if (next.length === state.items.length) {
      return;
    }
    state.items = next;
    await writeQueueFile(params.queuePath, state);
  };

  const markFailure = async (id: string, err: unknown) => {
    const state = await readQueueFile(params.queuePath);
    const item = state.items.find((entry) => entry.id === id);
    if (!item) {
      return;
    }
    item.attempts += 1;
    item.updatedAt = Date.now();
    item.lastError = err instanceof Error ? err.message : String(err);
    item.nextAttemptAt = Date.now() + backoffMs(item.attempts, params.backoffSec);
    if (item.attempts >= params.maxAttempts) {
      params.onWarn(
        `Dropping queued inbound message ${item.id} after ${item.attempts} attempts: ${item.lastError}`,
      );
      state.items = state.items.filter((entry) => entry.id !== id);
    }
    await writeQueueFile(params.queuePath, state);
  };

  const processSingle = async (
    id: string,
    msg: WebInboundMessage,
    processor: (msg: WebInboundMessage) => Promise<void>,
  ) => {
    try {
      await processor(msg);
      await ack(id);
    } catch (err) {
      await markFailure(id, err);
      throw err;
    }
  };

  const enqueueAndProcess = async (
    msg: WebInboundMessage,
    processor: (msg: WebInboundMessage) => Promise<void>,
  ) => {
    const id = await enqueue(msg);
    await processSingle(id, msg, processor);
  };

  const drainReady = async (processor: (msg: WebInboundMessage) => Promise<void>) => {
    if (draining) {
      return;
    }
    draining = true;
    try {
      const state = await readQueueFile(params.queuePath);
      const now = Date.now();
      const readyItems = state.items.filter((item) => item.nextAttemptAt <= now);
      for (const item of readyItems) {
        try {
          const replayMsg = hydrateInboundMessage(item.msg);
          await processSingle(item.id, replayMsg, processor);
        } catch (err) {
          params.onWarn(
            `Queued inbound replay failed (${item.id}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } finally {
      draining = false;
    }
  };

  return {
    enqueueAndProcess,
    drainReady,
  };
}
