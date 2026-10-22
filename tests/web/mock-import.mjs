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
      if (real[specifier]) return statement.replace(specifier, new URL(specifier, url).href);
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
  try { return await import('data:text/javascript,' + encodeURIComponent(source + `\n//# sourceURL=${url.href}`)); }
  finally { delete globalThis[key]; }
}
