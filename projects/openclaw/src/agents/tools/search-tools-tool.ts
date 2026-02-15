/**
 * search_tools meta-tool for deferred tool discovery.
 *
 * When tool deferral is enabled, this tool lets the LLM search for
 * specialized tools by keyword and get their full schemas back.
 */

import type { ToolIndex } from "../tool-deferral.js";
import type { AnyAgentTool } from "./common.js";
import { searchToolIndex } from "../tool-deferral.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

export function createSearchToolsTool(index: ToolIndex): AnyAgentTool {
  return {
    label: "Search Tools",
    name: "search_tools",
    description: [
      "Search for available tools by keyword.",
      "Returns full tool schemas for matching tools so you can call them.",
      "Use this when you need a specialized tool not in your immediate toolkit.",
      "The query should describe what you want to do (e.g., 'browse website', 'manage cron jobs', 'search web').",
    ].join(" "),
    parameters: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Search query — keywords describing what you want to do.",
        },
        limit: {
          type: "number",
          description: "Max results to return (default: 5, max: 10).",
        },
      },
      required: ["query"],
    },
    execute: async (_toolCallId: string, args: unknown) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const limit = Math.min(readNumberParam(params, "limit") ?? 5, 10);

      const results = searchToolIndex(index, query, limit);

      if (results.length === 0) {
        return jsonResult({
          status: "no_results",
          message: `No tools found matching "${query}". Try different keywords.`,
          available_count: index.entries.length,
        });
      }

      return jsonResult({
        status: "ok",
        results: results.map((r) => ({
          name: r.name,
          description: r.description,
          parameters: r.parameters,
          relevance: Math.round(r.score * 100) / 100,
        })),
        hint: "You can now call these tools directly with the parameters shown above.",
      });
    },
  } as unknown as AnyAgentTool;
}
