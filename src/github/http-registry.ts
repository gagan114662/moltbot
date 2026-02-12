/**
 * GitHub HTTP route registry — follows the Slack/LINE webhook pattern.
 *
 * Provides a Map-based route registry + handler that returns Promise<boolean>.
 * Plugs into the gateway's handleRequest chain in server-http.ts.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export type GithubHttpRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<void> | void;

type RegisterGithubHttpHandlerArgs = {
  path?: string | null;
  handler: GithubHttpRequestHandler;
  log?: (message: string) => void;
};

const githubHttpRoutes = new Map<string, GithubHttpRequestHandler>();

export function normalizeGithubWebhookPath(path?: string | null): string {
  const trimmed = path?.trim();
  if (!trimmed) {
    return "/github/webhook";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function registerGithubHttpHandler(params: RegisterGithubHttpHandlerArgs): () => void {
  const normalizedPath = normalizeGithubWebhookPath(params.path);
  if (githubHttpRoutes.has(normalizedPath)) {
    params.log?.(`github: webhook path ${normalizedPath} already registered`);
    return () => {};
  }
  githubHttpRoutes.set(normalizedPath, params.handler);
  return () => {
    githubHttpRoutes.delete(normalizedPath);
  };
}

export async function handleGithubHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const handler = githubHttpRoutes.get(url.pathname);
  if (!handler) {
    return false;
  }
  await handler(req, res);
  return true;
}
