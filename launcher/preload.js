// The page's bridge to the window. Named like pywebview's bridge, which the page
// already calls (project.js: quit, settings.js: set_zoom), so the same page runs
// in either window unchanged.
// ponytail: rename once the pywebview window is gone (launcher plan, phase 6).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pywebview", {
  api: {
    quit: () => ipcRenderer.send("quit"),
    set_zoom: (factor) => ipcRenderer.invoke("zoom", factor),
    // Exports: choose_save asks where the file goes (null when cancelled) before it is built;
    // save_file writes it there afterwards.
    choose_save: (name) => ipcRenderer.invoke("choose-save", name),
    save_file: (id, bytes) => ipcRenderer.invoke("save-file", id, bytes),
  },
});
