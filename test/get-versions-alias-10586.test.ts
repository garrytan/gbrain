/**
 * #10586: get_versions on an old slug that only a merge or rename alias names.
 * 1. Protects: the old slug lists the surviving page's history, as get_page opens it, and never more than the surviving
 *    page's own slug shows the same caller: readers (readable_by) and visibility: private apply to the resolved page, and
 *    an exact page holding the slug keeps it even when the alias names another page.
 * 2. Fails when: get_versions matches pages.slug alone (empty history through the alias), or the alias read skips the
 *    caller's readers or privacy (a restricted page's history reaches a caller who cannot read it by its own slug).
 * 3. Real seams: dispatchToolCall under the local --as composition (withCallerAccess) and a remote dispatch; PGLite, and
 *    Postgres with DATABASE_URL; repo-less.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { withCallerAccess, __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { addMember, memberIdentity } from '../src/core/access/members.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const SRC = 'source-a';
const PAGES = {
  open: { slug: 'notes/open-current', old: 'notes/open-old', fm: '', canary: 'canaryverisonopen' },
  alice: { slug: 'notes/alice-current', old: 'notes/alice-old', fm: 'readable_by: [alice-example]\n', canary: 'canaryversionalice' },
  quiet: { slug: 'notes/quiet-current', old: 'notes/quiet-old', fm: 'visibility: private\n', canary: 'canaryversionquiet' },
} as const;
const HELD = 'notes/held-exact';

for (const kind of testBackends()) {
  describe(`get_versions through an alias (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    async function call(slug: string, opts: { member?: string; remote?: boolean; body?: boolean } = {}): Promise<{ ids: number[]; text: string }> {
      const run = () => dispatchToolCall(engine, 'get_versions', { slug, ...(opts.body ? { include_body: true } : {}) },
        { remote: opts.remote === true, sourceId: SRC });
      const result = opts.member
        ? await withCallerAccess({ identity: (await memberIdentity(engine, opts.member)).identity, applyRemoteReadPolicy: true, hidePrivate: true, privateReadableSources: [] }, run)
        : await run();
      const text = result.content.map(c => c.text).join('\n');
      if (result.isError) throw new Error(text);
      return { ids: (JSON.parse(text) as Array<{ id: number }>).map(v => Number(v.id)), text };
    }

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      for (const p of Object.values(PAGES)) {
        const body = (n: number) => `---\ntype: note\ntitle: ${p.slug}\n${p.fm}---\n# Plan\n\nDraft ${n} ${p.canary}.`;
        await importFromContent(engine, p.slug, body(1), { sourceId: SRC, noEmbed: true });
        await engine.createVersion(p.slug, { sourceId: SRC });
        await importFromContent(engine, p.slug, body(2), { sourceId: SRC, noEmbed: true });
        await engine.executeRaw('INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ($1, $2, $3)', [SRC, p.old, p.slug]);
      }
      await importFromContent(engine, HELD, '---\ntype: note\ntitle: Held\n---\n# Held\n\nIts own page.', { sourceId: SRC, noEmbed: true });
      await engine.executeRaw('INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ($1, $2, $3)', [SRC, HELD, PAGES.open.slug]);
      await addMember(engine, 'alice-example');
      await addMember(engine, 'bob-example');
    }, 120_000);

    afterAll(async () => { await close?.(); }, 60_000);

    test('an old slug lists the surviving page history for a trusted local caller', async () => {
      for (const p of Object.values(PAGES)) {
        const direct = await call(p.slug);
        expect(direct.ids.length).toBeGreaterThan(0);
        expect((await call(p.old)).ids).toEqual(direct.ids);
      }
    });

    test('a page that holds the slug keeps its own history', async () => {
      expect((await call(PAGES.open.slug)).ids.length).toBeGreaterThan(0);
      expect((await call(HELD)).ids).toEqual([]);
    });

    test('readers apply to the resolved page: the old slug shows a member what the surviving slug shows', async () => {
      const alice = await call(PAGES.alice.old, { member: 'alice-example' });
      expect(alice.ids.length).toBeGreaterThan(0);
      expect(alice.ids).toEqual((await call(PAGES.alice.slug, { member: 'alice-example' })).ids);
      for (const slug of [PAGES.alice.old, PAGES.alice.slug]) {
        const bob = await call(slug, { member: 'bob-example', body: true });
        expect(bob.ids).toEqual([]);
        expect(bob.text).not.toContain(PAGES.alice.canary);
      }
      expect((await call(PAGES.open.old, { member: 'bob-example' })).ids).toEqual((await call(PAGES.open.slug, { member: 'bob-example' })).ids);
    });

    test('a private surviving page stays hidden through its alias', async () => {
      for (const opts of [{ member: 'alice-example' }, { remote: true }]) {
        for (const slug of [PAGES.quiet.old, PAGES.quiet.slug]) {
          const seen = await call(slug, { ...opts, body: true });
          expect(seen.ids).toEqual([]);
          expect(seen.text).not.toContain(PAGES.quiet.canary);
        }
      }
      const open = await call(PAGES.open.old, { remote: true });
      expect(open.ids.length).toBeGreaterThan(0);
    });
  });
}
