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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const electronAPI = typeof window !== "undefined" ? (window as any).electronAPI : null;

    // Toggle click-through when mouse enters/leaves interactive areas
    const handleMouseEnter = () => electronAPI?.setInteractive?.(true);
    const handleMouseLeave = () => electronAPI?.setInteractive?.(false);

    return (
        <div
            style={{
                position: "fixed",
                inset: 0,
                background: "transparent",
                fontFamily: "'Outfit', sans-serif",
                overflow: "hidden",
                pointerEvents: "none", // entire overlay is click-through by default
            }}
        >
            {/* ── GREEN SCREEN BORDER (like macOS recording) ────────── */}
            {initialized && camStatus === "on" && (
                <>
                    <div style={{
                        position: "fixed", top: 0, left: 0, right: 0, height: 3,
                        background: "linear-gradient(90deg, transparent, #22c55e, transparent)",
                        boxShadow: "0 0 12px rgba(34,197,94,0.5), 0 0 30px rgba(34,197,94,0.2)",
                        animation: "borderPulse 3s ease-in-out infinite",
                        zIndex: 9999,
                    }} />
                    <div style={{
                        position: "fixed", bottom: 0, left: 0, right: 0, height: 3,
                        background: "linear-gradient(90deg, transparent, #22c55e, transparent)",
                        boxShadow: "0 2px 12px rgba(34,197,94,0.5)",
                        animation: "borderPulse 3s ease-in-out infinite",
                        zIndex: 9999,
                    }} />
                    <div style={{
                        position: "fixed", top: 0, left: 0, bottom: 0, width: 3,
                        background: "linear-gradient(180deg, transparent, #22c55e, transparent)",
                        boxShadow: "-2px 0 12px rgba(34,197,94,0.5)",
                        animation: "borderPulse 3s ease-in-out infinite",
                        zIndex: 9999,
                    }} />
                    <div style={{
                        position: "fixed", top: 0, right: 0, bottom: 0, width: 3,
                        background: "linear-gradient(180deg, transparent, #22c55e, transparent)",
                        boxShadow: "2px 0 12px rgba(34,197,94,0.5)",
                        animation: "borderPulse 3s ease-in-out infinite",
                        zIndex: 9999,
                    }} />
                </>
            )}

            {/* ── BUDDY ORB (bottom-right corner) ──────────────────── */}
            <div
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
                style={{
                    position: "fixed",
                    bottom: 30,
                    right: 30,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 12,
                    zIndex: 10000,
                    pointerEvents: "auto", // interactive zone
                }}
            >
                {/* Webcam preview */}
                <WebcamPreview
                    stream={null}
                    active={camStatus === "on"}
                    emotion={displayState.lastEmotion}
                />

                {/* The Orb */}
                <AssistantOrb
                    isListening={isListening && awake}
                    isSpeaking={isSpeaking}
                    emotion={displayState.lastEmotion}
                    audioLevel={audioLevel}
                />

                {/* Compact status line */}
                {initialized && (
                    <div style={{
                        display: "flex", gap: 8, alignItems: "center",
                        background: "rgba(0,0,0,0.6)",
                        backdropFilter: "blur(12px)",
                        borderRadius: 20,
                        padding: "4px 12px",
                        border: "1px solid rgba(255,255,255,0.06)",
                    }}>
                        <StatusDot
                            status={liveStatus === "ready" ? "ok" : liveStatus === "connecting" ? "loading" : "err"}
                            label=""
                        />
                        <StatusDot
                            status={camStatus === "on" ? "ok" : camStatus === "error" ? "err" : "off"}
                            label=""
                        />
                        <StatusDot
                            status={voiceStatus === "on" ? "ok" : "off"}
                            label=""
                        />
                        <span style={{ fontSize: 9, color: "#64748b", letterSpacing: "0.1em" }}>
                            {displayState.lastEmotion}
                        </span>
                    </div>
                )}
            </div>

            {/* ── FLOATING STATS (top-right, small) ────────────────── */}
            {initialized && (
                <div
                    onMouseEnter={handleMouseEnter}
                    onMouseLeave={handleMouseLeave}
                    style={{
                        position: "fixed",
                        top: 20,
                        right: 20,
                        background: "rgba(0,0,0,0.65)",
                        backdropFilter: "blur(16px)",
                        borderRadius: 14,
                        padding: "10px 16px",
                        border: "1px solid rgba(255,255,255,0.06)",
                        zIndex: 10000,
                        pointerEvents: "auto",
                        minWidth: 140,
                    }}
                >
                    <p style={{ fontSize: 8, color: "#475569", letterSpacing: "0.2em", marginBottom: 8, textTransform: "uppercase" }}>
                        buddy · live
                    </p>
                    <LiveBar label="Fatigue" pct={displayState.fatigue * 100} color="#f97316" />
                    <LiveBar label="Focus" pct={displayState.focus} color="#34d399" />
                    <LiveBar label="Distraction" pct={displayState.distraction} color="#f43f5e" />
                </div>
            )}

            {/* ── Transcript bubble (floating center-bottom) ───────── */}
            {transcript && (
                <div style={{
                    position: "fixed",
                    bottom: 200,
                    left: "50%",
                    transform: "translateX(-50%)",
                    background: "rgba(0,0,0,0.7)",
                    backdropFilter: "blur(12px)",
                    border: "1px solid rgba(255,255,255,0.08)",
                    borderRadius: 16,
                    padding: "8px 20px",
                    maxWidth: 420,
                    textAlign: "center",
                    zIndex: 10000,
                    pointerEvents: "none",
                }}>
                    <p style={{ fontSize: 13, color: "#94a3b8", fontStyle: "italic" }}>"{transcript}"</p>
                </div>
            )}

            {/* ── Init screen (only before ready) ──────────────────── */}
            {!initialized && (
                <div style={{
                    position: "fixed",
                    inset: 0,
                    display: "flex",
                    flexDirection: "column",
                    justifyContent: "center",
                    alignItems: "center",
                    background: "rgba(0,0,0,0.95)",
                    zIndex: 99999,
                    pointerEvents: "auto",
                }}>
                    <div style={{
                        width: 60, height: 60, borderRadius: "50%",
                        border: "2px solid rgba(99,102,241,0.3)",
                        borderTopColor: "#6366f1",
                        animation: "spin 1s linear infinite",
                    }} />
                    <p style={{ fontSize: 12, color: "#475569", marginTop: 20, letterSpacing: "0.15em" }}>
                        {statusMsg}
                    </p>
                </div>
            )}

            {/* ── Keyframe styles ──────────────────────────────────── */}
            <style>{`
                @keyframes borderPulse {
                    0%, 100% { opacity: 0.7; }
                    50% { opacity: 1; }
                }
                @keyframes spin {
                    to { transform: rotate(360deg); }
                }
                @keyframes fadeInUp {
                    from { opacity: 0; transform: translateY(10px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                @keyframes pulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.4; }
                }
            `}</style>
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
