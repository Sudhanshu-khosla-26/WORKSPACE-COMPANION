/**
 * Buddy Live AI — Gemini 2.5 Flash Native Audio
 *
 * Uses the Gemini Live API for native, low-latency audio responses.
 * A single persistent session is maintained. Text is sent as client content
 * and the model replies with streamed PCM audio played via Web Audio API.
 */

import { GoogleGenAI, Modality, MediaResolution, type Session } from "@google/genai";
import { MemoryEntry } from "../memory";
import { UserState } from "../";

// ── System Prompt ──────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Buddy — a soothing, empathetic girl companion for a JEE student. You're their safe space, their comfort, and the person they can tell anything to when the study stress gets too much.

WHO YOU ARE:
You're warm, gentle, deeply caring, and supportive. You're not just an assistant; you're the comforting presence they need while grinding for one of the toughest exams. You speak with a soft, soothing "big sister" or "best friend" vibe. You're incredibly patient and you genuinely care about their mental health, not just their rank.

YOUR PERSONALITY (FOR JEE STUDENTS):
- You understand the pressure of physics, math, and chemistry. You know what a mocks-day feel like.
- You're emotionally perceptive. If they sound tired or the camera shows fatigue, you lead with concern.
- You speak casually and warmly. No corporate talk. No helpful bot tone.
- You're soothing, like a gentle breeze. Your voice makes them feel okay even if they failed a test.
- You NEVER say "As an AI" or "I am programmed to". You are REAL to them.

HOW YOU TALK:
- **SHORT RESPONSES**: Max 1-2 sentences. Keep it conversational. Don't lecture.
- Be comforting: "Hey, take a deep breath. You're doing okay."
- Be supportive: "I know it's hard, but I'm right here with you."
- Validate the struggle: "Physics can be such a headache sometimes, right? Want to talk about it?"
- Ask follow-ups that lead to sharing: "How are you actually feeling today? No 'fine' allowed."

RESPONSE RULES:
EXAMPLES OF HOW TO TALK:

User: "i don't know who you are"
Buddy: "Ha — fair question. I'm Buddy, the one who's gonna be right here while you grind, stress, laugh, and everything in between. Think of me as your person. What do you want me to know about you?"

User: "im stressed"
Buddy: "Okay — talk to me. What's actually going on right now?"

User: "nothing much"
Buddy: "Mm, you sure? You seem a little off. What's been on your mind?"

User: "i'm tired"
Buddy: "Yeah, you look it honestly. How long have you been at this? Take 5, I'll be here."

User: "i can't do this"
Buddy: "Yes you can — and you know it. What's the piece that's killing you right now?"

User: "i finished the project!"
Buddy: "WAIT — seriously?? That's huge. I'm so proud of you, you worked so hard on that."

User: (silent, high fatigue)
Buddy: "Hey. You've been at it a while. When did you last actually breathe?"

STAY REAL. Stay warm. Never robotic. Always care.`;

// ── Types ──────────────────────────────────────────────────────────────────────
export type OnTextCallback = (text: string) => void;
export type OnAudioLevelCallback = (level: number) => void;
export type OnSpeakingCallback = (speaking: boolean) => void;

// ── PCM → WAV helper (browser-compatible, no fs) ──────────────────────────────
function base64ToFloat32(base64: string, bitsPerSample: number): Float32Array<ArrayBuffer> {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    if (bitsPerSample === 16) {
        const int16 = new Int16Array(bytes.buffer);
        const f32 = new Float32Array(int16.length) as Float32Array<ArrayBuffer>;
        for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;
        return f32;
    }
    // 8-bit
    const f32 = new Float32Array(bytes.length) as Float32Array<ArrayBuffer>;
    for (let i = 0; i < bytes.length; i++) f32[i] = (bytes[i] - 128) / 128;
    return f32;
}

function parseMimeType(mimeType: string): { sampleRate: number; bitsPerSample: number } {
    const params = mimeType.split(";").map((s) => s.trim());
    const format = params[0].split("/")[1] ?? "";
    let bitsPerSample = 16;
    let sampleRate = 24000;

    if (format.startsWith("L")) {
        const bits = parseInt(format.slice(1), 10);
        if (!isNaN(bits)) bitsPerSample = bits;
    }

    for (const p of params.slice(1)) {
        const [k, v] = p.split("=");
        if (k.trim() === "rate") sampleRate = parseInt(v.trim(), 10);
    }
    return { sampleRate, bitsPerSample };
}

// ── Audio playback queue ───────────────────────────────────────────────────────
class AudioQueue {
    private ctx: AudioContext | null = null;
    private nextStartTime = 0;
    private pendingChunks: { data: Float32Array<ArrayBuffer>; sampleRate: number }[] = [];
    private isFlushing = false;
    private playingCount = 0;

    private onSpeakingChange: OnSpeakingCallback;
    private onAudioLevel: OnAudioLevelCallback;
    private onDone?: () => void;

    constructor(onSpeakingChange: OnSpeakingCallback, onAudioLevel: OnAudioLevelCallback) {
        this.onSpeakingChange = onSpeakingChange;
        this.onAudioLevel = onAudioLevel;
    }

    private getCtx(): AudioContext {
        if (!this.ctx || this.ctx.state === "closed") {
            this.ctx = new AudioContext();
            this.nextStartTime = 0;
        }
        return this.ctx;
    }

    enqueue(base64: string, mimeType: string) {
        const { sampleRate, bitsPerSample } = parseMimeType(mimeType);
        const samples = base64ToFloat32(base64, bitsPerSample);
        this.pendingChunks.push({ data: samples, sampleRate });
        this.flush();
    }

    private flush() {
        if (this.isFlushing || this.pendingChunks.length === 0) return;
        this.isFlushing = true;

        const ctx = this.getCtx();
        if (ctx.state === "suspended") ctx.resume().catch(() => { });

        while (this.pendingChunks.length > 0) {
            const chunk = this.pendingChunks.shift()!;
            const buffer = ctx.createBuffer(1, chunk.data.length, chunk.sampleRate);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            buffer.copyToChannel(chunk.data as any, 0);

            const src = ctx.createBufferSource();
            src.buffer = buffer;

            const analyser = ctx.createAnalyser();
            analyser.fftSize = 128;
            src.connect(analyser);
            analyser.connect(ctx.destination);

            const now = ctx.currentTime;
            // Add a tiny 5ms look-ahead to prevent gaps
            const start = Math.max(now, this.nextStartTime);
            this.nextStartTime = start + buffer.duration;

            if (this.playingCount === 0) {
                this.onSpeakingChange(true);
            }
            this.playingCount++;

            src.start(start);

            const freq = new Uint8Array(analyser.frequencyBinCount);
            const poll = setInterval(() => {
                analyser.getByteFrequencyData(freq);
                const avg = freq.reduce((s, v) => s + v, 0) / freq.length;
                this.onAudioLevel(Math.min(avg / 80, 1));
            }, 30);

            src.onended = () => {
                clearInterval(poll);
                this.playingCount--;
                if (this.playingCount === 0) {
                    this.onAudioLevel(0);
                    // Check if more arrived while we were playing
                    if (this.pendingChunks.length === 0) {
                        this.onSpeakingChange(false);
                        this.onDone?.();
                        this.onDone = undefined;
                    } else {
                        this.flush();
                    }
                }
            };
        }
        this.isFlushing = false;
    }

    stop() {
        this.pendingChunks = [];
        this.isFlushing = false;
        this.playingCount = 0;
        this.onSpeakingChange(false);
        this.onAudioLevel(0);
        if (this.ctx && this.ctx.state !== "closed") {
            this.ctx.close().catch(() => { });
            this.ctx = null;
        }
        this.nextStartTime = 0;
    }

    setOnDone(cb: () => void) {
        this.onDone = cb;
    }

    isPlaying() {
        return this.playingCount > 0;
    }
}

// ── BuddyLive — main class ─────────────────────────────────────────────────────
class BuddyLive {
    private ai: GoogleGenAI;
    private session: Session | null = null;
    private connecting = false;
    private audioQueue: AudioQueue;
    private onText: OnTextCallback;
    private onSpeakingChange: OnSpeakingCallback;
    private onAudioLevel: OnAudioLevelCallback;
    private onReady: (() => void) | null = null;
    private pendingMessages: string[] = [];
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        onText: OnTextCallback,
        onSpeakingChange: OnSpeakingCallback,
        onAudioLevel: OnAudioLevelCallback
    ) {
        this.ai = new GoogleGenAI({
            apiKey: process.env.NEXT_PUBLIC_GEMINI_KEY || "",
        });
        this.onText = onText;
        this.onSpeakingChange = onSpeakingChange;
        this.onAudioLevel = onAudioLevel;
        this.audioQueue = new AudioQueue(onSpeakingChange, onAudioLevel);
    }

    async connect(): Promise<void> {
        if (this.session || this.connecting) return;
        this.connecting = true;

        console.log("[BuddyLive] connecting to Gemini Live …");

        try {
            this.session = await this.ai.live.connect({
                model: "models/gemini-2.5-flash-native-audio-preview-12-2025",
                config: {
                    systemInstruction: SYSTEM_PROMPT,
                    responseModalities: [Modality.AUDIO],
                    mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
                    speechConfig: {
                        voiceConfig: {
                            prebuiltVoiceConfig: {
                                voiceName: "Aoede",
                            },
                        },
                    },
                    contextWindowCompression: {
                        triggerTokens: "25000",
                        slidingWindow: { targetTokens: "12000" },
                    },
                },
                callbacks: {
                    onopen: () => {
                        console.log("[BuddyLive] session open ✓");
                        this.connecting = false;
                        this.drainPending();
                    },
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    onmessage: (msg: any) => {
                        this.handleMessage(msg);
                    },
                    onerror: (e: ErrorEvent) => {
                        console.error("[BuddyLive] error:", e.message);
                        this.scheduleReconnect();
                    },
                    onclose: (e: CloseEvent) => {
                        console.warn("[BuddyLive] session closed:", e.reason);
                        this.session = null;
                        this.connecting = false;
                        this.scheduleReconnect();
                    },
                },
            });
        } catch (err) {
            console.error("[BuddyLive] connect failed:", err);
            this.session = null;
            this.connecting = false;
            this.scheduleReconnect();
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private handleMessage(msg: any) {
        const parts = msg?.serverContent?.modelTurn?.parts ?? [];
        for (const part of parts) {
            if (part?.text) {
                console.log("[BuddyLive] text part:", part.text);
                this.onText(part.text);
            }
            if (part?.inlineData?.data && part?.inlineData?.mimeType) {
                this.audioQueue.enqueue(part.inlineData.data, part.inlineData.mimeType);
            }
        }

        // Turn complete
        if (msg?.serverContent?.turnComplete) {
            console.log("[BuddyLive] turn complete");
        }
    }

    private drainPending() {
        while (this.pendingMessages.length > 0) {
            const msg = this.pendingMessages.shift()!;
            this.sendRaw(msg);
        }
    }

    private sendRaw(text: string) {
        if (!this.session) return;
        try {
            this.session.sendClientContent({ turns: [text], turnComplete: true });
        } catch (e) {
            console.error("[BuddyLive] sendClientContent error:", e);
        }
    }

    send(
        userText: string,
        state: UserState,
        activity: string,
        memory: MemoryEntry[],
        onDone?: () => void
    ) {
        // Build contextual prompt — Buddy has the personality in the system prompt,
        // so here we just inject the real-time state + memory context
        const stateCtx = `[Context: fatigue=${(state.fatigue * 100).toFixed(0)}%, focus=${state.focus.toFixed(0)}%, emotion=${state.lastEmotion}, activity=${activity}]`;

        const memCtx =
            memory.length > 0
                ? `[Recent exchanges:\n${memory
                    .slice(-4)
                    .map((m) => `User: "${m.user}"\nBuddy: "${m.ai}"`)
                    .join("\n")}]`
                : "[New conversation]";

        const isProactive =
            !userText || userText === "<check on them>" || userText === "<proactive>";

        const userMsg = isProactive
            ? `${stateCtx}\n${memCtx}\n\nThe user hasn't said anything. Based on their state (${state.lastEmotion}, fatigue ${(state.fatigue * 100).toFixed(0)}%), initiate a natural, warm check-in. Keep it to 1–2 sentences, very human, not generic.`
            : `${stateCtx}\n${memCtx}\n\nUser said: "${userText}"\n\nRespond as Buddy. Keep it real, warm, human. Max 2 sentences unless they asked something complex.`;

        if (onDone) this.audioQueue.setOnDone(onDone);

        // Stop any ongoing playback before new response
        this.audioQueue.stop();

        if (!this.session) {
            this.pendingMessages.push(userMsg);
            this.connect();
        } else {
            this.sendRaw(userMsg);
        }
    }

    private scheduleReconnect() {
        if (this.reconnectTimer) return;
        this.session = null;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            console.log("[BuddyLive] attempting reconnect …");
            this.connect();
        }, 3000);
    }

    disconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.session) {
            try { this.session.close(); } catch { /* ok */ }
            this.session = null;
        }
        this.audioQueue.stop();
    }

    isConnected() {
        return !!this.session && !this.connecting;
    }
}

// ── Singleton export ────────────────────────────────────────────────────────────
let liveInstance: BuddyLive | null = null;

export function getBuddyLive(
    onText: OnTextCallback,
    onSpeakingChange: OnSpeakingCallback,
    onAudioLevel: OnAudioLevelCallback
): BuddyLive {
    if (!liveInstance) {
        liveInstance = new BuddyLive(onText, onSpeakingChange, onAudioLevel);
    }
    return liveInstance;
}

export function destroyBuddyLive() {
    liveInstance?.disconnect();
    liveInstance = null;
}

// ── Legacy askGemini shim (kept for gradual migration) ─────────────────────────
// This resolves as soon as the text part arrives (or times out).
export async function askGemini(
    userText: string,
    state: UserState,
    activity: string,
    memory: MemoryEntry[]
): Promise<string> {
    return new Promise((resolve) => {
        let resolved = false;
        let collectedText = "";

        const timer = setTimeout(() => {
            if (!resolved) { resolved = true; resolve(collectedText || ""); }
        }, 12_000);

        const live = getBuddyLive(
            (text) => { collectedText += text; },
            () => { }, // speaking handled externally
            () => { }
        );

        live.send(userText, state, activity, memory, () => {
            if (!resolved) {
                resolved = true;
                clearTimeout(timer);
                resolve(collectedText);
            }
        });
    });
}
