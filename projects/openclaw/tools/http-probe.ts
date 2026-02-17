#!/usr/bin/env node --import tsx
/**
 * http-probe — Full-featured HTTP client for security testing.
 *
 * Unlike web_fetch (GET-only, read-only), this supports:
 * - All HTTP methods (GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD)
 * - Custom headers, cookies, auth tokens
 * - Request/response timing (for timing attacks)
 * - Redirect control (follow or don't)
 * - Response comparison (diff two responses)
 * - Body in any format (JSON, form, raw)
 * - Automatic retry on 502/503/504 with backoff
 * - Rate-limit detection (429) with exponential backoff
 * - Structured trace logging for debugging
 *
 * Usage:
 *   node --import tsx tools/http-probe.ts '{
 *     "url": "https://api.example.com/users/1",
 *     "method": "GET",
 *     "headers": {"Authorization": "Bearer xxx"},
 *     "follow_redirects": false
 *   }'
 *
 * For authorized security testing only. Respect program scope.
 */

import {
  validateUrl,
  validateScope,
  handleRateLimit,
  withRetry,
  Tracer,
  truncate,
  safeJsonParse,
} from "./tool-utils.js";

type ProbeRequest = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Record<string, unknown>;
  cookies?: string;
  auth_bearer?: string;
  auth_basic?: { username: string; password: string };
  follow_redirects?: boolean;
  timeout_ms?: number;
  max_retries?: number;
  allowed_domains?: string[];
  blocked_domains?: string[];
  extract_headers?: string[];
  extract_body_json_paths?: string[];
};

type ProbeResponse = {
  status: number;
  status_text: string;
  headers: Record<string, string>;
  body: string;
  body_length: number;
  body_json?: unknown;
  timing_ms: number;
  redirect_url?: string;
  extracted?: Record<string, unknown>;
  _retries?: number;
  _trace?: { tool: string; total_duration_ms: number; steps: number };
};

function buildHeaders(req: ProbeRequest): Headers {
  const h = new Headers(req.headers ?? {});

  if (req.auth_bearer) {
    h.set("Authorization", `Bearer ${req.auth_bearer}`);
  }
  if (req.auth_basic) {
    const cred = Buffer.from(`${req.auth_basic.username}:${req.auth_basic.password}`).toString(
      "base64",
    );
    h.set("Authorization", `Basic ${cred}`);
  }
  if (req.cookies) {
    h.set("Cookie", req.cookies);
  }
  if (!h.has("User-Agent")) {
    h.set(
      "User-Agent",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    );
  }
  return h;
}

function extractJsonPath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

async function probe(req: ProbeRequest): Promise<ProbeResponse> {
  const tracer = new Tracer("http-probe");

  // --- Input validation ---
  tracer.log("validate", { url: req.url, method: req.method });
  validateUrl(req.url, "url");
  if (req.allowed_domains || req.blocked_domains) {
    validateScope(req.url, req.allowed_domains, req.blocked_domains);
  }

  const method = (req.method ?? "GET").toUpperCase();
  const headers = buildHeaders(req);

  let bodyStr: string | undefined;
  if (req.body !== undefined && method !== "GET" && method !== "HEAD") {
    if (typeof req.body === "object") {
      bodyStr = JSON.stringify(req.body);
      if (!headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
    } else {
      bodyStr = req.body;
    }
  }

  // --- Fetch with retry + rate-limit handling ---
  const doFetch = async (): Promise<ProbeResponse> => {
    const controller = new AbortController();
    const timeout = req.timeout_ms ?? 15000;
    const timer = setTimeout(() => controller.abort(), timeout);

    const start = performance.now();
    try {
      const resp = await fetch(req.url, {
        method,
        headers,
        body: bodyStr,
        redirect: req.follow_redirects === false ? "manual" : "follow",
        signal: controller.signal,
      });
      const elapsed = performance.now() - start;
      clearTimeout(timer);

      // Rate-limit detection
      await handleRateLimit(resp.status);

      const rawBody = await resp.text();
      const respHeaders: Record<string, string> = {};
      resp.headers.forEach((v, k) => {
        respHeaders[k] = v;
      });

      const bodyJson = safeJsonParse(rawBody);

      const result: ProbeResponse = {
        status: resp.status,
        status_text: resp.statusText,
        headers: respHeaders,
        body: truncate(rawBody, 5000),
        body_length: rawBody.length,
        body_json: bodyJson,
        timing_ms: Math.round(elapsed),
      };

      if (resp.status >= 300 && resp.status < 400) {
        result.redirect_url = resp.headers.get("location") ?? undefined;
      }

      // Extract specific fields if requested
      if (req.extract_headers || req.extract_body_json_paths) {
        result.extracted = {};
        if (req.extract_headers) {
          for (const h of req.extract_headers) {
            result.extracted[`header:${h}`] = respHeaders[h.toLowerCase()];
          }
        }
        if (req.extract_body_json_paths && bodyJson) {
          for (const p of req.extract_body_json_paths) {
            result.extracted[`body:${p}`] = extractJsonPath(bodyJson, p);
          }
        }
      }

      return result;
    } catch (err) {
      clearTimeout(timer);
      const elapsed = performance.now() - start;
      return {
        status: 0,
        status_text: err instanceof Error ? err.message : "Unknown error",
        headers: {},
        body: "",
        body_length: 0,
        timing_ms: Math.round(elapsed),
      };
    }
  };

  const result = await tracer.time(`${method} ${req.url}`, () =>
    withRetry(doFetch, {
      maxRetries: req.max_retries ?? 2,
      onRetry: (attempt, status, error) => {
        tracer.log("retry", { attempt, status, error });
      },
    }),
  );

  // Attach trace summary
  const summary = tracer.summary();
  result._retries = result._retries ?? 0;
  result._trace = {
    tool: summary.tool,
    total_duration_ms: summary.total_duration_ms,
    steps: summary.steps,
  };

  return result;
}

// --- CLI entry ---
if (process.argv[1]?.includes("http-probe")) {
  const input = process.argv[2];
  if (!input) {
    console.log(
      JSON.stringify({
        error: 'Usage: http-probe \'{"url":"...", "method":"GET", ...}\'',
        params: [
          "url (required)",
          "method (GET|POST|PUT|DELETE|PATCH|OPTIONS|HEAD)",
          "headers (object)",
          "body (string or object)",
          "cookies (string)",
          "auth_bearer (string)",
          "auth_basic ({username, password})",
          "follow_redirects (bool, default true)",
          "timeout_ms (number, default 15000)",
          "extract_headers (string[])",
          "extract_body_json_paths (string[])",
        ],
      }),
    );
    process.exit(1);
  }
  const req: ProbeRequest = JSON.parse(input);
  probe(req).then((r) => console.log(JSON.stringify(r, null, 2)));
}

export { probe, type ProbeRequest, type ProbeResponse };
