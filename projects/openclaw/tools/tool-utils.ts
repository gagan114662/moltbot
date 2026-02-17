/**
 * tool-utils — Shared hardening utilities for all security tools.
 *
 * Implements DeepAgents principles:
 * 1. Input validation before network calls
 * 2. Rate-limit detection and exponential backoff
 * 3. Diagnostic retries (not blind)
 * 4. Structured error reporting
 * 5. Trace logging for debugging
 */

// --- Input Validation ---

export function validateUrl(url: string, label = "url"): void {
  if (!url || typeof url !== "string") {
    throw new Error(`${label} is required and must be a string`);
  }
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`${label} must use http or https protocol, got: ${parsed.protocol}`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes("protocol")) {
      throw e;
    }
    throw new Error(`${label} is not a valid URL: ${url}`, { cause: e });
  }
}

export function validateRequired(params: Record<string, unknown>, required: string[]): void {
  const missing = required.filter(
    (k) => params[k] === undefined || params[k] === null || params[k] === "",
  );
  if (missing.length > 0) {
    throw new Error(`Missing required parameters: ${missing.join(", ")}`);
  }
}

// --- Rate Limit Detection & Backoff ---

type RateLimitState = {
  consecutive429s: number;
  lastBackoffMs: number;
  totalRequests: number;
  totalBackoffMs: number;
};

const rateLimitState: RateLimitState = {
  consecutive429s: 0,
  lastBackoffMs: 0,
  totalRequests: 0,
  totalBackoffMs: 0,
};

export async function handleRateLimit(status: number): Promise<void> {
  rateLimitState.totalRequests++;

  if (status === 429) {
    rateLimitState.consecutive429s++;
    // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
    const backoff = Math.min(1000 * Math.pow(2, rateLimitState.consecutive429s - 1), 30000);
    rateLimitState.lastBackoffMs = backoff;
    rateLimitState.totalBackoffMs += backoff;

    if (rateLimitState.consecutive429s >= 5) {
      throw new Error(
        `Rate limited 5 times in a row. Total backoff: ${rateLimitState.totalBackoffMs}ms. ` +
          `Stop and increase delay_ms or reduce concurrency.`,
      );
    }

    console.error(
      `[rate-limit] 429 received (${rateLimitState.consecutive429s}/5). Backing off ${backoff}ms...`,
    );
    await sleep(backoff);
  } else {
    rateLimitState.consecutive429s = 0;
  }
}

export function getRateLimitStats(): RateLimitState {
  return { ...rateLimitState };
}

// --- Diagnostic Retry ---

type RetryOpts = {
  maxRetries?: number;
  retryableStatuses?: number[];
  onRetry?: (attempt: number, status: number, error?: string) => void;
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOpts = {},
): Promise<T & { _retries?: number }> {
  const maxRetries = opts.maxRetries ?? 2;
  const retryable = opts.retryableStatuses ?? [502, 503, 504];
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();

      // Check if result has a status field indicating retryable error
      const status = (result as Record<string, unknown>)?.status;
      if (typeof status === "number" && retryable.includes(status) && attempt < maxRetries) {
        const backoff = 1000 * (attempt + 1);
        opts.onRetry?.(attempt + 1, status);
        console.error(
          `[retry] Status ${status} is retryable. Attempt ${attempt + 1}/${maxRetries}. Waiting ${backoff}ms...`,
        );
        await sleep(backoff);
        continue;
      }

      // Handle rate limiting
      if (typeof status === "number") {
        await handleRateLimit(status);
      }

      return { ...result, _retries: attempt } as T & { _retries?: number };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt < maxRetries) {
        const backoff = 1000 * (attempt + 1);
        opts.onRetry?.(attempt + 1, 0, lastError.message);
        console.error(
          `[retry] Error: ${lastError.message}. Attempt ${attempt + 1}/${maxRetries}. Waiting ${backoff}ms...`,
        );
        await sleep(backoff);
      }
    }
  }

  throw lastError ?? new Error("All retries exhausted");
}

// --- Trace Logging ---

type TraceEntry = {
  timestamp: string;
  action: string;
  duration_ms?: number;
  details?: unknown;
};

export class Tracer {
  private entries: TraceEntry[] = [];
  private startTime: number;

  constructor(private toolName: string) {
    this.startTime = Date.now();
  }

  log(action: string, details?: unknown): void {
    this.entries.push({
      timestamp: new Date().toISOString(),
      action,
      details,
    });
  }

  async time<T>(action: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      const result = await fn();
      this.entries.push({
        timestamp: new Date().toISOString(),
        action,
        duration_ms: Math.round(performance.now() - start),
        details: { status: "ok" },
      });
      return result;
    } catch (err) {
      this.entries.push({
        timestamp: new Date().toISOString(),
        action,
        duration_ms: Math.round(performance.now() - start),
        details: { status: "error", error: (err as Error).message },
      });
      throw err;
    }
  }

  summary(): {
    tool: string;
    total_duration_ms: number;
    steps: number;
    trace: TraceEntry[];
    rate_limit_stats: RateLimitState;
  } {
    return {
      tool: this.toolName,
      total_duration_ms: Date.now() - this.startTime,
      steps: this.entries.length,
      trace: this.entries,
      rate_limit_stats: getRateLimitStats(),
    };
  }
}

// --- Scope Validation ---

export function validateScope(
  url: string,
  allowedDomains?: string[],
  blockedDomains?: string[],
): void {
  const hostname = new URL(url).hostname;

  if (blockedDomains?.length) {
    for (const blocked of blockedDomains) {
      if (hostname === blocked || hostname.endsWith(`.${blocked}`)) {
        throw new Error(`Domain ${hostname} is blocked (matches ${blocked}). Check program scope.`);
      }
    }
  }

  if (allowedDomains?.length) {
    const allowed = allowedDomains.some((d) => hostname === d || hostname.endsWith(`.${d}`));
    if (!allowed) {
      throw new Error(`Domain ${hostname} is not in allowed scope: ${allowedDomains.join(", ")}`);
    }
  }
}

// --- Response Diffing ---

export function diffResponses(
  a: { status: number; body_length: number; body: string; timing_ms: number },
  b: { status: number; body_length: number; body: string; timing_ms: number },
): {
  same: boolean;
  differences: string[];
} {
  const diffs: string[] = [];

  if (a.status !== b.status) {
    diffs.push(`status: ${a.status} vs ${b.status}`);
  }
  if (Math.abs(a.body_length - b.body_length) > 10) {
    diffs.push(`body_length: ${a.body_length} vs ${b.body_length}`);
  }
  if (a.body !== b.body) {
    // Find first difference
    for (let i = 0; i < Math.min(a.body.length, b.body.length); i++) {
      if (a.body[i] !== b.body[i]) {
        diffs.push(
          `body differs at char ${i}: "${a.body.slice(i, i + 30)}..." vs "${b.body.slice(i, i + 30)}..."`,
        );
        break;
      }
    }
  }
  if (Math.abs(a.timing_ms - b.timing_ms) > a.timing_ms * 2) {
    diffs.push(
      `timing: ${a.timing_ms}ms vs ${b.timing_ms}ms (${Math.round((b.timing_ms / a.timing_ms) * 100)}% ratio)`,
    );
  }

  return { same: diffs.length === 0, differences: diffs };
}

// --- Helpers ---

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function truncate(s: string, max = 500): string {
  return s.length > max ? s.slice(0, max) + "...[truncated]" : s;
}

export function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
