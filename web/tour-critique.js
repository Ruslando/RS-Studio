// TEMP critique: edit a card's text and leave a comment on it, right on the card,
// while the walkthrough copy is reviewed. Saved by the server to
// .walkthrough-critique.json in the data folder. Remove this file, its hooks in
// tour.js (marked "TEMP critique"), the endpoint in server.py and the CSS block.
//
// ponytail: one JSON file rewritten whole on every save; fine for one reviewer.

let entries = {};
let loaded = null;
let timer = 0;

const load = () => loaded ||= fetch("/api/walkthrough/critique")
  .then((r) => r.json()).then((data) => { entries = data.entries || {}; })
  .catch(() => {});

function save(status) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    fetch("/api/walkthrough/critique", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries }),
    }).then((r) => { status.textContent = r.ok ? "Saved" : "Could not save"; })
      .catch(() => { status.textContent = "Could not save"; });
  }, 350);
}

/** The edited text of a card, or its own. */
export const critiqueBody = (key, body) => entries[key]?.body ?? body;

/** Add the two fields to the card; returns show(key, label, body) for each step. */
export async function attachCritique(card) {
  await load();
  const box = document.createElement("section");
  box.className = "tour-critique";
  box.innerHTML = `
    <label>Walkthrough text<textarea class="tour-override" rows="4" spellcheck="true"></textarea></label>
    <label>Your comments<textarea class="tour-comment" rows="3" spellcheck="true" placeholder="What should change?"></textarea></label>
    <span class="tour-critique-status" aria-live="polite"></span>`;
  card.querySelector(".tour-body").after(box);
  const [text, comment] = box.querySelectorAll("textarea");
  const status = box.querySelector(".tour-critique-status");
  let current = null;
  const update = () => {
    if (!current) return;
    const changed = text.value !== current.original;
    if (!changed && !comment.value) delete entries[current.key];
    else entries[current.key] = { card: current.label, original: current.original,
      body: changed ? text.value : undefined, comment: comment.value };
    save(status);
  };
  text.addEventListener("input", update);
  comment.addEventListener("input", update);
  return (key, label, original) => {
    current = { key, label, original };
    text.value = critiqueBody(key, original);
    comment.value = entries[key]?.comment || "";
    status.textContent = "";
  };
}
