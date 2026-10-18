/**
 * Wave B PR 2 fix lane H (finding H1): timeline retraction reads retained segmented generations with the live body's
 * block cutter, and reads each stored run once.
 *
 * 1. Protects: a retained generation is cut into blocks as bodyBlocks cuts the live body (a forced cut at a line
 *    boundary ends a block), so a page of dated bullets over BLOCK_MAX_BYTES with a segmented version is pruned, not
 *    refused; and a run of a retained generation whose key the live body (or an earlier generation) already read is
 *    skipped, so pruning a page with several versions that share their compiled truth reads that truth once.
 * 2. Fails when: retainedGenerationBlocks joins every run of forced cuts into one block (page_body_segmented on the
 *    9 MiB timeline), or reads every retained generation in full (the bytes read grow with the version count).
 * Runs on PGLite, and on Postgres when DATABASE_URL is set. Seams: segmentedPassWork.bytes (a work count, not time).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { extractTimelineFromDB } from '../../src/commands/extract-timeline-db.ts';
import { pruneTimelineOrphans } from '../../src/core/timeline-extract.ts';
import { BLOCK_MAX_BYTES, segmentedPassWork } from '../../src/core/page-body/segment-blocks.ts';
import { conversationBody } from '../helpers/conversation-page.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const MB = 1024 * 1024;

/** A short truth, then about `bytes` of dated bullets with no blank line (every cut forced), the first one `first`. */
function bulletPage(bytes: number, first: string): string {
  const bullets = [first + '\n'];
  let size = first.length + 1;
  for (let i = 0; size < bytes; i++) {
    const line = '- **20' + String(10 + (i % 15)) + '-0' + (1 + (i % 9)) + '-1' + (i % 10) + '** | Met acme-example about item ' + i + '\n';
    bullets.push(line);
    size += line.length;
  }
  return '---\ntitle: Bullet timeline\ntype: note\n---\nA short truth.\n\n<!-- timeline -->\n\n' + bullets.join('');
}

/** About 2.4 MiB of conversation in the truth, then the dated bullets. */
const versionedPage = (bullets: string[]) => '---\ntype: note\ntitle: Versions\n---\n\n' + conversationBody(1_200_000, { seed: 51 }) + '\n\n'
  + conversationBody(1_200_000, { seed: 52 }) + '\n\n## Timeline\n\n' + bullets.join('\n') + '\n';

const summaries = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ summary: string }>(
  'SELECT t.summary FROM timeline_entries t JOIN pages p ON p.id=t.page_id WHERE p.slug=$1 AND t.event_page_id IS NULL ORDER BY t.summary', [slug])).map(row => row.summary);

for (const kind of testBackends()) {
  describe('timeline retraction over retained generations (' + kind + ')', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') {
        const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
        engine = pg.engine;
        close = pg.close;
      } else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      await engine.setConfig('pages.segmented_storage', 'on');
    }, 120_000);

    afterAll(async () => { await close(); });

    test('a 9 MiB timeline of dated bullets with a segmented version is pruned, not refused', async () => {
      const slug = 'notes/bullets-versioned';
      const removed = '- **2009-01-01** | A bullet the next version drops';
      const older = bulletPage(9 * MB, removed);
      expect(Buffer.byteLength(older)).toBeGreaterThan(BLOCK_MAX_BYTES);
      expect((await importFromContent(engine, slug, older, { sourceId: 'default', noEmbed: true })).status).toBe('imported');
      await extractTimelineFromDB(engine, { dryRun: false, jsonMode: false, quiet: true, sourceIdFilter: 'default', slugs: [slug] });
      expect(await summaries(engine, slug)).toContain('A bullet the next version drops');
      expect((await importFromContent(engine, slug, older.replace(removed + '\n', '- **2009-01-02** | Its replacement\n'), { sourceId: 'default', noEmbed: true })).status).toBe('imported');
      const [versions] = await engine.executeRaw<{ n: number }>(
        "SELECT count(*)::int AS n FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.slug=$1 AND v.body_storage='segmented'", [slug]);
      expect(versions!.n).toBeGreaterThanOrEqual(1);
      const pruned = await pruneTimelineOrphans(engine, { sourceId: 'default', dryRun: false }).then(r => r, (e: unknown) => ({ error: (e as { code?: string }).code ?? String(e) }));
      console.log('[retained-blocks] ' + kind + ' 9 MiB bullets: ' + JSON.stringify(pruned));
      expect(pruned).toMatchObject({ removed: 1 });
      expect(await summaries(engine, slug)).not.toContain('A bullet the next version drops');
    }, 900_000);

    test('versions that share their compiled truth: the prune reads that truth once, not once per version', async () => {
      const slug = 'notes/shared-truth';
      await engine.executeRaw('UPDATE pages SET deleted_at = now() WHERE deleted_at IS NULL');
      const steps = [['- **2026-03-04** | Kickoff', '- **2026-04-05** | Pricing review'], ['- **2026-03-04** | Kickoff'],
        ['- **2026-03-04** | Kickoff', '- **2026-05-06** | Launch'], ['- **2026-03-04** | Kickoff', '- **2026-05-06** | Launch', '- **2026-06-07** | Retro']];
      for (const [n, bullets] of steps.entries()) {
        expect((await importFromContent(engine, slug, versionedPage(bullets), { sourceId: 'default', noEmbed: true })).status).toBe('imported');
        if (n === 0) await extractTimelineFromDB(engine, { dryRun: false, jsonMode: false, quiet: true, sourceIdFilter: 'default', slugs: [slug] });
      }
      const [live] = await engine.executeRaw<{ id: number; body_bytes: number; body_storage: string }>('SELECT id, body_bytes, body_storage FROM pages WHERE slug=$1', [slug]);
      expect(live!.body_storage).toBe('segmented');
      const versions = await engine.executeRaw<{ body_bytes: number }>("SELECT DISTINCT body_generation, body_bytes FROM page_versions WHERE page_id=$1 AND body_storage='segmented'", [live!.id]);
      expect(versions.length).toBeGreaterThanOrEqual(3);
      const before = segmentedPassWork.bytes;
      const pruned = await pruneTimelineOrphans(engine, { sourceId: 'default', dryRun: false });
      const read = segmentedPassWork.bytes - before;
      console.log('[retained-blocks] ' + kind + ' shared truth: ' + read + ' bytes read for a ' + live!.body_bytes + '-byte page with ' + versions.length + ' retained generations');
      expect(pruned.removed).toBe(1);
      expect(await summaries(engine, slug)).toEqual(['Kickoff']);
      expect(read).toBeLessThan(2 * Number(live!.body_bytes));
    }, 900_000);
  });
}
