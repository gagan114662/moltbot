import fs from "node:fs";
import path from "node:path";

type PluginInstall = {
  installPath?: string;
};

type PluginEntry = {
  enabled?: boolean;
};

type ConfigShape = {
  plugins?: {
    installs?: Record<string, PluginInstall>;
    entries?: Record<string, PluginEntry>;
  };
};

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function exists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function resolveCandidateEntrypoints(installPath: string): string[] {
  const candidates = [path.join(installPath, "dist", "index.js"), path.join(installPath, "index.js")];
  const pkgPath = path.join(installPath, "package.json");
  if (!exists(pkgPath)) {
    return candidates;
  }

  try {
    const pkg = readJson<Record<string, unknown>>(pkgPath);
    const pushRel = (value: unknown) => {
      if (typeof value === "string" && value.trim()) {
        candidates.push(path.resolve(installPath, value));
      }
    };

    pushRel(pkg.main);
    pushRel(pkg.module);
    const exportsValue = pkg.exports;
    if (typeof exportsValue === "string") {
      pushRel(exportsValue);
    } else if (exportsValue && typeof exportsValue === "object") {
      const root = (exportsValue as Record<string, unknown>)["."];
      if (typeof root === "string") {
        pushRel(root);
      } else if (root && typeof root === "object") {
        pushRel((root as Record<string, unknown>).default);
        pushRel((root as Record<string, unknown>).import);
        pushRel((root as Record<string, unknown>).require);
      }
    }
  } catch {
    // ignore malformed package.json and rely on defaults
  }

  return Array.from(new Set(candidates));
}

function main() {
  const configPath = process.env.OPENCLAW_CONFIG_PATH || path.join(process.env.HOME || "", ".openclaw", "moltbot.json");
  const fix = process.argv.includes("--fix");
  if (!exists(configPath)) {
    console.error(`config not found: ${configPath}`);
    process.exit(2);
  }

  const config = readJson<ConfigShape>(configPath);
  const installs = config.plugins?.installs || {};
  const entries = config.plugins?.entries || {};
  const report: Array<{
    plugin: string;
    installPath: string;
    enabled: boolean;
    status: "ok" | "broken";
    candidates: string[];
    existing: string[];
    autoDisabled?: boolean;
  }> = [];
  let brokenEnabled = 0;

  for (const [plugin, install] of Object.entries(installs)) {
    const installPath = install.installPath || "";
    if (!installPath || !exists(installPath)) {
      const enabled = entries[plugin]?.enabled !== false;
      if (enabled) {
        brokenEnabled += 1;
      }
      report.push({
        plugin,
        installPath,
        enabled,
        status: "broken",
        candidates: [],
        existing: [],
      });
      if (fix) {
        entries[plugin] = { ...(entries[plugin] || {}), enabled: false };
      }
      continue;
    }

    const candidates = resolveCandidateEntrypoints(installPath);
    const existing = candidates.filter(exists);
    const isBroken = existing.length === 0;
    const enabled = entries[plugin]?.enabled !== false;
    if (isBroken) {
      if (enabled) {
        brokenEnabled += 1;
      }
      if (fix) {
        entries[plugin] = { ...(entries[plugin] || {}), enabled: false };
      }
    }

    report.push({
      plugin,
      installPath,
      enabled,
      status: isBroken ? "broken" : "ok",
      candidates,
      existing,
      autoDisabled: isBroken && fix ? true : undefined,
    });
  }

  if (fix) {
    config.plugins = { ...(config.plugins || {}), entries, installs };
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  console.log(
    JSON.stringify(
      {
        ok: brokenEnabled === 0,
        fixApplied: fix,
        brokenEnabledCount: brokenEnabled,
        report,
      },
      null,
      2,
    ),
  );
  process.exit(brokenEnabled === 0 ? 0 : 1);
}

main();
