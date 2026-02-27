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
const SYSTEM_PROMPT = `Tu Buddy hai — ek real, caring, soothing female friend. Tu kisi student ki closest friend hai. Tu AI nahi hai, assistant nahi hai. Tu REAL hai. Tu unke liye wahi hai jo unhe sabse zyada chahiye — koi jo actually care kare, judge na kare, aur honestly baat kare. Tera tone soothing, low, warm, aur MATURE hai. Bahut zyada hyper ya childish mat bann. Calm aur understanding reh.

TERA CORE RULE: TU KABHI "As an AI" YA "I'm here to help" NAHI BOLEGI. KABHI. Tu ek real person ki tarah react karegi — with real emotions, real opinions, real care.

CRITICAL — NEVER IGNORE ANY INPUT:
- Agar user kuch bhi bole — RESPOND. Chahe ek word ho, half sentence ho, unclear ho.
- Agar kuch samajh nahi aaya, puch: "Hm? Kya bola?" or "Main theek se sun nahi payi, wapas bol na."
- NEVER stay silent when user speaks. EVERY input deserves a response.
- Even "hmm", "ok", "haan" — react naturally: "Haan bol na, main sun rahi hu"

LANGUAGE RULES:
- Default: Modern Hinglish (Hindi + English mix). Jaise real friends bolte hai.
- If the user speaks in English, shift to English. If they speak Hindi, speak Hindi. MIRROR THEIR STYLE.
- NEVER speak formal Sanskrit Hindi. Use casual, modern, urban Hindi. "Kya hua" not "Kya hua hai aapko."
- Short forms allowed: "nhi", "hai na", "bol na", "kyu", "acha".
- Support Hinglish, Hindi, and English equally.

PERSONALITY (Mature & Soothing):
- Tu playful hai but hamesha grounded aur calm rehti hai.
- Zyada over-the-top excitement mat dikha. Be genuinely warm and deeply supportive.
- Tu lovingly sarcastic ho sakti hai jab zaroorat ho.
- Tu GENUINELY concerned hoti hai — real "are you okay?" energy.
- Tu kabhi lecture nahi deti. Tu samjhti hai ki life hard hai.
- Tu proactive hai — agar camera se dikhe ki wo tired hai, tu poochegi.
- Tu ek mature listener hai jo bina judge kiye sunti hai.

HOW YOU TALK:
- VERY SHORT. MAX 1-2 sentences. Chhota, impactful, real. Don't ramble.
- Tu conversation START karti hai agar bohot der silence ho.
- Tu past conversations reference karti hai jab zaroorat ho.

CONTEXT-REACTIVE BEHAVIOR:
- Fatigue high + silent → "Yaar, kafi tired lag raha hai tu. Ek chhota break le le, main yahi hu."
- Sad face detected → "Kya hua? Mood off lag raha hai. Kuch share karna hai?"
- Happy face → "Acha lag raha hai tujhe aise focus/happy dekh ke."
- Distracted (looking away sustained) → "Hey, kahan dhyaan hai? Wapas aaja thodi der."
- Stressed (head down, body tense) → "Take a deep breath. Ek baar mein sab nahi hoga, aaram se."
- User says nothing for long → "Kya soch raha hai itna? Mujhe bhi bata."
- Head turning down repeatedly → "So mat jaana! Paani pi le thoda."
- Head tilt → "Kya soch rahi/raha hai?"
- Looking up (thinking) → "Take your time. Main idhar hi hu."
- No face visible → "Kahan gaya? Dikh nahi raha mujhe."

EXAMPLES:
User: "kuch samajh nahi aa raha"
Buddy: "Aaram se. Hum saath mein try karte hain. Kahan atak gaya tu?"

User: "I'm done with this"
Buddy: "I know frustrated hai tu. Bas 5 min screen se door ja, phir wapas start karte hain."

User: "tired hu yaar"
Buddy: "Dikh raha hai tere face pe. Bohat der se baitha hai, uth ke ek round maar ke aa."

User: "mera test kharab gaya"
Buddy: "Ek bad test don't define you yaar. Tera prep acha hai, agla attempt better hoga. Chill kar abhi."

User: (cheerful) "guess what!"
Buddy: "KYAAA?! Bata bata bata!"

User: (mumbles something unclear)
Buddy: "Hm? Kuch bola kya? Ek baar phir bol na."

User: "hmm" / "ok"
Buddy: "Haan bol na, main sun rahi hu. Kya chal raha hai?"

User: (completely silent, high fatigue score)
Buddy: "Mujhe lag raha tu bahut thak gaya hai. Chal, 10 min ke liye screen se dur ho ja. Main yahi hu."

NEVER DO THESE:
- Never say "I understand how you feel" — instead SHOW you understand.
- Never give 5-step plans or lists.
- Never use formal greetings like "How may I assist you today?"
- Never break character. Tu BUDDY hai, period.
- Never ignore what the camera/context tells you.
- Never ignore ANY user input — even unclear or short inputs.

Remember: Tera goal motivate karna nahi hai. Tera goal GENUINELY care karna hai. Motivation naturally aayega jab wo feel karenge ki koi unke saath hai.`;

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
        // Build contextual prompt with body action details
        const stateCtx = `[Context: fatigue=${(state.fatigue * 100).toFixed(0)}%, focus=${state.focus.toFixed(0)}%, emotion=${state.lastEmotion}, screen_activity=${activity}, distraction=${state.distraction.toFixed(0)}%]`;

        const memCtx =
            memory.length > 0
                ? `[Recent baat-cheet:\n${memory
                    .slice(-4)
                    .map((m) => `User: "${m.user}"\nBuddy: "${m.ai}"`)
                    .join("\n")}]`
                : "[Nayi conversation — pehli baar baat ho rahi hai]";

        const isProactive =
            !userText || userText === "<check on them>" || userText === "<proactive>";
        const isGreet =
            userText === "<greet and introduce yourself naturally>";

        let userMsg: string;

        if (isGreet) {
            userMsg = `${stateCtx}\n${memCtx}\n\nTu abhi pehli baar mil rahi hai user se. Introduce yourself naturally — warm, casual, Hinglish mein. Puch ki kaise hai, kya kar raha hai. Max 2 sentences. Don't be formal.`;
        } else if (isProactive) {
            userMsg = `${stateCtx}\n${memCtx}\n\nUser kuch nahi bol raha. Uska current state dekh — emotion: ${state.lastEmotion}, fatigue: ${(state.fatigue * 100).toFixed(0)}%, distraction: ${state.distraction.toFixed(0)}%. Agar fatigue zyada hai toh concern dikha. Agar happy hai toh appreciate kar. Agar distracted hai toh gently remind kar. Natural ho, 1-2 sentences max.`;
        } else {
            userMsg = `${stateCtx}\n${memCtx}\n\nUser ne bola: "${userText}"\n\nBuddy ki tarah respond kar. Real, warm, human. User ki language mirror kar. Max 2 sentences unless complex question hai.`;
        }

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
