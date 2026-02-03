import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { WebInboundMessage } from "../../inbound/types.js";
import { createDurableInboundQueue, resolveDurableQueuePath } from "./durable-inbound-queue.js";

function makeInbound(overrides: Partial<WebInboundMessage> = {}): WebInboundMessage {
  return {
    id: "m1",
    from: "+15551234567",
    conversationId: "+15551234567",
    to: "+15550000000",
    accountId: "default",
    body: "hello",
    chatType: "direct",
    chatId: "+15551234567",
    sendComposing: async () => {},
    reply: async () => {},
    sendMedia: async () => {},
    ...overrides,
  };
}

describe("durable inbound queue", () => {
  it("retains failures and drains successfully on retry", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-inbound-queue-"));
    const queuePath = resolveDurableQueuePath(dir, "default");
    const queue = createDurableInboundQueue({
      queuePath,
      backoffSec: [0],
      maxAttempts: 3,
      onWarn: () => {},
    });
    const msg = makeInbound();
    let attempts = 0;

    await expect(
      queue.enqueueAndProcess(msg, async () => {
        attempts += 1;
        throw new Error("temporary failure");
      }),
    ).rejects.toThrow("temporary failure");

    const rawAfterFail = await fs.readFile(queuePath, "utf-8");
    const afterFail = JSON.parse(rawAfterFail) as { items: Array<{ attempts: number }> };
    expect(afterFail.items).toHaveLength(1);
    expect(afterFail.items[0]?.attempts).toBe(1);

    await queue.drainReady(async () => {
      attempts += 1;
    });

    const rawAfterDrain = await fs.readFile(queuePath, "utf-8");
    const afterDrain = JSON.parse(rawAfterDrain) as { items: unknown[] };
    expect(afterDrain.items).toHaveLength(0);
    expect(attempts).toBe(2);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it("deduplicates queued messages by message key", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-inbound-queue-"));
    const queuePath = resolveDurableQueuePath(dir, "default");
    const queue = createDurableInboundQueue({
      queuePath,
      backoffSec: [0],
      maxAttempts: 3,
      onWarn: () => {},
    });
    const msg = makeInbound({ id: "same-id" });

    await expect(
      queue.enqueueAndProcess(msg, async () => {
        throw new Error("fail once");
      }),
    ).rejects.toThrow("fail once");
    await expect(
      queue.enqueueAndProcess(msg, async () => {
        throw new Error("fail twice");
      }),
    ).rejects.toThrow("fail twice");

    const raw = await fs.readFile(queuePath, "utf-8");
    const parsed = JSON.parse(raw) as { items: unknown[] };
    expect(parsed.items).toHaveLength(1);

    await fs.rm(dir, { recursive: true, force: true });
  });
});
