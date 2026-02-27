/**
 * Voice System — Always-On Listener
 *
 * Listens to ALL speech continuously. No wake word required.
 * Uses Web Speech API with debouncing and confidence thresholds
 * to avoid sending misheard/partial results.
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
    private restartDelay = 300; // exponential backoff start

    // Debounce: collect speech, wait for silence, then send
    private pendingText = "";
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;
    private DEBOUNCE_MS = 1000; // wait 1s of silence before sending
    private MIN_CONFIDENCE = 0.4; // lower threshold — let more through
    private MIN_LENGTH = 2; // ignore very short transcripts

    private onSpeech: (t: string) => void;
    private onSpeakingChange: (s: boolean) => void;
    private onAudioLevel: (l: number) => void;
    private onWakeWord: () => void;
    private onAwakeChange: (a: boolean) => void;

    constructor(
        onSpeech: (t: string) => void,
        onSpeakingChange: (s: boolean) => void,
        onAudioLevel: (l: number) => void = () => { },
        onWakeWord: () => void = () => { },
        onAwakeChange: (a: boolean) => void = () => { }
    ) {
        this.onSpeech = onSpeech;
        this.onSpeakingChange = onSpeakingChange;
        this.onAudioLevel = onAudioLevel;
        this.onWakeWord = onWakeWord;
        this.onAwakeChange = onAwakeChange;
        this.init();
    }

    private init() {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const SR = (window as any).webkitSpeechRecognition || (window as any).SpeechRecognition;
        if (!SR) {
            console.error("[Voice] ⚠ SpeechRecognition NOT available.");
            return;
        }
        this.supported = true;
        console.log("[Voice] SpeechRecognition API available ✓");

        this.rec = new SR();
        this.rec.continuous = true;
        // Use en-US for maximum compatibility (works in Electron, mobile, all browsers)
        // Hindi/Hinglish is still recognized — Google's speech engine auto-detects
        this.rec.lang = "en-US";
        this.rec.interimResults = false; // Only final results — reduces noise
        this.rec.maxAlternatives = 3; // Get alternatives for better accuracy

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.rec.onresult = (e: any) => {
            for (let i = e.resultIndex; i < e.results.length; i++) {
                const result = e.results[i];
                if (!result.isFinal) continue;

                // Get best transcript with confidence check
                let bestText = "";
                let bestConf = 0;

                for (let alt = 0; alt < result.length; alt++) {
                    const transcript = result[alt].transcript.trim();
                    const confidence = result[alt].confidence || 0.7;

                    if (confidence > bestConf && transcript.length > this.MIN_LENGTH) {
                        bestText = transcript;
                        bestConf = confidence;
                    }
                }

                if (!bestText || bestConf < this.MIN_CONFIDENCE) {
                    console.log(`[Voice] skipped low-confidence: "${bestText}" (${(bestConf * 100).toFixed(0)}%)`);
                    continue;
                }

                console.log(`[Voice] heard: "${bestText}" (conf: ${(bestConf * 100).toFixed(0)}%)`);

                // Accumulate text and debounce
                this.pendingText += (this.pendingText ? " " : "") + bestText;

                // Reset debounce timer — wait for silence
                if (this.debounceTimer) clearTimeout(this.debounceTimer);
                this.debounceTimer = setTimeout(() => {
                    this.flushPendingText();
                }, this.DEBOUNCE_MS);
            }
        };

        this.rec.onstart = () => {
            console.log("[Voice] recognition started — always listening ✓");
            this.restartDelay = 300; // reset backoff on successful start
        };

        // Auto-restart on end
        this.rec.onend = () => {
            console.log("[Voice] recognition ended — restarting...");
            if (this.listening && !this.restartPending) {
                this.scheduleRestart();
            }
        };

        this.rec.onerror = (e: Event & { error: string }) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const err = (e as any).error;
            if (err === "no-speech") return; // Normal, just silence

            console.warn("[Voice] error:", err);

            if (err === "not-allowed") {
                console.error("[Voice] Microphone DENIED. Check System Privacy → Microphone.");
            }

            // Restart with backoff
            if (this.listening && !this.restartPending) {
                this.scheduleRestart();
            }
        };
    }

    private flushPendingText() {
        if (!this.pendingText.trim()) return;
        const text = this.pendingText.trim();
        this.pendingText = "";
        console.log("[Voice] → sending to Buddy:", text);
        this.onSpeech(text);
    }

    private scheduleRestart() {
        this.restartPending = true;
        const delay = this.restartDelay;
        this.restartDelay = Math.min(this.restartDelay * 1.5, 5000); // max 5s backoff

        setTimeout(() => {
            this.restartPending = false;
            if (this.listening) {
                try {
                    this.rec.start();
                } catch (e) {
                    console.warn("[Voice] restart failed:", e);
                }
            }
        }, delay);
    }

    async startListening() {
        if (!this.supported) {
            console.error("[Voice] cannot start — SpeechRecognition not supported");
            return;
        }
        this.listening = true;
        this.onAwakeChange(true);

        // Start mic meter
        console.log("[Voice] requesting getUserMedia...");
        await this.startMicMeter();

        try {
            console.log("[Voice] starting always-on speech recognition...");
            this.rec.start();
        } catch (e) {
            console.warn("[Voice] start error:", e);
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
            console.log("[Voice] getUserMedia SUCCESS ✓");

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
            console.error("[Voice] getUserMedia FAILED:", e);
            if ((e as Error).name === "NotAllowedError") {
                console.error("[Voice] PERMISSION DENIED: Enable Microphone in Windows Settings → Privacy → Microphone.");
            }
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
            if (pref) { utter.voice = pref; }
        };
        applyVoice();
        if (window.speechSynthesis.getVoices().length === 0) {
            window.speechSynthesis.addEventListener("voiceschanged", applyVoice, { once: true });
        }

        utter.onstart = () => { this.onSpeakingChange(true); };
        utter.onend = () => { this.onSpeakingChange(false); onEnd?.(); };
        utter.onerror = () => { this.onSpeakingChange(false); onEnd?.(); };
        window.speechSynthesis.speak(utter);
    }

    forceAwake() {
        this.onAwakeChange(true);
    }

    isAwake() { return true; } // Always awake
}
