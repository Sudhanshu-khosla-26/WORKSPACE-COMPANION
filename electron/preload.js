const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
    saveFrame: (dataUrl) => ipcRenderer.send("save-frame", dataUrl),
    getFramesDir: () => ipcRenderer.invoke("get-frames-dir"),
});
