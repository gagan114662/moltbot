import { describe, expect, it } from "vitest";
import {
  buildDelegationAssessment,
  buildDelegationGovernancePolicy,
  inferAuthRequired,
  isAuthorizedPaymentAction,
} from "./delegation-framework.js";

describe("delegation-framework", () => {
  it("detects auth-requiring tasks from task text and seed URLs", () => {
    expect(inferAuthRequired("Scan X For You feed for trends", [])).toBe(true);
    expect(inferAuthRequired("Summarize public docs", ["https://twitter.com/home"])).toBe(true);
    expect(inferAuthRequired("Compare two public blog posts", ["https://example.com"])).toBe(false);
  });

  it("selects guarded delegation when auth is required but personal session is unavailable", () => {
    const assessment = buildDelegationAssessment({
      task: "Deep research X For You feed and compare account-level trends.",
      timeoutMinutes: 30,
      nestedDelegationAllowed: true,
      authRequired: true,
      chromeAttached: false,
      fallbackReady: true,
    });
    expect(assessment.blockers).toContain("auth_preflight_missing_personal_session");
    expect(["delegate_guarded", "do_not_delegate"]).toContain(assessment.decision);
  });

  it("selects delegation for high-complexity observable tasks", () => {
    const assessment = buildDelegationAssessment({
      task: "Deep research and cross-check RAG vs RETRO from multiple sources and produce evidence.",
      timeoutMinutes: 30,
      nestedDelegationAllowed: true,
      authRequired: false,
      chromeAttached: true,
      fallbackReady: true,
    });
    expect(assessment.decision).toBe("delegate");
    expect(assessment.score).toBeGreaterThanOrEqual(0.72);
  });

  it("builds governance policy with auth trigger when needed", () => {
    const policy = buildDelegationGovernancePolicy({
      decision: "delegate_guarded",
      timeoutMinutes: 25,
      checkpointMinutes: 4,
      nestedDelegationAllowed: false,
      authRequired: true,
    });
    expect(policy.escalationTriggers).toContain("auth_blocked");
    expect(policy.escalationTriggers).toContain("nested_delegation_disallowed");
    expect(policy.visibilityEvents).toContain("checkpoint");
  });

  describe("isAuthorizedPaymentAction", () => {
    it("recognizes authorized payment keywords", () => {
      expect(isAuthorizedPaymentAction("Set up stripe webhook for revenue tracking")).toBe(true);
      expect(isAuthorizedPaymentAction("Create Stripe API integration")).toBe(true);
      expect(isAuthorizedPaymentAction("Process bot subscription payment")).toBe(true);
      expect(isAuthorizedPaymentAction("Send Telegram payment link")).toBe(true);
    });

    it("recognizes authorized seed URLs", () => {
      expect(
        isAuthorizedPaymentAction("check payment status", ["https://api.stripe.com/v1/charges"]),
      ).toBe(true);
      expect(
        isAuthorizedPaymentAction("check payment status", [
          "https://dashboard.stripe.com/payments",
        ]),
      ).toBe(true);
    });

    it("rejects unauthorized payment actions", () => {
      expect(isAuthorizedPaymentAction("wire transfer $5000 to offshore account")).toBe(false);
      expect(isAuthorizedPaymentAction("purchase gift cards online")).toBe(false);
      expect(isAuthorizedPaymentAction("send money via paypal", ["https://paypal.com/send"])).toBe(
        false,
      );
    });
  });

  it("allows delegation for authorized payment tasks instead of blocking", () => {
    const assessment = buildDelegationAssessment({
      task: "Set up Stripe API webhook for revenue tracking and process bot subscription payments",
      timeoutMinutes: 20,
      nestedDelegationAllowed: true,
      authRequired: false,
      chromeAttached: false,
      fallbackReady: true,
      seedUrls: ["https://api.stripe.com/v1/webhooks"],
    });
    expect(assessment.decision).not.toBe("do_not_delegate");
  });

  it("still blocks unauthorized payment tasks", () => {
    const assessment = buildDelegationAssessment({
      task: "Purchase items from Amazon with my credit card and send wire transfer",
      timeoutMinutes: 20,
      nestedDelegationAllowed: true,
      authRequired: false,
      chromeAttached: false,
      fallbackReady: true,
    });
    expect(assessment.decision).toBe("do_not_delegate");
  });
});
