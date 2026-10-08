import { progressToast, toast } from "./notify.js";

// Poll backend work counters; never manufacture a percentage from elapsed time.
export async function operationRequest(url, body, title, detail) {
  const progressId = crypto.randomUUID().replaceAll("-", "");
  const notification = progressToast(title, detail);
  notification.update({stage: "Preparing audio", fraction: null});
  let active = true, timer = null;
  async function poll() {
    try {
      const response = await fetch("/api/operations/" + progressId);
      if (response.ok) {
        const value = await response.json();
        if (active) notification.update(value);
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
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).detail || "Audio processing failed");
    return await response.json();
  } catch (error) {
    toast(title + " failed: " + error.message, 6000, "error");
    throw error;
  } finally {
    active = false;
    clearTimeout(timer);
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
