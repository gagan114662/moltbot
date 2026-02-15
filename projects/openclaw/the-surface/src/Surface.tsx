import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useRef, useState } from "react";
import { useGeminiLive, type ConnectionState } from "./ai/useGeminiLive";
import { CanvasPortal } from "./canvas/CanvasPortal";
import { EditorProvider, useEditorContext } from "./canvas/EditorContext";
import { SurfaceCanvas } from "./canvas/SurfaceCanvas";
import { useCanvasBreathing } from "./canvas/useCanvasBreathing";
import { usePortalDetection } from "./canvas/usePortalDetection";
import { MicPulse } from "./mic/MicPulse";
import { CellWorld } from "./worlds/CellWorld";
import { SolarSystem } from "./worlds/SolarSystem";

/**
 * The Surface — one component, one surface, one conversation.
 *
 * Speak → the AI listens via Gemini Live, draws on the canvas, and speaks back.
 * Type → same thing, for when speech isn't available.
 * Draw a circle → double-click to enter a 3D world.
 */
function SurfaceInner() {
  const [portalOpen, setPortalOpen] = useState(false);
  const [portalWorld, setPortalWorld] = useState<string>("solar-system");
  const [hasInteracted, setHasInteracted] = useState(false);

  const { editor } = useEditorContext();

  // --- Gemini Live API ---
  const { connectionState, isListening, isSpeaking, startListening, stopListening, sendText } =
    useGeminiLive({
      editor,
      onPortalWorldReady: (world) => setPortalWorld(world),
    });

  // --- Portal from canvas shapes ---
  usePortalDetection(
    editor,
    useCallback((world: string) => {
      setPortalWorld(world);
      setPortalOpen(true);
    }, []),
  );

  // --- Canvas breathing ---
  useCanvasBreathing(editor, isListening || hasInteracted);

  // --- Handlers ---
  const handleMicToggle = useCallback(() => {
    setHasInteracted(true);
    if (isListening) {
      stopListening();
    } else {
      void startListening();
    }
  }, [isListening, startListening, stopListening]);

  const handleTextSubmit = useCallback(
    (text: string) => {
      setHasInteracted(true);
      sendText(text);
    },
    [sendText],
  );

  const handlePortalClose = useCallback(() => {
    setPortalOpen(false);
  }, []);

  const WorldComponent = portalWorld === "cell" ? CellWorld : SolarSystem;

  return (
    <div className="relative w-full h-full overflow-hidden bg-[var(--surface)]">
      <SurfaceCanvas />

      {/* Idle greeting */}
      {!hasInteracted && !isListening && <IdleGreeting onMicClick={handleMicToggle} />}

      {/* Connection status */}
      <ConnectionIndicator state={connectionState} />

      {/* Speaking indicator */}
      <AnimatePresence>
        {isSpeaking && (
          <motion.div
            className="fixed top-6 left-1/2 z-50 flex items-center gap-2 px-4 py-2 rounded-full"
            style={{
              backgroundColor: "var(--accent-glow)",
              color: "var(--accent)",
              transform: "translateX(-50%)",
            }}
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
          >
            <SpeakingDots />
            <span className="text-xs font-medium select-none">Speaking...</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 3D portal */}
      <AnimatePresence>
        {portalOpen && (
          <CanvasPortal onClose={handlePortalClose}>
            <WorldComponent />
          </CanvasPortal>
        )}
      </AnimatePresence>

      {/* Text input — bottom-left, always available */}
      <TextInput onSubmit={handleTextSubmit} disabled={connectionState === "connecting"} />

      {/* Listening indicator */}
      {isListening && (
        <motion.div
          className="fixed bottom-20 right-8 z-50 text-xs text-[var(--accent)] select-none"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
        >
          listening...
        </motion.div>
      )}

      {/* The only chrome — mic pulse */}
      <MicPulse active={isListening} onClick={handleMicToggle} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Connection Indicator                                                */
/* ------------------------------------------------------------------ */

function ConnectionIndicator({ state }: { state: ConnectionState }) {
  if (state === "disconnected") {
    return null;
  }

  const dot: Record<ConnectionState, string> = {
    disconnected: "transparent",
    connecting: "var(--ink-soft)",
    connected: "#22c55e",
    error: "#ef4444",
  };

  const label: Record<ConnectionState, string> = {
    disconnected: "",
    connecting: "Connecting...",
    connected: "Connected",
    error: "Connection failed",
  };

  return (
    <motion.div
      className="fixed top-4 right-4 z-50 flex items-center gap-2 text-xs select-none"
      initial={{ opacity: 0 }}
      animate={{ opacity: state === "connected" ? 0.4 : 1 }}
      transition={{ delay: state === "connected" ? 2 : 0, duration: 0.5 }}
    >
      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: dot[state] }} />
      <span style={{ color: dot[state] }}>{label[state]}</span>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* Speaking dots animation                                             */
/* ------------------------------------------------------------------ */

function SpeakingDots() {
  return (
    <div className="flex gap-1">
      {[0, 1, 2].map((i) => (
        <motion.div
          key={i}
          className="w-1.5 h-1.5 rounded-full bg-current"
          animate={{ scale: [1, 1.5, 1], opacity: [0.5, 1, 0.5] }}
          transition={{
            duration: 0.8,
            repeat: Infinity,
            delay: i * 0.15,
          }}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Idle Greeting                                                       */
/* ------------------------------------------------------------------ */

function IdleGreeting({ onMicClick }: { onMicClick: () => void }) {
  return (
    <motion.div
      className="absolute inset-0 z-20 flex flex-col items-center justify-center pointer-events-none"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.8, delay: 1.5 }}
    >
      <motion.p
        className="text-[var(--ink-soft)] text-2xl font-light select-none"
        style={{ fontFamily: "Inter, sans-serif" }}
      >
        What&apos;s on your mind?
      </motion.p>
      <motion.p
        className="text-[var(--ink-soft)] text-sm mt-3 opacity-50 select-none"
        initial={{ opacity: 0 }}
        animate={{ opacity: 0.5 }}
        transition={{ delay: 2.5 }}
      >
        Click the mic and speak — or type below
      </motion.p>
      <motion.button
        className="mt-6 px-5 py-2 rounded-full text-sm pointer-events-auto cursor-pointer"
        style={{ backgroundColor: "var(--accent-glow)", color: "var(--accent)" }}
        onClick={onMicClick}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 3 }}
      >
        Start talking
      </motion.button>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* Text Input — fallback / alternative to speech                       */
/* ------------------------------------------------------------------ */

function TextInput({
  onSubmit,
  disabled,
}: {
  onSubmit: (text: string) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = value.trim();
    if (text && !disabled) {
      onSubmit(text);
      setValue("");
    }
  };

  return (
    <form onSubmit={handleSubmit} className="fixed bottom-8 left-8 z-50 flex items-center gap-2">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={disabled ? "Connecting..." : "Ask me anything..."}
        disabled={disabled}
        className="w-72 px-4 py-2 rounded-full text-sm outline-none"
        style={{
          backgroundColor: "var(--accent-glow)",
          color: "var(--ink)",
          border: "1px solid transparent",
          fontFamily: "Inter, sans-serif",
          opacity: disabled ? 0.5 : 1,
        }}
        onFocus={(e) => {
          e.currentTarget.style.borderColor = "var(--accent)";
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = "transparent";
        }}
      />
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Root                                                                */
/* ------------------------------------------------------------------ */

export function Surface() {
  return (
    <EditorProvider>
      <SurfaceInner />
    </EditorProvider>
  );
}
