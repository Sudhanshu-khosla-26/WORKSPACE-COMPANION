const { app, BrowserWindow, ipcMain, session } = require("electron");
const path = require("path");
const fs = require("fs");

// ── MUST be before app ready ─────────────────────────────────────────────────
// Treat localhost as secure so Speech API + getUserMedia work over http://
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

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 650,
        backgroundColor: "#07080d",
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

    mainWindow.loadURL("http://localhost:3000");

    // Open DevTools on first load so you can see console errors
    mainWindow.webContents.on("did-finish-load", () => {
        console.log("[Electron] page loaded");
        // DevTools open so you can see camera/mic/speech console logs:
        mainWindow.webContents.openDevTools({ mode: "detach" });
    });

    mainWindow.webContents.on("did-fail-load", (_e, code, desc) => {
        console.error("[Electron] page failed to load:", code, desc);
        setTimeout(() => mainWindow.reload(), 2000);
    });
}

app.whenReady().then(async () => {
    // Grant ALL media permissions (camera, mic, display-capture, speech)
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
        const allowed = ["media", "audioCapture", "videoCapture", "display-capture", "geolocation", "notifications"];
        if (allowed.includes(permission)) {
            console.log("[Electron] granting permission:", permission);
            callback(true);
        } else {
            console.log("[Electron] unknown permission requested:", permission);
            callback(true); // Still grant for now
        }
    });

    session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
        return true;
    });

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

// ── IPC: save captured frame to disk ────────────────────────────────────────
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