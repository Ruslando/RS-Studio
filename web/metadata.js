// Song/project metadata helpers shared by project creation, project settings,
// and export dialogs. The manifest stores the cover art as a job-relative path;
// the client also receives coverArtUrl for previewing it.

export function normalizeMetadata(raw = {}) {
  return {
    title: (raw.title || "").trim(),
    artist: (raw.artist || "").trim(),
    album: (raw.album || "").trim(),
    year: raw.year ? String(raw.year).trim() : "",
    coverArt: raw.coverArt || null,
    coverArtName: raw.coverArtName || "",
    coverArtUpdatedAt: raw.coverArtUpdatedAt || null,
    coverArtUrl: raw.coverArtUrl || "",
  };
}

export function metadataFromState(state) {
  const meta = normalizeMetadata(state && state.metadata);
  const fallback = (state && (state.name || state.filename)) || "Untitled";
  if (!meta.title) meta.title = fallback;
  return meta;
}

export function metadataPayload(meta) {
  const m = normalizeMetadata(meta);
  const year = parseInt(m.year, 10);
  return {
    title: m.title,
    artist: m.artist,
    album: m.album,
    year: Number.isFinite(year) && year >= 1000 && year <= 9999 ? year : null,
    coverArt: m.coverArt || null,
    coverArtName: m.coverArtName || "",
    coverArtUpdatedAt: m.coverArtUpdatedAt || null,
  };
}

export function exportSongName(meta, fallback = "Untitled") {
  const m = normalizeMetadata(meta);
  const title = m.title || fallback || "Untitled";
  return m.artist ? `${m.artist} - ${title}` : title;
}

// Run a cover-art operation and fold its result into metadata the user has
// already typed but not yet saved. Three places do this — project settings, the
// New Project dialog, and the Rocksmith export dialog — and all three had the
// same eighteen lines. Two things they must all get right and this makes unmissable:
// the text fields are read BEFORE the request (so changing artwork never
// discards a title in progress), and a failure reports and changes nothing.
//
// Returns the merged metadata, or null if it failed; `status` has already been
// told either way.
export async function applyCoverChange(textMeta, run, status, working, done) {
  status(working);
  try {
    const result = await run();
    status(done);
    return {
      ...textMeta,
      coverArt: result.coverArt,
      coverArtName: result.coverArtName,
      coverArtUpdatedAt: result.coverArtUpdatedAt,
      coverArtUrl: result.coverArtUrl,
    };
  } catch (err) {
    status(err.message, true);
    return null;
  }
}

export async function uploadProjectCover(job, file) {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`/api/projects/${job}/cover`, { method: "POST", body: fd });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "Cover upload failed");
  const data = await res.json();
  return normalizeMetadata(data.metadata);
}

function filesFromDrop(dataTransfer) {
  return Array.from((dataTransfer && dataTransfer.files) || []);
}

function imageFileFromDrop(dataTransfer) {
  return filesFromDrop(dataTransfer).find((f) => f.type.startsWith("image/")) || null;
}

function fallbackFileFromDrop(dataTransfer) {
  return filesFromDrop(dataTransfer)[0] || null;
}

function normalizeCoverUrl(value) {
  const raw = (value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw.startsWith("//") ? `${location.protocol}${raw}` : raw, location.href);
    if (url.protocol === "data:" && !url.href.toLowerCase().startsWith("data:image/")) return "";
    return ["http:", "https:", "data:"].includes(url.protocol) ? url.href : "";
  } catch {
    return "";
  }
}

function urlFromSrcset(srcset) {
  const first = (srcset || "").split(",")[0] || "";
  return first.trim().split(/\s+/)[0] || "";
}

function coverUrlFromDrop(dataTransfer) {
  if (!dataTransfer) return "";
  const uri = (dataTransfer.getData("text/uri-list") || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#"));
  const fromUri = normalizeCoverUrl(uri);
  if (fromUri) return fromUri;

  const html = dataTransfer.getData("text/html") || "";
  if (html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const img = doc.querySelector("img[src]");
    const source = doc.querySelector("source[srcset], img[srcset]");
    const meta = doc.querySelector('meta[property="og:image"][content], meta[name="twitter:image"][content]');
    const fromHtml = normalizeCoverUrl(
      (img && img.getAttribute("src")) ||
      (source && urlFromSrcset(source.getAttribute("srcset"))) ||
      (meta && meta.getAttribute("content"))
    );
    if (fromHtml) return fromHtml;
  }

  return normalizeCoverUrl(dataTransfer.getData("text/plain"));
}

async function uploadProjectCoverUrl(job, url) {
  if (url.startsWith("data:image/")) {
    const blob = await fetch(url).then((r) => r.blob());
    const file = new File([blob], "dropped-cover.png", { type: blob.type || "image/png" });
    return uploadProjectCover(job, file);
  }
  const res = await fetch(`/api/projects/${job}/cover-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "Cover upload failed");
  const data = await res.json();
  return normalizeMetadata(data.metadata);
}

export async function uploadDroppedProjectCover(job, dataTransfer) {
  const file = imageFileFromDrop(dataTransfer);
  if (file) return uploadProjectCover(job, file);
  const url = coverUrlFromDrop(dataTransfer);
  if (url) return uploadProjectCoverUrl(job, url);
  const fallbackFile = fallbackFileFromDrop(dataTransfer);
  if (fallbackFile) return uploadProjectCover(job, fallbackFile);
  throw new Error("Drop an image file or an image from a web page.");
}

export async function clearProjectCover(job) {
  const res = await fetch(`/api/projects/${job}/cover`, { method: "DELETE" });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail || "Cover remove failed");
  const data = await res.json();
  return normalizeMetadata(data.metadata);
}
