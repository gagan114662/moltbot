/**
 * GitHub authentication + webhook signature validation.
 *
 * Uses a Personal Access Token (PAT) for API calls.
 * Webhook signature validation is mandatory — all payloads must be verified
 * via HMAC-SHA256 even when using PAT auth.
 */

import type { IncomingMessage } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GithubConfig = {
  /** Personal Access Token for GitHub API calls. */
  token: string;
  /** Webhook secret for HMAC-SHA256 signature validation. */
  webhookSecret: string;
};

// ---------------------------------------------------------------------------
// Auth headers
// ---------------------------------------------------------------------------

/** Build Authorization header for GitHub API requests. */
export function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

// ---------------------------------------------------------------------------
// Webhook signature validation
// ---------------------------------------------------------------------------

/**
 * Validate GitHub webhook signature (HMAC-SHA256).
 *
 * GitHub sends the signature in the `X-Hub-Signature-256` header as
 * `sha256=<hex>`. We recompute the HMAC and compare using timing-safe
 * comparison to prevent timing attacks.
 *
 * @returns true if signature is valid, false otherwise.
 */
export function validateWebhookSignature(
  payload: string | Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature || !signature.startsWith("sha256=")) {
    return false;
  }

  const expected = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;

  // Both must be the same length for timingSafeEqual
  if (signature.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

/**
 * Read the full request body from an IncomingMessage.
 */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
