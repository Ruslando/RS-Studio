// A do-nothing DOM, so the app's own modules load in Node and the audit runs the
// real import and export code, not a copy of it. Every property is another stub.
// Worker stays undefined: the voicer then runs synchronously (tablature.js).
const stub = () => new Proxy(function () {}, {
  get: (t, k) => k === Symbol.toPrimitive ? () => "" : k === Symbol.iterator ? function* () {} : k === "then" ? undefined : stub(),
  apply: () => stub(), construct: () => stub(), set: () => true,
});
for (const k of ["document", "window", "localStorage", "sessionStorage", "navigator", "matchMedia", "requestAnimationFrame",
  "cancelAnimationFrame", "getComputedStyle", "ResizeObserver", "MutationObserver", "IntersectionObserver", "HTMLElement",
  "Element", "Image", "AudioContext", "location", "history", "devicePixelRatio", "CSS", "FontFace", "OffscreenCanvas", "Path2D"])
  if (!(k in globalThis)) globalThis[k] = stub();
