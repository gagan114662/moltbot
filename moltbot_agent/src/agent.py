"""Moltbot Agent — autonomous security research and task execution.

Uses Claude Agent SDK with full tool access including browser automation.
"""

from typing import Any

from claude_agent_sdk import ClaudeAgentOptions, query
from claude_agent_sdk.types import ResultMessage

from terminaluse.lib import (
    AgentServer,
    TaskContext,
    make_logger,
)
from terminaluse.types import Event, TextPart

logger = make_logger(__name__)

SYSTEM_PROMPT = """You are Moltbot, an autonomous agent that builds, deploys, and executes tasks.

## Capabilities
- Full Bash access (install packages, run tools, build projects)
- File read/write/edit
- Headless browser via Playwright (pre-installed with Chromium)
- Internet access (curl, wget, APIs)

## Browser Automation
Playwright and Chromium are pre-installed. Use them for web automation:

```python
# Python
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto("https://example.com")
    print(page.title())
    browser.close()
```

```javascript
// Node.js
const { chromium } = require('playwright');
(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto('https://example.com');
    console.log(await page.title());
    await browser.close();
})();
```

ALWAYS use headless=True. There is no display server.

## Known Pitfalls — DO NOT REPEAT
- WebFetch often gets 403/404. Use curl or Playwright instead for web scraping.
- pip install may fail on read-only paths. Use: pip install --user or pip install --break-system-packages
- When scanning security targets, ONLY scan targets with explicit bug bounty programs that authorize testing.
- Save all outputs to /workspace/ so they persist.
- For payment integration, PayPal is vandan@getfoolish.com — NO Stripe account exists yet.

## Revenue Goal
Your work should generate revenue. Every task should move toward:
1. Bug bounty payouts (find vulns, write reports, submit to HackerOne)
2. Bot monetization (premium features, subscriptions)
3. Security services (scanning, monitoring, reporting)
"""

server = AgentServer()


@server.on_create
async def handle_create(ctx: TaskContext, params: dict[str, Any]):
    """Handle task creation."""
    await ctx.state.create(
        state={
            "session_id": None,
        },
    )


@server.on_event
async def handle_event(ctx: TaskContext, event: Event):
    """Handle incoming messages from users."""
    try:
        if not isinstance(event.content, TextPart):
            raise ValueError("Unsupported message type. Only text messages are supported.")
        user_message = event.content.text

        state = await ctx.state.get()
        session_id = state.get("session_id") if state else None

        options = ClaudeAgentOptions(
            include_partial_messages=True,
            permission_mode="bypassPermissions",
            cwd="/workspace",
            allowed_tools=["Skill", "Read", "Write", "Bash", "Edit", "Grep", "Glob"],
            resume=session_id,
            append_system_prompt=SYSTEM_PROMPT,
        )

        # Query Claude and stream responses
        async for message in query(prompt=user_message, options=options):
            await ctx.messages.send(message)

            # Save session ID for continuity
            if isinstance(message, ResultMessage):
                await ctx.state.update(
                    {"session_id": message.session_id}
                )

    except Exception as e:
        error_msg = str(e)
        await ctx.messages.send(f"Sorry, I encountered an error: {error_msg}")


@server.on_cancel
async def handle_cancel(ctx: TaskContext):
    """Handle task cancellation.

    Clean up any resources or state when a task is cancelled.
    """
    logger.info(f"Task cancelled: {ctx.task.id}")