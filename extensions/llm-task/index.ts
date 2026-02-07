import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { createLlmTaskTool } from "./src/llm-task-tool.js";

export default function register(api: OpenClawPluginApi) {
  api.registerTool(createLlmTaskTool(api), { optional: true });
}
