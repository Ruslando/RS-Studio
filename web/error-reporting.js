// A classic script loaded before the app's module graph: even a failed import
// or an exception halfway through startup must reach the Python terminal.
(() => {
  let phase = 'startup';
  const reported = new Set();
  const describe = value => {
    try { return value?.stack || String(value); }
    catch { return '[unprintable error]'; }
  };
  const report = (kind, detail) => {
    const message = detail.slice(0, 16000), key = `${phase}:${kind}:${message}`;
    // A broken animation frame must not flood the terminal or the local server.
    if (reported.has(key) || reported.size >= 50) return;
    reported.add(key);
    try {
      fetch('/api/frontend-error', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phase, kind, message }), keepalive: true,
      }).catch(() => {}); // Reporting failure must never recursively report itself.
    } catch { /* Keep the browser's original error reporting available. */ }
  };
  window.addEventListener('cw-app-ready', () => { phase = 'runtime'; });
  window.addEventListener('error', event => {
    if (event.target instanceof HTMLScriptElement) {
      report('script-load', `Could not load script: ${event.target.src}`);
    } else if (event instanceof ErrorEvent) {
      report('exception', `${describe(event.error || event.message)}\n${event.filename}:${event.lineno}:${event.colno}`);
    }
  }, true);
  window.addEventListener('unhandledrejection', event => report('rejection', describe(event.reason)));
  const originalError = console.error;
  console.error = function (...args) {
    originalError.apply(console, args);
    report('console', args.map(describe).join(' '));
  };
})();
