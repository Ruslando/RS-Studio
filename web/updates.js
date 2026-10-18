// The startup check marks the launcher button. Both update buttons open the
// shared dialog, where changing the channel checks again before installation.
import { $ } from "./dom.js";
import { confirmChoice } from "./dialog.js";
import { progressToast, toast } from "./notify.js";

let checkGeneration = 0;
let dialogOpen = false;

async function requestJSON(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.detail || "Could not check for updates");
  }
  return response.json();
}

const fetchUpdate = (signal) => requestJSON("/api/update", { signal });
const MANUAL = "This copy runs from source. Update it with:\ngit pull";

function showUpdate(data) {
  const latest = data.available ? data : null;
  $("welcomeUpdateBtn").classList.toggle("has-update", !!latest);
  $("welcomeUpdateTitle").textContent = latest ? "Update available" : "Check for updates";
  $("welcomeUpdateVersion").hidden = !latest;
  $("welcomeUpdateVersion").textContent = latest ? latest.latest : "";
}

async function installUpdate(data) {
  try {
    await requestJSON("/api/update/install", { method: "POST" });
    progressToast("Updating RS Studio", `Version ${data.latest}`).update({ stage: "Downloading", fraction: null });
  } catch (error) {
    toast(error.message, 6000, "error");
  }
}

async function openUpdate() {
  if (dialogOpen) return;
  dialogOpen = true;
  let offered = null;
  const content = document.createElement("label");
  content.className = "field-group block";
  const label = document.createElement("span");
  label.className = "field-label";
  label.textContent = "Update channel";
  const channel = document.createElement("select");
  channel.id = "updateDialogChannel";
  channel.disabled = true;
  channel.innerHTML = '<option value="stable">Stable</option><option value="preview">Preview</option>';
  content.append(label, channel);

  try {
    const choice = await confirmChoice({ title: "Updates", message: "Checking for updates…", confirmLabel: "Close", content,
      onOpen: ({ update }) => {
        const controller = new AbortController();
        const { signal } = controller;
        let savedChannel = "stable", canChange = false;
        const report = (error) => {
          if (signal.aborted) return;
          offered = null;
          update({ title: "Updates", message: error.message, confirmLabel: "Close", confirmDisabled: false });
        };
        const refresh = async () => {
          offered = null;
          const generation = ++checkGeneration;
          update({ title: "Updates", message: "Checking for updates…", confirmLabel: "Close", confirmDisabled: false });
          const data = await fetchUpdate(signal);
          if (signal.aborted || generation !== checkGeneration) return;
          offered = data;
          showUpdate(data);
          const message = data.available
            ? (data.notes || `Installed: ${data.current}`) + (data.supported ? "" : `\n\n${MANUAL}`)
            : "You are up to date.";
          update({ title: data.available ? `RS Studio ${data.latest}` : "Updates", message,
            confirmLabel: data.available && data.supported ? "Update now" : "Close",
            confirmDisabled: !!(data.available && data.supported && !data.can_install) });
        };
        const changeChannel = async () => {
          channel.disabled = true;
          offered = null;
          ++checkGeneration;
          showUpdate({ available: false });
          update({ title: "Updates", message: "Checking for updates…", confirmLabel: "Close", confirmDisabled: false });
          try {
            const state = await requestJSON("/api/update/channel", { method: "POST", signal,
              headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel: channel.value }) });
            if (signal.aborted) return;
            savedChannel = state.channel;
            await refresh();
          } catch (error) {
            channel.value = savedChannel;
            report(error);
          } finally {
            if (!signal.aborted) channel.disabled = !canChange;
          }
        };
        channel.addEventListener("change", changeChannel);
        (async () => {
          try {
            const state = await requestJSON("/api/update/channel", { signal });
            if (signal.aborted) return;
            savedChannel = state.channel;
            canChange = state.can_change_channel;
            channel.value = savedChannel;
            channel.title = canChange ? "" : "Run the new RS Studio Setup once to enable update channels.";
            await refresh();
          } catch (error) {
            report(error);
          } finally {
            if (!signal.aborted) channel.disabled = !canChange;
          }
        })();
        return () => { channel.removeEventListener("change", changeChannel); controller.abort(); };
      },
    });
    if (choice === "confirm" && offered?.available && offered.supported && offered.can_install)
      await installUpdate(offered);
  } finally {
    dialogOpen = false;
  }
}

export function init_updates() {
  $("welcomeUpdateBtn").addEventListener("click", openUpdate);
  const generation = checkGeneration;
  fetchUpdate().then(data => { if (generation === checkGeneration) showUpdate(data); }).catch(() => {});
}
