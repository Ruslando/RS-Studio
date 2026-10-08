// Pure presentation model for project-library cards. Song metadata is optional,
// so every field has a quiet fallback without inventing "Unknown" labels.

const clean = (value) => String(value || "").trim();
const sameLabel = (a, b) => clean(a).localeCompare(clean(b), undefined, { sensitivity: "base" }) === 0;

export function durationLabel(seconds) {
  const total = Math.round(Number(seconds) || 0);
  if (!total) return "";
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

export function projectCardInfo(project = {}) {
  const metadata = project.metadata && typeof project.metadata === "object" ? project.metadata : {};
  const projectName = clean(project.name) || clean(project.filename) || clean(project.job) || "Untitled project";
  const songTitle = clean(metadata.title);
  const title = songTitle || projectName;
  const artist = clean(metadata.artist);
  const album = clean(metadata.album);
  const year = clean(metadata.year);
  const filename = clean(project.filename);

  const songDetails = [artist, album, year].filter(Boolean);
  const context = songDetails.join(" · ") || (
    filename && !sameLabel(filename, title) ? filename : ""
  );
  const alias = songTitle && !sameLabel(projectName, songTitle) ? projectName : "";
  const utility = [alias, durationLabel(project.duration)].filter(Boolean).join(" · ");

  return {
    title,
    context,
    utility,
    coverUrl: clean(metadata.coverArtUrl),
  };
}
