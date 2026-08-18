/**
 * A tiny JSON file store with the same shape as Netlify Blobs
 * (`get(key, {type:'json'})` / `setJSON(key, value)`), so the scoring pipeline
 * carries over from the Netlify build unchanged.
 *
 * State lives in `data/` and is committed back to the repository by the
 * GitHub Action. That gives persistence for free, with full version history —
 * if a refresh ever writes something wrong, the previous day is one `git
 * revert` away.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export function createStore(root) {
  const base = resolve(root);
  const pathFor = (key) => join(base, `${key.replace(/[^a-zA-Z0-9/_-]/g, '_')}.json`);

  return {
    async get(key, opts = {}) {
      try {
        const raw = await readFile(pathFor(key), 'utf8');
        return opts.type === 'json' ? JSON.parse(raw) : raw;
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        // A corrupt state file should not take down the whole refresh — treat
        // it as missing and let this run rebuild it.
        if (err instanceof SyntaxError) {
          console.warn(`State file for "${key}" is unreadable, rebuilding it.`);
          return null;
        }
        throw err;
      }
    },

    async setJSON(key, value) {
      const p = pathFor(key);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, JSON.stringify(value), 'utf8');
    },
  };
}
