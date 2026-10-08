import { progressToast, toast } from "./notify.js";

// Poll backend work counters; never manufacture a percentage from elapsed time.
export async function operationRequest(url, body, title, detail) {
  const progressId = crypto.randomUUID().replaceAll("-", "");
  let cancelRequested = false;
  const notification = progressToast(title, detail, async () => {
    if (!active || cancelRequested) return;
    cancelRequested = true;
    notification.cancelling();
    notification.update({stage: "Stopping…", fraction: null});
    try {
      const response = await fetch(`/api/operations/${progressId}/cancel`, {method: "POST"});
      if (!response.ok) throw new Error("Unable to cancel processing");
    } catch (error) {
      if (!active) return;
      cancelRequested = false;
      notification.cancelling(false);
      toast(error.message, 6000, "error");
    }
  });
  notification.update({stage: "Preparing audio", fraction: null});
  let active = true, timer = null, endState = "done";
  async function poll() {
    try {
      const response = await fetch("/api/operations/" + progressId);
      if (response.ok) {
        const value = await response.json();
        if (active) notification.update(cancelRequested ? {stage: "Stopping…", fraction: null} : value);
      }
    } catch { /* The original request reports connection errors. */ }
    if (active) timer = setTimeout(poll, 500);
  }
  timer = setTimeout(poll, 100);
  try {
    const response = await fetch(url, {
      method: "POST", headers: {"Content-Type": "application/json"},
      body: JSON.stringify({...body, progress_id: progressId}),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      const error = new Error(data.detail || "Audio processing failed");
      error.cancelled = data.cancelled === true;
      throw error;
    }
    return await response.json();
  } catch (error) {
    endState = error.cancelled ? "cancelled" : "error";
    if (error.cancelled) toast(title + " cancelled");
    else toast(title + " failed: " + error.message, 6000, "error");
    throw error;
  } finally {
    active = false;
    clearTimeout(timer);
    notification.update({state: endState, stage: endState === "done" ? "Complete" : endState === "cancelled" ? "Cancelled" : "Failed", fraction: endState === "done" ? 1 : null});
    notification.finish();
  }
}

// Browser upload counters measure transferred bytes; server analysis remains indeterminate.
export function uploadRequest(url, form, title, detail) {
  const notification = progressToast(title, detail);
  notification.update({stage: "Uploading audio", fraction: null});
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const fail = (message) => { notification.finish(); reject(new Error(message)); };
    request.open("POST", url);
    request.responseType = "json";
    request.upload.onprogress = event => notification.update({
      stage: "Uploading audio", fraction: event.lengthComputable ? event.loaded / event.total : null,
    });
    request.upload.onload = () => notification.update({stage: "Processing audio", fraction: null});
    request.onload = () => {
      notification.finish();
      if (request.status >= 200 && request.status < 300) resolve(request.response);
      else reject(new Error(request.response?.detail || "Upload failed"));
    };
    request.onerror = () => fail("Unable to upload audio");
    request.onabort = () => fail("Upload cancelled");
    request.send(form);
  });
}
