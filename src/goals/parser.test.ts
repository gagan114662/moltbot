import { describe, it, expect } from "vitest";
import type { Goal, GoalsFile } from "./types.js";
import {
  parseGoalsFile,
  serializeGoalsFile,
  selectNextGoal,
  updateGoalProgress,
  markSubtasksCompleted,
  areAllCriteriaMet,
  getNextSubtask,
} from "./parser.js";

describe("goals/parser", () => {
  describe("parseGoalsFile", () => {
    it("parses a basic GOALS.md file", () => {
      const content = `# GOALS

## Active Goals

### [HIGH] Complete authentication refactor
- **ID:** auth-refactor-001
- **Status:** in_progress
- **Progress:** 60%
- **Context:** Refactor auth module to use OAuth 2.0
- **Success Criteria:**
  - [x] Research OAuth 2.0 patterns
  - [ ] Implement Google OAuth
- **Subtasks:**
  - [x] Set up OAuth library
  - [ ] Configure OAuth provider
- **Blocked By:** None
- **Last Worked:** 2026-02-01T10:00:00Z

## Completed Goals

*No completed goals yet.*
`;

      const result = parseGoalsFile(content);

      expect(result.activeGoals).toHaveLength(1);
      expect(result.activeGoals[0].id).toBe("auth-refactor-001");
      expect(result.activeGoals[0].title).toBe("Complete authentication refactor");
      expect(result.activeGoals[0].priority).toBe("HIGH");
      expect(result.activeGoals[0].status).toBe("in_progress");
      expect(result.activeGoals[0].progress).toBe(60);
      expect(result.activeGoals[0].successCriteria).toHaveLength(2);
      expect(result.activeGoals[0].subtasks).toHaveLength(2);
    });

    it("parses multiple goals", () => {
      const content = `# GOALS

## Active Goals

### [HIGH] Task 1
- **ID:** task-1
- **Status:** pending
- **Progress:** 0%
- **Context:** First task
- **Blocked By:** None

### [MEDIUM] Task 2
- **ID:** task-2
- **Status:** in_progress
- **Progress:** 50%
- **Context:** Second task
- **Blocked By:** task-1

## Completed Goals

*No completed goals yet.*
`;

      const result = parseGoalsFile(content);

      expect(result.activeGoals).toHaveLength(2);
      expect(result.activeGoals[0].id).toBe("task-1");
      expect(result.activeGoals[1].id).toBe("task-2");
      expect(result.activeGoals[1].blockedBy).toContain("task-1");
    });

    it("parses configuration section", () => {
      const content = `# GOALS

## Active Goals

*No active goals.*

## Configuration

\`\`\`yaml
autonomous:
  enabled: true
  workInterval: 30m
  maxWorkDuration: 10m
\`\`\`
`;

      const result = parseGoalsFile(content);

      expect(result.config).toBeDefined();
      expect(result.config?.autonomous.enabled).toBe(true);
      expect(result.config?.autonomous.workInterval).toBe("30m");
    });
  });

  describe("serializeGoalsFile", () => {
    it("serializes back to markdown", () => {
      const goalsFile: GoalsFile = {
        activeGoals: [
          {
            id: "test-goal-001",
            title: "Test Goal",
            priority: "HIGH",
            status: "in_progress",
            progress: 25,
            context: "A test goal",
            successCriteria: [
              { text: "Criterion 1", completed: true },
              { text: "Criterion 2", completed: false },
            ],
            subtasks: [{ text: "Subtask 1", completed: true }],
          },
        ],
        completedGoals: [],
      };

      const result = serializeGoalsFile(goalsFile);

      expect(result).toContain("# GOALS");
      expect(result).toContain("## Active Goals");
      expect(result).toContain("### [HIGH] Test Goal");
      expect(result).toContain("- **ID:** test-goal-001");
      expect(result).toContain("- **Progress:** 25%");
      expect(result).toContain("  - [x] Criterion 1");
      expect(result).toContain("  - [ ] Criterion 2");
    });
  });

  describe("selectNextGoal", () => {
    it("returns null for empty list", () => {
      expect(selectNextGoal([])).toBeNull();
    });

    it("selects highest priority goal", () => {
      const goals: Goal[] = [
        {
          id: "low",
          title: "Low",
          priority: "LOW",
          status: "pending",
          progress: 0,
          context: "",
          successCriteria: [],
          subtasks: [],
        },
        {
          id: "high",
          title: "High",
          priority: "HIGH",
          status: "pending",
          progress: 0,
          context: "",
          successCriteria: [],
          subtasks: [],
        },
        {
          id: "med",
          title: "Medium",
          priority: "MEDIUM",
          status: "pending",
          progress: 0,
          context: "",
          successCriteria: [],
          subtasks: [],
        },
      ];

      const result = selectNextGoal(goals);
      expect(result?.id).toBe("high");
    });

    it("skips blocked goals", () => {
      const goals: Goal[] = [
        {
          id: "high",
          title: "High",
          priority: "HIGH",
          status: "pending",
          progress: 0,
          context: "",
          successCriteria: [],
          subtasks: [],
          blockedBy: ["blocker"],
        },
        {
          id: "blocker",
          title: "Blocker",
          priority: "LOW",
          status: "pending",
          progress: 0,
          context: "",
          successCriteria: [],
          subtasks: [],
        },
      ];

      const result = selectNextGoal(goals);
      expect(result?.id).toBe("blocker");
    });

    it("prefers in_progress over pending", () => {
      const goals: Goal[] = [
        {
          id: "pending",
          title: "Pending",
          priority: "HIGH",
          status: "pending",
          progress: 0,
          context: "",
          successCriteria: [],
          subtasks: [],
        },
        {
          id: "in-progress",
          title: "In Progress",
          priority: "HIGH",
          status: "in_progress",
          progress: 50,
          context: "",
          successCriteria: [],
          subtasks: [],
        },
      ];

      const result = selectNextGoal(goals);
      expect(result?.id).toBe("in-progress");
    });
  });

  describe("updateGoalProgress", () => {
    it("updates goal progress", () => {
      const goalsFile: GoalsFile = {
        activeGoals: [
          {
            id: "goal-1",
            title: "Goal 1",
            priority: "HIGH",
            status: "pending",
            progress: 0,
            context: "",
            successCriteria: [],
            subtasks: [],
          },
        ],
        completedGoals: [],
      };

      const result = updateGoalProgress(goalsFile, "goal-1", {
        progress: 50,
        status: "in_progress",
      });

      expect(result.activeGoals[0].progress).toBe(50);
      expect(result.activeGoals[0].status).toBe("in_progress");
      expect(result.activeGoals[0].lastWorked).toBeDefined();
    });

    it("moves completed goal to completedGoals", () => {
      const goalsFile: GoalsFile = {
        activeGoals: [
          {
            id: "goal-1",
            title: "Goal 1",
            priority: "HIGH",
            status: "in_progress",
            progress: 90,
            context: "",
            successCriteria: [],
            subtasks: [],
          },
        ],
        completedGoals: [],
      };

      const result = updateGoalProgress(goalsFile, "goal-1", {
        status: "completed",
        progress: 100,
      });

      expect(result.activeGoals).toHaveLength(0);
      expect(result.completedGoals).toHaveLength(1);
      expect(result.completedGoals[0].id).toBe("goal-1");
    });
  });

  describe("markSubtasksCompleted", () => {
    it("marks subtasks as completed and recalculates progress", () => {
      const goal: Goal = {
        id: "goal-1",
        title: "Goal 1",
        priority: "HIGH",
        status: "in_progress",
        progress: 0,
        context: "",
        successCriteria: [],
        subtasks: [
          { text: "Subtask 1", completed: false },
          { text: "Subtask 2", completed: false },
          { text: "Subtask 3", completed: false },
          { text: "Subtask 4", completed: false },
        ],
      };

      const result = markSubtasksCompleted(goal, ["Subtask 1", "Subtask 2"]);

      expect(result.subtasks[0].completed).toBe(true);
      expect(result.subtasks[1].completed).toBe(true);
      expect(result.subtasks[2].completed).toBe(false);
      expect(result.progress).toBe(50);
    });
  });

  describe("areAllCriteriaMet", () => {
    it("returns false for empty criteria", () => {
      const goal: Goal = {
        id: "goal-1",
        title: "Goal",
        priority: "HIGH",
        status: "pending",
        progress: 0,
        context: "",
        successCriteria: [],
        subtasks: [],
      };
      expect(areAllCriteriaMet(goal)).toBe(false);
    });

    it("returns true when all criteria are completed", () => {
      const goal: Goal = {
        id: "goal-1",
        title: "Goal",
        priority: "HIGH",
        status: "pending",
        progress: 0,
        context: "",
        successCriteria: [
          { text: "Crit 1", completed: true },
          { text: "Crit 2", completed: true },
        ],
        subtasks: [],
      };
      expect(areAllCriteriaMet(goal)).toBe(true);
    });

    it("returns false when not all criteria are completed", () => {
      const goal: Goal = {
        id: "goal-1",
        title: "Goal",
        priority: "HIGH",
        status: "pending",
        progress: 0,
        context: "",
        successCriteria: [
          { text: "Crit 1", completed: true },
          { text: "Crit 2", completed: false },
        ],
        subtasks: [],
      };
      expect(areAllCriteriaMet(goal)).toBe(false);
    });
  });

  describe("getNextSubtask", () => {
    it("returns null for no subtasks", () => {
      const goal: Goal = {
        id: "goal-1",
        title: "Goal",
        priority: "HIGH",
        status: "pending",
        progress: 0,
        context: "",
        successCriteria: [],
        subtasks: [],
      };
      expect(getNextSubtask(goal)).toBeNull();
    });

    it("returns first incomplete subtask", () => {
      const goal: Goal = {
        id: "goal-1",
        title: "Goal",
        priority: "HIGH",
        status: "pending",
        progress: 0,
        context: "",
        successCriteria: [],
        subtasks: [
          { text: "Done", completed: true },
          { text: "Next", completed: false },
          { text: "Later", completed: false },
        ],
      };
      const result = getNextSubtask(goal);
      expect(result?.text).toBe("Next");
    });
  });
});
