import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  estimateQueryComplexity,
  shouldAutoTriggerCouncil,
  formatCouncilResult,
  DEFAULT_COUNCIL_MEMBERS,
  DEFAULT_CHAIR_MODEL,
  type CouncilResult,
} from "./council-mode.js";
import type { CouncilConfig } from "openclaw/plugin-sdk";

describe("council-mode", () => {
  describe("estimateQueryComplexity", () => {
    it("scores simple queries low", () => {
      const score = estimateQueryComplexity("What is 2+2?");
      expect(score).toBeLessThan(0.3);
    });

    it("scores trade-off questions higher", () => {
      const score = estimateQueryComplexity("What are the trade-offs between SQL and NoSQL?");
      expect(score).toBeGreaterThanOrEqual(0.3);
    });

    it("scores comparison questions higher", () => {
      const score = estimateQueryComplexity("Compare React vs Vue for a large application");
      expect(score).toBeGreaterThanOrEqual(0.3);
    });

    it("scores architectural questions higher", () => {
      const score = estimateQueryComplexity(
        "What architecture pattern should we use for a microservices system?",
      );
      // "architecture" + "should" + "pattern" contribute to complexity
      expect(score).toBeGreaterThanOrEqual(0.3);
    });

    it("scores multiple questions higher", () => {
      const score = estimateQueryComplexity(
        "Should we use TypeScript? What about testing? How do we structure the project?",
      );
      expect(score).toBeGreaterThanOrEqual(0.4);
    });

    it("scores long, complex queries higher", () => {
      const score = estimateQueryComplexity(
        `We're building a new startup and need to decide on our tech stack.
        We have a team of 5 developers. The application needs real-time features.
        Should we use microservices or start with a monolith? What database should we choose?
        How do we balance speed-to-market with scalability?`,
      );
      expect(score).toBeGreaterThanOrEqual(0.6);
    });

    it("caps score at 1.0", () => {
      const score = estimateQueryComplexity(
        `What are the trade-offs between microservices vs monolith architecture?
        Compare the performance implications. What's the best approach for scalability?
        How should we design the security model? What are the reliability considerations?
        Should we recommend a specific framework? What's your opinion on the future evolution?`,
      );
      expect(score).toBeLessThanOrEqual(1.0);
    });
  });

  describe("shouldAutoTriggerCouncil", () => {
    it("returns false when autoTrigger is disabled", () => {
      const config: CouncilConfig = { autoTrigger: false };
      const result = shouldAutoTriggerCouncil("complex trade-off question", config);
      expect(result).toBe(false);
    });

    it("returns true when complexity exceeds threshold", () => {
      const config: CouncilConfig = {
        autoTrigger: true,
        complexityThreshold: 0.3,
      };
      const result = shouldAutoTriggerCouncil("What are the trade-offs between SQL vs NoSQL?", config);
      expect(result).toBe(true);
    });

    it("returns false when complexity is below threshold", () => {
      const config: CouncilConfig = {
        autoTrigger: true,
        complexityThreshold: 0.9,
      };
      const result = shouldAutoTriggerCouncil("What is 2+2?", config);
      expect(result).toBe(false);
    });

    it("uses default threshold of 0.8 when not specified", () => {
      const config: CouncilConfig = { autoTrigger: true };
      // Simple query should not trigger at 0.8 threshold
      const result = shouldAutoTriggerCouncil("What time is it?", config);
      expect(result).toBe(false);
    });
  });

  describe("formatCouncilResult", () => {
    it("formats a successful result", () => {
      const result: CouncilResult = {
        ok: true,
        synthesis: "Start with a modular monolith.",
        confidence: "high",
        memberResponses: [
          { memberId: "claude", model: "anthropic/claude-opus-4-5", response: "...", durationMs: 5000 },
          { memberId: "gpt", model: "openai/gpt-5.2", response: "...", durationMs: 4000 },
        ],
        agreements: ["Speed matters", "Don't over-engineer"],
        disagreements: ["When to split"],
        minorityViews: ["Consider serverless"],
        chairDurationMs: 3000,
        totalDurationMs: 8000,
      };

      const formatted = formatCouncilResult(result);

      expect(formatted).toContain("## Council Synthesis");
      expect(formatted).toContain("Start with a modular monolith.");
      expect(formatted).toContain("**Confidence:** HIGH");
      expect(formatted).toContain("### Points of Agreement");
      expect(formatted).toContain("Speed matters");
      expect(formatted).toContain("### Points of Disagreement");
      expect(formatted).toContain("When to split");
      expect(formatted).toContain("### Notable Minority Views");
      expect(formatted).toContain("Consider serverless");
      expect(formatted).toContain("2 members");
      expect(formatted).toContain("8.0s");
    });

    it("omits empty sections", () => {
      const result: CouncilResult = {
        ok: true,
        synthesis: "Simple answer.",
        confidence: "medium",
        memberResponses: [
          { memberId: "claude", model: "anthropic/claude-opus-4-5", response: "...", durationMs: 5000 },
        ],
        agreements: [],
        disagreements: [],
        minorityViews: [],
        chairDurationMs: 2000,
        totalDurationMs: 7000,
      };

      const formatted = formatCouncilResult(result);

      expect(formatted).not.toContain("### Points of Agreement");
      expect(formatted).not.toContain("### Points of Disagreement");
      expect(formatted).not.toContain("### Notable Minority Views");
    });
  });

  describe("DEFAULT_COUNCIL_MEMBERS", () => {
    it("has diverse roles", () => {
      const roles = DEFAULT_COUNCIL_MEMBERS.map((m) => m.role);
      expect(roles).toContain("analytical");
      expect(roles).toContain("creative");
      expect(roles).toContain("systematic");
    });

    it("has unique member IDs", () => {
      const ids = DEFAULT_COUNCIL_MEMBERS.map((m) => m.id);
      const uniqueIds = [...new Set(ids)];
      expect(uniqueIds.length).toBe(ids.length);
    });

    it("includes system prompts", () => {
      for (const member of DEFAULT_COUNCIL_MEMBERS) {
        expect(member.systemPrompt).toBeDefined();
        expect(member.systemPrompt!.length).toBeGreaterThan(50);
      }
    });
  });

  describe("DEFAULT_CHAIR_MODEL", () => {
    it("is a Claude model", () => {
      expect(DEFAULT_CHAIR_MODEL).toContain("anthropic/claude");
    });
  });
});
