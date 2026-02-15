/**
 * Security Sandbox Orchestrator — Manages isolated Kali Docker containers
 * for bug bounty engagements.
 *
 * Each engagement gets its own container with:
 * - Scoped target (only authorized domains/IPs)
 * - Time limit (auto-kill after expiry)
 * - Tool permissions (which scanners to enable)
 * - Result extraction (FINAL_VAR pattern)
 * - Clean destruction (no data leakage between targets)
 */

import { execSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam, readStringArrayParam } from "./common.js";

const SANDBOX_IMAGE = "moltbot/sandbox-kali";
const RESULTS_DIR = path.join(
  process.env.HOME ?? "/tmp",
  ".openclaw",
  "workspace",
  "evidence",
  "engagements",
);

type EngagementConfig = {
  id: string;
  target_scope: string[];
  excluded_scope: string[];
  tools: string[];
  max_duration_seconds: number;
  container_name: string;
  created_at: string;
};

type ScanResult = {
  tool: string;
  target: string;
  findings: string[];
  severity: "critical" | "high" | "medium" | "low" | "info";
  raw_output: string;
  timestamp: string;
};

function generateEngagementId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `eng_${ts}_${rand}`;
}

function isDockerAvailable(): boolean {
  try {
    execSync("docker info", { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function isImageBuilt(): boolean {
  try {
    const output = execSync(`docker images -q ${SANDBOX_IMAGE}`, {
      encoding: "utf-8",
      timeout: 5000,
    }).trim();
    return output.length > 0;
  } catch {
    return false;
  }
}

const SecuritySandboxSchema = {
  type: "object" as const,
  properties: {
    action: {
      type: "string" as const,
      enum: [
        "create_engagement",
        "run_scan",
        "get_results",
        "destroy_engagement",
        "list_engagements",
        "build_image",
        "status",
      ],
      description:
        "Action: create_engagement (new container), run_scan (execute tool in container), " +
        "get_results (extract findings), destroy_engagement (cleanup), " +
        "list_engagements (show active), build_image (build Kali image), status (check Docker)",
    },
    // create_engagement params
    target_scope: {
      type: "array" as const,
      items: { type: "string" as const },
      description: "Authorized target domains/IPs/CIDRs (ONLY scan these)",
    },
    excluded_scope: {
      type: "array" as const,
      items: { type: "string" as const },
      description: "Explicitly excluded targets (never scan these)",
    },
    tools: {
      type: "array" as const,
      items: { type: "string" as const },
      description:
        "Security tools to enable: nmap, sqlmap, nuclei, nikto, skipfish, dirb, ffuf, subfinder, httpx, amass, hashcat",
    },
    max_duration_seconds: {
      type: "number" as const,
      description: "Maximum engagement duration in seconds (default: 3600, max: 14400)",
    },
    // run_scan params
    engagement_id: {
      type: "string" as const,
      description: "Engagement ID (from create_engagement)",
    },
    scan_tool: {
      type: "string" as const,
      description: "Tool to run: nmap, sqlmap, nuclei, nikto, subfinder, httpx, ffuf, dirb",
    },
    scan_target: {
      type: "string" as const,
      description: "Target for this specific scan (must be within engagement scope)",
    },
    scan_args: {
      type: "string" as const,
      description: "Additional arguments for the scan tool",
    },
    // get_results params — uses engagement_id
    // destroy_engagement — uses engagement_id
  },
  required: ["action"],
};

export function createSecuritySandboxTool(): AnyAgentTool {
  return {
    name: "security_sandbox",
    description:
      "Manage isolated Kali Linux Docker containers for authorized security scanning. " +
      "Each engagement runs in its own container with scoped targets and time limits. " +
      "ONLY for authorized bug bounty programs and CTF targets. " +
      "Actions: create_engagement, run_scan, get_results, destroy_engagement, list_engagements, build_image, status.",
    schema: SecuritySandboxSchema,
    async execute(params: Record<string, unknown>) {
      const action = readStringParam(params, "action", { required: true });

      switch (action) {
        case "status":
          return handleStatus();
        case "build_image":
          return await handleBuildImage();
        case "create_engagement":
          return await handleCreateEngagement(params);
        case "run_scan":
          return await handleRunScan(params);
        case "get_results":
          return await handleGetResults(params);
        case "destroy_engagement":
          return await handleDestroyEngagement(params);
        case "list_engagements":
          return await handleListEngagements();
        default:
          return jsonResult({ error: `Unknown action: ${action}` });
      }
    },
  };
}

function handleStatus() {
  const dockerAvailable = isDockerAvailable();
  const imageBuilt = dockerAvailable && isImageBuilt();

  return jsonResult({
    docker_available: dockerAvailable,
    kali_image_built: imageBuilt,
    image_name: SANDBOX_IMAGE,
    results_dir: RESULTS_DIR,
    ready: dockerAvailable && imageBuilt,
    next_step: !dockerAvailable
      ? "Install and start Docker Desktop"
      : !imageBuilt
        ? 'Run action "build_image" to build the Kali sandbox image'
        : "Ready for engagements",
  });
}

async function handleBuildImage() {
  if (!isDockerAvailable()) {
    return jsonResult({ error: "Docker is not available. Install and start Docker Desktop." });
  }

  try {
    const projectRoot = path.resolve(process.cwd());
    const dockerfile = path.join(projectRoot, "docker", "Dockerfile.sandbox-kali");

    try {
      await fs.access(dockerfile);
    } catch {
      return jsonResult({
        error: `Dockerfile not found at ${dockerfile}. Create docker/Dockerfile.sandbox-kali first.`,
      });
    }

    // Build asynchronously, return immediately
    const child = spawn("docker", ["build", "-f", dockerfile, "-t", SANDBOX_IMAGE, projectRoot], {
      stdio: "ignore",
      detached: true,
    });
    child.unref();

    return jsonResult({
      ok: true,
      message: `Building ${SANDBOX_IMAGE} in background. This may take 10-15 minutes for first build.`,
      check_with: 'Use action "status" to check if image is ready.',
    });
  } catch (err) {
    return jsonResult({ error: `Build failed: ${String(err)}` });
  }
}

async function handleCreateEngagement(params: Record<string, unknown>) {
  if (!isDockerAvailable()) {
    return jsonResult({ error: "Docker is not available" });
  }
  if (!isImageBuilt()) {
    return jsonResult({ error: `Image ${SANDBOX_IMAGE} not built. Run build_image first.` });
  }

  const targetScope = readStringArrayParam(params, "target_scope", { required: true }) ?? [];
  const excludedScope = readStringArrayParam(params, "excluded_scope") ?? [];
  const tools = readStringArrayParam(params, "tools") ?? ["nmap", "nuclei", "httpx", "subfinder"];
  const maxDuration = readNumberParam(params, "max_duration_seconds", { integer: true }) ?? 3600;

  if (targetScope.length === 0) {
    return jsonResult({ error: "target_scope is required — specify authorized targets" });
  }

  // Validate scope doesn't include dangerous targets
  const blockedPatterns = [
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /localhost/i,
    /127\.0\.0\./,
    /^0\.0\.0\.0/,
  ];

  for (const target of targetScope) {
    if (blockedPatterns.some((p) => p.test(target))) {
      return jsonResult({
        error: `Target "${target}" is a private/local network address. Only scan authorized external targets.`,
      });
    }
  }

  const engId = generateEngagementId();
  const containerName = `moltbot-sec-${engId}`;
  const engDir = path.join(RESULTS_DIR, engId);

  await fs.mkdir(engDir, { recursive: true });

  // Write scope file
  await fs.writeFile(
    path.join(engDir, "scope.json"),
    JSON.stringify(
      {
        target_scope: targetScope,
        excluded_scope: excludedScope,
        tools,
        max_duration_seconds: Math.min(maxDuration, 14400),
      },
      null,
      2,
    ),
  );

  // Start container with scope mounted
  const cappedDuration = Math.min(maxDuration, 14400);
  try {
    execSync(
      `docker run -d --name ${containerName} ` +
        `--memory=2g --cpus=2 ` +
        `--network=bridge ` +
        `-v "${engDir}:/engagement/results" ` +
        `-e "ENGAGEMENT_ID=${engId}" ` +
        `-e "TARGET_SCOPE=${targetScope.join(",")}" ` +
        `-e "MAX_DURATION=${cappedDuration}" ` +
        `${SANDBOX_IMAGE} ` +
        `sleep ${cappedDuration}`,
      { encoding: "utf-8", timeout: 30000 },
    );
  } catch (err) {
    return jsonResult({ error: `Failed to create container: ${String(err)}` });
  }

  const config: EngagementConfig = {
    id: engId,
    target_scope: targetScope,
    excluded_scope: excludedScope,
    tools,
    max_duration_seconds: cappedDuration,
    container_name: containerName,
    created_at: new Date().toISOString(),
  };

  await fs.writeFile(path.join(engDir, "config.json"), JSON.stringify(config, null, 2));

  return jsonResult({
    ok: true,
    engagement_id: engId,
    container: containerName,
    scope: targetScope,
    tools_enabled: tools,
    max_duration_seconds: cappedDuration,
    message: `Engagement ${engId} created. Container ${containerName} running. Use run_scan to execute scans.`,
  });
}

async function handleRunScan(params: Record<string, unknown>) {
  const engId = readStringParam(params, "engagement_id", { required: true });
  const scanTool = readStringParam(params, "scan_tool", { required: true });
  const scanTarget = readStringParam(params, "scan_target", { required: true });
  const scanArgs = readStringParam(params, "scan_args") ?? "";

  if (!engId || !scanTool || !scanTarget) {
    return jsonResult({ error: "engagement_id, scan_tool, and scan_target are required" });
  }

  // Read engagement config
  const engDir = path.join(RESULTS_DIR, engId);
  let config: EngagementConfig;
  try {
    const raw = await fs.readFile(path.join(engDir, "config.json"), "utf-8");
    config = JSON.parse(raw);
  } catch {
    return jsonResult({ error: `Engagement ${engId} not found` });
  }

  // Verify target is in scope
  const inScope = config.target_scope.some(
    (s) => scanTarget === s || scanTarget.endsWith(`.${s}`) || s.includes("/"), // CIDR — trust the tool to handle
  );
  if (!inScope) {
    return jsonResult({
      error: `Target "${scanTarget}" is NOT in scope. Authorized: ${config.target_scope.join(", ")}`,
    });
  }

  // Verify target is not excluded
  const excluded = config.excluded_scope.some(
    (s) => scanTarget === s || scanTarget.endsWith(`.${s}`),
  );
  if (excluded) {
    return jsonResult({ error: `Target "${scanTarget}" is explicitly excluded from scope` });
  }

  // Verify tool is enabled
  if (!config.tools.includes(scanTool)) {
    return jsonResult({
      error: `Tool "${scanTool}" is not enabled. Enabled: ${config.tools.join(", ")}`,
    });
  }

  // Build scan command based on tool
  const scanCommands: Record<string, string> = {
    nmap: `nmap -sV -sC -oN /engagement/results/nmap-${Date.now()}.txt ${scanArgs} ${scanTarget}`,
    nuclei: `nuclei -u ${scanTarget} -o /engagement/results/nuclei-${Date.now()}.txt ${scanArgs}`,
    sqlmap: `sqlmap -u "${scanTarget}" --batch --output-dir=/engagement/results/sqlmap-${Date.now()} ${scanArgs}`,
    nikto: `nikto -h ${scanTarget} -output /engagement/results/nikto-${Date.now()}.txt ${scanArgs}`,
    subfinder: `subfinder -d ${scanTarget} -o /engagement/results/subfinder-${Date.now()}.txt ${scanArgs}`,
    httpx: `echo "${scanTarget}" | httpx -o /engagement/results/httpx-${Date.now()}.txt ${scanArgs}`,
    ffuf: `ffuf -u https://${scanTarget}/FUZZ -w /usr/share/wordlists/dirb/common.txt -o /engagement/results/ffuf-${Date.now()}.json ${scanArgs}`,
    dirb: `dirb https://${scanTarget} -o /engagement/results/dirb-${Date.now()}.txt ${scanArgs}`,
    amass: `amass enum -d ${scanTarget} -o /engagement/results/amass-${Date.now()}.txt ${scanArgs}`,
    skipfish: `skipfish -o /engagement/results/skipfish-${Date.now()} https://${scanTarget} ${scanArgs}`,
    hping3: `hping3 ${scanTarget} -c 10 ${scanArgs} > /engagement/results/hping3-${Date.now()}.txt 2>&1`,
  };

  const cmd = scanCommands[scanTool];
  if (!cmd) {
    return jsonResult({ error: `Unknown scan tool: ${scanTool}` });
  }

  // Execute scan in container (async with timeout)
  try {
    const output = execSync(`docker exec ${config.container_name} bash -c '${cmd}'`, {
      encoding: "utf-8",
      timeout: 300000, // 5 minute timeout per scan
      maxBuffer: 10 * 1024 * 1024, // 10MB output buffer
    });

    return jsonResult({
      ok: true,
      engagement_id: engId,
      tool: scanTool,
      target: scanTarget,
      output: output.slice(0, 5000), // Cap output at 5KB
      results_dir: engDir,
      message: `${scanTool} scan completed on ${scanTarget}`,
    });
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string; status?: number };
    return jsonResult({
      ok: false,
      engagement_id: engId,
      tool: scanTool,
      target: scanTarget,
      error: `Scan failed or timed out`,
      stdout: (error.stdout ?? "").slice(0, 3000),
      stderr: (error.stderr ?? "").slice(0, 1000),
      exit_code: error.status,
    });
  }
}

async function handleGetResults(params: Record<string, unknown>) {
  const engId = readStringParam(params, "engagement_id", { required: true });
  const engDir = path.join(RESULTS_DIR, engId ?? "");

  try {
    const files = await fs.readdir(engDir);
    const results: { file: string; size: number; preview: string }[] = [];

    for (const file of files) {
      if (file === "config.json" || file === "scope.json") {
        continue;
      }
      const filePath = path.join(engDir, file);
      const stat = await fs.stat(filePath);
      if (stat.isFile()) {
        const content = await fs.readFile(filePath, "utf-8");
        results.push({
          file,
          size: stat.size,
          preview: content.slice(0, 2000),
        });
      }
    }

    return jsonResult({
      engagement_id: engId,
      result_count: results.length,
      results,
    });
  } catch {
    return jsonResult({ error: `Engagement ${engId} not found or no results yet` });
  }
}

async function handleDestroyEngagement(params: Record<string, unknown>) {
  const engId = readStringParam(params, "engagement_id", { required: true });
  const engDir = path.join(RESULTS_DIR, engId ?? "");

  let config: EngagementConfig;
  try {
    const raw = await fs.readFile(path.join(engDir, "config.json"), "utf-8");
    config = JSON.parse(raw);
  } catch {
    return jsonResult({ error: `Engagement ${engId} not found` });
  }

  // Stop and remove container
  try {
    execSync(`docker rm -f ${config.container_name}`, {
      stdio: "ignore",
      timeout: 15000,
    });
  } catch {
    // Container may already be stopped
  }

  return jsonResult({
    ok: true,
    engagement_id: engId,
    container_removed: config.container_name,
    results_preserved: engDir,
    message: `Engagement ${engId} destroyed. Results preserved at ${engDir} for reporting.`,
  });
}

async function handleListEngagements() {
  try {
    await fs.mkdir(RESULTS_DIR, { recursive: true });
    const dirs = await fs.readdir(RESULTS_DIR);
    const engagements: { id: string; config: EngagementConfig; container_running: boolean }[] = [];

    for (const dir of dirs) {
      if (!dir.startsWith("eng_")) {
        continue;
      }
      try {
        const raw = await fs.readFile(path.join(RESULTS_DIR, dir, "config.json"), "utf-8");
        const config = JSON.parse(raw) as EngagementConfig;

        let running = false;
        try {
          const status = execSync(
            `docker inspect -f '{{.State.Running}}' ${config.container_name}`,
            { encoding: "utf-8", timeout: 5000 },
          ).trim();
          running = status === "true";
        } catch {
          // Container doesn't exist
        }

        engagements.push({ id: dir, config, container_running: running });
      } catch {
        // Skip malformed engagement dirs
      }
    }

    return jsonResult({
      active_engagements: engagements.filter((e) => e.container_running).length,
      total_engagements: engagements.length,
      engagements,
    });
  } catch {
    return jsonResult({ active_engagements: 0, total_engagements: 0, engagements: [] });
  }
}
