import type { Editor } from "tldraw";
import { useCallback } from "react";
import { Tldraw } from "tldraw";
import "tldraw/tldraw.css";
import { useEditorContext } from "./EditorContext";

/**
 * The canvas — tldraw stripped to its essence.
 *
 * No toolbars. No menus. No panels.
 * Just an infinite warm-white surface the student can draw on.
 * The AI also draws here — real tldraw shapes, not overlays.
 */
export function SurfaceCanvas() {
  const { setEditor } = useEditorContext();

  const handleMount = useCallback(
    (editor: Editor) => {
      setEditor(editor);
      editor.setCurrentTool("draw");
    },
    [setEditor],
  );

  return (
    <div className="absolute inset-0">
      <Tldraw hideUi inferDarkMode={false} onMount={handleMount} />
      {/* Override tldraw's default white background */}
      <style>{`
        .tl-background { background: var(--surface) !important; }
        .tl-canvas { cursor: crosshair !important; }
      `}</style>
    </div>
  );
}
