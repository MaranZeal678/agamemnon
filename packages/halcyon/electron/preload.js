const { contextBridge, ipcRenderer } = require("electron");

// Safe bridge between the renderer and the main process: the guard's port, the
// plugin install, and the embedded local terminal (a real persistent shell).
contextBridge.exposeInMainWorld("halcyon", {
  getInfo: () => ipcRenderer.invoke("halcyon:info"),
  installPlugin: () => ipcRenderer.invoke("halcyon:install"),
  term: {
    run: (cmd) => ipcRenderer.send("term:run", cmd),
    interrupt: () => ipcRenderer.send("term:interrupt"),
    onData: (cb) => ipcRenderer.on("term:data", (_e, d) => cb(d)),
    onDone: (cb) => ipcRenderer.on("term:done", (_e, code) => cb(code)),
  },
});
