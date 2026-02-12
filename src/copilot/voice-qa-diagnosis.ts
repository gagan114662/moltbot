/**
 * Voice QA Diagnosis Engine
 *
 * Matches observable Playwright signals (WS events, console strings, HTTP status,
 * subtitle transcript) against a knowledge base of Gemini native audio bugs.
 * Produces actionable root-cause diagnoses instead of generic "tutor did not respond".
 */

import {
  isGreetingResponse,
  type CanvasChangeInfo,
  type ScreenshotSet,
  type VoiceQaResult,
} from "./voice-qa.js";

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

/** Structured Khan Academy quality scorecard from one-shot analysis. */
export type ExperienceScorecard = {
  /** Overall quality 1-10 (Khan Academy standard). */
  overall: number;
  /** Visual clarity: layout, colors, spacing, readability (1-5). */
  visualClarity: number;
  /** Teaching effectiveness: step-by-step, builds understanding (1-5). */
  teachingEffectiveness: number;
  /** Scratchpad usage: relevant drawings, clears before redraw (1-5). */
  scratchpadUsage: number;
  /** Conversation flow: warm, encouraging, responsive (1-5). */
  conversationFlow: number;
  /** Age appropriateness: 3rd grader would understand (1-5). */
  ageAppropriateness: number;
  /** Specific aesthetic issues spotted. */
  aestheticNotes: string[];
  /** Direct comparison to what Khan Academy would do. */
  khanComparison: string;
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
  /** Frontend health snapshot from Playwright DOM inspection. */
  pageHealth?: import("./types.js").PageHealthReport;
  /** Response latency in ms (prompt end → first tutor response). */
  responseLatencyMs?: number;
  /** Before/after screenshots for multimodal analysis. */
  screenshots?: ScreenshotSet;
  /** Canvas pixel checksum change detection. */
  canvasChange?: CanvasChangeInfo;
};

/** Auto-scribe pipeline status extracted from console logs. */
export type AutoScribeStatus = {
  /** Count of [AutoScribe] outputTranscript: events. */
  transcriptEvents: number;
  /** Whether auto-scribe attempted a Gemini Flash API call. */
  attempted: boolean;
  /** Number of commands executed (from "Executing N commands"). */
  executed: number;
  /** Whether all commands were filtered out. */
  filtered: boolean;
  /** Error message if auto-scribe crashed. */
  error?: string;
  /** Fallback reason (e.g. "no-math-transcript", "missing-api-key"). */
  fallbackReason?: string;
  /** Whether auto-scribe skipped due to "no clear math". */
  skipped: boolean;
  /** Specific filter reasons (e.g. "too-long", "non-math", "duplicate"). */
  filterReasons?: string[];
};

/** Extract auto-scribe pipeline status from Playwright-captured console logs. */
export function extractAutoScribeStatus(consoleLogs: string[]): AutoScribeStatus {
  let transcriptEvents = 0;
  let attempted = false;
  let executed = 0;
  let filtered = false;
  let error: string | undefined;
  let fallbackReason: string | undefined;
  let skipped = false;
  const filterReasons: string[] = [];

  for (const log of consoleLogs) {
    if (log.includes("[AutoScribe] outputTranscript:")) {
      transcriptEvents++;
    }
    if (log.includes("[AutoScribe] Raw response:")) {
      attempted = true;
    }
    const execMatch = log.match(/\[AutoScribe\] Executing (\d+) commands/);
    if (execMatch) {
      attempted = true;
      executed += parseInt(execMatch[1], 10);
    }
    if (log.includes("[AutoScribe] All commands filtered out")) {
      filtered = true;
      attempted = true;
      filterReasons.push("all-filtered");
    }
    if (log.includes("[AutoScribe] Filtering out long text:")) {
      filtered = true;
      attempted = true;
      filterReasons.push("too-long");
    }
    if (log.includes("[AutoScribe] Filtering out non-math text:")) {
      filtered = true;
      attempted = true;
      filterReasons.push("non-math");
    }
    if (log.includes("[AutoScribe] Filtering out duplicate:")) {
      filtered = true;
      attempted = true;
      filterReasons.push("duplicate");
    }
    if (log.includes("[AutoScribe] Immediate fallback")) {
      fallbackReason = "no-math-transcript";
    }
    const errorMatch = log.match(/\[AutoScribe\] Error:\s*(.+)/);
    if (errorMatch) {
      error = errorMatch[1].slice(0, 200);
      attempted = true;
    }
    const fallbackMatch = log.match(/\[AutoScribe\] Fallback draw:\s*(\S+)/);
    if (fallbackMatch) {
      fallbackReason = fallbackMatch[1];
    }
    if (log.includes("[AutoScribe] Skipping")) {
      skipped = true;
    }
  }

  return {
    transcriptEvents,
    attempted,
    executed,
    filtered,
    error,
    fallbackReason,
    skipped,
    filterReasons: filterReasons.length > 0 ? filterReasons : undefined,
  };
}

/** Format auto-scribe status as a human-readable summary line. */
export function formatAutoScribeStatus(status: AutoScribeStatus): string {
  const parts: string[] = [];
  parts.push(`${status.transcriptEvents} transcript events`);
  if (!status.attempted && !status.skipped) {
    parts.push("auto-scribe NOT triggered");
  } else if (status.skipped) {
    parts.push("skipped (no math detected)");
  } else if (status.error) {
    parts.push(`ERROR: ${status.error}`);
  } else if (status.filtered) {
    const reasons = status.filterReasons
      ? ` (reasons: ${[...new Set(status.filterReasons)].join(", ")})`
      : "";
    parts.push(`all commands filtered out${reasons}`);
  } else if (status.executed > 0) {
    parts.push(`executed ${status.executed} commands`);
  } else {
    parts.push("attempted but 0 commands");
  }
  if (status.fallbackReason) {
    parts.push(`fallback: ${status.fallbackReason}`);
  }
  return parts.join(" → ");
}

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
        const greeting = isGreetingResponse(result.tutorResponse);
        const promptLooksLikeQuestion =
          result.prompt?.toLowerCase().includes("what is") ||
          result.prompt?.toLowerCase().includes("how") ||
          result.prompt?.toLowerCase().includes("can you");
        if (greeting && promptLooksLikeQuestion) {
          evidence.push(
            `Student asked: "${result.prompt}" but tutor said: "${result.tutorResponse.slice(0, 100)}"`,
          );
          // Count how many results show this same pattern
          const greetingCount = allResults.filter(
            (r) => r.tutorResponse && isGreetingResponse(r.tutorResponse),
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

  // --- VISUAL QUALITY ---
  {
    id: "canvas-overwriting",
    severity: "major",
    rootCause: "Canvas content overwriting previous drawings",
    explanation:
      "New content is being drawn on top of existing content without clearing first. " +
      "This makes the scratchpad unreadable — overlapping text and shapes become a mess. " +
      "The canvas should be cleared (or a new region used) before drawing the next step.",
    suggestedFix:
      "Call clear_canvas before drawing new content for a different problem, or " +
      "use write_step with incrementing y-coordinates to avoid overlap. " +
      "In useScratchpadAI.ts, track the last drawn y-position and offset new content.",
    match(result) {
      const evidence: string[] = [];
      // Canvas changed but visual assessment says content is overlapping/unreadable
      if (result.canvasChange?.changed && result.visualAssessment) {
        for (const issue of result.visualAssessment.issues) {
          if (/overlap|overwrite|unreadable|on top/i.test(issue.description)) {
            evidence.push(`Visual: ${issue.description}`);
          }
        }
        // Also flag if score is low and canvas changed (likely overwriting)
        if (result.visualAssessment.score < 30 && evidence.length === 0) {
          evidence.push(
            `Canvas changed (${result.canvasChange.checksumBefore} → ${result.canvasChange.checksumAfter}) but visual score is ${result.visualAssessment.score}/100`,
          );
        }
      }
      return evidence;
    },
  },
  {
    id: "irrelevant-drawing",
    severity: "major",
    rootCause: "Drawing doesn't match the math topic",
    explanation:
      "The tutor drew something that doesn't relate to what's being discussed. " +
      "Random shapes, circles, or decorative elements distract from the lesson. " +
      "Every drawing should directly support the mathematical concept being taught.",
    suggestedFix:
      "In the system prompt (ai_tutor_system_prompt.md), explicitly instruct: " +
      "'Only draw content that directly illustrates the math concept. No decorative shapes.' " +
      "Check tool call arguments match the current topic.",
    match(result) {
      const evidence: string[] = [];
      if (result.visualAssessment) {
        for (const issue of result.visualAssessment.issues) {
          if (/irrelevant|random|decorat|unrelated|doesn't match/i.test(issue.description)) {
            evidence.push(`Visual: ${issue.description}`);
          }
        }
        // Pedagogy score: low drawing relevance
        if (
          result.visualAssessment.pedagogyScore &&
          result.visualAssessment.pedagogyScore.drawingRelevance <= 2
        ) {
          evidence.push(
            `Pedagogy: drawing relevance score ${result.visualAssessment.pedagogyScore.drawingRelevance}/5`,
          );
        }
      }
      return evidence;
    },
  },

  // --- AUTO-SCRIBE (native audio model fallback rendering) ---
  {
    id: "no-output-transcript",
    severity: "critical",
    rootCause: "No outputTranscription events — auto-scribe has nothing to work with",
    explanation:
      "The Gemini native audio model is not emitting outputTranscription events. " +
      "Without transcript text, auto-scribe cannot extract math to render on the canvas. " +
      "Check that `outputAudioTranscription: { enable: true }` is in the LiveConnectConfig.",
    suggestedFix:
      "In tutor-service.ts, ensure `fullConfig.outputAudioTranscription = { enable: true }` " +
      "is set BEFORE connecting. Verify in console logs that [TutorService] shows the config key.",
    match(_result, allResults) {
      const allLogs = allResults.flatMap((r) => r.consoleLogs);
      const status = extractAutoScribeStatus(allLogs);
      if (status.transcriptEvents === 0 && allLogs.length > 0) {
        return [
          `0 outputTranscript events across ${allResults.length} turn(s) — model is silent or transcript disabled`,
        ];
      }
      return [];
    },
  },
  {
    id: "auto-scribe-api-error",
    severity: "critical",
    rootCause: "Auto-scribe Gemini Flash API call failed",
    explanation:
      "Auto-scribe attempted to call Gemini Flash to extract math from Adam's speech, " +
      "but the API call threw an error. Check VITE_GEMINI_API_KEY and API quota.",
    suggestedFix:
      "Verify VITE_GEMINI_API_KEY in .env.local is valid and not rate-limited. " +
      "Check the browser console for the specific error message.",
    match(_result, allResults) {
      const allLogs = allResults.flatMap((r) => r.consoleLogs);
      const status = extractAutoScribeStatus(allLogs);
      if (status.error) {
        return [`Auto-scribe error: ${status.error}`];
      }
      return [];
    },
  },
  {
    id: "auto-scribe-all-filtered",
    severity: "major",
    rootCause: "Auto-scribe commands filtered out by post-processing",
    explanation:
      "Auto-scribe received a response from Gemini Flash but all commands were removed by " +
      "the post-filter (hasMathHints check, 40-char limit, or duplicate detection).",
    suggestedFix:
      "In useScratchpadAI.ts, review the post-filter in runAutoScribe. The hasMathHints regex " +
      "or 40-char limit may be too aggressive. Check [AutoScribe] console logs for 'Filtering out' details.",
    match(_result, allResults) {
      const allLogs = allResults.flatMap((r) => r.consoleLogs);
      const status = extractAutoScribeStatus(allLogs);
      if (status.filtered && status.executed === 0) {
        return ["Auto-scribe API returned commands but all were filtered out"];
      }
      return [];
    },
  },
  {
    id: "auto-scribe-ok-canvas-unchanged",
    severity: "critical",
    rootCause: "Auto-scribe executed commands but canvas stayed blank",
    explanation:
      "Auto-scribe successfully extracted math and sent commands to the OverlayAnimator, " +
      "but the canvas pixel checksum didn't change. The canvas rendering pipeline is broken — " +
      "most likely the OverlayAnimator's attach() captured canvas.width/height as 0 (CSS-sized " +
      "canvas without explicit HTML width/height attributes), so all drawing goes to an invisible 0x0 surface.",
    suggestedFix:
      "In canvas-renderer.ts attach(), the bug is: `this.width = canvas.width; this.height = canvas.height;` — " +
      "these read the HTML attributes, not the CSS size. If the canvas uses CSS sizing (width:100%), the HTML " +
      "attributes default to 0. Fix: use canvas.getBoundingClientRect() or ensure the canvas element has explicit " +
      "width/height attributes set before attach() is called. Also check ScratchpadAIOverlay.tsx — the overlay " +
      "canvas must have width/height attributes matching its CSS size.",
    match(result, allResults) {
      const allLogs = allResults.flatMap((r) => r.consoleLogs);
      const status = extractAutoScribeStatus(allLogs);
      if (status.executed > 0 && result.canvasChange && !result.canvasChange.changed) {
        return [
          `Auto-scribe executed ${status.executed} commands but canvas checksum unchanged ` +
            `(${result.canvasChange.checksumBefore} → ${result.canvasChange.checksumAfter})`,
        ];
      }
      return [];
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

/** Minimal iteration context for the LLM prompt — what was tried in previous iterations. */
export type IterationContext = {
  iteration: number;
  nudgeSent: string;
  diffStat: string;
  changedFiles: string[];
  /** Last ~30 lines of Claude's tmux output. */
  tmuxScrollbackTail: string;
  diffMatchResult: string;
  previousDiagnoses: string[];
  /** Truncated unified diff of what the agent actually changed. */
  diffSnippet?: string;
  /** Whether the agent's changes compiled successfully. */
  compileOk?: boolean;
};

/** Build a rich prompt for an LLM to diagnose voice QA failures.
 *  When sourceFiles are provided, Codex can reference actual code for specific fixes. */
export function buildLlmDiagnosisPrompt(
  results: EnrichedVoiceQaResult[],
  staticDiagnoses: Diagnosis[],
  sourceFiles?: SourceFile[],
  iterationHistory?: IterationContext[],
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

  // Include iteration history so LLM knows what was tried before
  if (iterationHistory && iterationHistory.length > 0) {
    parts.push("## Previous Attempts (iteration history)");
    parts.push(
      "Claude has been nudged to fix issues in previous iterations. Use this context to suggest DIFFERENT fixes if previous ones didn't work.",
    );
    parts.push("");
    for (const ctx of iterationHistory) {
      parts.push(`### Iteration ${ctx.iteration}`);
      parts.push(`Nudge sent: "${ctx.nudgeSent}"`);
      parts.push(`Files changed: ${ctx.changedFiles.join(", ") || "none"}`);
      parts.push(`Diff match against our suggestion: ${ctx.diffMatchResult}`);
      if (ctx.diffStat) {
        parts.push(`Diff stat:\n${ctx.diffStat}`);
      }
      if (ctx.previousDiagnoses.length > 0) {
        parts.push(`Diagnoses that iteration: ${ctx.previousDiagnoses.join("; ")}`);
      }
      if (ctx.tmuxScrollbackTail) {
        parts.push(`Claude's output (last 30 lines):\n${ctx.tmuxScrollbackTail}`);
      }
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

  // Suppress generic fallback when any specific diagnosis exists
  const hasSpecific = merged.some(
    (d) => d.id !== "no-tutor-response-generic" && d.severity !== "info",
  );
  const filtered = hasSpecific
    ? merged.filter((d) => d.id !== "no-tutor-response-generic")
    : merged;

  // Re-sort by severity
  return filtered.toSorted((a, b) => {
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

/**
 * Build a nudge that includes context from the previous iteration's observation.
 * Tells Claude what it tried, what changed, and why it still fails.
 * Accepts primitive fields (not IterationObservation) to avoid circular imports.
 */
export function buildContextualNudge(
  iteration: number,
  max: number,
  diagnoses: Diagnosis[],
  prevContext?: { changedFiles: string[]; diffMatchResult: string } | null,
): string {
  const baseNudge = buildDiagnosisNudge(iteration, max, diagnoses);
  if (!prevContext || prevContext.changedFiles.length === 0) {
    return baseNudge;
  }

  const parts: string[] = [];
  parts.push(`Previous attempt: you changed ${prevContext.changedFiles.join(", ")}`);

  if (prevContext.diffMatchResult === "none") {
    parts.push("but you did NOT apply the suggested diff from QA-FEEDBACK.md");
  } else if (prevContext.diffMatchResult === "partial") {
    parts.push("but only partially applied the suggested fix");
  } else if (prevContext.diffMatchResult === "full") {
    parts.push("and applied the fix, but the test STILL fails — try a different approach");
  }

  const contextStr = parts.join(", ") + ".";

  // Inject context before "Read QA-FEEDBACK.md..."
  return baseNudge.replace("Read QA-FEEDBACK.md", `${contextStr} Read QA-FEEDBACK.md`);
}

// ---------------------------------------------------------------------------
// Behavioral Observations — human-like pattern detection
// ---------------------------------------------------------------------------

import type { BehavioralObservation, PageHealthReport, ProjectWarning } from "./types.js";

/** Words that indicate the tutor promises a visual action. */
const VISUAL_PROMISE_WORDS =
  /\b(draw|show|write|illustrate|look at|let me|pizza|number line|diagram|picture|sketch|board|scratchpad)\b/i;

/** Tool names associated with scratchpad drawing/writing. */
const DRAW_TOOL_NAMES = new Set(["draw_annotation", "write_step", "clear_canvas", "draw_shape"]);

/**
 * Build human-readable behavioral observations from enriched voice QA results.
 * These describe what a human tester would notice — not technical error codes.
 */
export function buildBehavioralObservations(
  results: EnrichedVoiceQaResult[],
): BehavioralObservation[] {
  const obs: BehavioralObservation[] = [];
  const allToolCalls = results.flatMap((r) => r.toolCalls ?? []);
  const hasAnyDrawTools = allToolCalls.some((t) => DRAW_TOOL_NAMES.has(t));
  const respondedTurns = results.filter((r) => r.tutorResponse);
  const silentTurns = results.filter((r) => !r.tutorResponse);

  // 0. Total silence — no tutor response at all across ALL turns
  if (results.length > 0 && respondedTurns.length === 0) {
    obs.push({
      category: "conversation-flow",
      severity: "critical",
      observation: `Adam was completely silent — ${results.length} questions from Maya, zero responses. The tutor never engaged at all.`,
      evidence: [`${results.length} turns, 0 responses`],
    });
  }

  // 1. "Says but doesn't do" — tutor talks about drawing but never calls tools
  for (const r of results) {
    if (r.tutorResponse && VISUAL_PROMISE_WORDS.test(r.tutorResponse) && !hasAnyDrawTools) {
      const excerpt = r.tutorResponse.slice(0, 80);
      obs.push({
        category: "tool-gap",
        severity: "major",
        observation: `Adam talked about visual content ("${excerpt}...") but never actually used any scratchpad tools. The canvas stayed blank.`,
        evidence: [`Tutor said: "${excerpt}"`, `Tool calls across all turns: none`],
      });
      break; // One observation is enough for this pattern
    }
  }

  // 2. Conversation death — turn N responded, N+1..end silent
  if (respondedTurns.length > 0 && silentTurns.length > 0 && results.length > 1) {
    const lastRespondedIdx = results.findLastIndex((r) => r.tutorResponse);
    const trailingSlience = results.length - 1 - lastRespondedIdx;
    if (trailingSlience >= 1 && lastRespondedIdx < results.length - 1) {
      obs.push({
        category: "conversation-flow",
        severity: "major",
        observation: `The conversation died after turn ${lastRespondedIdx + 1}. Maya kept asking but Adam went silent for the remaining ${trailingSlience} turn(s).`,
        evidence: [
          `Last response at turn ${lastRespondedIdx + 1}`,
          `${trailingSlience} silent turns after`,
        ],
      });
    }
  }

  // 3. One-and-done — only 1 of N turns got a response
  if (results.length > 1 && respondedTurns.length === 1) {
    obs.push({
      category: "conversation-flow",
      severity: "major",
      observation: `Adam responded only once (turn ${results.indexOf(respondedTurns[0]) + 1}) then stopped engaging entirely. Maya's other questions were ignored.`,
      evidence: [`${results.length} turns total`, `Only 1 got a response`],
    });
  }

  // 4. Verbal-only teaching — responses exist but zero tool calls anywhere
  if (respondedTurns.length > 1 && allToolCalls.length === 0) {
    obs.push({
      category: "teaching-quality",
      severity: "major",
      observation:
        "Adam explained everything verbally without ever using the scratchpad. A visual tutor that doesn't draw isn't meeting its purpose.",
      evidence: [
        `${respondedTurns.length} turns with verbal responses`,
        `0 tool calls across all turns`,
      ],
    });
  }

  // 5. Canvas blank despite tool calls
  const drawToolsCalled = allToolCalls.some((t) => DRAW_TOOL_NAMES.has(t));
  const anyVisualBlank = results.some(
    (r) => r.visualAssessment && !r.visualAssessment.drawingCorrect,
  );
  if (drawToolsCalled && anyVisualBlank) {
    obs.push({
      category: "tool-gap",
      severity: "critical",
      observation:
        "Adam called drawing tools but nothing appeared correctly on the canvas — the rendering pipeline may be broken.",
      evidence: [
        `Draw tools called: ${allToolCalls.filter((t) => DRAW_TOOL_NAMES.has(t)).join(", ")}`,
        `Visual assessment: drawing incorrect`,
      ],
    });
  }

  // 5b. Canvas pixels unchanged despite draw tool calls (checksum-based)
  const canvasUnchanged = results.some(
    (r) =>
      r.canvasChange &&
      !r.canvasChange.changed &&
      (r.toolCalls ?? []).some((t) => DRAW_TOOL_NAMES.has(t)),
  );
  if (canvasUnchanged && !anyVisualBlank) {
    obs.push({
      category: "tool-gap",
      severity: "critical",
      observation:
        "Adam called drawing tools but the canvas pixels didn't change — the drawing pipeline is broken. The tool handler may not be wiring into the overlay animator.",
      evidence: [
        `Draw tools called: ${allToolCalls.filter((t) => DRAW_TOOL_NAMES.has(t)).join(", ")}`,
        `Canvas checksum: unchanged`,
      ],
    });
  }

  // 6. Response latency — sluggish tutor makes the conversation feel unnatural
  const slowTurns = results.filter(
    (r) => r.responseLatencyMs !== undefined && r.responseLatencyMs > 5000,
  );
  if (slowTurns.length > 0) {
    const avgLatency = Math.round(
      slowTurns.reduce((sum, r) => sum + r.responseLatencyMs!, 0) / slowTurns.length / 1000,
    );
    obs.push({
      category: "conversation-flow",
      severity: "major",
      observation: `Adam is slow to respond — ${slowTurns.length} turn(s) took over 5 seconds (avg ${avgLatency}s). The conversation feels unnatural and stilted.`,
      evidence: slowTurns.map(
        (r) =>
          `"${r.prompt?.slice(0, 30)}..." → ${((r.responseLatencyMs ?? 0) / 1000).toFixed(1)}s`,
      ),
    });
  }

  // 7-9. Frontend health observations (from page health reports)
  const lastHealth = results.at(-1)?.pageHealth;
  if (lastHealth) {
    buildFrontendHealthObservations(lastHealth, obs);
  }

  return obs;
}

/** Add frontend health observations from DOM inspection. */
function buildFrontendHealthObservations(
  health: PageHealthReport,
  obs: BehavioralObservation[],
): void {
  if (health.hasErrorToast && health.toastMessages.length > 0) {
    obs.push({
      category: "frontend-error",
      severity: "major",
      observation: `There's an error toast on screen saying: "${health.toastMessages[0]}"`,
      evidence: health.toastMessages.map((m) => `Toast: ${m}`),
    });
  }

  if (!health.sessionConnected) {
    obs.push({
      category: "frontend-error",
      severity: "critical",
      observation: `The session dropped — the button says "Start Session" instead of "End Session". Adam is disconnected.`,
      evidence: [`sessionConnected: false`],
    });
  }

  if (health.audioBlocked) {
    obs.push({
      category: "audio-gap",
      severity: "major",
      observation: `The "Enable Audio" button is showing — Chrome isn't playing Adam's audio. The student can't hear the tutor.`,
      evidence: [`audioBlocked: true`],
    });
  }

  if (health.hasAlertRole && health.alertMessages.length > 0) {
    obs.push({
      category: "frontend-error",
      severity: "major",
      observation: `Alert visible on page: "${health.alertMessages[0]}"`,
      evidence: health.alertMessages.map((m) => `Alert: ${m}`),
    });
  }
}

// ---------------------------------------------------------------------------
// Project Knowledge Base — proactive warnings from known gotchas
// ---------------------------------------------------------------------------

type ProjectGotcha = {
  id: string;
  trigger: RegExp;
  warning: string;
};

const PROJECT_KNOWLEDGE: ProjectGotcha[] = [
  {
    id: "native-audio-tool-calling",
    trigger: /sendToolResponse|\.toolResponse\(/,
    warning:
      "Native audio models have broken function calling via toolResponse. Use clientContent with functionResponse parts instead of sendToolResponse. See googleapis/python-genai#1832.",
  },
  {
    id: "non-blocking-hallucination",
    trigger: /NON_BLOCKING/,
    warning:
      "NON_BLOCKING scheduling causes the model to hallucinate answers before tool results return. Remove it. See python-genai#1894.",
  },
  {
    id: "complex-schema-risk",
    trigger: /propertyOrdering/,
    warning:
      "Complex tool schemas with propertyOrdering increase malformed function call risk on native audio. Keep schemas flat.",
  },
  {
    id: "shared-cache-contamination",
    trigger: /cachedModel|systemPromptCache/,
    warning:
      "Module-level caches (cachedModel, systemPromptCache) are shared between Adam and Maya. This causes cross-contamination. Each session needs its own instance.",
  },
  {
    id: "concurrent-session-limit",
    trigger: /live\.connect\(|LiveConnectConfig/,
    warning:
      "Gemini has concurrent session limits. If Maya and Adam both connect via live.connect(), one may get disconnected within 5 seconds.",
  },
  {
    id: "silent-scheduling",
    trigger: /SILENT|FunctionResponseScheduling\.SILENT/,
    warning:
      "FunctionResponseScheduling.SILENT is rejected by the server on native audio models. Don't use it.",
  },
  {
    id: "audio-transcription-enable-field",
    trigger: /AudioTranscription.*enable|enableTranscription|transcription.*:\s*\{\s*enable/,
    warning:
      "AudioTranscriptionConfig must be an empty object {}. Any fields like 'enable: true' or 'enableTranscription: true' cause WS 1007 'Unknown name'. Just use inputAudioTranscription: {} to enable.",
  },
];

/**
 * Scan text (code diff or source) against project knowledge base.
 * Returns warnings for any known gotchas found.
 */
export function matchProjectKnowledge(text: string): ProjectWarning[] {
  if (!text) {
    return [];
  }
  const warnings: ProjectWarning[] = [];
  for (const gotcha of PROJECT_KNOWLEDGE) {
    if (gotcha.trigger.test(text)) {
      warnings.push({
        id: gotcha.id,
        warning: gotcha.warning,
        trigger: text.match(gotcha.trigger)?.[0] ?? "",
      });
    }
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Plan review prompt
// ---------------------------------------------------------------------------

/**
 * Build an LLM prompt to review Claude's fix plan before implementation.
 * Used when plan-mode is detected in the tmux session.
 */
export function buildPlanReviewPrompt(
  planContent: string,
  behavioralObs: BehavioralObservation[],
  projectWarnings: ProjectWarning[],
): string {
  const parts: string[] = [];

  parts.push(
    "You are a senior engineer reviewing a developer's plan to fix issues in a Gemini Live API voice tutor app.",
  );
  parts.push("Review their plan and give pointed, specific feedback.");
  parts.push("");

  parts.push("## The Plan");
  parts.push(planContent.slice(0, 3000));
  parts.push("");

  if (projectWarnings.length > 0) {
    parts.push("## Known Project Gotchas");
    for (const w of projectWarnings) {
      parts.push(`- ${w.warning}`);
    }
    parts.push("");
  }

  if (behavioralObs.length > 0) {
    parts.push("## What Voice QA Observed");
    for (const o of behavioralObs) {
      parts.push(`- [${o.severity.toUpperCase()}] ${o.observation}`);
    }
    parts.push("");
  }

  parts.push("## Your Review");
  parts.push("Be direct and specific. Point out:");
  parts.push("1. Will this plan actually fix the root cause, or just a symptom?");
  parts.push("2. Is the plan missing anything critical? (tool registration, session config, etc.)");
  parts.push("3. Are there known gotchas the plan doesn't account for?");
  parts.push("4. What will still be broken after this plan is implemented?");
  parts.push("");
  parts.push("Keep it under 150 words. Be conversational, like typing feedback into a terminal.");

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Senior engineer nudge prompt
// ---------------------------------------------------------------------------

/**
 * Build an LLM prompt to compose a conversational nudge (like a senior engineer typing).
 * When agentDiagnose is not available, use buildSeniorNudgeFallback() instead.
 */
/** A screenshot description from the vision model for the nudge prompt. */
export type ScreenshotDescription = {
  turn: string;
  description: string;
  path: string;
};

export function buildSeniorNudgePrompt(
  behavioral: BehavioralObservation[],
  projectWarnings: ProjectWarning[],
  diagnoses: Diagnosis[],
  iteration: number,
  maxIterations: number,
  prevDiffStat?: string,
  screenshots?: ScreenshotDescription[],
): string {
  const parts: string[] = [];

  parts.push(
    "You are a senior engineer who deeply knows this project. Write feedback for the developer as if typing it into their terminal.",
  );
  parts.push(
    "Be conversational, direct, and specific. Name the actors (Adam = tutor, Maya = student).",
  );
  parts.push(
    "LEAD WITH WHAT THE SCREENSHOTS SHOW — a human tester looks at the screen first, reads logs second. " +
      "Describe what you SAW, not error codes. Reference specific files to investigate. Keep it under 200 words.",
  );
  parts.push("");

  parts.push(`## Iteration ${iteration}/${maxIterations}`);
  parts.push("");

  if (behavioral.length > 0) {
    parts.push("## What I Observed");
    for (const o of behavioral) {
      parts.push(`- ${o.observation}`);
    }
    parts.push("");
  }

  if (screenshots && screenshots.length > 0) {
    parts.push("## What the Screen Showed (MOST IMPORTANT — this is what a human would SEE)");
    for (const s of screenshots) {
      parts.push(`- Turn "${s.turn}": ${s.description}`);
    }
    parts.push("");
    parts.push(
      "Key visual signals: Is 'Start Session' or 'End Session' showing? Is 'Enable Audio' button yellow/pulsing? " +
        "Are there error toasts? Is the scratchpad canvas blank or populated?",
    );
    parts.push("");
  }

  if (projectWarnings.length > 0) {
    parts.push("## Known Gotchas Triggered");
    for (const w of projectWarnings) {
      parts.push(`- ${w.warning}`);
    }
    parts.push("");
  }

  if (diagnoses.length > 0) {
    parts.push("## Technical Diagnosis (top 2)");
    for (const d of diagnoses.slice(0, 2)) {
      parts.push(`- [${d.severity.toUpperCase()}] ${d.rootCause}: ${d.explanation.slice(0, 200)}`);
    }
    parts.push("");
  }

  if (prevDiffStat) {
    parts.push("## Claude's Last Changes");
    parts.push(prevDiffStat);
    parts.push("");
  }

  parts.push('End with: Fix these, then say "done" so I can retest. Details in QA-FEEDBACK.md.');

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// One-shot multimodal analysis — single LLM call for nudge + diagnosis
// ---------------------------------------------------------------------------

/**
 * Build ONE prompt that asks the model to produce both a tmux nudge and a
 * JSON diagnosis array. The model receives screenshots as images alongside
 * this text prompt, so it can correlate visual state with technical signals.
 */
export function buildOneShotAnalysisPrompt(
  results: EnrichedVoiceQaResult[],
  behavioral: BehavioralObservation[],
  projectWarnings: ProjectWarning[],
  staticDiagnoses: Diagnosis[],
  sourceFiles?: SourceFile[],
  iterationHistory?: IterationContext[],
  iteration?: number,
  maxIterations?: number,
): string {
  const parts: string[] = [];

  parts.push(
    "You are a senior engineer who deeply knows this Gemini Live API voice tutor project (Scratchpad).",
  );
  parts.push(
    "You're looking at screenshots of the app + technical signals from Playwright. Produce TWO outputs:",
  );
  parts.push("");
  parts.push(
    "1. A conversational **nudge** (typed into the developer's terminal) — lead with ROOT CAUSE, not symptoms.",
  );
  parts.push("2. A **diagnosis** JSON array for QA-FEEDBACK.md with specific file:line fixes.");
  parts.push("");
  parts.push("## ROOT CAUSE ANALYSIS (CRITICAL — read this first)");
  parts.push(
    "Your nudge goes to Codex (an AI coding agent). It can only fix CODE. Distinguish these layers:",
  );
  parts.push(
    "1. **Tool registration** — Are functionDeclarations in LiveConnectConfig at connect time? Check console for '[useTutor] Tools in config: NONE' vs tool names listed.",
  );
  parts.push(
    "2. **Model behavior** — Gemini native audio model is flaky with function calling. If tools ARE registered but model isn't calling them, the fix is prompt engineering or model config, NOT frontend code.",
  );
  parts.push(
    "2b. **Auto-scribe fallback** — For native audio models, tools are STRIPPED. Instead, auto-scribe " +
      "listens to Adam's outputTranscription, sends transcript to Gemini Flash API, extracts math as JSON commands, " +
      "and renders on the canvas overlay. Check [AutoScribe] logs to see: Did outputTranscript fire? " +
      "Did the API call succeed? Did post-filtering remove all commands? See the Auto-Scribe Pipeline Status section.",
  );
  parts.push(
    "3. **Frontend rendering** — Only blame React/canvas code if tools ARE being called (or auto-scribe executed commands) but the canvas doesn't update.",
  );
  parts.push(
    "4. **Dev server** — If the app shows a Vite error overlay or compile errors in console, Codex's previous changes broke the build. Say so explicitly.",
  );
  parts.push("");
  parts.push("**Diagnostic checklist (answer in your nudge):**");
  parts.push(
    "- How many `functionCall` / `toolCall` events appear in console logs? (0 = model isn't calling tools)",
  );
  parts.push("- Does console show `[useTutor] Tools in config:` followed by tool names or NONE?");
  parts.push("- Are there Vite compile errors or React error boundaries in the console?");
  parts.push(
    "- Is the issue the Gemini MODEL not calling tools, or the FRONTEND not rendering tool results?",
  );
  parts.push(
    "- How many `[AutoScribe] outputTranscript:` events? (0 = transcript disabled or tutor silent)",
  );
  parts.push(
    "- Did auto-scribe execute commands? Check `[AutoScribe] Executing N commands` in logs.",
  );
  parts.push(
    "DO NOT suggest frontend code changes if the model simply isn't making function calls. " +
      "For native audio models, focus on auto-scribe pipeline status instead of tool registration.",
  );
  parts.push("");
  parts.push("Format your response EXACTLY like this:");
  parts.push("```");
  parts.push("=== NUDGE ===");
  parts.push("[Your terminal message here — 100-200 words, conversational, name Adam/Maya]");
  parts.push("");
  parts.push("=== SCORECARD ===");
  parts.push(
    '{"overall":5,"visualClarity":3,"teachingEffectiveness":2,"scratchpadUsage":1,"conversationFlow":4,"ageAppropriateness":3,"aestheticNotes":["Pink circle is irrelevant to math","Text overlaps previous content"],"khanComparison":"Khan would draw a number line with dots. Adam just said four."}',
  );
  parts.push("");
  parts.push("=== DIAGNOSIS ===");
  parts.push(
    '[{"severity":"critical","rootCause":"...","explanation":"...","suggestedFix":"--- a/file\\n+++ b/file\\n@@ ...","evidence":["..."]}]',
  );
  parts.push("```");
  parts.push("");

  // Iteration context
  if (iteration !== undefined && maxIterations !== undefined) {
    parts.push(`## Iteration ${iteration}/${maxIterations}`);
    parts.push("");
  }

  // Screenshots instruction
  const screenshotCount = results.filter(
    (r) => r.screenshots?.before || r.screenshots?.after || r.screenshotPath,
  ).length;
  if (screenshotCount > 0) {
    parts.push(`## Screenshots (${screenshotCount * 2} images attached)`);
    parts.push("I've attached before/after screenshots for each test turn. Look at them FIRST.");
    parts.push(
      "Key visual signals: 'Start Session' vs 'End Session' button, error toasts, 'Enable Audio' yellow button, scratchpad canvas content.",
    );
    parts.push("");
  }

  // Behavioral observations
  if (behavioral.length > 0) {
    parts.push("## What I Observed (behavioral)");
    for (const o of behavioral) {
      parts.push(`- [${o.severity.toUpperCase()}] ${o.observation}`);
    }
    parts.push("");
  }

  // Test results with signals
  const failed = results.filter((r) => !r.passed);
  parts.push(`## Test Results (${failed.length} failed / ${results.length} total)`);
  parts.push("");

  for (const [idx, r] of failed.entries()) {
    parts.push(`### Failed ${idx + 1}: "${r.prompt ?? "unknown"}"`);
    if (r.tutorResponse) {
      parts.push(`Tutor: "${r.tutorResponse}"`);
    } else {
      parts.push("Tutor: SILENT");
    }
    if (r.canvasChange) {
      parts.push(
        `Canvas: ${r.canvasChange.changed ? "CHANGED" : "UNCHANGED"} (${r.canvasChange.checksumBefore} → ${r.canvasChange.checksumAfter})`,
      );
    }
    if ((r.toolCalls ?? []).length > 0) {
      parts.push(`Tools called: ${(r.toolCalls ?? []).join(", ")}`);
    }
    // Surface visual assessment data (pedagogy score, canvas description)
    if (r.visualAssessment) {
      parts.push(`Visual score: ${r.visualAssessment.score}/100`);
      if (r.visualAssessment.canvasDescription) {
        parts.push(`Canvas description: ${r.visualAssessment.canvasDescription}`);
      }
      if (r.visualAssessment.pedagogyScore) {
        const ps = r.visualAssessment.pedagogyScore;
        parts.push(
          `Pedagogy: clarity=${ps.explanationClarity}/5 relevance=${ps.drawingRelevance}/5 age=${ps.ageAppropriateness}/5 matches-claim=${ps.drawingMatchesClaim}`,
        );
      }
      if (r.visualAssessment.issues.length > 0) {
        parts.push("Visual issues:");
        for (const issue of r.visualAssessment.issues.slice(0, 5)) {
          parts.push(`  - [${issue.severity.toUpperCase()}] ${issue.description}`);
        }
      }
    }
    if (r.pageHealth) {
      const ph = r.pageHealth;
      const healthParts: string[] = [];
      if (ph.hasErrorToast) {
        healthParts.push(`toast: "${ph.toastMessages[0] ?? "error"}"`);
      }
      if (!ph.sessionConnected) {
        healthParts.push("session DISCONNECTED");
      }
      if (ph.audioBlocked) {
        healthParts.push("audio BLOCKED");
      }
      if (healthParts.length > 0) {
        parts.push(`Page health: ${healthParts.join(", ")}`);
      }
    }

    // Console errors (top 5)
    if (r.consoleErrors.length > 0) {
      parts.push("Console errors:");
      for (const e of r.consoleErrors.slice(0, 5)) {
        parts.push(`  - ${e.slice(0, 300)}`);
      }
    }

    // Console logs (last 15)
    if (r.consoleLogs.length > 0) {
      parts.push(`Console logs (last 15 of ${r.consoleLogs.length}):`);
      for (const l of r.consoleLogs.slice(-15)) {
        parts.push(`  ${l.slice(0, 300)}`);
      }
    }

    // WS events (last 20)
    if (r.wsEvents.length > 0) {
      parts.push(`WS events (${r.wsEvents.length}):`);
      for (const evt of r.wsEvents.slice(-20)) {
        const time = fmtTime(evt.timestamp);
        if (evt.type === "close") {
          parts.push(
            `  [${time}] CLOSE code=${evt.closeCode ?? "?"} reason="${evt.closeReason ?? ""}"`,
          );
        } else if (evt.type === "open") {
          parts.push(`  [${time}] OPEN ${evt.url ?? ""}`);
        } else {
          const dir = evt.type === "message-sent" ? "SENT" : "RECV";
          parts.push(`  [${time}] ${dir} ${evt.payload?.slice(0, 150) ?? "<no payload>"}`);
        }
      }
    }
    parts.push("");
  }

  // Auto-scribe pipeline status (critical for native audio models)
  const allConsoleLogs = results.flatMap((r) => r.consoleLogs);
  const overallAutoScribe = extractAutoScribeStatus(allConsoleLogs);
  if (
    overallAutoScribe.transcriptEvents > 0 ||
    overallAutoScribe.attempted ||
    allConsoleLogs.some((l) => l.includes("[AutoScribe]"))
  ) {
    parts.push("## Auto-Scribe Pipeline Status");
    parts.push(
      "Native audio models have tools STRIPPED. Auto-scribe listens to Adam's outputTranscription, " +
        "sends text to Gemini Flash for math extraction, renders on canvas overlay.",
    );
    parts.push(`Overall: ${formatAutoScribeStatus(overallAutoScribe)}`);
    // Per-turn status
    for (const [idx, r] of results.entries()) {
      const turnStatus = extractAutoScribeStatus(r.consoleLogs);
      const canvasLabel = r.canvasChange
        ? r.canvasChange.changed
          ? "canvas CHANGED"
          : "canvas UNCHANGED"
        : "canvas unknown";
      parts.push(`  Turn ${idx}: ${formatAutoScribeStatus(turnStatus)} → ${canvasLabel}`);
    }
    parts.push("");
  } else if (allConsoleLogs.some((l) => l.includes("Stripping tools"))) {
    parts.push("## Auto-Scribe Pipeline Status");
    parts.push("Tools were STRIPPED (native audio model) but NO auto-scribe activity detected.");
    parts.push("This means: outputTranscription events are not firing OR the tutor never spoke.");
    parts.push("");
  }

  // Static diagnoses (already detected)
  if (staticDiagnoses.length > 0) {
    parts.push("## Static Rules Already Detected");
    for (const d of staticDiagnoses) {
      parts.push(`- [${d.severity.toUpperCase()}] ${d.rootCause}`);
    }
    parts.push("");
  }

  // Project warnings
  if (projectWarnings.length > 0) {
    parts.push("## Known Project Gotchas");
    for (const w of projectWarnings) {
      parts.push(`- ${w.warning}`);
    }
    parts.push("");
  }

  // Source code
  if (sourceFiles && sourceFiles.length > 0) {
    parts.push("## Source Code");
    for (const file of sourceFiles) {
      parts.push(`### ${file.path}`);
      parts.push("```typescript");
      parts.push(file.content);
      parts.push("```");
      parts.push("");
    }
  }

  // Iteration history
  if (iterationHistory && iterationHistory.length > 0) {
    parts.push("## Previous Attempts (REVIEW THESE — what did Codex change and did it help?)");
    for (const ctx of iterationHistory) {
      parts.push(`### Iteration ${ctx.iteration}`);
      parts.push(`Nudge we sent: "${ctx.nudgeSent.slice(0, 300)}"`);
      parts.push(
        `Files Codex changed: ${ctx.changedFiles.join(", ") || "NONE — Codex made no changes"} (match: ${ctx.diffMatchResult})`,
      );
      if (ctx.compileOk === false) {
        parts.push(
          "**COMPILE FAILED** — Codex's changes broke the build. The test ran against OLD code.",
        );
      }
      if (ctx.diffSnippet) {
        parts.push("Codex's actual diff (review this — did it fix the right layer?):");
        parts.push("```diff");
        parts.push(ctx.diffSnippet);
        parts.push("```");
      } else if (ctx.changedFiles.length === 0) {
        parts.push(
          "Codex made ZERO changes. Possible reasons: model error, couldn't understand the nudge, or wrong working directory.",
        );
      }
      parts.push("");
    }
  }

  // Known bugs reference
  parts.push("## Known Gemini Bugs");
  parts.push("- sendToolResponse → WS 1011: use clientContent with functionResponse instead");
  parts.push("- NON_BLOCKING → hallucination: remove it");
  parts.push("- Complex schemas → malformed calls: keep flat");
  parts.push("- WORKAROUND may already be applied in tutor-service.ts — check source code");
  parts.push("");

  // Pedagogical quality rubric
  parts.push("## Pedagogical Quality (Sal Khan standard)");
  parts.push(
    "The tutor (Adam) should teach like Sal Khan — step-by-step visual explanations that build understanding.",
  );
  parts.push(
    "Assess these in your diagnosis (severity 'major' for failures, 'minor' for improvements):",
  );
  parts.push(
    "- Does Adam explain step-by-step, or just blurt the answer? (Khan draws out each step)",
  );
  parts.push(
    "- Does Adam USE the scratchpad to draw while explaining? (Khan's whole approach is visual)",
  );
  parts.push("- Are drawings relevant and helpful, or random/decorative?");
  parts.push(
    "- Is the tone warm, encouraging, age-appropriate? ('Great question!' not 'The answer is 4.')",
  );
  parts.push("- Does Adam build on what Maya said, or ignore her entirely?");
  parts.push("- Would a 3rd grader understand this explanation?");
  parts.push(
    "If Adam just says 'four' without drawing or explaining, that's a MAJOR pedagogy failure.",
  );
  parts.push("");

  // Visual regression checks
  parts.push("## Visual Regression Checks (IMPORTANT)");
  parts.push("Look at the screenshots carefully and answer:");
  parts.push(
    "- Is content being drawn ON TOP of previous content without clearing? (overwriting makes scratchpad unreadable)",
  );
  parts.push(
    "- Are there random/irrelevant shapes (circles, lines) that don't relate to the math topic?",
  );
  parts.push(
    "- Is the canvas aesthetically clean? Good contrast against dark background? Readable text size?",
  );
  parts.push("- Compare the visual to what Khan Academy would show for this exact problem.");
  parts.push("");

  // Khan Academy reference examples
  parts.push("## Khan Academy Reference (what GOOD looks like)");
  parts.push(
    "For '2+2': Khan would draw two groups of dots, count them together, write '2+2=4' step by step.",
  );
  parts.push("For '3×5': Khan would show 3 rows of 5 dots, count total, then write '3×5=15'.");
  parts.push(
    "For 'show on the board': Khan would draw a number line, place dots, animate the operation.",
  );
  parts.push(
    "For 'why does addition work': Khan would use physical objects (apples, blocks) drawn on screen.",
  );
  parts.push(
    "Adam should be doing THIS level of visual teaching. If he's just talking — that's a failure.",
  );
  parts.push("");

  // Blank canvas emergency — when ALL turns have blank canvas, be extremely prescriptive
  const allCanvasBlank = results.every((r) => !r.canvasChange || !r.canvasChange.changed);
  if (allCanvasBlank) {
    parts.push("## BLANK CANVAS EMERGENCY");
    parts.push(
      "The canvas is BLANK across ALL turns. This is a total visual failure — score will be 1-2/10.",
    );
    parts.push("");
    parts.push(
      "**Focus your ENTIRE nudge on the ONE most impactful fix from this priority list:**",
    );
    parts.push(
      "0. **HIGHEST PRIORITY: Is the OverlayAnimator drawing to a 0x0 canvas?** " +
        "In canvas-renderer.ts `attach()`, the code does `this.width = canvas.width; this.height = canvas.height`. " +
        "If the canvas uses CSS sizing (width:100%) without explicit HTML width/height attributes, " +
        "these values are 0 and ALL drawing is invisible. Fix: in attach(), use " +
        "`this.width = canvas.getBoundingClientRect().width` or ensure the <canvas> element has " +
        "explicit width/height attributes. Check ScratchpadAIOverlay.tsx — the overlay canvas MUST " +
        "have width={number} height={number} attributes matching its rendered size.",
    );
    parts.push(
      "1. **Is auto-scribe extracting commands but they're being filtered out?** " +
        "Check `[AutoScribe] Filtering out` logs. If yes: the post-filter in useScratchpadAI.ts is too aggressive. " +
        "The fix is to ACCEPT any command from the Flash API that has text containing digits or math operators. " +
        "The LLM already decided it's math — the post-filter should trust it.",
    );
    parts.push(
      "2. **Is auto-scribe's Flash API call returning empty commands?** " +
        "Check `[AutoScribe] Raw response:` logs. If the API returns `[]`, the system prompt is too restrictive. " +
        "Lower the bar: any math-adjacent text should produce a write_step command.",
    );
    parts.push(
      "3. **Is auto-scribe never firing at all?** " +
        "Check `[AutoScribe] outputTranscript:` count. If 0, the model isn't producing transcription events. " +
        "Verify inputAudioTranscription is {} (empty object) in the connect config. " +
        "If transcripts ARE arriving but auto-scribe ignores them, check shouldAttemptAutoScribe().",
    );
    parts.push(
      "4. **Is the fallback question draw working?** " +
        "When auto-scribe produces nothing, drawFallbackQuestion() should render the question text ('2+2'). " +
        "If the canvas is STILL blank, the fallback itself is broken — check canvas-renderer.ts.",
    );
    parts.push("");
    parts.push(
      "**DO NOT list 5 problems.** Pick the ONE highest-priority fix from above and give Codex " +
        "a specific file:function with the exact change needed. The goal is to get ANYTHING on the canvas.",
    );
    parts.push("");
  }

  // Output instructions
  parts.push("## Output Rules");
  parts.push(
    "- NUDGE: Conversational, 100-200 words. Name Adam/Maya. **Lead with root cause layer** (tool registration / model behavior / frontend rendering / dev server). End with 'Fix these, then say done.'",
  );
  parts.push(
    "- NUDGE must start with ONE of: 'Tool registration issue:', 'Model behavior issue:', 'Frontend rendering issue:', or 'Dev server issue:' — then explain.",
  );
  parts.push(
    "- NUDGE must include the functionCall count from console logs (e.g. '0 function calls in 1371 console entries').",
  );
  parts.push(
    "- **FOCUS**: Your nudge should prioritize the SINGLE most impactful fix. Don't list 5+ problems — Codex works better with one clear directive.",
  );
  parts.push(
    "- SCORECARD: JSON object with overall (1-10), visualClarity (1-5), teachingEffectiveness (1-5), scratchpadUsage (1-5), conversationFlow (1-5), ageAppropriateness (1-5), aestheticNotes (string[]), khanComparison (string).",
  );
  parts.push(
    "- DIAGNOSIS: JSON array. suggestedFix MUST target the correct layer. If 0 function calls → fix tool registration or system prompt, NOT canvas rendering code.",
  );
  parts.push(
    "- Include pedagogy issues as diagnoses with rootCause starting with 'Pedagogy:' (e.g. 'Pedagogy: verbal-only teaching without scratchpad')",
  );
  parts.push(
    "- If Codex made changes last iteration but score didn't improve, say WHAT it changed and WHY it didn't help.",
  );
  parts.push(
    '- End NUDGE with: Fix these, then say "done" so I can retest. Details in QA-FEEDBACK.md.',
  );

  return parts.join("\n");
}

/** Parsed result from a one-shot analysis response. */
export type OneShotResult = {
  nudge: string;
  diagnoses: Diagnosis[];
  /** Structured quality scorecard (Khan Academy standard). */
  scorecard?: ExperienceScorecard;
};

/**
 * Parse a one-shot response that contains both NUDGE and DIAGNOSIS sections.
 * Splits on === NUDGE === and === DIAGNOSIS === markers.
 */
export function parseOneShotResponse(response: string): OneShotResult {
  const nudgeMarker = "=== NUDGE ===";
  const scorecardMarker = "=== SCORECARD ===";
  const diagMarker = "=== DIAGNOSIS ===";

  let nudge = "";
  let diagnoses: Diagnosis[] = [];
  let scorecard: ExperienceScorecard | undefined;

  const nudgeIdx = response.indexOf(nudgeMarker);
  const scorecardIdx = response.indexOf(scorecardMarker);
  const diagIdx = response.indexOf(diagMarker);

  // Extract nudge section
  if (nudgeIdx >= 0) {
    const nudgeEnd = Math.min(
      ...[scorecardIdx, diagIdx].filter((i) => i > nudgeIdx),
      response.length,
    );
    nudge = response.slice(nudgeIdx + nudgeMarker.length, nudgeEnd).trim();
  } else if (diagIdx >= 0) {
    nudge = response.slice(0, diagIdx).trim();
  }

  // Extract scorecard section
  if (scorecardIdx >= 0) {
    const scorecardEnd = diagIdx > scorecardIdx ? diagIdx : response.length;
    const scorecardText = response
      .slice(scorecardIdx + scorecardMarker.length, scorecardEnd)
      .trim();
    scorecard = parseScorecardJson(scorecardText);
  }

  // Extract diagnosis section
  if (diagIdx >= 0) {
    const diagText = response.slice(diagIdx + diagMarker.length).trim();
    diagnoses = parseLlmDiagnosis(diagText);
  } else if (nudgeIdx < 0 && scorecardIdx < 0) {
    // No markers at all — try to parse as JSON diagnosis, use full text as nudge fallback
    diagnoses = parseLlmDiagnosis(response);
    if (diagnoses.length === 0) {
      nudge = response.trim();
    }
  }

  return { nudge, diagnoses, scorecard };
}

/** Parse scorecard JSON from the SCORECARD section. */
function parseScorecardJson(text: string): ExperienceScorecard | undefined {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return undefined;
  }

  try {
    const raw = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    return {
      overall: clampScorecard(raw.overall, 1, 10),
      visualClarity: clampScorecard(raw.visualClarity, 1, 5),
      teachingEffectiveness: clampScorecard(raw.teachingEffectiveness, 1, 5),
      scratchpadUsage: clampScorecard(raw.scratchpadUsage, 1, 5),
      conversationFlow: clampScorecard(raw.conversationFlow, 1, 5),
      ageAppropriateness: clampScorecard(raw.ageAppropriateness, 1, 5),
      aestheticNotes: Array.isArray(raw.aestheticNotes)
        ? (raw.aestheticNotes as string[]).filter((n) => typeof n === "string")
        : [],
      khanComparison: typeof raw.khanComparison === "string" ? raw.khanComparison : "",
    };
  } catch {
    return undefined;
  }
}

/** Clamp a scorecard value to [min, max]. */
function clampScorecard(v: unknown, min: number, max: number): number {
  if (typeof v !== "number" || Number.isNaN(v)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.round(v)));
}

// ---------------------------------------------------------------------------
// Code review prompt — LLM review of agent's code changes
// ---------------------------------------------------------------------------

/**
 * Build an LLM prompt to review the agent's code changes (git diff).
 * Catches anti-patterns like propertyOrdering, sendToolResponse, scope creep.
 */
export function buildCodeReviewPrompt(
  diff: string,
  originalNudge: string,
  projectWarnings: ProjectWarning[],
): string {
  const parts: string[] = [];

  parts.push(
    "You are a senior engineer reviewing code changes made by another agent to fix voice QA issues in a Gemini Live API tutor app.",
  );
  parts.push("Review this diff and give line-specific feedback.");
  parts.push("");

  parts.push("## The Original Issue (what we asked the agent to fix)");
  parts.push(originalNudge.slice(0, 1000));
  parts.push("");

  parts.push("## The Agent's Diff");
  parts.push("```diff");
  parts.push(diff.slice(0, 8000));
  parts.push("```");
  parts.push("");

  if (projectWarnings.length > 0) {
    parts.push("## Known Anti-Patterns to Check For");
    for (const w of projectWarnings) {
      parts.push(`- ${w.warning}`);
    }
    parts.push("");
  }

  parts.push("## Specific Checks");
  parts.push("Flag any of these if found in the diff:");
  parts.push(
    "- `propertyOrdering` added to tool schemas (increases malformed call risk on native audio)",
  );
  parts.push("- `sendToolResponse` instead of `clientContent` + `functionResponse` workaround");
  parts.push("- `NON_BLOCKING` or `FunctionResponseScheduling.NON_BLOCKING` reintroduced");
  parts.push("- `SILENT` or `FunctionResponseScheduling.SILENT` (rejected by server)");
  parts.push("- Overly complex tool schemas (nested objects, >5 params per tool)");
  parts.push("- Scope creep: changes unrelated to the original issue");
  parts.push("- Missing error handling on WebSocket send/receive paths");
  parts.push("- Module-level caches shared between Adam and Maya sessions");
  parts.push("");

  parts.push("## Output Format");
  parts.push("Give line-specific feedback like:");
  parts.push(
    '  "tutor-service.ts:256 — you added propertyOrdering to draw_annotation schema. Known anti-pattern on native audio. Remove it."',
  );
  parts.push(
    '  "useScratchpadAI.ts:142 — good fix, correctly uses clientContent instead of toolResponse."',
  );
  parts.push("");
  parts.push(
    "Be brief and direct. If the diff looks good, say so. If it introduces problems, list them.",
  );
  parts.push("Focus on correctness and known gotchas, not style.");

  return parts.join("\n");
}

/**
 * Build a senior engineer nudge without LLM — pure string composition from
 * behavioral observations + project warnings. Used as fallback when agentDiagnose
 * is not available.
 */
export function buildSeniorNudgeFallback(
  behavioral: BehavioralObservation[],
  projectWarnings: ProjectWarning[],
  diagnoses: Diagnosis[],
  iteration: number,
  maxIterations: number,
  screenshots?: ScreenshotDescription[],
): string {
  const parts: string[] = [];

  parts.push(
    `Hey — I watched the session (attempt ${iteration}/${maxIterations}) and here's what I saw:`,
  );
  parts.push("");

  // Use behavioral observations if available (human-like)
  if (behavioral.length > 0) {
    for (const o of behavioral) {
      parts.push(o.observation);
    }
  } else if (diagnoses.length > 0) {
    // Fall back to technical diagnoses
    for (const d of diagnoses.slice(0, 2)) {
      parts.push(`${d.rootCause}: ${d.explanation.split(".")[0]}.`);
    }
  } else {
    parts.push("Something's still off — check QA-FEEDBACK.md for details.");
  }

  // Include screenshot descriptions if available
  if (screenshots && screenshots.length > 0) {
    parts.push("");
    parts.push("Here's what the screen showed:");
    for (const s of screenshots.slice(0, 2)) {
      parts.push(`- "${s.turn}": ${s.description.split(".")[0]}.`);
    }
  }

  if (projectWarnings.length > 0) {
    parts.push("");
    parts.push("Heads up:");
    for (const w of projectWarnings) {
      parts.push(`- ${w.warning.split(".")[0]}.`);
    }
  }

  parts.push("");
  parts.push('Fix these, then say "done" so I can retest. Details in QA-FEEDBACK.md.');

  return parts.join("\n");
}
