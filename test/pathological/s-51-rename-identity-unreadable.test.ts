/**
 * GBRA-133 S-51 (PR 1 item 1): a NUL or a lone surrogate in a title or frontmatter id used to reach
 * confirmRenameIdentities' text[] parameters, so every classic incremental run of the source failed with SQLSTATE
 * 22021 and no ledger row (only --full escaped). Such values are now absent before any SQL (the pair takes today's
 * unconfirmed-rename rules, never a normalized value), and a value the database still refuses (22021/22P05) holds only
 * the pair carrying it as rename_identity_unreadable, keeping the old page whole; any other error stays the run's.
 * Classic sync on PGLite, and on Postgres through test/e2e/s-51-rename-identity-unreadable-postgres.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { performSync } from '../../src/commands/sync/perform.ts';
import { readGitSourceHolds, gitHoldItem } from '../../src/core/persistence/sync-holds.ts';
import { frontmatterIdentity } from '../../src/core/sync-rename-identity.ts';
import { loadSyncFailures } from '../../src/core/sync-failure-ledger.ts';
import { expectUnitNotAborted, pathologicalArms } from './harness.ts';
import { md, withProbeEngine, withProbeRepo, type ProbeRepo } from './s-blockers-fixture.ts';

const body = (title: string, extra = '') => `---\ntitle: ${title}\ntype: note\n---\n${Array.from({ length: 12 }, (_, i) => `Line ${i} of the ${title} note, long enough that git pairs an edited move.`).join('\n')}\n${extra}`;
const page = async (engine: BrainEngine, sourceId: string, slug: string): Promise<number | null> =>
  (await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, slug]))[0]?.id ?? null;
const holdsOf = async (engine: BrainEngine, sourceId: string) => ((await readGitSourceHolds(engine, { sourceIds: [sourceId] }))[0]?.holds ?? []);
const syncWith = (r: ProbeRepo, engine: BrainEngine) => performSync(engine, { repoPath: r.root, sourceId: r.sourceId, noPull: true, noEmbed: true, noExtract: true, concurrency: 1 });

/** The engine whose identity-confirmation reads (the stored-title and live-identity queries) throw `error` when `when` matches their params. */
function failingIdentityReads(engine: BrainEngine, error: () => unknown, when: (params: unknown[]) => boolean): BrainEngine {
  return new Proxy(engine, { get(target, prop) {
    const value = Reflect.get(target, prop);
    if (prop === 'executeRaw' && typeof value === 'function') {
      return (sql: string, params: unknown[] = []) => /\btitle FROM pages\b/.test(sql) && /= ANY\([$][23]::text\[\]\)/.test(sql) && when(params)
        ? Promise.reject(error()) : (value as Function).call(target, sql, params);
    }
    return typeof value === 'function' ? value.bind(target) : value;
  } }) as BrainEngine;
}
const naming = (needle: string) => (params: unknown[]) => JSON.stringify(params).includes(needle);

describe('S-51 identity values the database cannot compare are absent', () => {
  test('a NUL or a lone surrogate in a title, id or slug reads as no value; other values are kept as written', () => {
    expect(frontmatterIdentity('# Meeting notes\u0000\u0000')).toMatchObject({ title: null });
    expect(frontmatterIdentity('---\ntitle: "a\\0b"\nid: "x\\0y"\nslug: "s\\0"\n---\nbody')).toMatchObject({ title: null, id: null, slug: null });
    expect(frontmatterIdentity('---\ntitle: "a\\uD800b"\nid: "\\uDC00"\n---\nbody')).toMatchObject({ title: null, id: null });
    expect(frontmatterIdentity('---\ntitle: "Caf\\u00e9 \\U0001F600"\nid: note-7\n---\nbody')).toMatchObject({ title: 'Café 😀', id: 'note-7' });
  });
});

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`S-51 classic sync: rename identity the database refuses (${backend})`, () => {
    test('S-51 a NUL-padded title committed with a markdown delete syncs; later commits keep syncing', () => withProbeEngine(databaseUrl, (engine, home) => withProbeRepo(engine, 'classic', home, async r => {
      r.write('notes/old.md', md('old')); r.commitAll('old');
      expect((await r.sync()).status).toBe('first_sync');
      unlinkSync(join(r.root, 'notes/old.md'));
      r.write('notes/nul-title.md', '# Meeting notes\u0000\u0000\u0000');
      r.write('ok/healthy-1.md', md('healthy one'));
      r.commitAll('odd');
      await expectUnitNotAborted(() => r.sync());
      expect({ cursor: await r.lastCommit() === r.head(), healthy: await page(engine, r.sourceId, 'ok/healthy-1') !== null, old: await page(engine, r.sourceId, 'notes/old') })
        .toEqual({ cursor: true, healthy: true, old: null });
      r.write('ok/healthy-2.md', md('healthy two')); r.commitAll('healthy two');
      await expectUnitNotAborted(() => r.sync());
      expect({ cursor: await r.lastCommit() === r.head(), healthy: await page(engine, r.sourceId, 'ok/healthy-2') !== null }).toEqual({ cursor: true, healthy: true });
    })), 180_000);

    test('S-51 a NUL title in an edited move takes the unconfirmed-rename path (never a normalized value); a page with the colliding plain title keeps its id, links and timeline', () => withProbeEngine(databaseUrl, (engine, home) => withProbeRepo(engine, 'classic', home, async r => {
      r.write('notes/keep.md', '---\ntitle: Meeting notes\ntype: note\n---\nSee [[seed]].\n');
      r.write('notes/move.md', body('Moved note'));
      r.write('notes/gone.md', md('Gone'));
      r.commitAll('base');
      expect((await r.sync()).status).toBe('first_sync');
      const keep = await page(engine, r.sourceId, 'notes/keep');
      await engine.executeRaw("INSERT INTO timeline_entries(page_id, date, summary) VALUES($1, '2026-01-02', 'kept entry')", [keep]);
      await engine.addLink('notes/keep', 'seed', 'kept link', undefined, undefined, undefined, undefined, { fromSourceId: r.sourceId, toSourceId: r.sourceId });
      const kept = async () => (await engine.executeRaw<{ links: number; timeline: number; deleted: string | null }>(`SELECT
        (SELECT count(*)::int FROM links WHERE from_page_id=p.id) AS links, (SELECT count(*)::int FROM timeline_entries WHERE page_id=p.id) AS timeline,
        p.deleted_at::text AS deleted FROM pages p WHERE p.id=$1`, [keep]))[0];
      const before = await kept();
      unlinkSync(join(r.root, 'notes/move.md'));
      r.write('notes/moved.md', body('Moved note').replace(/^---[\s\S]*?---\n/, '# Moved note\u0000\n'));
      unlinkSync(join(r.root, 'notes/gone.md'));
      r.write('notes/nul.md', '# Meeting notes\u0000\u0000\nAnother note.\n');
      r.write('ok/healthy-1.md', md('healthy one'));
      r.commitAll('odd');
      expect(r.git('diff', '--name-status', '-M', 'HEAD~1', 'HEAD')).toMatch(/^R\d+\tnotes\/move\.md\tnotes\/moved\.md$/m);
      await expectUnitNotAborted(() => r.sync());
      expect({ cursor: await r.lastCommit() === r.head(), healthy: await page(engine, r.sourceId, 'ok/healthy-1') !== null,
        keepId: await page(engine, r.sourceId, 'notes/keep'), kept: await kept(), moveOld: await page(engine, r.sourceId, 'notes/move') })
        .toEqual({ cursor: true, healthy: true, keepId: keep, kept: before, moveOld: null });
      expect(before).toEqual({ links: 1, timeline: 1, deleted: null });
    })), 180_000);

    test('S-51 a value the database still refuses (22021) holds only its pair: the old page stays whole, the other pair renames, and a later edit renames it with its id', () => withProbeEngine(databaseUrl, (engine, home) => withProbeRepo(engine, 'classic', home, async r => {
      r.write('notes/a.md', body('Poison title')); r.write('notes/c.md', body('Fine title'));
      r.commitAll('base');
      expect((await r.sync()).status).toBe('first_sync');
      const a = await page(engine, r.sourceId, 'notes/a'), c = await page(engine, r.sourceId, 'notes/c');
      unlinkSync(join(r.root, 'notes/a.md')); r.write('notes/b.md', body('Poison title', 'An edit.\n'));
      unlinkSync(join(r.root, 'notes/c.md')); r.write('notes/d.md', body('Fine title', 'An edit.\n'));
      r.write('ok/healthy-1.md', md('healthy one'));
      r.commitAll('moves');
      const refused = failingIdentityReads(engine, () => Object.assign(new Error('invalid byte sequence for encoding "UTF8": 0x00'), { code: '22021' }), naming('Poison title'));
      await expectUnitNotAborted(() => syncWith(r, refused));
      const held = (await holdsOf(engine, r.sourceId)).find(h => h.path === 'notes/b.md');
      expect({ cursor: await r.lastCommit() === r.head(), healthy: await page(engine, r.sourceId, 'ok/healthy-1') !== null,
        a: await page(engine, r.sourceId, 'notes/a'), b: await page(engine, r.sourceId, 'notes/b'), d: await page(engine, r.sourceId, 'notes/d'), c: await page(engine, r.sourceId, 'notes/c'),
        hold: held && { code: held.code, origin: held.meta.rename_from?.pageId ?? null }, ledger: loadSyncFailures().filter(f => f.source_id === r.sourceId).length })
        .toEqual({ cursor: true, healthy: true, a, b: null, d: c, c: null, hold: { code: 'rename_identity_unreadable', origin: a }, ledger: 0 });
      const fix = gitHoldItem(held!).fix;
      expect({ actor: fix.actor, argv: fix.argv, then: fix.then?.argv }).toEqual({ actor: 'user', argv: ['gbrain', 'sources', 'status', r.sourceId, '--json'],
        then: ['gbrain', 'sync', '--source', r.sourceId, '--no-pull'] });
      expect(fix.user_message).toContain('notes/b.md');
      // Untouched, the hold waits (no re-decision, nothing imported).
      r.write('ok/healthy-2.md', md('healthy two')); r.commitAll('healthy two');
      await expectUnitNotAborted(() => r.sync());
      expect({ a: await page(engine, r.sourceId, 'notes/a'), b: await page(engine, r.sourceId, 'notes/b'), held: (await holdsOf(engine, r.sourceId)).map(h => h.path) })
        .toEqual({ a, b: null, held: ['notes/b.md'] });
      // The file changes and the database reads it: the pair is decided again and the page moves with its id.
      r.write('notes/b.md', body('Poison title', 'An edit.\nA fix.\n')); r.commitAll('fix b');
      await expectUnitNotAborted(() => r.sync());
      expect({ cursor: await r.lastCommit() === r.head(), a: await page(engine, r.sourceId, 'notes/a'), b: await page(engine, r.sourceId, 'notes/b'), held: (await holdsOf(engine, r.sourceId)).length })
        .toEqual({ cursor: true, a: null, b: a, held: 0 });
    })), 180_000);

    test('S-51 run: a lost connection during identity confirmation stops the run with nothing deleted or added, and the next run renames', () => withProbeEngine(databaseUrl, (engine, home) => withProbeRepo(engine, 'classic', home, async r => {
      r.write('notes/a.md', body('Some title'));
      r.commitAll('base');
      expect((await r.sync()).status).toBe('first_sync');
      const a = await page(engine, r.sourceId, 'notes/a');
      const before = await r.lastCommit();
      unlinkSync(join(r.root, 'notes/a.md')); r.write('notes/b.md', body('Some title', 'An edit.\n'));
      r.commitAll('move');
      const lost = failingIdentityReads(engine, () => Object.assign(new Error('Connection terminated unexpectedly'), { code: '08006' }), () => true);
      await expect(syncWith(r, lost)).rejects.toThrow('Connection terminated unexpectedly');
      expect({ cursor: await r.lastCommit(), a: await page(engine, r.sourceId, 'notes/a'), b: await page(engine, r.sourceId, 'notes/b'), held: (await holdsOf(engine, r.sourceId)).length })
        .toEqual({ cursor: before, a, b: null, held: 0 });
      await expectUnitNotAborted(() => r.sync());
      expect({ cursor: await r.lastCommit() === r.head(), a: await page(engine, r.sourceId, 'notes/a'), b: await page(engine, r.sourceId, 'notes/b') })
        .toEqual({ cursor: true, a: null, b: a });
    })), 180_000);
  });
}
