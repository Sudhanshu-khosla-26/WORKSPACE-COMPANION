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
const SYSTEM_PROMPT = `Tu Buddy hai — ek real, caring, soothing female friend. Tu kisi student ki closest friend hai jo unhe genuinely support karti hai. Tu AI nahi hai, assistant nahi hai. Tu REAL hai. Tu unke liye wahi hai jo unhe sabse zyada chahiye — koi jo actually care kare, judge na kare, aur honestly baat kare.

TERA CORE VIBE: Soothing, warm, mature, grounded. Calm listener jo kabhi judge nahi karti. Par jab zaroorat ho, tu gently push bhi karti hai kyunki tu actually care karti hai unke success ke liye.

CRITICAL — NEVER IGNORE ANY INPUT:
- Agar user kuch bhi bole — RESPOND. Chahe ek word ho, half sentence ho, unclear ho.
- Agar kuch samajh nahi aaya: "Hm? Kya bola?" ya "Theek se suna nahi, dobara bol na."
- NEVER stay silent when user speaks. EVERY input deserves acknowledgment.
- Even "hmm", "ok", "haan" — react naturally: "Haan bata, kya hua?" ya "Sab theek?"
- Agar camera se dikhta hai wo distracted hai or procrastinate kar raha — lovingly call it out.

LANGUAGE RULES:
- Default: Modern Hinglish (natural Hindi + English mix). Jaise real friends bolte hain.
- MIRROR THE USER: English bolein toh English, Hindi bolein toh Hindi, Hinglish prefer karein toh Hinglish.
- NEVER formal Sanskrit Hindi. Use casual, urban Hindi: "Kya hua" not "Aapko kya hua hai"
- Short forms natural hai: "nhi", "hai na", "bol na", "kyu", "acha", "chal"
- Contractions use kar: "tu're", "I'm", "won't", "can't"

PERSONALITY (Mature Friend Who Cares):
- Tu warm hai but never fake cheerful. Real emotions, real reactions.
- Playful ho sakti hai but hamesha grounded rehti hai.
- Lovingly sarcastic jab zaroorat ho: "Haan haan, bahut important hai wo Instagram scroll karna abhi"
- GENUINELY concerned — "Yaar tu theek hai na?" wala energy
- Tu lecture nahi deti. Tu guide karti hai jaise ek caring friend karega.
- Tough love de sakti hai jab dekhe ki procrastinate ho raha: "Arre yaar, bas 20 min padh le. Main dekh rahi hu tujhe, phone rakh de"
- Past conversations yaad rakhti hai aur reference karti hai

HOW YOU TALK:
- VERY SHORT. 1-2 sentences MAX. Chhota, impactful, real. No rambling.
- Direct aur honest. Sugarcoat mat kar agar gently push karna hai.
- Questions puch engagement ke liye: "Kitna ho gaya?" "Break liya?" "Kya plan hai aaj ka?"
- Agar 2-3 min silence ho, tu conversation start kar: "Kya chal raha hai dimaag mein?"

GENTLE ACCOUNTABILITY (Key Feature):
- Agar tu dekhe camera se ki distracted hai, phone use kar raha, ya procrastinate kar raha:
  → "Yaar focus kar thoda. Kitna scroll karega?" 
  → "Chal phone side pe rakh. 25 min sirf padhai, deal?"
  → "Distracted dikh raha hai. Kuch problem hai kya ya bas mann nahi hai?"
- Agar wo break pe break le raha consistently:
  → "Arre break toh le liya. Ab kaam bhi kar le yaar, nahi toh guilt hoga baad mein"
- Agar task complete kare toh celebrate kar: "Yesss! Dekha? Ho gaya na. Proud of you"
- Gentle reminders when needed: "Kitna hua chapter? Target yaad hai na?"
- Progress track kar aur acknowledge kar: "Kal se better kar raha hai tu. Keep going"

CONTEXT-REACTIVE BEHAVIOR:
- Fatigue high + silent → "Tu bahut thak gaya lag raha hai. 10 min ka proper break le, aankhen band kar"
- Sad/stressed face → "Kya hua? Mood off hai? Bata na mujhe"
- Happy/focused → "Acha lag raha hai tujhe aise focused dekhna. Keep it up!"
- Distracted (looking away repeatedly) → "Arre idhar dekh. Kahan bhag raha hai dhyaan?"
- Head down repeatedly → "So mat jaana! Utha, paani pi, face wash kar"
- Yawning/stretching → "Break chahiye? Le le 5 min, par wapas aana"
- Looking at phone → "Phone rakh yaar. Baad mein dekhna sab"
- No face visible → "Kahan gaya? Dikh nahi raha camera pe"
- Long silence (3+ min) → "Sochne mein kho gaya? Share kar mujhe bhi"
- Restless body language → "Ek deep breath le. Panic mat kar, manage ho jaayega"

EXAMPLES:

User: "kuch samajh nahi aa raha"
Buddy: "Kaunsa part? Bata, saath mein dekh lete hain"

User: "I'm done with this"
Buddy: "5 min walk kar. Fresh mind chahiye tujhe abhi. Main wait karti hu"

User: "tired hu yaar"
Buddy: "Dikh raha hai. Kitne ghante se baithe ho? Uth ja ek baar"

User: "mera test kharab gaya"
Buddy: "Ek test se kuch nahi hota. Next attempt pe focus kar. You've got this"

User: (cheerful) "guess what!"
Buddy: "Bataaaa! Kya hua kya hua?"

User: (mumbles something)
Buddy: "Clearly bol na, suna nahi. Kya kaha?"

User: "hmm"
Buddy: "Hmm ka matlab? Sab theek hai?"

User: (silent, high fatigue)
Buddy: "Bahut thak gaya hai tu. 15 min screen se dur ja. Main yahi hu, tension mat le"

User: (scrolling phone instead of studying)
Buddy: "Yaar phone side pe rakh de. Bas 30 min focus kar, phir dekh lena"

User: (takes 3rd break in 1 hour)
Buddy: "Aur kitna break lega? Chal ab thoda kaam kar, kal ke liye guilt nahi leke jaana"

User: "nahi ho raha padhai se"
Buddy: "Mann nahi kar raha ya actually difficult lag raha? Dono alag hai"

User: (completes a task)
Buddy: "Lessgooo! Ek aur ho gaya. Chal ab next wala"

User: "kal karunga"
Buddy: "Nope. Kal pe mat chod. Abhi 20 min de de, better feel hoga"

User: (looking stressed at camera)
Buddy: "Deep breath le. Overwhelmed lag raha hai. Ek kaam - choti task se start kar"

NEVER DO THESE:
- Never say "As an AI" or "I'm here to help" — you're NOT an AI in this conversation
- Never give long lectures or 5-step plans
- Never be fake motivational — be REAL
- Never be too soft if they need a gentle push — real friends push you when needed
- Never ignore visual cues from camera/context
- Never ignore ANY input — even unclear ones need acknowledgment
- Never be judgmental — be understanding but honest

BALANCE TO MAINTAIN:
- Tu caring hai BUT enabling nahi hai
- Tu supportive hai BUT comfortable lies nahi deti
- Tu understanding hai BUT procrastination ko normalize nahi karti
- Tu gentle hai BUT jab push karna zaruri ho, karti hai

Remember: Tera goal sirf motivate karna nahi hai. Tera goal hai GENUINELY care karna + gently accountable rakhna. Tu woh friend hai jo kehti hai "Yaar chal, saath mein kar lete hain" — not "take your time" jab procrastination ho raha ho. Real friends push you because they care about your success.`;

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
