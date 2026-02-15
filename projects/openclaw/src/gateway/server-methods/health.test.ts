import { describe, expect, it, vi } from "vitest";
import type { HealthSummary } from "../../commands/health.js";
import type { ChannelRuntimeSnapshot } from "../server-channels.js";
import type { GatewayRequestContext } from "./types.js";
import { healthHandlers } from "./health.js";

const baseHealthSummary = (): HealthSummary => ({
  ok: true,
  ts: Date.now(),
  durationMs: 25,
  channels: {
    whatsapp: {
      accountId: "default",
      linked: true,
      running: false,
      connected: false,
      accounts: {
        default: {
          accountId: "default",
          linked: true,
          running: false,
          connected: false,
        },
      },
    },
  },
  channelOrder: ["whatsapp"],
  channelLabels: { whatsapp: "WhatsApp" },
  heartbeatSeconds: 0,
  defaultAgentId: "main",
  agents: [],
  sessions: {
    path: "/tmp/sessions.json",
    count: 0,
    recent: [],
  },
});

const liveRuntimeSnapshot = (): ChannelRuntimeSnapshot => ({
  channels: {
    whatsapp: {
      accountId: "default",
      running: true,
      connected: true,
      lastConnectedAt: 123,
      lastError: null,
    },
  },
  channelAccounts: {
    whatsapp: {
      default: {
        accountId: "default",
        running: true,
        connected: true,
        lastConnectedAt: 123,
        lastError: null,
      },
    },
  },
});

const reqBase = { type: "req", id: "h1", method: "health" } as const;

const buildContext = (opts: {
  cached: HealthSummary | null;
  refreshed: HealthSummary;
  runtime?: ChannelRuntimeSnapshot;
}) => {
  const refreshHealthSnapshot = vi.fn(async () => opts.refreshed);
  const context = {
    getHealthCache: vi.fn(() => opts.cached),
    refreshHealthSnapshot,
    getRuntimeSnapshot: vi.fn(() => opts.runtime ?? liveRuntimeSnapshot()),
    logHealth: { error: vi.fn() },
  } as unknown as GatewayRequestContext;
  return { context, refreshHealthSnapshot };
};

describe("gateway health handler", () => {
  it("overlays live runtime state onto cached health responses", async () => {
    const cached = baseHealthSummary();
    const refreshed = baseHealthSummary();
    const { context, refreshHealthSnapshot } = buildContext({ cached, refreshed });
    const respond = vi.fn();

    await healthHandlers.health({
      params: {},
      respond,
      context,
      req: reqBase,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        channels: expect.objectContaining({
          whatsapp: expect.objectContaining({
            running: true,
            connected: true,
            accounts: expect.objectContaining({
              default: expect.objectContaining({
                running: true,
                connected: true,
              }),
            }),
          }),
        }),
      }),
      undefined,
      { cached: true },
    );
    expect(refreshHealthSnapshot).toHaveBeenCalledWith({ probe: false });
  });

  it("overlays live runtime state onto refreshed health responses", async () => {
    const stale = baseHealthSummary();
    const { context, refreshHealthSnapshot } = buildContext({
      cached: null,
      refreshed: stale,
    });
    const respond = vi.fn();

    await healthHandlers.health({
      params: {},
      respond,
      context,
      req: reqBase,
      client: null,
      isWebchatConnect: () => false,
    });

    const payload = respond.mock.calls[0]?.[1] as HealthSummary;
    expect(payload.channels.whatsapp?.connected).toBe(true);
    expect(payload.channels.whatsapp?.running).toBe(true);
    expect(payload.channels.whatsapp?.accounts?.default?.connected).toBe(true);
    expect(payload.channels.whatsapp?.accounts?.default?.running).toBe(true);
    expect(refreshHealthSnapshot).toHaveBeenCalledWith({ probe: false });
  });

  it("forces a fresh probe when params.probe=true", async () => {
    const cached = baseHealthSummary();
    const refreshed = baseHealthSummary();
    const { context, refreshHealthSnapshot } = buildContext({ cached, refreshed });
    const respond = vi.fn();

    await healthHandlers.health({
      params: { probe: true },
      respond,
      context,
      req: reqBase,
      client: null,
      isWebchatConnect: () => false,
    });

    expect(refreshHealthSnapshot).toHaveBeenCalledWith({ probe: true });
    const payload = respond.mock.calls[0]?.[1] as HealthSummary;
    expect(payload.channels.whatsapp?.connected).toBe(true);
  });
});
