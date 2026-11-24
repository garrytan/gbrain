/**
 * GST-3623 follow-up: `gbrain extract --stale` over a segmented transcript failed with code internal ("undefined is not an
 * object (evaluating '[key, entry]')") when a stored timeline derivation row named an entry digest its run's text no longer
 * yields (a row derived by an older parser). The incremental canonical timeline read must not trust such a row: it takes the
 * full pass, which reads every entry from the text.
 *
 * 1. Protects: a stored timeline row with a digest its run does not yield gives the full pass's entries, not a crash; the
 *    managed stale extraction over that page finishes.
 * 2. Fails when: incrementalCanonicalTimeline destructures the missing entry (TypeError).
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { extractManagedStaleLinks } from '../../src/core/persistence/links-maintenance.ts';
import { storedCanonicalTimeline } from '../../src/core/persistence/canonical-projections.ts';
import { bodyUnread } from '../../src/core/page-body/page-shape.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

const MB = 1024 * 1024;
const SLUG = 'transcripts/session-example';

/** A conversation transcript over 1 MiB: a short truth, then dated turns in the timeline. */
function transcript(): string {
  const turns: string[] = [];
  let size = 0;
  for (let i = 0; size < MB + MB / 4; i++) {
    const line = '- **20' + String(10 + (i % 15)) + '-0' + (1 + (i % 9)) + '-1' + (i % 10) + '** | alice-example asked about item ' + i + ' ' + 'and the reply followed '.repeat(6) + '\n';
    turns.push(line);
    size += line.length;
  }
  return '---\ntitle: Session example\ntype: transcript\n---\nA conversation archive.\n\n<!-- timeline -->\n\n' + turns.join('');
}

const digest = (key: string) => Number.parseInt(createHash('sha256').update(key).digest('hex').slice(0, 13), 16);

for (const kind of testBackends()) {
  describe('segmented timeline read with a stale derivation row (' + kind + ')', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-stale-timeline-row-'));

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({ database_path: join(dir, 'db') });
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      await engine.setConfig('pages.segmented_storage', 'on');
    }, 120_000);

    afterAll(async () => {
      await disposePersistenceConsumer(engine);
      await close();
      rmSync(dir, { recursive: true, force: true });
    });

    test('a row naming an entry its run no longer yields takes the full pass; extract --stale finishes', async () => {
      const root = join(dir, 'brain');
      mkdirSync(root, { recursive: true });
      const sourceId = 'stale-row-' + kind;
      await withEnv({ GBRAIN_HOME: join(dir, 'home'), GBRAIN_AUDIT_DIR: join(dir, 'audit') }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        const content = transcript();
        expect((await importFromContent(engine, SLUG, content, { sourceId, noEmbed: true })).status).toBe('imported');
        const { page } = (await engine.readPageSnapshot(SLUG, { sourceId }))!;
        expect(bodyUnread(page)).toBe(true);
        const full = await storedCanonicalTimeline(engine, page, SLUG);
        expect(full.size).toBeGreaterThan(0);

        const [row] = await engine.executeRaw<{ occurrence_id: string; output: unknown }>(`SELECT d.occurrence_id::text AS occurrence_id, d.output FROM page_segment_derivations d
          WHERE d.page_id=$1 AND d.pipeline='timeline' AND d.output ? 'x' ORDER BY d.occurrence_id DESC LIMIT 1`, [Number(page.id)]);
        expect(row).toBeDefined();
        const output = (typeof row!.output === 'string' ? JSON.parse(row!.output) : row!.output) as { x: number[]; p: number[]; m: number[]; s: number[] };
        output.x.push(digest('2019-01-01\u0000markdown\u0000a turn an older parser read'));
        await engine.executeRaw(`UPDATE page_segment_derivations SET output=$3::text::jsonb WHERE page_id=$1 AND pipeline='timeline' AND occurrence_id=$2::bigint`,
          [Number(page.id), row!.occurrence_id, JSON.stringify(output)]);

        const again = await storedCanonicalTimeline(engine, page, SLUG);
        expect([...again.keys()]).toEqual([...full.keys()]);
        const result = await extractManagedStaleLinks(engine, { sourceId, slugs: [SLUG], mentions: false });
        expect(result).toBeDefined();
      });
    }, 180_000);
  });
}
