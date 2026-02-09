import { describe, expect, it } from "vitest";
import { parseQaFlags } from "./commands-qa.js";

describe("parseQaFlags", () => {
  it("parses bare criteria", () => {
    const result = parseQaFlags("test the tutor board renders");
    expect(result.criteria).toBe("test the tutor board renders");
    expect(result.steps).toBe(10);
    expect(result.sample).toBe(5);
    expect(result.url).toBeUndefined();
    expect(result.agentId).toBeUndefined();
    expect(result.tmuxTarget).toBe("moltbot:0.0");
  });

  it("parses --steps flag", () => {
    const result = parseQaFlags("--steps 5 test drawing tools");
    expect(result.steps).toBe(5);
    expect(result.criteria).toBe("test drawing tools");
  });

  it("parses --sample flag", () => {
    const result = parseQaFlags("--sample 3 test subjects");
    expect(result.sample).toBe(3);
    expect(result.criteria).toBe("test subjects");
  });

  it("parses --url flag", () => {
    const result = parseQaFlags("--url http://localhost:3000 test board");
    expect(result.url).toBe("http://localhost:3000");
    expect(result.criteria).toBe("test board");
  });

  it("parses agent=<id> flag", () => {
    const result = parseQaFlags("agent=v4 test the tutor");
    expect(result.agentId).toBe("v4");
    expect(result.criteria).toBe("test the tutor");
  });

  it("parses --tmux flag with explicit target", () => {
    const result = parseQaFlags("--tmux scratchpad:0.0 test board");
    expect(result.tmuxTarget).toBe("scratchpad:0.0");
    expect(result.criteria).toBe("test board");
  });

  it("defaults tmux target to moltbot:0.0", () => {
    const result = parseQaFlags("test board");
    expect(result.tmuxTarget).toBe("moltbot:0.0");
  });

  it("parses --voice flag", () => {
    const result = parseQaFlags("--voice test the tutor with speech");
    expect(result.voice).toBe(true);
    expect(result.criteria).toBe("test the tutor with speech");
  });

  it("defaults voice to false", () => {
    const result = parseQaFlags("test the board");
    expect(result.voice).toBe(false);
  });

  it("parses all flags together", () => {
    const result = parseQaFlags(
      "agent=v4 --steps 3 --sample 2 --url http://localhost:5173 --tmux dev:1.0 --voice test everything",
    );
    expect(result.agentId).toBe("v4");
    expect(result.steps).toBe(3);
    expect(result.sample).toBe(2);
    expect(result.url).toBe("http://localhost:5173");
    expect(result.tmuxTarget).toBe("dev:1.0");
    expect(result.voice).toBe(true);
    expect(result.criteria).toBe("test everything");
  });
});
