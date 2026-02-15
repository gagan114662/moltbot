import type { Editor } from "tldraw";
import { useEffect, useRef } from "react";
import { AI_SEQUENCES } from "../canvas/ai-drawing-sequences";
import { matchConversation } from "./conversation-engine";

interface Opts {
  editor: Editor | null;
  transcript: string;
  speak: (text: string) => Promise<void>;
  onPortalWorldReady: (world: string) => void;
}

export function useConversationLoop({ editor, transcript, speak, onPortalWorldReady }: Opts) {
  const lastProcessed = useRef("");
  const processing = useRef(false);

  useEffect(() => {
    if (!editor || !transcript || transcript === lastProcessed.current || processing.current) {
      return;
    }

    const newContent = transcript.slice(lastProcessed.current.length).trim();
    if (newContent.length < 3) {
      return;
    }

    lastProcessed.current = transcript;
    processing.current = true;

    void (async () => {
      try {
        const response = matchConversation(newContent);

        // 1. Start speaking (fire-and-forget — don't block drawing)
        void speak(response.speech);

        // 2. Handle drawing
        if (response.drawingSequence === "__clear__") {
          const allShapeIds = editor.getCurrentPageShapeIds();
          editor.deleteShapes([...allShapeIds]);
        } else if (response.drawingSequence && AI_SEQUENCES[response.drawingSequence]) {
          const bounds = editor.getViewportScreenBounds();
          const center = editor.screenToPage({
            x: bounds.w / 2,
            y: bounds.h / 2,
          });
          const seq = AI_SEQUENCES[response.drawingSequence];
          if (seq) {
            await seq(editor, center);
          }
        }

        // 3. Follow-up speech (fire-and-forget)
        if (response.followUp) {
          void speak(response.followUp);
        }

        // 4. Signal portal world
        if (response.portalWorld) {
          onPortalWorldReady(response.portalWorld);
        }
      } finally {
        processing.current = false;
      }
    })();
  }, [editor, transcript, speak, onPortalWorldReady]);
}
