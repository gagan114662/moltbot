#!/usr/bin/env npx tsx
/**
 * Standalone Anthropic OAuth re-authentication script.
 * Bypasses the broken CLI build to refresh auth-profiles.json.
 *
 * Usage: npx tsx scripts/refresh-anthropic-auth.ts
 */

import { exec } from "node:child_process";
import { webcrypto as crypto } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const SCOPES = "org:create_api_key user:profile user:inference";

const AUTH_PROFILES_PATH = join(homedir(), ".openclaw/agents/main/agent/auth-profiles.json");

function base64urlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let str = "";
  for (const b of bytes) {
    str += String.fromCharCode(b);
  }
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function generatePKCE() {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64urlEncode(verifierBytes.buffer);
  const challengeBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64urlEncode(challengeBuffer);
  return { verifier, challenge };
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function openBrowser(url: string) {
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd);
}

async function exchangeCodeForTokens(code: string, state: string, verifier: string) {
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      state,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token exchange failed (${resp.status}): ${text}`);
  }
  return resp.json();
}

function loadAuthProfiles(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(AUTH_PROFILES_PATH, "utf-8"));
  } catch {
    return { version: 1, profiles: {} };
  }
}

function saveAuthProfiles(data: Record<string, unknown>) {
  mkdirSync(join(homedir(), ".openclaw/agents/main/agent"), {
    recursive: true,
  });
  writeFileSync(AUTH_PROFILES_PATH, JSON.stringify(data, null, 2) + "\n");
}

async function main() {
  console.log("=== Anthropic OAuth Re-Authentication ===\n");

  // Step 1: Generate PKCE
  const { verifier, challenge } = await generatePKCE();

  // Step 2: Build auth URL
  const params = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: verifier,
  });
  const authUrl = `${AUTHORIZE_URL}?${params}`;

  console.log("Opening browser for Anthropic login...\n");
  openBrowser(authUrl);

  console.log("After authorizing, you'll see a page with a URL like:");
  console.log("  https://console.anthropic.com/oauth/code/callback?code=AUTH_CODE#state=STATE\n");

  const input = await prompt("Paste the FULL callback URL (or just the code): ");

  // Step 3: Parse code and state
  let code: string;
  let state: string;

  if (input.startsWith("http")) {
    // Parse from URL — code is a query param, state is after #
    const url = new URL(input.split("#")[0] ?? "");
    const fragment = input.split("#")[1] ?? "";
    code = url.searchParams.get("code") ?? "";
    const fragParams = new URLSearchParams(fragment);
    state = fragParams.get("state") ?? verifier;
  } else {
    code = input;
    state = verifier;
  }

  if (!code) {
    console.error("No authorization code found. Aborting.");
    process.exit(1);
  }

  console.log("\nExchanging code for tokens...");

  // Step 4: Exchange
  const tokens = await exchangeCodeForTokens(code, state, verifier);
  const expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000 - 5 * 60 * 1000;

  console.log("Token received! Expires:", new Date(expiresAt).toISOString());

  // Step 5: Update auth-profiles.json
  const store = loadAuthProfiles() as {
    profiles: Record<string, unknown>;
    lastGood?: Record<string, string>;
    [k: string]: unknown;
  };

  store.profiles["anthropic:claude-cli"] = {
    type: "oauth",
    provider: "anthropic",
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: expiresAt,
  };

  store.lastGood = store.lastGood ?? {};
  store.lastGood["anthropic"] = "anthropic:claude-cli";

  saveAuthProfiles(store);
  console.log(`\nSaved to ${AUTH_PROFILES_PATH}`);

  // Step 6: Copy to other agent dirs
  const agentDirs = ["v4", "researcher", "goal-work-v4", "goal-work-researcher"];
  for (const dir of agentDirs) {
    const target = join(homedir(), `.openclaw/agents/${dir}/agent/auth-profiles.json`);
    try {
      const agentStore = JSON.parse(readFileSync(target, "utf-8"));
      agentStore.profiles["anthropic:claude-cli"] = store.profiles["anthropic:claude-cli"];
      agentStore.lastGood = agentStore.lastGood ?? {};
      agentStore.lastGood["anthropic"] = "anthropic:claude-cli";
      writeFileSync(target, JSON.stringify(agentStore, null, 2) + "\n");
      console.log(`  Updated ${dir}/agent/auth-profiles.json`);
    } catch {
      // Agent dir doesn't exist, skip
    }
  }

  console.log("\nDone! Anthropic auth is now active.");
  console.log("Restart the gateway to pick up the new credentials.");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
