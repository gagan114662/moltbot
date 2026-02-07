import { describe, expect, it, afterEach, vi } from "vitest";
import {
  ConnectionRateLimiter,
  DEFAULT_RATE_LIMITER_CONFIG,
  RateLimiterRegistry,
  getGlobalRateLimiterRegistry,
  resetGlobalRateLimiterRegistry,
} from "./rate-limiter.js";

describe("ConnectionRateLimiter", () => {
  it("allows requests within burst allowance", () => {
    const limiter = new ConnectionRateLimiter({ burstAllowance: 5, messagesPerSecond: 10 });
    for (let i = 0; i < 5; i++) {
      const result = limiter.consume();
      expect(result.allowed).toBe(true);
      expect(result.retryAfterMs).toBe(0);
    }
  });

  it("rejects when burst is exhausted", () => {
    const limiter = new ConnectionRateLimiter({ burstAllowance: 2, messagesPerSecond: 10 });
    limiter.consume();
    limiter.consume();
    const result = limiter.consume();
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("bypasses limiting when disabled", () => {
    const limiter = new ConnectionRateLimiter({ enabled: false });
    for (let i = 0; i < 1000; i++) {
      const result = limiter.consume();
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(Infinity);
    }
  });

  it("peek does not consume tokens", () => {
    const limiter = new ConnectionRateLimiter({ burstAllowance: 1, messagesPerSecond: 10 });
    const peek1 = limiter.peek();
    expect(peek1.allowed).toBe(true);
    const peek2 = limiter.peek();
    expect(peek2.allowed).toBe(true);
    // Actually consume
    const consumed = limiter.consume();
    expect(consumed.allowed).toBe(true);
    // Now exhausted
    const result = limiter.consume();
    expect(result.allowed).toBe(false);
  });

  it("reset restores full burst", () => {
    const limiter = new ConnectionRateLimiter({ burstAllowance: 2, messagesPerSecond: 10 });
    limiter.consume();
    limiter.consume();
    expect(limiter.consume().allowed).toBe(false);
    limiter.reset();
    expect(limiter.consume().allowed).toBe(true);
  });

  it("refills tokens over time", () => {
    vi.useFakeTimers();
    try {
      const limiter = new ConnectionRateLimiter({
        burstAllowance: 1,
        messagesPerSecond: 10,
      });
      limiter.consume(); // exhaust the single token
      expect(limiter.consume().allowed).toBe(false);
      // Advance 200ms → should refill 2 tokens (10/sec * 0.2s)
      vi.advanceTimersByTime(200);
      expect(limiter.consume().allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps tokens at burstAllowance", () => {
    vi.useFakeTimers();
    try {
      const limiter = new ConnectionRateLimiter({
        burstAllowance: 3,
        messagesPerSecond: 100,
      });
      // Advance a long time — tokens should not exceed burst
      vi.advanceTimersByTime(10_000);
      const result = limiter.consume();
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBeLessThanOrEqual(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("getConfig returns current config", () => {
    const limiter = new ConnectionRateLimiter({ messagesPerSecond: 42 });
    const config = limiter.getConfig();
    expect(config.messagesPerSecond).toBe(42);
    expect(config.burstAllowance).toBe(DEFAULT_RATE_LIMITER_CONFIG.burstAllowance);
  });

  it("updateConfig adjusts settings at runtime", () => {
    const limiter = new ConnectionRateLimiter({ burstAllowance: 10 });
    limiter.updateConfig({ burstAllowance: 2 });
    expect(limiter.getConfig().burstAllowance).toBe(2);
  });

  it("updateConfig caps existing tokens to new burst", () => {
    const limiter = new ConnectionRateLimiter({ burstAllowance: 10 });
    // tokens start at 10
    limiter.updateConfig({ burstAllowance: 3 });
    // consume 3 should work, 4th should not
    expect(limiter.consume().allowed).toBe(true);
    expect(limiter.consume().allowed).toBe(true);
    expect(limiter.consume().allowed).toBe(true);
    expect(limiter.consume().allowed).toBe(false);
  });

  it("remaining decreases with each consume", () => {
    const limiter = new ConnectionRateLimiter({ burstAllowance: 5, messagesPerSecond: 10 });
    const r1 = limiter.consume();
    const r2 = limiter.consume();
    expect(r2.remaining).toBeLessThan(r1.remaining);
  });
});

describe("RateLimiterRegistry", () => {
  it("creates and retrieves limiters by connection ID", () => {
    const registry = new RateLimiterRegistry();
    const limiter1 = registry.getOrCreate("conn-1");
    const limiter2 = registry.getOrCreate("conn-1");
    expect(limiter1).toBe(limiter2);
  });

  it("creates separate limiters for different connections", () => {
    const registry = new RateLimiterRegistry();
    const limiter1 = registry.getOrCreate("conn-1");
    const limiter2 = registry.getOrCreate("conn-2");
    expect(limiter1).not.toBe(limiter2);
  });

  it("removes limiters", () => {
    const registry = new RateLimiterRegistry();
    registry.getOrCreate("conn-1");
    expect(registry.size).toBe(1);
    expect(registry.remove("conn-1")).toBe(true);
    expect(registry.size).toBe(0);
    expect(registry.remove("conn-1")).toBe(false);
  });

  it("tracks connection count", () => {
    const registry = new RateLimiterRegistry();
    expect(registry.size).toBe(0);
    registry.getOrCreate("a");
    registry.getOrCreate("b");
    expect(registry.size).toBe(2);
  });

  it("clears all limiters", () => {
    const registry = new RateLimiterRegistry();
    registry.getOrCreate("a");
    registry.getOrCreate("b");
    registry.clear();
    expect(registry.size).toBe(0);
  });

  it("applies default config to new limiters", () => {
    const registry = new RateLimiterRegistry({ messagesPerSecond: 99 });
    const limiter = registry.getOrCreate("conn");
    expect(limiter.getConfig().messagesPerSecond).toBe(99);
  });

  it("updateDefaultConfig affects new connections only", () => {
    const registry = new RateLimiterRegistry({ messagesPerSecond: 10 });
    const existing = registry.getOrCreate("old");
    registry.updateDefaultConfig({ messagesPerSecond: 99 });
    const newLimiter = registry.getOrCreate("new");
    expect(existing.getConfig().messagesPerSecond).toBe(10);
    expect(newLimiter.getConfig().messagesPerSecond).toBe(99);
  });
});

describe("getGlobalRateLimiterRegistry", () => {
  afterEach(() => {
    resetGlobalRateLimiterRegistry();
  });

  it("returns a singleton registry", () => {
    const r1 = getGlobalRateLimiterRegistry();
    const r2 = getGlobalRateLimiterRegistry();
    expect(r1).toBe(r2);
  });

  it("applies config on first call", () => {
    const registry = getGlobalRateLimiterRegistry({ messagesPerSecond: 42 });
    const limiter = registry.getOrCreate("test");
    expect(limiter.getConfig().messagesPerSecond).toBe(42);
  });

  it("resetGlobalRateLimiterRegistry creates a fresh instance", () => {
    const r1 = getGlobalRateLimiterRegistry();
    r1.getOrCreate("conn");
    expect(r1.size).toBe(1);
    resetGlobalRateLimiterRegistry();
    const r2 = getGlobalRateLimiterRegistry();
    expect(r2.size).toBe(0);
    expect(r2).not.toBe(r1);
  });
});
