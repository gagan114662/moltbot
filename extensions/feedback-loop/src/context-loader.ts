/**
 * Context Loader - Extracts and loads rich context from tasks
 *
 * Implements Claude Code best practices:
 * 1. Reference specific files → READ them before coding
 * 2. Point to example patterns → LOAD and show to coder
 * 3. Describe symptoms with location → FOCUS exploration there
 * 4. Extract constraints → ENFORCE in verification
 *
 * Example transformations:
 * - "fix login bug in src/auth/" → reads all files in src/auth/
 * - "like HotDogWidget.php" → reads HotDogWidget.php as pattern
 * - "avoid mocks" → adds constraint to verification
 */

import fs from "node:fs/promises";
import path from "node:path";

// ============================================
// TYPES
// ============================================

export interface ExtractedContext {
  /** Files explicitly mentioned (@file or path syntax) */
  referencedFiles: FileReference[];
  /** Directories to explore (src/auth/, components/) */
  directoriesToExplore: string[];
  /** Example patterns to follow ("like X", "similar to Y") */
  examplePatterns: PatternReference[];
  /** Constraints mentioned (avoid, without, don't use) */
  constraints: Constraint[];
  /** Symptom description with location */
  symptom?: SymptomDescription;
  /** URLs for documentation */
  documentationUrls: string[];
  /** Image references (screenshots, mockups) */
  images: ImageReference[];
  /** Git history requests */
  gitHistoryRequests: GitHistoryRequest[];
}

export interface FileReference {
  path: string;
  reason: "explicit" | "inferred" | "pattern";
  content?: string;
  error?: string;
}

export interface PatternReference {
  file: string;
  description: string;
  content?: string;
}

export interface Constraint {
  type: "avoid" | "require" | "prefer";
  description: string;
  keywords: string[];
}

export interface SymptomDescription {
  symptom: string;
  location?: string;
  expectedFix?: string;
}

export interface ImageReference {
  path: string;
  type: "screenshot" | "mockup" | "design" | "reference";
}

export interface GitHistoryRequest {
  file: string;
  reason: string;
}

export interface LoadedContext {
  /** Extracted metadata */
  extracted: ExtractedContext;
  /** File contents that were successfully loaded */
  fileContents: Map<string, string>;
  /** Total tokens (estimated) of loaded content */
  estimatedTokens: number;
  /** Formatted prompt section */
  promptSection: string;
}

// ============================================
// EXTRACTION PATTERNS
// ============================================

const PATTERNS = {
  // File references: @file.ts, in src/auth/, path/to/file.js
  fileExplicit: /@([a-zA-Z0-9_\-./]+\.[a-zA-Z]+)/g,
  filePath: /(?:in |at |check |look at |see |read )([a-zA-Z0-9_\-./]+\.[a-zA-Z]+)/gi,
  fileExtension: /\b([a-zA-Z0-9_\-./]+\.(ts|tsx|js|jsx|py|go|rs|vue|svelte|php|rb|java))\b/g,

  // Directories: in src/auth/, under components/
  directory: /(?:in |under |at |check |within )([a-zA-Z0-9_\-./]+\/)/gi,

  // Example patterns: like X, similar to Y, following Z pattern
  examplePattern: /(?:like |similar to |following |same as |pattern (?:of|from|in) )([A-Za-z0-9_\-./]+(?:\.[a-zA-Z]+)?)/gi,

  // Constraints
  avoidConstraint: /(?:avoid|don't use|without|no |never use|skip) ([a-zA-Z0-9_\- ]+?)(?:\.|,|$)/gi,
  requireConstraint: /(?:must use|require|always use|use only) ([a-zA-Z0-9_\- ]+?)(?:\.|,|$)/gi,
  preferConstraint: /(?:prefer|prioritize|favor) ([a-zA-Z0-9_\- ]+?)(?:\.|,|$)/gi,

  // Symptoms with location
  symptomLocation: /(?:fails?|errors?|crashes?|breaks?|bugs?) (?:in |at |when |after |during )([^.]+)/gi,
  expectedFix: /(?:should |fix should |expected |correct behavior:? )([^.]+)/gi,

  // Git history
  gitHistory: /(?:git history|commit history|blame|how .+ came to be) (?:of |for )?([a-zA-Z0-9_\-./]+)/gi,

  // URLs
  url: /(https?:\/\/[^\s]+)/g,

  // Images
  image: /(?:screenshot|image|mockup|design|reference)[:\s]+([a-zA-Z0-9_\-./]+\.(?:png|jpg|jpeg|gif|svg|webp))/gi,
};

// ============================================
// EXTRACTION FUNCTIONS
// ============================================

/**
 * Extract all rich context from a task description
 */
export function extractContext(task: string): ExtractedContext {
  const context: ExtractedContext = {
    referencedFiles: [],
    directoriesToExplore: [],
    examplePatterns: [],
    constraints: [],
    documentationUrls: [],
    images: [],
    gitHistoryRequests: [],
  };

  // Extract file references
  const seenFiles = new Set<string>();

  // @file syntax (highest priority)
  for (const match of task.matchAll(PATTERNS.fileExplicit)) {
    if (!seenFiles.has(match[1])) {
      seenFiles.add(match[1]);
      context.referencedFiles.push({ path: match[1], reason: "explicit" });
    }
  }

  // "in file.ts" / "at path/file.ts" syntax
  for (const match of task.matchAll(PATTERNS.filePath)) {
    if (!seenFiles.has(match[1])) {
      seenFiles.add(match[1]);
      context.referencedFiles.push({ path: match[1], reason: "explicit" });
    }
  }

  // Any file extension mentioned (lower priority)
  for (const match of task.matchAll(PATTERNS.fileExtension)) {
    if (!seenFiles.has(match[1]) && match[1].includes("/")) {
      seenFiles.add(match[1]);
      context.referencedFiles.push({ path: match[1], reason: "inferred" });
    }
  }

  // Extract directories
  const seenDirs = new Set<string>();
  for (const match of task.matchAll(PATTERNS.directory)) {
    const dir = match[1].replace(/\/$/, "");
    if (!seenDirs.has(dir)) {
      seenDirs.add(dir);
      context.directoriesToExplore.push(dir);
    }
  }

  // Extract example patterns
  for (const match of task.matchAll(PATTERNS.examplePattern)) {
    const pattern = match[1];
    // Determine if it's a file or concept
    if (pattern.includes(".") || pattern.includes("/")) {
      context.examplePatterns.push({
        file: pattern,
        description: `Follow pattern from ${pattern}`,
      });
    } else {
      context.examplePatterns.push({
        file: pattern,
        description: `Follow ${pattern} pattern`,
      });
    }
  }

  // Extract constraints
  for (const match of task.matchAll(PATTERNS.avoidConstraint)) {
    context.constraints.push({
      type: "avoid",
      description: `Avoid: ${match[1].trim()}`,
      keywords: match[1].trim().toLowerCase().split(/\s+/),
    });
  }
  for (const match of task.matchAll(PATTERNS.requireConstraint)) {
    context.constraints.push({
      type: "require",
      description: `Required: ${match[1].trim()}`,
      keywords: match[1].trim().toLowerCase().split(/\s+/),
    });
  }
  for (const match of task.matchAll(PATTERNS.preferConstraint)) {
    context.constraints.push({
      type: "prefer",
      description: `Preferred: ${match[1].trim()}`,
      keywords: match[1].trim().toLowerCase().split(/\s+/),
    });
  }

  // Extract symptom description
  const symptomMatch = task.match(PATTERNS.symptomLocation);
  if (symptomMatch) {
    const expectedMatch = task.match(PATTERNS.expectedFix);
    context.symptom = {
      symptom: symptomMatch[0],
      location: symptomMatch[1],
      expectedFix: expectedMatch?.[1],
    };
  }

  // Extract git history requests
  for (const match of task.matchAll(PATTERNS.gitHistory)) {
    context.gitHistoryRequests.push({
      file: match[1],
      reason: "User requested git history analysis",
    });
  }

  // Extract URLs
  for (const match of task.matchAll(PATTERNS.url)) {
    context.documentationUrls.push(match[1]);
  }

  // Extract images
  for (const match of task.matchAll(PATTERNS.image)) {
    context.images.push({
      path: match[1],
      type: task.toLowerCase().includes("screenshot") ? "screenshot"
        : task.toLowerCase().includes("mockup") ? "mockup"
        : task.toLowerCase().includes("design") ? "design"
        : "reference",
    });
  }

  return context;
}

// ============================================
// LOADING FUNCTIONS
// ============================================

/**
 * Load file contents for all referenced files
 */
export async function loadFileContents(
  context: ExtractedContext,
  workspaceDir: string,
  maxTotalChars: number = 50000,
): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  let totalChars = 0;

  // Load explicitly referenced files first (highest priority)
  const explicitFiles = context.referencedFiles.filter(f => f.reason === "explicit");
  for (const file of explicitFiles) {
    if (totalChars >= maxTotalChars) break;
    const content = await loadFile(file.path, workspaceDir);
    if (content) {
      const truncated = truncateContent(content, maxTotalChars - totalChars);
      contents.set(file.path, truncated);
      totalChars += truncated.length;
    }
  }

  // Load example pattern files
  for (const pattern of context.examplePatterns) {
    if (totalChars >= maxTotalChars) break;
    if (pattern.file.includes(".")) {
      const content = await loadFile(pattern.file, workspaceDir);
      if (content) {
        const truncated = truncateContent(content, Math.min(10000, maxTotalChars - totalChars));
        contents.set(pattern.file, truncated);
        totalChars += truncated.length;
      }
    }
  }

  // Load files from directories (if space remains)
  for (const dir of context.directoriesToExplore) {
    if (totalChars >= maxTotalChars * 0.8) break; // Leave some room
    const dirFiles = await listFilesInDir(dir, workspaceDir);
    for (const file of dirFiles.slice(0, 5)) { // Max 5 files per dir
      if (totalChars >= maxTotalChars) break;
      const content = await loadFile(file, workspaceDir);
      if (content) {
        const truncated = truncateContent(content, Math.min(5000, maxTotalChars - totalChars));
        contents.set(file, truncated);
        totalChars += truncated.length;
      }
    }
  }

  // Load inferred files (lowest priority)
  const inferredFiles = context.referencedFiles.filter(f => f.reason === "inferred");
  for (const file of inferredFiles) {
    if (totalChars >= maxTotalChars) break;
    const content = await loadFile(file.path, workspaceDir);
    if (content) {
      const truncated = truncateContent(content, Math.min(5000, maxTotalChars - totalChars));
      contents.set(file.path, truncated);
      totalChars += truncated.length;
    }
  }

  return contents;
}

async function loadFile(filePath: string, workspaceDir: string): Promise<string | null> {
  try {
    // Try relative to workspace first
    const fullPath = path.isAbsolute(filePath) ? filePath : path.join(workspaceDir, filePath);
    const content = await fs.readFile(fullPath, "utf-8");
    return content;
  } catch {
    // Try common variations
    const variations = [
      filePath,
      `src/${filePath}`,
      `lib/${filePath}`,
      `app/${filePath}`,
    ];
    for (const variant of variations) {
      try {
        const content = await fs.readFile(path.join(workspaceDir, variant), "utf-8");
        return content;
      } catch {
        continue;
      }
    }
    return null;
  }
}

async function listFilesInDir(dir: string, workspaceDir: string): Promise<string[]> {
  try {
    const fullPath = path.join(workspaceDir, dir);
    const entries = await fs.readdir(fullPath, { withFileTypes: true });
    return entries
      .filter(e => e.isFile() && /\.(ts|tsx|js|jsx|py|go|rs|vue|svelte|php|rb|java)$/.test(e.name))
      .map(e => path.join(dir, e.name))
      .slice(0, 10);
  } catch {
    return [];
  }
}

function truncateContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const half = Math.floor(maxChars / 2);
  return content.slice(0, half) + "\n\n... [truncated] ...\n\n" + content.slice(-half);
}

// ============================================
// PROMPT BUILDING
// ============================================

/**
 * Load context and build a prompt section
 */
export async function loadAndBuildContext(
  task: string,
  workspaceDir: string,
): Promise<LoadedContext> {
  const extracted = extractContext(task);
  const fileContents = await loadFileContents(extracted, workspaceDir);

  let estimatedTokens = 0;
  for (const content of fileContents.values()) {
    estimatedTokens += Math.ceil(content.length / 4); // Rough token estimate
  }

  const promptSection = buildPromptSection(extracted, fileContents);

  return {
    extracted,
    fileContents,
    estimatedTokens,
    promptSection,
  };
}

function buildPromptSection(
  extracted: ExtractedContext,
  fileContents: Map<string, string>,
): string {
  const sections: string[] = [];

  // Symptom description (if present)
  if (extracted.symptom) {
    sections.push(`## SYMPTOM DESCRIPTION
${extracted.symptom.symptom}
${extracted.symptom.location ? `**Location:** ${extracted.symptom.location}` : ""}
${extracted.symptom.expectedFix ? `**Expected fix:** ${extracted.symptom.expectedFix}` : ""}
`);
  }

  // Constraints (important - show prominently)
  if (extracted.constraints.length > 0) {
    sections.push(`## CONSTRAINTS (MUST FOLLOW)
${extracted.constraints.map(c => `- ${c.description}`).join("\n")}
`);
  }

  // Example patterns to follow
  if (extracted.examplePatterns.length > 0) {
    sections.push(`## EXAMPLE PATTERNS (follow these)
${extracted.examplePatterns.map(p => `- ${p.file}: ${p.description}`).join("\n")}
`);

    // Include pattern file contents
    for (const pattern of extracted.examplePatterns) {
      const content = fileContents.get(pattern.file);
      if (content) {
        sections.push(`### Pattern: ${pattern.file}
\`\`\`
${content.slice(0, 3000)}${content.length > 3000 ? "\n... [truncated]" : ""}
\`\`\`
`);
      }
    }
  }

  // Referenced files
  if (fileContents.size > 0) {
    sections.push(`## REFERENCED FILES (pre-loaded for context)
The following files were mentioned or are relevant to this task:
`);

    for (const [filePath, content] of fileContents) {
      // Skip if already shown as pattern
      if (extracted.examplePatterns.some(p => p.file === filePath)) continue;

      sections.push(`### ${filePath}
\`\`\`
${content.slice(0, 5000)}${content.length > 5000 ? "\n... [truncated]" : ""}
\`\`\`
`);
    }
  }

  // Directories to focus on
  if (extracted.directoriesToExplore.length > 0) {
    sections.push(`## DIRECTORIES TO FOCUS ON
${extracted.directoriesToExplore.map(d => `- ${d}/`).join("\n")}
`);
  }

  // Documentation URLs
  if (extracted.documentationUrls.length > 0) {
    sections.push(`## DOCUMENTATION REFERENCES
${extracted.documentationUrls.map(u => `- ${u}`).join("\n")}
`);
  }

  // Git history requests
  if (extracted.gitHistoryRequests.length > 0) {
    sections.push(`## GIT HISTORY ANALYSIS REQUESTED
${extracted.gitHistoryRequests.map(r => `- ${r.file}: ${r.reason}`).join("\n")}

Run \`git log --oneline --follow ${extracted.gitHistoryRequests.map(r => r.file).join(" ")}\` to see history.
`);
  }

  // Image references
  if (extracted.images.length > 0) {
    sections.push(`## IMAGE REFERENCES
${extracted.images.map(i => `- ${i.path} (${i.type})`).join("\n")}
`);
  }

  return sections.join("\n");
}

/**
 * Get a summary of what was extracted (for logging)
 */
export function getContextSummary(extracted: ExtractedContext): string {
  const parts: string[] = [];

  if (extracted.referencedFiles.length > 0) {
    parts.push(`${extracted.referencedFiles.length} files`);
  }
  if (extracted.directoriesToExplore.length > 0) {
    parts.push(`${extracted.directoriesToExplore.length} directories`);
  }
  if (extracted.examplePatterns.length > 0) {
    parts.push(`${extracted.examplePatterns.length} patterns`);
  }
  if (extracted.constraints.length > 0) {
    parts.push(`${extracted.constraints.length} constraints`);
  }
  if (extracted.symptom) {
    parts.push(`symptom with location`);
  }
  if (extracted.gitHistoryRequests.length > 0) {
    parts.push(`git history request`);
  }

  return parts.length > 0 ? parts.join(", ") : "no rich context";
}
