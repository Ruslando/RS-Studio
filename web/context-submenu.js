import { placeFloating } from "./floating-position.js";

// Fixed descendants escape the scrollable root menu without leaving its event scope.
export function wireContextSubmenu(wrap, row, child) {
  row.setAttribute("aria-haspopup", "menu");
  row.setAttribute("aria-expanded", "false");
  child.hidden = true;
  const close = () => {
    wrap.classList.remove("ctxmenu-sub--open"); child.hidden = true;
    row.setAttribute("aria-expanded", "false");
  };
  const open = (focus = false) => {
    if (row.disabled) return;
    child.hidden = false; wrap.classList.add("ctxmenu-sub--open");
    row.setAttribute("aria-expanded", "true");
    const rect = row.getBoundingClientRect();
    const width = child.offsetWidth;
    const preferLeft = !!wrap.closest(".ctxmenu-left");
    const fitsRight = rect.right + width <= window.innerWidth - 8;
    const fitsLeft = rect.left - width >= 8;
    const left = (preferLeft && fitsLeft) || (!fitsRight && fitsLeft)
      ? rect.left - width + 1 : rect.right - 1;
    placeFloating(child, left, rect.top, 0);
    if (focus) [...child.querySelectorAll("button")].find((button) =>
      !button.disabled && !button.closest("[hidden]"))?.focus();
  };
  wrap.parentElement.addEventListener("scroll", close);
  wrap.addEventListener("mouseenter", () => open());
  wrap.addEventListener("mouseleave", () => { if (!child.contains(document.activeElement)) close(); });
  row.addEventListener("click", () => open());
  row.addEventListener("keydown", (event) => {
    if (!["ArrowRight", "ArrowDown"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation(); open(true);
  });
  child.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" || event.target.closest(".ctxmenu-child") !== child) return;
    event.preventDefault(); event.stopPropagation(); close(); row.focus();
  });
}
