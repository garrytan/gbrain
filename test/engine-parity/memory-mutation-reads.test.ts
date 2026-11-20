/**
 * BrainEngine parity — the reads `remember` and `forget` (src/core/persistence/memory-mutations.ts) made through
 * `executeRaw` before admission (src/core/engine-sql/memory-mutation-reads.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: readSourceWriteRow answers a source's incarnation, archived flag, checkout and the `kind` and `role`
 *    config keys as `->>` text (null when missing or JSON null), or null for an unknown id; readSourceLocalPath answers
 *    the checkout or null; readFactEntitySlug answers the entity of a fact only in its own source; hasLiveFileBackedPage
 *    says whether a live page among the slugs has a source file; factReadableUnder admits a fact with any visibility
 *    or only a world one, hides one on a deleted or quarantined page or below the trust floor, and with excludePrivate
 *    one whose provenance page is private; readRemoteForgetTier answers the stored tier of a world fact of the source,
 *    and under the remote floor (restricted brain, unrestricted brain, owner) none whose provenance page is private or
 *    names readers; readForgetTarget answers the fact a forget names (entity, provenance page, row, expiry, tier) of
 *    any visibility, only a world one with worldOnly, under the remote floor none on a private or readers page, and
 *    for a member's own page only a private fact on it while the live page names the member; lock changes nothing.
 *  - Regression: `gbrain remember` and `gbrain forget` read these before every write; an engine that drops a clause
 *    admits a write to an archived source, strikes the wrong file, or lets a member withdraw a fact it cannot read;
 *    a remote forget that misreads the tier forgets a fact the owner confirmed, or files a proposal for a hidden one;
 *    a forget that misreads its target withdraws a fact the caller cannot see, or answers not_found for one it can.
 *  - Why existing coverage misses it: the reads were raw SQL inside memory-mutations.ts and forget-prepare.ts, so no
 *    engine arm ran them.
 *  - Seam: none. Sources come from the harness fixture, rows from typed members. Ids differ between arms, so facts are
 *    named by their text and a source's incarnation is compared only as a stable non-empty string.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { archiveSource, createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withCallerAccess } from '../../src/core/search/private-visibility.ts';

const { parityTest } = parityArms(testBackends());

const note = (title: string, frontmatter: Record<string, unknown> = {}, source_path?: string) =>
  ({ type: 'note' as const, title, compiled_truth: 'x', timeline: '', frontmatter, ...(source_path ? { source_path } : {}) });

/** Run `fn` in a transaction whose write trust settings declare `tier`. */
function declared<T>(engine: BrainEngine, tier: string, fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
  return engine.transaction(async (tx) => {
    await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_trust_promotion', 'gbrain.write_origin'], [tier, tier, JSON.stringify({ channel: tier })]);
    return fn(tx);
  });
}

describe('engine parity: memory mutation reads', () => {
  parityTest('readSourceWriteRow and readSourceLocalPath read the source row a memory write admits against',
    { methods: ['readSourceWriteRow', 'readSourceLocalPath'] }, async (engine, backend) => {
      await createSource(engine, backend, 'kinded', { kind: 'memory', role: 'scope', other: 1 }, '/var/brain/kinded');
      await createSource(engine, backend, 'odd', { kind: 3, role: null });
      await createSource(engine, backend, 'shelved', {}, '/var/brain/shelved');
      await archiveSource(engine, backend, 'shelved');
      const row = async (id: string) => {
        const r = await engine.readSourceWriteRow(id);
        if (!r) return r;
        expect(typeof r.incarnation).toBe('string');
        expect(r.incarnation.length).toBeGreaterThan(0);
        expect((await engine.readSourceWriteRow(id))!.incarnation).toBe(r.incarnation);
        return { ...r, incarnation: 'stable' };
      };
      const out = {
        kinded: await row('kinded'), odd: await row('odd'), shelved: await row('shelved'), default: await row('default'),
        unknown: await row('no-such-source'),
        paths: await Promise.all(['kinded', 'odd', 'shelved', 'no-such-source'].map(id => engine.readSourceLocalPath(id))),
      };
      expect(out.kinded).toEqual({ incarnation: 'stable', archived: false, local_path: '/var/brain/kinded', kind: 'memory', role: 'scope' });
      expect(out.odd).toEqual({ incarnation: 'stable', archived: false, local_path: null, kind: '3', role: null });
      expect(out.shelved!.archived).toBe(true);
      expect(out.unknown).toBeNull();
      expect(out.paths).toEqual(['/var/brain/kinded', null, '/var/brain/shelved', null]);
      return out;
    });

  parityTest('readFactEntitySlug reads the entity of a fact in its own source only',
    { methods: ['insertFact', 'readFactEntitySlug'] }, async (engine, backend) => {
      await createSource(engine, backend, 'other');
      const day = (d: number) => new Date(Date.UTC(2026, 4, d));
      const keyed = await engine.insertFact({ fact: 'Pat likes tea', entity_slug: 'people/pat-example', source: 'mcp:remember', valid_from: day(1) }, { source_id: 'default' });
      const loose = await engine.insertFact({ fact: 'It rained', entity_slug: null, source: 'mcp:remember', valid_from: day(2) }, { source_id: 'default' });
      const out = {
        keyed: await engine.readFactEntitySlug(keyed.id, 'default'),
        loose: await engine.readFactEntitySlug(loose.id, 'default'),
        wrongSource: await engine.readFactEntitySlug(keyed.id, 'other'),
        unknown: await engine.readFactEntitySlug(keyed.id + loose.id + 1000, 'default'),
      };
      expect(out).toEqual({ keyed: 'people/pat-example', loose: null, wrongSource: null, unknown: null });
      return out;
    });

  parityTest('hasLiveFileBackedPage finds a live page with a source file among the slugs',
    { methods: ['putPage', 'softDeletePage', 'hasLiveFileBackedPage'] }, async (engine, backend) => {
      await createSource(engine, backend, 'other');
      await engine.putPage('notes/filed', note('Filed', {}, 'notes/filed.md'));
      await engine.putPage('notes/unfiled', note('Unfiled'));
      await engine.putPage('notes/gone', note('Gone', {}, 'notes/gone.md'));
      await engine.softDeletePage('notes/gone');
      await engine.putPage('notes/elsewhere', note('Elsewhere', {}, 'notes/elsewhere.md'), { sourceId: 'other' });
      const has = (slugs: string[], source = 'default') => engine.hasLiveFileBackedPage(source, slugs);
      const out = {
        filed: await has(['notes/unfiled', 'notes/filed']),
        unfiled: await has(['notes/unfiled']),
        deleted: await has(['notes/gone']),
        otherSource: await has(['notes/elsewhere']),
        inOther: await has(['notes/elsewhere'], 'other'),
        none: await has([]),
      };
      expect(out).toEqual({ filed: true, unfiled: false, deleted: false, otherSource: false, inOther: true, none: false });
      return out;
    });

  parityTest('factReadableUnder admits a fact under the visibility rule, read eligibility and private-provenance policy',
    { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'softDeletePage', 'insertFacts', 'factReadableUnder'] }, async (engine, backend) => {
      await createSource(engine, backend, 'other');
      await engine.putPage('notes/open', note('Open'));
      await engine.putPage('notes/private', note('Private', { visibility: 'private' }));
      await engine.putPage('notes/quarantined', note('Quarantined', { quarantine: { reason: 'junk_pattern' } }));
      await engine.putPage('notes/deleted', note('Deleted'));
      const rows: Array<{ fact: string; page: string; visibility: 'world' | 'private'; tier: string }> = [
        { fact: 'open world', page: 'notes/open', visibility: 'world', tier: 'operator_curated' },
        { fact: 'open private', page: 'notes/open', visibility: 'private', tier: 'operator_curated' },
        { fact: 'on private page', page: 'notes/private', visibility: 'world', tier: 'operator_curated' },
        { fact: 'on quarantined page', page: 'notes/quarantined', visibility: 'world', tier: 'operator_curated' },
        { fact: 'on deleted page', page: 'notes/deleted', visibility: 'world', tier: 'operator_curated' },
        { fact: 'agent written', page: 'notes/open', visibility: 'world', tier: 'agent_written' },
      ];
      const ids = new Map<string, number>();
      for (const [i, r] of rows.entries()) {
        const out = await declared(engine, r.tier, tx => tx.insertFacts([{
          fact: r.fact, entity_slug: 'people/e-example', source_markdown_slug: r.page, row_num: i + 1, kind: 'fact',
          visibility: r.visibility, source: 'fence', valid_from: new Date(Date.UTC(2026, 6, 1 + i)),
        }] as never, { source_id: 'default' }));
        ids.set(r.fact, out.ids[0]!);
      }
      await engine.softDeletePage('notes/deleted');
      const read = async (opts: { anyVisibility: boolean; floor?: 'tool_observed'; excludePrivate?: boolean; sourceId?: string }) => {
        const admitted: string[] = [];
        for (const r of rows) {
          if (await engine.factReadableUnder({
            id: ids.get(r.fact)!, sourceId: opts.sourceId ?? 'default', anyVisibility: opts.anyVisibility,
            eligibility: opts.floor ? { floor: opts.floor } : undefined, excludePrivate: opts.excludePrivate === true,
          })) admitted.push(r.fact);
        }
        return admitted;
      };
      const out = {
        owner: await read({ anyVisibility: true }),
        world: await read({ anyVisibility: false }),
        floor: await read({ anyVisibility: true, floor: 'tool_observed' }),
        excludePrivate: await read({ anyVisibility: true, excludePrivate: true }),
        worldExcludePrivate: await read({ anyVisibility: false, excludePrivate: true }),
        wrongSource: await read({ anyVisibility: true, sourceId: 'other' }),
      };
      expect(out.owner).toEqual(['open world', 'open private', 'on private page', 'agent written']);
      expect(out.world).toEqual(['open world', 'on private page', 'agent written']);
      expect(out.floor).toEqual(['open world', 'open private', 'on private page']);
      expect(out.excludePrivate).not.toContain('on private page');
      expect(out.excludePrivate).toContain('open world');
      expect(out.wrongSource).toEqual([]);
      return out;
    });

  parityTest('readRemoteForgetTier reads the tier of a world fact a remote forget targets, under the remote floor',
    { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'insertFacts', 'readRemoteForgetTier'] }, async (engine, backend) => {
      await createSource(engine, backend, 'other');
      await engine.putPage('notes/open', note('Open'));
      await engine.putPage('notes/private', note('Private', { visibility: 'private' }));
      await engine.putPage('notes/aliased', note('Aliased', { access: 'restricted' }));
      await engine.putPage('notes/readers', note('Readers', { readable_by: ['member:alice-example'] }));
      await engine.putPage('atoms/from-readers', { ...note('From readers', { source_slug: 'notes/readers' }), type: 'atom' as never });
      const rows: Array<{ fact: string; page: string | null; visibility: 'world' | 'private'; tier: string }> = [
        { fact: 'curated world', page: 'notes/open', visibility: 'world', tier: 'operator_curated' },
        { fact: 'agent world', page: 'notes/open', visibility: 'world', tier: 'agent_written' },
        { fact: 'private fact', page: 'notes/open', visibility: 'private', tier: 'operator_curated' },
        { fact: 'on private page', page: 'notes/private', visibility: 'world', tier: 'operator_curated' },
        { fact: 'on aliased page', page: 'notes/aliased', visibility: 'world', tier: 'operator_curated' },
        { fact: 'no page', page: null, visibility: 'world', tier: 'operator_curated' },
        { fact: 'missing page', page: 'notes/never-written', visibility: 'world', tier: 'tool_observed' },
        { fact: 'on readers page', page: 'notes/readers', visibility: 'world', tier: 'operator_curated' },
        { fact: 'on atom of readers page', page: 'atoms/from-readers', visibility: 'world', tier: 'operator_curated' },
      ];
      const ids = new Map<string, number>();
      for (const [i, r] of rows.entries()) {
        const out = await declared(engine, r.tier, tx => tx.insertFacts([{
          fact: r.fact, entity_slug: 'people/e-example', source_markdown_slug: r.page, row_num: i + 1, kind: 'fact',
          visibility: r.visibility, source: 'fence', valid_from: new Date(Date.UTC(2026, 7, 1 + i)),
        }] as never, { source_id: 'default' }));
        ids.set(r.fact, out.ids[0]!);
      }
      const tiers = async (remoteFloor: boolean, sourceId = 'default') => {
        const out: Record<string, string | null> = {};
        for (const r of rows) out[r.fact] = await engine.readRemoteForgetTier({ factId: ids.get(r.fact)!, sourceId, remoteFloor });
        return out;
      };
      const unknown = Math.max(...ids.values()) + 1000;
      const out = {
        plain: await tiers(false),
        floor: await tiers(true),
        unrestrictedFloor: await withCallerAccess({ restricted: false }, () => tiers(true)),
        ownerFloor: await withCallerAccess({ owner: true }, () => tiers(true)),
        wrongSource: await tiers(true, 'other'),
        unknown: [await engine.readRemoteForgetTier({ factId: unknown, sourceId: 'default', remoteFloor: false }),
          await engine.readRemoteForgetTier({ factId: unknown, sourceId: 'default', remoteFloor: true })],
      };
      expect(out.plain).toEqual({
        'curated world': 'operator_curated', 'agent world': 'agent_written', 'private fact': null,
        'on private page': 'operator_curated', 'on aliased page': 'operator_curated', 'no page': 'operator_curated',
        'missing page': 'tool_observed', 'on readers page': 'operator_curated', 'on atom of readers page': 'operator_curated',
      });
      expect(out.floor['on private page']).toBeNull();
      expect(out.floor['curated world']).toBe('operator_curated');
      expect(out.floor['no page']).toBe('operator_curated');
      expect(out.floor['missing page']).toBe('tool_observed');
      expect(out.floor['on readers page']).toBeNull();
      expect(out.unrestrictedFloor['on readers page']).toBeNull();
      expect(out.floor['on atom of readers page']).toBeNull();
      // On this fixture the unrestricted and owner renderings hide the same rows; what they pin is that each arm serves them.
      expect(out.unrestrictedFloor).toEqual(out.floor);
      expect(out.ownerFloor).toEqual(out.floor);
      expect(Object.values(out.wrongSource).every(v => v === null)).toBe(true);
      expect(out.unknown).toEqual([null, null]);
      return out;
    });

  parityTest('readForgetTarget reads the fact a forget names, under the caller visibility, the remote floor or a member page',
    { methods: ['transaction', 'applyTransactionSettings', 'putPage', 'insertFacts', 'expireFact', 'readForgetTarget'] }, async (engine, backend) => {
      await createSource(engine, backend, 'other');
      await engine.putPage('notes/open', note('Open'));
      await engine.putPage('notes/private', note('Private', { visibility: 'private' }));
      await engine.putPage('notes/readers', note('Readers', { readable_by: ['member:alice-example'] }));
      await engine.putPage('memory/members/alice-example', note('Alice', { readable_by: ['member:alice-example'] }));
      await engine.putPage('memory/members/carol-example', note('Carol', { readable_by: ['member:dave-example'] }));
      const rows: Array<{ fact: string; page: string | null; visibility: 'world' | 'private'; tier: string; entity: string | null }> = [
        { fact: 'open world', page: 'notes/open', visibility: 'world', tier: 'operator_curated', entity: 'people/e-example' },
        { fact: 'open private', page: 'notes/open', visibility: 'private', tier: 'agent_written', entity: 'people/e-example' },
        { fact: 'on private page', page: 'notes/private', visibility: 'world', tier: 'operator_curated', entity: null },
        { fact: 'on readers page', page: 'notes/readers', visibility: 'world', tier: 'tool_observed', entity: 'people/e-example' },
        { fact: 'no page', page: null, visibility: 'world', tier: 'agent_written', entity: null },
        { fact: 'alice private', page: 'memory/members/alice-example', visibility: 'private', tier: 'agent_written', entity: 'people/alice-example' },
        { fact: 'alice world', page: 'memory/members/alice-example', visibility: 'world', tier: 'agent_written', entity: 'people/alice-example' },
        { fact: 'carol private', page: 'memory/members/carol-example', visibility: 'private', tier: 'agent_written', entity: null },
        { fact: 'ghost private', page: 'memory/members/ghost-example', visibility: 'private', tier: 'agent_written', entity: null },
        { fact: 'expired world', page: 'notes/open', visibility: 'world', tier: 'operator_curated', entity: 'people/e-example' },
      ];
      const ids = new Map<string, number>();
      for (const [i, r] of rows.entries()) {
        const out = await declared(engine, r.tier, tx => tx.insertFacts([{
          fact: r.fact, entity_slug: r.entity, source_markdown_slug: r.page, row_num: i + 1, kind: 'fact',
          visibility: r.visibility, source: 'fence', valid_from: new Date(Date.UTC(2026, 7, 1 + i)),
        }] as never, { source_id: 'default' }));
        ids.set(r.fact, Number(out.ids[0]!));
      }
      expect(await engine.expireFact(ids.get('expired world')!, { at: new Date(Date.UTC(2026, 8, 1)) })).toBe(true);
      type Spec = { worldOnly?: boolean; remoteFloor?: boolean; lock?: boolean; ownPage?: string | null; sourceId?: string };
      const read = async (spec: Spec = {}, e: BrainEngine = engine) => {
        const out: Record<string, unknown> = {};
        for (const r of rows) {
          const row = await e.readForgetTarget({ id: ids.get(r.fact)!, sourceId: spec.sourceId ?? 'default', worldOnly: spec.worldOnly ?? false,
            remoteFloor: spec.remoteFloor ?? false, lock: spec.lock ?? false, ownPage: spec.ownPage ?? null });
          out[r.fact] = row && {
            sameId: Number(row.id) === ids.get(r.fact), entity_slug: row.entity_slug, source_markdown_slug: row.source_markdown_slug,
            row_num: row.row_num, expired_at: row.expired_at instanceof Date ? row.expired_at.toISOString() : row.expired_at, trust_tier: row.trust_tier,
          };
        }
        return out;
      };
      const seen = (out: Record<string, unknown>) => Object.keys(out).filter(k => out[k] !== null);
      const unknown = Math.max(...ids.values()) + 1000;
      const out = {
        plain: await read(),
        locked: await engine.transaction(tx => read({ lock: true }, tx)),
        worldOnly: seen(await read({ worldOnly: true })),
        floor: seen(await read({ worldOnly: true, remoteFloor: true })),
        unrestrictedFloor: seen(await withCallerAccess({ restricted: false }, () => read({ worldOnly: true, remoteFloor: true }))),
        alice: seen(await read({ worldOnly: true, ownPage: 'memory/members/alice-example' })),
        carol: seen(await read({ worldOnly: true, ownPage: 'memory/members/carol-example' })),
        ghost: seen(await read({ worldOnly: true, ownPage: 'memory/members/ghost-example' })),
        wrongSource: seen(await read({ sourceId: 'other' })),
        unknown: await engine.readForgetTarget({ id: unknown, sourceId: 'default', worldOnly: false, remoteFloor: false, lock: false, ownPage: null }),
      };
      expect(out.plain['open private']).toEqual({ sameId: true, entity_slug: 'people/e-example', source_markdown_slug: 'notes/open', row_num: 2, expired_at: null, trust_tier: 'agent_written' });
      expect(out.plain['no page']).toEqual({ sameId: true, entity_slug: null, source_markdown_slug: null, row_num: 5, expired_at: null, trust_tier: 'agent_written' });
      expect(out.plain['expired world']).toEqual({ sameId: true, entity_slug: 'people/e-example', source_markdown_slug: 'notes/open', row_num: 10, expired_at: '2026-09-01T00:00:00.000Z', trust_tier: 'operator_curated' });
      expect(seen(out.plain)).toEqual(rows.map(r => r.fact));
      expect(out.locked).toEqual(out.plain);
      expect(out.worldOnly).toEqual(['open world', 'on private page', 'on readers page', 'no page', 'alice world', 'expired world']);
      expect(out.floor).toEqual(['open world', 'no page', 'expired world']);
      expect(out.unrestrictedFloor).toEqual(out.floor);
      expect(out.alice).toEqual(['alice private']);
      expect(out.carol).toEqual([]);
      expect(out.ghost).toEqual([]);
      expect(out.wrongSource).toEqual([]);
      expect(out.unknown).toBeNull();
      return out;
    });
});
