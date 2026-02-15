import type { Editor } from "tldraw";
import { useEffect } from "react";

/**
 * Double-click an ellipse shape on the canvas → trigger portal.
 * Detects AI-placed portal shapes (ID contains "portal-") or
 * student-drawn circles that are roughly square (w ≈ h).
 */
export function usePortalDetection(
  editor: Editor | null,
  onPortalTriggered: (world: string) => void,
) {
  useEffect(() => {
    if (!editor) {
      return;
    }

    const handleDblClick = () => {
      const selected = editor.getSelectedShapes();
      for (const shape of selected) {
        if (shape.type !== "geo" || !("geo" in shape.props)) {
          continue;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const props = shape.props as any;
        if (props.geo !== "ellipse") {
          continue;
        }

        // AI-placed portal shapes have deterministic IDs like "shape:portal-solar-system"
        const id = shape.id as string;
        if (id.includes("portal-solar-system")) {
          onPortalTriggered("solar-system");
          return;
        }
        if (id.includes("portal-cell")) {
          onPortalTriggered("cell");
          return;
        }

        // Student-drawn circle: roughly circular and large enough
        if (props.w > 60 && props.h > 60 && Math.abs(props.w - props.h) < 40) {
          onPortalTriggered("solar-system");
          return;
        }
      }
    };

    const container = document.querySelector(".tl-canvas");
    container?.addEventListener("dblclick", handleDblClick);
    return () => {
      container?.removeEventListener("dblclick", handleDblClick);
    };
  }, [editor, onPortalTriggered]);
}
