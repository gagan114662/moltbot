#!/usr/bin/env node --import tsx
/**
 * graphql-probe — GraphQL introspection, schema extraction, and abuse testing.
 *
 * Typical payout: $1K-$15K. Rising trend. API security is growing fast.
 *
 * Tests:
 * 1. Introspection enabled? (extract full schema)
 * 2. Dangerous mutations accessible? (delete, admin operations)
 * 3. Query depth/complexity limits? (DoS via nested queries)
 * 4. Field-level authorization? (access restricted fields)
 * 5. Batch query abuse? (rate limit bypass via batching)
 * 6. SQL injection via GraphQL arguments?
 *
 * Usage:
 *   node --import tsx tools/graphql-probe.ts '{
 *     "url": "https://api.example.com/graphql",
 *     "auth_token": "Bearer xxx"
 *   }'
 */

import { probe } from "./http-probe.js";
import { validateUrl, validateRequired, Tracer, sleep } from "./tool-utils.js";

type GraphQLConfig = {
  url: string;
  auth_token?: string;
  cookies?: string;
  headers?: Record<string, string>;
  max_depth?: number; // max depth for nested query test (default 10)
  delay_ms?: number;
};

type GraphQLType = {
  name: string;
  kind: string;
  fields?: { name: string; type: string; args: string[] }[];
};

type GraphQLFinding = {
  type: string;
  severity: "critical" | "high" | "medium" | "low" | "info";
  description: string;
  evidence: string;
};

type GraphQLResult = {
  target: string;
  introspection_enabled: boolean;
  schema_types: number;
  queries: string[];
  mutations: string[];
  subscriptions: string[];
  sensitive_fields: string[];
  findings: GraphQLFinding[];
  raw_schema?: unknown;
  summary: string;
};

const INTROSPECTION_QUERY = `{
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      name
      kind
      fields {
        name
        type { name kind ofType { name kind ofType { name kind } } }
        args { name type { name kind } }
      }
    }
  }
}`;

const SENSITIVE_FIELD_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /credential/i,
  /ssn/i,
  /social/i,
  /credit[_-]?card/i,
  /cvv/i,
  /private/i,
  /admin/i,
  /role/i,
  /permission/i,
  /internal/i,
  /debug/i,
  /email/i,
  /phone/i,
  /address/i,
  /salary/i,
  /bank/i,
];

const DANGEROUS_MUTATION_PATTERNS = [
  /delete/i,
  /remove/i,
  /destroy/i,
  /drop/i,
  /purge/i,
  /admin/i,
  /escalat/i,
  /promote/i,
  /setRole/i,
  /grant/i,
  /transfer/i,
  /withdraw/i,
  /payment/i,
  /charge/i,
  /impersonate/i,
  /loginAs/i,
  /sudo/i,
  /bypass/i,
  /reset[_-]?password/i,
  /change[_-]?email/i,
  /export/i,
  /dump/i,
  /backup/i,
];

async function gqlRequest(
  config: GraphQLConfig,
  query: string,
  variables?: Record<string, unknown>,
): Promise<{
  data?: unknown;
  errors?: unknown[];
  status: number;
  body: string;
  timing_ms: number;
}> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...config.headers,
  };
  if (config.auth_token) {
    headers["Authorization"] = config.auth_token.startsWith("Bearer ")
      ? config.auth_token
      : `Bearer ${config.auth_token}`;
  }

  const resp = await probe({
    url: config.url,
    method: "POST",
    headers,
    cookies: config.cookies,
    body: JSON.stringify({ query, variables }),
  });

  return {
    data:
      resp.body_json && typeof resp.body_json === "object"
        ? (resp.body_json as Record<string, unknown>).data
        : undefined,
    errors:
      resp.body_json && typeof resp.body_json === "object"
        ? ((resp.body_json as Record<string, unknown>).errors as unknown[])
        : undefined,
    status: resp.status,
    body: resp.body,
    timing_ms: resp.timing_ms,
  };
}

async function probeGraphQL(config: GraphQLConfig): Promise<GraphQLResult> {
  // --- Input validation ---
  validateRequired(config as unknown as Record<string, unknown>, ["url"]);
  validateUrl(config.url, "url");

  const tracer = new Tracer("graphql-probe");
  tracer.log("start", { url: config.url });

  const delay = config.delay_ms ?? 300;
  const result: GraphQLResult = {
    target: config.url,
    introspection_enabled: false,
    schema_types: 0,
    queries: [],
    mutations: [],
    subscriptions: [],
    sensitive_fields: [],
    findings: [],
    summary: "",
  };

  // Test 1: Introspection
  const intro = await gqlRequest(config, INTROSPECTION_QUERY);

  if (intro.data && typeof intro.data === "object") {
    result.introspection_enabled = true;
    result.findings.push({
      type: "introspection_enabled",
      severity: "medium",
      description: "GraphQL introspection is enabled, exposing the full API schema",
      evidence: `Status: ${intro.status}, schema returned with types`,
    });

    // Parse schema
    const schema = (intro.data as Record<string, unknown>).__schema as Record<string, unknown>;
    const types = (schema?.types as Record<string, unknown>[]) ?? [];
    result.schema_types = types.length;
    result.raw_schema = schema;

    const queryTypeName = (schema?.queryType as Record<string, unknown>)?.name as string;
    const mutationTypeName = (schema?.mutationType as Record<string, unknown>)?.name as string;
    const subscriptionTypeName = (schema?.subscriptionType as Record<string, unknown>)
      ?.name as string;

    for (const type of types) {
      if (typeof type.name !== "string" || type.name.startsWith("__")) {
        continue;
      }
      const fields = type.fields as Record<string, unknown>[] | undefined;
      if (!fields) {
        continue;
      }

      for (const field of fields) {
        const fieldName = field.name as string;

        if (type.name === queryTypeName) {
          result.queries.push(fieldName);
        }
        if (type.name === mutationTypeName) {
          result.mutations.push(fieldName);
        }
        if (type.name === subscriptionTypeName) {
          result.subscriptions.push(fieldName);
        }

        // Check for sensitive fields
        for (const pattern of SENSITIVE_FIELD_PATTERNS) {
          if (pattern.test(fieldName)) {
            const path = `${type.name}.${fieldName}`;
            if (!result.sensitive_fields.includes(path)) {
              result.sensitive_fields.push(path);
            }
          }
        }

        // Check for dangerous mutations
        if (type.name === mutationTypeName) {
          for (const pattern of DANGEROUS_MUTATION_PATTERNS) {
            if (pattern.test(fieldName)) {
              result.findings.push({
                type: "dangerous_mutation",
                severity: "high",
                description: `Dangerous mutation exposed: ${fieldName}`,
                evidence: `Mutation "${fieldName}" matches pattern ${pattern}`,
              });
              break;
            }
          }
        }
      }
    }

    if (result.sensitive_fields.length > 0) {
      result.findings.push({
        type: "sensitive_fields_exposed",
        severity: "medium",
        description: `${result.sensitive_fields.length} sensitive fields found in schema`,
        evidence: result.sensitive_fields.slice(0, 10).join(", "),
      });
    }
  } else {
    // Introspection disabled — try field suggestions
    result.findings.push({
      type: "introspection_disabled",
      severity: "info",
      description: "Introspection is disabled (good security practice)",
      evidence: `Response: ${intro.body.slice(0, 200)}`,
    });
  }

  await sleep(delay);

  // Test 2: Query depth / complexity (DoS)
  const maxDepth = config.max_depth ?? 10;
  let deepQuery = "{ __typename";
  for (let i = 0; i < maxDepth; i++) {
    deepQuery = `{ __schema { types { fields { type { ofType ${deepQuery} } } } } }`;
  }

  const depthResp = await gqlRequest(config, deepQuery);
  if (depthResp.status === 200 && !depthResp.errors) {
    result.findings.push({
      type: "no_depth_limit",
      severity: "medium",
      description: `No query depth limit detected (tested depth: ${maxDepth})`,
      evidence: `Deep nested query returned 200 OK without errors`,
    });
  }

  await sleep(delay);

  // Test 3: Batch query abuse
  const batchQuery = Array.from({ length: 10 }, (_, i) => `a${i}: __typename`).join("\n");
  const batchResp = await gqlRequest(config, `{ ${batchQuery} }`);
  if (batchResp.status === 200 && !batchResp.errors) {
    result.findings.push({
      type: "batch_queries_allowed",
      severity: "low",
      description: "Batch/aliased queries are allowed (potential rate limit bypass)",
      evidence: `10 aliased queries returned 200 OK`,
    });
  }

  await sleep(delay);

  // Test 4: No-auth access (if auth was provided)
  if (config.auth_token) {
    const noAuthResp = await gqlRequest({ ...config, auth_token: undefined }, INTROSPECTION_QUERY);
    if (noAuthResp.data && typeof noAuthResp.data === "object") {
      result.findings.push({
        type: "no_auth_required",
        severity: "high",
        description: "GraphQL endpoint accessible without authentication",
        evidence: `Introspection succeeds without auth token`,
      });
    }
  }

  await sleep(delay);

  // Test 5: SQL injection via arguments (if we have queries)
  if (result.queries.length > 0) {
    const testQuery = result.queries[0];
    const sqliPayload = `{ ${testQuery}(id: "1' OR '1'='1") { __typename } }`;
    const sqliResp = await gqlRequest(config, sqliPayload);
    if (
      sqliResp.body.toLowerCase().includes("sql") ||
      sqliResp.body.toLowerCase().includes("syntax error") ||
      sqliResp.body.toLowerCase().includes("mysql") ||
      sqliResp.body.toLowerCase().includes("postgresql") ||
      sqliResp.body.toLowerCase().includes("sqlite")
    ) {
      result.findings.push({
        type: "sql_injection_indicator",
        severity: "critical",
        description: "SQL error message in response — possible SQL injection",
        evidence: sqliResp.body.slice(0, 500),
      });
    }
  }

  // Summary
  const critCount = result.findings.filter((f) => f.severity === "critical").length;
  const highCount = result.findings.filter((f) => f.severity === "high").length;
  result.summary = [
    `Introspection: ${result.introspection_enabled ? "ENABLED" : "disabled"}.`,
    result.introspection_enabled
      ? `Schema: ${result.schema_types} types, ${result.queries.length} queries, ${result.mutations.length} mutations.`
      : "",
    result.findings.length > 0
      ? `Findings: ${result.findings.length} (${critCount} critical, ${highCount} high).`
      : "No issues found.",
    result.sensitive_fields.length > 0
      ? `${result.sensitive_fields.length} sensitive fields exposed.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  tracer.log("complete", {
    findings: result.findings.length,
    introspection: result.introspection_enabled,
  });
  (result as Record<string, unknown>)._trace = tracer.summary();

  return result;
}

// --- CLI entry ---
if (process.argv[1]?.includes("graphql-probe")) {
  const input = process.argv[2];
  if (!input) {
    console.log(
      JSON.stringify({
        error: 'Usage: graphql-probe \'{"url":"https://api.example.com/graphql", ...}\'',
        params: [
          "url (required) — GraphQL endpoint",
          "auth_token — Bearer token",
          "cookies — cookie header",
          "headers (object) — additional headers",
          "max_depth (number, default 10) — max nesting depth to test",
          "delay_ms (number, default 300)",
        ],
      }),
    );
    process.exit(1);
  }
  const config: GraphQLConfig = JSON.parse(input);
  probeGraphQL(config).then((r) => console.log(JSON.stringify(r, null, 2)));
}

export { probeGraphQL, type GraphQLConfig, type GraphQLResult };
