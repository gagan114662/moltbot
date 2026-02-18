import { defineConfig } from "tsdown";

const env = {
  NODE_ENV: "production",
};

// Workaround for rolldown#8184: chunk optimization creates circular import
// cycles that break the __exportAll runtime helper at startup.  `unbundle`
// (preserveModules) outputs one file per source module, eliminating shared
// chunks and the circular dependency entirely.  `treeshake: false` prevents
// unbundle mode from dropping cross-module re-exports.
const unbundled = { unbundle: true, treeshake: false } as const;

export default defineConfig([
  {
    entry: "src/index.ts",
    env,
    fixedExtension: false,
    platform: "node",
    ...unbundled,
  },
  {
    entry: "src/entry.ts",
    env,
    fixedExtension: false,
    platform: "node",
    ...unbundled,
  },
  {
    entry: "src/infra/warning-filter.ts",
    env,
    fixedExtension: false,
    platform: "node",
    ...unbundled,
  },
  {
    entry: "src/plugin-sdk/index.ts",
    outDir: "dist/plugin-sdk",
    env,
    fixedExtension: false,
    platform: "node",
  },
  {
    entry: "src/extensionAPI.ts",
    env,
    fixedExtension: false,
    platform: "node",
    ...unbundled,
  },
  {
    entry: [
      "src/hooks/bundled/boot-md/handler.ts",
      "src/hooks/bundled/command-logger/handler.ts",
      "src/hooks/bundled/session-memory/handler.ts",
      "src/hooks/bundled/soul-evil/handler.ts",
      "src/hooks/llm-slug-generator.ts",
    ],
    env,
    fixedExtension: false,
    platform: "node",
    ...unbundled,
  },
]);
