#!/usr/bin/env node --import tsx
/**
 * endpoint-extract — Extract API endpoints from web app JavaScript bundles.
 *
 * Scanners can't find logic bugs if they don't know the attack surface.
 * This tool:
 * 1. Fetches the target web app HTML
 * 2. Finds all JS bundle URLs (<script src="...">)
 * 3. Downloads each bundle
 * 4. Extracts API endpoint patterns, GraphQL operations, and internal routes
 * 5. Reports discovered attack surface
 *
 * Also extracts:
 * - API keys and tokens left in client code
 * - WebSocket URLs
 * - Internal/staging hostnames
 * - GraphQL queries and mutations
 * - Environment variables baked into bundles
 *
 * Usage:
 *   node --import tsx tools/endpoint-extract.ts '{
 *     "url": "https://app.example.com",
 *     "include_external": false,
 *     "max_bundles": 20
 *   }'
 */

import { validateUrl, Tracer } from "./tool-utils.js";

type ExtractConfig = {
  url: string;
  include_external?: boolean; // include scripts from different domains
  max_bundles?: number; // max JS files to download (default 20)
  custom_patterns?: string[]; // additional regex patterns to search for
};

type Endpoint = {
  path: string;
  method?: string;
  source_file: string;
  context: string; // surrounding code for manual review
};

type Secret = {
  type: "api_key" | "token" | "password" | "internal_url" | "env_var" | "websocket";
  value: string;
  source_file: string;
  context: string;
};

type GraphQLOp = {
  type: "query" | "mutation" | "subscription";
  name: string;
  source_file: string;
  context: string;
};

type ExtractResult = {
  target: string;
  bundles_found: number;
  bundles_analyzed: number;
  endpoints: Endpoint[];
  secrets: Secret[];
  graphql_ops: GraphQLOp[];
  internal_hosts: string[];
  summary: string;
};

// Regex patterns for finding API endpoints in JS bundles
const ENDPOINT_PATTERNS = [
  // REST API paths: "/api/v1/users", "/v2/accounts"
  /["'`](\/(?:api|v[0-9]+|rest|graphql|auth|oauth|admin|internal|private|ws|webhook)[^"'`\s]{2,80})["'`]/g,
  // Fetch/axios calls: fetch("/users"), axios.get("/products")
  /(?:fetch|axios|http|request|api|client)\s*[.(]\s*["'`](\/[a-zA-Z][^"'`\s]{2,80})["'`]/g,
  // URL path construction: baseUrl + "/users/" + id
  /["'`](\/[a-z][a-z0-9_-]*(?:\/[a-z][a-z0-9_-]*){1,6}(?:\/:\w+)?)["'`]/g,
  // Route definitions: path: "/dashboard", route: "/settings"
  /(?:path|route|url|endpoint|uri)\s*[:=]\s*["'`](\/[a-zA-Z][^"'`\s]{2,80})["'`]/g,
];

// Patterns for HTTP methods near endpoints
const METHOD_PATTERNS = [
  /(?:method|type)\s*[:=]\s*["'`](GET|POST|PUT|DELETE|PATCH|OPTIONS)["'`]/gi,
  /\.(get|post|put|delete|patch|options)\s*\(/gi,
  /fetch\s*\([^)]*method\s*:\s*["'`](GET|POST|PUT|DELETE|PATCH)["'`]/gi,
];

// Patterns for sensitive data in JS bundles
const SECRET_PATTERNS: { type: Secret["type"]; pattern: RegExp }[] = [
  // API keys (generic)
  {
    type: "api_key",
    pattern:
      /["'`](?:api[_-]?key|apikey|api[_-]?secret|access[_-]?key)\s*["'`]\s*[:=]\s*["'`]([a-zA-Z0-9_\-./+=]{16,128})["'`]/gi,
  },
  // AWS keys
  {
    type: "api_key",
    pattern: /["'`](AKIA[0-9A-Z]{16})["'`]/g,
  },
  // Google API keys
  {
    type: "api_key",
    pattern: /["'`](AIza[0-9A-Za-z_-]{35})["'`]/g,
  },
  // Stripe keys
  {
    type: "api_key",
    pattern: /["'`]((?:sk|pk)_(?:test|live)_[0-9a-zA-Z]{24,})["'`]/g,
  },
  // JWT tokens
  {
    type: "token",
    pattern: /["'`](eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})["'`]/g,
  },
  // Internal URLs / staging hostnames
  {
    type: "internal_url",
    pattern:
      /["'`](https?:\/\/(?:localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|[\w.-]+\.(?:internal|local|dev|staging|test|corp)(?:\.[\w.-]+)*)(?::\d+)?(?:\/[^"'`\s]*)?)["'`]/gi,
  },
  // WebSocket URLs
  {
    type: "websocket",
    pattern: /["'`](wss?:\/\/[^"'`\s]{5,120})["'`]/g,
  },
  // Hardcoded passwords
  {
    type: "password",
    pattern: /["'`](?:password|passwd|secret)\s*["'`]\s*[:=]\s*["'`]([^"'`]{4,64})["'`]/gi,
  },
  // Environment variables baked in
  {
    type: "env_var",
    pattern: /(?:process\.env|import\.meta\.env)\.\s*([A-Z_][A-Z0-9_]{2,40})/g,
  },
];

// GraphQL patterns
const GRAPHQL_PATTERNS = [
  /(?:query|mutation|subscription)\s+(\w+)\s*[({]/g,
  /gql\s*`\s*(?:query|mutation|subscription)\s+(\w+)/g,
];

function extractFromBundle(
  content: string,
  sourceFile: string,
): {
  endpoints: Endpoint[];
  secrets: Secret[];
  graphql: GraphQLOp[];
} {
  const endpoints: Endpoint[] = [];
  const secrets: Secret[] = [];
  const graphql: GraphQLOp[] = [];
  const seenPaths = new Set<string>();
  const seenSecrets = new Set<string>();

  // Extract endpoints
  for (const pattern of ENDPOINT_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const path = match[1];
      if (seenPaths.has(path)) {
        continue;
      }
      // Filter noise
      if (
        path.length < 4 ||
        path.includes("webpack") ||
        path.includes("node_modules") ||
        path.match(/\.(js|css|png|jpg|svg|ico|woff|map)$/)
      ) {
        continue;
      }
      seenPaths.add(path);

      // Try to find nearby HTTP method
      const contextStart = Math.max(0, match.index - 100);
      const contextEnd = Math.min(content.length, match.index + path.length + 100);
      const context = content.slice(contextStart, contextEnd);

      let method: string | undefined;
      for (const mp of METHOD_PATTERNS) {
        const methodRegex = new RegExp(mp.source, mp.flags);
        const methodMatch = methodRegex.exec(context);
        if (methodMatch) {
          method = methodMatch[1].toUpperCase();
          break;
        }
      }

      endpoints.push({
        path,
        method,
        source_file: sourceFile,
        context: context.replace(/\s+/g, " ").trim(),
      });
    }
  }

  // Extract secrets
  for (const { type, pattern } of SECRET_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const value = match[1];
      if (seenSecrets.has(value)) {
        continue;
      }
      if (value.length < 4) {
        continue;
      }
      // Skip obvious placeholders
      if (value.match(/^(xxx|your|example|test|dummy|placeholder|changeme|todo)/i)) {
        continue;
      }
      seenSecrets.add(value);

      const contextStart = Math.max(0, match.index - 50);
      const contextEnd = Math.min(content.length, match.index + value.length + 50);

      secrets.push({
        type,
        value: type === "password" ? value.slice(0, 4) + "****" : value,
        source_file: sourceFile,
        context: content.slice(contextStart, contextEnd).replace(/\s+/g, " ").trim(),
      });
    }
  }

  // Extract GraphQL operations
  for (const pattern of GRAPHQL_PATTERNS) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const name = match[1];
      const contextStart = Math.max(0, match.index - 20);
      const contextEnd = Math.min(content.length, match.index + 200);
      const context = content.slice(contextStart, contextEnd);
      const type = context.includes("mutation")
        ? "mutation"
        : context.includes("subscription")
          ? "subscription"
          : "query";
      graphql.push({
        type: type as GraphQLOp["type"],
        name,
        source_file: sourceFile,
        context: context.replace(/\s+/g, " ").trim().slice(0, 200),
      });
    }
  }

  return { endpoints, secrets, graphql };
}

async function extractEndpoints(config: ExtractConfig): Promise<ExtractResult> {
  // --- Input validation ---
  validateUrl(config.url, "url");

  const tracer = new Tracer("endpoint-extract");
  tracer.log("start", { url: config.url });

  const maxBundles = config.max_bundles ?? 20;
  const targetOrigin = new URL(config.url).origin;

  const result: ExtractResult = {
    target: config.url,
    bundles_found: 0,
    bundles_analyzed: 0,
    endpoints: [],
    secrets: [],
    graphql_ops: [],
    internal_hosts: [],
    summary: "",
  };

  // Step 1: Fetch the main page
  let html: string;
  try {
    const resp = await fetch(config.url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    html = await resp.text();
  } catch (err) {
    result.summary = `Failed to fetch ${config.url}: ${err instanceof Error ? err.message : "unknown error"}`;
    return result;
  }

  // Step 2: Find all script tags
  const scriptPattern = /<script[^>]+src\s*=\s*["']([^"']+)["']/gi;
  const scriptUrls: string[] = [];
  let scriptMatch: RegExpExecArray | null;
  while ((scriptMatch = scriptPattern.exec(html)) !== null) {
    let src = scriptMatch[1];
    // Resolve relative URLs
    if (src.startsWith("//")) {
      src = "https:" + src;
    } else if (src.startsWith("/")) {
      src = targetOrigin + src;
    } else if (!src.startsWith("http")) {
      const base = config.url.replace(/\/[^/]*$/, "/");
      src = base + src;
    }
    // Filter external scripts unless requested
    if (!config.include_external && !src.startsWith(targetOrigin)) {
      continue;
    }
    scriptUrls.push(src);
  }

  // Also extract inline scripts
  const inlinePattern = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let inlineMatch: RegExpExecArray | null;
  const inlineScripts: string[] = [];
  while ((inlineMatch = inlinePattern.exec(html)) !== null) {
    const content = inlineMatch[1].trim();
    if (content.length > 50) {
      inlineScripts.push(content);
    }
  }

  result.bundles_found = scriptUrls.length + inlineScripts.length;

  // Step 3: Download and analyze each bundle
  const bundlesToAnalyze = scriptUrls.slice(0, maxBundles);

  // Process bundles in parallel (batches of 5)
  for (let i = 0; i < bundlesToAnalyze.length; i += 5) {
    const batch = bundlesToAnalyze.slice(i, i + 5);
    const results = await Promise.all(
      batch.map(async (url) => {
        try {
          const resp = await fetch(url, {
            headers: { "User-Agent": "Mozilla/5.0" },
          });
          if (!resp.ok) {
            return null;
          }
          const text = await resp.text();
          return { url, text };
        } catch {
          return null;
        }
      }),
    );

    for (const r of results) {
      if (!r) {
        continue;
      }
      result.bundles_analyzed++;
      const extracted = extractFromBundle(r.text, r.url);
      result.endpoints.push(...extracted.endpoints);
      result.secrets.push(...extracted.secrets);
      result.graphql_ops.push(...extracted.graphql);
    }
  }

  // Step 4: Analyze inline scripts
  for (const script of inlineScripts) {
    result.bundles_analyzed++;
    const extracted = extractFromBundle(script, "inline-script");
    result.endpoints.push(...extracted.endpoints);
    result.secrets.push(...extracted.secrets);
    result.graphql_ops.push(...extracted.graphql);
  }

  // Also analyze the HTML itself for data attributes, form actions, etc.
  const formActions = [...html.matchAll(/action\s*=\s*["']([^"']+)["']/gi)];
  for (const m of formActions) {
    result.endpoints.push({
      path: m[1],
      method: "POST",
      source_file: "html-form",
      context: html.slice(Math.max(0, m.index! - 50), m.index! + 100).replace(/\s+/g, " "),
    });
  }

  // Deduplicate endpoints by path
  const uniqueEndpoints = new Map<string, Endpoint>();
  for (const ep of result.endpoints) {
    const key = `${ep.method ?? "?"}:${ep.path}`;
    if (!uniqueEndpoints.has(key)) {
      uniqueEndpoints.set(key, ep);
    }
  }
  result.endpoints = [...uniqueEndpoints.values()];

  // Extract internal hostnames
  const hostPattern =
    /["'`](https?:\/\/[\w.-]+\.(?:internal|local|dev|staging|test|corp)[\w.-]*)["'`]/gi;
  const hostsSeen = new Set<string>();
  for (const ep of result.secrets.filter((s) => s.type === "internal_url")) {
    try {
      const host = new URL(ep.value).hostname;
      if (!hostsSeen.has(host)) {
        hostsSeen.add(host);
        result.internal_hosts.push(host);
      }
    } catch {
      // invalid URL
    }
  }

  result.summary = [
    `Analyzed ${result.bundles_analyzed}/${result.bundles_found} bundles.`,
    `Found ${result.endpoints.length} API endpoints,`,
    `${result.secrets.length} secrets/keys,`,
    `${result.graphql_ops.length} GraphQL operations,`,
    `${result.internal_hosts.length} internal hostnames.`,
  ].join(" ");

  tracer.log("complete", {
    endpoints: result.endpoints.length,
    secrets: result.secrets.length,
    bundles: result.bundles_analyzed,
  });
  (result as Record<string, unknown>)._trace = tracer.summary();

  return result;
}

// --- CLI entry ---
if (process.argv[1]?.includes("endpoint-extract")) {
  const input = process.argv[2];
  if (!input) {
    console.log(
      JSON.stringify({
        error: 'Usage: endpoint-extract \'{"url":"https://app.example.com"}\'',
        params: [
          "url (required) — target web application URL",
          "include_external (bool, default false) — include scripts from CDNs",
          "max_bundles (number, default 20) — max JS files to analyze",
          "custom_patterns (string[]) — additional regex patterns",
        ],
      }),
    );
    process.exit(1);
  }
  const config: ExtractConfig = JSON.parse(input);
  extractEndpoints(config).then((r) => console.log(JSON.stringify(r, null, 2)));
}

export { extractEndpoints, type ExtractConfig, type ExtractResult };
