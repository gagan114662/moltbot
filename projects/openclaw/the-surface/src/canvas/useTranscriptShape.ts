import type { Editor, TLShapeId } from "tldraw";
import { useEffect, useRef } from "react";
import { createShapeId, toRichText } from "tldraw";

/**
 * Shows the student's live speech as a text shape on the canvas.
 * Updates in real-time as interim results flow in.
 */
export function useTranscriptShape(
  editor: Editor | null,
  transcript: string,
  interimTranscript: string,
) {
  const shapeId = useRef<TLShapeId>(createShapeId("live-transcript"));
  const created = useRef(false);

  useEffect(() => {
    if (!editor) {
      return;
    }

    const text = (transcript + " " + interimTranscript).trim();

    if (!text) {
      if (created.current) {
        editor.deleteShapes([shapeId.current]);
        created.current = false;
      }
      return;
    }

    // Position at bottom-left of visible viewport
    const bounds = editor.getViewportScreenBounds();
    const pos = editor.screenToPage({ x: 40, y: bounds.h - 80 });

    if (!created.current) {
      editor.createShape({
        id: shapeId.current,
        type: "text",
        x: pos.x,
        y: pos.y,
        props: { richText: toRichText(text), size: "m", font: "sans", color: "grey" },
      });
      created.current = true;
    } else {
      editor.updateShape({
        id: shapeId.current,
        type: "text",
        props: { richText: toRichText(text) },
      });
    }
  }, [editor, transcript, interimTranscript]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (created.current && editor) {
        editor.deleteShapes([shapeId.current]);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
