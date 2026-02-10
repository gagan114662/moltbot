import { describe, expect, it } from "vitest";
import type { Diagnosis, EnrichedVoiceQaResult, WsEvent } from "./voice-qa-diagnosis.js";
import {
  buildDiagnosisNudge,
  buildLlmDiagnosisPrompt,
  diagnose,
  enrichWsEventsFromConsole,
  formatDiagnosisReport,
  mergeDiagnoses,
  parseLlmDiagnosis,
} from "./voice-qa-diagnosis.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(overrides: Partial<EnrichedVoiceQaResult> = {}): EnrichedVoiceQaResult {
  return {
    prompt: "What is 2+2?",
    consoleErrors: [],
    consoleLogs: [],
    passed: false,
    wsEvents: [],
    ...overrides,
  };
}

function makeWsEvent(overrides: Partial<WsEvent> = {}): WsEvent {
  return {
    timestamp: Date.now(),
    type: "open",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// diagnose()
// ---------------------------------------------------------------------------

describe("diagnose", () => {
  it("detects WS 1011 after tool response as critical", () => {
    const result = makeResult({
      wsEvents: [
        makeWsEvent({ type: "open", url: "wss://gemini.example.com" }),
        makeWsEvent({
          type: "message-sent",
          payload: '{"toolResponse":{"name":"drawLine","response":{}}}',
        }),
        makeWsEvent({
          type: "close",
          closeCode: 1011,
          closeReason: "Internal error",
        }),
      ],
    });

    const diagnoses = diagnose([result]);
    expect(diagnoses).toHaveLength(1);
    expect(diagnoses[0].id).toBe("ws-1011-after-tool-response");
    expect(diagnoses[0].severity).toBe("critical");
    expect(diagnoses[0].suggestedFix).toContain("clientContent");
    expect(diagnoses[0].suggestedFix).toContain("functionResponse");
    expect(diagnoses[0].evidence.length).toBeGreaterThan(0);
  });

  it("detects WS 1011 generic (no tool context) as critical", () => {
    const result = makeResult({
      wsEvents: [
        makeWsEvent({ type: "open" }),
        makeWsEvent({
          type: "close",
          closeCode: 1011,
          closeReason: "Internal error",
        }),
      ],
    });

    const diagnoses = diagnose([result]);
    expect(diagnoses).toHaveLength(1);
    expect(diagnoses[0].id).toBe("ws-1011-generic");
    expect(diagnoses[0].severity).toBe("critical");
    expect(diagnoses[0].rootCause).toContain("1011");
  });

  it("detects no WS session as critical", () => {
    const result = makeResult({ wsEvents: [] });

    const diagnoses = diagnose([result]);
    expect(diagnoses).toHaveLength(1);
    expect(diagnoses[0].id).toBe("no-ws-session");
    expect(diagnoses[0].severity).toBe("critical");
    expect(diagnoses[0].rootCause).toContain("never established");
  });

  it("detects mic heard + tutor silent as major", () => {
    const result = makeResult({
      transcript: "What is 2+2?",
      tutorResponse: undefined,
      wsEvents: [makeWsEvent({ type: "open" })],
    });

    const diagnoses = diagnose([result]);
    const micDiag = diagnoses.find((d) => d.id === "mic-heard-tutor-silent");
    expect(micDiag).toBeDefined();
    expect(micDiag!.severity).toBe("major");
    expect(micDiag!.evidence).toContain('User speech recognized: "What is 2+2?"');
  });

  it("detects hallucination loop across results", () => {
    const results = [
      makeResult({
        prompt: "What is 2+2?",
        tutorResponse: "I cannot help with that.",
        wsEvents: [makeWsEvent({ type: "open" })],
      }),
      makeResult({
        prompt: "Draw a circle",
        tutorResponse: "I cannot help with that.",
        wsEvents: [makeWsEvent({ type: "open" })],
      }),
    ];

    const diagnoses = diagnose(results);
    const hallDiag = diagnoses.find((d) => d.id === "hallucination-loop");
    expect(hallDiag).toBeDefined();
    expect(hallDiag!.severity).toBe("major");
    expect(hallDiag!.suggestedFix).toContain("NON_BLOCKING");
  });

  it("deduplicates same root cause from multiple results", () => {
    const results = [
      makeResult({
        wsEvents: [makeWsEvent({ type: "open" }), makeWsEvent({ type: "close", closeCode: 1011 })],
      }),
      makeResult({
        wsEvents: [makeWsEvent({ type: "open" }), makeWsEvent({ type: "close", closeCode: 1011 })],
      }),
    ];

    const diagnoses = diagnose(results);
    const ws1011 = diagnoses.find((d) => d.id === "ws-1011-generic");
    expect(ws1011).toBeDefined();
    expect(ws1011!.count).toBe(2);
    // Should be a single diagnosis, not two
    expect(diagnoses.filter((d) => d.id === "ws-1011-generic")).toHaveLength(1);
  });

  it("suppresses generic fallback when specific match exists", () => {
    const result = makeResult({
      wsEvents: [makeWsEvent({ type: "open" }), makeWsEvent({ type: "close", closeCode: 1011 })],
    });

    const diagnoses = diagnose([result]);
    expect(diagnoses.find((d) => d.id === "no-tutor-response-generic")).toBeUndefined();
  });

  it("uses generic fallback when no signals detected", () => {
    const result = makeResult({
      wsEvents: [makeWsEvent({ type: "open" })],
    });

    const diagnoses = diagnose([result]);
    expect(diagnoses).toHaveLength(1);
    expect(diagnoses[0].id).toBe("no-tutor-response-generic");
    expect(diagnoses[0].severity).toBe("info");
    expect(diagnoses[0].rootCause).toBe("Unknown cause");
  });

  it("skips passed results", () => {
    const results = [
      makeResult({
        passed: true,
        tutorResponse: "Four!",
        wsEvents: [makeWsEvent({ type: "open" })],
      }),
    ];

    const diagnoses = diagnose(results);
    expect(diagnoses).toHaveLength(0);
  });

  it("sorts critical before major before minor", () => {
    const result = makeResult({
      transcript: "Hello",
      consoleErrors: ["getUserMedia NotAllowedError"],
      consoleLogs: [],
      wsEvents: [makeWsEvent({ type: "open" }), makeWsEvent({ type: "close", closeCode: 1011 })],
    });

    const diagnoses = diagnose([result]);
    const severities = diagnoses.map((d) => d.severity);
    // Critical should come before major, major before minor
    for (let i = 1; i < severities.length; i++) {
      const order = ["critical", "major", "minor", "info"];
      expect(order.indexOf(severities[i])).toBeGreaterThanOrEqual(order.indexOf(severities[i - 1]));
    }
  });

  it("detects malformed function call", () => {
    const result = makeResult({
      consoleErrors: ['Uncaught SyntaxError: functionCall args JSON.parse failed: {"broken'],
      wsEvents: [makeWsEvent({ type: "open" })],
    });

    const diagnoses = diagnose([result]);
    const malformed = diagnoses.find((d) => d.id === "function-call-malformed");
    expect(malformed).toBeDefined();
    expect(malformed!.severity).toBe("major");
  });

  it("detects tool response delivery failure", () => {
    const result = makeResult({
      consoleLogs: ["[error] Failed to send functionResponse: WebSocket not open"],
      wsEvents: [makeWsEvent({ type: "open" })],
    });

    const diagnoses = diagnose([result]);
    const delivery = diagnoses.find((d) => d.id === "tool-response-delivery-failed");
    expect(delivery).toBeDefined();
    expect(delivery!.severity).toBe("major");
  });

  it("detects abnormal WS close codes", () => {
    const result = makeResult({
      wsEvents: [
        makeWsEvent({ type: "open" }),
        makeWsEvent({ type: "close", closeCode: 1006, closeReason: "Abnormal closure" }),
      ],
    });

    const diagnoses = diagnose([result]);
    const abnormal = diagnoses.find((d) => d.id === "ws-close-abnormal");
    expect(abnormal).toBeDefined();
    expect(abnormal!.severity).toBe("major");
  });

  it("detects HTTP API errors", () => {
    const result = makeResult({
      consoleLogs: ["[HTTP 500] POST https://api.example.com/session"],
      wsEvents: [makeWsEvent({ type: "open" })],
    });

    const diagnoses = diagnose([result]);
    const httpErr = diagnoses.find((d) => d.id === "http-500-server-error");
    expect(httpErr).toBeDefined();
    expect(httpErr!.severity).toBe("critical");
  });

  it("detects getUserMedia failure", () => {
    const result = makeResult({
      consoleErrors: ["NotAllowedError: getUserMedia permission denied"],
      wsEvents: [makeWsEvent({ type: "open" })],
    });

    const diagnoses = diagnose([result]);
    const mic = diagnoses.find((d) => d.id === "get-user-media-failed");
    expect(mic).toBeDefined();
    expect(mic!.severity).toBe("minor");
  });
});

// ---------------------------------------------------------------------------
// enrichWsEventsFromConsole()
// ---------------------------------------------------------------------------

describe("enrichWsEventsFromConsole", () => {
  it("extracts close code from console log", () => {
    const events = enrichWsEventsFromConsole(
      [],
      ['[log] WebSocket closed: code=1011, reason="Internal error"'],
    );

    const closeEvt = events.find((e) => e.type === "close");
    expect(closeEvt).toBeDefined();
    expect(closeEvt!.closeCode).toBe(1011);
    expect(closeEvt!.closeReason).toBe("Internal error");
  });

  it("extracts code from 'close code: 1006' format", () => {
    const events = enrichWsEventsFromConsole([], ["[warning] close code: 1006"]);

    const closeEvt = events.find((e) => e.type === "close");
    expect(closeEvt).toBeDefined();
    expect(closeEvt!.closeCode).toBe(1006);
  });

  it("enriches existing close event with missing reason", () => {
    const existing: WsEvent[] = [{ timestamp: 1000, type: "close", closeCode: 1011 }];

    const events = enrichWsEventsFromConsole(existing, [
      '[log] close code=1011 reason="Server error"',
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].closeReason).toBe("Server error");
  });

  it("ignores non-WS-close console lines", () => {
    const events = enrichWsEventsFromConsole(
      [],
      ["[log] Normal application log", "[error] Something broke"],
    );

    expect(events).toHaveLength(0);
  });

  it("ignores invalid close codes", () => {
    const events = enrichWsEventsFromConsole([], ["[log] code=999", "[log] code=5000"]);

    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// formatDiagnosisReport()
// ---------------------------------------------------------------------------

describe("formatDiagnosisReport", () => {
  it("formats markdown with badge, fix, evidence", () => {
    const report = formatDiagnosisReport([
      {
        id: "ws-1011-after-tool-response",
        severity: "critical",
        rootCause: "WebSocket 1011 after tool call",
        explanation: "The Gemini session crashed.",
        suggestedFix: "Use clientContent with functionResponse parts.",
        evidence: ['WS close: code=1011, reason="Internal error"'],
        count: 1,
      },
    ]);

    expect(report).toContain("[CRITICAL]");
    expect(report).toContain("ROOT CAUSE: WebSocket 1011 after tool call");
    expect(report).toContain("### Fix");
    expect(report).toContain("clientContent");
    expect(report).toContain("### Evidence");
    expect(report).toContain("code=1011");
  });

  it("shows occurrence count when > 1", () => {
    const report = formatDiagnosisReport([
      {
        id: "test",
        severity: "major",
        rootCause: "Test cause",
        explanation: "Test",
        suggestedFix: "Fix",
        evidence: [],
        count: 3,
      },
    ]);

    expect(report).toContain("(3 occurrences)");
  });

  it("returns fallback message for empty diagnoses", () => {
    const report = formatDiagnosisReport([]);
    expect(report).toContain("No diagnostic signals");
  });
});

// ---------------------------------------------------------------------------
// buildDiagnosisNudge()
// ---------------------------------------------------------------------------

describe("buildDiagnosisNudge", () => {
  it("includes top-2 root causes", () => {
    const nudge = buildDiagnosisNudge(1, 5, [
      {
        id: "a",
        severity: "critical",
        rootCause: "WS 1011 after tool call",
        explanation: "",
        suggestedFix: "",
        evidence: [],
        count: 1,
      },
      {
        id: "b",
        severity: "major",
        rootCause: "mic heard, tutor silent",
        explanation: "",
        suggestedFix: "",
        evidence: [],
        count: 1,
      },
    ]);

    expect(nudge).toContain("Voice QA 1/5 FAILED");
    expect(nudge).toContain("WS 1011 after tool call");
    expect(nudge).toContain("mic heard, tutor silent");
    expect(nudge).toContain("QA-FEEDBACK.md");
    expect(nudge).not.toContain("+0 more");
  });

  it("shows +N more when 3+ diagnoses", () => {
    const nudge = buildDiagnosisNudge(2, 5, [
      {
        id: "a",
        severity: "critical",
        rootCause: "A",
        explanation: "",
        suggestedFix: "",
        evidence: [],
        count: 1,
      },
      {
        id: "b",
        severity: "major",
        rootCause: "B",
        explanation: "",
        suggestedFix: "",
        evidence: [],
        count: 1,
      },
      {
        id: "c",
        severity: "minor",
        rootCause: "C",
        explanation: "",
        suggestedFix: "",
        evidence: [],
        count: 1,
      },
    ]);

    expect(nudge).toContain("A; B");
    expect(nudge).toContain("(+1 more)");
  });

  it("handles single diagnosis without +N", () => {
    const nudge = buildDiagnosisNudge(1, 5, [
      {
        id: "a",
        severity: "critical",
        rootCause: "WS crash",
        explanation: "",
        suggestedFix: "",
        evidence: [],
        count: 1,
      },
    ]);

    expect(nudge).toContain("WS crash");
    expect(nudge).not.toContain("+");
    expect(nudge).not.toContain("more");
  });

  it("handles empty diagnoses gracefully", () => {
    const nudge = buildDiagnosisNudge(1, 5, []);
    expect(nudge).toContain("Voice QA 1/5 FAILED");
    expect(nudge).toContain("QA-FEEDBACK.md");
  });
});

// ---------------------------------------------------------------------------
// buildLlmDiagnosisPrompt()
// ---------------------------------------------------------------------------

describe("buildLlmDiagnosisPrompt", () => {
  it("includes known bugs section", () => {
    const result = makeResult({ wsEvents: [makeWsEvent({ type: "open" })] });
    const prompt = buildLlmDiagnosisPrompt([result], []);
    expect(prompt).toContain("Known Bugs");
    expect(prompt).toContain("sendToolResponse");
    expect(prompt).toContain("NON_BLOCKING");
    expect(prompt).toContain("gemini-2.5-flash-native-audio");
  });

  it("includes console errors and WS events", () => {
    const result = makeResult({
      consoleErrors: ["Something broke"],
      wsEvents: [
        makeWsEvent({ type: "open", url: "wss://gemini.example.com" }),
        makeWsEvent({ type: "close", closeCode: 1011, closeReason: "Internal error" }),
      ],
    });
    const prompt = buildLlmDiagnosisPrompt([result], []);
    expect(prompt).toContain("Something broke");
    expect(prompt).toContain("WS CLOSE code=1011");
    expect(prompt).toContain("WS OPEN");
  });

  it("includes static diagnoses for context", () => {
    const staticDiags: Diagnosis[] = [
      {
        id: "ws-1011-generic",
        severity: "critical",
        rootCause: "Gemini server crash (WS 1011)",
        explanation: "Known instability",
        suggestedFix: "Remove NON_BLOCKING",
        evidence: [],
        count: 1,
      },
    ];
    const result = makeResult({});
    const prompt = buildLlmDiagnosisPrompt([result], staticDiags);
    expect(prompt).toContain("Static Rule Diagnosis");
    expect(prompt).toContain("Gemini server crash");
  });

  it("asks for JSON array response", () => {
    const result = makeResult({});
    const prompt = buildLlmDiagnosisPrompt([result], []);
    expect(prompt).toContain("JSON array");
    expect(prompt).toContain('"severity"');
    expect(prompt).toContain('"rootCause"');
  });
});

// ---------------------------------------------------------------------------
// parseLlmDiagnosis()
// ---------------------------------------------------------------------------

describe("parseLlmDiagnosis", () => {
  it("parses valid JSON array from LLM response", () => {
    const response = `Here's my analysis:
\`\`\`json
[
  {
    "severity": "major",
    "rootCause": "Audio format mismatch",
    "explanation": "The WAV file format is not PCM16 mono 16kHz as required.",
    "suggestedFix": "Convert audio with ffmpeg -ar 16000 -ac 1 -f s16le",
    "evidence": ["Console: audio format unsupported"]
  }
]
\`\`\``;

    const diagnoses = parseLlmDiagnosis(response);
    expect(diagnoses).toHaveLength(1);
    expect(diagnoses[0].id).toBe("llm-audio-format-mismatch");
    expect(diagnoses[0].severity).toBe("major");
    expect(diagnoses[0].rootCause).toBe("Audio format mismatch");
    expect(diagnoses[0].explanation).toContain("PCM16");
    expect(diagnoses[0].suggestedFix).toContain("ffmpeg");
    expect(diagnoses[0].evidence).toHaveLength(1);
  });

  it("returns empty for non-JSON response", () => {
    expect(parseLlmDiagnosis("No issues found.")).toHaveLength(0);
  });

  it("returns empty for empty JSON array", () => {
    expect(parseLlmDiagnosis("[]")).toHaveLength(0);
  });

  it("skips entries missing rootCause or explanation", () => {
    const response = '[{ "severity": "major", "message": "bad" }]';
    expect(parseLlmDiagnosis(response)).toHaveLength(0);
  });

  it("normalizes unknown severity to major", () => {
    const response =
      '[{ "severity": "warning", "rootCause": "Test", "explanation": "Test explanation" }]';
    const diagnoses = parseLlmDiagnosis(response);
    expect(diagnoses[0].severity).toBe("major");
  });

  it("handles malformed JSON gracefully", () => {
    expect(parseLlmDiagnosis("[{broken json")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// mergeDiagnoses()
// ---------------------------------------------------------------------------

describe("mergeDiagnoses", () => {
  const staticDiag: Diagnosis = {
    id: "ws-1011-generic",
    severity: "critical",
    rootCause: "Gemini server crash (WS 1011)",
    explanation: "Known instability",
    suggestedFix: "Remove NON_BLOCKING",
    evidence: [],
    count: 1,
  };

  it("adds LLM diagnoses that don't overlap with static", () => {
    const llmDiag: Diagnosis = {
      id: "llm-audio-format",
      severity: "major",
      rootCause: "Audio format mismatch",
      explanation: "WAV not in correct format",
      suggestedFix: "Convert audio",
      evidence: [],
      count: 1,
    };

    const merged = mergeDiagnoses([staticDiag], [llmDiag]);
    expect(merged).toHaveLength(2);
    expect(merged[0].id).toBe("ws-1011-generic"); // critical first
    expect(merged[1].id).toBe("llm-audio-format");
  });

  it("deduplicates overlapping root causes", () => {
    const llmDiag: Diagnosis = {
      id: "llm-ws-1011",
      severity: "critical",
      rootCause: "Gemini server crash WS 1011",
      explanation: "Same issue differently worded",
      suggestedFix: "Same fix",
      evidence: [],
      count: 1,
    };

    const merged = mergeDiagnoses([staticDiag], [llmDiag]);
    expect(merged).toHaveLength(1); // Should dedup
    expect(merged[0].id).toBe("ws-1011-generic");
  });

  it("preserves severity ordering after merge", () => {
    const llmDiag: Diagnosis = {
      id: "llm-critical-thing",
      severity: "critical",
      rootCause: "Completely new critical issue",
      explanation: "Something new",
      suggestedFix: "Fix it",
      evidence: [],
      count: 1,
    };
    const minorStatic: Diagnosis = {
      id: "http-api-error",
      severity: "minor",
      rootCause: "Backend API error",
      explanation: "HTTP 500",
      suggestedFix: "Check server",
      evidence: [],
      count: 1,
    };

    const merged = mergeDiagnoses([minorStatic], [llmDiag]);
    expect(merged[0].severity).toBe("critical");
    expect(merged[1].severity).toBe("minor");
  });

  it("handles empty LLM diagnoses", () => {
    const merged = mergeDiagnoses([staticDiag], []);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe("ws-1011-generic");
  });
});

// ---------------------------------------------------------------------------
// Diff formatting in diagnosis reports
// ---------------------------------------------------------------------------

describe("formatDiagnosisReport — diff blocks", () => {
  it("wraps unified diff suggestedFix in ```diff fences", () => {
    const diag: Diagnosis = {
      id: "test-diff",
      severity: "critical",
      rootCause: "broken tool response",
      explanation: "sendToolResponse causes WS 1011",
      suggestedFix:
        "--- a/src/hooks/useScratchpadAI.ts\n+++ b/src/hooks/useScratchpadAI.ts\n@@ -142,3 +142,5 @@\n context\n-    session.sendToolResponse(resp);\n+    session.send({ clientContent: { functionResponse: [resp] } });\n context",
      evidence: [],
      count: 1,
    };

    const report = formatDiagnosisReport([diag]);
    expect(report).toContain("```diff");
    expect(report).toContain("--- a/src/hooks/useScratchpadAI.ts");
    expect(report).toContain("```\n");
  });

  it("does NOT wrap plain text suggestedFix in diff fences", () => {
    const diag: Diagnosis = {
      id: "test-plain",
      severity: "major",
      rootCause: "plain fix",
      explanation: "some issue",
      suggestedFix: "In useScratchpadAI.ts:142, change sendToolResponse to sendClientContent",
      evidence: [],
      count: 1,
    };

    const report = formatDiagnosisReport([diag]);
    expect(report).not.toContain("```diff");
    expect(report).toContain("In useScratchpadAI.ts:142");
  });
});

describe("buildLlmDiagnosisPrompt — diff instructions", () => {
  it("includes unified diff format instructions", () => {
    const results = [makeResult({ error: "tutor silent" })];
    const prompt = buildLlmDiagnosisPrompt(results, [], []);
    expect(prompt).toContain("unified diff");
    expect(prompt).toContain("git apply");
    expect(prompt).toContain("--- a/");
    expect(prompt).toContain("+++ b/");
    expect(prompt).toContain("@@ -LINE,COUNT +LINE,COUNT @@");
  });
});
