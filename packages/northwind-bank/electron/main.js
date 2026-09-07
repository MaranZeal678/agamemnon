const { app, BrowserWindow, Menu, shell } = require("electron");
const path = require("path");

// Northwind Financial — the bank back-office. It holds NO data; every read and
// delete goes over HTTP to the Agamemnon guard (localhost:7420). Open Agamemnon
// first, or this app will show "Agamemnon offline".

function createWindow() {
  const win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 1080, minHeight: 680,
    backgroundColor: "#f3f5f8", titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 18 }, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, "..", "app", "index.html"));
  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: "deny" }; });
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: "appMenu" }, { role: "editMenu" },
    { label: "View", submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "togglefullscreen" }] },
    { role: "windowMenu" },
  ]));
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
