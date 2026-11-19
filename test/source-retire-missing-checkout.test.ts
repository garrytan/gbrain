/**
 * #5219: on a managed brain, archive/remove/purge of a source whose canonical
 * checkout was deleted out of band succeeds for a zero-page source that is its
 * checkout's sole member (the receipt records `retired_without_checkout`). A
 * source with pages, or one sharing its checkout, keeps refusing
 * `recovery_required`, now naming the counts and the exits.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { runManagedSourceLifecycle } from '../src/core/persistence/source-lifecycle.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { flagRejection, gbrainInvocations, liveCliVerbs } from './helpers/cli-command-surface.ts';

function expectRunnableFix(fix: string) {
  const invocations = [...fix.matchAll(/(?:foresights|gbrain) [^,;()]+/g)].flatMap(m => gbrainInvocations(m[0].replace(/\.$/, '').trim()));
  expect(invocations.length).toBeGreaterThan(1);
  for (const inv of invocations) {
    expect(liveCliVerbs().has(inv.verb)).toBe(true);
    expect(flagRejection(inv)).toBeNull();
  }
}

const databaseUrl = process.env.DATABASE_URL;
for (const flavor of ['pglite', ...(databaseUrl ? ['postgres'] : [])] as const) describe(`retire a source whose checkout vanished (${flavor})`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (flavor === 'postgres') { const pg = await isolatedPersistencePostgres(databaseUrl!); engine = pg.engine; closePostgres = pg.close; }
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
  }, 120_000);
  afterAll(async () => { if (!engine) return; await disposePersistenceConsumer(engine); if (closePostgres) await closePostgres(); else await engine.disconnect(); });

  /** Claims each source at its own directory (or a shared Git root), seeds while classic, activates, then deletes the checkout. */
  async function fixture(sources: string[], opts: { shared?: boolean; seed?: (source: string) => Promise<void> }, run: (home: string, gone: string) => Promise<void>) {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-retire-missing-'));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        if (flavor === 'pglite') await resetPgliteState(engine as PGLiteEngine);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await registerLocalWriter(engine, 'cli');
        const checkout = join(home, 'profile');
        mkdirSync(checkout);
        if (opts.shared) execFileSync('git', ['init', '--quiet', checkout]);
        for (const source of sources) {
          const root = opts.shared ? join(checkout, source) : checkout;
          mkdirSync(root, { recursive: true });
          writeFileSync(join(root, 'example.md'), '---\ntitle: Example\ntype: note\n---\n\nCanonical\n');
          await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [source, root]);
          await claimWorktree(engine, source, root);
          await opts.seed?.(source);
        }
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        rmSync(checkout, { recursive: true, force: true });
        try { await run(home, checkout); }
        finally {
          await disposePersistenceConsumer(engine);
          await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
          for (const source of sources) await engine.executeRaw('DELETE FROM sources WHERE id=$1', [source]);
        }
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }

  test('a zero-page sole-member source archives, then purges, with a receipt naming the missing checkout', () => fixture(['empty-profile'], {}, async (_home, gone) => {
    const archived = await runManagedSourceLifecycle(engine, { operation: 'archive', sourceId: 'empty-profile' });
    expect(archived).toMatchObject({ operation: 'archive', source_id: 'empty-profile', retired_without_checkout: gone });
    expect((await engine.executeRaw<{ archived: boolean }>('SELECT archived FROM sources WHERE id=$1', ['empty-profile']))[0].archived).toBe(true);
    const purged = await runManagedSourceLifecycle(engine, { operation: 'purge', sourceId: 'empty-profile', confirmDestructive: true });
    expect(purged).toMatchObject({ operation: 'purge', pages_deleted: 0, retired_without_checkout: gone });
    expect(await engine.executeRaw('SELECT id FROM sources WHERE id=$1', ['empty-profile'])).toEqual([]);
  }), 60_000);

  test('a zero-page sole-member source can be removed directly', () => fixture(['empty-remove'], {}, async (_home, gone) => {
    const removed = await runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: 'empty-remove', confirmDestructive: true });
    expect(removed).toMatchObject({ operation: 'remove', pages_deleted: 0, retired_without_checkout: gone });
    expect(await engine.executeRaw('SELECT id FROM sources WHERE id=$1', ['empty-remove'])).toEqual([]);
    expect(await engine.executeRaw('SELECT source_id FROM persistence_source_bindings WHERE source_id=$1', ['empty-remove'])).toEqual([]);
  }), 60_000);

  test('a source with pages keeps refusing, naming its page count and the exits', () => fixture(['with-pages'], {
    seed: async source => { await engine.putPage('notes/kept', { type: 'note', title: 'Kept', compiled_truth: 'Still here.' }, { sourceId: source }); },
  }, async (_home, gone) => {
    const error = await runManagedSourceLifecycle(engine, { operation: 'archive', sourceId: 'with-pages' }).catch((e: Error) => e) as Error & Record<string, string>;
    expect(error).toMatchObject({ code: 'recovery_required', docs: 'docs/guides/write-refusals.md#source_checkout_missing' });
    expect(error.message).toContain(`The canonical checkout ${gone} of source 'with-pages' is missing`);
    expect(error.message).toContain('(pages: 1, other sources on the checkout: 0)');
    expect(error.suggestion).toContain('foresights sources writer deactivate --dry-run');
    expect(error.suggestion).toContain('foresights sources archive with-pages');
    expectRunnableFix(error.suggestion);
    expect((await engine.executeRaw<{ archived: boolean }>('SELECT archived FROM sources WHERE id=$1', ['with-pages']))[0].archived).toBe(false);
  }), 60_000);

  test('an empty source sharing its vanished checkout with another source keeps refusing', () => fixture(['shared-first', 'shared-second'], { shared: true }, async () => {
    const error = await runManagedSourceLifecycle(engine, { operation: 'remove', sourceId: 'shared-first', confirmDestructive: true }).catch((e: Error) => e) as Error & Record<string, string>;
    expect(error).toMatchObject({ code: 'recovery_required' });
    expect(error.message).toContain('(pages: 0, other sources on the checkout: 1)');
    expect(await engine.executeRaw('SELECT id FROM sources WHERE id=$1', ['shared-first'])).toHaveLength(1);
  }), 60_000);
});
