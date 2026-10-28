export function formatTimelineTime(value, milliseconds = false) {
  const scale = milliseconds ? 1000 : 1;
  const raw = Number.isFinite(Number(value)) ? Number(value) : 0;
  // Before 0 lies the leading silence, counted with a minus sign.
  if (Math.floor((-raw + 1e-9) * scale) > 0) return '-' + formatTimelineTime(-raw, milliseconds);
  const time = Math.max(0, raw);
  const ticks = Math.floor((time + 1e-9) * scale);
  const whole = Math.floor(ticks / scale);
  const hours = Math.floor(whole / 3600);
  const minutes = String(Math.floor(whole / 60) % 60).padStart(2, '0');
  const seconds = String(whole % 60).padStart(2, '0');
  return `${hours ? hours + ':' : ''}${minutes}:${seconds}${milliseconds ? '.' + String(ticks % scale).padStart(3, '0') : ''}`;
}

export function parseTimelineTime(value) {
  // A leading minus is a time in the leading silence; the seek clamps it to what is shown.
  const match = /^(-)?(?:(\d+):)?([0-5]?\d):([0-5]\d)(?:\.(\d{1,3}))?$/.exec(String(value).trim());
  if (!match) return null;
  const seconds = Number(match[2] || 0) * 3600 + Number(match[3]) * 60 + Number(match[4])
    + (match[5] ? Number('0.' + match[5]) : 0);
  return Number.isFinite(seconds) ? (match[1] ? -seconds : seconds) : null;
}

// The editor freezes in place while typing; playback may continue behind it.
export function createOverviewTime({ root, button, input, getProject, getTime, onSeek }) {
  let editing = false, project = null, currentTime = 0, currentDuration = 0, currentWidth = 0;
  function close() {
    editing = false;
    input.hidden = true;
    input.setCustomValidity('');
    button.hidden = false;
    input.blur();
    sync(getTime(), currentDuration, currentWidth);
  }
  // x: where `time` is on the overview, when it does not start at 0.
  function sync(time, duration, width, x = time / duration * width) {
    currentTime = time; currentDuration = duration; currentWidth = width;
    if (editing && getProject() !== project) close();
    root.hidden = !(duration > 0 && width > 0);
    if (root.hidden || editing) return;
    const label = formatTimelineTime(time, true);
    if (button.textContent !== label) button.textContent = label;
    const left = Math.max(0, Math.min(width - root.offsetWidth, x + 5));
    root.style.left = `${left}px`;
    button.setAttribute('aria-label', `Current time ${label}. Double-click or press Enter to enter a time.`);
  }
  function open() {
    if (!(currentDuration > 0)) return;
    editing = true; project = getProject();
    button.hidden = true; input.hidden = false;
    input.value = formatTimelineTime(currentTime, true);
    root.style.left = `${Math.max(0, Math.min(currentWidth - root.offsetWidth, parseFloat(root.style.left) || 0))}px`;
    input.focus(); input.select();
  }
  function apply(report = true) {
    if (!editing) return;
    if (getProject() !== project) { close(); return; }
    const time = parseTimelineTime(input.value);
    const message = time === null ? 'Use mm:ss or h:mm:ss, optionally with .sss milliseconds.'
      : time > currentDuration ? `Time must not exceed ${formatTimelineTime(currentDuration, true)}.` : '';
    input.setCustomValidity(message);
    if (message) {
      if (report) input.reportValidity();
      else close();
      return;
    }
    onSeek(time);
    close();
  }
  root.addEventListener('mousedown', event => event.stopPropagation());
  button.addEventListener('dblclick', event => { event.preventDefault(); open(); });
  button.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault(); event.stopPropagation(); open();
  });
  input.addEventListener('input', () => input.setCustomValidity(''));
  input.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Enter') { event.preventDefault(); apply(); }
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  });
  input.addEventListener('blur', () => apply(false));
  return { sync };
}
