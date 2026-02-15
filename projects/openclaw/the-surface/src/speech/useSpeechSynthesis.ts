import { useCallback, useEffect, useRef } from "react";

/**
 * Ensures voices are loaded before first use.
 * Chrome loads voices asynchronously — getVoices() returns [] on first call.
 */
function waitForVoices(): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    const voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) {
      resolve(voices);
      return;
    }
    window.speechSynthesis.addEventListener("voiceschanged", () => {
      resolve(window.speechSynthesis.getVoices());
    });
    setTimeout(() => resolve(window.speechSynthesis.getVoices()), 1000);
  });
}

/**
 * Chrome blocks speechSynthesis.speak() unless it's been "warmed up"
 * by a prior speak call inside a user gesture (click/keypress).
 * Call this once on the first user interaction.
 */
let warmedUp = false;
function warmUp() {
  if (warmedUp) {
    return;
  }
  warmedUp = true;
  const u = new SpeechSynthesisUtterance("");
  u.volume = 0;
  window.speechSynthesis.speak(u);
}

export function useSpeechSynthesis() {
  const voicesRef = useRef<SpeechSynthesisVoice[]>([]);

  useEffect(() => {
    void waitForVoices().then((v) => {
      voicesRef.current = v;
    });

    // Warm up on first user interaction (click or keypress)
    const handler = () => {
      warmUp();
      document.removeEventListener("click", handler);
      document.removeEventListener("keydown", handler);
    };
    document.addEventListener("click", handler);
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("click", handler);
      document.removeEventListener("keydown", handler);
    };
  }, []);

  const speak = useCallback(
    (text: string, opts?: { rate?: number; pitch?: number }): Promise<void> => {
      return new Promise<void>((resolve) => {
        // Cancel previous, then wait a tick — Chrome can cancel the new
        // utterance too if speak() follows cancel() synchronously.
        window.speechSynthesis.cancel();

        setTimeout(() => {
          const utterance = new SpeechSynthesisUtterance(text);
          utterance.rate = opts?.rate ?? 0.95;
          utterance.pitch = opts?.pitch ?? 1.0;

          const voices =
            voicesRef.current.length > 0 ? voicesRef.current : window.speechSynthesis.getVoices();
          const preferred = voices.find(
            (v) => v.name.includes("Samantha") || v.name.includes("Google UK English Female"),
          );
          if (preferred) {
            utterance.voice = preferred;
          }

          utterance.onend = () => resolve();
          utterance.addEventListener("error", () => resolve());
          window.speechSynthesis.speak(utterance);

          // Chrome bug: onend sometimes doesn't fire for long utterances
          // when the tab loses focus. Also, some utterances silently fail.
          // Force-resolve after 5s to prevent the conversation loop from
          // hanging forever.
          setTimeout(() => resolve(), 5_000);
        }, 50);
      });
    },
    [],
  );

  const stop = useCallback(() => {
    window.speechSynthesis.cancel();
  }, []);

  return { speak, stop };
}
