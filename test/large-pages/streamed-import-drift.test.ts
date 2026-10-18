/**
 * A streamed import (a Markdown file over PAGE_MAX_BYTES, `pages.segmented_storage` on) reads its file twice;
 * a rewrite between the passes that keeps the size and the mtime is held, never stored as a mix of both versions.
 *
 * 1. Protects: pass 2 reads whole file blocks and checks each against the sha256 pass 1 recorded, so a file
 *    rewritten after pass 1 (same size, mtime restored with utimes) is held as `file_too_large` "the file changed
 *    while it was imported" with nothing stored, and imports whole once it holds still; an unchanged file reads
 *    each block after pass 1 about once (streamedImportWork).
 * 2. Fails when: pass 2 trusts size and mtime alone, which stores the pass-1 frontmatter (title) over the
 *    pass-2 body.
 * 3. Existing coverage: managed-streamed-import.test.ts checks a managed import's admitted sha256 on pass 1 only.
 * 4. No production seam: the rewrite runs in a wrapped engine.getPage (unbound, so a transaction derived from
 *    the engine keeps its own connection), which importScanned calls after pass 1 and before pass 2. Runs on
 *    PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromFile } from '../../src/core/import-file.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { streamedImportWork } from '../../src/core/page-body/streamed-import.ts';
import { conversationBody } from '../helpers/conversation-page.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';

const MiB = 1024 * 1024;
const SLUG = 'notes/drift-example';
const MTIME = 1_700_000_000;
const body = conversationBody(PAGE_MAX_BYTES + MiB, { seed: 41 });
const version = (tag: 'old' | 'new') => `---\ntype: note\ntitle: Drift ${tag}\n---\n\nhead-${tag}-marker\n\n${body}\n\ntail-${tag}-marker\n`;

const dir = mkdtempSync(join(tmpdir(), 'gbrain-streamed-drift-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
  for (const engine of engines) await engine.setConfig('pages.segmented_storage', 'on');
}, 120_000);

afterAll(async () => {
  for (const engine of engines) if (engine.kind === 'pglite') await engine.disconnect();
  await closePostgres?.();
  rmSync(dir, { recursive: true, force: true });
});

function writeVersion(file: string, tag: 'old' | 'new'): void {
  writeFileSync(file, version(tag));
  utimesSync(file, MTIME, MTIME);
}

async function stored(engine: BrainEngine) {
  const [row] = await engine.executeRaw<{ title: string; body_storage: string }>('SELECT title, body_storage FROM pages WHERE slug=$1', [SLUG]);
  return row ?? null;
}

const importFile = async (engine: BrainEngine, file: string) =>
  importFromFile(engine, file, `${SLUG}.md`, { noEmbed: true, bodyPolicy: await readPageBodyPolicy(engine) });

test('a file rewritten between the passes with the same size and mtime is held, then imports whole', async () => {
  for (const engine of engines) {
    await engine.executeRaw('DELETE FROM pages');
    const file = join(dir, `${engine.kind}.md`);
    writeVersion(file, 'old');
    const before = statSync(file);
    const getPage = engine.getPage;
    let rewritten = false;
    engine.getPage = (async function (this: BrainEngine, slug: string, opts?: Parameters<BrainEngine['getPage']>[1]) {
      if (slug === SLUG && !rewritten) { rewritten = true; writeVersion(file, 'new'); }
      return getPage.call(this, slug, opts);
    }) as BrainEngine['getPage'];
    let result;
    try { result = await importFile(engine, file); } finally { engine.getPage = getPage; }
    const after = statSync(file);
    expect(rewritten).toBe(true);
    expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
    const page = await stored(engine);
    expect<Record<string, unknown>>({ status: result.status, title: page?.title ?? null }).toEqual({ status: 'skipped', title: null });
    expect(result.refusal?.code).toBe('file_too_large');
    expect(result.error).toContain('the file changed while it was imported');

    Object.assign(streamedImportWork, { blocks: 0, bytes: 0 });
    expect((await importFile(engine, file)).status).toBe('imported');
    expect(await stored(engine)).toEqual({ title: 'Drift new', body_storage: 'segmented' });
    expect(streamedImportWork.bytes).toBeGreaterThanOrEqual(PAGE_MAX_BYTES);
    expect(streamedImportWork.bytes).toBeLessThanOrEqual(after.size + 10 * MiB);
  }
}, 600_000);
