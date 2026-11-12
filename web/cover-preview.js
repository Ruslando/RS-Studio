// Render the same cover-art fields in project settings and the export dialog.
export function renderCoverPreview(meta, { thumb, title, sub, clear }) {
  const has = !!meta.coverArtUrl;
  thumb.classList.toggle("has-cover", has);
  thumb.replaceChildren();
  // Use DOM properties: a URL containing quotes must never become markup.
  if (has) {
    const img = document.createElement("img");
    img.src = meta.coverArtUrl; img.alt = ""; thumb.append(img);
  }
  title.textContent = has ? (meta.coverArtName || "Cover art") : "Choose image";
  sub.textContent = "";
  clear.hidden = !has;
}
