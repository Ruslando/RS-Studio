// One disclosure component for the Editor and Tone presets settings panes.
export function setSection(section, open) {
  section.toggleAttribute('data-collapsed', !open);
  section.querySelector('.sound-section-toggle').setAttribute('aria-expanded', String(open));
  section.querySelector('.sound-section-body').inert = !open;
}

export function initCollapsibleSections(root, storageKey, onToggle = () => {}) {
  let collapsed = [];
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (Array.isArray(saved)) collapsed = saved;
  } catch { /* All sections start open when no layout preference is available. */ }
  const sections = [...root.querySelectorAll('.sound-section')];
  for (const section of sections) {
    setSection(section, !collapsed.includes(section.dataset.section));
    section.querySelector('.sound-section-toggle').addEventListener('click', () => {
      setSection(section, section.hasAttribute('data-collapsed'));
      const keys = sections.filter(item => item.hasAttribute('data-collapsed')).map(item => item.dataset.section);
      try { localStorage.setItem(storageKey, JSON.stringify(keys)); } catch { /* Layout remains usable without storage. */ }
      onToggle(section);
    });
  }
}
