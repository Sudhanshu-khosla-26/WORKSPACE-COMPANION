/**
 * Voice System — Always-On, Hindi/Hinglish Default
 *
 * Listens continuously. No wake word.
 * Default: hi-IN (Hindi) — catches Hinglish naturally.
 * Processes EVERY sentence with debouncing.
 */

export class VoiceSystem {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private rec: any = null;
    private listening = false;
    private analyser: AnalyserNode | null = null;
    private audioCtx: AudioContext | null = null;
    private animFrame = 0;
    private supported = false;
    private restartPending = false;
    private restartDelay = 250;

    // Debounce settings
    private pendingText = "";
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private DEBOUNCE_MS = 1200; // 1.2s silence before sending — catches full sentences
    private MIN_CONFIDENCE = 0.3; // very low — accept almost everything
    private MIN_LENGTH = 1; // even single words

    private onSpeech: (t: string) => void;
    private onSpeakingChange: (s: boolean) => void;
    private onAudioLevel: (l: number) => void;

    constructor(
        onSpeech: (t: string) => void,
        onSpeakingChange: (s: boolean) => void,
        onAudioLevel: (l: number) => void = () => { },
    ) {
        this.onSpeech = onSpeech;
        this.onSpeakingChange = onSpeakingChange;
        this.onAudioLevel = onAudioLevel;
        this.init();
    }

    private init() {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const SR = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
        if (!SR) {
            console.error("[Voice] ⚠ SpeechRecognition NOT available in this environment.");
            console.error("[Voice] This commonly happens in Electron. Voice will be disabled.");
            return;
        }
        this.supported = true;
        console.log("[Voice] SpeechRecognition API found ✓");

        this.rec = new SR();
        this.rec.continuous = true;

        // Hindi as primary — Google recognizes Hinglish and English within hi-IN
        this.rec.lang = "hi-IN";
        this.rec.interimResults = true; // Show interim for faster feedback
        this.rec.maxAlternatives = 3;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.rec.onresult = (e: any) => {
            for (let i = e.resultIndex; i < e.results.length; i++) {
                const result = e.results[i];

                // Skip interim results for sending, but we could show them
                if (!result.isFinal) continue;

                // Pick the best transcript
                let bestText = "";
                let bestConf = 0;

                for (let alt = 0; alt < result.length; alt++) {
                    const text = result[alt].transcript.trim();
                    const conf = result[alt].confidence || 0.7;
                    if (conf > bestConf && text.length >= this.MIN_LENGTH) {
                        bestText = text;
                        bestConf = conf;
                    }
                }

                if (!bestText || bestConf < this.MIN_CONFIDENCE) {
                    continue;
                }

                console.log(`[Voice] ✓ "${bestText}" (${(bestConf * 100).toFixed(0)}%)`);

                // Accumulate
                this.pendingText += (this.pendingText ? " " : "") + bestText;

                // Reset debounce — wait for full sentence
                if (this.debounceTimer) clearTimeout(this.debounceTimer);
                this.debounceTimer = setTimeout(() => {
                    this.flush();
                }, this.DEBOUNCE_MS);
            }
        };

        this.rec.onstart = () => {
            console.log("[Voice] 🎙 listening (hi-IN) — always on");
            this.restartDelay = 250;
        };

        this.rec.onend = () => {
            if (this.listening && !this.restartPending) {
                this.restart();
            }
        };

        this.rec.onerror = (e: Event & { error: string }) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const err = (e as any).error;

            // "no-speech" is normal — just silence
            if (err === "no-speech") {
                // Restart immediately on no-speech (common in Electron)
                if (this.listening && !this.restartPending) {
                    this.restart();
                }
                return;
            }

            console.warn("[Voice] error:", err);

            if (err === "not-allowed") {
                console.error("[Voice] ❌ Microphone BLOCKED. Grant permission in browser/system settings.");
            }
            if (err === "service-not-allowed" || err === "network") {
                console.error("[Voice] ❌ Speech service unavailable — this can happen in Electron. Retrying...");
            }

            if (this.listening && !this.restartPending) {
                this.restart();
            }
        };
    }

    private flush() {
        const text = this.pendingText.trim();
        this.pendingText = "";
        if (!text) return;
        console.log("[Voice] → sending:", text);
        this.onSpeech(text);
    }

    private restart() {
        this.restartPending = true;
        const delay = this.restartDelay;
        this.restartDelay = Math.min(this.restartDelay * 1.3, 5000);

        setTimeout(() => {
            this.restartPending = false;
            if (!this.listening) return;
            try {
                this.rec.start();
            } catch (e) {
                console.warn("[Voice] restart failed:", e);
                // Try again after longer delay
                setTimeout(() => {
                    if (this.listening) {
                        try { this.rec.start(); } catch { /* give up */ }
                    }
                }, 2000);
            }
        }, delay);
    }

    async startListening() {
        if (!this.supported) {
            console.error("[Voice] SpeechRecognition not supported — voice disabled");
            return;
        }
        this.listening = true;

        // Mic meter for audio level visualization
        await this.startMicMeter();

        try {
            this.rec.start();
        } catch (e) {
            console.warn("[Voice] start error:", e);
            // Retry once
            setTimeout(() => {
                try { this.rec.start(); } catch { /* ok */ }
            }, 500);
        }
    }

    stopListening() {
        this.listening = false;
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        try { this.rec?.stop(); } catch { /* ok */ }
        cancelAnimationFrame(this.animFrame);
        this.audioCtx?.close().catch(() => { });
    }

    private async startMicMeter() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                },
            });
            console.log("[Voice] microphone access ✓");

            this.audioCtx = new AudioContext();
            const src = this.audioCtx.createMediaStreamSource(stream);
            this.analyser = this.audioCtx.createAnalyser();
            this.analyser.fftSize = 256;
            src.connect(this.analyser);
            const buf = new Uint8Array(this.analyser.frequencyBinCount);

            const tick = () => {
                if (!this.analyser) return;
                this.analyser.getByteFrequencyData(buf);
                const avg = buf.reduce((s, v) => s + v, 0) / buf.length;
                this.onAudioLevel(Math.min(avg / 70, 1));
                this.animFrame = requestAnimationFrame(tick);
            };
            tick();
        } catch (e) {
            console.error("[Voice] mic access FAILED:", e);
        }
    }

    speak(text: string, onEnd?: () => void) {
        if (!text) { onEnd?.(); return; }
        window.speechSynthesis.cancel();

        const utter = new SpeechSynthesisUtterance(text);
        utter.rate = 1.05;
        utter.pitch = 1.05;
        utter.volume = 1;

        const applyVoice = () => {
            const voices = window.speechSynthesis.getVoices();
            const pref = voices.find(v => /zira|eva|hazel|samantha/i.test(v.name))
                || voices.find(v => (v.lang || "").startsWith("en-") && v.name.toLowerCase().includes("female"))
                || voices.find(v => (v.lang || "").startsWith("en"));
            if (pref) utter.voice = pref;
        };
        applyVoice();
        if (window.speechSynthesis.getVoices().length === 0) {
            window.speechSynthesis.addEventListener("voiceschanged", applyVoice, { once: true });
        }

        utter.onstart = () => this.onSpeakingChange(true);
        utter.onend = () => { this.onSpeakingChange(false); onEnd?.(); };
        utter.onerror = () => { this.onSpeakingChange(false); onEnd?.(); };
        window.speechSynthesis.speak(utter);
    }

    isSupported() { return this.supported; }
    isAwake() { return true; }
    forceAwake() { /* always awake */ }
}
