// Every UI icon, as inline SVG markup on the 24-unit outline grid (design 4.16).
//
// They are Lucide's (lucide-static 0.460.0, ISC; licenses/lucide-ISC.txt), each
// under the name the app calls it, with the Lucide name beside it. Drawn by hand
// only where Lucide has nothing: the metronome and transposition here, the
// walkthrough's left/right mouse (tour-text.js), the amp, pedal and rack
// (sound-designer.js) and the splitters' grip dots (index.html). An icon is placed
// with `icon(name, size)` or `data-ui-icon`, never pasted: two copies of one mark
// drift apart unnoticed.
//
// Strings rather than <template> elements because every consumer builds its
// markup as a template literal and interpolates these; a DOM node there would
// stringify to "[object HTMLTemplateElement]".

const OUTLINE = {
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',   // plus
  minus: '<path d="M5 12h14"/>',   // minus
  return: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/>',   // undo-2
  fit: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',   // maximize
  tap: '<path d="M22 14a8 8 0 0 1-8 8"/><path d="M18 11v-1a2 2 0 0 0-2-2a2 2 0 0 0-2 2"/><path d="M14 10V9a2 2 0 0 0-2-2a2 2 0 0 0-2 2v1"/><path d="M10 9.5V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v10"/><path d="M18 11a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',   // pointer
  new: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M9 15h6"/><path d="M12 18v-6"/>',   // file-plus
  folder: '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',   // folder-open
  folderClosed: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',   // folder
  guide: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',   // book-open
  score: '<path d="M10.5 22H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v8.4"/><path d="M8 18v-7.7L16 9v7"/><circle cx="14" cy="16" r="2"/><circle cx="6" cy="18" r="2"/>',   // file-music
  update: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',   // refresh-cw
  settings: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',   // sliders-horizontal
  eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',   // eye
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',   // lock
  unlock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',   // lock-open
  speaker: '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.364 18.364a9 9 0 0 0 0-12.728"/>',   // volume-2
  speakerOff: '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/>',   // volume-x
  edit: '<path d="M12 20h9"/><path d="M16.376 3.622a1 1 0 0 1 3.002 3.002L7.368 18.635a2 2 0 0 1-.855.506l-2.872.838a.5.5 0 0 1-.62-.62l.838-2.872a2 2 0 0 1 .506-.854z"/><path d="m15 5 3 3"/>',   // pencil-line
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',   // x
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',   // trash-2
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',   // ellipsis
  jump: '<path d="M17 12H3"/><path d="m11 18 6-6-6-6"/><path d="M21 5v14"/>',   // arrow-right-to-line
  previousMarker: '<polygon points="19 20 9 12 19 4 19 20"/><line x1="5" x2="5" y1="19" y2="5"/>',   // skip-back
  nextMarker: '<polygon points="5 4 15 12 5 20 5 4"/><line x1="19" x2="19" y1="5" y2="19"/>',   // skip-forward
  check: '<path d="M20 6 9 17l-5-5"/>',   // check
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',   // info
  warning: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',   // triangle-alert
  chevronUp: '<path d="m18 15-6-6-6 6"/>',   // chevron-up
  chevronDown: '<path d="m6 9 6 6 6-6"/>',   // chevron-down
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',   // chevron-left
  chevronRight: '<path d="m9 18 6-6-6-6"/>',   // chevron-right
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',   // play
  pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',   // pause
  stop: '<rect width="18" height="18" x="3" y="3" rx="2"/>',   // square
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',   // upload
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',   // search
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',   // arrow-left
  compare: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',   // repeat
  panelLeft: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',   // panel-left
  panelRight: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>',   // panel-right
  splitView: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 3v18"/>',   // columns-2
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',   // flag
  fretboard: '<path d="m11.9 12.1 4.514-4.514"/><path d="M20.1 2.3a1 1 0 0 0-1.4 0l-1.114 1.114A2 2 0 0 0 17 4.828v1.344a2 2 0 0 1-.586 1.414A2 2 0 0 1 17.828 7h1.344a2 2 0 0 0 1.414-.586L21.7 5.3a1 1 0 0 0 0-1.4z"/><path d="m6 16 2 2"/><path d="M8.2 9.9C8.7 8.8 9.8 8 11 8c2.8 0 5 2.2 5 5 0 1.2-.8 2.3-1.9 2.8l-.9.4A2 2 0 0 0 12 18a4 4 0 0 1-4 4c-3.3 0-6-2.7-6-6a4 4 0 0 1 4-4 2 2 0 0 0 1.8-1.2z"/><circle cx="11.5" cy="12.5" r=".5" fill="currentColor"/>',   // guitar
  grip: '<circle cx="9" cy="12" r="1"/><circle cx="9" cy="5" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="19" r="1"/>',   // grip-vertical
  waveform: '<path d="M2 10v3"/><path d="M6 6v11"/><path d="M10 3v18"/><path d="M14 8v7"/><path d="M18 5v13"/><path d="M22 10v3"/>',   // audio-lines
  wand: '<path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"/><path d="m14 7 3 3"/><path d="M5 6v4"/><path d="M19 14v4"/><path d="M10 2v2"/><path d="M7 8H3"/><path d="M21 16h-4"/><path d="M11 3H9"/>',   // wand-sparkles
  // Ours: Lucide has no metronome, and its arrows alone lose the note that makes
  // transposition read as pitch.
  metronome: '<path d="M5 21h14L15 3H9ZM9 18h6M12 18l4-11m-2 4 3 1"/>',
  transpose: '<ellipse cx="5.5" cy="18" rx="3.5" ry="2.5" transform="rotate(-20 5.5 18)" fill="currentColor" stroke="none"/><path d="M8.5 17V3c0 4 6 3 4 8M19 3v18m-3-15 3-3 3 3m-6 12 3 3 3-3"/>',
};
// The same icon as an image for a canvas, in one colour and stroke width. Loads
// asynchronously: `onload` is called once it can be drawn.
const stageIcons = new Map();
export function stageIcon(name, color, width = 1.8, onload = null) {
  const key = `${name}|${color}|${width}`;
  if (!stageIcons.has(key)) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" color="${color}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round">${OUTLINE[name]}</svg>`;
    const image = new Image();
    if (onload) image.onload = onload;
    image.src = "data:image/svg+xml," + encodeURIComponent(svg);
    stageIcons.set(key, image);
  }
  return stageIcons.get(key);
}

// `className` adds to "ui-icon", for marks styled by their role (a chevron that turns).
export function icon(name, size = 16, className = "") {
  return `<svg class="ui-icon${className ? ` ${className}` : ""}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${OUTLINE[name]}</svg>`;
}
