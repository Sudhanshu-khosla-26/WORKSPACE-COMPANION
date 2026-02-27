/**
 * Voice System — Production Ready
 *
 * Strategy:
 * 1. Try Web Speech API first (works in Chrome on any platform)
 * 2. If it fails or isn't available → use MediaRecorder → backend /transcribe
 * 3. Always capture mic for audio level visualization
 *
 * Default language: hi-IN (Hindi/Hinglish). Debounce: 1200ms.
 */

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

export class VoiceSystem {
    private onSpeech: (text: string) => void;
    private onSpeakingChange: (speaking: boolean) => void;
    private onAudioLevel: (level: number) => void;

    private active = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private recognition: any = null;
    private webSpeechWorks = false;

    // MediaRecorder fallback
    private recorder: MediaRecorder | null = null;
    private chunks: Blob[] = [];
    private recTimer: ReturnType<typeof setTimeout> | null = null;
    private micStream: MediaStream | null = null;

    // Audio meter
    private ctx: AudioContext | null = null;
    private analyser: AnalyserNode | null = null;
    private raf = 0;

    // Debounce
    private pending = "";
    private dTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        onSpeech: (text: string) => void,
        onSpeakingChange: (speaking: boolean) => void,
        onAudioLevel: (level: number) => void = () => { },
    ) {
        this.onSpeech = onSpeech;
        this.onSpeakingChange = onSpeakingChange;
        this.onAudioLevel = onAudioLevel;
    }

    /** Call this and AWAIT it before setting voice status */
    async startListening(): Promise<string> {
        this.active = true;

        // 1. Get mic access
        try {
            this.micStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            });
            console.log("[Voice] mic ✓");
        } catch (e) {
            console.error("[Voice] mic denied:", e);
            return "error";
        }

        // Audio level meter
        this.setupMeter(this.micStream);

        // 2. Try Web Speech API
        const mode = await this.tryWebSpeech();
        if (mode === "webspeech") return "webspeech";

        // 3. Fallback to MediaRecorder
        this.setupRecorder(this.micStream);
        return "recorder";
    }

    // ─── Web Speech API ──────────────────────────────────────────────────────
    private tryWebSpeech(): Promise<string> {
        return new Promise((resolve) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const SR = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
            if (!SR) {
                console.log("[Voice] Web Speech API not available");
                resolve("none");
                return;
            }

            const rec = new SR();
            rec.continuous = true;
            rec.lang = "hi-IN";
            rec.interimResults = false;
            rec.maxAlternatives = 3;

            let started = false;
            let resolved = false;

            const done = (mode: string) => {
                if (!resolved) { resolved = true; resolve(mode); }
            };

            rec.onstart = () => {
                started = true;
                this.webSpeechWorks = true;
                console.log("[Voice] Web Speech started ✓ (hi-IN)");
                done("webspeech");
            };

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            rec.onresult = (e: any) => {
                for (let i = e.resultIndex; i < e.results.length; i++) {
                    const r = e.results[i];
                    if (!r.isFinal) continue;

                    let best = "", bestC = 0;
                    for (let a = 0; a < r.length; a++) {
                        const t = r[a].transcript?.trim();
                        const c = r[a].confidence ?? 0.8;
                        if (t && c > bestC) { best = t; bestC = c; }
                    }
                    if (best.length > 0) {
                        console.log(`[Voice] heard: "${best}"`);
                        this.accum(best);
                    }
                }
            };

            rec.onend = () => {
                if (this.active && this.webSpeechWorks) {
                    // Auto-restart
                    setTimeout(() => {
                        if (!this.active) return;
                        try { rec.start(); } catch { /* */ }
                    }, 300);
                }
            };

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            rec.onerror = (e: any) => {
                const err = e.error || "";
                console.warn("[Voice] speech error:", err);

                if (err === "no-speech") {
                    // Normal — just silence. Restart.
                    if (this.active && started) {
                        setTimeout(() => {
                            if (!this.active) return;
                            try { rec.start(); } catch { /* */ }
                        }, 200);
                    }
                    return;
                }

                // Fatal errors → give up on Web Speech, fallback to recorder
                if (!started || err === "not-allowed" || err === "service-not-allowed" || err === "network") {
                    console.log("[Voice] Web Speech failed → using recorder");
                    this.webSpeechWorks = false;
                    done("none");
                    return;
                }

                // Other errors → try restart
                if (this.active) {
                    setTimeout(() => {
                        if (!this.active) return;
                        try { rec.start(); } catch { /* */ }
                    }, 500);
                }
            };

            this.recognition = rec;

            try {
                rec.start();
                // Give it 3 seconds to succeed
                setTimeout(() => done("none"), 3000);
            } catch {
                done("none");
            }
        });
    }

    // ─── MediaRecorder → Backend ─────────────────────────────────────────────
    private setupRecorder(stream: MediaStream) {
        console.log("[Voice] setting up MediaRecorder → backend");

        const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
            ? "audio/webm;codecs=opus"
            : MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";

        if (!mime) {
            console.error("[Voice] no supported audio format for MediaRecorder");
            return;
        }

        this.startRecordCycle(stream, mime);
    }

    private startRecordCycle(stream: MediaStream, mime: string) {
        if (!this.active) return;

        const mr = new MediaRecorder(stream, { mimeType: mime });
        this.chunks = [];

        mr.ondataavailable = (e) => {
            if (e.data.size > 0) this.chunks.push(e.data);
        };

        mr.onstop = () => {
            const blob = new Blob(this.chunks, { type: mime });
            this.chunks = [];

            if (blob.size > 4000 && this.active) {
                this.transcribe(blob);
            }

            // Start next cycle
            if (this.active) {
                this.recTimer = setTimeout(() => this.startRecordCycle(stream, mime), 200);
            }
        };

        try {
            mr.start();
            this.recorder = mr;

            // Stop after 3 seconds
            setTimeout(() => {
                if (mr.state === "recording") {
                    try { mr.stop(); } catch { /* */ }
                }
            }, 3000);
        } catch (e) {
            console.warn("[Voice] recorder start error:", e);
            if (this.active) {
                this.recTimer = setTimeout(() => this.startRecordCycle(stream, mime), 1000);
            }
        }
    }

    private async transcribe(blob: Blob) {
        try {
            const form = new FormData();
            form.append("file", blob, "audio.webm");
            const res = await fetch(`${BACKEND}/transcribe`, { method: "POST", body: form });
            if (!res.ok) return;
            const data = await res.json();
            const text = data.text?.trim();
            if (text) {
                console.log(`[Voice:backend] "${text}"`);
                this.accum(text);
            }
        } catch (e) {
            console.warn("[Voice] transcribe err:", e);
        }
    }

    // ─── Shared ──────────────────────────────────────────────────────────────
    private accum(text: string) {
        this.pending += (this.pending ? " " : "") + text;
        if (this.dTimer) clearTimeout(this.dTimer);
        this.dTimer = setTimeout(() => {
            const t = this.pending.trim();
            this.pending = "";
            if (t) {
                console.log("[Voice] → Buddy:", t);
                this.onSpeech(t);
            }
        }, 1200);
    }

    private setupMeter(stream: MediaStream) {
        try {
            this.ctx = new AudioContext();
            const src = this.ctx.createMediaStreamSource(stream);
            this.analyser = this.ctx.createAnalyser();
            this.analyser.fftSize = 256;
            src.connect(this.analyser);
            const buf = new Uint8Array(this.analyser.frequencyBinCount);
            const tick = () => {
                if (!this.analyser) return;
                this.analyser.getByteFrequencyData(buf);
                this.onAudioLevel(Math.min(buf.reduce((s, v) => s + v, 0) / buf.length / 70, 1));
                this.raf = requestAnimationFrame(tick);
            };
            tick();
        } catch { /* meter is optional */ }
    }

    stopListening() {
        this.active = false;
        if (this.dTimer) clearTimeout(this.dTimer);
        if (this.recTimer) clearTimeout(this.recTimer);
        try { this.recognition?.stop(); } catch { /* */ }
        try { if (this.recorder?.state === "recording") this.recorder.stop(); } catch { /* */ }
        cancelAnimationFrame(this.raf);
        this.ctx?.close().catch(() => { });
        this.micStream?.getTracks().forEach(t => t.stop());
    }

    speak(text: string, onEnd?: () => void) {
        if (!text) { onEnd?.(); return; }
        window.speechSynthesis.cancel();

        const u = new SpeechSynthesisUtterance(text);
        u.rate = 1.05; u.pitch = 1.05;

        const voices = window.speechSynthesis.getVoices();
        const v = voices.find(v => /zira|eva|hazel|samantha/i.test(v.name))
            || voices.find(v => (v.lang || "").startsWith("en"));
        if (v) u.voice = v;

        u.onstart = () => this.onSpeakingChange(true);
        u.onend = () => { this.onSpeakingChange(false); onEnd?.(); };
        u.onerror = () => { this.onSpeakingChange(false); onEnd?.(); };
        window.speechSynthesis.speak(u);
    }

    isAwake() { return true; }
    forceAwake() { }
}
