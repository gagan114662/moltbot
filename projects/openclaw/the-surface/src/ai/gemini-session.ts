/**
 * Raw WebSocket client for the Gemini Live (BidiGenerateContent) API.
 *
 * Uses the WebSocket protocol directly instead of the @google/genai SDK
 * to avoid Node.js dependencies and ensure browser compatibility.
 *
 * Includes auto-reconnect with context replay for the flaky native audio
 * models that crash with 1011/1008 every 10-20 seconds.
 */

const WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/** Codes that trigger auto-reconnect (Gemini server instability). */
const RECONNECTABLE_CODES = new Set([1011, 1008]);

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface FunctionCall {
  name: string;
  args: Record<string, unknown>;
  id: string;
}

export interface GeminiSessionCallbacks {
  onReady: () => void;
  onAudio: (base64: string) => void;
  onText: (text: string) => void;
  onToolCall: (calls: FunctionCall[]) => void;
  onTurnComplete: () => void;
  onInterrupted: () => void;
  onError: (error: Error) => void;
  onClose: () => void;
}

export interface GeminiSessionConfig {
  apiKey: string;
  model?: string;
  systemPrompt: string;
  tools: unknown[];
  voiceName?: string;
  callbacks: GeminiSessionCallbacks;
}

/* ------------------------------------------------------------------ */
/* Session                                                             */
/* ------------------------------------------------------------------ */

export class GeminiSession {
  private ws: WebSocket | null = null;
  private callbacks: GeminiSessionCallbacks;
  private ready = false;
  private intentionalClose = false;

  // Auto-reconnect state
  private connectAttempt = 0;
  private static MAX_RETRIES = 5;
  private static RETRY_DELAY_MS = 800;

  // Context replay — re-send the last user text after reconnect
  private lastUserText: string | null = null;
  private pendingReplay = false;

  constructor(private config: GeminiSessionConfig) {
    this.callbacks = config.callbacks;
  }

  /** Open the WebSocket and send the setup message. */
  connect(): void {
    this.intentionalClose = false;
    const url = `${WS_BASE}?key=${this.config.apiKey}`;
    this.ws = new WebSocket(url);

    this.ws.addEventListener("open", () => {
      this.sendSetup();
    });

    this.ws.addEventListener("message", (event: MessageEvent) => {
      // Native audio models send binary (Blob) frames; older models send text.
      const raw = event.data;
      if (raw instanceof Blob) {
        raw
          .text()
          .then((text) => {
            const msg = JSON.parse(text) as Record<string, unknown>;
            this.handleMessage(msg);
          })
          .catch((e) => {
            this.callbacks.onError(new Error(`Failed to parse server Blob: ${String(e)}`));
          });
      } else {
        try {
          const msg = JSON.parse(raw as string) as Record<string, unknown>;
          this.handleMessage(msg);
        } catch (e) {
          this.callbacks.onError(new Error(`Failed to parse server message: ${String(e)}`));
        }
      }
    });

    this.ws.addEventListener("error", () => {
      this.callbacks.onError(new Error("WebSocket connection error"));
    });

    this.ws.addEventListener("close", (event: CloseEvent) => {
      this.ready = false;
      if (this.intentionalClose) {
        return;
      }

      // Auto-reconnect on Gemini server instability (1011, 1008)
      if (RECONNECTABLE_CODES.has(event.code) && this.connectAttempt < GeminiSession.MAX_RETRIES) {
        this.connectAttempt++;
        this.pendingReplay = this.lastUserText !== null;
        console.warn(
          `[GeminiSession] ${event.code} on attempt ${this.connectAttempt}/${GeminiSession.MAX_RETRIES}, reconnecting...`,
        );
        setTimeout(() => this.connect(), GeminiSession.RETRY_DELAY_MS);
        return;
      }

      if (event.code !== 1000) {
        this.callbacks.onError(
          new Error(`WebSocket closed: code=${event.code} reason=${event.reason}`),
        );
      }
      this.callbacks.onClose();
    });
  }

  /* ---------------------------------------------------------------- */
  /* Setup                                                             */
  /* ---------------------------------------------------------------- */

  private sendSetup(): void {
    const model = this.config.model ?? "gemini-2.5-flash-native-audio-latest";
    this.send({
      setup: {
        model: `models/${model}`,
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: this.config.voiceName ?? "Kore",
              },
            },
          },
        },
        systemInstruction: {
          parts: [{ text: this.config.systemPrompt }],
        },
        tools: [{ functionDeclarations: this.config.tools }],
        // Enable input audio transcription (config must be empty object)
        inputAudioTranscription: {},
      },
    });
  }

  /* ---------------------------------------------------------------- */
  /* Message handling                                                   */
  /* ---------------------------------------------------------------- */

  private handleMessage(msg: Record<string, unknown>): void {
    // 1. Setup complete
    if ("setupComplete" in msg) {
      this.ready = true;
      this.connectAttempt = 0; // Reset retry counter on success
      this.callbacks.onReady();

      // Replay last user text after reconnect so model has context
      if (this.pendingReplay && this.lastUserText) {
        this.pendingReplay = false;
        console.info("[GeminiSession] Replaying last user text after reconnect");
        this.sendText(this.lastUserText);
      }
      return;
    }

    // 2. Tool call
    if ("toolCall" in msg) {
      const tc = msg.toolCall as { functionCalls?: unknown[] };
      if (tc.functionCalls?.length) {
        this.callbacks.onToolCall(tc.functionCalls as FunctionCall[]);
      }
      return;
    }

    // 3. Server content (audio, text, turn complete, interrupted)
    if ("serverContent" in msg) {
      const sc = msg.serverContent as Record<string, unknown>;

      if (sc.turnComplete) {
        this.callbacks.onTurnComplete();
        return;
      }

      if (sc.interrupted) {
        this.callbacks.onInterrupted();
        return;
      }

      const modelTurn = sc.modelTurn as { parts?: unknown[] } | undefined;
      if (modelTurn?.parts) {
        for (const part of modelTurn.parts) {
          const p = part as Record<string, unknown>;

          // Audio
          if (p.inlineData) {
            const inline = p.inlineData as { data?: string };
            if (inline.data) {
              this.callbacks.onAudio(inline.data);
            }
          }

          // Text
          if (typeof p.text === "string") {
            this.callbacks.onText(p.text);
          }
        }
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Client → Server messages                                          */
  /* ---------------------------------------------------------------- */

  /** Stream a chunk of 16kHz PCM audio (base64-encoded). */
  sendAudio(base64: string): void {
    if (!this.ready) {
      return;
    }
    this.send({
      realtimeInput: {
        mediaChunks: [{ data: base64, mimeType: "audio/pcm;rate=16000" }],
      },
    });
  }

  /** Send a text message (for typed input). */
  sendText(text: string): void {
    // Track for context replay on reconnect
    this.lastUserText = text;

    if (!this.ready) {
      return;
    }
    this.send({
      clientContent: {
        turns: [{ role: "user", parts: [{ text }] }],
        turnComplete: true,
      },
    });
  }

  /**
   * Send tool execution results back to Gemini.
   *
   * Uses the standard `toolResponse` format.
   */
  sendToolResponse(responses: { id: string; name: string; output: unknown }[]): void {
    if (!this.ready) {
      return;
    }
    this.send({
      toolResponse: {
        functionResponses: responses.map((r) => ({
          id: r.id,
          name: r.name,
          response: r.output,
        })),
      },
    });
  }

  /* ---------------------------------------------------------------- */
  /* Utilities                                                         */
  /* ---------------------------------------------------------------- */

  private send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  /** Close the WebSocket connection. */
  disconnect(): void {
    this.ready = false;
    this.lastUserText = null;
    this.pendingReplay = false;
    if (this.ws) {
      this.intentionalClose = true;
      this.ws.close();
      this.ws = null;
    }
  }

  get isReady(): boolean {
    return this.ready;
  }
}
