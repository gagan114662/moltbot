import type { Editor, TLShapeId } from "tldraw";
import { createShapeId, toRichText } from "tldraw";

/* ------------------------------------------------------------------ */
/* Tool declarations for Gemini function calling                       */
/* Keep schemas FLAT and SIMPLE — complex schemas cause hallucinated   */
/* or malformed function calls on native audio models.                 */
/* ------------------------------------------------------------------ */

export const FUNCTION_DECLARATIONS = [
  {
    name: "write_text",
    description:
      "Write text on the canvas. Use for labels, titles, explanations, equations, numbers, and any written content.",
    parameters: {
      type: "OBJECT",
      properties: {
        text: { type: "STRING", description: "The text to display" },
        x: { type: "NUMBER", description: "X position. -500 left, 0 center, 500 right" },
        y: { type: "NUMBER", description: "Y position. -350 top, 0 center, 350 bottom" },
        size: { type: "STRING", description: "Text size: s, m, l, or xl" },
        color: {
          type: "STRING",
          description: "Color: black, blue, red, green, violet, orange, grey",
        },
      },
    },
  },
  {
    name: "draw_shape",
    description:
      "Draw a rectangle or circle on the canvas. Use for diagrams, containers, entities.",
    parameters: {
      type: "OBJECT",
      properties: {
        shape: { type: "STRING", description: "Shape type: rectangle or circle" },
        x: { type: "NUMBER", description: "Center X position" },
        y: { type: "NUMBER", description: "Center Y position" },
        width: { type: "NUMBER", description: "Width in pixels, 10 to 800" },
        height: { type: "NUMBER", description: "Height in pixels, 10 to 600" },
        color: {
          type: "STRING",
          description: "Color: black, blue, red, green, violet, orange, grey",
        },
        fill: { type: "STRING", description: "Fill style: none, semi, or solid" },
      },
    },
  },
  {
    name: "draw_arrow",
    description: "Draw an arrow from one point to another. Use for relationships, flow, pointing.",
    parameters: {
      type: "OBJECT",
      properties: {
        fromX: { type: "NUMBER", description: "Arrow start X" },
        fromY: { type: "NUMBER", description: "Arrow start Y" },
        toX: { type: "NUMBER", description: "Arrow end X (where the arrowhead points)" },
        toY: { type: "NUMBER", description: "Arrow end Y" },
        color: { type: "STRING", description: "Color: black, blue, red, green" },
      },
    },
  },
  {
    name: "create_portal",
    description:
      "Create a glowing portal circle on the canvas. The student can double-click it to enter a 3D world.",
    parameters: {
      type: "OBJECT",
      properties: {
        world: { type: "STRING", description: "Which 3D world: solar-system or cell" },
        x: { type: "NUMBER", description: "Portal center X" },
        y: { type: "NUMBER", description: "Portal center Y" },
        label: { type: "STRING", description: "Text label shown below the portal" },
      },
    },
  },
  {
    name: "clear_canvas",
    description: "Erase everything on the canvas to start fresh.",
    parameters: {
      type: "OBJECT",
      properties: {},
    },
  },
];

/* ------------------------------------------------------------------ */
/* Validation helpers                                                  */
/* ------------------------------------------------------------------ */

const VALID_COLORS = new Set([
  "black",
  "blue",
  "red",
  "green",
  "violet",
  "orange",
  "grey",
  "light-blue",
  "light-green",
  "light-red",
  "light-violet",
  "yellow",
]);
const VALID_SIZES = new Set(["s", "m", "l", "xl"]);
const VALID_FILLS = new Set(["none", "semi", "solid"]);

function validColor(c: unknown): string {
  return typeof c === "string" && VALID_COLORS.has(c) ? c : "black";
}

function validSize(s: unknown): string {
  return typeof s === "string" && VALID_SIZES.has(s) ? s : "m";
}

function validFill(f: unknown): string {
  return typeof f === "string" && VALID_FILLS.has(f) ? f : "none";
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/* ------------------------------------------------------------------ */
/* Tool executor — takes a Gemini function call and draws on tldraw    */
/* ------------------------------------------------------------------ */

export interface ToolCallResult {
  shapeIds: TLShapeId[];
  portalWorld?: string;
}

/**
 * Execute a single tool call from Gemini and draw on the tldraw canvas.
 *
 * @param editor - The tldraw editor instance
 * @param toolName - Name of the tool to execute
 * @param args - Arguments from Gemini's function call
 * @param viewportCenter - Current viewport center in page coordinates
 */
export function executeTool(
  editor: Editor,
  toolName: string,
  args: Record<string, unknown>,
  viewportCenter: { x: number; y: number },
): ToolCallResult {
  const ids: TLShapeId[] = [];

  // Virtual coords → page coords. (0,0) maps to viewport center.
  const toPage = (vx: number, vy: number) => ({
    x: viewportCenter.x + vx,
    y: viewportCenter.y + vy,
  });

  switch (toolName) {
    case "write_text": {
      const pos = toPage(num(args.x, 0), num(args.y, 0));
      const id = createShapeId();
      editor.createShape({
        id,
        type: "text",
        x: pos.x,
        y: pos.y,
        props: {
          richText: toRichText(typeof args.text === "string" ? args.text : ""),
          size: validSize(args.size),
          font: "sans",
          color: validColor(args.color),
        },
      });
      ids.push(id);
      break;
    }

    case "draw_shape": {
      const w = clamp(num(args.width, 100), 10, 800);
      const h = clamp(num(args.height, 100), 10, 600);
      // Args specify center, tldraw uses top-left origin
      const pos = toPage(num(args.x, 0) - w / 2, num(args.y, 0) - h / 2);
      const id = createShapeId();
      editor.createShape({
        id,
        type: "geo",
        x: pos.x,
        y: pos.y,
        props: {
          w,
          h,
          geo: String(args.shape) === "circle" ? "ellipse" : "rectangle",
          fill: validFill(args.fill),
          color: validColor(args.color),
        },
      });
      ids.push(id);
      break;
    }

    case "draw_arrow": {
      const from = toPage(num(args.fromX, 0), num(args.fromY, 0));
      const to = toPage(num(args.toX, 100), num(args.toY, 0));
      const id = createShapeId();
      editor.createShape({
        id,
        type: "arrow",
        x: from.x,
        y: from.y,
        props: {
          start: { x: 0, y: 0 },
          end: { x: to.x - from.x, y: to.y - from.y },
          color: validColor(args.color),
        },
      });
      ids.push(id);
      break;
    }

    case "create_portal": {
      const world = args.world === "cell" ? "cell" : "solar-system";
      const pos = toPage(num(args.x, 0) - 80, num(args.y, 0) - 80);
      const portalId = createShapeId(`portal-${world}`);
      editor.createShape({
        id: portalId,
        type: "geo",
        x: pos.x,
        y: pos.y,
        props: {
          w: 160,
          h: 160,
          geo: "ellipse",
          fill: "solid",
          color: world === "cell" ? "green" : "blue",
        },
      });
      ids.push(portalId);

      const labelId = createShapeId();
      editor.createShape({
        id: labelId,
        type: "text",
        x: pos.x - 15,
        y: pos.y + 170,
        props: {
          richText: toRichText(
            typeof args.label === "string" ? args.label : "Double-click to explore",
          ),
          size: "s",
          font: "sans",
          color: "grey",
        },
      });
      ids.push(labelId);

      return { shapeIds: ids, portalWorld: world };
    }

    case "clear_canvas": {
      const allIds = editor.getCurrentPageShapeIds();
      editor.deleteShapes([...allIds]);
      break;
    }
  }

  return { shapeIds: ids };
}
