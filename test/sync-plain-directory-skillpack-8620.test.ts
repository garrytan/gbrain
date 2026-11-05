/**
 * #8620: the 0.53.0 DB-only export binds a plain directory and installs the shared memory pack into it (skillpack.json
 * plus skills/<name>/SKILL.md). Plain-directory sync must leave those reserved paths to the shared skill publisher, the
 * way managed Git sync discovery does, instead of handing them to the importer, which refuses each one with
 * skill_bundle_required and blocks the source for good.
 * Fails when: the sync after the export ends blocked_by_failures, the dry run counts the pack's files, the sync
 * writes the pack into pages or the shared skill catalog, or a skill the publisher writes while the sync walks the
 * directory reaches the importer and blocks the run.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { exportDatabaseContent } from '../src/core/shared-skills/migration-export.ts';
import { performSync } from '../src/commands/sync.ts';
import { withEnv } from './helpers/with-env.ts';

const catalogTables = ['shared_skill_packs', 'shared_skill_members', 'shared_skill_heads', 'shared_skill_revisions', 'shared_skill_state', 'shared_skill_policies'];
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => {
  await engine.disconnect();
});

async function catalog(): Promise<Record<string, unknown[]>> {
  const rows: Record<string, unknown[]> = {};
  for (const table of catalogTables) rows[table] = await engine.executeRaw(`SELECT * FROM ${table} ORDER BY 1`);
  return rows;
}

test('a plain directory holding the exported memory pack syncs, and the dry run leaves the pack out', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-plain-skillpack-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      await engine.putPage('notes/example', { type: 'note', title: 'Example', compiled_truth: 'A saved observation.', timeline: '' }, { sourceId: 'default' });
      const ctx: OperationContext = { engine, config: { engine: 'pglite', mcp: { publish_skills: false } }, remote: false, dryRun: false, sourceId: 'default', logger: { info() {}, warn() {}, error() {} } };
      const root = join(home, 'content');
      expect((await exportDatabaseContent(ctx, { sourceId: 'default', root, confirmQuiesced: true, backup: 'operator_verified' })).status).toBe('complete');
      for (const path of ['skillpack.json', 'skills/brain-router/SKILL.md', 'skills/memory-recall/SKILL.md', 'skills/memory-care/SKILL.md']) expect(existsSync(join(root, path))).toBe(true);
      const before = await catalog();

      expect(await performSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, dryRun: true })).toMatchObject({ status: 'dry_run', added: 1 });
      const synced = await performSync(engine, { sourceId: 'default', noPull: true, noEmbed: true });
      expect(synced.status).toBe('synced');
      expect(synced.failedFiles ?? 0).toBe(0);
      const [source] = await engine.executeRaw<{ last_sync_at: unknown }>("SELECT last_sync_at FROM sources WHERE id='default'");
      expect(source?.last_sync_at).not.toBeNull();
      expect(await engine.executeRaw("SELECT slug FROM pages WHERE source_id='default' AND (slug ILIKE 'skills/%' OR slug ILIKE 'skillpack%')")).toEqual([]);
      expect(await catalog()).toEqual(before);

      const realReaddir = fs.readdirSync;
      let published = false;
      const readdir = spyOn(fs, 'readdirSync').mockImplementation(((path: fs.PathLike, ...rest: unknown[]) => {
        const entries = (realReaddir as (...args: unknown[]) => unknown)(path, ...rest);
        if (!published && String(path) === fs.realpathSync(root) && new Error().stack?.includes('collectSyncableFiles')) {
          published = true;
          mkdirSync(join(root, 'team-example', 'skills', 'late-example'), { recursive: true });
          writeFileSync(join(root, 'team-example', 'skills', 'late-example', 'SKILL.md'), '---\nname: late-example\n---\n\nPublished while the sync runs.\n');
        }
        return entries;
      }) as typeof fs.readdirSync);
      try {
        expect(await performSync(engine, { sourceId: 'default', noPull: true, noEmbed: true })).toMatchObject({ status: 'synced' });
      } finally { readdir.mockRestore(); }
      expect(published).toBe(true);
      expect(await performSync(engine, { sourceId: 'default', noPull: true, noEmbed: true })).toMatchObject({ status: 'synced' });
      expect(await engine.executeRaw("SELECT slug FROM pages WHERE source_id='default' AND (slug ILIKE 'skills/%' OR slug ILIKE '%/skills/%')")).toEqual([]);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}, 180_000);
