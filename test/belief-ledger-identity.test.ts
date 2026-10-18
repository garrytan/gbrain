/**
 * Belief ledger identity probes (docs/designs/BELIEF_LEDGER.md section 3 and
 * section 11: 4, 19, 29). Renames keep the page lifetime and append one
 * `page.renamed`; replay resolves the slug a lifetime had at a time; a
 * phantom merge transfers assertions instead of renaming, and a crash between
 * its two requests leaves both pages live; a renamed link endpoint changes no
 * key, a reused slug starts a new lifetime and a database-only fact whose page
 * appears later is adopted. Each runs on PGLite and on Postgres when
 * DATABASE_URL is set, and each has a forced probe: a deliberately broken
 * emitter that must make the assertion fail.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { renamePageOntoSlug } from '../src/commands/sync/rename-collision.ts';
import { carryRenameIdentity } from '../src/commands/sync/renames.ts';
import { enableBeliefLedger } from '../src/core/belief/coverage.ts';
import { lifetimeAtSlug, lifetimeSlugAt } from '../src/core/belief/identity.ts';
import { currentStateHash, noteBelief, withBeliefBatch } from '../src/core/belief/ledger.ts';
import { renameLifetime, resolveLifetimes } from '../src/core/belief/lifetimes.ts';
import { maintenanceTransaction } from '../src/core/persistence/attribution.ts';
import { recordDerivationInputs } from '../src/core/facts/derivation-inputs.ts';
import { propagateTierLowering } from '../src/core/trust/propagation.ts';
import { keyedSubjects } from '../src/core/belief/subjects.ts';
import { lifetimeRef, pageKey } from '../src/core/belief/keys.ts';
import { __setBeliefEmitterFaultForTests, type BeliefEventDraft } from '../src/core/belief/append.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';
import { beliefBrain, beliefEngineCase, beliefPage, readEvents, shape, type BeliefBrain, type BeliefEvent } from './helpers/belief-ledger.ts';

afterEach(() => __setBeliefEmitterFaultForTests(null));

const fault = (fn: (drafts: BeliefEventDraft[]) => BeliefEventDraft[]) => __setBeliefEmitterFaultForTests(fn);
const retype = (from: string, to: string) => (drafts: BeliefEventDraft[]) => drafts.map(d => d.eventType === from ? { ...d, eventType: to } : d);
const dropType = (type: string) => (drafts: BeliefEventDraft[]) => drafts.filter(d => d.eventType !== type);
/** The database's clock, so a replay instant orders against recorded_at on both engines. */
const dbNow = async (engine: BrainEngine) => new Date(String((await engine.executeRaw<{ t: string }>(`SELECT clock_timestamp()::text AS t`))[0]!.t));
async function since(b: { engine: BrainEngine; sourceId: string }, fn: () => Promise<unknown>): Promise<BeliefEvent[]> {
  const mark = Number((await b.engine.executeRaw<{ id: number | null }>('SELECT max(id) AS id FROM belief_events WHERE source_id = $1', [b.sourceId]))[0]?.id ?? 0);
  await fn();
  return readEvents(b.engine, b.sourceId, mark);
}
const lifetimeOf = async (b: BeliefBrain, slug: string) => (await b.events()).filter(e => e.slug === slug && e.subject_kind === 'page').at(-1)!.page_lifetime!;

const FENCE = (rows: string[]) => ['## Facts', '<!--- gbrain:facts:begin -->',
  '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
  '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
  ...rows.map((claim, i) => `| ${i + 1} | ${claim} | fact | 1.0 | world | medium | 2017-01-01 |  | chat |  |`), '<!--- gbrain:facts:end -->', ''].join('\n');
const PERSON = (title: string, body = '') => `---\ntitle: ${title}\ntype: person\n---\n# ${title}\n\n${body}`;

interface Managed { engine: BrainEngine; sourceId: string; root: string; put(slug: string, content: string): Promise<void> }

/** A managed brain with a fresh worktree source on `engine`: `seed` runs unmanaged (legacy writes allowed), then managed mode and coverage are enabled. */
async function managedWorktree(engine: BrainEngine, seed: (f: Managed) => Promise<void>, run: (f: Managed) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-belief-identity-'));
  try {
    await withEnv({ GBRAIN_HOME: join(dir, 'home'), GBRAIN_AUDIT_DIR: join(dir, 'audit') }, async () => {
      const root = join(dir, 'brain'); mkdirSync(root);
      const sourceId = `identity-${randomUUID().slice(0, 8)}`;
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
      await engine.setConfig('sync.write_through', 'true');
      await engine.setConfig('facts.extraction_enabled', 'true');
      await claimWorktree(engine, sourceId, root);
      const ctx = { engine, sourceId, remote: false as const, config: { engine: engine.kind, embedding_disabled: true }, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
      const f: Managed = { engine, sourceId, root, put: async (slug, content) => {
        const prior = await engine.readPageSnapshot(slug, { sourceId });
        await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content, request_id: randomUUID(), ...(prior ? { expected_revision: prior.revision } : {}) } });
      } };
      await seed(f);
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      await enableBeliefLedger(engine, sourceId);
      await run(f);
    });
  } finally {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe(`belief ledger identity (${engineCase.name})`, () => {
    let engine: BrainEngine;
    let close: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      if (engineCase.databaseUrl) ({ engine, close } = await isolatedPersistencePostgres(engineCase.databaseUrl));
      else { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite; }
    }, 120_000);
    afterAll(async () => { await disposePersistenceConsumer(engine); if (close) await close(); else await engine.disconnect(); });
    const brain = (run: (b: BeliefBrain) => Promise<void>) => beliefBrain(run, { databaseUrl: engineCase.databaseUrl });

    test('probe 4: a cheap rename and a fallback rename each append one page.renamed on the same lifetime; replay before the rename resolves the old slug', () => brain(async b => {
      await b.put('notes/old-example', beliefPage({ type: 'note', title: 'Old', facts: ['Old example has a roof'] }));
      const lifetime = await lifetimeOf(b, 'notes/old-example');
      const before = await dbNow(b.engine);
      const check = async (events: BeliefEvent[], oldSlug: string, newSlug: string, expectedLifetime: string, extra: Record<string, unknown> = {}) => {
        // The moved rows may also take a new revision and the maintenance writer's tier; no key changes, never a delete or a new page.
        expect(events.every(e => e.subject_kind === 'page' ? ['page.renamed', 'page.published', 'trust.retiered'].includes(e.event_type) : e.event_type === 'trust.retiered')).toBe(true);
        expect(events.every(e => e.page_lifetime === expectedLifetime)).toBe(true);
        const renames = events.filter(e => e.event_type === 'page.renamed');
        expect(renames).toHaveLength(1);
        expect(renames[0]!).toMatchObject({ slug: newSlug, page_lifetime: expectedLifetime, subject_key: pageKey(expectedLifetime), value: { old_slug: oldSlug, new_slug: newSlug, ...extra } });
      };
      const cheap = await since(b, () => renamePageOntoSlug(b.engine, { sourceId: b.sourceId, oldSlug: 'notes/old-example', newSlug: 'notes/new-example', to: 'notes/new-example.md' }));
      await check(cheap, 'notes/old-example', 'notes/new-example', lifetime);
      expect(cheap.find(e => e.event_type === 'page.renamed')!.cause).toMatchObject({ op: 'sync_rename' });
      expect(await lifetimeSlugAt(b.engine, b.sourceId, lifetime, before)).toBe('notes/old-example');
      expect(await lifetimeAtSlug(b.engine, b.sourceId, 'notes/old-example', before)).toBe(lifetime);
      const after = await dbNow(b.engine);
      expect(await lifetimeSlugAt(b.engine, b.sourceId, lifetime, after)).toBe('notes/new-example');
      expect(await lifetimeAtSlug(b.engine, b.sourceId, 'notes/old-example', after)).toBeNull();
      expect(await lifetimeAtSlug(b.engine, b.sourceId, 'notes/new-example', after)).toBe(lifetime);

      // Fallback (#5431): the destination materialized as its own row; the stale row's identity, lifetime included, moves onto it.
      await b.put('notes/stale-example', beliefPage({ type: 'note', title: 'Stale' }));
      await b.put('notes/dest-example', beliefPage({ type: 'note', title: 'Stale' }));
      const stale = await lifetimeOf(b, 'notes/stale-example');
      const absorbed = await lifetimeOf(b, 'notes/dest-example');
      const preFallback = await dbNow(b.engine);
      const fallback = await since(b, () => carryRenameIdentity(b.engine, b.sourceId, 'notes/stale-example', 'notes/dest-example'));
      await check(fallback, 'notes/stale-example', 'notes/dest-example', stale, { absorbed_lifetime: absorbed });
      expect(shape(fallback)).toEqual(['page:page.renamed']);
      expect(fallback[0]!.cause).toMatchObject({ op: 'rename_fallback' });
      expect(await lifetimeSlugAt(b.engine, b.sourceId, stale, preFallback)).toBe('notes/stale-example');
      expect(await lifetimeAtSlug(b.engine, b.sourceId, 'notes/dest-example', await dbNow(b.engine))).toBe(stale);

      // Forced probe: an emitter that records the cheap rename as a publication is caught.
      await b.put('notes/forced-example', beliefPage({ type: 'note', title: 'Forced' }));
      const forcedLifetime = await lifetimeOf(b, 'notes/forced-example');
      fault(retype('page.renamed', 'page.published'));
      const forced = await since(b, () => renamePageOntoSlug(b.engine, { sourceId: b.sourceId, oldSlug: 'notes/forced-example', newSlug: 'notes/forced-moved-example', to: 'notes/forced-moved-example.md' }));
      await expect(check(forced, 'notes/forced-example', 'notes/forced-moved-example', forcedLifetime)).rejects.toThrow();
    }), 120_000);

    test('review #5: a cheap rename of a page with a database-only fact moves no fact key and leaves the fact live', () => brain(async b => {
      await operationsByName.remember!.handler(b.ctx as OperationContext, { fact: 'Zeta example prefers tea', provenance: 'notes', entity: 'people/zeta-example', request_id: randomUUID() });
      await b.put('people/zeta-example', beliefPage({ type: 'person', title: 'Zeta Example' }));
      const factKey = (await b.events()).find(e => e.event_type === 'fact.adopted')!.subject_key;
      const [{ incarnation }] = await b.engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [b.sourceId]);
      const check = async (events: BeliefEvent[], slug: string) => {
        expect(events.filter(e => e.subject_kind === 'fact' && e.event_type !== 'trust.retiered')).toEqual([]);
        const last = (await b.events()).filter(e => e.subject_key === factKey).at(-1)!;
        expect(last.event_type).toMatch(/^fact\.(asserted|adopted|revised|transferred)$|^trust\.retiered$/);
        const now = await b.engine.transaction(tx => currentStateHash(tx, b.sourceId, incarnation!, slug));
        const [newest] = await b.engine.executeRaw<{ state_hash: string }>('SELECT state_hash FROM belief_events WHERE source_id=$1 AND slug=$2 ORDER BY id DESC LIMIT 1', [b.sourceId, slug]);
        expect(newest!.state_hash).toBe(now.hash);
      };
      // The new slug sorts before the old one, so a per-slug diff would append the retraction last.
      renameSync(join(b.root, 'people/zeta-example.md'), join(b.root, 'people/alpha-example.md'));
      const renamed = await since(b, () => renamePageOntoSlug(b.engine, { sourceId: b.sourceId, oldSlug: 'people/zeta-example', newSlug: 'people/alpha-example', to: 'people/alpha-example.md' }));
      expect(renamed.filter(e => e.event_type === 'page.renamed')).toHaveLength(1);
      await check(renamed, 'people/alpha-example');
      // Forced probe: an emitter that records the fact as retracted on the rename is caught.
      fault(drafts => [...drafts, ...drafts.filter(d => d.eventType === 'page.renamed').map(d => ({ ...d, subjectKind: 'fact' as const, subjectKey: factKey, eventType: 'fact.retracted', value: null }))]);
      renameSync(join(b.root, 'people/alpha-example.md'), join(b.root, 'people/aardvark-example.md'));
      const forced = await since(b, () => renamePageOntoSlug(b.engine, { sourceId: b.sourceId, oldSlug: 'people/alpha-example', newSlug: 'people/aardvark-example', to: 'people/aardvark-example.md' }));
      await expect(check(forced, 'people/aardvark-example')).rejects.toThrow();
    }), 120_000);

    test('review #18: after a fallback rename the surviving lifetime describes the destination page, and the ended lifetime keeps no belief', () => brain(async b => {
      const [{ incarnation }] = await b.engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [b.sourceId]);
      const currentKeys = async (slug: string) => {
        const { state, lifetimes } = await b.engine.transaction(tx => currentStateHash(tx, b.sourceId, incarnation!, slug));
        const page = state.pages.find(p => p.slug === slug)!;
        return keyedSubjects({ incarnation: incarnation!, lifetimes, pagesBySlug: new Map([[slug, page]]) }, state, () => 'world')
          .filter(s => s.stream === slug && s.kind !== 'link_transition').map(s => s.key);
      };
      const run = async (stale: string, dest: string) => {
        await b.put(stale, beliefPage({ type: 'note', title: 'Stale', takes: ['Stale take survives'], facts: ['Both pages hold this'] }));
        await b.put(dest, beliefPage({ type: 'note', title: 'Dest', takes: ['Dest take is new'], facts: ['Both pages hold this', 'Only the destination holds this'] }));
        const staleKeys = await currentKeys(stale), destKeys = await currentKeys(dest);
        const absorbed = await lifetimeOf(b, dest);
        const events = await since(b, () => carryRenameIdentity(b.engine, b.sourceId, stale, dest));
        return { staleKeys, destKeys, absorbed, events, after: await currentKeys(dest) };
      };
      const asserting = /\.(asserted|revised|adopted|transferred)$/;
      const check = (r: Awaited<ReturnType<typeof run>>) => {
        expect(r.events.filter(e => e.subject_kind === 'page').map(e => e.event_type)).toEqual(['page.renamed']);
        const last = new Map(r.events.filter(e => e.subject_kind !== 'page' && !e.event_type.startsWith('trust.')).map(e => [e.subject_key, e]));
        // A destination belief the stale lifetime did not hold is recorded on it; a stale belief the destination lacks is retracted.
        for (const key of r.after.filter(k => !r.staleKeys.includes(k))) expect(last.get(key)?.event_type).toMatch(asserting);
        for (const key of r.staleKeys.filter(k => !r.after.includes(k))) expect(last.get(key)?.event_type).toMatch(/\.retracted$/);
        // Every belief of the ended lifetime is named by a transfer onto the surviving one.
        const from = new Set(r.events.filter(e => e.event_type.endsWith('.transferred')).map(e => e.cause.from_key));
        expect(r.destKeys.every(k => from.has(k))).toBe(true);
        expect(r.events.filter(e => e.event_type.endsWith('.transferred')).every(e => e.cause.from_lifetime === r.absorbed)).toBe(true);
        expect(r.events.filter(e => e.event_type === 'take.retracted').map(e => e.value)).toEqual([null]);
      };
      check(await run('notes/stale-example', 'notes/dest-example'));
      // Forced probe: an emitter that records the destination's beliefs as fresh assertions, leaving the ended lifetime's beliefs live, is caught.
      fault(drafts => drafts.map(d => d.eventType.endsWith('.transferred') ? { ...d, eventType: d.eventType.replace('.transferred', '.asserted') } : d));
      const forced = await run('notes/stale-two-example', 'notes/dest-two-example');
      expect(() => check(forced)).toThrow();
    }), 120_000);

    test('review #31: a contested fact outside the batch\'s streams is keyed by its page\'s lifetime and hashed as its own stream', () => brain(async b => {
      await b.put('companies/acme-example', beliefPage({ facts: ['Acme raised a seed round'] }));
      await b.put('notes/other-example', beliefPage({ type: 'note', title: 'Other' }));
      const acme = await lifetimeOf(b, 'companies/acme-example');
      const [fact] = await b.engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id=$1 AND fact=$2', [b.sourceId, 'Acme raised a seed round']);
      const [{ incarnation }] = await b.engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [b.sourceId]);
      const events = await since(b, () => b.engine.transaction(async tx => {
        await tx.lockPageKeys([{ sourceId: b.sourceId, slug: 'notes/other-example' }]);
        await withBeliefBatch(tx, { sourceId: b.sourceId, slugs: ['notes/other-example'], op: 'review_probe' },
          async () => noteBelief({ kind: 'contested', table: 'facts', rowId: Number(fact!.id), proposalId: 1, guard: 'review_probe' }));
      }));
      const hash = (await b.engine.transaction(tx => currentStateHash(tx, b.sourceId, incarnation!, 'companies/acme-example'))).hash;
      expect(events.map(e => [e.event_type, e.slug, e.page_lifetime, (JSON.parse(e.subject_key) as unknown[]).slice(0, 2), e.state_hash]))
        .toEqual([['trust.contested', 'companies/acme-example', acme, ['f', lifetimeRef(acme)], hash]]);
    }), 120_000);

    test('review #40: a lifetime renamed after the caller read the page is resolved by page id, not minted again at the old slug', () => brain(async b => {
      await b.put('notes/p-example', beliefPage({ type: 'note', title: 'P' }));
      const lifetime = await lifetimeOf(b, 'notes/p-example');
      const [{ id, incarnation }] = await b.engine.executeRaw<{ id: number; incarnation: string }>(
        'SELECT p.id, s.incarnation::text AS incarnation FROM pages p JOIN sources s ON s.id=p.source_id WHERE p.source_id=$1 AND p.slug=$2', [b.sourceId, 'notes/p-example']);
      // A concurrent rename commits between this caller's page read (slug notes/p-example) and its lifetime read.
      await b.engine.transaction(async tx => {
        await tx.executeRaw('UPDATE pages SET slug=$1 WHERE id=$2', ['notes/q-example', id]);
        await renameLifetime(tx, lifetime, 'notes/q-example', Number(id));
      });
      const resolved = await b.engine.transaction(tx => resolveLifetimes(tx, [{ sourceId: b.sourceId, incarnation: incarnation!, slug: 'notes/p-example', pageId: Number(id) }]));
      expect(resolved.get(Number(id))).toBe(lifetime);
      const open = await b.engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM belief_page_lifetimes WHERE page_id=$1 AND ended_at IS NULL', [id]);
      expect(Number(open[0]!.n)).toBe(1);
    }), 120_000);

    test('review #32: a dependent lowered inside the batch\'s own stream is recorded once by the batch, with its final state hash and the input as cause', () => brain(async b => {
      const slug = 'notes/lab-example';
      await b.put(slug, beliefPage({ type: 'note', title: 'Lab', facts: ['The lab opened in 2020', 'The lab has ten benches'] }));
      const ids = await b.engine.executeRaw<{ id: number; fact: string }>('SELECT id, fact FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 ORDER BY row_num', [b.sourceId, slug]);
      const [input, dependent] = ids.map(r => Number(r.id));
      await maintenanceTransaction(b.engine, tx => recordDerivationInputs(tx, { table: 'facts', id: dependent!, sourceId: b.sourceId }, [{ table: 'facts', id: input! }]));
      const [{ incarnation }] = await b.engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [b.sourceId]);
      const events = await since(b, () => maintenanceTransaction(b.engine, async tx => {
        await tx.lockPageKeys([{ sourceId: b.sourceId, slug }]);
        await withBeliefBatch(tx, { sourceId: b.sourceId, slugs: [slug], op: 'review_probe' }, async () => {
          await tx.executeRaw(`UPDATE facts SET trust_tier='external_untrusted' WHERE id=$1`, [input]);
          await propagateTierLowering(tx, [{ table: 'facts', id: input! }]);
          // A later write in the same stream, after the propagation.
          await tx.executeRaw('UPDATE facts SET confidence=0.5 WHERE id=$1', [dependent]);
        });
      }));
      const final = (await b.engine.transaction(tx => currentStateHash(tx, b.sourceId, incarnation!, slug))).hash;
      const retiered = events.filter(e => e.event_type === 'trust.retiered' && e.subject_kind === 'fact');
      expect(retiered).toHaveLength(2);
      expect(new Set(retiered.map(e => e.state_hash))).toEqual(new Set([final]));
      const inputKey = retiered.find(e => !e.cause.inputs)!.subject_key;
      expect(retiered.find(e => e.cause.inputs)!.cause).toMatchObject({ op: 'review_probe', inputs: [{ subject_key: inputKey }] });
    }), 120_000);

    test('review #34: two pages that swap slugs in one transaction each keep their own lifetime, both open', () => brain(async b => {
      await b.put('notes/a-example', beliefPage({ type: 'note', title: 'A' }));
      await b.put('notes/b-example', beliefPage({ type: 'note', title: 'B' }));
      const a = await lifetimeOf(b, 'notes/a-example'), bb = await lifetimeOf(b, 'notes/b-example');
      const events = await since(b, () => maintenanceTransaction(b.engine, async tx => {
        await tx.lockPageKeys(['notes/a-example', 'notes/b-example'].map(slug => ({ sourceId: b.sourceId, slug })));
        await withBeliefBatch(tx, { sourceId: b.sourceId, slugs: ['notes/a-example', 'notes/b-example'], op: 'review_probe' }, async () => {
          for (const slug of ['notes/a-example', 'notes/b-example']) await tx.createVersion(slug, { sourceId: b.sourceId, preimage: (await tx.readPageSnapshot(slug, { sourceId: b.sourceId }))! });
          await tx.executeRaw('UPDATE pages SET slug=$1 WHERE source_id=$2 AND slug=$3', ['notes/swap-example', b.sourceId, 'notes/a-example']);
          await tx.executeRaw('UPDATE pages SET slug=$1 WHERE source_id=$2 AND slug=$3', ['notes/a-example', b.sourceId, 'notes/b-example']);
          await tx.executeRaw('UPDATE pages SET slug=$1 WHERE source_id=$2 AND slug=$3', ['notes/b-example', b.sourceId, 'notes/swap-example']);
        });
      }));
      expect(events.filter(e => e.event_type === 'page.renamed').map(e => [e.page_lifetime, e.value]).sort()).toEqual([
        [a, { old_slug: 'notes/a-example', new_slug: 'notes/b-example' }], [bb, { old_slug: 'notes/b-example', new_slug: 'notes/a-example' }]].sort());
      const open = await b.engine.executeRaw<{ page_lifetime: string; slug: string }>(
        'SELECT page_lifetime::text AS page_lifetime, slug FROM belief_page_lifetimes WHERE page_lifetime = ANY($1::uuid[]) AND ended_at IS NULL ORDER BY slug', [[a, bb]]);
      expect(open.map(r => [r.slug, r.page_lifetime])).toEqual([['notes/a-example', bb], ['notes/b-example', a]]);
    }), 120_000);

    test('probe 29: a renamed link endpoint changes no key, a reused slug starts a new lifetime, and a database-only fact is adopted by its later page', () => brain(async b => {
      await b.put('people/bob-example', beliefPage({ type: 'person', title: 'Bob Example' }));
      await b.put('notes/meeting-example', beliefPage({ type: 'note', title: 'Meeting', links: ['people/bob-example'] }));
      const bob = await lifetimeOf(b, 'people/bob-example');
      const [{ incarnation }] = await b.engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [b.sourceId]);
      /** The meeting stream's state hash, over its subject keys: the link to Bob is keyed by Bob's lifetime. */
      const meeting = () => b.engine.transaction(tx => currentStateHash(tx, b.sourceId, incarnation!, 'notes/meeting-example'));
      const beforeRename = await meeting();
      expect(beforeRename.state.links.map(l => beforeRename.lifetimes.get(l.to.id))).toEqual([bob]);
      // Sync saw the file move; the cheap rename moves the row.
      renameSync(join(b.root, 'people/bob-example.md'), join(b.root, 'people/robert-example.md'));
      const renamed = await since(b, () => renamePageOntoSlug(b.engine, { sourceId: b.sourceId, oldSlug: 'people/bob-example', newSlug: 'people/robert-example', to: 'people/robert-example.md' }));
      expect(renamed.filter(e => e.event_type === 'page.renamed').map(e => [e.page_lifetime, e.value])).toEqual([[bob, { old_slug: 'people/bob-example', new_slug: 'people/robert-example' }]]);
      expect(renamed.filter(e => e.slug === 'notes/meeting-example' || e.subject_kind !== 'page')).toEqual([]);
      const afterRename = await meeting();
      expect(afterRename.state.links.map(l => l.to.slug)).toEqual(['people/robert-example']);
      expect(afterRename.hash).toBe(beforeRename.hash);
      // The old slug is reused by a new page: a new lifetime, and the renamed page's history stays its own.
      const reused = await since(b, () => b.put('people/bob-example', beliefPage({ type: 'person', title: 'Another Bob' })));
      const published = reused.find(e => e.event_type === 'page.published')!;
      expect(published.page_lifetime).not.toBe(bob);
      expect(reused.every(e => e.page_lifetime !== bob)).toBe(true);
      const now = await dbNow(b.engine);
      expect(await lifetimeAtSlug(b.engine, b.sourceId, 'people/bob-example', now)).toBe(published.page_lifetime);
      expect(await lifetimeSlugAt(b.engine, b.sourceId, bob, now)).toBe('people/robert-example');

      // A database-only fact about a page that does not exist yet, then the page.
      await operationsByName.remember!.handler(b.ctx as OperationContext, { fact: 'Dana example runs the lab', provenance: 'notes', entity: 'people/dana-example', request_id: randomUUID() });
      const dbOnlyEvent = async (slug: string) => (await b.events()).find(e => e.subject_kind === 'fact' && e.slug === slug)!;
      const dbOnly = await dbOnlyEvent('people/dana-example');
      expect(dbOnly.page_lifetime).toBeNull();
      const check = (events: BeliefEvent[], slug: string, prior: BeliefEvent) => {
        const page = events.find(e => e.event_type === 'page.published' && e.slug === slug)!;
        const adopted = events.filter(e => e.event_type === 'fact.adopted');
        expect(adopted).toHaveLength(1);
        expect(adopted[0]!).toMatchObject({ slug, page_lifetime: page.page_lifetime, cause: { from_key: prior.subject_key } });
        expect((JSON.parse(adopted[0]!.subject_key) as unknown[]).slice(0, 2)).toEqual(['f', lifetimeRef(page.page_lifetime!)]);
        expect(events.filter(e => e.subject_kind === 'fact' && e.event_type !== 'fact.adopted')).toEqual([]);
      };
      check(await since(b, () => b.put('people/dana-example', beliefPage({ type: 'person', title: 'Dana Example' }))), 'people/dana-example', dbOnly);
      // Forced probe: an emitter that records the adoption as a retraction plus a new assertion is caught.
      await operationsByName.remember!.handler(b.ctx as OperationContext, { fact: 'Erin example runs the shop', provenance: 'notes', entity: 'people/erin-example', request_id: randomUUID() });
      const erin = await dbOnlyEvent('people/erin-example');
      fault(retype('fact.adopted', 'fact.asserted'));
      const forced = await since(b, () => b.put('people/erin-example', beliefPage({ type: 'person', title: 'Erin Example' })));
      expect(() => check(forced, 'people/erin-example', erin)).toThrow();
    }), 120_000);

    /** Seeds a canonical page and a legacy stub phantom holding one claim the canonical page also holds and one it does not. */
    const phantomSeed = async ({ engine, sourceId, root, put }: Managed) => {
      await put('people/alice-example', PERSON('Alice Example', FENCE(['Founded Acme'])));
      await engine.putPage('alice', { type: 'person', title: 'alice', compiled_truth: `# alice\n\n${FENCE(['Founded Acme', 'Lives in Paris'])}`.trim(), timeline: '', frontmatter: {} }, { sourceId });
      const phantom = (await engine.readPageSnapshot('alice', { sourceId }))!;
      writeFileSync(join(root, 'alice.md'), serializePageToMarkdown(phantom.page, phantom.tags));
      await runExtractFacts(engine, { sourceId, slugs: ['alice'] });
    };
    const lifetimes = async (engine: BrainEngine, sourceId: string) => {
      const all = await readEvents(engine, sourceId);
      const [fp] = await engine.executeRaw<{ fp: string }>(`SELECT gbrain_fact_fingerprint('Founded Acme') AS fp`);
      return { overlapFp: fp!.fp, phantom: all.find(e => e.slug === 'alice' && e.subject_kind === 'page')!.page_lifetime!,
        canonical: all.find(e => e.slug === 'people/alice-example' && e.subject_kind === 'page')!.page_lifetime! };
    };
    /** The merge request's events: the canonical page's publication. */
    const mergeEvents = (events: BeliefEvent[]) => {
      const page = events.find(e => e.event_type === 'page.published' && e.slug === 'people/alice-example');
      return page ? events.filter(e => e.publication_id === page.publication_id) : [];
    };
    const checkMerge = (events: BeliefEvent[], l: { overlapFp: string; phantom: string; canonical: string }) => {
      expect(events.filter(e => e.subject_kind === 'page' && e.event_type !== 'trust.retiered').map(e => [e.event_type, e.slug])).toEqual([['page.published', 'people/alice-example']]);
      const transferred = events.filter(e => e.event_type === 'fact.transferred');
      expect(transferred.map(e => e.value!.fact)).toContain('Lives in Paris');
      for (const e of transferred) {
        expect(e).toMatchObject({ slug: 'people/alice-example', page_lifetime: l.canonical, cause: { from_lifetime: l.phantom } });
        expect((JSON.parse(e.cause.from_key as string) as unknown[]).slice(0, 2)).toEqual(['f', lifetimeRef(l.phantom)]);
        expect((JSON.parse(e.subject_key) as unknown[]).slice(0, 2)).toEqual(['f', lifetimeRef(l.canonical)]);
      }
      expect(events.filter(e => e.event_type === 'fact.asserted')).toEqual([]);
      // The claim both pages held is not moved (the canonical row keeps it): the phantom's copy ends on the phantom's own lifetime.
      expect(events.filter(e => e.slug === 'alice').map(e => [e.event_type, e.page_lifetime, e.claim_fp])).toEqual([['fact.retracted', l.phantom, l.overlapFp]]);
    };

    test('probe 19: a phantom merge transfers each moved assertion from the phantom\'s lifetime; a crash before the delete leaves both pages live', () => managedWorktree(engine, phantomSeed, async ({ sourceId, root }) => {
      const b = { engine, sourceId };
      const l = await lifetimes(engine, sourceId);
      // The crash: the process dies after the merge commits, before the delete request is submitted.
      const read = engine.readPageSnapshot;
      let reads = 0;
      engine.readPageSnapshot = (async function (this: BrainEngine, slug: string, opts?: Parameters<BrainEngine['readPageSnapshot']>[1]) {
        if (this === engine && slug === 'alice' && new Error().stack?.includes('redirectManagedPhantom') && ++reads === 2) throw new Error('crash between the merge and the delete');
        return read.call(this, slug, opts);
      }) as BrainEngine['readPageSnapshot'];
      let merge: BeliefEvent[];
      try { merge = await since(b, () => runExtractFacts(engine, { sourceId, brainDir: root }).catch(() => undefined)); }
      finally { delete (engine as { readPageSnapshot?: unknown }).readPageSnapshot; }
      expect(reads).toBe(2);
      checkMerge(mergeEvents(merge), l);
      expect(merge.filter(e => e.event_type === 'page.deleted')).toEqual([]);
      expect((await engine.readPageSnapshot('alice', { sourceId }))?.page.deleted_at ?? null).toBeNull();
      const open = await engine.executeRaw<{ slug: string }>('SELECT slug FROM belief_page_lifetimes WHERE source_id=$1 AND ended_at IS NULL AND page_lifetime = ANY($2::uuid[]) ORDER BY slug', [sourceId, [l.phantom, l.canonical]]);
      expect(open.map(r => r.slug)).toEqual(['alice', 'people/alice-example']);
      // The rerun replays the merge (keyed by its intent) and completes the delete: the phantom's own page.deleted, nothing transferred twice.
      const finish = await since(b, () => runExtractFacts(engine, { sourceId, brainDir: root }));
      expect(finish.filter(e => e.subject_kind === 'page').map(e => [e.event_type, e.slug, e.page_lifetime])).toEqual([['page.deleted', 'alice', l.phantom]]);
      expect(finish.filter(e => e.event_type === 'fact.transferred')).toEqual([]);
    }), 180_000);

    test('probe 19 forced: an emitter that records a phantom transfer as a fresh assertion is caught', () => managedWorktree(engine, phantomSeed, async ({ sourceId, root }) => {
      const l = await lifetimes(engine, sourceId);
      fault(retype('fact.transferred', 'fact.asserted'));
      const events = await since({ engine, sourceId }, () => runExtractFacts(engine, { sourceId, brainDir: root }));
      expect(() => checkMerge(mergeEvents(events), l)).toThrow();
    }), 180_000);
  });
}
