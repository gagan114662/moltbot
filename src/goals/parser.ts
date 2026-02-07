/**
 * GOALS.md Parser
 *
 * Parses and serializes the GOALS.md markdown format for the autonomous
 * goal-driven agent system.
 */

import YAML from "yaml";
import type {
  Goal,
  GoalPriority,
  GoalStatus,
  CompletedGoal,
  GoalsFile,
  GoalsFileConfig,
  SuccessCriterion,
  Subtask,
} from "./types.js";

// ============================================
// PARSING
// ============================================

/**
 * Parse a GOALS.md file content into structured data
 */
export function parseGoalsFile(content: string): GoalsFile {
  const sections = splitIntoSections(content);

  const activeGoals = parseGoalsSection(sections["Active Goals"] || "");
  const completedGoals = parseCompletedGoalsSection(sections["Completed Goals"] || "");
  const config = parseConfigSection(sections["Configuration"] || "");

  // Keep raw sections we don't parse
  const rawSections: Record<string, string> = {};
  for (const [name, content] of Object.entries(sections)) {
    if (!["Active Goals", "Completed Goals", "Configuration"].includes(name)) {
      rawSections[name] = content;
    }
  }

  return {
    activeGoals,
    completedGoals,
    config,
    rawSections: Object.keys(rawSections).length > 0 ? rawSections : undefined,
  };
}

/**
 * Split markdown content into sections by ## headers
 */
function splitIntoSections(content: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const lines = content.split("\n");

  let currentSection = "";
  let currentContent: string[] = [];

  for (const line of lines) {
    const sectionMatch = line.match(/^## (.+)$/);
    if (sectionMatch) {
      if (currentSection) {
        sections[currentSection] = currentContent.join("\n").trim();
      }
      currentSection = sectionMatch[1].trim();
      currentContent = [];
    } else if (currentSection) {
      currentContent.push(line);
    }
  }

  // Save last section
  if (currentSection) {
    sections[currentSection] = currentContent.join("\n").trim();
  }

  return sections;
}

/**
 * Parse the Active Goals section
 */
function parseGoalsSection(content: string): Goal[] {
  const goals: Goal[] = [];
  const goalBlocks = splitIntoGoalBlocks(content);

  for (const block of goalBlocks) {
    const goal = parseGoalBlock(block);
    if (goal) {
      goals.push(goal);
    }
  }

  return goals;
}

/**
 * Parse the Completed Goals section
 */
function parseCompletedGoalsSection(content: string): CompletedGoal[] {
  const goals: CompletedGoal[] = [];
  const goalBlocks = splitIntoGoalBlocks(content);

  for (const block of goalBlocks) {
    const goal = parseGoalBlock(block);
    if (goal) {
      goals.push({
        ...goal,
        status: "completed",
        completedAt: goal.lastWorked || new Date().toISOString(),
      } as CompletedGoal);
    }
  }

  return goals;
}

/**
 * Split content into individual goal blocks (### headers)
 */
function splitIntoGoalBlocks(content: string): string[] {
  const blocks: string[] = [];
  const lines = content.split("\n");

  let currentBlock: string[] = [];

  for (const line of lines) {
    if (line.match(/^### /)) {
      if (currentBlock.length > 0) {
        blocks.push(currentBlock.join("\n"));
      }
      currentBlock = [line];
    } else if (currentBlock.length > 0) {
      currentBlock.push(line);
    }
  }

  if (currentBlock.length > 0) {
    blocks.push(currentBlock.join("\n"));
  }

  return blocks;
}

/**
 * Parse a single goal block into a Goal object
 */
function parseGoalBlock(block: string): Goal | null {
  const lines = block.split("\n");
  if (lines.length === 0) return null;

  // Parse header: ### [PRIORITY] Title
  const headerMatch = lines[0].match(/^### \[(\w+)\] (.+)$/);
  if (!headerMatch) return null;

  const priority = headerMatch[1].toUpperCase() as GoalPriority;
  const title = headerMatch[2].trim();

  // Parse metadata fields
  const metadata: Record<string, string> = {};
  const successCriteria: SuccessCriterion[] = [];
  const subtasks: Subtask[] = [];

  let currentList: "success" | "subtasks" | "blocked" | null = null;
  let currentMultilineField: string | null = null;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];

    // Check for metadata field: - **Field:** Value (colon can be inside or outside the bold)
    const fieldMatch = line.match(/^- \*\*([^*:]+):?\*\*:?\s*(.*)$/);
    if (fieldMatch) {
      const fieldName = fieldMatch[1].trim();
      const fieldValue = fieldMatch[2].trim();

      // Handle list fields
      if (fieldName === "Success Criteria") {
        currentList = "success";
        currentMultilineField = null;
        continue;
      } else if (fieldName === "Subtasks") {
        currentList = "subtasks";
        currentMultilineField = null;
        continue;
      } else if (fieldName === "Blocked By") {
        currentList = "blocked";
        currentMultilineField = null;
        if (fieldValue && fieldValue !== "None") {
          metadata.blockedBy = fieldValue;
        }
        continue;
      }

      metadata[fieldName] = fieldValue;
      currentList = null;
      // Context supports multi-line continuation (indented lines following it)
      currentMultilineField = fieldName === "Context" ? "Context" : null;
      continue;
    }

    // Check for multi-line Context continuation (indented lines that aren't checkboxes)
    if (currentMultilineField === "Context" && line.match(/^\s{2,}/) && !line.match(/^\s*- \[/)) {
      const continuation = line.replace(/^\s{2}/, "");
      metadata.Context = metadata.Context ? metadata.Context + "\n" + continuation : continuation;
      continue;
    }

    // Any non-indented, non-field line ends multi-line accumulation
    if (currentMultilineField && !line.match(/^\s{2,}/)) {
      currentMultilineField = null;
    }

    // Check for list items (success criteria or subtasks)
    const checkboxMatch = line.match(/^\s*- \[([ xX])\] (.+)$/);
    if (checkboxMatch && currentList) {
      const completed = checkboxMatch[1].toLowerCase() === "x";
      const text = checkboxMatch[2].trim();

      if (currentList === "success") {
        successCriteria.push({ text, completed });
      } else if (currentList === "subtasks") {
        subtasks.push({ text, completed });
      }
    }
  }

  // Build goal object
  const goal: Goal = {
    id: metadata.ID || generateGoalId(title),
    title,
    priority: isValidPriority(priority) ? priority : "MEDIUM",
    status: parseStatus(metadata.Status),
    progress: parseProgress(metadata.Progress),
    context: metadata.Context || "",
    successCriteria,
    subtasks,
  };

  // Add optional fields
  if (metadata.Deadline) goal.deadline = metadata.Deadline;
  if (metadata["Last Worked"]) goal.lastWorked = metadata["Last Worked"];
  if (metadata.blockedBy) {
    goal.blockedBy = metadata.blockedBy.split(",").map((s) => s.trim());
  }
  if (metadata.Completed) {
    (goal as CompletedGoal).completedAt = metadata.Completed;
  }
  if (metadata.Summary) {
    (goal as CompletedGoal).completionSummary = metadata.Summary;
  }

  return goal;
}

/**
 * Parse the Configuration section (YAML)
 */
function parseConfigSection(content: string): GoalsFileConfig | undefined {
  // Extract YAML from code block
  const yamlMatch = content.match(/```ya?ml\n([\s\S]*?)\n```/);
  if (!yamlMatch) return undefined;

  try {
    const parsed = YAML.parse(yamlMatch[1]) as GoalsFileConfig;
    return parsed;
  } catch {
    return undefined;
  }
}

// ============================================
// SERIALIZATION
// ============================================

/**
 * Serialize a GoalsFile back to GOALS.md format
 */
export function serializeGoalsFile(goals: GoalsFile): string {
  const sections: string[] = [];

  sections.push("# GOALS\n");

  // Active Goals section
  sections.push("## Active Goals\n");
  for (const goal of goals.activeGoals) {
    sections.push(serializeGoal(goal));
  }
  if (goals.activeGoals.length === 0) {
    sections.push("*No active goals.*\n");
  }

  // Completed Goals section
  sections.push("## Completed Goals\n");
  for (const goal of goals.completedGoals) {
    sections.push(serializeCompletedGoal(goal));
  }
  if (goals.completedGoals.length === 0) {
    sections.push("*No completed goals yet.*\n");
  }

  // Configuration section
  if (goals.config) {
    sections.push("## Configuration\n");
    sections.push("```yaml");
    sections.push(YAML.stringify(goals.config, { indent: 2 }).trim());
    sections.push("```\n");
  }

  // Raw sections we preserved
  if (goals.rawSections) {
    for (const [name, content] of Object.entries(goals.rawSections)) {
      sections.push(`## ${name}\n`);
      sections.push(content);
      sections.push("");
    }
  }

  return sections.join("\n");
}

/**
 * Serialize a single active goal
 */
function serializeGoal(goal: Goal): string {
  const lines: string[] = [];

  lines.push(`### [${goal.priority}] ${goal.title}`);
  lines.push(`- **ID:** ${goal.id}`);
  lines.push(`- **Status:** ${goal.status}`);
  lines.push(`- **Progress:** ${goal.progress}%`);

  if (goal.deadline) {
    lines.push(`- **Deadline:** ${goal.deadline}`);
  }

  // Context supports multi-line: first line inline, rest indented by 2 spaces
  if (goal.context.includes("\n")) {
    const contextLines = goal.context.split("\n");
    lines.push(`- **Context:** ${contextLines[0]}`);
    for (let i = 1; i < contextLines.length; i++) {
      lines.push(`  ${contextLines[i]}`);
    }
  } else {
    lines.push(`- **Context:** ${goal.context}`);
  }

  if (goal.successCriteria.length > 0) {
    lines.push(`- **Success Criteria:**`);
    for (const criterion of goal.successCriteria) {
      const mark = criterion.completed ? "x" : " ";
      lines.push(`  - [${mark}] ${criterion.text}`);
    }
  }

  if (goal.subtasks.length > 0) {
    lines.push(`- **Subtasks:**`);
    for (const subtask of goal.subtasks) {
      const mark = subtask.completed ? "x" : " ";
      lines.push(`  - [${mark}] ${subtask.text}`);
    }
  }

  if (goal.blockedBy && goal.blockedBy.length > 0) {
    lines.push(`- **Blocked By:** ${goal.blockedBy.join(", ")}`);
  } else {
    lines.push(`- **Blocked By:** None`);
  }

  if (goal.lastWorked) {
    lines.push(`- **Last Worked:** ${goal.lastWorked}`);
  }

  lines.push("");

  return lines.join("\n");
}

/**
 * Serialize a completed goal
 */
function serializeCompletedGoal(goal: CompletedGoal): string {
  const lines: string[] = [];

  lines.push(`### [DONE] ${goal.title}`);
  lines.push(`- **ID:** ${goal.id}`);
  lines.push(`- **Completed:** ${goal.completedAt}`);

  if (goal.completionSummary) {
    lines.push(`- **Summary:** ${goal.completionSummary}`);
  }

  lines.push("");

  return lines.join("\n");
}

// ============================================
// HELPERS
// ============================================

function isValidPriority(p: string): p is GoalPriority {
  return ["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(p);
}

function parseStatus(status: string | undefined): GoalStatus {
  const normalized = status?.toLowerCase();
  if (normalized === "pending") return "pending";
  if (normalized === "in_progress" || normalized === "in progress") return "in_progress";
  if (normalized === "blocked") return "blocked";
  if (normalized === "completed") return "completed";
  return "pending";
}

function parseProgress(progress: string | undefined): number {
  if (!progress) return 0;
  const match = progress.match(/(\d+)/);
  if (!match) return 0;
  const value = parseInt(match[1], 10);
  return Math.max(0, Math.min(100, value));
}

function generateGoalId(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 20);
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${slug}-${suffix}`;
}

// ============================================
// GOAL MANIPULATION HELPERS
// ============================================

/**
 * Select the next goal to work on based on priority and status
 */
export function selectNextGoal(goals: Goal[]): Goal | null {
  // Filter to workable goals (pending or in_progress, not blocked)
  const workable = goals.filter(
    (g) => (g.status === "pending" || g.status === "in_progress") && !isGoalBlocked(g, goals),
  );

  if (workable.length === 0) return null;

  // Sort by priority (CRITICAL > HIGH > MEDIUM > LOW), then by deadline
  const priorityOrder: Record<GoalPriority, number> = { CRITICAL: -1, HIGH: 0, MEDIUM: 1, LOW: 2 };

  workable.sort((a, b) => {
    // Priority first
    const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (priorityDiff !== 0) return priorityDiff;

    // Then deadline (earlier first)
    if (a.deadline && b.deadline) {
      return new Date(a.deadline).getTime() - new Date(b.deadline).getTime();
    }
    if (a.deadline) return -1;
    if (b.deadline) return 1;

    // Then status (in_progress before pending)
    if (a.status === "in_progress" && b.status !== "in_progress") return -1;
    if (b.status === "in_progress" && a.status !== "in_progress") return 1;

    return 0;
  });

  return workable[0];
}

/**
 * Check if a goal is blocked by other incomplete goals
 */
function isGoalBlocked(goal: Goal, allGoals: Goal[]): boolean {
  if (!goal.blockedBy || goal.blockedBy.length === 0) return false;

  for (const blockerId of goal.blockedBy) {
    const blocker = allGoals.find((g) => g.id === blockerId);
    if (blocker && blocker.status !== "completed") {
      return true;
    }
  }

  return false;
}

/**
 * Update a goal's progress and status
 */
export function updateGoalProgress(
  goalsFile: GoalsFile,
  goalId: string,
  updates: Partial<Goal>,
): GoalsFile {
  const newActiveGoals = goalsFile.activeGoals.map((goal) => {
    if (goal.id !== goalId) return goal;

    const updated = { ...goal, ...updates };

    // Update lastWorked timestamp
    updated.lastWorked = new Date().toISOString();

    return updated;
  });

  // Check if goal was completed and should move to completed list
  let newCompletedGoals = [...goalsFile.completedGoals];
  const updatedGoal = newActiveGoals.find((g) => g.id === goalId);

  if (updatedGoal?.status === "completed") {
    // Remove from active, add to completed
    const completedGoal: CompletedGoal = {
      ...updatedGoal,
      status: "completed",
      completedAt: new Date().toISOString(),
    };
    newCompletedGoals = [completedGoal, ...newCompletedGoals];

    return {
      ...goalsFile,
      activeGoals: newActiveGoals.filter((g) => g.id !== goalId),
      completedGoals: newCompletedGoals,
    };
  }

  return {
    ...goalsFile,
    activeGoals: newActiveGoals,
    completedGoals: newCompletedGoals,
  };
}

/**
 * Mark specific subtasks as completed
 */
export function markSubtasksCompleted(goal: Goal, completedSubtasks: string[]): Goal {
  const updatedSubtasks = goal.subtasks.map((subtask) => {
    if (completedSubtasks.some((s) => subtask.text.includes(s) || s.includes(subtask.text))) {
      return { ...subtask, completed: true };
    }
    return subtask;
  });

  // Recalculate progress based on completed subtasks
  const totalSubtasks = updatedSubtasks.length;
  const completedCount = updatedSubtasks.filter((s) => s.completed).length;
  const newProgress = totalSubtasks > 0 ? Math.round((completedCount / totalSubtasks) * 100) : 0;

  return {
    ...goal,
    subtasks: updatedSubtasks,
    progress: newProgress,
  };
}

/**
 * Check if all success criteria are met
 */
export function areAllCriteriaMet(goal: Goal): boolean {
  if (goal.successCriteria.length === 0) return false;
  return goal.successCriteria.every((c) => c.completed);
}

/**
 * Get the next incomplete subtask
 */
export function getNextSubtask(goal: Goal): Subtask | null {
  return goal.subtasks.find((s) => !s.completed) || null;
}
