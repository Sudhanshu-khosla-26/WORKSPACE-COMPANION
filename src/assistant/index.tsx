"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { CameraCapture, FaceAnalysisResult } from "./camera";
import { ScreenCapture, ScreenAnalysisResult } from "./screen";
import { VoiceSystem } from "./voice";
import { getBuddyLive, destroyBuddyLive } from "./ai";
import { memoryStore } from "./memory";
import { AssistantOrb } from "./ui/AssistantOrb";
import { WebcamPreview } from "./ui/WebcamPreview";

export interface UserState {
    fatigue: number;  // 0-1
    focus: number;  // 0-100
    distraction: number;  // 0-100
    lastEmotion: string;
}

const PROACTIVE_COOLDOWN = 60_000; // 1 min between proactive nudges
const TIRED_THRESHOLD = 0.45;
const DISTRACT_THRESHOLD = 45;
const NEG_EMOTIONS = ["sad", "angry", "fear", "disgust"];
const GREET_TRIGGER = "<greet and introduce yourself naturally>";

export const AssistantEngine: React.FC = () => {
    const [initialized, setInitialized] = useState(false);
    const [awake, setAwake] = useState(false);
    const [isListening, setIsListening] = useState(false);
    const [isSpeaking, setIsSpeaking] = useState(false);
    const [ariaReply, setAriaReply] = useState<string | null>(null);
    const [screenActivity, setScreenActivity] = useState("unknown");
    const [frameCount, setFrameCount] = useState(0);
    const [camStatus, setCamStatus] = useState<"off" | "starting" | "on" | "error">("off");
    const [voiceStatus, setVoiceStatus] = useState<"off" | "on" | "error">("off");
    const [liveStatus, setLiveStatus] = useState<"connecting" | "ready" | "error">("connecting");
    const [audioLevel, setAudioLevel] = useState(0);
    const [transcript, setTranscript] = useState<string | null>(null);
    const [lastUpdate, setLastUpdate] = useState(0);

    // Stats live here as a ref so camera callback always has fresh values
    const stateRef = useRef<UserState>({ fatigue: 0, focus: 100, distraction: 0, lastEmotion: "neutral" });
    const [displayState, setDisplayState] = useState<UserState>(stateRef.current);

    const voiceRef = useRef<VoiceSystem | null>(null);
    const cameraRef = useRef<CameraCapture | null>(null);
    const screenRef = useRef<ScreenCapture | null>(null);
    const processingRef = useRef(false);
    const lockTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const buildingReplyRef = useRef(""); // Use ref for the building reply to avoid state closure issues in callbacks
    const lastProactiveRef = useRef(0);
    const screenActivityRef = useRef("unknown");
    const replyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Keep screenActivity in a ref for stable callbacks
    useEffect(() => { screenActivityRef.current = screenActivity; }, [screenActivity]);

    // Auto-initialize on mount
    useEffect(() => {
        initialize();
    }, []);

    // Cleanup on unmount
    useEffect(() => () => {
        cameraRef.current?.stop();
        screenRef.current?.stop();
        voiceRef.current?.stopListening();
        destroyBuddyLive();
    }, []);

    /* ── Release processing lock ──────────────────────────── */
    const releaseLock = useCallback((reason = "unknown") => {
        if (!processingRef.current) return;
        console.log(`[Engine] LOCK RELEASED (${reason})`);
        processingRef.current = false;
        if (lockTimeoutRef.current) {
            clearTimeout(lockTimeoutRef.current);
            lockTimeoutRef.current = null;
        }
    }, []);

    const acquireLock = useCallback(() => {
        if (processingRef.current) return false;
        console.log("[Engine] LOCK ACQUIRED");
        processingRef.current = true;
        // Safety timeout: never stay locked more than 15s
        lockTimeoutRef.current = setTimeout(() => {
            if (processingRef.current) releaseLock("timeout-safety");
        }, 15000);
        return true;
    }, [releaseLock]);

    /* ── Callbacks for BuddyLive ─────────────────────────── */
    const onBuddyText = useCallback((text: string) => {
        buildingReplyRef.current += text;
        setAriaReply(prev => prev ? prev + text : text);
        if (replyTimeoutRef.current) clearTimeout(replyTimeoutRef.current);
        replyTimeoutRef.current = setTimeout(() => setAriaReply(null), 8000);
    }, []);

    const onBuddySpeaking = useCallback((speaking: boolean) => {
        setIsSpeaking(speaking);
        if (!speaking) {
            // Give audio a tiny bit of time to clear before releasing
            setTimeout(() => releaseLock("speaking-ended"), 500);
        }
    }, [releaseLock]);

    const onBuddyAudioLevel = useCallback((level: number) => {
        setAudioLevel(level);
    }, []);

    /* ── Get or init the BuddyLive singleton ──────────────── */
    const getBuddy = useCallback(() => {
        return getBuddyLive(onBuddyText, onBuddySpeaking, onBuddyAudioLevel);
    }, [onBuddyText, onBuddySpeaking, onBuddyAudioLevel]);

    /* ── Send message to Buddy ─────────────────────────────── */
    const sendToBuddy = useCallback((
        text: string,
        state: UserState,
        pushToMemory = true
    ) => {
        if (!acquireLock()) return;

        setAriaReply(null); // clear old reply
        buildingReplyRef.current = "";

        const buddy = getBuddy();
        const currentState = { ...state };
        const currentActivity = screenActivityRef.current;
        const memory = memoryStore.getLast(6);

        buddy.send(text, currentState, currentActivity, memory, () => {
            // onDone fires when audio finishes playing
            console.log("[Engine] buddy turn finished (audio done)");
            if (pushToMemory && buildingReplyRef.current) {
                memoryStore.push({
                    user: text,
                    ai: buildingReplyRef.current,
                    emotion: currentState.lastEmotion,
                    timestamp: Date.now(),
                });
            }
            releaseLock("onDone-callback");
        });
    }, [getBuddy, acquireLock, releaseLock]);

    /* ── Handle user speech ───────────────────────────────── */
    const handleSpeech = useCallback(async (text: string) => {
        if (processingRef.current) return;
        console.log("[Engine] user said:", text);
        setTranscript(text);
        setTimeout(() => setTranscript(null), 4000);
        sendToBuddy(text, stateRef.current, true);
    }, [sendToBuddy]);

    /* ── Proactive check (uses ref for stability) ─────────── */
    const proactiveCheckRef = useRef<(s: UserState) => void>(() => { });
    proactiveCheckRef.current = (newState: UserState) => {
        if (processingRef.current) return;
        const now = Date.now();
        if (now - lastProactiveRef.current < PROACTIVE_COOLDOWN) return;

        let trigger = false;
        if (newState.fatigue > TIRED_THRESHOLD) trigger = true;
        else if (newState.distraction > DISTRACT_THRESHOLD) trigger = true;
        else if (NEG_EMOTIONS.includes(newState.lastEmotion)) trigger = true;
        if (!trigger) return;

        lastProactiveRef.current = now;
        sendToBuddy("<check on them>", newState, false);
    };

    /* ── Camera face result ────────────────────────────────── */
    const handleFaceResult = useCallback((res: FaceAnalysisResult) => {
        const newState: UserState = {
            fatigue: parseFloat((res.fatigue_score ?? 0).toFixed(3)),
            distraction: parseFloat((res.distraction_score ?? 0).toFixed(1)),
            focus: parseFloat((100 - (res.distraction_score ?? 0)).toFixed(1)),
            lastEmotion: (res.emotion || "neutral").toLowerCase(),
        };
        stateRef.current = newState;
        setDisplayState({ ...newState });
        setLastUpdate(Date.now());
        setFrameCount(c => c + 1);
        proactiveCheckRef.current(newState);
    }, []);

    /* ── Screen result ───────────────────────────────────────*/
    const handleScreenResult = useCallback((res: ScreenAnalysisResult) => {
        const activity = (res.activity || "unknown").toLowerCase();
        setScreenActivity(activity);
        screenActivityRef.current = activity;
    }, []);

    /* ── Save frame via Electron ─────────────────────────── */
    const handleFrame = useCallback((dataUrl: string) => {
        try { (window as any).electronAPI?.saveFrame?.(dataUrl); } catch { /* not Electron */ }
    }, []);

    const [statusMsg, setStatusMsg] = useState("Waking up Buddy...");

    const initializingRef = useRef(false);

    /* ── Initialize ──────────────────────────────────────── */
    const initialize = useCallback(async () => {
        if (initialized || initializingRef.current) return;
        initializingRef.current = true;

        const geminiKey = process.env.NEXT_PUBLIC_GEMINI_KEY;
        console.log("[Engine] Checking keys...", geminiKey ? "Found" : "Missing");

        // Connect to Gemini Live first
        setStatusMsg("Connecting to Gemini Live...");
        setLiveStatus("connecting");
        try {
            const buddy = getBuddy();
            if (!geminiKey) {
                throw new Error("NEXT_PUBLIC_GEMINI_KEY is missing from build!");
            }
            await buddy.connect();
            setLiveStatus("ready");
            console.log("[Engine] Gemini Live connected ✓");
        } catch (e) {
            console.error("[Engine] Gemini Live failed:", e);
            setLiveStatus("error");
            setStatusMsg(`Gemini Connection Failed: ${(e as Error).message}`);
            // Don't return, try to start other systems anyway
        }

        // Voice (STT only — audio output from Gemini native)
        setStatusMsg("Starting voice system...");
        try {
            voiceRef.current = new VoiceSystem(
                handleSpeech,
                () => { /* speaking handled by BuddyLive */ },
                () => { /* mic level — not needed when buddy speaks */ },
            );
            voiceRef.current.startListening();
            setIsListening(true);
            setAwake(true);
            setVoiceStatus("on");
            console.log("[Engine] voice STT started — always listening ✓");

            // Automatic Greet after short delay
            setTimeout(() => {
                sendToBuddy(GREET_TRIGGER, stateRef.current, false);
            }, 2500);

        } catch (e) {
            console.error("[Engine] voice failed:", e);
            setVoiceStatus("error");
        }

        // Camera
        setStatusMsg("Starting camera vision...");
        setCamStatus("starting");
        try {
            const previewEl = document.getElementById("camera-preview-video") as HTMLVideoElement;
            cameraRef.current = new CameraCapture(handleFaceResult, handleFrame);
            await cameraRef.current.start(previewEl || undefined);
            setCamStatus("on");
            console.log("[Engine] camera started");
        } catch (e) {
            console.error("[Engine] camera failed:", e);
            setCamStatus("error");
        }

        // Screen (non-blocking)
        setStatusMsg("Starting screen analysis...");
        try {
            screenRef.current = new ScreenCapture(handleScreenResult);
            screenRef.current.start().catch(() => { });
        } catch { /* optional */ }

        setInitialized(true);
        initializingRef.current = false;
    }, [initialized, getBuddy, handleSpeech, handleFaceResult, handleFrame, handleScreenResult]);

    /* ── Emotion → color ──────────────────────────────────── */
    const emotionColor: Record<string, string> = {
        happy: "#fbbf24", sad: "#60a5fa", angry: "#f87171",
        fear: "#c084fc", surprised: "#f472b6", disgust: "#4ade80", neutral: "#64748b",
    };
    const eColor = emotionColor[displayState.lastEmotion] ?? "#64748b";

    return (
        <div
            className="min-h-screen flex flex-col"
            style={{
                background: "radial-gradient(ellipse at 50% -10%, #0a0a12 0%, #000000 65%)",
                fontFamily: "'Outfit', sans-serif",
            }}
        >
            {/* ── Top bar ──────────────────────────────────────── */}
            <header className="flex items-center justify-between px-8 py-5">
                <div>
                    <h1 style={{ letterSpacing: "0.28em", fontSize: 16, fontWeight: 300, color: "#cbd5e1", textTransform: "uppercase" }}>
                        Hey Buddy
                    </h1>
                    <p style={{ fontSize: 10, color: "#334155", letterSpacing: "0.2em", marginTop: 2 }}>
                        your ai companion
                    </p>
                </div>

                {initialized && (
                    <div className="flex items-center gap-5">
                        {/* Live API status */}
                        <StatusDot
                            status={liveStatus === "ready" ? "ok" : liveStatus === "connecting" ? "loading" : "err"}
                            label={liveStatus === "ready" ? "live · ready" : liveStatus === "connecting" ? "live connecting" : "live error"}
                        />
                        {/* Camera status */}
                        <StatusDot
                            status={camStatus === "on" ? "ok" : camStatus === "starting" ? "loading" : camStatus === "error" ? "err" : "off"}
                            label={camStatus === "on" ? `cam · ${frameCount}` : camStatus === "starting" ? "cam starting" : camStatus === "error" ? "cam error" : "cam off"}
                        />
                        {/* Voice status */}
                        <StatusDot
                            status={voiceStatus === "on" ? "ok" : voiceStatus === "error" ? "err" : "off"}
                            label={voiceStatus === "on" ? "🎙 always listening" : "mic off"}
                        />
                    </div>
                )}
            </header>

            {/* ── Orb + Camera Preview ─────────────────────────── */}
            <main className="flex-1 flex flex-col items-center justify-center gap-6 px-8 relative">
                {/* Floating Webcam Preview */}
                <div style={{ position: "absolute", top: 20, right: 30, zIndex: 10 }}>
                    <p style={{ fontSize: 9, color: "#334155", letterSpacing: "0.2em", marginBottom: 8, textAlign: "right" }}>
                        AI VISION
                    </p>
                    <WebcamPreview
                        stream={null}
                        active={camStatus === "on"}
                        emotion={displayState.lastEmotion}
                    />
                </div>

                <AssistantOrb
                    isListening={isListening && awake}
                    isSpeaking={isSpeaking}
                    emotion={displayState.lastEmotion}
                    audioLevel={audioLevel}
                />

                {/* State label */}
                <div style={{ fontSize: 11, letterSpacing: "0.3em", color: "#475569", textTransform: "uppercase", marginTop: -8 }}>
                    {isSpeaking ? "Speaking" : awake ? "Listening" : initialized ? "Idle" : ""}
                </div>

                {/* Transcript bubble */}
                {transcript && (
                    <div style={{
                        background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)",
                        borderRadius: 16, padding: "10px 18px", maxWidth: 420, textAlign: "center",
                        backdropFilter: "blur(8px)",
                    }}>
                        <p style={{ fontSize: 13, color: "#94a3b8", fontStyle: "italic" }}>"{transcript}"</p>
                    </div>
                )}

                {/* AI reply bubble */}
                {/* {ariaReply && (
                    <div style={{
                        background: "rgba(129, 140, 248, 0.08)", border: "1px solid rgba(129, 140, 248, 0.15)",
                        borderRadius: "16px 16px 16px 0px", padding: "14px 22px", maxWidth: 400,
                        textAlign: "left", backdropFilter: "blur(12px)",
                        boxShadow: "0 8px 32px rgba(0,0,0,0.2)",
                        animation: "fadeInUp 0.3s ease-out",
                    }}>
                        <p style={{ fontSize: 8, color: "#818cf8", letterSpacing: "0.2em", marginBottom: 6, fontWeight: 700 }}>SOOTHING COMPANION · JEE FOCUS</p>
                        <p style={{ fontSize: 13, color: "#cbd5e1", lineHeight: 1.6, fontWeight: 400 }}>{ariaReply}</p>
                    </div>
                )} */}

                {/* Welcome message when not yet fully ready */}
                {!initialized && (
                    <div style={{ textAlign: "center", marginTop: 24 }}>
                        <p style={{ fontSize: 12, color: "#475569" }}>
                            {statusMsg}
                        </p>
                    </div>
                )}
            </main>

            {/* ── Live stats bar ────────────────────────────────── */}
            {initialized && (
                <footer style={{
                    margin: "0 24px 24px",
                    background: "rgba(255,255,255,0.03)",
                    border: "1px solid rgba(255,255,255,0.07)",
                    borderRadius: 20, padding: "20px 28px",
                    backdropFilter: "blur(12px)",
                    display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24,
                }}>
                    {/* Left: visual bars */}
                    <div>
                        <p style={{ fontSize: 9, letterSpacing: "0.25em", color: "#334155", marginBottom: 14, textTransform: "uppercase" }}>
                            User State {frameCount > 0 && <span style={{ color: "#22d3ee" }}>· {frameCount} frames</span>}
                        </p>
                        <LiveBar label="Fatigue" pct={displayState.fatigue * 100} color="#f97316" />
                        <LiveBar label="Focus" pct={displayState.focus} color="#34d399" />
                        <LiveBar label="Distraction" pct={displayState.distraction} color="#f43f5e" />
                    </div>
                    {/* Right: context */}
                    <div>
                        <p style={{ fontSize: 9, letterSpacing: "0.25em", color: "#334155", marginBottom: 14, textTransform: "uppercase" }}>Context</p>
                        <ContextRow label="Screen" value={screenActivity} />
                        <ContextRow label="Emotion" value={displayState.lastEmotion} color={eColor} />
                        <ContextRow label="Memory" value={`${memoryStore.getAll().length} entries`} />
                        <ContextRow label="Last seen" value={lastUpdate > 0 ? new Date(lastUpdate).toLocaleTimeString() : "—"} />
                    </div>
                </footer>
            )}
        </div>
    );
};

/* ── Sub-components ───────────────────────────────────────── */

function LiveBar({ label, pct, color }: { label: string; pct: number; color: string }) {
    const clamped = Math.min(Math.max(pct, 0), 100);
    return (
        <div style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ fontSize: 11, color: "#64748b" }}>{label}</span>
                <span style={{ fontSize: 11, fontWeight: 600, color }}>{clamped.toFixed(0)}</span>
            </div>
            <div style={{ height: 4, background: "rgba(255,255,255,0.06)", borderRadius: 4, overflow: "hidden" }}>
                <div style={{
                    height: "100%", borderRadius: 4, background: color,
                    boxShadow: `0 0 8px ${color}88`,
                    width: `${clamped}%`,
                    transition: "width 0.4s ease",
                }} />
            </div>
        </div>
    );
}

function ContextRow({ label, value, color = "#64748b" }: { label: string; value: string; color?: string }) {
    return (
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 11, color: "#334155" }}>{label}</span>
            <span style={{ fontSize: 11, fontWeight: 500, color, textTransform: "capitalize" }}>{value}</span>
        </div>
    );
}

function StatusDot({ status, label }: { status: "ok" | "loading" | "err" | "off"; label: string }) {
    const colors = { ok: "#22d3ee", loading: "#fbbf24", err: "#f43f5e", off: "#334155" };
    return (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{
                width: 6, height: 6, borderRadius: "50%",
                background: colors[status],
                boxShadow: status === "ok" ? `0 0 6px ${colors.ok}` : "none",
                animation: status === "loading" ? "pulse 1s infinite" : "none",
            }} />
            <span style={{ fontSize: 10, color: "#475569", letterSpacing: "0.1em" }}>{label}</span>
        </div>
    );
}
