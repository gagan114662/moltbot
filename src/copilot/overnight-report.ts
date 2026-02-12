/**
 * Morning report generation for the overnight self-healing loop.
 *
 * Produces a human-readable markdown report that Gagan reads in the morning.
 */

import type { OvernightState } from "./overnight-types.js";

/**
 * Generate a markdown morning report from the overnight state.
 */
export function generateMorningReport(state: OvernightState): string {
  const lines: string[] = [];

  lines.push("# Overnight Self-Healing Report");
  lines.push(`> Run ID: ${state.runId}`);
  lines.push(`> Started: ${state.startedAt}`);
  lines.push(`> Completed: ${new Date().toISOString()}`);
  lines.push("");

  // ---- Summary ----
  const totalCycles = state.cycles.length;
  const totalIterations = state.cycles.reduce((s, c) => s + c.iterations, 0);
  const totalDurationMs = state.cycles.reduce((s, c) => s + c.durationMs, 0);
  const hours = Math.floor(totalDurationMs / 3600000);
  const mins = Math.floor((totalDurationMs % 3600000) / 60000);

  lines.push("## Summary");
  lines.push(`- **Cycles**: ${totalCycles}`);
  lines.push(`- **Total iterations**: ${totalIterations}`);
  lines.push(`- **Wall time**: ${hours}h ${mins}m`);
  lines.push(`- **Best score**: ${state.bestScore}/10 (cycle ${state.bestScoreCycle})`);
  lines.push(`- **Final phase**: ${state.currentPhase}`);
  lines.push("");

  // ---- Score trajectory ----
  lines.push("## Score Trajectory");
  const scored = state.cycles.filter((c) => c.score !== null);
  if (scored.length > 0) {
    const trajectory = scored.map((c) => `${c.score}/10`).join(" -> ");
    lines.push(`\`${trajectory}\``);
    const first = scored[0].score!;
    const last = scored[scored.length - 1].score!;
    const delta = last - first;
    lines.push(`Net change: ${delta > 0 ? "+" : ""}${delta}`);
  } else {
    lines.push("No scores recorded (all cycles may have failed before scoring).");
  }
  lines.push("");

  // ---- Phase progression ----
  lines.push("## Phase Progression");
  for (const c of state.cycles) {
    lines.push(`- Cycle ${c.cycle}: ${c.phase} (${c.strategy})`);
  }
  lines.push("");

  // ---- What was fixed ----
  lines.push("## What Was Fixed");
  const improved = state.cycles.filter((c) => c.scoreImproved);
  if (improved.length > 0) {
    for (const c of improved) {
      const diags = c.diagnoses.slice(0, 2).join(", ") || "unspecified";
      lines.push(`- **Cycle ${c.cycle}**: ${diags} — ${c.diffSummary}`);
    }
  } else {
    lines.push("No cycles showed score improvement.");
  }
  lines.push("");

  // ---- What's still broken ----
  lines.push("## Still Broken");
  const lastCycle = state.cycles.at(-1);
  if (lastCycle && lastCycle.stopReason !== "success") {
    lines.push(`- Phase: ${lastCycle.phase}`);
    lines.push(`- Last diagnoses: ${lastCycle.diagnoses.join(", ") || "none"}`);
    lines.push(`- Last score: ${lastCycle.score ?? "N/A"}/10`);
  } else if (lastCycle) {
    lines.push("All tests passing!");
  } else {
    lines.push("No cycles completed.");
  }
  lines.push("");

  // ---- Recommended next steps ----
  lines.push("## Recommended Next Steps");
  const phase = state.currentPhase;
  if (phase === "phase-1-connect") {
    lines.push("1. WebSocket connection is still crashing. Manual investigation needed.");
    lines.push("2. Check Gemini API status: https://status.cloud.google.com");
    lines.push("3. Try the non-native-audio model: gemini-live-2.5-flash-preview");
    lines.push("4. Review inputAudioTranscription config — must be exactly `{}`");
  } else if (phase === "phase-2-talk") {
    lines.push("1. WS connects but tutor is silent. Check Gemini session config.");
    lines.push("2. Verify mic audio reaches the WebSocket (check binary frame count).");
    lines.push("3. Try a simpler system prompt to rule out content filtering.");
  } else if (phase === "phase-3-draw") {
    lines.push("1. Tutor talks but canvas is blank. Check auto-scribe pipeline.");
    lines.push("2. Verify OverlayAnimator.add() is being called with valid commands.");
    lines.push("3. Check that the overlay canvas element is mounted and visible.");
  } else {
    lines.push("1. Focus on teaching quality improvements.");
    lines.push("2. Review Khan Academy examples for the tested math concepts.");
    lines.push("3. Tune the system prompt for more interactive whiteboard teaching.");
  }
  lines.push("");

  // ---- Approaches tried ----
  lines.push("## Approaches Tried");
  if (state.triedApproaches.length > 0) {
    for (const a of state.triedApproaches) {
      lines.push(`- ${a}`);
    }
  } else {
    lines.push("None recorded.");
  }

  return lines.join("\n");
}
