import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type ChromeExtensionManifest = {
  name?: string;
  description?: string;
  version?: string;
  default_locale?: string;
  action?: {
    default_popup?: string;
    default_title?: string;
  };
  side_panel?: {
    default_path?: string;
  };
  options_page?: string;
  commands?: Record<string, unknown>;
};

export type DiscoveredChromeExtension = {
  id: string;
  name: string;
  description?: string;
  version: string;
  profile: string;
  manifestPath: string;
  defaultPopup?: string;
  sidePanelPath?: string;
  optionsPage?: string;
  actionTitle?: string;
  hasToggleSidePanelCommand: boolean;
};

export type ChromeExtensionLaunchTarget = {
  extension: DiscoveredChromeExtension;
  launchKind: "popup" | "side_panel" | "options" | "none";
  launchPath?: string;
  launchUrl?: string;
};

function safeReadJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function listChromeUserDataRoots(): string[] {
  const home = os.homedir();
  const roots: string[] = [];
  if (process.platform === "darwin") {
    roots.push(path.join(home, "Library", "Application Support", "Google", "Chrome"));
  } else if (process.platform === "linux") {
    roots.push(path.join(home, ".config", "google-chrome"));
    roots.push(path.join(home, ".config", "chromium"));
  } else if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    if (localAppData) {
      roots.push(path.join(localAppData, "Google", "Chrome", "User Data"));
      roots.push(path.join(localAppData, "Chromium", "User Data"));
    }
  }
  return roots.filter((entry) => {
    try {
      return fs.existsSync(entry);
    } catch {
      return false;
    }
  });
}

function resolveLocaleMessage(
  manifestDir: string,
  manifest: ChromeExtensionManifest,
  value?: string,
): string | undefined {
  if (!value) {
    return undefined;
  }
  const match = /^__MSG_([A-Za-z0-9_@.-]+)__$/.exec(value);
  if (!match) {
    return value;
  }
  const key = match[1];
  const locales = [manifest.default_locale, "en", "en_US", "en_GB"].filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
  for (const locale of locales) {
    const localeMessagesPath = path.join(manifestDir, "_locales", locale, "messages.json");
    const messages = safeReadJson<Record<string, { message?: string }>>(localeMessagesPath);
    const text = messages?.[key]?.message?.trim();
    if (text) {
      return text;
    }
  }
  return value;
}

function parseVersionParts(version: string): number[] {
  return version
    .split(/[._-]/g)
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part));
}

function compareVersions(a: string, b: string): number {
  const left = parseVersionParts(a);
  const right = parseVersionParts(b);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const lv = left[i] ?? 0;
    const rv = right[i] ?? 0;
    if (lv !== rv) {
      return lv - rv;
    }
  }
  return 0;
}

function chooseLatestVersionDir(versionDirs: string[]): string | undefined {
  const sorted = [...versionDirs].toSorted((a, b) => compareVersions(a, b));
  return sorted.at(-1);
}

function normalizeLaunchPath(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }
  return value.replace(/^\/+/, "");
}

export function discoverInstalledChromeExtensions(): DiscoveredChromeExtension[] {
  const discovered: DiscoveredChromeExtension[] = [];
  for (const root of listChromeUserDataRoots()) {
    let profileDirs: string[] = [];
    try {
      profileDirs = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .filter((entry) => entry === "Default" || /^Profile \d+$/.test(entry));
    } catch {
      continue;
    }
    for (const profile of profileDirs) {
      const extensionsDir = path.join(root, profile, "Extensions");
      if (!fs.existsSync(extensionsDir)) {
        continue;
      }
      let extensionIds: string[] = [];
      try {
        extensionIds = fs
          .readdirSync(extensionsDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .filter((entry) => /^[a-z]{32}$/.test(entry));
      } catch {
        continue;
      }
      for (const extensionId of extensionIds) {
        const extensionRoot = path.join(extensionsDir, extensionId);
        let versionDirs: string[] = [];
        try {
          versionDirs = fs
            .readdirSync(extensionRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
        } catch {
          continue;
        }
        const latestVersion = chooseLatestVersionDir(versionDirs);
        if (!latestVersion) {
          continue;
        }
        const manifestPath = path.join(extensionRoot, latestVersion, "manifest.json");
        const manifest = safeReadJson<ChromeExtensionManifest>(manifestPath);
        if (!manifest) {
          continue;
        }
        const manifestDir = path.dirname(manifestPath);
        const resolvedName = resolveLocaleMessage(manifestDir, manifest, manifest.name)?.trim();
        const name = resolvedName || extensionId;
        const description =
          resolveLocaleMessage(manifestDir, manifest, manifest.description)?.trim() || undefined;
        const defaultPopup = normalizeLaunchPath(manifest.action?.default_popup);
        const sidePanelPath = normalizeLaunchPath(manifest.side_panel?.default_path);
        const optionsPage = normalizeLaunchPath(manifest.options_page);
        const actionTitle =
          resolveLocaleMessage(manifestDir, manifest, manifest.action?.default_title)?.trim() ||
          undefined;
        const hasToggleSidePanelCommand = Object.keys(manifest.commands ?? {}).includes(
          "toggle-side-panel",
        );
        discovered.push({
          id: extensionId,
          name,
          description,
          version: manifest.version?.trim() || latestVersion,
          profile,
          manifestPath,
          defaultPopup,
          sidePanelPath,
          optionsPage,
          actionTitle,
          hasToggleSidePanelCommand,
        });
      }
    }
  }
  return discovered;
}

function scoreExtensionMatch(extension: DiscoveredChromeExtension, query: string) {
  const q = query.trim().toLowerCase();
  if (!q) {
    return -1;
  }
  const id = extension.id.toLowerCase();
  const name = extension.name.toLowerCase();
  const description = (extension.description ?? "").toLowerCase();
  if (id === q) {
    return 100;
  }
  if (name === q) {
    return 95;
  }
  if (name.startsWith(q)) {
    return 90;
  }
  if (name.includes(q)) {
    return 80;
  }
  if (description.includes(q)) {
    return 60;
  }
  if (id.includes(q)) {
    return 50;
  }
  return -1;
}

export function findInstalledChromeExtension(
  query: string,
  extensions = discoverInstalledChromeExtensions(),
): DiscoveredChromeExtension | null {
  const scored = extensions
    .map((extension) => ({ extension, score: scoreExtensionMatch(extension, query) }))
    .filter((entry) => entry.score >= 0)
    .toSorted((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      const versionCompare = compareVersions(a.extension.version, b.extension.version);
      if (versionCompare !== 0) {
        return -versionCompare;
      }
      return a.extension.name.localeCompare(b.extension.name);
    });
  return scored[0]?.extension ?? null;
}

export function resolveChromeExtensionLaunchTarget(
  extensionQuery: string,
  opts?: { allowOptionsFallback?: boolean; extensions?: DiscoveredChromeExtension[] },
): ChromeExtensionLaunchTarget | null {
  const extension = findInstalledChromeExtension(
    extensionQuery,
    opts?.extensions ?? discoverInstalledChromeExtensions(),
  );
  if (!extension) {
    return null;
  }
  if (extension.defaultPopup) {
    return {
      extension,
      launchKind: "popup",
      launchPath: extension.defaultPopup,
      launchUrl: `chrome-extension://${extension.id}/${extension.defaultPopup}`,
    };
  }
  if (extension.sidePanelPath) {
    return {
      extension,
      launchKind: "side_panel",
      launchPath: extension.sidePanelPath,
      launchUrl: `chrome-extension://${extension.id}/${extension.sidePanelPath}`,
    };
  }
  if (opts?.allowOptionsFallback !== false && extension.optionsPage) {
    return {
      extension,
      launchKind: "options",
      launchPath: extension.optionsPage,
      launchUrl: `chrome-extension://${extension.id}/${extension.optionsPage}`,
    };
  }
  return { extension, launchKind: "none" };
}
