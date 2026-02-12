/**
 * Overnight adapter — converts CycleRecord to ContextRecord<OvernightCyclePayload>.
 */

import type { OvernightCyclePayload, ContextRecord } from "../types.js";

/** Minimal shape matching CycleRecord from overnight-types.ts. */
export type OvernightAdapterInput = {
  cycle: number;
  phase: string;
  strategy: string;
  stopReason: string;
  iterations: number;
  score: number | null;
  diagnoses: string[];
  changedFiles: string[];
  scoreImproved: boolean;
};

/**
 * Convert overnight cycle data into a ContextRecord shape.
 */
export function overnightCycleToRecord(
  input: OvernightAdapterInput,
  runId: string,
): Omit<ContextRecord<OvernightCyclePayload>, "meta"> & {
  domain: "overnight-cycle";
  scopeKey: string;
  tags: string[];
} {
  const payload: OvernightCyclePayload = {
    cycle: input.cycle,
    phase: input.phase,
    strategy: input.strategy,
    stopReason: input.stopReason,
    iterations: input.iterations,
    score: input.score,
    diagnoses: input.diagnoses,
    changedFiles: input.changedFiles,
    scoreImproved: input.scoreImproved,
  };

  const tags: string[] = [`phase:${input.phase}`, `strategy:${input.strategy}`];
  if (input.scoreImproved) {
    tags.push("improved");
  }

  return {
    domain: "overnight-cycle",
    scopeKey: runId,
    tags,
    payload,
  };
}
