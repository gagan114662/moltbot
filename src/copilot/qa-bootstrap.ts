/**
 * Bootstrap Claude Code hooks in a target project so that QA feedback
 * from Moltbot automatically surfaces in Claude Code sessions.
 *
 * Idempotent: safe to call multiple times without duplicating entries.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const HOOK_MARKER = "# moltbot-qa-hook";
const HOOK_COMMAND = ".claude/hooks/qa-feedback.sh";

const HOOK_SCRIPT = `#!/usr/bin/env bash
# moltbot-qa-hook
set -uo pipefail
INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // "."')
cd "$CWD"

CONTEXT=""
FEEDBACK_FILE=".moltbot/copilot-feedback.json"
if [ -f "$FEEDBACK_FILE" ]; then
  FEEDBACK_OK=$(jq -r '.ok // true' "$FEEDBACK_FILE" 2>/dev/null)
  if [ "$FEEDBACK_OK" = "false" ]; then
    FEEDBACK_SUMMARY=$(jq -r '.summary // "unknown issues"' "$FEEDBACK_FILE" 2>/dev/null)
    CONTEXT="[MOLTBOT QA FAILED] \${FEEDBACK_SUMMARY}
Read QA-FEEDBACK.md for detailed findings and fix instructions."
  fi
fi

if [ -n "$CONTEXT" ]; then
  echo "$CONTEXT"
fi
exit 0
`;

const CLAUDE_MD_MARKER = "## Moltbot QA Integration";
const CLAUDE_MD_SECTION = `
## Moltbot QA Integration
When \`QA-FEEDBACK.md\` exists in this project, read it FIRST before responding.
It contains automated QA test results. Address all CRITICAL and MAJOR issues before other work.
After fixing issues, delete or rename the file to signal completion.
`;

const GITIGNORE_ENTRIES = [".moltbot/", "QA-FEEDBACK.md"];

type HookEntry = {
  type: string;
  command: string;
};

type SettingsJson = {
  hooks?: {
    UserPromptSubmit?: HookEntry[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

/** Install QA feedback hooks into a target project directory. */
export async function bootstrapQaHooks(targetPath: string): Promise<void> {
  await installHookScript(targetPath);
  await mergeSettings(targetPath);
  await appendClaudeMd(targetPath);
  await appendGitignore(targetPath);
}

async function installHookScript(targetPath: string): Promise<void> {
  const hookPath = path.join(targetPath, HOOK_COMMAND);

  // Skip if already installed
  if (fs.existsSync(hookPath)) {
    const content = await fsp.readFile(hookPath, "utf-8");
    if (content.includes(HOOK_MARKER)) {
      return;
    }
  }

  await fsp.mkdir(path.dirname(hookPath), { recursive: true });
  await fsp.writeFile(hookPath, HOOK_SCRIPT, { mode: 0o755 });
}

async function mergeSettings(targetPath: string): Promise<void> {
  const settingsPath = path.join(targetPath, ".claude", "settings.json");
  let settings: SettingsJson = {};

  if (fs.existsSync(settingsPath)) {
    const raw = await fsp.readFile(settingsPath, "utf-8");
    settings = JSON.parse(raw) as SettingsJson;
  }

  if (!settings.hooks) {
    settings.hooks = {};
  }
  if (!Array.isArray(settings.hooks.UserPromptSubmit)) {
    settings.hooks.UserPromptSubmit = [];
  }

  const alreadyPresent = settings.hooks.UserPromptSubmit.some(
    (entry) => entry.command === HOOK_COMMAND,
  );
  if (alreadyPresent) {
    return;
  }

  settings.hooks.UserPromptSubmit.push({
    type: "command",
    command: HOOK_COMMAND,
  });

  await fsp.mkdir(path.dirname(settingsPath), { recursive: true });
  await fsp.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
}

async function appendClaudeMd(targetPath: string): Promise<void> {
  const claudeMdPath = path.join(targetPath, ".claude", "CLAUDE.md");

  if (fs.existsSync(claudeMdPath)) {
    const content = await fsp.readFile(claudeMdPath, "utf-8");
    if (content.includes(CLAUDE_MD_MARKER)) {
      return;
    }
    await fsp.appendFile(claudeMdPath, CLAUDE_MD_SECTION, "utf-8");
  } else {
    await fsp.mkdir(path.dirname(claudeMdPath), { recursive: true });
    await fsp.writeFile(claudeMdPath, CLAUDE_MD_SECTION.trimStart(), "utf-8");
  }
}

async function appendGitignore(targetPath: string): Promise<void> {
  const gitignorePath = path.join(targetPath, ".gitignore");
  let content = "";

  if (fs.existsSync(gitignorePath)) {
    content = await fsp.readFile(gitignorePath, "utf-8");
  }

  const lines = content.split("\n");
  const toAdd = GITIGNORE_ENTRIES.filter((entry) => !lines.includes(entry));

  if (toAdd.length === 0) {
    return;
  }

  // Ensure trailing newline before appending
  const suffix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  await fsp.writeFile(gitignorePath, content + suffix + toAdd.join("\n") + "\n", "utf-8");
}
