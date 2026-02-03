# Sandbox Agent Extension for OpenClaw

Run coding agents (Claude Code, Codex, OpenCode, Amp) in isolated sandboxes with HTTP control and human-in-the-loop approval via messaging channels.

## Features

- **Universal Agent API**: Control Claude Code, Codex, OpenCode, and Amp through a unified interface
- **Isolated Execution**: Run AI coding tasks in sandboxed environments
- **Human-in-the-Loop**: Route permission requests through WhatsApp, Telegram, Discord, etc.
- **Event Streaming**: Real-time updates on agent activities
- **Embedded or Remote Mode**: Run locally or connect to cloud sandboxes (E2B, Daytona, Vercel)

## Installation

```bash
cd extensions/sandbox-agent
pnpm install
pnpm build
```

## Configuration

Add to your `moltbot.json`:

```json
{
  "plugins": {
    "entries": {
      "sandbox-agent": {
        "enabled": true,
        "config": {
          "defaultAgent": "claude",
          "mode": "embedded",
          "port": 2468,
          "humanInTheLoop": {
            "enabled": true,
            "timeoutSeconds": 300,
            "autoApproveSafe": true
          }
        }
      }
    }
  }
}
```

## Usage

### Via Chat Command

```
/sandbox claude Fix the bug in src/utils.ts that causes null reference errors
```

### Via Agent Skill

The extension registers a `sandbox-task` skill that agents can invoke:

```typescript
await invokeSkill("sandbox-task", {
  agent: "codex",
  task: "Refactor the authentication module to use JWT",
  workingDirectory: "/path/to/project"
});
```

### Programmatic API

```typescript
import { SandboxAgentManager } from "@openclaw/plugin-sandbox-agent";

const manager = new SandboxAgentManager({
  mode: "embedded",
  port: 2468,
  defaultAgent: "claude",
  workspaceDir: "/path/to/workspace"
});

const result = await manager.runTask({
  agent: "claude",
  task: "Create a REST API for user management",
  sessionId: "task-001",
  onEvent: async (event) => {
    console.log(event.type, event.data);
  },
  onPermissionRequest: async (event) => {
    // Custom approval logic
    return { approved: true };
  }
});
```

## Human-in-the-Loop

When enabled, permission requests are sent to your messaging channel:

```
⚠️ Sandbox Agent Permission Request

**Operation:** `write_file`
**Target:** `src/api/users.ts`

This operation requires your approval.

Reply **yes** to approve or **no** to deny.
```

### Auto-Approve Safe Operations

Set `autoApproveSafe: true` to automatically approve read-only operations:
- `read_file`, `list_files`, `search_files`, `glob`, `grep`, `view_file`

Dangerous operations always require explicit approval:
- `write_file`, `delete_file`, `execute`, `bash`, `shell`, `rm`, `sudo`, `install`

## Supported Agents

| Agent | Description |
|-------|-------------|
| `claude` | Claude Code (Anthropic) |
| `codex` | OpenAI Codex |
| `opencode` | OpenCode |
| `amp` | Amp |

## Remote Mode

Connect to a sandbox server running in the cloud:

```json
{
  "mode": "remote",
  "serverUrl": "https://your-sandbox.example.com",
  "token": "your-auth-token"
}
```

Compatible with:
- E2B
- Daytona
- Vercel Sandboxes
- Docker containers
- Any infrastructure running `sandbox-agent server`

## Integration with Feedback Loop

The sandbox-agent can be used by the feedback loop for safer code execution:

```json
{
  "feedbackLoop": {
    "enabled": true,
    "useSandbox": true,
    "sandbox": {
      "agent": "claude",
      "requireApproval": false
    }
  }
}
```

## License

MIT
