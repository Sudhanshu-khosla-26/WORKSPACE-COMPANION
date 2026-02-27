"use client";

import React, { useEffect, useRef, useState } from "react";

interface Props {
    isListening: boolean;
    isSpeaking: boolean;
    emotion?: string;
    audioLevel?: number; // 0-1 for live mic amplitude
}

/* ── Colour palettes per state ─────────────────────────── */
const IDLE_COLORS = ["#6366f1", "#a855f7", "#3b82f6"];
const LISTEN_COLORS = ["#10b981", "#06b6d4", "#3b82f6"];
const SPEAK_COLORS = ["#38bdf8", "#818cf8", "#c084fc", "#f472b6"];
const EMOTION_COLORS: Record<string, string[]> = {
    sad: ["#1e40af", "#3730a3", "#312e81"],
    angry: ["#dc2626", "#b91c1c", "#f97316"],
    fear: ["#7c3aed", "#4c1d95", "#1e1b4b"],
    happy: ["#fbbf24", "#f59e0b", "#d97706"],
    surprised: ["#f472b6", "#ec4899", "#db2777"],
    disgust: ["#15803d", "#166534", "#14532d"],
    neutral: ["#6366f1", "#a855f7", "#3b82f6"],
};

export const AssistantOrb: React.FC<Props> = ({
    isListening,
    isSpeaking,
    emotion = "neutral",
    audioLevel = 0,
}) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const animRef = useRef<number>(0);
    const tRef = useRef<number>(0);
    const phaseRef = useRef<number>(0);

    const state = isSpeaking ? "speak" : isListening ? "listen" : "idle";

    const getColors = () => {
        if (isSpeaking) return SPEAK_COLORS;
        if (isListening) return LISTEN_COLORS;
        return EMOTION_COLORS[emotion] ?? IDLE_COLORS;
    };

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d")!;
        const W = canvas.width;
        const H = canvas.height;
        const cx = W / 2;
        const cy = H / 2;
        const R = W * 0.30;

        const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

        function drawFrame() {
            tRef.current += 0.016;
            phaseRef.current += isSpeaking ? 0.08 + audioLevel * 0.06 : 0.02;
            const t = tRef.current;
            const p = phaseRef.current;

            ctx.clearRect(0, 0, W, H);

            const colors = getColors();

            /* ── outer ring glow ─────────────────────────────── */
            const rings = isSpeaking ? 3 : isListening ? 2 : 1;
            for (let i = 0; i < rings; i++) {
                const alpha = 0.12 - i * 0.04;
                const scale = 1 + i * 0.18 + (Math.sin(p + i * 1.2) * 0.04);
                const rg = ctx.createRadialGradient(cx, cy, R * 0.5 * scale, cx, cy, R * 1.6 * scale);
                rg.addColorStop(0, colors[0] + "44");
                rg.addColorStop(1, "transparent");
                ctx.beginPath();
                ctx.arc(cx, cy, R * 1.6 * scale, 0, Math.PI * 2);
                ctx.fillStyle = rg;
                ctx.globalAlpha = alpha + Math.sin(p * 0.7 + i) * 0.04;
                ctx.fill();
            }
            ctx.globalAlpha = 1;

            /* ── blob / spoke layers ─────────────────────────── */
            const numSpokes = isSpeaking ? 6 : isListening ? 4 : 3;
            for (let s = 0; s < numSpokes; s++) {
                const angle = (s / numSpokes) * Math.PI * 2 + p * (s % 2 === 0 ? 1 : -1) * 0.4;
                const spokeLen = R * (0.55 + Math.sin(p * 1.3 + s * 0.9) * (isSpeaking ? 0.35 + audioLevel * 0.25 : 0.12));
                const x2 = cx + Math.cos(angle) * spokeLen;
                const y2 = cy + Math.sin(angle) * spokeLen;

                const sg = ctx.createLinearGradient(cx, cy, x2, y2);
                sg.addColorStop(0, colors[s % colors.length] + "cc");
                sg.addColorStop(1, colors[(s + 1) % colors.length] + "00");

                ctx.beginPath();
                ctx.moveTo(cx, cy);
                // Bezier for organic shape
                const cpx = cx + Math.cos(angle + 0.4) * spokeLen * 0.6;
                const cpy = cy + Math.sin(angle + 0.4) * spokeLen * 0.6;
                ctx.quadraticCurveTo(cpx, cpy, x2, y2);
                ctx.lineWidth = 16 * (isSpeaking ? 1.2 + audioLevel : 0.7);
                ctx.strokeStyle = sg;
                ctx.globalAlpha = 0.6 + Math.sin(p + s) * 0.2;
                ctx.lineCap = "round";
                ctx.stroke();
            }
            ctx.globalAlpha = 1;

            /* ── core sphere gradient ────────────────────────── */
            const pulseFactor = isSpeaking
                ? 1 + Math.sin(p * 5) * (0.04 + audioLevel * 0.06)
                : isListening
                    ? 1 + Math.sin(p * 2) * 0.025
                    : 1 + Math.sin(p * 0.8) * 0.01;

            const coreR = R * pulseFactor;

            // base chromatic sphere
            const g = ctx.createRadialGradient(
                cx - coreR * 0.25, cy - coreR * 0.25, coreR * 0.05,
                cx, cy, coreR
            );
            g.addColorStop(0, "#ffffff55");
            g.addColorStop(0.2, colors[0] + "dd");
            g.addColorStop(0.55, colors[1 % colors.length] + "bb");
            g.addColorStop(0.85, colors[2 % colors.length] + "99");
            g.addColorStop(1, "#00000099");

            ctx.beginPath();
            ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
            ctx.fillStyle = g;
            ctx.fill();

            /* ── inner specular highlight ─────────────────────── */
            const hg = ctx.createRadialGradient(
                cx - coreR * 0.3, cy - coreR * 0.35, 0,
                cx - coreR * 0.1, cy - coreR * 0.1, coreR * 0.55
            );
            hg.addColorStop(0, "rgba(255,255,255,0.55)");
            hg.addColorStop(0.4, "rgba(255,255,255,0.10)");
            hg.addColorStop(1, "transparent");

            ctx.beginPath();
            ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
            ctx.fillStyle = hg;
            ctx.fill();

            /* ── waveform bars around the sphere (speaking) ──── */
            if (isSpeaking) {
                const bars = 32;
                for (let b = 0; b < bars; b++) {
                    const ang = (b / bars) * Math.PI * 2;
                    const bh = (R * 0.18) * (0.3 + Math.abs(Math.sin(p * 4 + b * 0.5 + audioLevel * 8)) * 0.7);
                    const x1 = cx + Math.cos(ang) * (coreR + 4);
                    const y1 = cy + Math.sin(ang) * (coreR + 4);
                    const x2 = cx + Math.cos(ang) * (coreR + 4 + bh);
                    const y2 = cy + Math.sin(ang) * (coreR + 4 + bh);
                    ctx.beginPath();
                    ctx.moveTo(x1, y1);
                    ctx.lineTo(x2, y2);
                    ctx.lineWidth = 2.5;
                    ctx.strokeStyle = colors[b % colors.length] + "cc";
                    ctx.globalAlpha = 0.5 + audioLevel * 0.5;
                    ctx.stroke();
                }
                ctx.globalAlpha = 1;
            }

            animRef.current = requestAnimationFrame(drawFrame);
        }

        animRef.current = requestAnimationFrame(drawFrame);
        return () => cancelAnimationFrame(animRef.current);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isListening, isSpeaking, emotion, audioLevel]);

    const label =
        isSpeaking ? "Speaking…"
            : isListening ? "Listening…"
                : "Idle";

    const labelClass =
        isSpeaking ? "text-cyan-300"
            : isListening ? "text-emerald-400"
                : "text-slate-500";

    return (
        <div className="flex flex-col items-center justify-center gap-3 select-none">
            {/* Outer glow ring */}
            <div className="relative flex items-center justify-center">
                {(isSpeaking || isListening) && (
                    <div
                        className="absolute rounded-full ring-expand pointer-events-none"
                        style={{
                            width: 240,
                            height: 240,
                            background: isSpeaking
                                ? "radial-gradient(circle, rgba(56,189,248,0.15) 0%, transparent 70%)"
                                : "radial-gradient(circle, rgba(16,185,129,0.12) 0%, transparent 70%)",
                        }}
                    />
                )}
                <canvas
                    ref={canvasRef}
                    width={240}
                    height={240}
                    className="rounded-full"
                    style={{ background: "transparent" }}
                />
            </div>

            {/* Status label */}
            <span className={`text-xs font-medium tracking-[0.2em] uppercase ${labelClass}`}>
                {label}
            </span>
        </div>
    );
};
