"use client";

import React from "react";

interface WebcamPreviewProps {
    stream: MediaStream | null;
    active: boolean;
    emotion?: string;
}

export const WebcamPreview: React.FC<WebcamPreviewProps> = ({ active, emotion }) => {
    return (
        <div style={{
            position: "relative",
            width: 140,
            height: 105,
            borderRadius: 12,
            overflow: "hidden",
            background: "#000",
            transition: "all 0.4s ease",
            opacity: active ? 1 : 0.3,
            filter: active ? "none" : "grayscale(1)",
            // Green glow border when camera is ON (like macOS indicator)
            border: active
                ? "2px solid rgba(34, 197, 94, 0.8)"
                : "2px solid rgba(255,255,255,0.08)",
            boxShadow: active
                ? "0 0 12px rgba(34, 197, 94, 0.4), 0 0 30px rgba(34, 197, 94, 0.15), 0 8px 24px rgba(0,0,0,0.4)"
                : "0 8px 24px rgba(0,0,0,0.4)",
        }}>
            {/* Green indicator dot (like macOS) */}
            {active && (
                <div style={{
                    position: "absolute",
                    top: 8,
                    right: 8,
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: "#22c55e",
                    boxShadow: "0 0 6px #22c55e, 0 0 12px rgba(34, 197, 94, 0.5)",
                    animation: "greenPulse 2s ease-in-out infinite",
                    zIndex: 10,
                }} />
            )}

            {/* The Video Feed */}
            <video
                id="camera-preview-video"
                autoPlay
                muted
                playsInline
                style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                    transform: "scaleX(-1)",
                }}
            />

            {/* Scanning Overlay */}
            {active && (
                <div style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    pointerEvents: "none",
                    background: "linear-gradient(to bottom, transparent 90%, rgba(34, 197, 94, 0.15) 100%)",
                    backgroundSize: "100% 30px",
                    animation: "scan 4s linear infinite",
                }} />
            )}

            {/* Corner Accents (green when active) */}
            <div style={{
                position: "absolute", top: 6, left: 6, width: 10, height: 10,
                borderTop: `2px solid ${active ? "rgba(34, 197, 94, 0.7)" : "rgba(255,255,255,0.1)"}`,
                borderLeft: `2px solid ${active ? "rgba(34, 197, 94, 0.7)" : "rgba(255,255,255,0.1)"}`,
                transition: "border-color 0.3s ease",
            }} />
            <div style={{
                position: "absolute", top: 6, right: 6, width: 10, height: 10,
                borderTop: `2px solid ${active ? "rgba(34, 197, 94, 0.7)" : "rgba(255,255,255,0.1)"}`,
                borderRight: `2px solid ${active ? "rgba(34, 197, 94, 0.7)" : "rgba(255,255,255,0.1)"}`,
                transition: "border-color 0.3s ease",
            }} />
            <div style={{
                position: "absolute", bottom: 6, left: 6, width: 10, height: 10,
                borderBottom: `2px solid ${active ? "rgba(34, 197, 94, 0.7)" : "rgba(255,255,255,0.1)"}`,
                borderLeft: `2px solid ${active ? "rgba(34, 197, 94, 0.7)" : "rgba(255,255,255,0.1)"}`,
                transition: "border-color 0.3s ease",
            }} />
            <div style={{
                position: "absolute", bottom: 6, right: 6, width: 10, height: 10,
                borderBottom: `2px solid ${active ? "rgba(34, 197, 94, 0.7)" : "rgba(255,255,255,0.1)"}`,
                borderRight: `2px solid ${active ? "rgba(34, 197, 94, 0.7)" : "rgba(255,255,255,0.1)"}`,
                transition: "border-color 0.3s ease",
            }} />

            {/* Emotion Badge */}
            {active && emotion && (
                <div style={{
                    position: "absolute",
                    bottom: 6,
                    left: "50%",
                    transform: "translateX(-50%)",
                    background: "rgba(0,0,0,0.75)",
                    backdropFilter: "blur(6px)",
                    padding: "2px 10px",
                    borderRadius: 6,
                    fontSize: 9,
                    color: "#22c55e",
                    letterSpacing: "0.12em",
                    textTransform: "uppercase",
                    fontWeight: 600,
                    border: "1px solid rgba(34, 197, 94, 0.25)",
                }}>
                    {emotion}
                </div>
            )}

            <style>{`
                @keyframes scan {
                    from { transform: translateY(-100%); }
                    to { transform: translateY(100%); }
                }
                @keyframes greenPulse {
                    0%, 100% { opacity: 1; box-shadow: 0 0 6px #22c55e, 0 0 12px rgba(34, 197, 94, 0.5); }
                    50% { opacity: 0.7; box-shadow: 0 0 3px #22c55e, 0 0 8px rgba(34, 197, 94, 0.3); }
                }
            `}</style>
        </div>
    );
};
