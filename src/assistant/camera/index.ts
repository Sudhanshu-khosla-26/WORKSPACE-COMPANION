export interface FaceAnalysisResult {
    fatigue_score: number;
    gaze_direction: string;
    distraction_score: number;
    blink_rate: number;
    emotion?: string;
    emotion_confidence?: number;
}

export class CameraCapture {
    private video: HTMLVideoElement | null = null;
    private canvas: HTMLCanvasElement | null = null;
    private stream: MediaStream | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private running = false;
    private framesSent = 0;
    private onResult: (r: FaceAnalysisResult) => void;
    private onFrame?: (dataUrl: string) => void;

    constructor(
        onResult: (r: FaceAnalysisResult) => void,
        onFrame?: (dataUrl: string) => void
    ) {
        this.onResult = onResult;
        this.onFrame = onFrame;
    }

    async start(previewVideo?: HTMLVideoElement): Promise<void> {
        console.log("[Camera] requesting getUserMedia...");

        this.stream = await navigator.mediaDevices.getUserMedia({
            video: { width: 320, height: 240, facingMode: "user" },
            audio: false,
        });
        console.log("[Camera] stream granted:", this.stream.id);

        // If preview element provided by React/UI, use it
        if (previewVideo) {
            this.video = previewVideo;
        } else {
            this.video = document.createElement("video");
        }

        this.video.srcObject = this.stream;
        this.video.muted = true;
        this.video.playsInline = true;
        this.video.setAttribute("playsinline", "");
        await this.video.play();
        console.log("[Camera] video playing");

        this.canvas = document.createElement("canvas");
        this.canvas.width = 320;
        this.canvas.height = 240;

        // Wait until real frames arrive (videoWidth > 0)
        await new Promise<void>(resolve => {
            const check = () => {
                if (this.video && this.video.videoWidth > 0 && this.video.readyState >= 2) {
                    console.log(`[Camera] first frame ready — ${this.video.videoWidth}×${this.video.videoHeight}`);
                    resolve();
                } else {
                    requestAnimationFrame(check);
                }
            };
            check();
        });

        this.running = true;
        // 5 FPS = 200ms
        this.timer = setInterval(() => this.capture(), 200);
        console.log("[Camera] capture loop started at 5fps");
    }

    stop() {
        this.running = false;
        if (this.timer) clearInterval(this.timer);
        this.stream?.getTracks().forEach(t => t.stop());
        this.video = null;
        this.canvas = null;
        console.log("[Camera] stopped");
    }

    private async capture() {
        if (!this.running || !this.video || !this.canvas) return;
        if (this.video.readyState < 2 || this.video.videoWidth === 0) return;

        const ctx = this.canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(this.video, 0, 0, 320, 240);
        this.framesSent++;

        if (this.framesSent % 25 === 0) {
            console.log(`[Camera] ${this.framesSent} frames captured`);
        }

        // Get blob
        const blob = await new Promise<Blob | null>(res =>
            this.canvas!.toBlob(res, "image/jpeg", 0.75)
        );
        if (!blob) return;

        // Save via Electron IPC
        if (this.onFrame) {
            const reader = new FileReader();
            reader.onloadend = () => { if (reader.result) this.onFrame!(reader.result as string); };
            reader.readAsDataURL(blob);
        }

        // Send to backend3
        try {
            const form = new FormData();
            form.append("file", blob, "frame.jpg");

            const ctrl = new AbortController();
            const tid = setTimeout(() => ctrl.abort(), 3000);

            const res = await fetch("http://localhost:8000/analyze-face", {
                method: "POST",
                body: form,
                signal: ctrl.signal,
            });
            clearTimeout(tid);

            if (res.ok) {
                const data: FaceAnalysisResult = await res.json();
                if (this.framesSent % 5 === 0) { // log every second
                    console.log(`[Camera] result → emotion:${data.emotion} fatigue:${data.fatigue_score?.toFixed(2)} dist:${data.distraction_score?.toFixed(1)}`);
                }
                this.onResult(data);
            }
        } catch (e) {
            if ((e as Error).name !== "AbortError") {
                console.warn("[Camera] fetch failed:", (e as Error).message);
            }
        }
    }
}
