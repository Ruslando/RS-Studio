// One loading surface for walkthrough preparation and project opening.
let loading = false;

export async function loadWithScreen(operation, { title = "Loading project", failureTitle = "Could not open project" } = {}) {
  if (loading) return false;
  loading = true;
  const backdrop = document.createElement("div");
  backdrop.className = "project-loading-backdrop";
  backdrop.innerHTML = `
    <section class="project-loading" role="dialog" aria-modal="true" aria-busy="true"
             aria-labelledby="projectLoadingTitle" tabindex="-1">
      <h2 id="projectLoadingTitle"></h2>
      <p class="project-loading-stage" aria-live="polite" hidden></p>
      <div class="project-loading-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100"><span></span></div>
      <p class="project-loading-error" role="alert" hidden></p>
      <button type="button" class="project-loading-dismiss" hidden>Back</button>
    </section>`;
  const dialog = backdrop.querySelector(".project-loading");
  backdrop.querySelector("h2").textContent = title;
  backdrop.querySelector('[role="progressbar"]').setAttribute("aria-label", title);
  const blockKeys = (event) => {
    if (event.key === "Tab") return;
    event.preventDefault(); event.stopImmediatePropagation();
  };
  window.addEventListener("keydown", blockKeys, true);
  document.body.append(backdrop);
  dialog.focus();
  // Operations that know their steps report them: a label and how far along (0..1).
  const progress = (stage, fraction) => {
    const line = backdrop.querySelector(".project-loading-stage");
    line.textContent = stage; line.hidden = false;
    const bar = backdrop.querySelector('[role="progressbar"]');
    bar.classList.add("measured");
    bar.setAttribute("aria-valuenow", Math.round(fraction * 100));
    bar.firstElementChild.style.width = `${fraction * 100}%`;
  };
  try {
    await operation(progress);
    return true;
  } catch (error) {
    window.removeEventListener("keydown", blockKeys, true);
    dialog.setAttribute("aria-busy", "false");
    backdrop.querySelector("h2").textContent = failureTitle;
    const message = backdrop.querySelector(".project-loading-error");
    message.textContent = error.message || String(error); message.hidden = false;
    backdrop.querySelector('[role="progressbar"]').hidden = true;
    backdrop.querySelector(".project-loading-stage").hidden = true;
    const dismiss = backdrop.querySelector("button"); dismiss.hidden = false; dismiss.focus();
    await new Promise((resolve) => dismiss.addEventListener("click", resolve, { once: true }));
    return false;
  } finally {
    window.removeEventListener("keydown", blockKeys, true);
    backdrop.remove();
    loading = false;
  }
}
