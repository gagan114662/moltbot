/**
 * Strategy resolution for the overnight self-healing loop.
 *
 * Determines:
 * 1. What healing phase we're in (connect → talk → draw → teach)
 * 2. What strategy level to use (standard → contextual → architectural → fallback)
 * 3. What context to prepend to every Codex nudge
 */

import type {
  HealingPhase,
  OvernightState,
  OvernightStrategy,
  StrategyLevel,
} from "./overnight-types.js";

// ---------------------------------------------------------------------------
// Source file sets (relative to scratchpad/frontend targetCwd)
// ---------------------------------------------------------------------------

const SOURCE_FILES_BASE = [
  "src/hooks/useScratchpadAI.ts",
  "src/features/tutor/tutor-service.ts",
  "src/hooks/canvas-renderer.ts",
  "src/components/ScratchpadCanvas.tsx",
  "src/App.tsx",
];

const SOURCE_FILES_DEEP = [
  ...SOURCE_FILES_BASE,
  "src/features/tutor/tutor-client.ts",
  "src/features/tutor/use-tutor.ts",
  "public/ai_tutor_voice_prompt.md",
  "public/ai_tutor_system_prompt.md",
];

// ---------------------------------------------------------------------------
// Phase detection
// ---------------------------------------------------------------------------

const WS_PATTERNS = ["websocket", "ws-10", "1007", "1011", "no-ws-session"];
const SILENT_PATTERNS = [
  "no tutor response",
  "tutor-silent",
  "mic-heard",
  "tutor silent",
  "greeting-only",
];
const CANVAS_PATTERNS = ["canvas", "auto-scribe", "visual", "blank", "draw", "scratchpad"];

/**
 * Detect the current healing phase from the most recent cycle's diagnoses.
 * Phase drives what kind of feedback is most useful to Codex.
 */
export function detectPhase(state: OvernightState): HealingPhase {
  const lastCycle = state.cycles.at(-1);
  if (!lastCycle) {
    return "phase-1-connect";
  }

  const diags = lastCycle.diagnoses.map((d) => d.toLowerCase());

  // Phase 1: WS connection issues
  if (diags.some((d) => WS_PATTERNS.some((p) => d.includes(p)))) {
    return "phase-1-connect";
  }

  // Phase 2: Connected but tutor silent
  if (diags.some((d) => SILENT_PATTERNS.some((p) => d.includes(p)))) {
    return "phase-2-talk";
  }

  // Phase 3: Talking but canvas blank/broken
  if (diags.some((d) => CANVAS_PATTERNS.some((p) => d.includes(p)))) {
    return "phase-3-draw";
  }

  // Phase 4: Drawing but low quality — or score-based fallback
  if (lastCycle.score !== null && lastCycle.score >= 4) {
    return "phase-4-teach";
  }

  // Score-based fallback when diagnoses are ambiguous
  if (lastCycle.score !== null) {
    if (lastCycle.score <= 2) {
      return "phase-1-connect";
    }
    if (lastCycle.score <= 4) {
      return "phase-2-talk";
    }
    if (lastCycle.score <= 6) {
      return "phase-3-draw";
    }
    return "phase-4-teach";
  }

  return "phase-1-connect";
}

// ---------------------------------------------------------------------------
// Strategy resolution
// ---------------------------------------------------------------------------

const PHASE_GOALS: Record<HealingPhase, string> = {
  "phase-1-connect":
    "Get the WebSocket connection stable (no 1007/1011 crashes). Do NOT try to improve teaching quality yet.",
  "phase-2-talk":
    "Get the tutor to respond to audio input. WS is connected — focus on the Gemini session config and mic pipeline.",
  "phase-3-draw":
    "Get the canvas rendering working. Tutor talks but the scratchpad is blank. Focus on auto-scribe or tool calls.",
  "phase-4-teach":
    "Improve teaching quality to Khan Academy standard. The plumbing works — now make it pedagogically excellent.",
};

/**
 * Resolve the strategy for the next cycle based on stall count and phase.
 */
export function resolveStrategy(state: OvernightState): OvernightStrategy {
  const phase = detectPhase(state);
  const stalls = state.consecutiveStalls;

  let level: StrategyLevel;
  if (stalls >= 6) {
    level = "fallback-model";
  } else if (stalls >= 4) {
    level = "architectural";
  } else if (stalls >= 2) {
    level = "contextual";
  } else {
    level = "standard";
  }

  return {
    level,
    phase,
    extraSourceFiles: level === "standard" ? SOURCE_FILES_BASE : SOURCE_FILES_DEEP,
    strategicPreamble: buildStrategicPreamble(level, phase, state),
    innerMaxIterations: level === "fallback-model" ? 3 : 5,
    codexModel: undefined, // Use Codex default model (ChatGPT Plus plan)
  };
}

// ---------------------------------------------------------------------------
// Strategic preamble (prepended to every Codex nudge)
// ---------------------------------------------------------------------------

function buildStrategicPreamble(
  level: StrategyLevel,
  phase: HealingPhase,
  state: OvernightState,
): string {
  const lines: string[] = [];

  lines.push(`CURRENT PHASE: ${phase}`);
  lines.push(`GOAL: ${PHASE_GOALS[phase]}`);

  // Include tried approaches so Codex doesn't repeat them
  const tried = state.triedApproaches.slice(-10);
  if (tried.length > 0) {
    lines.push("");
    lines.push("ALREADY TRIED (do not repeat these):");
    for (const a of tried) {
      lines.push(`- ${a}`);
    }
  }

  // Escalation context
  if (level === "contextual") {
    lines.push("");
    lines.push(
      `STRATEGY: Standard fixes haven't worked for ${state.consecutiveStalls} cycles. ` +
        `Include more context. Check for incorrect config values, wrong API field names, or missing env vars.`,
    );
  }

  if (level === "architectural") {
    lines.push("");
    lines.push(
      `STRATEGY ESCALATION: After ${state.consecutiveStalls} stalled cycles, step back. ` +
        `Consider architectural changes — maybe the approach is wrong, not just the implementation. ` +
        `Think about: using a different Gemini model, restructuring the WS message format, ` +
        `or switching from native-audio to standard live mode for reliable function calling.`,
    );
  }

  if (level === "fallback-model") {
    lines.push("");
    lines.push(
      `FALLBACK MODE: After ${state.completedCycles} cycles without success. ` +
        `Consider using gemini-live-2.5-flash-preview (non-native-audio) for more reliable function calling, ` +
        `or restructuring the entire Gemini connection setup. ` +
        `Known fact: native audio models have broken sendToolResponse (WS 1011). ` +
        `The workaround is sending functionResponse parts inside clientContent.`,
    );
  }

  return lines.join("\n");
}
