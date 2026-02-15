import { describe, expect, it } from "vitest";
import {
  hasExplicitWebTarget,
  isClaudeExtensionRequest,
  isExtensionWorkflowRequest,
  isVagueUsefulExtensionRequest,
} from "./extension-intent.js";

describe("isExtensionWorkflowRequest", () => {
  it("matches explicit claude extension requests", () => {
    expect(isExtensionWorkflowRequest("can you use claude extension")).toBe(true);
    expect(isExtensionWorkflowRequest("use claude eextension")).toBe(true);
    expect(isExtensionWorkflowRequest("use claude extnesion")).toBe(true);
    expect(isClaudeExtensionRequest("can you use claude extension")).toBe(true);
    expect(isClaudeExtensionRequest("use claude eextension")).toBe(true);
    expect(isClaudeExtensionRequest("use claude extnesion")).toBe(true);
  });

  it("treats orange toolbar extension phrasing as claude-extension intent", () => {
    const prompt = "i want it to use the extnesion on my bar, the orange one";
    expect(isExtensionWorkflowRequest(prompt)).toBe(true);
    expect(isClaudeExtensionRequest(prompt)).toBe(true);
  });

  it("matches wrapped/speaker-prefixed extension requests", () => {
    const wrapped =
      "[Current message - respond to this]\n[WhatsApp ...] Gagan: use the extension to do anything useful";
    expect(isExtensionWorkflowRequest(wrapped)).toBe(true);
  });

  it("matches browser relay phrasing", () => {
    expect(isExtensionWorkflowRequest("please use browser relay and attach tab")).toBe(true);
  });

  it("ignores file-extension technical chatter", () => {
    expect(isExtensionWorkflowRequest("I use file extension .png and .jpg")).toBe(false);
    expect(isExtensionWorkflowRequest("this filename extension is .ts")).toBe(false);
  });

  it("returns false for unrelated text", () => {
    expect(isExtensionWorkflowRequest("summarize this PDF")).toBe(false);
    expect(isClaudeExtensionRequest("summarize this PDF")).toBe(false);
    expect(isClaudeExtensionRequest("use the extension to do anything useful")).toBe(false);
  });

  it("detects explicit web targets", () => {
    expect(hasExplicitWebTarget("open https://openai.com and summarize")).toBe(true);
    expect(hasExplicitWebTarget("go to openai.com")).toBe(true);
    expect(hasExplicitWebTarget("use the extension to do anything useful")).toBe(false);
  });

  it("detects vague useful extension asks", () => {
    expect(isVagueUsefulExtensionRequest("use the extension to do anything useful")).toBe(true);
    expect(isVagueUsefulExtensionRequest("use claude extension and do a capability showcase")).toBe(
      true,
    );
    expect(
      isVagueUsefulExtensionRequest("use the extension to open https://openai.com and summarize"),
    ).toBe(false);
    expect(isVagueUsefulExtensionRequest("use the extension to summarize this page")).toBe(false);
  });
});
