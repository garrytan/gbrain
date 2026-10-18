/**
 * Wave B PR 2 fix lane C2 (D7): forget keeps the caller's reason on a
 * segmented page, as on an inline one.
 *
 * 1. Protects: on the fence path (the source has a local path and the page a
 *    file) forget strikes the file's row with the caller's reason, and the
 *    stored body mirrors the file: an inline page takes the file's text, a
 *    segmented page takes the file's struck row in the segment holding the
 *    fence. Both stored rows read `forgotten: <reason>` (parity).
 * 2. Fails when: the segmented strike re-strikes the row the withdrawal
 *    already struck with the overlay's reason (`forgotten: memory withdrawn`)
 *    and keeps it, so the caller's reason never reaches the stored body.
 * 3. Out of scope: the legacy path (no file) gives both storages the
 *    overlay's reason; that is unchanged.
 * Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { forgetFactInFence } from '../../src/core/facts/forget.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { reconstructedPage } from '../helpers/segmented-page-checks.ts';
import { TEST_WRITE_ATTRIBUTION } from '../helpers/write-attribution.ts';
import { withEnv } from '../helpers/with-env.ts';

const REASON = 'asked to drop it on the call';
const home = mkdtempSync(join(tmpdir(), 'gbrain-forget-reason-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

const fence = (claim: string) => `<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | ${claim} | preference | 1.0 | world | medium | 2026-01-01 |  | chat | said at lunch |
| 2 | Walks to work | preference | 1.0 | world | medium | 2026-01-01 |  | chat |  |
<!--- gbrain:facts:end -->`;
const filler = (sections: number) => Array.from({ length: sections }, (_, i) => `## Part ${i}\n\n${'Notes on hiring and the budget review. '.repeat(30)}\n\n`).join('');

beforeAll(async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
  for (const engine of engines) { await registerLocalWriter(engine, 'cli'); await engine.setConfig('pages.segmented_storage', 'on'); }
}), 120_000);
afterAll(async () => { for (const engine of engines) await engine.disconnect(); await closePostgres?.(); rmSync(home, { recursive: true, force: true }); });

describe('forget reason on a segmented page', () => {
  test('the fence path stores the caller\'s reason in the segmented row, as in the inline row', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    for (const [index, engine] of engines.entries()) {
      const root = mkdtempSync(join(home, `brain-${index}-`));
      mkdirSync(join(root, 'notes'));
      await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [root, 'default']);
      const rows: Record<string, string | undefined> = {};
      for (const [storage, sections] of [['inline', 2], ['segmented', 1500]] as const) {
        const slug = `notes/forget-reason-${storage}`, claim = `Prefers the ${storage} window seat`;
        const content = `---\ntitle: Reason\ntype: note\n---\n\n# Reason\n\n## Facts\n\n${fence(claim)}\n\n${filler(sections)}`;
        writeFileSync(join(root, `${slug}.md`), content);
        await importFromContent(engine, slug, content, { noEmbed: true, sourceId: 'default' });
        const [fact] = await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw<{ id: number }>(`INSERT INTO facts(source_id,fact,entity_slug,visibility,source,source_markdown_slug,row_num)
          VALUES ('default',$1,$2,'world','test',$2,1) RETURNING id`, [claim, slug]), TEST_WRITE_ATTRIBUTION));
        const result = await withCoordinatedWrite(engine, ['default'], () => forgetFactInFence(engine, Number(fact!.id), { reason: REASON }), TEST_WRITE_ATTRIBUTION);
        expect(result).toMatchObject({ ok: true, path: 'fence' });
        const [page] = await engine.executeRaw<{ body_storage: string; compiled_truth: string | null }>('SELECT body_storage, compiled_truth FROM pages WHERE slug=$1', [slug]);
        expect(page!.body_storage).toBe(storage);
        const stored = storage === 'segmented' ? (await reconstructedPage(engine, slug)).body.compiled_truth : page!.compiled_truth!;
        const row = (text: string) => text.split('\n').find(line => line.startsWith('| 1 |'))?.replace(storage, 'STORAGE');
        expect(row(stored)).toBe(row(readFileSync(join(root, `${slug}.md`), 'utf8')));
        rows[storage] = row(stored);
      }
      expect(rows.segmented).toContain(`forgotten: ${REASON} \\| said at lunch`);
      expect(rows.segmented).toBe(rows.inline);
    }
  }), 300_000);
});
