import type { Editor } from "tldraw";
import { useEffect, useRef } from "react";

/**
 * Subtle camera "breathing" when the student is idle.
 * Very gentle zoom oscillation (±0.5%) that starts after 5s of inactivity.
 */
export function useCanvasBreathing(editor: Editor | null, isActive: boolean) {
  const raf = useRef(0);

  useEffect(() => {
    if (!editor || isActive) {
      cancelAnimationFrame(raf.current);
      return;
    }

    let startTime = 0;
    const baseZ = editor.getCamera().z;

    const breathe = (now: number) => {
      if (!startTime) {
        startTime = now;
      }
      const elapsed = (now - startTime) / 1000;
      const scale = 1 + Math.sin(elapsed * 0.4) * 0.004;
      const camera = editor.getCamera();
      editor.setCamera({ x: camera.x, y: camera.y, z: baseZ * scale });
      raf.current = requestAnimationFrame(breathe);
    };

    // Wait 5 seconds of inactivity before starting
    const timeout = setTimeout(() => {
      raf.current = requestAnimationFrame(breathe);
    }, 5000);

    return () => {
      clearTimeout(timeout);
      cancelAnimationFrame(raf.current);
    };
  }, [editor, isActive]);
}
