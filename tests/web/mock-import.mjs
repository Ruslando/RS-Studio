import { readFile } from 'node:fs/promises';

let next = 0;
// Run a feature's real code with explicit browser/service doubles. Unexpected
// calls fail, rather than silently pretending the rest of the app succeeded.
export async function mockImport(url, overrides = {}, real = {}) {
  const key = `rs-test-import-${++next}`;
  const bindings = {};
  globalThis[key] = bindings;
  const source = (await readFile(url, 'utf8')).replace(
    /import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["'];?/g,
    (statement, names, specifier) => {
      // These modules have no browser imports; exercise their real bookkeeping.
      if (real[specifier] || specifier === './paint-memo.js' || (specifier === './edit-history.js' && !overrides[specifier])) return statement.replace(specifier, new URL(specifier, url).href);
      const module = { ...overrides[specifier] };
      const exports = names.split(',').map(name => name.trim().split(/\s+as\s+/)[0]);
      for (const name of exports) if (!(name in module)) module[name] = () => {
        throw new Error(`Unexpected mock call: ${specifier} ${name}`);
      };
      bindings[specifier] = module;
      const mock = exports.map(name => `export const ${name} = globalThis[${JSON.stringify(key)}][${JSON.stringify(specifier)}][${JSON.stringify(name)}];`).join('\n');
      return statement.replace(specifier, 'data:text/javascript,' + encodeURIComponent(mock));
    },
  ).replace(/export\s*(?:\{[^}]+\}|\*)\s*from\s*["']([^"']+)["']/g,
    (statement, specifier) => statement.replace(specifier, new URL(specifier, url).href));
  // Preserve relative worker/asset URLs when evaluating a module through a data URL.
  const resolvedSource = source.replace(/\bimport\.meta\.url\b/g, JSON.stringify(url.href));
  try { return await import('data:text/javascript,' + encodeURIComponent(resolvedSource + `\n//# sourceURL=${url.href}`)); }
  finally { delete globalThis[key]; }
}

// Exercise editor commands together with their shared clipboard/column helpers.
// The same browser doubles cross those boundaries; no helper behavior is stubbed.
export async function mockEditor(overrides = {}, real = {}) {
  const shared = {
    ...overrides,
    './lane-state.js': overrides['./lanes.js'],
    './voicing-core.js': overrides['./voicing-core.js'] || overrides['./voicing.js'],
  };
  const clipboard = await mockImport(new URL('../../web/note-clipboard.js', import.meta.url), shared, real);
  const column = await mockImport(new URL('../../web/column-context.js', import.meta.url), shared, real);
  return mockImport(new URL('../../web/edit.js', import.meta.url), {
    './note-clipboard.js': clipboard, './column-context.js': column, ...overrides,
  }, real);
}
