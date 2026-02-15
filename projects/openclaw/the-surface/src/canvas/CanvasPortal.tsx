import type { ReactNode } from "react";
import { motion } from "framer-motion";

interface CanvasPortalProps {
  children: ReactNode;
  onClose: () => void;
}

/**
 * The Mary Poppins moment.
 *
 * A circle on the canvas opens → the canvas falls away →
 * a 3D world fills the screen. Click the edge to return.
 * Just like stepping into a chalk drawing.
 */
export function CanvasPortal({ children, onClose }: CanvasPortalProps) {
  return (
    <motion.div
      className="fixed inset-0 z-40 flex items-center justify-center"
      style={{ backgroundColor: "#0a0a0a" }}
      initial={{ opacity: 0, scale: 0.3, borderRadius: "50%" }}
      animate={{ opacity: 1, scale: 1, borderRadius: "0%" }}
      exit={{ opacity: 0, scale: 0.3, borderRadius: "50%" }}
      transition={{
        duration: 0.6,
        ease: [0.16, 1, 0.3, 1], // custom ease-out
      }}
    >
      {/* The 3D world */}
      <div className="w-full h-full">{children}</div>

      {/* Return button — subtle, bottom center */}
      <motion.button
        onClick={onClose}
        className="fixed bottom-8 left-1/2 -translate-x-1/2 z-50 px-6 py-2 rounded-full text-white/60 hover:text-white/90 transition-colors cursor-pointer"
        style={{
          fontSize: "var(--text-sm)",
          fontFamily: "Inter, sans-serif",
          fontWeight: 400,
          backgroundColor: "rgba(255, 255, 255, 0.08)",
          backdropFilter: "blur(8px)",
        }}
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.8, duration: 0.4 }}
      >
        return to canvas
      </motion.button>
    </motion.div>
  );
}
