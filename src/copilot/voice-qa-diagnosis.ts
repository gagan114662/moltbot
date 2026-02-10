/**
 * Voice QA Diagnosis Engine
 *
 * Matches observable Playwright signals (WS events, console strings, HTTP status,
 * subtitle transcript) against a knowledge base of Gemini native audio bugs.
 * Produces actionable root-cause diagnoses instead of generic "tutor did not respond".
 */

import type { VoiceQaResult } from "./voice-qa.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DiagnosisSeverity = "critical" | "major" | "minor" | "info";

export type Diagnosis = {
  id: string;
  severity: DiagnosisSeverity;
  rootCause: string;
  explanation: string;
  suggestedFix: string;
  evidence: string[];
  /** How many results triggered this same diagnosis (for dedup). */
  count: number;
};

export type WsEvent = {
  timestamp: number;
  type: "open" | "close" | "message-sent" | "message-received" | "error";
  url?: string;
  closeCode?: number;
  closeReason?: string;
  /** Truncated payload for text frames; "<binary N bytes>" for binary. */
  payload?: string;
};

export type EnrichedVoiceQaResult = VoiceQaResult & {
  wsEvents: WsEvent[];
  /** Tool calls detected during this turn (for visual QA). */
  toolCalls?: string[];
  /** Visual assessment from screenshot analysis (for visual QA). */
  visualAssessment?: import("./voice-qa.js").VisualAssessment;
};

// ---------------------------------------------------------------------------
// Knowledge Base
// ---------------------------------------------------------------------------

type DiagnosisRule = {
  id: string;
  severity: DiagnosisSeverity;
  rootCause: string;
  explanation: string;
  suggestedFix: string;
  /** Return evidence strings if the rule matches, or empty array if not. */
  match: (result: EnrichedVoiceQaResult, allResults: EnrichedVoiceQaResult[]) => string[];
};

const SEVERITY_ORDER: Record<DiagnosisSeverity, number> = {
  critical: 0,
  major: 1,
  minor: 2,
  info: 3,
};

const KNOWLEDGE_BASE: DiagnosisRule[] = [
  // --- CRITICAL ---
  {
    id: "ws-1011-after-tool-response",
    severity: "critical",
    rootCause: "WebSocket 1011 after tool call",
    explanation:
      "The Gemini session crashed with code 1011 immediately after a tool response was sent. " +
      "Known server-side bug with native audio models (googleapis/python-genai#1832, #843, #3918).",
    suggestedFix:
      "In useScratchpadAI.ts, change tool response from `toolResponse` to `clientContent` with " +
      "`functionResponse` parts. See: google-gemini/cookbook#906.",
    match(result) {
      const evidence: string[] = [];
      const has1011 = result.wsEvents.some((e) => e.type === "close" && e.closeCode === 1011);
      // Only match raw `toolResponse` — NOT `functionResponse` inside `clientContent`
      // which is the WORKAROUND (already fixed in tutor-service.ts)
      const hasBrokenToolResponse = result.wsEvents.some(
        (e) =>
          e.type === "message-sent" &&
          e.payload &&
          /toolResponse/i.test(e.payload) &&
          !/clientContent/i.test(e.payload),
      );
      if (has1011 && hasBrokenToolResponse) {
        const closeEvt = result.wsEvents.find((e) => e.type === "close" && e.closeCode === 1011);
        const toolEvt = result.wsEvents.find(
          (e) => e.type === "message-sent" && e.payload && /toolResponse/i.test(e.payload),
        );
        if (closeEvt) {
          evidence.push(
            `WS close: code=1011, reason="${closeEvt.closeReason ?? ""}" at ${fmtTime(closeEvt.timestamp)}`,
          );
        }
        if (toolEvt?.payload) {
          evidence.push(
            `Last tool response sent: ${toolEvt.payload.slice(0, 200)}${toolEvt.payload.length > 200 ? "..." : ""}`,
          );
        }
      }
      return evidence;
    },
  },
  {
    id: "ws-1011-generic",
    severity: "critical",
    rootCause: "Gemini server crash (WS 1011)",
    explanation:
      "The Gemini WebSocket closed with code 1011 (Internal Error). " +
      "This is a known instability with native audio models.",
    suggestedFix:
      "Remove NON_BLOCKING scheduling, simplify tool schemas, and use clientContent " +
      "with functionResponse parts instead of toolResponse.",
    match(result) {
      const evidence: string[] = [];
      const closeEvt = result.wsEvents.find((e) => e.type === "close" && e.closeCode === 1011);
      if (closeEvt) {
        // Only match if ws-1011-after-tool-response didn't already match
        const hasToolFrame = result.wsEvents.some(
          (e) =>
            e.type === "message-sent" &&
            e.payload &&
            (/toolResponse/i.test(e.payload) || /functionResponse/i.test(e.payload)),
        );
        if (!hasToolFrame) {
          evidence.push(
            `WS close: code=1011, reason="${closeEvt.closeReason ?? ""}" at ${fmtTime(closeEvt.timestamp)}`,
          );
        }
      }
      return evidence;
    },
  },
  {
    id: "no-ws-session",
    severity: "critical",
    rootCause: "WebSocket session never established",
    explanation:
      "No WebSocket connections were detected during the test. " +
      "The Gemini Live session was never started.",
    suggestedFix:
      "Check API key validity, model name, Start Session button handler, " +
      "and network connectivity. Verify the WebSocket URL is correct.",
    match(result) {
      const evidence: string[] = [];
      const hasOpen = result.wsEvents.some((e) => e.type === "open");
      if (!hasOpen && !result.tutorResponse) {
        evidence.push("Zero WebSocket open events captured");
        if (!result.transcript) {
          evidence.push("No tutor transcript detected");
        }
      }
      return evidence;
    },
  },

  // --- MAJOR ---
  {
    id: "mic-heard-tutor-silent",
    severity: "major",
    rootCause: "Mic heard, tutor silent",
    explanation:
      "User speech was recognized (subtitle showed 'You' speaker) but the tutor " +
      "never responded. Audio is reaching the browser but not being processed by Gemini.",
    suggestedFix:
      "Check Gemini session state after audio starts, verify audio format " +
      "compatibility, and ensure event handlers for serverContent are wired correctly.",
    match(result) {
      const evidence: string[] = [];
      if (result.transcript && !result.tutorResponse) {
        evidence.push(`User speech recognized: "${result.transcript}"`);
        evidence.push("No tutor response detected");
      }
      return evidence;
    },
  },
  {
    id: "function-call-malformed",
    severity: "major",
    rootCause: "Malformed function call from model",
    explanation:
      "The model returned a function call that couldn't be parsed. " +
      "Complex tool schemas with nested objects increase malformed call risk.",
    suggestedFix:
      "Simplify tool schemas — avoid nested objects with propertyOrdering. " +
      "Add try/catch around JSON.parse of function call arguments.",
    match(result) {
      const evidence: string[] = [];
      for (const log of [...result.consoleErrors, ...result.consoleLogs]) {
        if (/functionCall/i.test(log) && /JSON\.parse|SyntaxError/i.test(log)) {
          evidence.push(`Console: ${log.slice(0, 300)}`);
        }
      }
      return evidence;
    },
  },
  {
    id: "tool-response-delivery-failed",
    severity: "major",
    rootCause: "Tool response delivery failed",
    explanation:
      "A tool/function response was sent but an error occurred during delivery. " +
      "The model never received the result.",
    suggestedFix:
      "Ensure both `name` and `id` fields are set on each FunctionResponse " +
      "(SDK line 12932). Check WebSocket readyState before sending.",
    match(result) {
      const evidence: string[] = [];
      for (const log of [...result.consoleErrors, ...result.consoleLogs]) {
        if (
          (/functionResponse/i.test(log) || /toolResponse/i.test(log)) &&
          (/error/i.test(log) || /fail/i.test(log))
        ) {
          evidence.push(`Console: ${log.slice(0, 300)}`);
        }
      }
      return evidence;
    },
  },
  {
    id: "ws-close-abnormal",
    severity: "major",
    rootCause: "Abnormal WebSocket disconnect",
    explanation:
      "The WebSocket closed with an unexpected code (not 1000/normal, not 1011/internal). " +
      "The session dropped unexpectedly.",
    suggestedFix: "Add WebSocket reconnection logic. Check message format and size limits.",
    match(result) {
      const evidence: string[] = [];
      for (const evt of result.wsEvents) {
        if (
          evt.type === "close" &&
          evt.closeCode !== undefined &&
          evt.closeCode !== 1000 &&
          evt.closeCode !== 1011
        ) {
          evidence.push(
            `WS close: code=${evt.closeCode}, reason="${evt.closeReason ?? ""}" at ${fmtTime(evt.timestamp)}`,
          );
        }
      }
      return evidence;
    },
  },
  {
    id: "hallucination-loop",
    severity: "major",
    rootCause: "Model stuck in hallucination loop",
    explanation:
      "The tutor gave identical responses to different prompts. " +
      "This happens when NON_BLOCKING scheduling causes the model to hallucinate " +
      "answers before tool results return (python-genai#1894).",
    suggestedFix:
      "Remove FunctionResponseScheduling.NON_BLOCKING from the session config. " +
      "Ensure tool responses are sent synchronously.",
    match(_result, allResults) {
      const evidence: string[] = [];
      const responses = allResults.filter((r) => r.tutorResponse).map((r) => r.tutorResponse!);

      if (responses.length >= 2) {
        const unique = new Set(responses);
        if (unique.size === 1) {
          evidence.push(
            `All ${responses.length} prompts received identical response: "${responses[0].slice(0, 100)}"`,
          );
        }
      }
      return evidence;
    },
  },

  // --- MAJOR (scratchpad-specific) ---
  {
    id: "tutor-greeting-only",
    severity: "major",
    rootCause: "Tutor greets but ignores the question",
    explanation:
      "The tutor responded with its initial greeting (e.g. 'Hey there! What are we learning today?') " +
      "instead of answering the student's actual question. This typically means the student's audio " +
      "arrived while the tutor was still generating its greeting, so Gemini ignored the student speech.",
    suggestedFix:
      "Increase the delay before the first student prompt to give the tutor time to finish its greeting. " +
      "Alternatively, disable the tutor's auto-greeting in the system prompt so it waits silently for the student. " +
      "In ai_tutor_system_prompt.md, change the opening instruction to: 'Wait silently for the student to speak first.'",
    match(result, allResults) {
      const evidence: string[] = [];
      // Check if tutor response looks like a greeting rather than an answer
      if (result.tutorResponse) {
        const resp = result.tutorResponse.toLowerCase();
        const isGreeting =
          /what.*(?:learn|div|curious|work on|study|today)/.test(resp) ||
          /hey there|hello|hi there|welcome/.test(resp);
        const promptLooksLikeQuestion =
          result.prompt?.toLowerCase().includes("what is") ||
          result.prompt?.toLowerCase().includes("how") ||
          result.prompt?.toLowerCase().includes("can you");
        if (isGreeting && promptLooksLikeQuestion) {
          evidence.push(
            `Student asked: "${result.prompt}" but tutor said: "${result.tutorResponse.slice(0, 100)}"`,
          );
          // Count how many results show this same pattern
          const greetingCount = allResults.filter(
            (r) =>
              r.tutorResponse &&
              /what.*(?:learn|div|curious|work on|study|today)|hey there|hello|hi there/i.test(
                r.tutorResponse,
              ),
          ).length;
          if (greetingCount > 1) {
            evidence.push(
              `${greetingCount} turns received greeting-style responses instead of answers`,
            );
          }
        }
      }
      return evidence;
    },
  },
  {
    id: "http-500-server-error",
    severity: "critical",
    rootCause: "Backend server error (HTTP 500)",
    explanation:
      "The scratchpad backend returned HTTP 500 errors. This means the Node.js server " +
      "or Python auth service is crashing on certain requests. The app cannot function " +
      "correctly until these endpoints are fixed.",
    suggestedFix:
      "Check the server terminal for stack traces. Common causes:\n" +
      "  - /conversation/turn 500: Gemini API key missing or expired in .env\n" +
      "  - /tutor/token-usage 500: Database connection issue or missing table\n" +
      "  - Auth service 500: Python venv not activated or missing deps\n" +
      "Fix the server errors FIRST before debugging the frontend.",
    match(result) {
      const evidence: string[] = [];
      for (const log of result.consoleLogs) {
        if (/\[HTTP 5\d\d\]/.test(log)) {
          evidence.push(log.slice(0, 300));
        }
      }
      return evidence;
    },
  },

  // --- MINOR ---
  {
    id: "get-user-media-failed",
    severity: "minor",
    rootCause: "Microphone not available",
    explanation:
      "getUserMedia failed — the audio device was not available. " +
      "The Web Audio API interceptor may not have loaded before the app called getUserMedia.",
    suggestedFix:
      "Ensure the page.addInitScript() runs before navigation. " +
      "Check that AudioContext creation succeeds (no autoplay policy block).",
    match(result) {
      const evidence: string[] = [];
      for (const log of [...result.consoleErrors, ...result.consoleLogs]) {
        if (/getUserMedia|NotAllowedError|NotFoundError/i.test(log)) {
          evidence.push(`Console: ${log.slice(0, 300)}`);
        }
      }
      return evidence;
    },
  },
  {
    id: "http-4xx-client-error",
    severity: "minor",
    rootCause: "HTTP client error (4xx)",
    explanation: "One or more HTTP requests returned a 4xx status code (auth, not found, etc.).",
    suggestedFix:
      "Check authentication tokens and request URLs. 401 = expired JWT, 404 = wrong endpoint.",
    match(result) {
      const evidence: string[] = [];
      for (const log of result.consoleLogs) {
        if (/\[HTTP 4\d\d\]/.test(log)) {
          evidence.push(log.slice(0, 300));
        }
      }
      return evidence;
    },
  },

  // --- VISUAL QA ---
  {
    id: "canvas-blank-after-draw",
    severity: "critical",
    rootCause: "Canvas blank after draw tool called",
    explanation:
      "A drawing tool was called but the canvas shows no content. " +
      "The tool handler may not be wiring into the overlay animator, or the canvas render loop isn't running.",
    suggestedFix:
      "Check canvas-renderer.ts draw handlers and useScratchpadAI.ts tool response wiring. " +
      "Verify overlayAnimator.addItem() is called after each draw tool execution.",
    match(result) {
      const evidence: string[] = [];
      const hasDrawCall = (result.toolCalls ?? []).some((t) => t.startsWith("draw"));
      const visualBlank = result.visualAssessment && !result.visualAssessment.drawingCorrect;
      if (hasDrawCall && visualBlank) {
        evidence.push(
          `Tool calls: ${(result.toolCalls ?? []).join(", ")} but drawing is incorrect/blank`,
        );
        if (result.visualAssessment?.canvasDescription) {
          evidence.push(`Canvas: ${result.visualAssessment.canvasDescription}`);
        }
      }
      return evidence;
    },
  },
  {
    id: "text-overlap-header",
    severity: "major",
    rootCause: "Content overlapping header zone",
    explanation:
      "Text or drawings are rendering in the reserved top 240px header zone, " +
      "overlapping the question display. Y coordinates should be >= 240.",
    suggestedFix:
      "In useScratchpadAI.ts, enforce y >= 240 for all write_step and draw_* calls. " +
      "Clamp the y parameter before passing to the canvas renderer.",
    match(result) {
      const evidence: string[] = [];
      if (result.visualAssessment) {
        for (const issue of result.visualAssessment.issues) {
          if (/overlap|header|top/i.test(issue.description)) {
            evidence.push(`Visual: ${issue.description}`);
          }
        }
      }
      return evidence;
    },
  },
  {
    id: "visual-score-low",
    severity: "major",
    rootCause: "Poor visual quality (score < 50)",
    explanation:
      "The overall visual quality is below the acceptable threshold. " +
      "Multiple visual issues detected on the blackboard.",
    suggestedFix:
      "Review individual visual issues in the assessment. Common fixes: ensure proper " +
      "spacing between elements, use contrasting colors, avoid overlapping text.",
    match(result) {
      const evidence: string[] = [];
      if (result.visualAssessment && result.visualAssessment.score < 50) {
        evidence.push(`Visual score: ${result.visualAssessment.score}/100`);
        for (const issue of result.visualAssessment.issues.slice(0, 3)) {
          evidence.push(`[${issue.severity.toUpperCase()}] ${issue.description}`);
        }
      }
      return evidence;
    },
  },

  // --- INFO (fallback) ---
  {
    id: "no-tutor-response-generic",
    severity: "info",
    rootCause: "Unknown cause",
    explanation:
      "The tutor did not respond and no specific root cause could be identified. " +
      "Manual investigation is needed.",
    suggestedFix:
      "Check browser console logs, network tab, and Gemini API dashboard for errors. " +
      "Try running the app manually to reproduce.",
    match(result) {
      if (!result.tutorResponse && !result.passed) {
        return ["No tutor response and no specific diagnostic signal detected"];
      }
      return [];
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtTime(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19);
}

// ---------------------------------------------------------------------------
// Console → WsEvent enrichment
// ---------------------------------------------------------------------------

/**
 * Extract WebSocket close codes from console logs and merge into wsEvents.
 * Playwright's WebSocket API doesn't expose close codes, but the app often
 * logs them (e.g. "WebSocket closed: code=1011, reason=Internal error").
 */
export function enrichWsEventsFromConsole(wsEvents: WsEvent[], consoleLogs: string[]): WsEvent[] {
  const enriched = [...wsEvents];

  for (const log of consoleLogs) {
    // Match patterns like "close code: 1011", "code=1011", "WebSocket closed: code 1011"
    const codeMatch = log.match(/(?:close\s*)?code[=:\s]+(\d{4})/i);
    if (!codeMatch) {
      continue;
    }
    const code = parseInt(codeMatch[1], 10);
    if (code < 1000 || code > 4999) {
      continue;
    }

    const reasonMatch = log.match(/reason[=:\s]+"?([^"}\n]+)"?/i);
    const reason = reasonMatch?.[1]?.trim();

    // Check if we already have a close event with this code
    const existing = enriched.find((e) => e.type === "close" && e.closeCode === code);
    if (existing) {
      // Enrich existing event with reason if missing
      if (!existing.closeReason && reason) {
        existing.closeReason = reason;
      }
      continue;
    }

    enriched.push({
      timestamp: Date.now(),
      type: "close",
      closeCode: code,
      closeReason: reason,
    });
  }

  return enriched;
}

// ---------------------------------------------------------------------------
// Diagnosis engine
// ---------------------------------------------------------------------------

/**
 * Run all knowledge base rules against enriched results.
 * Deduplicates by rootCause, sorts critical-first, suppresses generic fallback
 * when a specific diagnosis exists.
 */
export function diagnose(results: EnrichedVoiceQaResult[]): Diagnosis[] {
  const diagMap = new Map<string, Diagnosis>();
  const failedResults = results.filter((r) => !r.passed);

  for (const result of failedResults) {
    for (const rule of KNOWLEDGE_BASE) {
      // Skip fallback for now
      if (rule.id === "no-tutor-response-generic") {
        continue;
      }

      const evidence = rule.match(result, failedResults);
      if (evidence.length === 0) {
        continue;
      }

      const existing = diagMap.get(rule.id);
      if (existing) {
        existing.count++;
        for (const e of evidence) {
          if (!existing.evidence.includes(e)) {
            existing.evidence.push(e);
          }
        }
      } else {
        diagMap.set(rule.id, {
          id: rule.id,
          severity: rule.severity,
          rootCause: rule.rootCause,
          explanation: rule.explanation,
          suggestedFix: rule.suggestedFix,
          evidence,
          count: 1,
        });
      }
    }
  }

  // Add generic fallback only if no specific diagnosis was found
  if (diagMap.size === 0) {
    const fallback = KNOWLEDGE_BASE.find((r) => r.id === "no-tutor-response-generic")!;
    for (const result of failedResults) {
      const evidence = fallback.match(result, failedResults);
      if (evidence.length > 0) {
        diagMap.set(fallback.id, {
          id: fallback.id,
          severity: fallback.severity,
          rootCause: fallback.rootCause,
          explanation: fallback.explanation,
          suggestedFix: fallback.suggestedFix,
          evidence,
          count: 1,
        });
        break;
      }
    }
  }

  // Sort by severity (critical first), then by count (higher first)
  return [...diagMap.values()].toSorted((a, b) => {
    const sevDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sevDiff !== 0) {
      return sevDiff;
    }
    return b.count - a.count;
  });
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Format a markdown diagnosis report for QA-FEEDBACK.md. */
/** Check if a suggestedFix string looks like a unified diff block. */
function isDiffBlock(text: string): boolean {
  return /^---\s+a\//.test(text) || /^@@\s/.test(text) || /\n@@\s/.test(text);
}

export function formatDiagnosisReport(diagnoses: Diagnosis[]): string {
  if (diagnoses.length === 0) {
    return "No diagnostic signals detected.";
  }

  const sections: string[] = [];

  for (const d of diagnoses) {
    const badge = `[${d.severity.toUpperCase()}]`;
    const countNote = d.count > 1 ? ` (${d.count} occurrences)` : "";
    sections.push(`## ${badge} ROOT CAUSE: ${d.rootCause}${countNote}`);
    sections.push(d.explanation);
    sections.push("");
    sections.push("### Fix");
    // Wrap unified diff blocks in ```diff fences for markdown rendering
    if (isDiffBlock(d.suggestedFix)) {
      sections.push("```diff");
      sections.push(d.suggestedFix);
      sections.push("```");
    } else {
      sections.push(d.suggestedFix);
    }
    sections.push("");
    if (d.evidence.length > 0) {
      sections.push("### Evidence");
      for (const e of d.evidence) {
        sections.push(`- ${e}`);
      }
      sections.push("");
    }
  }

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// LLM-powered diagnosis
// ---------------------------------------------------------------------------

/** Source file content for code-aware diagnosis. */
export type SourceFile = {
  path: string;
  content: string;
};

/** Build a rich prompt for an LLM to diagnose voice QA failures.
 *  When sourceFiles are provided, Codex can reference actual code for specific fixes. */
export function buildLlmDiagnosisPrompt(
  results: EnrichedVoiceQaResult[],
  staticDiagnoses: Diagnosis[],
  sourceFiles?: SourceFile[],
): string {
  const parts: string[] = [];

  parts.push(
    "You are a senior QA engineer debugging a Gemini Live API voice tutor app (Scratchpad).",
  );
  parts.push("The app uses the `gemini-2.5-flash-native-audio-preview` model via WebSocket.");
  parts.push("Architecture: React frontend (Vite, port 3000) → Gemini LiveAPI WebSocket.");
  parts.push(
    "Key files: useScratchpadAI.ts (tool handler), canvas-renderer.ts (drawing), TutorClient (WS).",
  );
  parts.push("");
  parts.push(
    "Your diagnosis will be shown to another Claude instance working on the scratchpad project.",
  );
  parts.push(
    "Be EXTREMELY SPECIFIC — reference exact file:line numbers from the source code below.",
  );
  parts.push("Do NOT give generic advice like 'check the logs'. Give the EXACT fix needed.");
  parts.push("");
  parts.push("## Known Bugs (Gemini Native Audio)");
  parts.push(
    "- `sendToolResponse` causes WebSocket 1011 'Internal error' — server-side bug (googleapis/python-genai#1832, #843, #3918)",
  );
  parts.push(
    "- WORKAROUND (ALREADY APPLIED in tutor-service.ts): Tool responses are sent as `functionResponse` parts inside `clientContent` via `sendClientContent()` instead of raw `toolResponse`. Check tutor-service.ts source code below to confirm.",
  );
  parts.push(
    "- DO NOT suggest the sendToolResponse fix if tutor-service.ts already uses sendClientContent — look for other root causes instead.",
  );
  parts.push(
    "- NON_BLOCKING scheduling causes model to hallucinate answers before tool results return (python-genai#1894)",
  );
  parts.push("- FunctionResponseScheduling.SILENT is rejected by server on native audio models");
  parts.push(
    "- SDK requires both `name` AND `id` on each FunctionResponse (@google/genai SDK line 12932)",
  );
  parts.push(
    "- Complex tool schemas with nested objects/propertyOrdering increase malformed function call risk",
  );
  parts.push(
    "- Fallback model `gemini-live-2.5-flash-preview` has reliable function calling but worse audio quality",
  );
  parts.push("");

  // Include static diagnosis results for context
  if (staticDiagnoses.length > 0) {
    parts.push("## Static Rule Diagnosis (already detected)");
    for (const d of staticDiagnoses) {
      parts.push(`- [${d.severity.toUpperCase()}] ${d.rootCause}: ${d.explanation.slice(0, 200)}`);
    }
    parts.push("");
  }

  // Include each failed result with all signals
  const failed = results.filter((r) => !r.passed);
  parts.push(`## Test Results (${failed.length} failed out of ${results.length})`);
  parts.push("");

  for (const [idx, r] of failed.entries()) {
    parts.push(`### Failed Test ${idx + 1}: "${r.prompt ?? "unknown"}"`);
    if (r.error) {
      parts.push(`Error: ${r.error}`);
    }
    if (r.transcript) {
      parts.push(`User speech recognized: "${r.transcript}"`);
    }
    if (r.tutorResponse) {
      parts.push(`Tutor response: "${r.tutorResponse}"`);
    } else {
      parts.push("Tutor response: NONE");
    }

    // Console errors (truncated)
    if (r.consoleErrors.length > 0) {
      parts.push("Console errors:");
      for (const e of r.consoleErrors.slice(0, 10)) {
        parts.push(`  - ${e.slice(0, 500)}`);
      }
    }

    // Console logs (last 20, truncated)
    if (r.consoleLogs.length > 0) {
      parts.push(`Console logs (last 20 of ${r.consoleLogs.length}):`);
      for (const l of r.consoleLogs.slice(-20)) {
        parts.push(`  ${l.slice(0, 500)}`);
      }
    }

    // WebSocket events
    if (r.wsEvents.length > 0) {
      parts.push(`WebSocket events (${r.wsEvents.length}):`);
      for (const evt of r.wsEvents.slice(-30)) {
        const time = fmtTime(evt.timestamp);
        if (evt.type === "close") {
          parts.push(
            `  [${time}] WS CLOSE code=${evt.closeCode ?? "?"} reason="${evt.closeReason ?? ""}"`,
          );
        } else if (evt.type === "open") {
          parts.push(`  [${time}] WS OPEN ${evt.url ?? ""}`);
        } else if (evt.type === "error") {
          parts.push(`  [${time}] WS ERROR`);
        } else {
          const dir = evt.type === "message-sent" ? "SENT" : "RECV";
          parts.push(`  [${time}] WS ${dir} ${evt.payload?.slice(0, 200) ?? "<no payload>"}`);
        }
      }
    }
    parts.push("");
  }

  // Include actual source code for code-aware diagnosis
  if (sourceFiles && sourceFiles.length > 0) {
    parts.push("## Source Code (from the project under test)");
    parts.push("Use this code to give SPECIFIC fixes with exact file paths and line numbers.");
    parts.push("");
    for (const file of sourceFiles) {
      parts.push(`### ${file.path}`);
      parts.push("```typescript");
      parts.push(file.content);
      parts.push("```");
      parts.push("");
    }
  }

  parts.push("## Instructions");
  parts.push("Analyze the test signals AND the source code above.");
  parts.push("Produce a JSON array of diagnoses. Each diagnosis should have:");
  parts.push(
    '  { "severity": "critical"|"major"|"minor", "rootCause": "short label", "explanation": "detailed explanation", "suggestedFix": "unified diff — see format below", "evidence": ["signal1", "signal2"] }',
  );
  parts.push("");
  parts.push(
    "CRITICAL: Your suggestedFix MUST be a unified diff that Claude can apply directly with `git apply`.",
  );
  parts.push("Format each suggestedFix as:");
  parts.push("--- a/src/hooks/useScratchpadAI.ts");
  parts.push("+++ b/src/hooks/useScratchpadAI.ts");
  parts.push("@@ -LINE,COUNT +LINE,COUNT @@");
  parts.push(" context line before");
  parts.push("-    old code to remove");
  parts.push("+    new code to add");
  parts.push(" context line after");
  parts.push("");
  parts.push("Include 1-3 context lines before/after each change so git apply can locate it.");
  parts.push("If the fix spans multiple files, include multiple diff hunks in one suggestedFix.");
  parts.push(
    "If you cannot determine the exact diff, fall back to a file:line description as last resort.",
  );
  parts.push("");
  parts.push(
    "Focus on actionable root causes. Do NOT repeat the static rule diagnoses above — only add NEW insights.",
  );
  parts.push("If the static rules already cover everything, return an empty array: []");
  parts.push(
    "Look for patterns across multiple test results, timing correlations in WS events, and specific error messages.",
  );
  parts.push("");
  parts.push("## Pedagogical Quality (also assess these)");
  parts.push("- Did the tutor explain concepts step-by-step, or just give bare answers?");
  parts.push("- Did the tutor use the whiteboard when asked? Were drawings relevant?");
  parts.push("- Did the tutor maintain context across turns (reference previous answers)?");
  parts.push("- Was the tone warm, encouraging, and age-appropriate (like Sal Khan)?");
  parts.push(
    "If pedagogical issues exist, include them as diagnoses with severity 'minor' and rootCause starting with 'Pedagogy:'.",
  );

  return parts.join("\n");
}

/** Parse LLM diagnosis response into Diagnosis objects. */
export function parseLlmDiagnosis(response: string): Diagnosis[] {
  // Extract JSON array from response (may be in markdown code blocks)
  const jsonMatch = response.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    return [];
  }

  let raw: Array<{
    severity?: string;
    rootCause?: string;
    explanation?: string;
    suggestedFix?: string;
    evidence?: string[];
  }>;
  try {
    raw = JSON.parse(jsonMatch[0]);
  } catch {
    return [];
  }

  if (!Array.isArray(raw)) {
    return [];
  }

  const diagnoses: Diagnosis[] = [];
  for (const item of raw) {
    if (!item.rootCause || !item.explanation) {
      continue;
    }
    const severity = normalizeDiagSeverity(item.severity ?? "major");
    diagnoses.push({
      id: `llm-${slugify(item.rootCause)}`,
      severity,
      rootCause: item.rootCause,
      explanation: item.explanation,
      suggestedFix: item.suggestedFix ?? "See explanation above.",
      evidence: Array.isArray(item.evidence) ? item.evidence : [],
      count: 1,
    });
  }

  return diagnoses;
}

function normalizeDiagSeverity(s: string): DiagnosisSeverity {
  const lower = s.toLowerCase();
  if (lower === "critical") {
    return "critical";
  }
  if (lower === "major") {
    return "major";
  }
  if (lower === "minor") {
    return "minor";
  }
  return "major";
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

/** Merge LLM diagnoses with static diagnoses, deduplicating by rootCause similarity. */
export function mergeDiagnoses(staticDiags: Diagnosis[], llmDiags: Diagnosis[]): Diagnosis[] {
  const merged = [...staticDiags];
  const existingCauses = new Set(staticDiags.map((d) => d.rootCause.toLowerCase()));

  for (const llmDiag of llmDiags) {
    // Skip if a static rule already covers this root cause
    const lower = llmDiag.rootCause.toLowerCase();
    let isDuplicate = false;
    for (const existing of existingCauses) {
      // Fuzzy dedup — if >50% of words overlap, skip
      const llmWords = new Set(lower.split(/\s+/));
      const existWords = new Set(existing.split(/\s+/));
      const overlap = [...llmWords].filter((w) => existWords.has(w)).length;
      if (overlap > Math.min(llmWords.size, existWords.size) * 0.5) {
        isDuplicate = true;
        break;
      }
    }
    if (!isDuplicate) {
      merged.push(llmDiag);
      existingCauses.add(lower);
    }
  }

  // Re-sort by severity
  return merged.toSorted((a, b) => {
    const sevDiff = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (sevDiff !== 0) {
      return sevDiff;
    }
    return b.count - a.count;
  });
}

/**
 * Build a one-line tmux nudge with top-2 diagnoses.
 * E.g. "Voice QA 1/5 FAILED: WS 1011 after tool call; mic heard, tutor silent. Read QA-FEEDBACK.md..."
 */
export function buildDiagnosisNudge(
  iteration: number,
  max: number,
  diagnoses: Diagnosis[],
): string {
  if (diagnoses.length === 0) {
    return `Voice QA ${iteration}/${max} FAILED: see QA-FEEDBACK.md for details. Read QA-FEEDBACK.md, fix all issues, then say done.`;
  }

  const top2 = diagnoses.slice(0, 2).map((d) => d.rootCause);
  const detail = top2.join("; ");
  const extra = diagnoses.length > 2 ? ` (+${diagnoses.length - 2} more)` : "";

  return `Voice QA ${iteration}/${max} FAILED: ${detail}${extra}. Read QA-FEEDBACK.md, fix all issues, then say done.`;
}
