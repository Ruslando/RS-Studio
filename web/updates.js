// Update check on the launcher screen: a silent check at startup marks the
// "Check for updates" button when an update exists; the button also checks on demand. Installing hands
// over to RS Studio.exe, which updates and reopens the app.

import { $ } from "./dom.js";
import { confirmChoice } from "./dialog.js";
import { progressToast, toast } from "./notify.js";

let latest = null;
let savedChannel = null;
let checkGeneration = 0;

async function fetchUpdate() {
  const response = await fetch("/api/update");
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail || "Could not check for updates");
  return data;
}

// A copy that runs from source has no launcher to install an update with. It
// is still told about a new release, and how to get it; the notice can be ignored.
const MANUAL = "This copy runs from source. Update it with:\ngit pull";

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
  if (!latest.supported) {
    await confirmChoice({ title: `RS Studio ${latest.latest}`, message: `${message}\n\n${MANUAL}`, confirmLabel: "OK", cancelLabel: "Later" });
    return;
  }
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
  // A job that ends with the app restarting, so its panel is never finished from here.
  progressToast("Updating RS Studio", `Version ${latest.latest}`).update({ stage: "Downloading", fraction: null });
}

async function checkNow(button) {
  if (latest) { openUpdate(); return; }  // already known: the button shows it
  button.disabled = true;
  const generation = ++checkGeneration;
  try {
    const data = await fetchUpdate();
    if (generation !== checkGeneration) return;
    if (data.available) { showUpdate(data); openUpdate(); }
    else toast(`RS Studio ${data.current} is up to date`);
  } catch (error) {
    toast(error.message, 6000, "warn");
  } finally {
    button.disabled = false;
  }
}

export async function applyUpdateChannel() {
  const channel = $("updateChannel").value;
  if (savedChannel === null || channel === savedChannel) return true;
  try {
    const response = await fetch("/api/update/channel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "Could not save the update channel");
    savedChannel = data.channel;
    const generation = ++checkGeneration;
    showUpdate({ available: false });
    $("updateChannelStatus").textContent = "Channel saved. Checking for updates…";
    fetchUpdate().then(data => {
      if (generation !== checkGeneration) return;
      showUpdate(data);
      $("updateChannelStatus").textContent = data.available ? `Version ${data.latest} is available.` : `RS Studio ${data.current} is up to date.`;
    }).catch(error => {
      if (generation === checkGeneration) $("updateChannelStatus").textContent = error.message;
    });
    return true;
  } catch (error) {
    $("updateChannelStatus").textContent = error.message;
    return false;
  }
}

export function init_updates() {
  $("welcomeUpdateBtn").addEventListener("click", (event) => checkNow(event.currentTarget));
  $("settingsUpdateCheck").addEventListener("click", (event) => checkNow(event.currentTarget));
  fetch("/api/update/channel").then(async response => {
    if (!response.ok) throw new Error("Could not load the update channel. Restart RS Studio to try again.");
    const data = await response.json();
    savedChannel = data.channel;
    $("updateChannel").value = data.channel;
    $("updateChannel").disabled = !data.can_change_channel;
    $("updateChannelStatus").textContent = data.can_change_channel ? "" : "Run the new RS Studio Setup once to enable update channels.";
    window.dispatchEvent(new Event("update-channel-loaded"));
  }).catch(error => { $("updateChannelStatus").textContent = error.message; });
  const generation = checkGeneration;
  fetchUpdate().then(data => { if (generation === checkGeneration) showUpdate(data); }).catch(() => {});
}
