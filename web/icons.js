// Inline SVG markup for icons used by more than one module.
//
// The rule, so this file doesn't become a dumping ground: an icon lives here
// when a SECOND module needs it. A single-use icon stays a named constant in the
// module that draws it — hoisted out of the markup either way, never pasted into
// the middle of a template literal, where two identical copies drifted apart
// unnoticed (the drag handle and the upload arrow, both duplicated exactly).
//
// Strings rather than <template> elements because every consumer builds its
// markup as a template literal and interpolates these; a DOM node there would
// stringify to "[object HTMLTemplateElement]".

export const DRAG_HANDLE_ICON = `<svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="3" r="1.2"/><circle cx="9" cy="3" r="1.2"/><circle cx="3" cy="8" r="1.2"/><circle cx="9" cy="8" r="1.2"/><circle cx="3" cy="13" r="1.2"/><circle cx="9" cy="13" r="1.2"/></svg>`;

// "Drop a file here, or click to browse" — the stem card and the stem panel.
export const UPLOAD_ARROW_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M12 4l-4 4M12 4l4 4"/><path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>`;

// Dismiss: every dialog header, and every "remove the thing I just picked"
// button next to a cover or a file. One mark for both, because they are the same
// gesture at two scales, and the button around it is what says which.
// aria-hidden — the button carries the name, not the glyph.
export const CLOSE_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`;
// Shared 24-unit outline family, sized by the control's role.
const OUTLINE = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  return: '<path d="M9 4 4 9l5 5M4 9h10a6 6 0 0 1 0 12h-3"/>',
  fit: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  metronome: '<path d="M5 21h14L15 3H9ZM9 18h6M12 18l4-11m-2 4 3 1"/>',
  tap: '<path d="M9 13V5a2 2 0 0 1 4 0v7l2-1 5 3v5l-3 3h-6l-6-7a2 2 0 0 1 3-2l1 1M3 5h2m12 0h2M6 1l1 2m8-2-1 2"/>',
  new: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 14h8m-4-4v8"/>',
  folder: '<path d="M3 8V6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v1M3 10h18l-3 10H5Z"/>',
  guide: '<path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Zm0 0v15M6 8h3M6 12h3m6-4h3m-3 4h3"/>',
  score: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6m-8 1v7m0-6 4-1"/><ellipse cx="10" cy="17" rx="2" ry="1.5"/>',
  update: '<path d="M20 11a8 8 0 0 0-14.6-4.5M4 3v4h4M4 13a8 8 0 0 0 14.6 4.5M20 21v-4h-4"/>',
  settings: '<path d="M3 6h5m4 0h9M3 12h11m4 0h3M3 18h2m4 0h12"/><circle cx="10" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="7" cy="18" r="2"/>',
  eye: '<path d="M2 12c3-5 6-7 10-7s7 2 10 7c-3 5-6 7-10 7S5 17 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  unlock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 7-2.6M12 14v3"/>',
  speaker: '<path d="M4 9h4l5-4v14l-5-4H4ZM16 8c3 2 3 6 0 8m3-11c5 4 5 10 0 14"/>',
  speakerOff: '<path d="M4 9h4l5-4v14l-5-4H4Zm13 1 4 4m0-4-4 4"/>',
  edit: '<path d="m4 16 12-12a2.8 2.8 0 0 1 4 4L8 20l-5 1Zm10-10 4 4M3 21h18"/>',
};
export function icon(name, size = 16) {
  return `<svg class="ui-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${OUTLINE[name]}</svg>`;
}
