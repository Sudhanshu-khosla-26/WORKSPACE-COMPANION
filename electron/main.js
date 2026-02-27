const { app, BrowserWindow, ipcMain, session, protocol } = require("electron");
const path = require("path");
const fs = require("fs");

// ── Register custom protocol BEFORE app.ready ─────────────────────────────────
protocol.registerSchemesAsPrivileged([
    {
        scheme: "app",
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            corsEnabled: true,
        },
    },
]);

// ── Chromium flags (BEFORE app ready) ─────────────────────────────────────────
app.commandLine.appendSwitch("unsafely-treat-insecure-origin-as-secure", "http://localhost:3000");
app.commandLine.appendSwitch("allow-insecure-localhost", "true");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
app.commandLine.appendSwitch("enable-speech-dispatcher");
app.commandLine.appendSwitch("enable-features", "WebRTC,MediaFoundationH264Encoding");
app.commandLine.appendSwitch("enable-speech-input-notifications");
app.commandLine.appendSwitch("ignore-certificate-errors");

let mainWindow;

const framesDir = path.join(app.getPath("userData"), "captured_frames");
if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir, { recursive: true });
console.log("[Electron] frames dir:", framesDir);

// ── MIME type map for custom protocol ─────────────────────────────────────────
const MIME_TYPES = {
    ".html": "text/html",
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".eot": "application/vnd.ms-fontobject",
    ".webp": "image/webp",
    ".webm": "video/webm",
    ".mp4": "video/mp4",
    ".map": "application/json",
    ".txt": "text/plain",
};

function getMimeType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return MIME_TYPES[ext] || "application/octet-stream";
}

// ── Create the main window ────────────────────────────────────────────────────
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 650,
        backgroundColor: "#000000",
        autoHideMenuBar: true,
        title: "Hey Buddy",
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            webSecurity: true,
            allowRunningInsecureContent: true,
            preload: path.join(__dirname, "preload.js"),
        },
    });

    if (app.isPackaged) {
        mainWindow.loadURL("app://./index.html");
    } else {
        mainWindow.loadURL("http://localhost:3000");
    }

    mainWindow.webContents.on("did-finish-load", () => {
        console.log("[Electron] page loaded ✓");
    });

    mainWindow.webContents.on("did-fail-load", (_e, code, desc) => {
        console.error("[Electron] page failed to load:", code, desc);
        if (!app.isPackaged) {
            setTimeout(() => mainWindow.reload(), 2000);
        }
    });

    // Ctrl+Shift+I to toggle DevTools in production
    mainWindow.webContents.on("before-input-event", (_event, input) => {
        if (input.control && input.shift && input.key === "I") {
            mainWindow.webContents.toggleDevTools();
        }
    });
}

// ── App ready ─────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
    // Register the custom 'app' protocol handler for production builds
    protocol.handle("app", (request) => {
        const url = new URL(request.url);
        let filePath = decodeURIComponent(url.pathname);

        // Normalize: app://./index.html → /index.html
        if (filePath.startsWith("/.")) filePath = filePath.substring(2);
        if (filePath === "/" || filePath === "") filePath = "/index.html";

        const fullPath = path.normalize(path.join(__dirname, "..", "out", filePath));
        console.log("[Protocol]", request.url, "→", fullPath);

        // Check if file exists
        if (!fs.existsSync(fullPath)) {
            console.error("[Protocol] FILE NOT FOUND:", fullPath);
            // Try index.html for SPA routing fallback
            const fallback = path.join(__dirname, "..", "out", "index.html");
            if (fs.existsSync(fallback)) {
                return new Response(fs.readFileSync(fallback), {
                    headers: { "Content-Type": "text/html" },
                });
            }
            return new Response("Not Found", { status: 404 });
        }

        const mimeType = getMimeType(fullPath);
        const data = fs.readFileSync(fullPath);
        return new Response(data, {
            headers: { "Content-Type": mimeType },
        });
    });

    // ── Grant ALL media permissions ───────────────────────────────────────────
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
        const allowed = [
            "media", "audioCapture", "videoCapture",
            "display-capture", "geolocation", "notifications",
        ];
        console.log("[Electron] permission requested:", permission);
        callback(allowed.includes(permission) || true);
    });

    session.defaultSession.setPermissionCheckHandler(() => true);

    // OS level permission request (Windows/macOS)
    try {
        const { systemPreferences } = require("electron");
        if (systemPreferences.askForMediaAccess) {
            await systemPreferences.askForMediaAccess("microphone");
            await systemPreferences.askForMediaAccess("camera");
        }
    } catch (e) {
        console.warn("[Electron] systemPreferences error:", e);
    }

    createWindow();
});

// ── IPC: save captured frame to disk ──────────────────────────────────────────
ipcMain.on("save-frame", (_event, dataUrl) => {
    try {
        const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64, "base64");
        fs.writeFileSync(
            path.join(framesDir, `frame_${Date.now()}.jpg`),
            buffer
        );
    } catch (err) {
        console.error("[Electron] save-frame error:", err);
    }
});

ipcMain.handle("get-frames-dir", () => framesDir);

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});