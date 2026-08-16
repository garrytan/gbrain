// Compiled-binary smoke test for PGLite runtime-asset embedding (Bun vfs #1340).
//
// `bun build --compile` bundles our JS but NOT PGLite's runtime payload
// (pglite.wasm, initdb.wasm, pglite.data, vector.tar.gz, pg_trgm.tar.gz).
// src/core/pglite-embedded-assets.ts embeds those with `with { type: 'file' }`
// and hands them to PGLite via PGliteOptions. This smoketest proves the wiring
// actually works inside a compiled binary: it boots a REAL PGLiteEngine against
// a persistent data dir (the "serve a PGLite brain" scenario), runs the full
// schema (which needs the vector + pg_trgm extensions from the embedded
// tarballs), upserts a page, and reads it back.
//
// Output: a single JSON line on stdout.
//   {"ok":true,"pageFound":true,"title":"...","dataDir":"..."}
// Exit code 0 on success, 1 on any failure.
//
// Used by scripts/check-pglite-embedded.sh as a CI guard, mirroring
// scripts/chunker-smoketest.ts + scripts/check-wasm-embedded.sh.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

async function main(): Promise<void> {
  const out: Record<string, unknown> = {};
  const dir = mkdtempSync(join(tmpdir(), 'gb-pglite-embed-smoke-'));
  const dataDir = join(dir, 'brain.pglite');
  let engine: PGLiteEngine | null = null;
  try {
    engine = new PGLiteEngine();
    // Persistent data dir: exercises the initdb path + fsBundle, not just the
    // in-memory fast path — this is the real compiled `serve`/`init` scenario.
    await engine.connect({ database_path: dataDir });
    // initSchema runs CREATE EXTENSION vector / pg_trgm + the tsvector schema,
    // so it fails unless BOTH embedded extension tarballs loaded.
    await engine.initSchema();

    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
       VALUES ($1, $2, 'note', $3, $4, '')`,
      ['notes/embed-smoke', 'default', 'Embedded PGLite Smoke', 'the compiled binary served this row'],
    );

    const page = await engine.getPage('notes/embed-smoke', { sourceId: 'default' });
    out.pageFound = !!page;
    out.title = page?.title ?? null;
    out.body = page?.compiled_truth ?? null;
    out.dataDir = dataDir;
    out.ok = !!page && page.title === 'Embedded PGLite Smoke';
  } catch (e) {
    out.ok = false;
    out.error = e instanceof Error ? (e.stack ?? e.message) : String(e);
  } finally {
    try { await engine?.disconnect(); } catch { /* best-effort */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  console.log(JSON.stringify(out));
  process.exit(out.ok === true ? 0 : 1);
}

await main();
