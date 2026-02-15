import { motion } from "framer-motion";

interface MicPulseProps {
  active: boolean;
  onClick: () => void;
}

/**
 * The one piece of chrome on The Surface.
 *
 * A small circle, bottom-right. Gentle sine-wave pulse when idle.
 * Solid blue when listening. No label. No tooltip. Just presence.
 */
export function MicPulse({ active, onClick }: MicPulseProps) {
  return (
    <motion.button
      onClick={onClick}
      className="fixed bottom-8 right-8 z-50 flex items-center justify-center rounded-full outline-none focus:outline-none cursor-pointer"
      style={{ width: 48, height: 48 }}
      aria-label={active ? "Stop listening" : "Start listening"}
      whileHover={{ scale: 1.1 }}
      whileTap={{ scale: 0.95 }}
    >
      {/* Outer pulse ring — visible when idle */}
      <motion.div
        className="absolute rounded-full"
        style={{
          width: 48,
          height: 48,
          backgroundColor: "var(--accent-pulse)",
        }}
        animate={
          active
            ? { scale: [1, 1.4, 1], opacity: [0.4, 0.1, 0.4] }
            : { scale: [1, 1.15, 1], opacity: [0.3, 0.15, 0.3] }
        }
        transition={{
          duration: active ? 1.2 : 2,
          repeat: Infinity,
          ease: "easeInOut",
        }}
      />

      {/* Inner circle */}
      <motion.div
        className="relative rounded-full"
        style={{ width: 20, height: 20 }}
        animate={{
          backgroundColor: active ? "var(--accent)" : "var(--accent-pulse)",
        }}
        transition={{ duration: 0.3 }}
      />
    </motion.button>
  );
}
