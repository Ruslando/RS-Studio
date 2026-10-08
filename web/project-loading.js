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
      <div class="project-loading-head">
        <span class="project-loading-spinner" aria-hidden="true"></span>
        <h2 id="projectLoadingTitle"></h2>
      </div>
      <div class="project-loading-bar" role="progressbar"><span></span></div>
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
  try {
    await operation();
    return true;
  } catch (error) {
    window.removeEventListener("keydown", blockKeys, true);
    dialog.setAttribute("aria-busy", "false");
    backdrop.querySelector("h2").textContent = failureTitle;
    const message = backdrop.querySelector(".project-loading-error");
    message.textContent = error.message || String(error); message.hidden = false;
    backdrop.querySelector('[role="progressbar"]').hidden = true;
    backdrop.querySelector(".project-loading-spinner").hidden = true;
    const dismiss = backdrop.querySelector("button"); dismiss.hidden = false; dismiss.focus();
    await new Promise((resolve) => dismiss.addEventListener("click", resolve, { once: true }));
    return false;
  } finally {
    window.removeEventListener("keydown", blockKeys, true);
    backdrop.remove();
    loading = false;
  }
}
