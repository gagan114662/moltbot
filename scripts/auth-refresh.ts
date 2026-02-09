#!/usr/bin/env node --import tsx/esm
/**
 * Quick script to re-authenticate with Anthropic OAuth.
 * Run this in your terminal (it needs interactive input):
 *
 *   node --import tsx/esm scripts/auth-refresh.ts
 */

import { modelsAuthLoginCommand } from "../src/commands/models/auth.js";
import { defaultRuntime } from "../src/runtime.js";

console.log("\n\x1b[1m\x1b[35m╔═══════════════════════════════════════╗\x1b[0m");
console.log("\x1b[1m\x1b[35m║   MOLTBOT — Anthropic Auth Refresh    ║\x1b[0m");
console.log("\x1b[1m\x1b[35m╚═══════════════════════════════════════╝\x1b[0m\n");

try {
  await modelsAuthLoginCommand({ provider: "anthropic", setDefault: false }, defaultRuntime);
  console.log("\n\x1b[32m✅ Auth refreshed successfully!\x1b[0m\n");
} catch (err) {
  console.error("\n\x1b[31m❌ Auth failed:\x1b[0m", err);
  process.exit(1);
}
