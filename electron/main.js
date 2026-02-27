const { app, BrowserWindow, ipcMain, session, protocol, screen } = require("electron");
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
// DO NOT use "use-fake-ui-for-media-stream" — it replaces real mic with empty fake stream!
app.commandLine.appendSwitch("unsafely-treat-insecure-origin-as-secure", "http://localhost:3000");
app.commandLine.appendSwitch("allow-insecure-localhost", "true");
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("enable-speech-dispatcher");
app.commandLine.appendSwitch("enable-features", "WebRTC,MediaFoundationH264Encoding,WebSpeechAPI");
app.commandLine.appendSwitch("enable-experimental-web-platform-features");
app.commandLine.appendSwitch("ignore-certificate-errors");

let mainWindow;

const framesDir = path.join(app.getPath("userData"), "captured_frames");
if (!fs.existsSync(framesDir)) fs.mkdirSync(framesDir, { recursive: true });

// ── Reference images directory ────────────────────────────────────────────────
const refImagesDir = path.join(app.getPath("userData"), "reference_images");
const refCategories = ["fatigue", "distracted", "stressed", "happy", "neutral", "sad"];
for (const cat of refCategories) {
    const catDir = path.join(refImagesDir, cat);
    if (!fs.existsSync(catDir)) fs.mkdirSync(catDir, { recursive: true });
}
console.log("[Electron] reference images dir:", refImagesDir);

// ── MIME type map ─────────────────────────────────────────────────────────────
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

// ── Create window ─────────────────────────────────────────────────────────────
function createWindow() {
    const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;

    mainWindow = new BrowserWindow({
        width: screenW,
        height: screenH,
        x: 0,
        y: 0,
        transparent: true,
        frame: false,
        alwaysOnTop: true,
        hasShadow: false,
        skipTaskbar: false,
        backgroundColor: "#00000000",
        autoHideMenuBar: true,
        title: "Buddy",
        resizable: false,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            webSecurity: true,
            allowRunningInsecureContent: true,
            preload: path.join(__dirname, "preload.js"),
        },
    });

    // Make transparent areas click-through
    mainWindow.setIgnoreMouseEvents(true, { forward: true });

    if (app.isPackaged) {
        mainWindow.loadURL("app://./index.html");
    } else {
        mainWindow.loadURL("http://localhost:3000");
    }

    mainWindow.webContents.on("did-finish-load", () => {
        console.log("[Electron] page loaded ✓");
    });

    mainWindow.webContents.on("did-fail-load", (_e, code, desc) => {
        console.error("[Electron] page failed:", code, desc);
        if (!app.isPackaged) {
            setTimeout(() => mainWindow.reload(), 2000);
        }
    });

    // Ctrl+Shift+I for DevTools
    mainWindow.webContents.on("before-input-event", (_event, input) => {
        if (input.control && input.shift && input.key === "I") {
            mainWindow.webContents.toggleDevTools();
        }
    });
}

// ── App ready ─────────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
    // Protocol handler for production
    protocol.handle("app", (request) => {
        const url = new URL(request.url);
        let filePath = decodeURIComponent(url.pathname);
        if (filePath.startsWith("/.")) filePath = filePath.substring(2);
        if (filePath === "/" || filePath === "") filePath = "/index.html";

        const fullPath = path.normalize(path.join(__dirname, "..", "out", filePath));

        if (!fs.existsSync(fullPath)) {
            const fallback = path.join(__dirname, "..", "out", "index.html");
            if (fs.existsSync(fallback)) {
                return new Response(fs.readFileSync(fallback), {
                    headers: { "Content-Type": "text/html" },
                });
            }
            return new Response("Not Found", { status: 404 });
        }

        return new Response(fs.readFileSync(fullPath), {
            headers: { "Content-Type": getMimeType(fullPath) },
        });
    });

    // ── Grant ALL permissions ─────────────────────────────────────────────────
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
        callback(true);
    });
    session.defaultSession.setPermissionCheckHandler(() => true);

    // OS permissions
    try {
        const { systemPreferences } = require("electron");
        if (systemPreferences.askForMediaAccess) {
            await systemPreferences.askForMediaAccess("microphone");
            await systemPreferences.askForMediaAccess("camera");
        }
    } catch (e) {
        console.warn("[Electron] systemPreferences:", e);
    }

    createWindow();
});

// ── IPC: Toggle mouse events (interactive vs click-through) ───────────────────
ipcMain.on("set-interactive", (_event, isInteractive) => {
    if (!mainWindow) return;
    if (isInteractive) {
        mainWindow.setIgnoreMouseEvents(false);
    } else {
        mainWindow.setIgnoreMouseEvents(true, { forward: true });
    }
});

// ── IPC: save captured frame ──────────────────────────────────────────────────
ipcMain.on("save-frame", (_event, dataUrl) => {
    try {
        const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64, "base64");
        fs.writeFileSync(path.join(framesDir, `frame_${Date.now()}.jpg`), buffer);
    } catch (err) {
        console.error("[Electron] save-frame error:", err);
    }
});

// ── IPC: save reference image for emotion calibration ─────────────────────────
ipcMain.handle("save-reference-image", (_event, category, dataUrl) => {
    try {
        if (!refCategories.includes(category)) {
            return { success: false, error: "Invalid category: " + category };
        }
        const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64, "base64");
        const catDir = path.join(refImagesDir, category);
        const fileName = `ref_${Date.now()}.jpg`;
        fs.writeFileSync(path.join(catDir, fileName), buffer);
        console.log(`[Electron] saved reference: ${category}/${fileName}`);
        return { success: true, path: path.join(catDir, fileName) };
    } catch (err) {
        console.error("[Electron] save-reference error:", err);
        return { success: false, error: String(err) };
    }
});

// ── IPC: get reference image count per category ───────────────────────────────
ipcMain.handle("get-reference-counts", () => {
    const counts = {};
    for (const cat of refCategories) {
        const catDir = path.join(refImagesDir, cat);
        try {
            counts[cat] = fs.readdirSync(catDir).filter(f => f.endsWith(".jpg")).length;
        } catch {
            counts[cat] = 0;
        }
    }
    return counts;
});

ipcMain.handle("get-frames-dir", () => framesDir);
ipcMain.handle("get-ref-images-dir", () => refImagesDir);

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});