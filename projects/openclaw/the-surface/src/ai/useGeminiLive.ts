import type { Editor } from "tldraw";
import { useCallback, useEffect, useRef, useState } from "react";
import { AudioCapture, AudioPlayback } from "../audio/audio-handler";
import { GeminiSession, type FunctionCall } from "./gemini-session";
import { SURFACE_SYSTEM_PROMPT } from "./surface-prompt";
import { executeTool, FUNCTION_DECLARATIONS } from "./surface-tools";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

interface UseGeminiLiveOpts {
  editor: Editor | null;
  onPortalWorldReady: (world: string) => void;
}

/* ------------------------------------------------------------------ */
/* Hook                                                                */
/* ------------------------------------------------------------------ */

export function useGeminiLive({ editor, onPortalWorldReady }: UseGeminiLiveOpts) {
  const [connectionState, setConnectionState] = useState<ConnectionState>("disconnected");
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isListening, setIsListening] = useState(false);

  const sessionRef = useRef<GeminiSession | null>(null);
  const captureRef = useRef<AudioCapture | null>(null);
  const playbackRef = useRef<AudioPlayback | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const onPortalRef = useRef(onPortalWorldReady);

  // Keep refs current without re-triggering effects
  editorRef.current = editor;
  onPortalRef.current = onPortalWorldReady;

  /* ---------------------------------------------------------------- */
  /* Viewport helper                                                   */
  /* ---------------------------------------------------------------- */

  const getViewportCenter = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) {
      return { x: 0, y: 0 };
    }
    const bounds = ed.getViewportScreenBounds();
    return ed.screenToPage({ x: bounds.w / 2, y: bounds.h / 2 });
  }, []);

  /* ---------------------------------------------------------------- */
  /* Tool call handler                                                 */
  /* ---------------------------------------------------------------- */

  const handleToolCalls = useCallback(
    (calls: FunctionCall[]) => {
      const ed = editorRef.current;
      if (!ed) {
        return;
      }

      const center = getViewportCenter();
      const responses: { id: string; name: string; output: unknown }[] = [];

      for (const call of calls) {
        const result = executeTool(ed, call.name, call.args, center);
        responses.push({
          id: call.id,
          name: call.name,
          output: { success: true, shapesCreated: result.shapeIds.length },
        });

        if (result.portalWorld) {
          onPortalRef.current(result.portalWorld);
        }
      }

      // Send tool responses back to Gemini so it can continue drawing
      sessionRef.current?.sendToolResponse(responses);
    },
    [getViewportCenter],
  );

  /* ---------------------------------------------------------------- */
  /* Connect to Gemini                                                 */
  /* ---------------------------------------------------------------- */

  const connect = useCallback(() => {
    // Don't re-connect if already connected
    if (sessionRef.current?.isReady) {
      return;
    }

    const apiKey = import.meta.env.VITE_GEMINI_API_KEY as string | undefined;
    if (!apiKey) {
      setConnectionState("error");
      return;
    }

    setConnectionState("connecting");

    // Audio playback for Gemini's voice
    const playback = new AudioPlayback();
    playbackRef.current = playback;

    const session = new GeminiSession({
      apiKey,
      systemPrompt: SURFACE_SYSTEM_PROMPT,
      tools: FUNCTION_DECLARATIONS,
      voiceName: "Kore",
      callbacks: {
        onReady: () => {
          setConnectionState("connected");
        },
        onAudio: (base64) => {
          setIsSpeaking(true);
          playback.enqueue(base64);
        },
        onText: () => {
          // Text is secondary to audio — we primarily use voice
        },
        onToolCall: (calls) => {
          handleToolCalls(calls);
        },
        onTurnComplete: () => {
          setIsSpeaking(false);
        },
        onInterrupted: () => {
          setIsSpeaking(false);
          playback.stop();
        },
        onError: (error) => {
          console.error("[GeminiSession]", error.message);
          setConnectionState("error");
        },
        onClose: () => {
          setConnectionState("disconnected");
          setIsListening(false);
          setIsSpeaking(false);
        },
      },
    });

    sessionRef.current = session;
    session.connect();

    // Resume AudioContext (Chrome blocks until user gesture)
    void playback.resume();
  }, [handleToolCalls]);

  /* ---------------------------------------------------------------- */
  /* Mic control                                                       */
  /* ---------------------------------------------------------------- */

  const startListening = useCallback(async () => {
    // Connect first if needed
    connect();

    const capture = new AudioCapture();
    capture.onData = (base64) => {
      sessionRef.current?.sendAudio(base64);
    };
    await capture.start();
    captureRef.current = capture;
    setIsListening(true);
  }, [connect]);

  const stopListening = useCallback(() => {
    captureRef.current?.stop();
    captureRef.current = null;
    setIsListening(false);
  }, []);

  /* ---------------------------------------------------------------- */
  /* Text input                                                        */
  /* ---------------------------------------------------------------- */

  const sendText = useCallback(
    (text: string) => {
      // Connect first if needed
      connect();

      // If already ready, send immediately
      if (sessionRef.current?.isReady) {
        sessionRef.current.sendText(text);
        return;
      }

      // Otherwise wait for ready, then send
      const interval = setInterval(() => {
        if (sessionRef.current?.isReady) {
          clearInterval(interval);
          sessionRef.current.sendText(text);
        }
      }, 100);

      // Give up after 10 seconds
      setTimeout(() => clearInterval(interval), 10_000);
    },
    [connect],
  );

  /* ---------------------------------------------------------------- */
  /* Disconnect                                                        */
  /* ---------------------------------------------------------------- */

  const disconnect = useCallback(() => {
    captureRef.current?.stop();
    captureRef.current = null;
    playbackRef.current?.close();
    playbackRef.current = null;
    sessionRef.current?.disconnect();
    sessionRef.current = null;
    setConnectionState("disconnected");
    setIsListening(false);
    setIsSpeaking(false);
  }, []);

  /* ---------------------------------------------------------------- */
  /* Cleanup on unmount                                                */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    return () => {
      captureRef.current?.stop();
      playbackRef.current?.close();
      sessionRef.current?.disconnect();
    };
  }, []);

  return {
    connectionState,
    isListening,
    isSpeaking,
    startListening,
    stopListening,
    sendText,
    disconnect,
  };
}
