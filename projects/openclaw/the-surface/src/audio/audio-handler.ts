/* ------------------------------------------------------------------ */
/* Audio capture: Mic → 16kHz 16-bit PCM → base64 chunks              */
/* ------------------------------------------------------------------ */

export class AudioCapture {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;

  /** Called with base64-encoded PCM chunk each time audio is captured. */
  onData: ((base64: string) => void) | null = null;

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: 16000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.audioContext = new AudioContext({ sampleRate: 16000 });
    this.source = this.audioContext.createMediaStreamSource(this.stream);

    // ScriptProcessorNode is deprecated but works in all browsers.
    // AudioWorklet would be the modern replacement.
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);

    this.processor.onaudioprocess = (e: AudioProcessingEvent) => {
      const float32 = e.inputBuffer.getChannelData(0);
      if (!float32) {
        return;
      }
      const int16 = float32ToInt16(float32);
      const base64 = arrayBufferToBase64(int16.buffer as ArrayBuffer);
      this.onData?.(base64);
    };

    this.source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
  }

  stop(): void {
    this.processor?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.audioContext?.close();
    this.stream = null;
    this.audioContext = null;
    this.processor = null;
    this.source = null;
  }
}

/* ------------------------------------------------------------------ */
/* Audio playback: base64 PCM chunks → AudioContext → speakers         */
/* ------------------------------------------------------------------ */

export class AudioPlayback {
  private context: AudioContext;
  private queue: AudioBuffer[] = [];
  private playing = false;
  private nextTime = 0;

  constructor() {
    this.context = new AudioContext({ sampleRate: 24000 });
  }

  /** Enqueue a base64-encoded PCM audio chunk for playback. */
  enqueue(base64: string): void {
    const int16 = base64ToInt16(base64);
    const float32 = int16ToFloat32(int16);

    const buffer = this.context.createBuffer(1, float32.length, 24000);
    buffer.getChannelData(0).set(float32);

    this.queue.push(buffer);
    if (!this.playing) {
      this.flush();
    }
  }

  private flush(): void {
    if (this.queue.length === 0) {
      this.playing = false;
      return;
    }

    this.playing = true;
    const buffer = this.queue.shift()!;
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);

    const now = this.context.currentTime;
    const startTime = Math.max(now, this.nextTime);
    source.start(startTime);
    this.nextTime = startTime + buffer.duration;

    source.addEventListener("ended", () => this.flush());
  }

  /** Stop all playback and clear the queue. */
  stop(): void {
    this.queue = [];
    this.playing = false;
    this.nextTime = 0;
    void this.context.close();
    this.context = new AudioContext({ sampleRate: 24000 });
  }

  /** Resume the AudioContext (Chrome requires a user gesture first). */
  async resume(): Promise<void> {
    if (this.context.state === "suspended") {
      await this.context.resume();
    }
  }

  /** Fully close the AudioContext. */
  close(): void {
    this.queue = [];
    this.playing = false;
    void this.context.close();
  }
}

/* ------------------------------------------------------------------ */
/* PCM conversion utilities                                            */
/* ------------------------------------------------------------------ */

function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]!));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}

function int16ToFloat32(int16: Int16Array): Float32Array {
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i]! / 0x8000;
  }
  return float32;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function base64ToInt16(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer);
}
