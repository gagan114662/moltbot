import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import { createFeedbackLoopTool } from "./src/feedback-loop-tool.js";
import { registerFeedbackLoopHooks } from "./src/hooks.js";

export default function register(api: OpenClawPluginApi) {
  // Register the feedback_loop tool for manual invocation
  api.registerTool(createFeedbackLoopTool(api));

  // Register hooks for automatic feedback loop on agent_end
  registerFeedbackLoopHooks(api);

  // Log plugin registration
  console.log("[feedback-loop] Plugin registered");
}
