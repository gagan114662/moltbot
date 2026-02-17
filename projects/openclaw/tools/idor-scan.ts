#!/usr/bin/env node --import tsx
/**
 * idor-scan — Detect Insecure Direct Object References.
 *
 * The #1 most common payable bug in bounty programs.
 * Tests whether authenticated user A can access user B's resources
 * by swapping object IDs in API endpoints.
 *
 * Strategies:
 * 1. ID enumeration — try sequential/random IDs on an endpoint
 * 2. Auth swap — replay request with a different user's token
 * 3. Downgrade — try the request with no auth at all
 *
 * Usage:
 *   node --import tsx tools/idor-scan.ts '{
 *     "base_url": "https://api.example.com",
 *     "endpoint": "/api/v1/users/{id}/profile",
 *     "method": "GET",
 *     "own_id": "42",
 *     "test_ids": ["1", "2", "3", "100", "admin"],
 *     "auth_token": "Bearer eyJ...",
 *     "victim_token": "Bearer eyJ...",
 *     "headers": {"X-Custom": "value"}
 *   }'
 */

import { probe, type ProbeRequest } from "./http-probe.js";
import { validateUrl, validateRequired, Tracer, sleep } from "./tool-utils.js";

type IDORConfig = {
  base_url: string;
  endpoint: string; // must contain {id} placeholder
  method?: string;
  own_id: string;
  test_ids?: string[];
  id_range?: [number, number]; // [start, end] inclusive
  auth_token?: string; // user A's token
  victim_token?: string; // user B's token (for auth swap test)
  headers?: Record<string, string>;
  cookies?: string;
  concurrency?: number; // max parallel requests (default 5)
  delay_ms?: number; // delay between batches (default 100)
};

type IDORFinding = {
  type: "idor_id_access" | "idor_auth_swap" | "idor_no_auth";
  id: string;
  status: number;
  body_length: number;
  body_preview: string;
  timing_ms: number;
  severity: "critical" | "high" | "medium" | "info";
};

type IDORResult = {
  target: string;
  endpoint: string;
  total_tested: number;
  baseline: {
    own_id: string;
    status: number;
    body_length: number;
    body_preview: string;
  };
  findings: IDORFinding[];
  summary: string;
};

function buildUrl(base: string, endpoint: string, id: string): string {
  const path = endpoint.replace("{id}", encodeURIComponent(id));
  return `${base.replace(/\/$/, "")}${path}`;
}

async function runBatch<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    await Promise.all(batch.map(fn));
  }
}

async function scan(config: IDORConfig): Promise<IDORResult> {
  // --- Input validation ---
  validateRequired(config as unknown as Record<string, unknown>, [
    "base_url",
    "endpoint",
    "own_id",
  ]);
  validateUrl(config.base_url, "base_url");
  if (!config.endpoint.includes("{id}")) {
    throw new Error("endpoint must contain {id} placeholder");
  }

  const tracer = new Tracer("idor-scan");
  tracer.log("start", {
    base_url: config.base_url,
    endpoint: config.endpoint,
    own_id: config.own_id,
  });

  const method = config.method ?? "GET";
  const concurrency = config.concurrency ?? 5;
  const delay = config.delay_ms ?? 100;

  const baseHeaders: Record<string, string> = { ...config.headers };
  if (config.auth_token) {
    if (config.auth_token.startsWith("Bearer ")) {
      baseHeaders["Authorization"] = config.auth_token;
    } else {
      baseHeaders["Authorization"] = `Bearer ${config.auth_token}`;
    }
  }

  // Step 1: Baseline — request own resource
  const ownUrl = buildUrl(config.base_url, config.endpoint, config.own_id);
  const baseline = await probe({
    url: ownUrl,
    method,
    headers: baseHeaders,
    cookies: config.cookies,
  });

  const result: IDORResult = {
    target: config.base_url,
    endpoint: config.endpoint,
    total_tested: 0,
    baseline: {
      own_id: config.own_id,
      status: baseline.status,
      body_length: baseline.body_length,
      body_preview: baseline.body.slice(0, 200),
    },
    findings: [],
    summary: "",
  };

  if (baseline.status >= 400) {
    result.summary = `Baseline request failed with ${baseline.status}. Check your auth token and own_id.`;
    return result;
  }

  // Build ID list
  const testIds: string[] = [];
  if (config.test_ids) {
    testIds.push(...config.test_ids);
  }
  if (config.id_range) {
    const [start, end] = config.id_range;
    for (let i = start; i <= Math.min(end, start + 500); i++) {
      testIds.push(String(i));
    }
  }
  // Filter out own ID
  const ids = testIds.filter((id) => id !== config.own_id);

  // Step 2: Test each ID with own auth token
  const findings: IDORFinding[] = [];

  await runBatch(ids, concurrency, async (id) => {
    const url = buildUrl(config.base_url, config.endpoint, id);
    const resp = await probe({
      url,
      method,
      headers: baseHeaders,
      cookies: config.cookies,
    });
    result.total_tested++;

    // If we get a 200 on someone else's resource, that's an IDOR
    if (resp.status >= 200 && resp.status < 300) {
      // Check it's actually different data (not just a generic response)
      const isDifferentData = resp.body !== baseline.body || resp.body_length > 10;
      if (isDifferentData) {
        findings.push({
          type: "idor_id_access",
          id,
          status: resp.status,
          body_length: resp.body_length,
          body_preview: resp.body.slice(0, 300),
          timing_ms: resp.timing_ms,
          severity: resp.body_length > 100 ? "critical" : "high",
        });
      }
    }
    if (delay > 0) {
      await sleep(delay / concurrency);
    }
  });

  // Step 3: Auth swap test — access own resource with victim's token
  if (config.victim_token) {
    const swapHeaders: Record<string, string> = { ...config.headers };
    if (config.victim_token.startsWith("Bearer ")) {
      swapHeaders["Authorization"] = config.victim_token;
    } else {
      swapHeaders["Authorization"] = `Bearer ${config.victim_token}`;
    }

    const swapResp = await probe({
      url: ownUrl,
      method,
      headers: swapHeaders,
      cookies: config.cookies,
    });
    result.total_tested++;

    if (swapResp.status >= 200 && swapResp.status < 300) {
      findings.push({
        type: "idor_auth_swap",
        id: config.own_id,
        status: swapResp.status,
        body_length: swapResp.body_length,
        body_preview: swapResp.body.slice(0, 300),
        timing_ms: swapResp.timing_ms,
        severity: "critical",
      });
    }
  }

  // Step 4: No-auth test — access own resource with no auth
  const noAuthHeaders: Record<string, string> = { ...config.headers };
  delete noAuthHeaders["Authorization"];
  const noAuthResp = await probe({
    url: ownUrl,
    method,
    headers: noAuthHeaders,
  });
  result.total_tested++;

  if (noAuthResp.status >= 200 && noAuthResp.status < 300) {
    findings.push({
      type: "idor_no_auth",
      id: config.own_id,
      status: noAuthResp.status,
      body_length: noAuthResp.body_length,
      body_preview: noAuthResp.body.slice(0, 300),
      timing_ms: noAuthResp.timing_ms,
      severity: "critical",
    });
  }

  result.findings = findings;
  const critCount = findings.filter((f) => f.severity === "critical").length;
  const highCount = findings.filter((f) => f.severity === "high").length;
  result.summary =
    findings.length === 0
      ? `No IDOR found. Tested ${result.total_tested} requests.`
      : `FOUND ${findings.length} IDOR(s): ${critCount} critical, ${highCount} high. Tested ${result.total_tested} requests.`;

  tracer.log("complete", { findings: findings.length, total_tested: result.total_tested });
  (result as Record<string, unknown>)._trace = tracer.summary();

  return result;
}

// --- CLI entry ---
if (process.argv[1]?.includes("idor-scan")) {
  const input = process.argv[2];
  if (!input) {
    console.log(
      JSON.stringify({
        error:
          'Usage: idor-scan \'{"base_url":"...", "endpoint":"/api/users/{id}/profile", "own_id":"42", ...}\'',
        params: [
          "base_url (required) — target API base URL",
          "endpoint (required) — path with {id} placeholder",
          "own_id (required) — your own user/object ID",
          "method (GET|POST|PUT|DELETE, default GET)",
          "test_ids (string[]) — specific IDs to test",
          "id_range ([start, end]) — numeric range to test (max 500)",
          "auth_token — your auth token",
          "victim_token — another user's token (for auth swap test)",
          "headers (object) — additional headers",
          "cookies (string) — cookie header value",
          "concurrency (number, default 5)",
          "delay_ms (number, default 100) — delay between batches",
        ],
      }),
    );
    process.exit(1);
  }
  const config: IDORConfig = JSON.parse(input);
  scan(config).then((r) => console.log(JSON.stringify(r, null, 2)));
}

export { scan, type IDORConfig, type IDORResult };
