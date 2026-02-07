import { describe, expect, it } from "vitest";
import { validateMediaProbe } from "./browser-check.js";

describe("validateMediaProbe", () => {
  it("fails when no media elements are found and required is true", () => {
    const errors = validateMediaProbe({ audio: [], video: [] }, { enabled: true, required: true });
    expect(errors.some((error) => error.includes("No audio/video elements detected"))).toBe(true);
  });

  it("fails when media is present but not loaded/playable", () => {
    const errors = validateMediaProbe(
      {
        audio: [
          {
            selector: "audio#intro",
            hasSource: true,
            readyState: 0,
            duration: 12,
          },
        ],
        video: [],
      },
      {
        enabled: true,
        required: true,
        minReadyState: 1,
        requirePlayable: true,
      },
    );
    expect(errors.some((error) => error.includes("not loaded enough"))).toBe(true);
    expect(errors.some((error) => error.includes("not playable"))).toBe(true);
  });

  it("passes when media meets readiness/playability requirements", () => {
    const errors = validateMediaProbe(
      {
        audio: [
          {
            selector: "audio#intro",
            hasSource: true,
            readyState: 4,
            duration: 15,
          },
        ],
        video: [
          {
            selector: "video#lesson",
            hasSource: true,
            readyState: 4,
            duration: 25,
          },
        ],
      },
      {
        enabled: true,
        required: true,
        minReadyState: 1,
        requirePlayable: true,
        minDurationSeconds: 5,
      },
    );
    expect(errors).toEqual([]);
  });
});
