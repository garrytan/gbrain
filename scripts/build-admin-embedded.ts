#!/usr/bin/env bun
/**
 * Generates `src/admin-embedded.ts` from `admin/dist/*`.
 *
 * Why: `bun build --compile` does NOT embed arbitrary asset directories.
 * The only way to ship a file inside a compiled binary is via an ESM
 * `import x from './path' with { type: 'file' }` reference (which Bun
 * resolves at runtime to a path that works inside the binary archive).
 *
 * Pre-v0.36.x, `serve-http.ts:780` resolved `admin/dist/` via
 * `process.cwd()` — fine in dev (`cd ~/gbrain && bun start serve --http`),
 * broken in every globally-installed binary (no admin/dist next to the
 * binary). Result: every fresh `bun install -g github:garrytan/gbrain`
 * user got 404 on /admin (issue #1090).
 *
 * This generator emits one `import` line per file under admin/dist/,
 * plus a manifest map keyed by the request path the express handler
 * sees (e.g. `/admin/index.html`, `/admin/assets/index-XXX.js`).
 *
 * Run: `bun run scripts/build-admin-embedded.ts` (also invoked by
 * `bun run build:admin`).
 *
 * CI guard: `scripts/check-admin-embedded.sh` re-runs this generator
 * and `git diff --exit-code src/admin-embedded.ts` so PRs that change
 * admin/dist without regenerating the embedded module fail loud.
 */

import { readdirSync, statSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join, relative, posix } from 'path';

const REPO = join(import.meta.dir, '..');
const DIST = join(REPO, 'admin', 'dist');
const OUT = join(REPO, 'src', 'admin-embedded.ts');

function walk(dir: string, base: string = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full, base));
    } else {
      out.push(relative(base, full));
    }
  }
  return out.sort();
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function mimeFor(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  return MIME[filename.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

function safeIdent(rel: string, idx: number): string {
  // Stable, collision-free identifier per relative path. The numeric
  // suffix prevents collisions between filenames that normalize to the
  // same identifier (e.g. `foo.bar.js` and `foo-bar.js`).
  const cleaned = rel.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+/, '');
  return `A_${idx}_${cleaned}`;
}

const files = walk(DIST);
if (files.length === 0) {
  console.error('[build-admin-embedded] no files under admin/dist — run `cd admin && bun run build` first.');
  process.exit(1);
}

const imports: string[] = [];
const manifestEntries: string[] = [];

for (let i = 0; i < files.length; i++) {
  const rel = files[i];
  // POSIX-style relative path for the import (works on Windows too).
  const importRel = `../admin/dist/${rel.split(/[\\/]/).join('/')}`;
  const ident = safeIdent(rel, i);
  // @ts-ignore — `with { type: 'file' }` is Bun syntax not in lib.d.ts;
  // same pattern as src/core/chunkers/code.ts wasm imports.
  imports.push(`// @ts-ignore — type: 'file' is Bun ESM, not in lib.d.ts`);
  imports.push(`import ${ident} from '${importRel}' with { type: 'file' };`);
  const requestPath = '/admin/' + rel.split(/[\\/]/).join('/');
  manifestEntries.push(`  ${JSON.stringify(requestPath)}: { path: ${ident} as unknown as string, mime: ${JSON.stringify(mimeFor(rel))} },`);
}

const content = `// AUTO-GENERATED — do not edit by hand.
// Run \`bun run scripts/build-admin-embedded.ts\` to regenerate.
// Source: admin/dist/ at ${new Date().toISOString().slice(0, 10)}.
//
// Bun resolves the file: imports to a path that works at runtime even
// inside a compiled binary (\`bun build --compile\`). The manifest maps
// the request path the express handler sees to (resolved-path, mime).

${imports.join('\n')}

export interface AdminAsset {
  path: string;
  mime: string;
}

export const ADMIN_ASSETS: Record<string, AdminAsset> = {
${manifestEntries.join('\n')}
};

/** Index entry point for SPA fallback. */
export const ADMIN_INDEX_HTML: AdminAsset = ADMIN_ASSETS['/admin/index.html'];

export const ADMIN_ASSET_COUNT = ${files.length};
`;

const existing = existsSync(OUT) ? readFileSync(OUT, 'utf-8') : '';
if (existing === content) {
  console.log(`[build-admin-embedded] up to date (${files.length} files)`);
} else {
  writeFileSync(OUT, content, 'utf-8');
  console.log(`[build-admin-embedded] wrote ${OUT} (${files.length} files)`);
}
