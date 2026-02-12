/**
 * GitHub webhook handler for PR events.
 *
 * Validates signature (mandatory), parses pull_request events
 * (opened/synchronize/reopened), and triggers PR review.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readBody, validateWebhookSignature, type GithubConfig } from "./auth.js";
import { reviewPr, type PrContext } from "./pr-review.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type GithubPrPayload = {
  action: string;
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    head: { ref: string };
    base: { ref: string };
    user: { login: string };
    draft?: boolean;
  };
  repository: {
    full_name: string;
    owner: { login: string };
    name: string;
  };
};

export type WebhookHandlerOptions = {
  config: GithubConfig;
  log?: (message: string) => void;
  /** Agent review function — if not provided, review is skipped. */
  agentReview?: (prompt: string) => Promise<string>;
};

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Create a webhook request handler for GitHub PR events.
 *
 * Handles POST requests only. Validates HMAC-SHA256 signature on every
 * request (mandatory). Processes pull_request opened/synchronize/reopened.
 */
export function createGithubWebhookHandler(options: WebhookHandlerOptions) {
  const { config, log } = options;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Only accept POST
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end("Method Not Allowed");
      return;
    }

    // Read body
    const body = await readBody(req);

    // Validate signature (mandatory)
    const signature = req.headers["x-hub-signature-256"] as string | undefined;
    if (!validateWebhookSignature(body, signature, config.webhookSecret)) {
      log?.("[github] Webhook signature validation failed — rejecting request");
      res.statusCode = 401;
      res.end("Invalid signature");
      return;
    }

    // Parse event type
    const event = req.headers["x-github-event"] as string | undefined;
    if (event !== "pull_request") {
      // Acknowledge non-PR events without processing
      res.statusCode = 200;
      res.end("OK (ignored event)");
      return;
    }

    // Parse payload
    let payload: GithubPrPayload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.statusCode = 400;
      res.end("Invalid JSON");
      return;
    }

    // Only handle opened, synchronize, reopened
    const validActions = ["opened", "synchronize", "reopened"];
    if (!validActions.includes(payload.action)) {
      res.statusCode = 200;
      res.end("OK (ignored action)");
      return;
    }

    // Skip draft PRs
    if (payload.pull_request.draft) {
      res.statusCode = 200;
      res.end("OK (draft PR skipped)");
      return;
    }

    // Respond immediately — review runs async
    res.statusCode = 202;
    res.end("Accepted");

    // Run review asynchronously
    const pr: PrContext = {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      number: payload.pull_request.number,
      title: payload.pull_request.title,
      body: payload.pull_request.body ?? "",
      baseBranch: payload.pull_request.base.ref,
      headBranch: payload.pull_request.head.ref,
      author: payload.pull_request.user.login,
    };

    log?.(`[github] Reviewing PR #${pr.number}: "${pr.title}" on ${pr.owner}/${pr.repo}`);

    try {
      const result = await reviewPr(pr, config.token, {
        agentReview: options.agentReview,
      });
      log?.(`[github] PR #${pr.number} review complete: ${result.findings.length} finding(s)`);
    } catch (err: unknown) {
      log?.(`[github] PR #${pr.number} review failed: ${String(err)}`);
    }
  };
}
