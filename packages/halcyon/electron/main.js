const { app, BrowserWindow, Menu, shell, ipcMain } = require("electron");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { Store } = require("../guard/store");
const { createGuardServer } = require("../guard/server");

let store, guardPort = null, win, shellProc = null;

async function bootGuard() {
  const dataFile = path.join(app.getPath("userData"), "halcyon.json");
  store = new Store(dataFile);
  store.init();
  for (let p = 7420; p <= 7440; p++) {
    const r = await createGuardServer(store, p);
    if (r.server) { guardPort = p; console.log(`[halcyon] guard listening on http://127.0.0.1:${p}`); break; }
  }
  if (!guardPort) console.error("[halcyon] could not bind a guard port 7420-7440");
}

// ── the embedded local terminal: a real persistent login shell over pipes ────
const MARK = "__HALCYON_CMD_DONE__";
function initShell() {
  const env = { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ""}`, TERM: "xterm-256color", CLICOLOR: "1", HALCYON_GUARD: `http://127.0.0.1:${guardPort}` };
  const shellPath = process.env.SHELL && /zsh|bash/.test(process.env.SHELL) ? process.env.SHELL : "/bin/zsh";
  shellProc = spawn(shellPath, ["-l"], { cwd: os.homedir(), env });
  let buf = "";
  const sendData = (s) => { if (win && !win.isDestroyed()) win.webContents.send("term:data", s); };
  shellProc.stdout.on("data", (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf(MARK)) >= 0) {
      const before = buf.slice(0, idx);
      if (before) sendData(before);
      if (win && !win.isDestroyed()) win.webContents.send("term:done");
      buf = buf.slice(idx + MARK.length);
    }
    if (buf.length > MARK.length) { sendData(buf.slice(0, buf.length - MARK.length)); buf = buf.slice(buf.length - MARK.length); }
  });
  shellProc.stderr.on("data", (d) => sendData(d.toString()));
  shellProc.on("exit", () => { shellProc = null; });
}
function runInShell(cmd) {
  if (!shellProc) initShell();
  try {
    shellProc.stdin.write(cmd + "\n");
    shellProc.stdin.write(`printf '%s\\n' ${MARK}\n`);
  } catch (_) {}
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 880, minWidth: 1080, minHeight: 700,
    backgroundColor: "#0b0f17", titleBarStyle: "hiddenInset", trafficLightPosition: { x: 14, y: 18 }, show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, "..", "app", "index.html"));
  win.once("ready-to-show", () => { win.show(); initShell(); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: "deny" }; });
}

ipcMain.handle("halcyon:info", () => ({ guardPort, installed: store ? store.isInstalled() : false }));
ipcMain.handle("halcyon:install", () => { if (store) store.install(); return { installed: true, guardPort }; });
ipcMain.on("term:run", (_e, cmd) => runInShell(String(cmd || "")));
ipcMain.on("term:interrupt", () => { try { shellProc && shellProc.stdin.write("\x03"); } catch (_) {} });

app.whenReady().then(async () => {
  await bootGuard();
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: "appMenu" }, { role: "editMenu" },
    { label: "View", submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "togglefullscreen" }] },
    { role: "windowMenu" },
  ]));
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("before-quit", () => { try { store && store.persist(true); shellProc && shellProc.kill(); } catch (_) {} });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
