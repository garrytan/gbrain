/**
 * D-21 (GBRA-131).
 * Protects: migration verification reads the copy of record, not a stale
 * checkout, for classic database-only pages and write-through-disabled brains.
 * Fails when: a wrong copy produces false drift or a false complete migration.
 * Existing migration tests cover managed snapshots and classic files, not this
 * classic placement matrix. These probes compare all page, fact and history
 * rows and file bytes before/after: verification must never repair anything.
 * Seams: no new production seam; proxies inject a snapshot read failure or
 * order the segmented group before a healthy group to prove continuation.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { __testing } from '../../src/commands/migrations/v0_32_2.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { renderFactsTable } from '../../src/core/facts-fence.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { createSegmentedPage, segmentedPageState } from '../helpers/segmented-page.ts';
import { withEnv } from '../helpers/with-env.ts';
import { expectOthersUnchanged, expectUnitNotAborted, pathologicalArms, runScopedErrors, snapshotItems } from './harness.ts';

const SLUG = 'private/example';
const OPTS = { yes: true, dryRun: false, noAutopilotInstall: true };
const fence = (rowNum: number) => '# Example\n\n' + renderFactsTable([{ rowNum, claim: 'A synthetic claim', kind: 'fact', confidence: 1,
  visibility: 'private', notability: 'medium', validFrom: '2026-01-01', source: 'manual', active: true }]);

async function withBrain(databaseUrl: string | undefined, run: (engine: BrainEngine, root: string) => Promise<void>) {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-d21-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        _resetWriteThroughCacheForTest();
        const root = join(home, 'brain');
        mkdirSync(root);
        await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
        await engine.putPage('notes/sibling', { type: 'note', title: 'Sibling', compiled_truth: 'Keep this sibling exactly.' });
        await run(engine, root);
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

async function seed(engine: BrainEngine, root: string, opts: { db: number; file?: number; origin?: 'path' | 'uri'; segmented?: boolean }) {
  const { id } = opts.segmented
    ? await createSegmentedPage(engine, { slug: SLUG, truth: fence(opts.db) })
    : await engine.putPage(SLUG, { type: 'note', title: 'Example', compiled_truth: fence(opts.db) });
  if (opts.origin === 'path') await engine.executeRaw('UPDATE pages SET source_path=$1 WHERE id=$2', ['recorded/example.md', id]);
  const path = join(root, opts.origin ? 'recorded/example.md' : `${SLUG}.md`);
  if (opts.origin === 'uri') await engine.executeRaw('UPDATE pages SET source_uri=$1 WHERE id=$2', [`file://${path}`, id]);
  if (opts.file !== undefined) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, fence(opts.file));
  }
  await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence, row_num, source_markdown_slug)
    VALUES ('default',$1,'A synthetic claim','fact','private','medium','2026-01-01','manual',1,1,$1)`, [SLUG]);
  return { id, path };
}

async function state(engine: BrainEngine, path: string) {
  return { pages: await engine.executeRaw('SELECT * FROM pages ORDER BY id'), facts: await engine.executeRaw('SELECT * FROM facts ORDER BY id'),
    versions: await engine.executeRaw('SELECT * FROM page_versions ORDER BY id'), file: existsSync(path) ? readFileSync(path, 'utf8') : null };
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`D-21 classic migration copy of record (${backend})`, () => {
    for (const mode of ['off', 'declared', 'originless', 'no-root'] as const) {
      for (const db of [1, 2]) {
        test(`${mode}: ${db === 1 ? 'accepts the database fence despite a stale file' : 'detects database drift even if the file agrees'}`, async () => {
          await withBrain(databaseUrl, async (engine, root) => {
            const f = await seed(engine, root, { db, file: mode === 'off' || mode === 'declared' ? (db === 1 ? 2 : 1) : undefined,
              origin: mode === 'off' || mode === 'declared' ? 'path' : undefined });
            if (mode === 'off') await engine.setConfig('sync.write_through', 'off');
            if (mode === 'declared') writeFileSync(join(root, 'gbrain.yml'), 'storage:\n  db_only:\n    - private/\n');
            if (mode === 'no-root') await engine.executeRaw("UPDATE sources SET local_path=NULL WHERE id='default'");
            const before = await state(engine, f.path);
            const items = await snapshotItems(engine, 'default');
            const result = await expectUnitNotAborted(() => __testing.phaseCVerify(engine, OPTS));
            expect(await state(engine, f.path)).toEqual(before);
            expectOthersUnchanged(items, await snapshotItems(engine, 'default'));
            expect(result.status).toBe(db === 1 ? 'complete' : 'failed');
            expect(result.detail).toBe(db === 1 ? 'pages_checked=1' : `1 pages drifted: ${SLUG} (fence=1, db=1; not indexed: 2; not in fence: 1)`);
          });
        }, 180_000);
      }
    }

    for (const origin of [undefined, 'path', 'uri'] as const) {
      test(`write-through on with ${origin ?? 'unrecorded existing'} file: file drift is authoritative`, async () => {
        await withBrain(databaseUrl, async (engine, root) => {
          const f = await seed(engine, root, { db: 1, file: 2, origin });
          const before = await state(engine, f.path);
          expect(await __testing.phaseCVerify(engine, OPTS)).toMatchObject({ status: 'failed', detail: expect.stringContaining('not indexed: 2; not in fence: 1') });
          expect(await state(engine, f.path)).toEqual(before);
        });
      }, 180_000);
    }

    for (const origin of ['path', 'uri'] as const) {
      test(`missing recorded ${origin} is not database-only, but expired rows may skip`, async () => {
        await withBrain(databaseUrl, async (engine, root) => {
          const f = await seed(engine, root, { db: 1, origin });
          const before = await state(engine, f.path);
          expect(await __testing.phaseCVerify(engine, OPTS)).toEqual({ name: 'verify', status: 'failed', detail: `1 pages drifted: ${SLUG} (file missing)` });
          expect(await state(engine, f.path)).toEqual(before);
          await engine.executeRaw('UPDATE facts SET expired_at=now()');
          const expired = await state(engine, f.path);
          expect(await __testing.phaseCVerify(engine, OPTS)).toEqual({ name: 'verify', status: 'complete', detail: 'pages_checked=0 skipped_expired_no_page=1' });
          expect(await state(engine, f.path)).toEqual(expired);
        });
      }, 180_000);
    }

    test('segmented database-only page is held without changing its generation or history', async () => {
      await withBrain(databaseUrl, async (engine, root) => {
        const f = await seed(engine, root, { db: 1, segmented: true });
        await engine.putPage('zz/healthy', { type: 'note', title: 'Healthy', compiled_truth: fence(1) });
        await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence, row_num, source_markdown_slug)
          VALUES ('default','zz/healthy','A synthetic claim','fact','private','medium','2026-01-01','manual',1,1,'zz/healthy')`);
        const before = await state(engine, f.path);
        const segments = await segmentedPageState(engine, f.id);
        const checked: string[] = [];
        const ordered = new Proxy(engine, { get(target, key) {
          if (key === 'executeRaw') return async (sql: string, params?: unknown[]) => {
            const rows = await target.executeRaw(sql, params);
            return sql.includes('array_agg(row_num') ? rows.sort((a, b) => String(a.source_markdown_slug).localeCompare(String(b.source_markdown_slug))) : rows;
          };
          if (key === 'readPageSnapshot') return async (...args: Parameters<BrainEngine['readPageSnapshot']>) => {
            checked.push(args[0]);
            return target.readPageSnapshot(...args);
          };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        } });
        expect(await __testing.phaseCVerify(ordered, OPTS)).toMatchObject({ status: 'failed',
          detail: expect.stringContaining(`1 pages drifted: ${SLUG} (page_body_segmented:`) });
        expect(checked).toEqual([SLUG, 'zz/healthy']);
        expect(await state(engine, f.path)).toEqual(before);
        expect(await segmentedPageState(engine, f.id)).toEqual(segments);
      });
    }, 180_000);

    test('snapshot read failures stop verification without mutation, not a successful zero-page scan', async () => {
      await withBrain(databaseUrl, async (engine, root) => {
        const f = await seed(engine, root, { db: 1 });
        const before = await state(engine, f.path);
        for (const failure of runScopedErrors()) {
          let reached = false;
          const proxy = new Proxy(engine, { get(target, key) {
            if (key === 'readPageSnapshot') return async () => { reached = true; throw failure.error(); };
            const value = Reflect.get(target, key, target);
            return typeof value === 'function' ? value.bind(target) : value;
          } });
          expect(await __testing.phaseCVerify(proxy, OPTS)).toMatchObject({ status: 'failed' });
          expect(reached).toBe(true);
          expect(await state(engine, f.path)).toEqual(before);
        }
      });
    }, 180_000);
  });
}
