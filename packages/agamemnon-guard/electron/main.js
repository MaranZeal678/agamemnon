const { app, BrowserWindow, Menu, shell } = require("electron");
const path = require("path");
const { Store } = require("../guard/store");
const { createGuardServer } = require("../guard/server");

const PORT = 7420;
let store, server, win;

function boot() {
  const dataFile = path.join(app.getPath("userData"), "records.json");
  store = new Store(dataFile);
  store.init();
  try {
    server = createGuardServer(store, PORT);
    server.on("error", (e) => console.error("[guard] server error:", e.message));
    console.log(`[guard] Agamemnon guard listening on http://127.0.0.1:${PORT}`);
  } catch (e) {
    console.error("[guard] failed to start:", e.message);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 840, minWidth: 980, minHeight: 640,
    backgroundColor: "#0a0d13", titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 16 }, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, "..", "app", "index.html"));
  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: "deny" }; });
}

app.whenReady().then(() => {
  boot();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: "appMenu" }, { role: "editMenu" },
    { label: "View", submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "togglefullscreen" }] },
    { role: "windowMenu" },
  ]));
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("before-quit", () => { try { store && store.persist(true); } catch (_) {} });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
