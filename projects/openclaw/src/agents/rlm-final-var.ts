export type RlmFinalVarStatus = "ok" | "insufficient_evidence" | "auth_required" | "blocked";

export type RlmFinalVar = {
  status: RlmFinalVarStatus;
  answer?: string;
  summary?: string;
  findings?: string[];
  uncertainty?: string[];
  evidence?: Array<{
    claim?: string;
    source?: string;
    confidence?: string;
  }>;
  recursion?: {
    depth?: number;
    subagentsLaunched?: number;
    branches?: number;
  };
};

export type RlmFinalVarParseResult = {
  found: boolean;
  value?: RlmFinalVar;
  rawJson?: string;
  error?: string;
};

const FINAL_VAR_BEGIN = "FINAL_VAR_BEGIN";
const FINAL_VAR_END = "FINAL_VAR_END";

function extractBalancedJsonObject(input: string): string | null {
  const start = input.indexOf("{");
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < input.length; i += 1) {
    const ch = input[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return input.slice(start, i + 1);
      }
    }
  }
  return null;
}

function toStatus(value: unknown): RlmFinalVarStatus | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "ok" ||
    normalized === "insufficient_evidence" ||
    normalized === "auth_required" ||
    normalized === "blocked"
  ) {
    return normalized;
  }
  return null;
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out = value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
  return out.length > 0 ? out : undefined;
}

function toEvidence(
  value: unknown,
): Array<{ claim?: string; source?: string; confidence?: string }> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: Array<{ claim?: string; source?: string; confidence?: string }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const claim = typeof record.claim === "string" ? record.claim.trim() : undefined;
    const source = typeof record.source === "string" ? record.source.trim() : undefined;
    const confidence = typeof record.confidence === "string" ? record.confidence.trim() : undefined;
    if (!claim && !source && !confidence) {
      continue;
    }
    out.push({ claim, source, confidence });
  }
  return out.length > 0 ? out : undefined;
}

function toRecursion(value: unknown): RlmFinalVar["recursion"] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const depth =
    typeof record.depth === "number" && Number.isFinite(record.depth)
      ? Math.max(0, Math.floor(record.depth))
      : undefined;
  const subagentsLaunched =
    typeof record.subagentsLaunched === "number" && Number.isFinite(record.subagentsLaunched)
      ? Math.max(0, Math.floor(record.subagentsLaunched))
      : undefined;
  const branches =
    typeof record.branches === "number" && Number.isFinite(record.branches)
      ? Math.max(0, Math.floor(record.branches))
      : undefined;
  if (depth === undefined && subagentsLaunched === undefined && branches === undefined) {
    return undefined;
  }
  return { depth, subagentsLaunched, branches };
}

function normalizeFinalVar(raw: Record<string, unknown>): RlmFinalVar | null {
  const status = toStatus(raw.status);
  if (!status) {
    return null;
  }
  const answer = typeof raw.answer === "string" ? raw.answer.trim() : undefined;
  const summary = typeof raw.summary === "string" ? raw.summary.trim() : undefined;
  return {
    status,
    answer: answer || undefined,
    summary: summary || undefined,
    findings: toStringArray(raw.findings),
    uncertainty: toStringArray(raw.uncertainty),
    evidence: toEvidence(raw.evidence),
    recursion: toRecursion(raw.recursion),
  };
}

export function extractRlmFinalVar(text: string): RlmFinalVarParseResult {
  if (!text.trim()) {
    return { found: false };
  }

  const beginIndex = text.indexOf(FINAL_VAR_BEGIN);
  if (beginIndex >= 0) {
    const afterBegin = text.slice(beginIndex + FINAL_VAR_BEGIN.length);
    const endIndex = afterBegin.indexOf(FINAL_VAR_END);
    const block = endIndex >= 0 ? afterBegin.slice(0, endIndex) : afterBegin;
    const jsonText = extractBalancedJsonObject(block);
    if (!jsonText) {
      return {
        found: true,
        error: "FINAL_VAR block found but JSON object is missing or malformed.",
      };
    }
    try {
      const parsed = JSON.parse(jsonText) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { found: true, rawJson: jsonText, error: "FINAL_VAR JSON must be an object." };
      }
      const normalized = normalizeFinalVar(parsed as Record<string, unknown>);
      if (!normalized) {
        return {
          found: true,
          rawJson: jsonText,
          error:
            "FINAL_VAR JSON is missing required field `status` (ok|insufficient_evidence|auth_required|blocked).",
        };
      }
      return { found: true, rawJson: jsonText, value: normalized };
    } catch (err) {
      return {
        found: true,
        rawJson: jsonText,
        error: `FINAL_VAR JSON parse failed: ${String(err)}`,
      };
    }
  }

  const inlineIndex = text.indexOf("FINAL_VAR:");
  if (inlineIndex >= 0) {
    const jsonText = extractBalancedJsonObject(text.slice(inlineIndex + "FINAL_VAR:".length));
    if (!jsonText) {
      return { found: true, error: "FINAL_VAR marker found but JSON object is missing." };
    }
    try {
      const parsed = JSON.parse(jsonText) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { found: true, rawJson: jsonText, error: "FINAL_VAR JSON must be an object." };
      }
      const normalized = normalizeFinalVar(parsed as Record<string, unknown>);
      if (!normalized) {
        return {
          found: true,
          rawJson: jsonText,
          error:
            "FINAL_VAR JSON is missing required field `status` (ok|insufficient_evidence|auth_required|blocked).",
        };
      }
      return { found: true, rawJson: jsonText, value: normalized };
    } catch (err) {
      return {
        found: true,
        rawJson: jsonText,
        error: `FINAL_VAR JSON parse failed: ${String(err)}`,
      };
    }
  }

  return { found: false };
}

export function formatRlmFinalVarForMainAgent(value: RlmFinalVar): string {
  const lines: string[] = [];
  lines.push(`status: ${value.status}`);
  if (value.answer) {
    lines.push(`answer: ${value.answer}`);
  } else if (value.summary) {
    lines.push(`summary: ${value.summary}`);
  }
  if (value.findings && value.findings.length > 0) {
    lines.push("findings:");
    for (const finding of value.findings.slice(0, 8)) {
      lines.push(`- ${finding}`);
    }
  }
  if (value.uncertainty && value.uncertainty.length > 0) {
    lines.push("uncertainty:");
    for (const item of value.uncertainty.slice(0, 5)) {
      lines.push(`- ${item}`);
    }
  }
  if (value.evidence && value.evidence.length > 0) {
    lines.push("evidence:");
    for (const item of value.evidence.slice(0, 8)) {
      const claim = item.claim ? `claim=${item.claim}` : "claim=(none)";
      const source = item.source ? `source=${item.source}` : "source=(none)";
      const confidence = item.confidence ? `confidence=${item.confidence}` : "confidence=(none)";
      lines.push(`- ${claim}; ${source}; ${confidence}`);
    }
  }
  if (value.recursion) {
    const parts: string[] = [];
    if (typeof value.recursion.depth === "number") {
      parts.push(`depth=${value.recursion.depth}`);
    }
    if (typeof value.recursion.subagentsLaunched === "number") {
      parts.push(`subagents=${value.recursion.subagentsLaunched}`);
    }
    if (typeof value.recursion.branches === "number") {
      parts.push(`branches=${value.recursion.branches}`);
    }
    if (parts.length > 0) {
      lines.push(`recursion: ${parts.join(", ")}`);
    }
  }
  return lines.join("\n");
}
