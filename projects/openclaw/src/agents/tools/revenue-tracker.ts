/**
 * Revenue Tracker Tool — Tracks all revenue events for Moltbot's digital army.
 *
 * Logs every payment event to revenue.jsonl with source attribution,
 * calculates P&L per agent, and notifies via WhatsApp on payment.
 *
 * Payment method: PayPal (vandan@getfoolish.com) — NO Stripe, NO passwords.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";

// Revenue event stored in JSONL
type RevenueEvent = {
  id: string;
  timestamp: string;
  type: "bounty" | "subscription" | "one_time" | "tip" | "referral" | "voice_call";
  source: {
    division: "security_swarm" | "channel_bots" | "voice_battalion" | "intelligence" | "other";
    agent_id: string;
    agent_chain: string[]; // Attribution chain: [scout, recon, exploit, report_writer]
    program?: string; // e.g., "HackerOne/company-name"
    channel?: string; // e.g., "discord", "telegram"
  };
  amount_usd: number;
  currency: string;
  payment_method: "paypal" | "telegram_payments" | "discord_premium" | "bank_transfer" | "crypto";
  status: "pending" | "confirmed" | "paid" | "disputed" | "refunded";
  description: string;
  metadata?: Record<string, unknown>;
};

// P&L summary per agent
type AgentPnL = {
  agent_id: string;
  total_revenue: number;
  total_cost: number;
  net_profit: number;
  events: number;
  first_revenue: string;
  last_revenue: string;
};

const REVENUE_FILE = path.join(
  process.env.HOME ?? "/tmp",
  ".openclaw",
  "workspace",
  "metrics",
  "revenue.jsonl",
);

const COST_FILE = path.join(
  process.env.HOME ?? "/tmp",
  ".openclaw",
  "workspace",
  "metrics",
  "costs.jsonl",
);

function generateEventId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `rev_${ts}_${rand}`;
}

async function ensureDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

async function appendJsonl(filePath: string, data: unknown): Promise<void> {
  await ensureDir(filePath);
  await fs.appendFile(filePath, JSON.stringify(data) + "\n", "utf-8");
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as T);
  } catch {
    return [];
  }
}

// Calculate attribution percentages based on agent chain position
function calculateAttribution(chain: string[]): Record<string, number> {
  if (chain.length === 0) {
    return {};
  }
  if (chain.length === 1) {
    return { [chain[0]]: 1.0 };
  }

  // Standard attribution weights by position in the chain
  const weights: Record<number, number[]> = {
    2: [0.3, 0.7],
    3: [0.15, 0.25, 0.6],
    4: [0.1, 0.2, 0.5, 0.2], // scout, recon, exploit, report
    5: [0.1, 0.15, 0.15, 0.4, 0.2],
  };

  const w = weights[chain.length] ?? chain.map(() => 1 / chain.length);
  const result: Record<string, number> = {};
  for (let i = 0; i < chain.length; i++) {
    result[chain[i]] = w[i];
  }
  return result;
}

const RevenueTrackerSchema = {
  type: "object" as const,
  properties: {
    action: {
      type: "string" as const,
      enum: ["log_revenue", "log_cost", "get_summary", "get_agent_pnl", "get_total"],
      description:
        "Action to perform: log_revenue (record a payment), log_cost (record a cost), get_summary (revenue summary), get_agent_pnl (P&L for specific agent), get_total (total revenue/costs)",
    },
    // For log_revenue
    type: {
      type: "string" as const,
      enum: ["bounty", "subscription", "one_time", "tip", "referral", "voice_call"],
      description: "Type of revenue event",
    },
    division: {
      type: "string" as const,
      enum: ["security_swarm", "channel_bots", "voice_battalion", "intelligence", "other"],
      description: "Which division generated this revenue",
    },
    agent_id: {
      type: "string" as const,
      description: "ID of the agent that generated revenue",
    },
    agent_chain: {
      type: "array" as const,
      items: { type: "string" as const },
      description: "Chain of agents that contributed (for attribution)",
    },
    amount_usd: {
      type: "number" as const,
      description: "Amount in USD",
    },
    currency: {
      type: "string" as const,
      description: "Original currency (default: USD)",
    },
    payment_method: {
      type: "string" as const,
      enum: ["paypal", "telegram_payments", "discord_premium", "bank_transfer", "crypto"],
      description: "How payment was received",
    },
    status: {
      type: "string" as const,
      enum: ["pending", "confirmed", "paid", "disputed", "refunded"],
      description: "Payment status",
    },
    description: {
      type: "string" as const,
      description: "Description of the revenue event",
    },
    program: {
      type: "string" as const,
      description: "Bug bounty program name (e.g., HackerOne/company)",
    },
    channel: {
      type: "string" as const,
      description: "Channel where revenue was generated",
    },
    // For log_cost
    cost_category: {
      type: "string" as const,
      enum: ["api_calls", "compute", "infrastructure", "tools", "other"],
      description: "Cost category",
    },
    // For get_agent_pnl
    target_agent_id: {
      type: "string" as const,
      description: "Agent ID to get P&L for",
    },
    metadata: {
      type: "object" as const,
      description: "Additional metadata",
    },
  },
  required: ["action"],
};

export function createRevenueTrackerTool(): AnyAgentTool {
  return {
    name: "revenue_tracker",
    description:
      "Track revenue events, costs, and P&L for Moltbot's revenue-generating agents. " +
      "Logs payments to revenue.jsonl with agent attribution chain. " +
      "Supports: log_revenue, log_cost, get_summary, get_agent_pnl, get_total.",
    schema: RevenueTrackerSchema,
    async execute(params: Record<string, unknown>) {
      const action = readStringParam(params, "action", { required: true });

      switch (action) {
        case "log_revenue":
          return await handleLogRevenue(params);
        case "log_cost":
          return await handleLogCost(params);
        case "get_summary":
          return await handleGetSummary();
        case "get_agent_pnl":
          return await handleGetAgentPnL(params);
        case "get_total":
          return await handleGetTotal();
        default:
          return jsonResult({ error: `Unknown action: ${action}` });
      }
    },
  };
}

async function handleLogRevenue(params: Record<string, unknown>) {
  const amount = readNumberParam(params, "amount_usd", { required: true });
  const agentId = readStringParam(params, "agent_id", { required: true }) ?? "unknown";
  const description = readStringParam(params, "description") ?? "";

  const event: RevenueEvent = {
    id: generateEventId(),
    timestamp: new Date().toISOString(),
    type: (readStringParam(params, "type") as RevenueEvent["type"]) ?? "one_time",
    source: {
      division:
        (readStringParam(params, "division") as RevenueEvent["source"]["division"]) ?? "other",
      agent_id: agentId,
      agent_chain: (params.agent_chain as string[]) ?? [agentId],
      program: readStringParam(params, "program"),
      channel: readStringParam(params, "channel"),
    },
    amount_usd: amount ?? 0,
    currency: readStringParam(params, "currency") ?? "USD",
    payment_method:
      (readStringParam(params, "payment_method") as RevenueEvent["payment_method"]) ?? "paypal",
    status: (readStringParam(params, "status") as RevenueEvent["status"]) ?? "pending",
    description,
    metadata: params.metadata as Record<string, unknown>,
  };

  await appendJsonl(REVENUE_FILE, event);

  // Calculate attribution
  const attribution = calculateAttribution(event.source.agent_chain);

  return jsonResult({
    ok: true,
    event_id: event.id,
    amount_usd: event.amount_usd,
    attribution,
    message: `Revenue event logged: $${event.amount_usd} from ${event.source.division} (${event.type})`,
    whatsapp_notify: `New revenue: $${event.amount_usd} from ${event.source.division}/${agentId} — ${description}`,
  });
}

async function handleLogCost(params: Record<string, unknown>) {
  const amount = readNumberParam(params, "amount_usd", { required: true });
  const agentId = readStringParam(params, "agent_id") ?? "system";
  const category = readStringParam(params, "cost_category") ?? "other";
  const description = readStringParam(params, "description") ?? "";

  const event = {
    id: `cost_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    agent_id: agentId,
    category,
    amount_usd: amount ?? 0,
    description,
  };

  await appendJsonl(COST_FILE, event);

  return jsonResult({
    ok: true,
    event_id: event.id,
    message: `Cost logged: $${event.amount_usd} for ${category} (${agentId})`,
  });
}

async function handleGetSummary() {
  const revenues = await readJsonl<RevenueEvent>(REVENUE_FILE);

  const byDivision: Record<string, { count: number; total: number }> = {};
  const byType: Record<string, { count: number; total: number }> = {};
  let totalRevenue = 0;

  for (const event of revenues) {
    if (event.status === "refunded" || event.status === "disputed") {
      continue;
    }

    totalRevenue += event.amount_usd;

    const div = event.source.division;
    byDivision[div] = byDivision[div] ?? { count: 0, total: 0 };
    byDivision[div].count++;
    byDivision[div].total += event.amount_usd;

    byType[event.type] = byType[event.type] ?? { count: 0, total: 0 };
    byType[event.type].count++;
    byType[event.type].total += event.amount_usd;
  }

  const costs = await readJsonl<{ amount_usd: number }>(COST_FILE);
  const totalCosts = costs.reduce((sum, c) => sum + c.amount_usd, 0);

  return jsonResult({
    total_revenue: totalRevenue,
    total_costs: totalCosts,
    net_profit: totalRevenue - totalCosts,
    event_count: revenues.length,
    by_division: byDivision,
    by_type: byType,
    revenue_file: REVENUE_FILE,
  });
}

async function handleGetAgentPnL(params: Record<string, unknown>) {
  const targetAgent = readStringParam(params, "target_agent_id", { required: true });

  const revenues = await readJsonl<RevenueEvent>(REVENUE_FILE);
  const costs = await readJsonl<{ agent_id: string; amount_usd: number }>(COST_FILE);

  let totalRevenue = 0;
  let eventCount = 0;
  let firstRevenue = "";
  let lastRevenue = "";

  for (const event of revenues) {
    if (event.status === "refunded" || event.status === "disputed") {
      continue;
    }

    const attribution = calculateAttribution(event.source.agent_chain);
    const share = attribution[targetAgent ?? ""];
    if (share) {
      totalRevenue += event.amount_usd * share;
      eventCount++;
      if (!firstRevenue) {
        firstRevenue = event.timestamp;
      }
      lastRevenue = event.timestamp;
    }
  }

  const totalCosts = costs
    .filter((c) => c.agent_id === targetAgent)
    .reduce((sum, c) => sum + c.amount_usd, 0);

  const pnl: AgentPnL = {
    agent_id: targetAgent ?? "unknown",
    total_revenue: Math.round(totalRevenue * 100) / 100,
    total_cost: Math.round(totalCosts * 100) / 100,
    net_profit: Math.round((totalRevenue - totalCosts) * 100) / 100,
    events: eventCount,
    first_revenue: firstRevenue,
    last_revenue: lastRevenue,
  };

  return jsonResult(pnl);
}

async function handleGetTotal() {
  const revenues = await readJsonl<RevenueEvent>(REVENUE_FILE);
  const costs = await readJsonl<{ amount_usd: number }>(COST_FILE);

  const totalRevenue = revenues
    .filter((e) => e.status !== "refunded" && e.status !== "disputed")
    .reduce((sum, e) => sum + e.amount_usd, 0);

  const totalCosts = costs.reduce((sum, c) => sum + c.amount_usd, 0);

  return jsonResult({
    total_revenue_usd: Math.round(totalRevenue * 100) / 100,
    total_costs_usd: Math.round(totalCosts * 100) / 100,
    net_profit_usd: Math.round((totalRevenue - totalCosts) * 100) / 100,
    payment_destination: "PayPal: vandan@getfoolish.com",
  });
}
