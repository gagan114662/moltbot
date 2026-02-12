/**
 * Shared helpers for voice QA scripts.
 *
 * Extracted from run-voice-qa.ts so run-overnight.ts can reuse them.
 * All functions use the Pi SDK for Anthropic API access with OAuth tokens.
 */

import { completeSimple, getModel } from "@mariozechner/pi-ai";
import fs from "node:fs";
import { resolveOpenClawAgentDir } from "../src/agents/agent-paths.js";
import { resolveApiKeyForProvider } from "../src/agents/model-auth.js";

export const ANTHROPIC_MODEL_ID = "claude-sonnet-4-5-20250929";

// ---------------------------------------------------------------------------
// Anthropic via Pi SDK
// ---------------------------------------------------------------------------

/** Get a fresh Anthropic API key. Checks env var first, then OAuth store. */
export async function getAnthropicKey(): Promise<string> {
  // Fast path: env var (most reliable for overnight runs)
  const envKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (envKey) {
    return envKey;
  }

  // OAuth store (auto-refreshes expired tokens)
  const agentDir = resolveOpenClawAgentDir();
  const auth = await resolveApiKeyForProvider({
    provider: "anthropic",
    agentDir,
  });
  if (!auth.apiKey) {
    throw new Error(
      "No Anthropic API key resolved. Set ANTHROPIC_API_KEY env var or run: claude /login",
    );
  }
  return auth.apiKey;
}

/** Extract text from Pi SDK response (content blocks, not top-level .text). */
function extractText(res: { content?: Array<{ type: string; text?: string }> }): string {
  return res.content?.find((c) => c.type === "text")?.text ?? "";
}

/** Call Anthropic via Pi SDK (text-only). */
export async function anthropicText(apiKey: string, prompt: string): Promise<string> {
  const model = getModel("anthropic", ANTHROPIC_MODEL_ID);
  if (!model) {
    throw new Error(`Model not found: anthropic/${ANTHROPIC_MODEL_ID}`);
  }
  const res = await completeSimple(
    model,
    {
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    },
    { apiKey, maxTokens: 4096 },
  );
  return extractText(res);
}

/** Call Anthropic via Pi SDK with vision (image + text). */
export async function anthropicVision(
  apiKey: string,
  screenshotPath: string,
  prompt: string,
): Promise<string> {
  const model = getModel("anthropic", ANTHROPIC_MODEL_ID);
  if (!model) {
    throw new Error(`Model not found: anthropic/${ANTHROPIC_MODEL_ID}`);
  }
  const buf = fs.readFileSync(screenshotPath);
  const base64 = buf.toString("base64");
  const mimeType =
    screenshotPath.endsWith(".jpg") || screenshotPath.endsWith(".jpeg")
      ? "image/jpeg"
      : "image/png";

  const res = await completeSimple(
    model,
    {
      messages: [
        {
          role: "user",
          content: [
            { type: "image", data: base64, mimeType },
            { type: "text", text: prompt },
          ],
          timestamp: Date.now(),
        },
      ],
    },
    { apiKey, maxTokens: 512 },
  );
  return extractText(res);
}

// ---------------------------------------------------------------------------
// LLM callback factories
// ---------------------------------------------------------------------------

/** Create LLM diagnosis callback (text-only). */
export function createAgentDiagnose(apiKey: string): (prompt: string) => Promise<string> {
  return async (prompt: string): Promise<string> => {
    return anthropicText(apiKey, prompt);
  };
}

/** Create screenshot description callback (vision). */
export function createDescribeScreenshot(
  apiKey: string,
): (screenshotPath: string, prompt: string) => Promise<string> {
  return async (screenshotPath: string, prompt: string): Promise<string> => {
    return anthropicVision(apiKey, screenshotPath, prompt);
  };
}

/** Create one-shot multimodal analysis callback (replaces 3-call pipeline). */
export function createAgentAnalyze(
  apiKey: string,
): (prompt: string, images?: Array<{ path: string; label: string }>) => Promise<string> {
  return async (
    prompt: string,
    images?: Array<{ path: string; label: string }>,
  ): Promise<string> => {
    const model = getModel("anthropic", ANTHROPIC_MODEL_ID);
    if (!model) {
      throw new Error(`Model not found: anthropic/${ANTHROPIC_MODEL_ID}`);
    }

    const contentParts: Array<
      { type: "image"; data: string; mimeType: string } | { type: "text"; text: string }
    > = [];

    if (images && images.length > 0) {
      for (const img of images) {
        try {
          const buf = fs.readFileSync(img.path);
          const base64 = buf.toString("base64");
          const mimeType =
            img.path.endsWith(".jpg") || img.path.endsWith(".jpeg") ? "image/jpeg" : "image/png";
          contentParts.push({ type: "text", text: `[${img.label}]` });
          contentParts.push({ type: "image", data: base64, mimeType });
        } catch {
          // Skip unreadable screenshots
        }
      }
    }

    contentParts.push({ type: "text", text: prompt });

    const res = await completeSimple(
      model,
      {
        messages: [
          {
            role: "user",
            content: contentParts,
            timestamp: Date.now(),
          },
        ],
      },
      { apiKey, maxTokens: 4096 },
    );
    return extractText(res);
  };
}
