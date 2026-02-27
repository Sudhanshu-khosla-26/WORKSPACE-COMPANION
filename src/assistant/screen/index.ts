export interface ScreenAnalysisResult {
    activity: string;
    distraction_score?: number;
}

export class ScreenCapture {
    private videoElement: HTMLVideoElement | null = null;
    private canvasElement: HTMLCanvasElement | null = null;
    private stream: MediaStream | null = null;
    private intervalId: ReturnType<typeof setInterval> | null = null;
    private onResult: (result: ScreenAnalysisResult) => void;

    constructor(onResult: (result: ScreenAnalysisResult) => void) {
        this.onResult = onResult;
    }

    async start() {
        try {
            this.stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            this.videoElement = document.createElement("video");
            this.videoElement.srcObject = this.stream;
            this.videoElement.play();

            this.canvasElement = document.createElement("canvas");

            await new Promise<void>((resolve) => {
                if (this.videoElement) {
                    this.videoElement.onplaying = () => resolve();
                }
            });

            this.intervalId = setInterval(() => this.captureAndSend(), 5000);
        } catch (e) {
            console.error("Screen capture failed", e);
        }
    }

    stop() {
        if (this.intervalId) clearInterval(this.intervalId);
        if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    }

    private async captureAndSend() {
        if (!this.videoElement || !this.canvasElement) return;

        this.canvasElement.width = this.videoElement.videoWidth;
        this.canvasElement.height = this.videoElement.videoHeight;
        const ctx = this.canvasElement.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(this.videoElement, 0, 0);

        const blob = await new Promise<Blob | null>((res) =>
            this.canvasElement?.toBlob(res, "image/jpeg", 0.6)
        );
        if (!blob) return;

        try {
            const formData = new FormData();
            formData.append("file", blob, "screen.jpg");
            const baseUrl = process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";
            const res = await fetch(`${baseUrl}/analyze-screen`, {
                method: "POST",
                body: formData,
            });
            if (res.ok) {
                const data: ScreenAnalysisResult = await res.json();
                this.onResult(data);
            }
        } catch {
            // silently ignore
        }
    }
}
