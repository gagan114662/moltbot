#!/usr/bin/env node --import tsx
/**
 * auth-matrix — Authorization matrix tester.
 *
 * Tests every endpoint with every role to find privilege escalation.
 * Builds a visual matrix showing which roles can access which endpoints.
 *
 * Finds:
 * - Vertical privilege escalation (user accessing admin endpoints)
 * - Horizontal privilege escalation (user A accessing user B's data)
 * - Missing authentication (endpoints accessible without any auth)
 * - Inconsistent authorization (some methods allowed, others not)
 *
 * Usage:
 *   node --import tsx tools/auth-matrix.ts '{
 *     "base_url": "https://api.example.com",
 *     "endpoints": [
 *       {"path": "/api/admin/users", "method": "GET", "expected_roles": ["admin"]},
 *       {"path": "/api/users/me", "method": "GET", "expected_roles": ["admin", "user"]},
 *       {"path": "/api/public/health", "method": "GET", "expected_roles": ["admin", "user", "anon"]}
 *     ],
 *     "roles": {
 *       "admin": {"token": "Bearer admin-token"},
 *       "user": {"token": "Bearer user-token"},
 *       "anon": {}
 *     }
 *   }'
 */

import { probe } from "./http-probe.js";
import { validateUrl, validateRequired, Tracer, sleep } from "./tool-utils.js";

type EndpointDef = {
  path: string;
  method?: string;
  body?: string | Record<string, unknown>;
  expected_roles?: string[]; // roles that SHOULD have access
};

type RoleDef = {
  token?: string; // Authorization header value
  cookies?: string;
  headers?: Record<string, string>;
};

type MatrixConfig = {
  base_url: string;
  endpoints: EndpointDef[];
  roles: Record<string, RoleDef>;
  delay_ms?: number;
};

type CellResult = {
  endpoint: string;
  method: string;
  role: string;
  status: number;
  accessible: boolean;
  expected: boolean;
  body_length: number;
  timing_ms: number;
};

type MatrixFinding = {
  type: "privilege_escalation" | "missing_auth" | "unexpected_deny";
  severity: "critical" | "high" | "medium" | "low";
  endpoint: string;
  method: string;
  role: string;
  status: number;
  description: string;
};

type MatrixResult = {
  target: string;
  total_tests: number;
  matrix: CellResult[];
  findings: MatrixFinding[];
  ascii_matrix: string;
  summary: string;
};

function isAccessible(status: number): boolean {
  return status >= 200 && status < 400;
}

async function testMatrix(config: MatrixConfig): Promise<MatrixResult> {
  // --- Input validation ---
  validateRequired(config as unknown as Record<string, unknown>, [
    "base_url",
    "endpoints",
    "roles",
  ]);
  validateUrl(config.base_url, "base_url");
  if (!config.endpoints?.length) {
    throw new Error("endpoints array must not be empty");
  }
  if (!Object.keys(config.roles).length) {
    throw new Error("roles object must not be empty");
  }

  const tracer = new Tracer("auth-matrix");
  tracer.log("start", {
    base_url: config.base_url,
    endpoints: config.endpoints.length,
    roles: Object.keys(config.roles),
  });

  const delay = config.delay_ms ?? 200;
  const roleNames = Object.keys(config.roles);
  const cells: CellResult[] = [];
  const findings: MatrixFinding[] = [];

  for (const ep of config.endpoints) {
    const method = (ep.method ?? "GET").toUpperCase();
    const url = `${config.base_url.replace(/\/$/, "")}${ep.path}`;

    for (const roleName of roleNames) {
      const role = config.roles[roleName];
      const headers: Record<string, string> = { ...role.headers };
      if (role.token) {
        headers["Authorization"] = role.token;
      }

      const resp = await probe({
        url,
        method,
        headers,
        cookies: role.cookies,
        body: ep.body,
        follow_redirects: false,
      });

      const accessible = isAccessible(resp.status);
      const expected = ep.expected_roles ? ep.expected_roles.includes(roleName) : true; // if no expected_roles, assume anything goes

      cells.push({
        endpoint: ep.path,
        method,
        role: roleName,
        status: resp.status,
        accessible,
        expected,
        body_length: resp.body_length,
        timing_ms: resp.timing_ms,
      });

      // Check for privilege escalation
      if (accessible && !expected) {
        const severity = roleName === "anon" ? "critical" : roleName === "user" ? "high" : "medium";
        findings.push({
          type: roleName === "anon" ? "missing_auth" : "privilege_escalation",
          severity,
          endpoint: ep.path,
          method,
          role: roleName,
          status: resp.status,
          description:
            roleName === "anon"
              ? `${method} ${ep.path} accessible WITHOUT authentication (status ${resp.status})`
              : `${method} ${ep.path} accessible by "${roleName}" role (status ${resp.status}) — should be restricted to: ${ep.expected_roles?.join(", ")}`,
        });
      }

      // Check for unexpected deny (something that should work but doesn't)
      if (!accessible && expected) {
        findings.push({
          type: "unexpected_deny",
          severity: "low",
          endpoint: ep.path,
          method,
          role: roleName,
          status: resp.status,
          description: `${method} ${ep.path} denied for "${roleName}" (status ${resp.status}) but should be accessible`,
        });
      }

      if (delay > 0) {
        await sleep(delay);
      }
    }
  }

  // Build ASCII matrix
  const maxPath = Math.max(
    ...config.endpoints.map((e) => (e.path + " " + (e.method ?? "GET")).length),
    10,
  );
  const colWidth = Math.max(...roleNames.map((r) => r.length), 6) + 2;

  let ascii = "\n" + "ENDPOINT".padEnd(maxPath + 2);
  for (const r of roleNames) {
    ascii += r.padEnd(colWidth);
  }
  ascii += "\n" + "─".repeat(maxPath + 2 + colWidth * roleNames.length) + "\n";

  for (const ep of config.endpoints) {
    const method = ep.method ?? "GET";
    const label = `${method} ${ep.path}`;
    ascii += label.padEnd(maxPath + 2);
    for (const roleName of roleNames) {
      const cell = cells.find(
        (c) => c.endpoint === ep.path && c.method === method.toUpperCase() && c.role === roleName,
      );
      if (!cell) {
        ascii += "?".padEnd(colWidth);
        continue;
      }
      let marker: string;
      if (cell.accessible && cell.expected) {
        marker = `${cell.status} OK`; // expected access
      } else if (cell.accessible && !cell.expected) {
        marker = `${cell.status} !!`; // VULN: unexpected access
      } else if (!cell.accessible && cell.expected) {
        marker = `${cell.status} ??`; // unexpected deny
      } else {
        marker = `${cell.status} --`; // expected deny
      }
      ascii += marker.padEnd(colWidth);
    }
    ascii += "\n";
  }

  ascii +=
    "\nLegend: OK=expected access, !!=VULN(unexpected access), ??=unexpected deny, --=expected deny\n";

  const critCount = findings.filter((f) => f.severity === "critical").length;
  const highCount = findings.filter((f) => f.severity === "high").length;

  tracer.log("complete", { findings: findings.length, total_tests: cells.length });

  return {
    target: config.base_url,
    total_tests: cells.length,
    matrix: cells,
    findings,
    ascii_matrix: ascii,
    summary:
      findings.filter((f) => f.type !== "unexpected_deny").length === 0
        ? `No authorization issues found. Tested ${cells.length} endpoint/role combinations.`
        : `FOUND ${findings.length} issue(s): ${critCount} critical, ${highCount} high. ${findings.filter((f) => f.type === "privilege_escalation").length} privilege escalation, ${findings.filter((f) => f.type === "missing_auth").length} missing auth.`,
    _trace: tracer.summary(),
  } as MatrixResult;
}

// --- CLI entry ---
if (process.argv[1]?.includes("auth-matrix")) {
  const input = process.argv[2];
  if (!input) {
    console.log(
      JSON.stringify({
        error: 'Usage: auth-matrix \'{"base_url":"...", "endpoints":[...], "roles":{...}}\'',
        params: [
          "base_url (required) — target API base URL",
          "endpoints (required) — [{path, method, expected_roles}] — use {id} in path, expected_roles lists who SHOULD access it",
          "roles (required) — {roleName: {token?, cookies?, headers?}} — use empty {} for anonymous",
          "delay_ms (number, default 200) — delay between requests",
        ],
      }),
    );
    process.exit(1);
  }
  const config: MatrixConfig = JSON.parse(input);
  testMatrix(config).then((r) => {
    // Print ASCII matrix to stderr for readability, JSON to stdout for parsing
    process.stderr.write(r.ascii_matrix);
    console.log(JSON.stringify(r, null, 2));
  });
}

export { testMatrix, type MatrixConfig, type MatrixResult };
