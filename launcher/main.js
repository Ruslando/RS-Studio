// RS Studio's desktop window: starts the Python server (standalone.py --serve)
// and shows the app from it. Development only for now: `npm start` here runs the
// checkout's .venv. Version management and packaging come later.
"use strict";
const { app, BrowserWindow, Menu, dialog, ipcMain, screen, session, shell } = require("electron");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const repo = path.resolve(__dirname, "..");
const python = process.env.RS_STUDIO_PYTHON
  || path.join(repo, ".venv", ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));
// Chromium's profile (cache, localStorage) lives with the app's data, like the
// server's (paths.data_root(): the checkout for a source run), not in %APPDATA%.
app.setPath("userData", path.join(path.resolve(process.env.RS_STUDIO_DATA_ROOT || repo), ".electron"));
app.setAppUserModelId("com.rsstudio.app");
// No browser menu: its shortcuts (Ctrl+R reload, Ctrl+W close, Ctrl+plus zoom,
// devtools, Alt for a menu bar) would act on the app behind its back.
Menu.setApplicationMenu(null);

let win = null, server = null, appUrl = null, quitting = false;
const errorTail = [];

function quit() {
  quitting = true;
  app.quit();
}

function stopped(message) {
  if (quitting) return;
  dialog.showErrorBox("RS Studio stopped", message);
  quit();
}

function startServer() {
  // The server quits once this process is gone (RS_STUDIO_SHELL_PID), also after a crash.
  // No stdin: a pipe there would be inherited by every FFmpeg and Wwise the server starts.
  server = spawn(python, [path.join(repo, "standalone.py"), "--serve"], {
    cwd: repo, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    env: { ...process.env, RS_STUDIO_SHELL_PID: String(process.pid) },
  });
  server.on("error", (error) => stopped(`Could not start ${python}:\n${error.message}`));
  server.stderr.on("data", (chunk) => {
    process.stderr.write(chunk);
    errorTail.push(...chunk.toString().split(/\r?\n/).filter(Boolean));
    errorTail.splice(0, errorTail.length - 15);
  });
  readline.createInterface({ input: server.stdout }).on("line", (line) => {
    process.stdout.write(line + "\n");
    const ready = /^RS_STUDIO_READY (\d+)$/.exec(line);
    if (ready && !appUrl) {
      appUrl = `http://127.0.0.1:${ready[1]}/`;
      win.loadURL(appUrl);
    }
  });
  server.on("exit", (code) => {
    // 0 is a deliberate exit, e.g. handing over to the updater (updates._hand_over).
    if (code === 0) quit();
    else stopped(`The RS Studio server ended unexpectedly (exit code ${code}).\n\n${errorTail.join("\n")}`);
  });
}

// Where a file goes: asked with the file's name, starting in the folder the last one
// went to (a Rocksmith DLC folder, usually). The path, or null when the question is cancelled.
function askWhere(name) {
  const remembered = path.join(app.getPath("userData"), "download-folder.txt");
  let folder = app.getPath("downloads");
  try { folder = fs.readFileSync(remembered, "utf8").trim() || folder; } catch { /* first one */ }
  const extension = path.extname(name).slice(1);
  const target = dialog.showSaveDialogSync(win, {
    title: "Save " + name, defaultPath: path.join(folder, name),
    filters: extension ? [{ name: extension.toUpperCase() + " file", extensions: [extension] }] : [],
  });
  if (!target) return null;
  try { fs.writeFileSync(remembered, path.dirname(target)); } catch { /* only a convenience */ }
  return target;
}

// What the page did not ask for itself (a plain download link) is asked here, when it arrives.
// Exports ask first instead, through choose_save, and are written once they are built.
function saveDownload(item) {
  const target = askWhere(item.getFilename());
  if (target) item.setSavePath(target);
  else item.cancel();
}

// The destinations handed to the page, by id: save_file writes only to those, never to a
// path the page names. Kept for the session; there are a few at most.
const destinations = new Map();

const fromApp = (event) => !!appUrl && event.senderFrame?.url.startsWith(appUrl);

// Hand the close to the page, which asks about unsaved work in its own dialog and
// answers through the bridge's quit. A page that can't take it (not loaded,
// crashed, hung, from an older build) gets no say: the window closes.
const ASK_PAGE = "(() => { try { return !!window.cwQuitRequested && (window.cwQuitRequested(), true); } catch { return false; } })()";

async function askPageToClose() {
  const taken = await Promise.race([
    win.webContents.executeJavaScript(ASK_PAGE, true).catch(() => false),
    new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
  ]);
  if (!taken) quit();
}

function createWindow() {
  const area = screen.getPrimaryDisplay().workArea;
  const width = Math.min(1500, Math.round(area.width * 0.8)), height = Math.min(950, Math.round(area.height * 0.8));
  win = new BrowserWindow({
    width, height, minWidth: Math.min(1000, width), minHeight: Math.min(640, height), center: true, show: false,
    title: "RS Studio", backgroundColor: "#0c121b",   // tokens.css --workspace-ground
    icon: path.join(repo, "assets", process.platform === "win32" ? "icon.ico" : "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"), contextIsolation: true, sandbox: true, nodeIntegration: false,
      autoplayPolicy: "no-user-gesture-required",   // the sound engine starts before the first click
      backgroundThrottling: false,   // playback keeps its timing while the window is in the background
      spellcheck: false,
    },
  });
  win.once("ready-to-show", () => win.show());
  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(
    "<title>RS Studio</title><body style=\"margin:0;height:100vh;display:grid;place-items:center;"
    + "background:#0c121b;color:#a5abb7;font:14px system-ui,sans-serif\">Starting RS Studio…</body>"));

  const contents = win.webContents;
  // Links leave for the browser; nothing opens a second app window.
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !(appUrl && url.startsWith(appUrl))) shell.openExternal(url);
    return { action: "deny" };
  });
  // The window only ever shows the app. A file dropped outside a drop zone would
  // otherwise replace it with that file, losing the open project.
  contents.on("will-navigate", (event, url) => {
    if (appUrl && url.startsWith(appUrl)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  contents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "F12" && !app.isPackaged) contents.toggleDevTools();
  });
  win.on("close", (event) => {
    if (quitting || !appUrl) return;
    event.preventDefault();
    askPageToClose();
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();   // already running: that window comes forward (second-instance)
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  ipcMain.on("quit", (event) => { if (fromApp(event)) quit(); });
  ipcMain.handle("choose-save", (event, name) => {
    if (!fromApp(event)) return null;
    const target = askWhere(path.basename(String(name)));
    if (!target) return null;
    const id = randomUUID();
    destinations.set(id, target);
    return { id, name: path.basename(target) };
  });
  ipcMain.handle("save-file", async (event, id, bytes) => {
    const target = fromApp(event) && destinations.get(id);
    if (!target) throw new Error("This destination is no longer known. Export again.");
    await fs.promises.writeFile(target, Buffer.from(bytes));
    return target;
  });
  ipcMain.handle("zoom", (event, factor) => {
    if (!fromApp(event)) return false;
    event.sender.setZoomFactor(Math.min(3, Math.max(0.5, Number(factor) || 1)));
    return true;
  });
  app.whenReady().then(() => {
    // Clipboard writes (copy buttons) only; no camera, microphone, location or notifications.
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) =>
      callback(permission === "clipboard-sanitized-write"));
    session.defaultSession.on("will-download", (_event, item) => saveDownload(item));
    createWindow();
    startServer();
  });
  app.on("will-quit", () => { quitting = true; });
}
