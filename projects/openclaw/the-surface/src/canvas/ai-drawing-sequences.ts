import type { Editor, TLShapeId } from "tldraw";
import { createShapeId, toRichText } from "tldraw";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type AiDrawingSequence = (
  editor: Editor,
  center: { x: number; y: number },
) => Promise<TLShapeId[]>;

/* ------------------------------------------------------------------ */
/* Fractions: 1/2 and 1/3 side by side                                */
/* ------------------------------------------------------------------ */
export const drawFractions: AiDrawingSequence = async (editor, center) => {
  const ids: TLShapeId[] = [];

  // --- 1/2 (left side) ---
  const bar1 = createShapeId();
  editor.createShape({
    id: bar1,
    type: "geo",
    x: center.x - 250,
    y: center.y - 4,
    props: { w: 180, h: 8, geo: "rectangle", fill: "solid", color: "black" },
  });
  ids.push(bar1);
  await delay(500);

  const num1 = createShapeId();
  editor.createShape({
    id: num1,
    type: "text",
    x: center.x - 180,
    y: center.y - 55,
    props: { richText: toRichText("1"), size: "xl", font: "sans" },
  });
  ids.push(num1);
  await delay(350);

  const den1 = createShapeId();
  editor.createShape({
    id: den1,
    type: "text",
    x: center.x - 180,
    y: center.y + 15,
    props: { richText: toRichText("2"), size: "xl", font: "sans" },
  });
  ids.push(den1);
  await delay(500);

  // Visual bar — outline
  const viz1Out = createShapeId();
  editor.createShape({
    id: viz1Out,
    type: "geo",
    x: center.x - 250,
    y: center.y + 70,
    props: {
      w: 180,
      h: 28,
      geo: "rectangle",
      fill: "none",
      color: "grey",
    },
  });
  ids.push(viz1Out);
  await delay(300);

  // Visual bar — filled half
  const viz1Fill = createShapeId();
  editor.createShape({
    id: viz1Fill,
    type: "geo",
    x: center.x - 250,
    y: center.y + 70,
    props: {
      w: 90,
      h: 28,
      geo: "rectangle",
      fill: "solid",
      color: "blue",
    },
  });
  ids.push(viz1Fill);
  await delay(700);

  // --- 1/3 (right side) ---
  const bar2 = createShapeId();
  editor.createShape({
    id: bar2,
    type: "geo",
    x: center.x + 50,
    y: center.y - 4,
    props: { w: 180, h: 8, geo: "rectangle", fill: "solid", color: "black" },
  });
  ids.push(bar2);
  await delay(500);

  const num2 = createShapeId();
  editor.createShape({
    id: num2,
    type: "text",
    x: center.x + 120,
    y: center.y - 55,
    props: { richText: toRichText("1"), size: "xl", font: "sans" },
  });
  ids.push(num2);
  await delay(350);

  const den2 = createShapeId();
  editor.createShape({
    id: den2,
    type: "text",
    x: center.x + 120,
    y: center.y + 15,
    props: { richText: toRichText("3"), size: "xl", font: "sans" },
  });
  ids.push(den2);
  await delay(500);

  // Visual bar — outline
  const viz2Out = createShapeId();
  editor.createShape({
    id: viz2Out,
    type: "geo",
    x: center.x + 50,
    y: center.y + 70,
    props: {
      w: 180,
      h: 28,
      geo: "rectangle",
      fill: "none",
      color: "grey",
    },
  });
  ids.push(viz2Out);
  await delay(300);

  // Visual bar — filled third
  const viz2Fill = createShapeId();
  editor.createShape({
    id: viz2Fill,
    type: "geo",
    x: center.x + 50,
    y: center.y + 70,
    props: {
      w: 60,
      h: 28,
      geo: "rectangle",
      fill: "solid",
      color: "blue",
    },
  });
  ids.push(viz2Fill);

  return ids;
};

/* ------------------------------------------------------------------ */
/* Solar system sketch — a portal circle                              */
/* ------------------------------------------------------------------ */
export const drawSolarSystemSketch: AiDrawingSequence = async (editor, center) => {
  const ids: TLShapeId[] = [];

  const circleId = createShapeId("portal-solar-system");
  editor.createShape({
    id: circleId,
    type: "geo",
    x: center.x - 80,
    y: center.y - 80,
    props: {
      w: 160,
      h: 160,
      geo: "ellipse",
      fill: "solid",
      color: "blue",
    },
  });
  ids.push(circleId);
  await delay(400);

  const label = createShapeId();
  editor.createShape({
    id: label,
    type: "text",
    x: center.x - 55,
    y: center.y + 90,
    props: {
      richText: toRichText("Double-click to explore"),
      size: "s",
      font: "sans",
      color: "grey",
    },
  });
  ids.push(label);

  return ids;
};

/* ------------------------------------------------------------------ */
/* Cell sketch — a portal circle for biology                          */
/* ------------------------------------------------------------------ */
export const drawCellSketch: AiDrawingSequence = async (editor, center) => {
  const ids: TLShapeId[] = [];

  // Cell membrane (outer ellipse)
  const membrane = createShapeId("portal-cell");
  editor.createShape({
    id: membrane,
    type: "geo",
    x: center.x - 100,
    y: center.y - 70,
    props: {
      w: 200,
      h: 140,
      geo: "ellipse",
      fill: "semi",
      color: "green",
    },
  });
  ids.push(membrane);
  await delay(400);

  // Nucleus
  const nucleus = createShapeId();
  editor.createShape({
    id: nucleus,
    type: "geo",
    x: center.x - 30,
    y: center.y - 25,
    props: {
      w: 60,
      h: 50,
      geo: "ellipse",
      fill: "solid",
      color: "violet",
    },
  });
  ids.push(nucleus);
  await delay(300);

  // Label
  const label = createShapeId();
  editor.createShape({
    id: label,
    type: "text",
    x: center.x - 55,
    y: center.y + 80,
    props: {
      richText: toRichText("Double-click to go inside"),
      size: "s",
      font: "sans",
      color: "grey",
    },
  });
  ids.push(label);

  return ids;
};

/* ------------------------------------------------------------------ */
/* Registry                                                           */
/* ------------------------------------------------------------------ */
export const AI_SEQUENCES: Record<string, AiDrawingSequence> = {
  fractions: drawFractions,
  "solar-system": drawSolarSystemSketch,
  cell: drawCellSketch,
};
