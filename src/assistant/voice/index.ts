/**
 * Voice System — Mobile-First, Production Ready
 *
 * Priority: Mobile Chrome + Safari → Desktop Chrome → Electron (backend fallback)
 *
 * Mobile Safari quirks handled:
 * - continuous mode is unreliable → restart after every final result
 * - Needs user gesture to start (handled by init flow)
 * - May fire "end" without "error" — just restart
 */

const BACKEND = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

export class VoiceSystem {
    private onSpeech: (text: string) => void;
    private onSpeakingChange: (speaking: boolean) => void;
    private onAudioLevel: (level: number) => void;

    private active = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private recognition: any = null;
    private webSpeechOK = false;
    private isMobile = false;
    private isSafari = false;

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
    private restartTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        onSpeech: (text: string) => void,
        onSpeakingChange: (speaking: boolean) => void,
        onAudioLevel: (level: number) => void = () => { },
    ) {
        this.onSpeech = onSpeech;
        this.onSpeakingChange = onSpeakingChange;
        this.onAudioLevel = onAudioLevel;

        // Detect platform
        const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
        this.isMobile = /iPhone|iPad|iPod|Android|Mobile/i.test(ua);
        this.isSafari = /Safari/i.test(ua) && !/Chrome|CriOS|Chromium/i.test(ua);
        console.log(`[Voice] platform: mobile=${this.isMobile} safari=${this.isSafari}`);
    }

    async startListening(): Promise<string> {
        this.active = true;

        // 1. Get mic
        try {
            this.micStream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
            });
            console.log("[Voice] mic ✓");
        } catch (e) {
            console.error("[Voice] mic denied:", e);
            return "error";
        }

        this.setupMeter(this.micStream);

        // 2. Try Web Speech API
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const SR = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
        if (SR) {
            return this.initWebSpeech(SR);
        }

        // 3. No Web Speech → recorder fallback
        console.log("[Voice] no Web Speech API → recorder fallback");
        this.startRecorderFallback();
        return "recorder";
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Web Speech API — works on Chrome + Safari (mobile & desktop)
    // ═══════════════════════════════════════════════════════════════════════════
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private initWebSpeech(SR: any): string {
        this.recognition = new SR();

        // Safari: continuous mode is broken → use single-shot and restart
        // Chrome: continuous works fine
        this.recognition.continuous = !this.isSafari;
        this.recognition.lang = "hi-IN";
        this.recognition.interimResults = false;
        this.recognition.maxAlternatives = 3;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.recognition.onresult = (e: any) => {
            for (let i = e.resultIndex; i < e.results.length; i++) {
                const r = e.results[i];
                if (!r.isFinal) continue;

                let best = "", bestC = 0;
                for (let a = 0; a < r.length; a++) {
                    const t = r[a].transcript?.trim() || "";
                    const c = r[a].confidence ?? 0.8;
                    if (t.length > 0 && c > bestC) { best = t; bestC = c; }
                }

                if (best) {
                    console.log(`[Voice] ✓ "${best}"`);
                    this.accum(best);
                }
            }

            // Safari: must restart after getting results
            if (this.isSafari && this.active) {
                this.safeRestart(100);
            }
        };

        this.recognition.onstart = () => {
            this.webSpeechOK = true;
            console.log("[Voice] 🎙 listening" + (this.isSafari ? " (Safari single-shot)" : " (continuous)"));
        };

        this.recognition.onend = () => {
            // Always restart — this is the key to keeping it alive
            if (this.active) {
                this.safeRestart(this.isSafari ? 100 : 300);
            }
        };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.recognition.onerror = (e: any) => {
            const err = e.error || "";

            if (err === "no-speech") {
                // Normal — silence. Restart.
                if (this.active) this.safeRestart(100);
                return;
            }

            if (err === "aborted") {
                // Safari fires this on restart — normal
                if (this.active) this.safeRestart(200);
                return;
            }

            console.warn("[Voice] error:", err);

            if (err === "not-allowed") {
                console.error("[Voice] ❌ Mic blocked! Enable in browser settings.");
                // Don't fallback — user needs to grant permission
                return;
            }

            if (err === "service-not-allowed" || err === "network") {
                // No speech service (Electron) → fallback to recorder
                console.log("[Voice] no speech service → recorder fallback");
                this.webSpeechOK = false;
                this.recognition = null;
                this.startRecorderFallback();
                return;
            }

            // Other errors → restart
            if (this.active) this.safeRestart(500);
        };

        try {
            this.recognition.start();
            this.webSpeechOK = true;
            return "webspeech";
        } catch (e) {
            console.warn("[Voice] start failed:", e);
            this.startRecorderFallback();
            return "recorder";
        }
    }

    private safeRestart(delay: number) {
        if (this.restartTimer) clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => {
            if (!this.active || !this.recognition) return;
            try {
                this.recognition.start();
            } catch {
                // Already running or can't start — try again
                setTimeout(() => {
                    if (!this.active || !this.recognition) return;
                    try { this.recognition.start(); } catch { /* give up */ }
                }, 500);
            }
        }, delay);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // MediaRecorder → Backend /transcribe (Electron / fallback)
    // ═══════════════════════════════════════════════════════════════════════════
    private startRecorderFallback() {
        if (!this.micStream || !this.active) return;
        console.log("[Voice] starting MediaRecorder fallback");

        const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
            ? "audio/webm;codecs=opus"
            : MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm"
                : MediaRecorder.isTypeSupported("audio/mp4") ? "audio/mp4" : "";

        if (!mime) {
            console.error("[Voice] no audio format supported");
            return;
        }

        this.recordCycle(mime);
    }

    private recordCycle(mime: string) {
        if (!this.active || !this.micStream) return;

        const mr = new MediaRecorder(this.micStream, { mimeType: mime });
        this.chunks = [];
        mr.ondataavailable = (e) => { if (e.data.size > 0) this.chunks.push(e.data); };

        mr.onstop = () => {
            const blob = new Blob(this.chunks, { type: mime });
            this.chunks = [];
            if (blob.size > 4000) this.transcribe(blob);
            if (this.active) this.recTimer = setTimeout(() => this.recordCycle(mime), 200);
        };

        try {
            mr.start();
            this.recorder = mr;
            setTimeout(() => {
                if (mr.state === "recording") try { mr.stop(); } catch { /* */ }
            }, 3000);
        } catch {
            if (this.active) this.recTimer = setTimeout(() => this.recordCycle(mime), 1000);
        }
    }

    private async transcribe(blob: Blob) {
        try {
            const form = new FormData();
            form.append("file", blob, "audio.webm");
            const res = await fetch(`${BACKEND}/transcribe`, { method: "POST", body: form });
            if (!res.ok) return;
            const { text } = await res.json();
            if (text?.trim()) {
                console.log(`[Voice:backend] "${text}"`);
                this.accum(text.trim());
            }
        } catch { /* network error — skip */ }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // Shared
    // ═══════════════════════════════════════════════════════════════════════════
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
        }, 800);
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
        } catch { /* optional */ }
    }

    stopListening() {
        this.active = false;
        if (this.dTimer) clearTimeout(this.dTimer);
        if (this.recTimer) clearTimeout(this.recTimer);
        if (this.restartTimer) clearTimeout(this.restartTimer);
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
