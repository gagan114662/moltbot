/**
 * Per-connection rate limiter using a sliding window token bucket algorithm.
 * Provides protection against DoS and abuse at the WebSocket connection level.
 */

export type RateLimiterConfig = {
  /** Maximum messages per second (default: 50). */
  messagesPerSecond: number;
  /** Burst allowance - extra messages allowed in short bursts (default: 100). */
  burstAllowance: number;
  /** Whether rate limiting is enabled (default: true). */
  enabled: boolean;
};

export const DEFAULT_RATE_LIMITER_CONFIG: RateLimiterConfig = {
  messagesPerSecond: 50,
  burstAllowance: 100,
  enabled: true,
};

export type RateLimitResult = {
  allowed: boolean;
  /** Current tokens remaining. */
  remaining: number;
  /** Milliseconds until a token is available (0 if allowed). */
  retryAfterMs: number;
  /** Current request rate (messages per second). */
  currentRate: number;
};

/**
 * Token bucket rate limiter with sliding window for smooth rate limiting.
 * Allows bursts up to `burstAllowance` while maintaining average rate of `messagesPerSecond`.
 */
export class ConnectionRateLimiter {
  private tokens: number;
  private lastRefillMs: number;
  private requestCount: number;
  private windowStartMs: number;
  private readonly config: RateLimiterConfig;

  constructor(config: Partial<RateLimiterConfig> = {}) {
    this.config = { ...DEFAULT_RATE_LIMITER_CONFIG, ...config };
    // Start with full burst allowance
    this.tokens = this.config.burstAllowance;
    this.lastRefillMs = Date.now();
    this.requestCount = 0;
    this.windowStartMs = Date.now();
  }

  /**
   * Check if a request should be allowed and consume a token if so.
   * @returns Result indicating if request is allowed and rate limit metadata.
   */
  consume(): RateLimitResult {
    if (!this.config.enabled) {
      return { allowed: true, remaining: Infinity, retryAfterMs: 0, currentRate: 0 };
    }

    const now = Date.now();
    this.refillTokens(now);
    this.updateRequestRate(now);

    if (this.tokens >= 1) {
      this.tokens -= 1;
      this.requestCount += 1;
      return {
        allowed: true,
        remaining: Math.floor(this.tokens),
        retryAfterMs: 0,
        currentRate: this.calculateCurrentRate(now),
      };
    }

    // Calculate time until next token is available
    const tokensPerMs = this.config.messagesPerSecond / 1000;
    const msUntilToken = tokensPerMs > 0 ? Math.ceil(1 / tokensPerMs) : 1000;

    return {
      allowed: false,
      remaining: 0,
      retryAfterMs: msUntilToken,
      currentRate: this.calculateCurrentRate(now),
    };
  }

  /**
   * Check if a request would be allowed without consuming a token.
   */
  peek(): RateLimitResult {
    if (!this.config.enabled) {
      return { allowed: true, remaining: Infinity, retryAfterMs: 0, currentRate: 0 };
    }

    const now = Date.now();
    // Calculate what tokens would be after refill (without mutating state)
    const elapsed = now - this.lastRefillMs;
    const tokensPerMs = this.config.messagesPerSecond / 1000;
    const newTokens = elapsed * tokensPerMs;
    const projectedTokens = Math.min(this.tokens + newTokens, this.config.burstAllowance);

    const allowed = projectedTokens >= 1;
    const msUntilToken = tokensPerMs > 0 ? Math.ceil((1 - projectedTokens) / tokensPerMs) : 1000;

    return {
      allowed,
      remaining: Math.floor(Math.max(0, projectedTokens)),
      retryAfterMs: allowed ? 0 : Math.max(0, msUntilToken),
      currentRate: this.calculateCurrentRate(now),
    };
  }

  /**
   * Reset the rate limiter state (e.g., after a period of inactivity).
   */
  reset(): void {
    this.tokens = this.config.burstAllowance;
    this.lastRefillMs = Date.now();
    this.requestCount = 0;
    this.windowStartMs = Date.now();
  }

  /**
   * Get current configuration.
   */
  getConfig(): Readonly<RateLimiterConfig> {
    return this.config;
  }

  /**
   * Update configuration at runtime.
   */
  updateConfig(config: Partial<RateLimiterConfig>): void {
    Object.assign(this.config, config);
    // Cap current tokens to new burst allowance
    if (this.tokens > this.config.burstAllowance) {
      this.tokens = this.config.burstAllowance;
    }
  }

  private refillTokens(now: number): void {
    const elapsed = now - this.lastRefillMs;
    if (elapsed <= 0) return;

    const tokensPerMs = this.config.messagesPerSecond / 1000;
    const newTokens = elapsed * tokensPerMs;
    this.tokens = Math.min(this.tokens + newTokens, this.config.burstAllowance);
    this.lastRefillMs = now;
  }

  private updateRequestRate(now: number): void {
    // Reset window every second for rate calculation
    const windowDuration = 1000;
    if (now - this.windowStartMs >= windowDuration) {
      this.requestCount = 0;
      this.windowStartMs = now;
    }
  }

  private calculateCurrentRate(now: number): number {
    const elapsed = now - this.windowStartMs;
    if (elapsed <= 0) return 0;
    return (this.requestCount / elapsed) * 1000;
  }
}

/**
 * Registry to manage rate limiters per connection.
 */
export class RateLimiterRegistry {
  private limiters = new Map<string, ConnectionRateLimiter>();
  private defaultConfig: Partial<RateLimiterConfig>;

  constructor(defaultConfig: Partial<RateLimiterConfig> = {}) {
    this.defaultConfig = defaultConfig;
  }

  /**
   * Get or create a rate limiter for a connection.
   */
  getOrCreate(connId: string): ConnectionRateLimiter {
    let limiter = this.limiters.get(connId);
    if (!limiter) {
      limiter = new ConnectionRateLimiter(this.defaultConfig);
      this.limiters.set(connId, limiter);
    }
    return limiter;
  }

  /**
   * Remove a rate limiter when connection closes.
   */
  remove(connId: string): boolean {
    return this.limiters.delete(connId);
  }

  /**
   * Update default config for new connections.
   */
  updateDefaultConfig(config: Partial<RateLimiterConfig>): void {
    this.defaultConfig = { ...this.defaultConfig, ...config };
  }

  /**
   * Get current connection count.
   */
  get size(): number {
    return this.limiters.size;
  }

  /**
   * Clear all limiters (for testing or shutdown).
   */
  clear(): void {
    this.limiters.clear();
  }
}

/**
 * Global rate limiter registry for the gateway.
 */
let globalRegistry: RateLimiterRegistry | null = null;

export function getGlobalRateLimiterRegistry(
  config?: Partial<RateLimiterConfig>,
): RateLimiterRegistry {
  if (!globalRegistry) {
    globalRegistry = new RateLimiterRegistry(config);
  } else if (config) {
    globalRegistry.updateDefaultConfig(config);
  }
  return globalRegistry;
}

export function resetGlobalRateLimiterRegistry(): void {
  globalRegistry?.clear();
  globalRegistry = null;
}
