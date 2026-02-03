import { describe, expect, it } from "vitest";

import { resolveBoundTarget } from "./orchestrator.js";

describe("resolveBoundTarget", () => {
  it("rejects missing explicit binding when required", () => {
    expect(() =>
      resolveBoundTarget(
        "Implement websocket retry logic",
        {
          routing: {
            requireRepoBinding: true,
            requireBranchMatch: true,
            onAmbiguousTarget: "fail_closed",
            allowedTargets: [{ name: "aitutor-homework", path: "/tmp/aitutor-homework" }],
          },
        },
        "/tmp",
      ),
    ).toThrow(/Specify target repo/i);
  });

  it("rejects ambiguous target bindings", () => {
    expect(() =>
      resolveBoundTarget(
        "Ship this in homework and aitutor @v1",
        {
          routing: {
            requireRepoBinding: true,
            onAmbiguousTarget: "fail_closed",
            allowedTargets: [
              { name: "aitutor", path: "/tmp/aitutor" },
              { name: "homework", path: "/tmp/homework" },
            ],
          },
        },
        "/tmp",
      ),
    ).toThrow(/Ambiguous target binding/i);
  });

  it("enforces branch binding for fail-closed routing", () => {
    expect(() =>
      resolveBoundTarget(
        "Implement this in aitutor",
        {
          routing: {
            requireRepoBinding: true,
            requireBranchMatch: true,
            onAmbiguousTarget: "fail_closed",
            allowedTargets: [{ name: "aitutor", path: "/tmp/aitutor", branchPattern: "^v1$" }],
          },
        },
        "/tmp",
      ),
    ).toThrow(/Branch binding required/i);
  });
});

