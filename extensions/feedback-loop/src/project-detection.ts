import fs from "node:fs/promises";
import path from "node:path";

export type ProjectDetectionResult = {
  projectRoot: string;
  detected: boolean;
  method: "task-hint" | "git" | "agents-md" | "package-json" | "fallback";
  agentsMd?: string;
  claudeMd?: string;
};

/**
 * Detect the project root from task context.
 * Looks for:
 * 1. Path hints in the task text (e.g., "in aitutor-homework/frontend")
 * 2. Nearest .git directory
 * 3. AGENTS.md or CLAUDE.md files
 * 4. package.json files
 */
export async function detectProjectRoot(
  task: string,
  baseWorkspace: string,
): Promise<ProjectDetectionResult> {
  // Step 1: Extract path hints from task
  const pathHints = extractPathHints(task, baseWorkspace);

  for (const hint of pathHints) {
    const verified = await verifyProjectRoot(hint);
    if (verified) {
      return {
        projectRoot: hint,
        detected: true,
        method: "task-hint",
        agentsMd: verified.agentsMd,
        claudeMd: verified.claudeMd,
      };
    }
  }

  // Step 2: Check subdirectories for projects matching task keywords
  // Collect all matches with scores, then pick the best one
  const subdirs = await findProjectSubdirs(baseWorkspace);
  const matches: Array<{
    subdir: string;
    score: number;
    verified: { agentsMd?: string; claudeMd?: string };
  }> = [];

  for (const subdir of subdirs) {
    const score = taskMentionsProject(task, subdir, baseWorkspace);
    if (score > 0) {
      const verified = await verifyProjectRoot(subdir);
      if (verified) {
        matches.push({ subdir, score, verified });
      }
    }
  }

  // Sort by score (highest first), then by path length (more specific first)
  matches.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return b.subdir.length - a.subdir.length;
  });

  if (matches.length > 0) {
    const best = matches[0];
    return {
      projectRoot: best.subdir,
      detected: true,
      method: "agents-md",
      agentsMd: best.verified.agentsMd,
      claudeMd: best.verified.claudeMd,
    };
  }

  // Step 3: Fallback to base workspace
  const gitRoot = await findGitRoot(baseWorkspace);
  if (gitRoot) {
    const gitVerified = await verifyProjectRoot(gitRoot);
    return {
      projectRoot: gitRoot,
      detected: true,
      method: "git",
      agentsMd: gitVerified?.agentsMd,
      claudeMd: gitVerified?.claudeMd,
    };
  }

  const baseVerified = await verifyProjectRoot(baseWorkspace);
  return {
    projectRoot: baseWorkspace,
    detected: false,
    method: "fallback",
    agentsMd: baseVerified?.agentsMd,
    claudeMd: baseVerified?.claudeMd,
  };
}

/**
 * Extract path hints from task text.
 * Returns absolute paths sorted by specificity (most specific first).
 */
function extractPathHints(task: string, baseWorkspace: string): string[] {
  const hints: string[] = [];

  // Pattern 1: Explicit paths like "/Users/.../project" or "~/project"
  const absolutePathPattern = /(?:^|[\s"'`])(\/?(?:Users|home|var|tmp|opt|~)\/[a-zA-Z0-9_\-./]+)/gi;
  for (const match of task.matchAll(absolutePathPattern)) {
    let p = match[1];
    if (p.startsWith("~")) {
      p = path.join(process.env.HOME ?? "", p.slice(1));
    }
    hints.push(p);
  }

  // Pattern 2: "in <project-name>" or "in <project-name>/subdir"
  const inProjectPattern = /\bin\s+([a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_\-./]*)?)\b/gi;
  for (const match of task.matchAll(inProjectPattern)) {
    const relative = match[1];
    // Skip common words that aren't project names
    if (["the", "a", "an", "this", "that", "order", "parallel"].includes(relative.toLowerCase())) {
      continue;
    }
    hints.push(path.join(baseWorkspace, relative));
  }

  // Pattern 3: Known project name patterns (e.g., aitutor-homework, homework-test)
  const knownPatterns = [
    /\b(aitutor[a-zA-Z0-9_-]*)/gi,
    /\b(homework[a-zA-Z0-9_-]*)/gi,
    /\b(backend|frontend|services|api)[a-zA-Z0-9_-]*/gi,
  ];
  for (const pattern of knownPatterns) {
    for (const match of task.matchAll(pattern)) {
      hints.push(path.join(baseWorkspace, match[1]));
    }
  }

  // Dedupe and find nearest project root for each
  const seen = new Set<string>();
  const validHints: string[] = [];

  for (const hint of hints) {
    const normalized = path.normalize(hint);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);

    // Find nearest project root
    const projectRoot = findNearestProjectRoot(normalized, baseWorkspace);
    if (projectRoot && !seen.has(projectRoot)) {
      seen.add(projectRoot);
      validHints.push(projectRoot);
    }
  }

  // Sort by path length (most specific first)
  return validHints.toSorted((a, b) => b.length - a.length);
}

/**
 * Find the nearest parent directory that looks like a project root.
 */
function findNearestProjectRoot(targetPath: string, stopAt: string): string | undefined {
  let current = path.normalize(targetPath);
  const normalizedStop = path.normalize(stopAt);

  // Walk up until we hit stopAt or find a valid root
  while (current.length >= normalizedStop.length && current.startsWith(normalizedStop)) {
    // Don't return the base workspace itself from this function
    if (current !== normalizedStop) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return undefined;
}

/**
 * Check if task mentions a specific project by name.
 * Returns a score: 0 = no match, 1 = partial match, 2 = normalized match, 3 = exact match
 */
function taskMentionsProject(task: string, projectPath: string, baseWorkspace: string): number {
  const relativePath = path.relative(baseWorkspace, projectPath);
  const projectName = relativePath.split(path.sep)[0];
  if (!projectName) {
    return 0;
  }

  const taskLower = task.toLowerCase();
  const nameLower = projectName.toLowerCase();

  // Exact match (highest priority) - full project name appears in task
  if (taskLower.includes(nameLower)) {
    return 3;
  }

  // Normalized match (medium priority) - hyphens/underscores removed
  const nameNormalized = nameLower.replace(/[-_]/g, "");
  const taskNormalized = taskLower.replace(/[-_]/g, "");
  if (taskNormalized.includes(nameNormalized)) {
    return 2;
  }

  // Partial match (lowest priority) - compound name parts
  const parts = nameLower.split(/[-_]/);
  for (const part of parts) {
    if (part.length > 3 && taskLower.includes(part)) {
      return 1;
    }
  }

  return 0;
}

/**
 * Find all subdirectories that could be projects.
 */
async function findProjectSubdirs(baseWorkspace: string): Promise<string[]> {
  const projects: string[] = [];

  try {
    const entries = await fs.readdir(baseWorkspace, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (entry.name.startsWith(".")) {
        continue;
      }
      if (entry.name === "node_modules") {
        continue;
      }

      const subdir = path.join(baseWorkspace, entry.name);
      projects.push(subdir);
    }
  } catch {
    // Ignore errors
  }

  return projects;
}

/**
 * Verify a directory is a valid project root.
 * Returns paths to AGENTS.md/CLAUDE.md if found.
 */
async function verifyProjectRoot(
  dir: string,
): Promise<{ agentsMd?: string; claudeMd?: string } | null> {
  try {
    await fs.access(dir);
  } catch {
    return null;
  }

  const checks = await Promise.all([
    fileExists(path.join(dir, ".git")),
    fileExists(path.join(dir, "AGENTS.md")),
    fileExists(path.join(dir, "CLAUDE.md")),
    fileExists(path.join(dir, "package.json")),
    fileExists(path.join(dir, "pyproject.toml")),
    fileExists(path.join(dir, "Cargo.toml")),
    fileExists(path.join(dir, "go.mod")),
  ]);

  const [hasGit, hasAgents, hasClaude, hasPackageJson, hasPyproject, hasCargo, hasGoMod] = checks;

  // Must have at least one project indicator
  if (!hasGit && !hasPackageJson && !hasPyproject && !hasCargo && !hasGoMod && !hasAgents) {
    return null;
  }

  return {
    agentsMd: hasAgents ? path.join(dir, "AGENTS.md") : undefined,
    claudeMd: hasClaude ? path.join(dir, "CLAUDE.md") : undefined,
  };
}

async function fileExists(filepath: string): Promise<boolean> {
  try {
    await fs.access(filepath);
    return true;
  } catch {
    return false;
  }
}

async function findGitRoot(startDir: string): Promise<string | undefined> {
  let current = path.resolve(startDir);
  for (let depth = 0; depth < 12; depth += 1) {
    if (await fileExists(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return undefined;
}

/**
 * Load project-specific context files (AGENTS.md, CLAUDE.md).
 */
export async function loadProjectContext(
  result: ProjectDetectionResult,
): Promise<string | undefined> {
  const parts: string[] = [];

  if (result.agentsMd) {
    try {
      const content = await fs.readFile(result.agentsMd, "utf-8");
      parts.push(`### AGENTS.md (Project Instructions)\n${content}`);
    } catch {
      // Ignore
    }
  }

  if (result.claudeMd) {
    try {
      const content = await fs.readFile(result.claudeMd, "utf-8");
      parts.push(`### CLAUDE.md (Project Instructions)\n${content}`);
    } catch {
      // Ignore
    }
  }

  return parts.length > 0 ? parts.join("\n\n---\n\n") : undefined;
}
