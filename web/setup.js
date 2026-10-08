// First-run setup and the persistent Rocksmith warning on the launcher.
// The completion flag lives on the server because the desktop app uses a new
// localhost port on each run, and browser localStorage is scoped to that port.

import { $ } from "./dom.js";
import { ESC_DEPTH, registerEscapeLayer } from "./escape-stack.js";
import { renderModels, stopModelPolling } from "./models.js";

let step = 1;

function audioLink(linux) {
  return linux
    ? { href: "https://github.com/pas2k/wav2wem", label: "Get wav2wem" }
    : { href: "https://www.audiokinetic.com/download/", label: "Get Wwise" };
}

function showAudioStatus(status) {
  const linux = status.platform === "linux";
  const link = audioLink(linux);
  const ready = status.found === true;
  const missingText = linux
    ? `Rocksmith export is unavailable. ${status.detail || "Install oggenc and wav2wem."}`
    : "Wwise is missing. Rocksmith export is unavailable.";

  $("welcomeRocksmithWarning").hidden = ready;
  if (!ready) {
    $("welcomeRocksmithWarningText").textContent = missingText;
    $("welcomeRocksmithLink").href = link.href;
    $("welcomeRocksmithLink").textContent = link.label;
  }

  $("setupAudioIntro").textContent = linux
    ? "Linux uses oggenc and wav2wem to create Rocksmith audio."
    : "Windows requires a local Wwise installation for Rocksmith export.";
  $("setupAudioStatus").textContent = ready
    ? (linux ? "Linux audio tools found" : `Wwise ${status.version || ""} found`)
    : (linux ? "Linux audio tools missing" : "Wwise not found");
  $("setupAudioDot").className = `dot dot--${ready ? "ok" : "warn"}`;
  $("setupAudioDetail").textContent = linux
    ? (ready ? "This Linux export path is experimental. Check playback and seeking in Rocksmith 2014."
      : "Install oggenc from vorbis-tools and wav2wem from its project page. Both must be on PATH.")
    : (ready ? "Rocksmith audio export is available."
      : "Install Wwise, then return to RS Studio. You can continue setting up models now.");
  $("setupAudioLink").hidden = ready;
  $("setupAudioLink").href = link.href;
  $("setupAudioLink").textContent = link.label;
}

export async function refreshRocksmithReadiness() {
  try {
    const response = await fetch("/api/rocksmith/audio-converter");
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    showAudioStatus(await response.json());
  } catch {
    // An unreachable status route is not evidence that Wwise is missing.
    $("welcomeRocksmithWarning").hidden = true;
    $("setupAudioStatus").textContent = "Could not check the audio converter";
    $("setupAudioDetail").textContent = "You can continue setup and check again later.";
    $("setupAudioLink").hidden = true;
  }
}

function showStep(next) {
  step = next;
  $("setupModal").classList.toggle("wide", step === 2);
  $("setupStepAudio").hidden = step !== 1;
  $("setupStepModels").hidden = step !== 2;
  if (step === 1) {
    $("setupProgressAudio").setAttribute("aria-current", "step");
    $("setupProgressModels").removeAttribute("aria-current");
  } else {
    $("setupProgressAudio").removeAttribute("aria-current");
    $("setupProgressModels").setAttribute("aria-current", "step");
  }
  $("setupSkip").hidden = step !== 1;
  $("setupBack").hidden = step !== 2;
  $("setupNext").textContent = step === 1 ? "Choose models" : "Go to projects";
  if (step === 2) renderModels($("setupModels"));
  else stopModelPolling();
  $("setupNext").focus();
}

async function finishSetup() {
  try {
    const response = await fetch("/api/setup/complete", { method: "POST" });
    if (!response.ok) throw new Error(`Could not save setup (${response.status})`);
    stopModelPolling();
    $("setupBackdrop").hidden = true;
    $("welcomeNew").focus();
    refreshRocksmithReadiness();
  } catch (error) {
    const status = $("setupSaveStatus");
    status.textContent = error.message;
    status.hidden = false;
  }
}

export async function init_setup() {
  $("setupNext").addEventListener("click", () => {
    if (step === 1) showStep(2);
    else finishSetup();
  });
  $("setupBack").addEventListener("click", () => showStep(1));
  $("setupAudioRecheck").addEventListener("click", refreshRocksmithReadiness);
  $("setupSkip").addEventListener("click", finishSetup);
  $("setupClose").addEventListener("click", finishSetup);
  $("setupBackdrop").addEventListener("click", (event) => {
    if (event.target === $("setupBackdrop")) finishSetup();
  });
  registerEscapeLayer(ESC_DEPTH.modal, () => {
    if ($("setupBackdrop").hidden) return false;
    finishSetup();
    return true;
  });
  window.addEventListener("focus", () => {
    if (!$("welcome").hidden) refreshRocksmithReadiness();
  });

  try {
    const response = await fetch("/api/setup");
    if (!response.ok) return;
    const state = await response.json();
    if (state.complete) return;
    $("setupSaveStatus").hidden = true;
    $("setupBackdrop").hidden = false;
    showStep(1);
    refreshRocksmithReadiness();
  } catch {
    // The launcher remains usable if the server cannot report setup state.
  }
}
