"use client";

import React, { useEffect, useRef } from "react";

interface Props {
    isListening: boolean;
    isSpeaking: boolean;
    emotion?: string;
    audioLevel?: number;
}

/**
 * Siri-inspired glass orb with breathing gradient animation.
 * Pure monochromatic white/blue — follows WORKSPACE design guidelines.
 */
export const AssistantOrb: React.FC<Props> = ({
    isListening,
    isSpeaking,
    emotion = "neutral",
    audioLevel = 0,
}) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const animRef = useRef<number>(0);
    const timeRef = useRef<number>(0);

    // Siri-like color palettes
    const getColors = () => {
        if (isSpeaking) return ["#38bdf8", "#818cf8", "#c084fc", "#e879f9"];
        if (isListening) return ["#3b82f6", "#6366f1", "#8b5cf6"];
        // Emotion-based subtle shifts
        switch (emotion) {
            case "happy": return ["#fbbf24", "#f59e0b", "#eab308"];
            case "sad": return ["#3b82f6", "#1d4ed8", "#1e40af"];
            case "angry": return ["#ef4444", "#dc2626", "#b91c1c"];
            case "tired": return ["#64748b", "#475569", "#334155"];
            default: return ["#6366f1", "#8b5cf6", "#a78bfa"];
        }
    };

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d")!;
        const SIZE = 120;
        canvas.width = SIZE;
        canvas.height = SIZE;
        const cx = SIZE / 2;
        const cy = SIZE / 2;
        const R = SIZE * 0.32;

        function drawFrame() {
            timeRef.current += 0.016;
            const t = timeRef.current;
            ctx.clearRect(0, 0, SIZE, SIZE);

            const colors = getColors();
            const speed = isSpeaking ? 3 : isListening ? 1.5 : 0.6;
            const phase = t * speed;

            // ── Outer glow aura (breathing) ─────────────────────────────
            const auraScale = 1 + Math.sin(phase * 0.7) * 0.08;
            const auraR = R * 2.2 * auraScale;
            const auraGrad = ctx.createRadialGradient(cx, cy, R * 0.5, cx, cy, auraR);
            auraGrad.addColorStop(0, colors[0] + "30");
            auraGrad.addColorStop(0.5, colors[1 % colors.length] + "15");
            auraGrad.addColorStop(1, "transparent");
            ctx.beginPath();
            ctx.arc(cx, cy, auraR, 0, Math.PI * 2);
            ctx.fillStyle = auraGrad;
            ctx.fill();

            // ── Siri wave ring (when speaking) ──────────────────────────
            if (isSpeaking) {
                const wavePoints = 64;
                ctx.beginPath();
                for (let i = 0; i <= wavePoints; i++) {
                    const angle = (i / wavePoints) * Math.PI * 2;
                    const waveAmp = R * 0.15 * (0.3 + audioLevel * 0.7);
                    const wave = Math.sin(angle * 6 + phase * 4) * waveAmp
                        + Math.sin(angle * 3 + phase * 2.5) * waveAmp * 0.5;
                    const rr = R + 8 + wave;
                    const x = cx + Math.cos(angle) * rr;
                    const y = cy + Math.sin(angle) * rr;
                    if (i === 0) ctx.moveTo(x, y);
                    else ctx.lineTo(x, y);
                }
                ctx.closePath();
                const waveGrad = ctx.createLinearGradient(cx - R, cy, cx + R, cy);
                waveGrad.addColorStop(0, colors[0] + "80");
                waveGrad.addColorStop(0.5, colors[1 % colors.length] + "60");
                waveGrad.addColorStop(1, colors[2 % colors.length] + "80");
                ctx.strokeStyle = waveGrad;
                ctx.lineWidth = 2.5;
                ctx.stroke();
            }

            // ── Listening ring (subtle) ─────────────────────────────────
            if (isListening && !isSpeaking) {
                ctx.beginPath();
                ctx.arc(cx, cy, R + 6 + Math.sin(phase * 2) * 2, 0, Math.PI * 2);
                ctx.strokeStyle = colors[0] + "35";
                ctx.lineWidth = 1.5;
                ctx.stroke();
            }

            // ── Core sphere ─────────────────────────────────────────────
            const pulse = isSpeaking
                ? 1 + Math.sin(phase * 4) * 0.04 * (1 + audioLevel)
                : 1 + Math.sin(phase) * 0.02;
            const coreR = R * pulse;

            // Multi-stop gradient sphere (glass effect)
            const sphereGrad = ctx.createRadialGradient(
                cx - coreR * 0.25, cy - coreR * 0.3, coreR * 0.05,
                cx, cy, coreR
            );
            sphereGrad.addColorStop(0, "#ffffff40");
            sphereGrad.addColorStop(0.15, colors[0] + "cc");
            sphereGrad.addColorStop(0.45, colors[1 % colors.length] + "aa");
            sphereGrad.addColorStop(0.75, colors[2 % colors.length] + "88");
            sphereGrad.addColorStop(1, "#00000080");

            ctx.beginPath();
            ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
            ctx.fillStyle = sphereGrad;
            ctx.fill();

            // ── Glass highlight (top-left specular) ─────────────────────
            const hlGrad = ctx.createRadialGradient(
                cx - coreR * 0.3, cy - coreR * 0.35, 0,
                cx - coreR * 0.1, cy - coreR * 0.1, coreR * 0.5
            );
            hlGrad.addColorStop(0, "rgba(255,255,255,0.5)");
            hlGrad.addColorStop(0.3, "rgba(255,255,255,0.12)");
            hlGrad.addColorStop(1, "transparent");
            ctx.beginPath();
            ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
            ctx.fillStyle = hlGrad;
            ctx.fill();

            animRef.current = requestAnimationFrame(drawFrame);
        }

        animRef.current = requestAnimationFrame(drawFrame);
        return () => cancelAnimationFrame(animRef.current);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isListening, isSpeaking, emotion, audioLevel]);

    return (
        <div
            style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 6,
                userSelect: "none",
            }}
        >
            <canvas
                ref={canvasRef}
                width={120}
                height={120}
                style={{ background: "transparent" }}
            />
            <span
                style={{
                    fontSize: 9,
                    fontWeight: 500,
                    letterSpacing: "0.2em",
                    textTransform: "uppercase" as const,
                    color: isSpeaking
                        ? "#38bdf8"
                        : isListening
                            ? "#6366f1"
                            : "#475569",
                }}
            >
                {isSpeaking ? "speaking…" : isListening ? "listening…" : "idle"}
            </span>
        </div>
    );
};
