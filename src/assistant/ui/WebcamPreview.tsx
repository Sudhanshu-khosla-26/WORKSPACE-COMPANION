"use client";

import React, { useRef, useEffect } from "react";

interface WebcamPreviewProps {
    stream: MediaStream | null;
    active: boolean;
    emotion?: string;
}

export const WebcamPreview: React.FC<WebcamPreviewProps> = ({ active, emotion }) => {
    const videoRef = useRef<HTMLVideoElement>(null);

    return (
        <div style={{
            position: "relative",
            width: 180,
            height: 135,
            borderRadius: 16,
            overflow: "hidden",
            border: "2px solid rgba(255,255,255,0.1)",
            background: "#000",
            boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
            transition: "all 0.3s ease",
            opacity: active ? 1 : 0.4,
            filter: active ? "none" : "grayscale(1)",
        }}>
            {/* The Video Feed */}
            <video
                ref={videoRef}
                id="camera-preview-video"
                autoPlay
                muted
                playsInline
                style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                    transform: "scaleX(-1)", // Mirror
                }}
            />

            {/* Scanning Overlay Overlay */}
            <div style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                pointerEvents: "none",
                background: "linear-gradient(to bottom, transparent 95%, rgba(34, 211, 238, 0.2) 100%)",
                backgroundSize: "100% 40px",
                animation: "scan 3s linear infinite",
            }} />

            {/* Corner Accents */}
            <div style={{ position: "absolute", top: 10, left: 10, width: 8, height: 8, borderTop: "2px solid #22d3ee", borderLeft: "2px solid #22d3ee" }} />
            <div style={{ position: "absolute", top: 10, right: 10, width: 8, height: 8, borderTop: "2px solid #22d3ee", borderRight: "2px solid #22d3ee" }} />

            {/* Emotion Badge */}
            {active && emotion && (
                <div style={{
                    position: "absolute",
                    bottom: 8,
                    left: "50%",
                    transform: "translateX(-50%)",
                    background: "rgba(0,0,0,0.7)",
                    backdropFilter: "blur(4px)",
                    padding: "2px 8px",
                    borderRadius: 4,
                    fontSize: 9,
                    color: "#22d3ee",
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    border: "1px solid rgba(34, 211, 238, 0.3)",
                }}>
                    {emotion}
                </div>
            )}

            <style>{`
                @keyframes scan {
                    from { transform: translateY(-100%); }
                    to { transform: translateY(100%); }
                }
            `}</style>
        </div>
    );
};
