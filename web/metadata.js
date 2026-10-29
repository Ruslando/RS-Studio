// Song/project metadata helpers shared by project creation, project settings,
// and export dialogs. The manifest stores the cover art as a job-relative path;
// the client also receives coverArtUrl for previewing it.

import { latinUsable, nameCheck } from "./game-font.js";

export function normalizeMetadata(raw = {}) {
  return {
    title: (raw.title || "").trim(),
    artist: (raw.artist || "").trim(),
    album: (raw.album || "").trim(),
    year: raw.year ? String(raw.year).trim() : "",
    // Latin spellings for names in another script; Rocksmith sorts and names files by them.
    titleLatin: (raw.titleLatin || "").trim(),
    artistLatin: (raw.artistLatin || "").trim(),
    albumLatin: (raw.albumLatin || "").trim(),
    coverArt: raw.coverArt || null,
    coverArtName: raw.coverArtName || "",
    coverArtUpdatedAt: raw.coverArtUpdatedAt || null,
    coverArtUrl: raw.coverArtUrl || "",
    // Rocksmith export settings of this song: previewStart and previewLength, in seconds.
    rocksmith: { ...(raw.rocksmith || {}) },
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
    titleLatin: m.titleLatin,
    artistLatin: m.artistLatin,
    albumLatin: m.albumLatin,
    year: Number.isFinite(year) && year >= 1000 && year <= 9999 ? year : null,
    coverArt: m.coverArt || null,
    coverArtName: m.coverArtName || "",
    coverArtUpdatedAt: m.coverArtUpdatedAt || null,
    rocksmith: m.rocksmith,
  };
}

// ---- Latin spelling for names in another script ----
// Rocksmith sorts by a field that must start with a Latin letter or digit, and the
// .psarc name is ASCII. Its fonts have Latin, typographic marks (’ “ – …) and
// Japanese, nothing else. So a name with characters outside the Latin part of
// those fonts gets a second field beside it: Japanese is shown as written and
// sorted by the Latin spelling; a name the fonts cannot show (Кино, Dvořák) is
// shown as its Latin spelling too, since the game would leave gaps.
const LATIN_WHY = "Rocksmith shows the name as written, but sorts the song and names its file by Latin letters.";
const latinWhyMissing = (chars) => `Rocksmith's fonts have no ${chars.join(" ")}: the game shows this Latin spelling instead, and sorts by it.`;
const LATIN_MISSING = "Needed for Rocksmith export: Latin letters, starting with a letter or digit.";

// "伊根 (Ine)" already carries its Latin spelling; offer that rather than an empty field.
function latinGuess(name) {
  const latin = [...name].map((ch) => (nameCheck(ch).foreign ? " " : ch)).join("")
    .replace(/\s+/g, " ").replace(/^[^0-9A-Za-z]+/, "").trim();
  return latin.includes("(") ? latin : latin.replace(/\)$/, "");
}

// ids: { title, artist, album } -> the name inputs' element ids. Each gets a
// labelled field directly under its own, present only while that name needs one.
// The explanation is the label's tooltip and "still missing" is a dot beside
// it (rules 24 and 8) — shown as soon as it is true, not when Export is pressed.
export function latinFields(ids) {
  const fields = Object.entries(ids).map(([key, id]) => {
    const name = document.getElementById(id), group = document.createElement("div");
    group.className = "field-group block latin-field";
    group.innerHTML = `<span class="label">Latin spelling <span class="info" role="img" tabindex="0">i</span><span class="dot dot--warn" role="img" title="${LATIN_MISSING}" aria-label="${LATIN_MISSING}"></span></span><input type="text" maxlength="180" aria-label="Latin spelling" />`;
    name.after(group);
    const latin = group.querySelector("input"), dot = group.querySelector(".dot"), info = group.querySelector(".info");
    const needed = () => nameCheck(name.value).foreign;
    const missing = () => needed() && !latinUsable(latin.value.trim());
    const sync = () => {
      const gaps = nameCheck(name.value).missing;
      const why = gaps.length ? latinWhyMissing(gaps) : LATIN_WHY;
      info.title = why;
      info.setAttribute("aria-label", why);
      group.hidden = !needed();
      latin.disabled = name.disabled;
      dot.hidden = !missing();
    };
    name.addEventListener("input", sync);
    latin.addEventListener("input", sync);
    // "change", not "input": the guess is made once the name is finished, not per keystroke.
    name.addEventListener("change", () => { if (needed() && !latin.value) latin.value = latinGuess(name.value); sync(); });
    sync();
    return { key: `${key}Latin`, name, latin, needed, missing, sync };
  });
  return {
    read(meta) { for (const f of fields) meta[f.key] = f.needed() ? f.latin.value.trim() : ""; return meta; },
    fill(meta) {
      for (const f of fields) {
        f.latin.value = (meta && meta[f.key]) || (f.needed() ? latinGuess(f.name.value) : "");
        f.sync();
      }
    },
    sync() { for (const f of fields) f.sync(); },
    missing() { return fields.some((f) => f.missing()); },
  };
}

// A project is named after its song, so the name follows the details when they
// change; without a title it keeps the name it had (server: _project_name).
export function projectName(state) {
  if (!state) return "";
  const m = normalizeMetadata(state.metadata);
  // The name, with its Latin spelling in brackets when it has a separate one.
  const part = (value, latin) => (value && latin && !value.includes(latin) ? `${value} (${latin})` : value);
  const title = part(m.title, m.titleLatin), artist = part(m.artist, m.artistLatin);
  if (!title) return state.name || state.filename || "Untitled";
  return artist ? `${artist} - ${title}` : title;
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
// Where a cover change reports (design.md 4.17): the tile spins while it runs, and
// only a failure is a sentence, said by `say`.
export const coverStatus = (tile, say) => (message, error = false, busy = false) => {
  tile.classList.toggle("busy", busy);
  say(error ? message : "", error);
};

export async function applyCoverChange(textMeta, run, status, working, done) {
  status(working, false, true);
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
