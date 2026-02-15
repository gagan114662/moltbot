import { describe, expect, it } from "vitest";
import {
  findInstalledChromeExtension,
  resolveChromeExtensionLaunchTarget,
  type DiscoveredChromeExtension,
} from "./chrome-extension-discovery.js";

const fixtures: DiscoveredChromeExtension[] = [
  {
    id: "fcoeoabgfenejglbffodgkkbkcdhcgfn",
    name: "Claude",
    version: "1.0.49",
    profile: "Default",
    manifestPath: "/tmp/claude/manifest.json",
    hasToggleSidePanelCommand: true,
    optionsPage: "options.html",
  },
  {
    id: "abcabcabcabcabcabcabcabcabcabcab",
    name: "Example Popup Tool",
    version: "2.1.0",
    profile: "Default",
    manifestPath: "/tmp/example/manifest.json",
    hasToggleSidePanelCommand: false,
    defaultPopup: "popup/index.html",
  },
];

describe("chrome extension discovery matching", () => {
  it("matches by extension name", () => {
    const hit = findInstalledChromeExtension("claude", fixtures);
    expect(hit?.id).toBe("fcoeoabgfenejglbffodgkkbkcdhcgfn");
  });

  it("matches by extension id", () => {
    const hit = findInstalledChromeExtension("abcabcabcabcabcabcabcabcabcabcab", fixtures);
    expect(hit?.name).toBe("Example Popup Tool");
  });
});

describe("chrome extension launch target", () => {
  it("returns popup launch url when popup is present", () => {
    const target = resolveChromeExtensionLaunchTarget("example", { extensions: fixtures });
    expect(target?.launchKind).toBe("popup");
    expect(target?.launchUrl).toBe(
      "chrome-extension://abcabcabcabcabcabcabcabcabcabcab/popup/index.html",
    );
  });

  it("falls back to options for claude when popup is absent", () => {
    const target = resolveChromeExtensionLaunchTarget("claude", { extensions: fixtures });
    expect(target?.launchKind).toBe("options");
    expect(target?.launchUrl).toBe(
      "chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/options.html",
    );
  });
});
