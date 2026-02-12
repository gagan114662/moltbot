/**
 * QA adapter — converts IterationRecord + enriched data to ContextRecord<QaIterationPayload>.
 */

import type { QaIterationPayload, ContextRecord } from "../types.js";

/** Minimal shape of data needed from the voice QA loop. */
export type QaAdapterInput = {
  iteration: number;
  passed: boolean;
  nudgeSent: string;
  diffFull: string;
  changedFiles: string[];
  diagnoses: Array<{
    id?: string;
    rootCause: string;
    severity: string;
    suggestedFix: string;
  }>;
  consoleLogs: string[];
  consoleErrors: string[];
  wsEvents: Array<{
    type: string;
    closeCode?: number;
    payload?: string;
  }>;
  scorecard: { overall: number } | null;
};

/**
 * Convert QA iteration data into a ContextRecord shape.
 */
export function qaIterationToRecord(
  input: QaAdapterInput,
  loopId: string,
): Omit<ContextRecord<QaIterationPayload>, "meta"> & {
  domain: "qa-iteration";
  scopeKey: string;
  tags: string[];
} {
  const payload: QaIterationPayload = {
    iteration: input.iteration,
    passed: input.passed,
    nudgeSent: input.nudgeSent,
    diffFull: input.diffFull,
    changedFiles: input.changedFiles,
    diagnoses: input.diagnoses.map((d) => ({
      rootCause: d.rootCause,
      severity: d.severity,
      suggestedFix: d.suggestedFix,
    })),
    consoleLogs: input.consoleLogs,
    consoleErrors: input.consoleErrors,
    wsEvents: input.wsEvents,
    scorecard: input.scorecard,
  };

  const tags: string[] = [];
  for (const d of input.diagnoses) {
    if (d.id) {
      tags.push(`diagnosis:${d.id}`);
    }
  }
  if (input.passed) {
    tags.push("passed");
  }

  return {
    domain: "qa-iteration",
    scopeKey: loopId,
    tags,
    payload,
  };
}
