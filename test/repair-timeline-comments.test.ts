/**
 * `gbrain repair timeline-comments` (#6184): junk timeline rows filed from HTML
 * comments, and the materialized bullets that copied a section END marker into
 * the page, are cleaned through coordinated writes; preview first, a second
 * apply is a no-op, valid bullets are untouched. Runs on PGLite and, through
 * test/e2e, Postgres.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { materializedMarker } from '../src/core/timeline-marker.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-timeline-comments-'));
let closePostgres: (() => Promise<void>) | undefined;
const logger = { info() {}, warn() {}, error() {} };

beforeAll(async () => {
  if (backends.includes('pglite')) { const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); if (engine.kind === 'pglite') await engine.disconnect(); }
  await closePostgres?.(); rmSync(dataDir, { recursive: true, force: true });
});

const slug = 'people/alice-example';
const END = '<!-- AUTO:slack END -->';
const junkOnly = { date: '2026-10-04', source: 'Slack import', summary: END };
const junkSuffix = { date: '2026-10-05', source: 'Slack import', summary: `Talked with alice-example about the launch. ${END}` };
/** What the pre-fix write-back rendered for a junk row: a marked bullet carrying a second copy of the END marker. */
const junkBullet = (row: typeof junkOnly) => `${materializedMarker(row)}\n- **${row.date}** | ${row.source} — ${row.summary}`;
const body = [
  '---\ntype: person\ntitle: Alice Example\n---',
  '<!-- AUTO:slack BEGIN -->',
  '- Talked with alice-example about the launch. [Source: Slack import, 2026-10-05]',
  END,
  '',
  '## Timeline',
  '',
  '- **2026-09-01** | markdown — Joined acme-example',
  junkBullet(junkOnly),
  junkBullet(junkSuffix),
  '',
].join('\n');

test('preview counts junk rows and bullets; apply cleans them; a second apply is a no-op', async () => {
  for (const engine of engines) {
    const dir = mkdtempSync(join(dataDir, 'case-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    const sourceId = `comments-${randomUUID().slice(0, 8)}`;
    const ctx = { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true }, dryRun: false, logger } as never;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await claimWorktree(engine, sourceId, root);
        await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content: body, request_id: randomUUID() } });
        // The rows the pre-fix citation parser filed, as an upgraded brain has them.
        await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], async () => {
          for (const row of [junkOnly, junkSuffix]) await tx.executeRaw(`INSERT INTO timeline_entries(page_id,date,source,summary,detail)
            SELECT id,$3::date,$4,$5,'' FROM pages WHERE source_id=$1 AND slug=$2 ON CONFLICT DO NOTHING`, [sourceId, slug, row.date, row.source, row.summary]);
        }, TEST_WRITE_ATTRIBUTION));
        const rows = async () => (await engine.executeRaw<{ d: string }>(`SELECT t.date::text || ' ' || t.source || ' — ' || t.summary AS d FROM timeline_entries t
          JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1 AND p.slug=$2 AND t.event_page_id IS NULL ORDER BY 1`, [sourceId, slug])).map(r => r.d);
        const stored = async () => { const s = (await engine.readPageSnapshot(slug, { sourceId }))!; return `${s.page.compiled_truth}\n${s.page.timeline ?? ''}`; };
        expect((await rows()).some(r => r.includes('<!--'))).toBe(true);

        const scope = await resolveRepairScope(engine, sourceId);
        const timelinePreview = async () => (await repairRunner(engine, { apply: false, logger })).run('timeline', scope, { sourceFlag: sourceId });
        expect((await timelinePreview()).warnings?.join('\n')).toContain(`timeline_comment_markup: 2 timeline row(s)`);
        expect((await timelinePreview()).warnings?.join('\n')).toContain(`gbrain repair timeline-comments --source ${sourceId}`);
        const preview = await (await repairRunner(engine, { apply: false, logger })).run('timeline-comments', scope, { explicit: true, sourceFlag: sourceId });
        expect(preview).toMatchObject({ mode: 'dry_run', affected: 1, residuals: { comment_only_rows: 1, comment_bearing_rows: 1, pages_with_comment_bullets: 1 } });
        expect(await stored()).toContain(junkBullet(junkOnly));

        const applied = await (await repairRunner(engine, { apply: true, logger })).run('timeline-comments', scope, { explicit: true, sourceFlag: sourceId });
        expect(applied).toMatchObject({ applied: 1, complete: true });
        expect(await rows()).toEqual(['2026-09-01 markdown — Joined acme-example', '2026-10-05 Slack import — Talked with alice-example about the launch.']);
        const after = await stored();
        expect(after.split(END).length - 1).toBe(1);
        expect(after).toContain('- **2026-09-01** | markdown — Joined acme-example');
        expect(after).not.toContain('Slack import — <!--');

        const again = await (await repairRunner(engine, { apply: true, logger })).run('timeline-comments', scope, { explicit: true, sourceFlag: sourceId });
        expect(again).toMatchObject({ affected: 0, applied: 0, complete: true });
        expect((await timelinePreview()).warnings ?? []).toEqual([]);
      });
    } finally {
      await disposePersistenceConsumer(engine);
    }
  }
}, 120_000);
