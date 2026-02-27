const WAKE_WORDS = ["hey buddy", "buddy", "hey companion", "companion", "hello buddy", "hello", "hi", "hey"];

export class VoiceSystem {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private rec: any = null;
    private listening = false;
    private awake = false;
    private sleepTimer: ReturnType<typeof setTimeout> | null = null;
    private analyser: AnalyserNode | null = null;
    private audioCtx: AudioContext | null = null;
    private animFrame = 0;
    private supported = false;
    private restartPending = false;

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
            console.error("[Voice] ⚠ SpeechRecognition NOT available in this runtime.");
            console.error("[Voice] Check: chrome://flags and ensure speech is not blocked.");
            return;
        }
        this.supported = true;
        console.log("[Voice] SpeechRecognition API available ✓");

        this.rec = new SR();
        this.rec.continuous = true;
        this.rec.lang = "en-US";
        this.rec.interimResults = true;  // Faster wake word detection
        this.rec.maxAlternatives = 2;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.rec.onresult = (e: any) => {
            for (let i = e.resultIndex; i < e.results.length; i++) {
                const result = e.results[i];
                const raw = result[0].transcript.toLowerCase().trim();
                const isFinal = result.isFinal;

                // console.log("[Voice] stream:", `"${raw}" (final=${isFinal})`);

                // Check for wake word in interim OR final results for speed
                const hitWake = WAKE_WORDS.find(w => raw.includes(w));
                if (hitWake) {
                    if (!this.awake) {
                        console.log("[Voice] WAKE WORD triggered:", hitWake);
                        this.awake = true;
                        this.onWakeWord();
                        this.onAwakeChange(true);
                    }
                    this.resetSleepTimer();

                    // If final, check if there's significant text after wake word
                    if (isFinal) {
                        let after = raw;
                        for (const w of WAKE_WORDS) after = after.replace(w, "").trim();
                        if (after.length > 1) {
                            console.log("[Voice] speech after wake:", after);
                            this.onSpeech(after);
                        }
                    }
                    return;
                }

                // If already awake, only process final results to avoid double-sending
                if (this.awake && isFinal && raw.length > 2) {
                    this.resetSleepTimer();
                    console.log("[Voice] awake → forwarding:", raw);
                    this.onSpeech(raw);
                }
            }
        };

        this.rec.onstart = () => {
            console.log("[Voice] recognition started");
        };

        // Always restart — never let it go silent
        this.rec.onend = () => {
            console.log("[Voice] recognition ended — restarting in 300ms");
            if (this.listening && !this.restartPending) {
                this.restartPending = true;
                setTimeout(() => {
                    this.restartPending = false;
                    if (this.listening) {
                        try { this.rec.start(); }
                        catch (e) { console.warn("[Voice] restart failed:", e); }
                    }
                }, 300);
            }
        };

        this.rec.onerror = (e: Event & { error: string }) => {
            const err = (e as any).error;
            if (err === "no-speech") return;
            console.warn("[Voice] error:", err);

            if (err === "not-allowed") {
                console.error("[Voice] Microphone permission DENIED. Check System Privacy settings or Electron handlers.");
            }

            // Restart on error
            if (this.listening && !this.restartPending) {
                this.restartPending = true;
                setTimeout(() => {
                    this.restartPending = false;
                    if (this.listening) {
                        try { this.rec.start(); }
                        catch { /* already running */ }
                    }
                }, 1000);
            }
        };
    }

    private resetSleepTimer() {
        // Disabled — User requested "Always Active" companion.
        // Buddy stays awake once initialized until explicitly told otherwise.
        if (this.sleepTimer) clearTimeout(this.sleepTimer);
    }

    async startListening() {
        if (!this.supported) {
            console.error("[Voice] cannot start — SpeechRecognition not supported");
            return;
        }
        this.listening = true;
        this.awake = true; // Stay awake forever as requested
        this.onAwakeChange(true);

        // Try Mic Meter (getUserMedia)
        console.log("[Voice] requesting getUserMedia (Mic Meter)...");
        await this.startMicMeter();

        try {
            console.log("[Voice] starting SpeechRecognition in Always-Active mode...");
            this.rec.start();
        } catch (e) {
            console.warn("[Voice] SpeechRecognition start error:", e);
        }
    }

    stopListening() {
        this.listening = false;
        if (this.sleepTimer) clearTimeout(this.sleepTimer);
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
                    autoGainControl: true
                }
            });
            console.log("[Voice] getUserMedia SUCCESS. Mic is connected.");

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
            console.log("[Voice] mic meter running.");
        } catch (e) {
            console.error("[Voice] !!! getUserMedia FAILED. Buddy cannot hear you. Error:", e);
            if ((e as Error).name === "NotAllowedError") {
                console.error("[Voice] PERMISSION DENIED: Please enable Microphone access in Windows Settings -> Privacy -> Microphone.");
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
            if (pref) { utter.voice = pref; console.log("[Voice] using voice:", pref.name); }
        };
        applyVoice();
        if (window.speechSynthesis.getVoices().length === 0) {
            window.speechSynthesis.addEventListener("voiceschanged", applyVoice, { once: true });
        }

        utter.onstart = () => { console.log("[Voice] speaking:", text.slice(0, 60)); this.onSpeakingChange(true); };
        utter.onend = () => { this.onSpeakingChange(false); onEnd?.(); };
        utter.onerror = (e) => { console.error("[Voice] speak error:", e); this.onSpeakingChange(false); onEnd?.(); };
        window.speechSynthesis.speak(utter);
    }

    forceAwake() {
        this.awake = true;
        this.onAwakeChange(true);
        this.resetSleepTimer();
    }
    isAwake() { return this.awake; }
}
