/**
 * `importFromContent` with no coordinator (no `opts.prepare`) on a brain with no managed persistence, on every engine
 * arm: the same ImportResult, and a page that reads back.
 *
 * An unmanaged import checks the brain is unmanaged, opens its maintenance transaction, reads the belief ledger's view
 * of the source and publishes the page and its chunks. On a Rust brain built from master it stops at the first of those
 * (readManagedModeRows, engine_capability_missing persistence_journal); with parts A and B it stops at
 * readLedgerSource; part D serves readLedgerSource, replaceDerivedAliases and moveChunkIndexes, so the import lands.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 * 1. Protects: a direct content import on a Rust brain gives the ImportResult PGLite (and Postgres, with DATABASE_URL)
 *    gives, and stores a page engine.getPage reads back with the same title, type and body.
 * 2. Fails when: the Rust arm's import throws (a typed refusal included), returns another status or chunk count, or
 *    the stored page is missing or differs from PGLite's.
 * 3. Existing coverage: test/rust-engine-no-raw-proof.test.ts traces importFromContent on PGLite only;
 *    test/rust-engine-store.test.ts writes through engine.putPage, not the import's journal.
 * 4. Seams: none. The Rust arm needs the addon `bun run rust:build` writes and skips without it
 *    (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes a missing addon an error); the Postgres arm runs with DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { loadRustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { openRustEngine } from '../src/core/rust-engine.ts';

const TARGET = detectAddonTarget();
const ADDON = join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(ADDON);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${ADDON} does not exist; run bun run rust:build`);
}
const DATABASE_URL = process.env.DATABASE_URL;

type Arm = 'pglite' | 'postgres' | 'rust';
const dirs: string[] = [];
const engines: BrainEngine[] = [];
let pgliteEngine: PGLiteEngine;
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-rust-import-content-pglite-'));
  dirs.push(dir);
  pgliteEngine = new PGLiteEngine();
  engines.push(pgliteEngine);
  await pgliteEngine.connect({ engine: 'pglite', database_path: dir } as never);
  await pgliteEngine.initSchema();
});
afterAll(async () => {
  for (const engine of engines.splice(0)) await engine.disconnect().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function open(arm: Arm): Promise<BrainEngine> {
  if (arm === 'postgres') {
    const engine = new PostgresEngine();
    engines.push(engine);
    await engine.connect({ engine: 'postgres', database_url: DATABASE_URL } as never);
    await engine.initSchema();
    return engine;
  }
  if (arm === 'pglite') return pgliteEngine;
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-rust-import-content-rust-'));
  dirs.push(dir);
  const addon = await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: ADDON } });
  const engine = openRustEngine({ addon, databasePath: dir });
  engines.push(engine);
  await engine.connect({ engine: 'pglite', database_path: dir } as never);
  await engine.initSchema();
  return engine;
}

const CONTENT = `---\ntype: note\ntitle: Import parity\ntags: [probe]\n---\n# Import parity\n\nOne page imported with no coordinator on a brain with no managed persistence.\n`;

/** Imports one page with no `prepare`, then reads it back; both without ids, timestamps or this run's slug token. */
async function importThenRead(arm: Arm, token: string): Promise<{ result: unknown; page: unknown }> {
  const engine = await open(arm);
  const slug = `notes/import-parity-${token}`;
  const result = await importFromContent(engine, slug, CONTENT, { noEmbed: true });
  const page = await engine.getPage(slug);
  return {
    result: { slug: result.slug.split(token).join('TOKEN'), status: result.status, chunks: result.chunks, error: result.error ?? null },
    page: page && { slug: page.slug.split(token).join('TOKEN'), type: page.type, title: page.title, compiled_truth: page.compiled_truth },
  };
}

describe('importFromContent with no coordinator on a brain with no managed persistence', () => {
  const token = randomUUID().slice(0, 8);
  let pglite: { result: unknown; page: unknown };

  test('PGLite: the import lands and the page reads back', async () => {
    pglite = await importThenRead('pglite', token);
    expect(pglite.result).toMatchObject({ slug: 'notes/import-parity-TOKEN', status: 'imported', error: null });
    expect(pglite.page).toMatchObject({ slug: 'notes/import-parity-TOKEN', type: 'note', title: 'Import parity' });
  }, 180_000);

  test.skipIf(!DATABASE_URL)('Postgres: the same ImportResult and the same stored page as PGLite', async () => {
    expect(await importThenRead('postgres', token)).toEqual(pglite);
  }, 180_000);

  test.skipIf(!HAVE_ADDON)('Rust: the same ImportResult and the same stored page as PGLite', async () => {
    expect(await importThenRead('rust', token)).toEqual(pglite);
  }, 180_000);
});
