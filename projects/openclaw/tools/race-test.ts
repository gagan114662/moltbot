#!/usr/bin/env node --import tsx
/**
 * race-test — Race condition / TOCTOU vulnerability tester.
 *
 * Fires N identical requests simultaneously to detect:
 * - Double-spend (payment processed twice)
 * - Double-claim (coupon/reward used twice)
 * - Counter bypass (rate limit, vote manipulation)
 * - State corruption (concurrent updates)
 *
 * The key is TRUE concurrency: all requests hit the wire at the same instant.
 * Uses Promise.all with pre-built request objects for minimal delay between sends.
 *
 * Usage:
 *   node --import tsx tools/race-test.ts '{
 *     "url": "https://api.example.com/redeem-coupon",
 *     "method": "POST",
 *     "body": {"coupon_code": "SAVE50"},
 *     "auth_token": "Bearer eyJ...",
 *     "concurrency": 20,
 *     "rounds": 3
 *   }'
 */

import { validateUrl, validateRequired, Tracer, sleep } from "./tool-utils.js";

type RaceConfig = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Record<string, unknown>;
  auth_token?: string;
  cookies?: string;
  concurrency?: number; // requests per round (default 10)
  rounds?: number; // number of rounds (default 1)
  delay_between_rounds_ms?: number; // delay between rounds (default 1000)
  success_indicator?: string; // string to look for in response body indicating success
  check_url?: string; // URL to GET after each round to check state
  check_auth_token?: string; // auth for check URL (defaults to auth_token)
};

type RaceRoundResult = {
  round: number;
  responses: {
    index: number;
    status: number;
    body_preview: string;
    body_length: number;
    timing_ms: number;
    contains_success: boolean;
  }[];
  successes: number;
  unique_statuses: number[];
  unique_body_lengths: number[];
  state_check?: {
    status: number;
    body_preview: string;
  };
};

type RaceResult = {
  target: string;
  method: string;
  concurrency: number;
  rounds: RaceRoundResult[];
  vulnerability_detected: boolean;
  evidence: string;
  summary: string;
};

function buildFetchInit(config: RaceConfig): RequestInit {
  const method = (config.method ?? "POST").toUpperCase();
  const headers: Record<string, string> = { ...config.headers };

  if (config.auth_token) {
    headers["Authorization"] = config.auth_token.startsWith("Bearer ")
      ? config.auth_token
      : `Bearer ${config.auth_token}`;
  }
  if (config.cookies) {
    headers["Cookie"] = config.cookies;
  }
  if (!headers["User-Agent"]) {
    headers["User-Agent"] = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
  }

  let body: string | undefined;
  if (config.body !== undefined && method !== "GET" && method !== "HEAD") {
    if (typeof config.body === "object") {
      body = JSON.stringify(config.body);
      if (!headers["Content-Type"]) {
        headers["Content-Type"] = "application/json";
      }
    } else {
      body = config.body;
    }
  }

  return { method, headers, body, redirect: "follow" };
}

async function fireRound(config: RaceConfig, roundNum: number): Promise<RaceRoundResult> {
  const concurrency = config.concurrency ?? 10;
  const init = buildFetchInit(config);
  const successStr = config.success_indicator?.toLowerCase();

  // Pre-create all fetch promises, then fire them all at once
  const _batchStart = performance.now();
  const promises = Array.from({ length: concurrency }, (_, i) => {
    const reqStart = performance.now();
    return fetch(config.url, { ...init })
      .then(async (resp) => {
        const bodyText = await resp.text();
        const elapsed = performance.now() - reqStart;
        return {
          index: i,
          status: resp.status,
          body_preview: bodyText.slice(0, 500),
          body_length: bodyText.length,
          timing_ms: Math.round(elapsed),
          contains_success: successStr
            ? bodyText.toLowerCase().includes(successStr)
            : resp.status >= 200 && resp.status < 300,
        };
      })
      .catch((err) => ({
        index: i,
        status: 0,
        body_preview: err instanceof Error ? err.message : "error",
        body_length: 0,
        timing_ms: Math.round(performance.now() - reqStart),
        contains_success: false,
      }));
  });

  const responses = await Promise.all(promises);
  responses.sort((a, b) => a.index - b.index);

  const result: RaceRoundResult = {
    round: roundNum,
    responses,
    successes: responses.filter((r) => r.contains_success).length,
    unique_statuses: [...new Set(responses.map((r) => r.status))],
    unique_body_lengths: [...new Set(responses.map((r) => r.body_length))],
  };

  // Optional state check after the round
  if (config.check_url) {
    try {
      const checkHeaders: Record<string, string> = {};
      const checkToken = config.check_auth_token ?? config.auth_token;
      if (checkToken) {
        checkHeaders["Authorization"] = checkToken.startsWith("Bearer ")
          ? checkToken
          : `Bearer ${checkToken}`;
      }
      const checkResp = await fetch(config.check_url, {
        method: "GET",
        headers: checkHeaders,
      });
      const checkBody = await checkResp.text();
      result.state_check = {
        status: checkResp.status,
        body_preview: checkBody.slice(0, 500),
      };
    } catch {
      // check failed, not critical
    }
  }

  return result;
}

async function raceTest(config: RaceConfig): Promise<RaceResult> {
  // --- Input validation ---
  validateRequired(config as unknown as Record<string, unknown>, ["url"]);
  validateUrl(config.url, "url");

  const tracer = new Tracer("race-test");
  tracer.log("start", { url: config.url, concurrency: config.concurrency, rounds: config.rounds });

  const concurrency = config.concurrency ?? 10;
  const rounds = config.rounds ?? 1;
  const delay = config.delay_between_rounds_ms ?? 1000;

  const result: RaceResult = {
    target: config.url,
    method: (config.method ?? "POST").toUpperCase(),
    concurrency,
    rounds: [],
    vulnerability_detected: false,
    evidence: "",
    summary: "",
  };

  for (let r = 0; r < rounds; r++) {
    const roundResult = await fireRound(config, r + 1);
    result.rounds.push(roundResult);

    // Detect race condition: if more than 1 request "succeeded" for an
    // action that should only succeed once
    if (roundResult.successes > 1) {
      result.vulnerability_detected = true;
      result.evidence += `Round ${r + 1}: ${roundResult.successes}/${concurrency} requests succeeded (expected max 1). `;
    }

    // Also flag if responses differ significantly (state corruption)
    if (roundResult.unique_body_lengths.length > 2) {
      result.evidence += `Round ${r + 1}: ${roundResult.unique_body_lengths.length} different response sizes detected. `;
    }

    if (r < rounds - 1) {
      await sleep(delay);
    }
  }

  if (result.vulnerability_detected) {
    result.summary = `RACE CONDITION DETECTED: ${result.evidence}`;
  } else {
    const totalSuccesses = result.rounds.reduce((s, r) => s + r.successes, 0);
    result.summary = `No race condition detected. ${totalSuccesses} total successes across ${rounds} rounds of ${concurrency} concurrent requests.`;
  }

  tracer.log("complete", {
    vulnerability: result.vulnerability_detected,
    rounds: result.rounds.length,
  });
  (result as Record<string, unknown>)._trace = tracer.summary();

  return result;
}

// --- CLI entry ---
if (process.argv[1]?.includes("race-test")) {
  const input = process.argv[2];
  if (!input) {
    console.log(
      JSON.stringify({
        error:
          'Usage: race-test \'{"url":"...", "method":"POST", "body":{...}, "concurrency": 10}\'',
        params: [
          "url (required) — target endpoint",
          "method (POST|PUT|DELETE, default POST)",
          "body (string or object) — request body",
          "auth_token — Bearer token",
          "cookies — cookie header",
          "headers (object) — additional headers",
          "concurrency (number, default 10) — simultaneous requests per round",
          "rounds (number, default 1) — number of test rounds",
          "delay_between_rounds_ms (number, default 1000)",
          "success_indicator — string to look for in response body",
          "check_url — GET this URL after each round to verify state",
          "check_auth_token — auth for check_url",
        ],
      }),
    );
    process.exit(1);
  }
  const config: RaceConfig = JSON.parse(input);
  raceTest(config).then((r) => console.log(JSON.stringify(r, null, 2)));
}

export { raceTest, type RaceConfig, type RaceResult };
