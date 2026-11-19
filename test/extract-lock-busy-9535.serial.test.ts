import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import postgres from '#postgres';
import type { BrainEngine } from '../src/core/engine.ts';
import { extractStaleFromDB, runExtract } from '../src/commands/extract.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase } from './helpers/test-backends.ts';
import { lockDerivedLinkPages, DerivedLinkLockBusyError } from '../src/core/derived-link-lock.ts';
import { replaceDerivedLinksDeferringConflicts } from '../src/core/derived-links.ts';

// Real independent sessions: a mocked lock method cannot prove a database wait is bounded.
describe.skipIf(!process.env.DATABASE_URL)('DB extraction busy page guards (#9535)', () => {
  let engine: BrainEngine;
  let client: ReturnType<typeof postgres>;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const fixture = await isolatedPersistencePostgres(requirePostgresTestDatabase());
    engine = fixture.engine;
    close = fixture.close;
    client = postgres(fixture.databaseUrl, { max: 1, prepare: false });
    await engine.setConfig('mentions.auto_link', 'false');
  }, 120_000);
  afterAll(async () => { await client?.end(); await close?.(); });
  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM pages');
    for (const [slug, body] of [['notes/busy', 'See [[notes/target]].'], ['notes/healthy', 'See [[notes/target]].'], ['notes/target', 'Target.']]) {
      await engine.putPage(slug!, { type: 'note', title: slug!, compiled_truth: body! });
    }
    await engine.addLinksBatch([{ from_slug: 'notes/busy', to_slug: 'notes/healthy', link_source: 'markdown', link_type: 'references' }]);
  });

  async function held<T>(run: () => Promise<T>): Promise<{ value: T; released: boolean }> {
    let release!: () => void, ready!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { ready = resolve; });
    let released = false;
    const holder = client.begin(async sql => {
      await sql.unsafe("SELECT g.slug FROM page_write_guards g JOIN sources s ON s.incarnation=g.source_incarnation WHERE s.id='default' AND g.slug='notes/busy' FOR UPDATE OF g");
      ready();
      await gate;
      released = true;
    });
    // Safety release also makes stock upstream execute to completion, then fail the assertions.
    const safety = setTimeout(release, 8_000);
    try { await locked; const value = await run(); return { value, released }; }
    finally { clearTimeout(safety); release(); await holder; }
  }

  async function busyState() {
    return {
      page: await engine.executeRaw("SELECT knowledge_revision::text,links_extracted_at FROM pages WHERE slug='notes/busy'"),
      links: await engine.executeRaw("SELECT l.* FROM links l JOIN pages p ON p.id=l.from_page_id WHERE p.slug='notes/busy' ORDER BY l.id"),
    };
  }

  test('stale extraction defers a held page, preserves its projection and stamps a healthy sibling before release', async () => {
    const before = await busyState();
    const result = await held(() => extractStaleFromDB(engine, { dryRun: false, jsonMode: true, quiet: true, catchUp: true }));
    expect(result.released).toBe(false);
    expect(result.value).toMatchObject({ skippedLockBusy: 1, pagesProcessed: 2, staleRemaining: 1 });
    expect(await busyState()).toEqual(before);
    expect(await engine.executeRaw("SELECT 1 FROM links l JOIN pages f ON f.id=l.from_page_id WHERE f.slug='notes/healthy'")).toHaveLength(1);
    const retry = await extractStaleFromDB(engine, { dryRun: false, jsonMode: true, quiet: true, catchUp: true });
    expect(retry).toMatchObject({ pagesProcessed: 1, staleRemaining: 0 });
  }, 30_000);

  test('ordinary DB extraction replays a busy batch without losing the held projection', async () => {
    const before = await busyState();
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const run = async () => {
      await runExtract(engine, ['links', '--source', 'db', '--json']);
      return JSON.parse(String(log.mock.calls.at(-1)![0]));
    };
    try {
      const result = await held(run);
      expect(result.released).toBe(false);
      expect(result.value).toMatchObject({ skipped_lock_busy: 1, pages_processed: 2, links_created: 1 });
      expect(await busyState()).toEqual(before);
      const retry = await run();
      expect(retry.pages_processed).toBe(3);
    } finally { log.mockRestore(); }
  }, 30_000);

  test('a shorter caller timeout wins and successful acquisition restores the prior setting', async () => {
    await engine.transaction(async tx => {
      await tx.executeRaw("SET LOCAL lock_timeout='137ms'");
      await lockDerivedLinkPages(tx, [{ slug: 'notes/healthy', sourceId: 'default' }], 1_000);
      expect(await tx.executeRaw("SELECT current_setting('lock_timeout') AS value")).toEqual([{ value: '137ms' }]);
    });
    const result = await held(async () => {
      await expect(engine.transaction(async tx => {
        await tx.executeRaw("SET LOCAL lock_timeout='137ms'");
        await tx.executeRaw("SET LOCAL statement_timeout='500ms'");
        await lockDerivedLinkPages(tx, [{ slug: 'notes/busy', sourceId: 'default' }], 1_000);
      })).rejects.toBeInstanceOf(DerivedLinkLockBusyError);
    });
    expect(result.released).toBe(false);
    await engine.transaction(async tx => {
      await tx.executeRaw("SET LOCAL lock_timeout='3s'");
      await lockDerivedLinkPages(tx, [{ slug: 'notes/healthy', sourceId: 'default' }], 100);
      expect(await tx.executeRaw("SELECT current_setting('lock_timeout') AS value")).toEqual([{ value: '3s' }]);
    });
  }, 30_000);

  test('a lock error outside acquisition and unrelated storage errors remain fatal', async () => {
    const original = engine.replaceDerivedLinks;
    const snapshot = (await engine.readPageSnapshot('notes/healthy', { sourceId: 'default' }))!;
    const origin = { slug: 'notes/healthy', sourceId: 'default', expectedRevision: snapshot.revision, sourceIncarnation: snapshot.sourceIncarnation };
    try {
      for (const code of ['55P03', '57014', '08006']) {
        const failure = Object.assign(new Error('injected publication failure'), { code });
        engine.replaceDerivedLinks = async function () { throw failure; };
        await expect(replaceDerivedLinksDeferringConflicts(engine, origin, [], { lockTimeoutMs: 100 })).rejects.toBe(failure);
      }
    } finally { engine.replaceDerivedLinks = original; }
  });
});
