// Update check on the launcher screen: a silent check at startup marks the
// "Check for updates" button when an update exists; the button also checks on demand. Installing hands
// over to RS Studio.exe, which updates and reopens the app.

import { $ } from "./dom.js";
import { confirmChoice } from "./dialog.js";
import { toast } from "./notify.js";

let latest = null;

async function fetchUpdate() {
  const response = await fetch("/api/update");
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail || "Could not check for updates");
  return data;
}

function showUpdate(data) {
  latest = data.available ? data : null;
  $("welcomeUpdateBtn").classList.toggle("has-update", !!latest);
  $("welcomeUpdateTitle").textContent = latest ? "Update available" : "Check for updates";
  $("welcomeUpdateVersion").hidden = !latest;
  $("welcomeUpdateVersion").textContent = latest ? latest.latest : "";
}

async function openUpdate() {
  if (!latest) return;
  const message = latest.notes || `Installed: ${latest.current}`;
  const choice = await confirmChoice({ title: `RS Studio ${latest.latest}`, message, confirmLabel: "Update now", cancelLabel: "Later" });
  if (choice !== "confirm") return;
  if (!latest.can_install) {
    toast("Updating requires the installed RS Studio.", 6000, "warn");
    return;
  }
  const response = await fetch("/api/update/install", { method: "POST" });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    toast(data.detail || "Could not start the update", 6000, "error");
    return;
  }
  toast("Updating RS Studio…", 10000);
}

async function checkNow(button) {
  if (latest) { openUpdate(); return; }  // already known: the button shows it
  button.disabled = true;
  try {
    const data = await fetchUpdate();
    if (!data.supported) toast("Updates require the installed RS Studio.", 5000);
    else if (data.available) { showUpdate(data); openUpdate(); }
    else toast(`RS Studio ${data.current} is up to date`);
  } catch (error) {
    toast(error.message, 6000, "warn");
  } finally {
    button.disabled = false;
  }
}

export function init_updates() {
  $("welcomeUpdateBtn").addEventListener("click", (event) => checkNow(event.currentTarget));
  fetchUpdate().then(showUpdate).catch(() => {});  // offline at startup: stay quiet, the button reports errors
}
