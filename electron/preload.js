const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
    // Frame capture
    saveFrame: (dataUrl) => ipcRenderer.send("save-frame", dataUrl),
    getFramesDir: () => ipcRenderer.invoke("get-frames-dir"),

    // Reference image calibration
    saveReferenceImage: (category, dataUrl) =>
        ipcRenderer.invoke("save-reference-image", category, dataUrl),
    getReferenceCounts: () => ipcRenderer.invoke("get-reference-counts"),
    getRefImagesDir: () => ipcRenderer.invoke("get-ref-images-dir"),

    // Transparent overlay: toggle click-through
    setInteractive: (isInteractive) =>
        ipcRenderer.send("set-interactive", isInteractive),
});
