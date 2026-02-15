import { useCallback, useEffect, useRef, useState } from "react";

/* ------------------------------------------------------------------ */
/* Web Speech API types (not in TS lib.dom by default)                */
/* ------------------------------------------------------------------ */
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionErrorEvent extends Event {
  error: string;
}

interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

function createSR(): SpeechRecognitionInstance | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Ctor = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
  if (!Ctor) {
    return null;
  }
  return new Ctor() as SpeechRecognitionInstance;
}

/* ------------------------------------------------------------------ */
/* Hook                                                               */
/* ------------------------------------------------------------------ */
export interface SpeechState {
  isListening: boolean;
  transcript: string;
  interimTranscript: string;
  isSupported: boolean;
  error: string | null;
}

export function useSpeechRecognition() {
  const [state, setState] = useState<SpeechState>({
    isListening: false,
    transcript: "",
    interimTranscript: "",
    isSupported:
      typeof window !== "undefined" &&
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      !!((window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition),
    error: null,
  });

  const srRef = useRef<SpeechRecognitionInstance | null>(null);
  const wantListening = useRef(false);

  const startListening = useCallback(() => {
    const sr = createSR();
    if (!sr) {
      setState((s) => ({ ...s, error: "Speech recognition not supported" }));
      return;
    }

    sr.continuous = true;
    sr.interimResults = true;
    sr.lang = "en-US";

    sr.onstart = () => {
      setState((s) => ({ ...s, isListening: true, error: null }));
    };

    sr.onresult = (event) => {
      let final = "";
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res?.[0]) {
          if (res.isFinal) {
            final += res[0].transcript;
          } else {
            interim += res[0].transcript;
          }
        }
      }
      setState((s) => ({
        ...s,
        transcript: s.transcript + final,
        interimTranscript: interim,
      }));
    };

    sr.addEventListener("error", (event) => {
      // "aborted" fires when we call stop() — not a real error
      const err = (event as unknown as SpeechRecognitionErrorEvent).error;
      if (err === "aborted") {
        return;
      }
      setState((s) => ({ ...s, error: err, isListening: false }));
    });

    sr.onend = () => {
      setState((s) => ({ ...s, isListening: false, interimTranscript: "" }));
      // Chrome auto-stops after ~60s of silence — restart if we still want to listen
      if (wantListening.current) {
        setTimeout(() => {
          if (wantListening.current) {
            startListening();
          }
        }, 200);
      }
    };

    srRef.current = sr;
    wantListening.current = true;
    sr.start();
  }, []);

  const stopListening = useCallback(() => {
    wantListening.current = false;
    srRef.current?.stop();
    srRef.current = null;
  }, []);

  const resetTranscript = useCallback(() => {
    setState((s) => ({ ...s, transcript: "", interimTranscript: "" }));
  }, []);

  useEffect(() => {
    return () => {
      wantListening.current = false;
      srRef.current?.abort();
    };
  }, []);

  return { ...state, startListening, stopListening, resetTranscript };
}
