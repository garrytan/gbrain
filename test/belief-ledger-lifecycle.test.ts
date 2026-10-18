/**
 * Belief ledger lifecycle probes (docs/designs/BELIEF_LEDGER.md section 11:
 * 1, 2, 3, 5, 7, 18, 21, 39; probe 12 is in belief-ledger-group.test.ts). Each asserts exact event types, keys and
 * values on PGLite and on Postgres when DATABASE_URL is set, and each has a
 * forced probe: a deliberately broken emitter that must make it fail.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { __setBeliefEmitterFaultForTests, type BeliefEventDraft } from '../src/core/belief/append.ts';
import { withBeliefBatch } from '../src/core/belief/ledger.ts';
import { factValue } from '../src/core/belief/subjects.ts';
import { valueHash, lifetimeRef } from '../src/core/belief/keys.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { submitRememberMutation } from '../src/core/persistence/memory-mutations.ts';
import { testBackends } from './helpers/test-backends.ts';
import { beliefBrain, beliefEngineCase, beliefPage, shape, type BeliefBrain, type BeliefEvent } from './helpers/belief-ledger.ts';

afterEach(() => { __setBeliefEmitterFaultForTests(null); installFaultHook(undefined); });

const page = (o: Parameters<typeof beliefPage>[0] = {}) => beliefPage({ facts: ['Acme raised a seed round', 'Acme has ten staff', 'Acme sells widgets'],
  takes: ['Acme will win its market', 'Acme will hire fast'], links: ['people/alice-example'], ...o });
const without = (fault: (drafts: BeliefEventDraft[]) => BeliefEventDraft[]) => __setBeliefEmitterFaultForTests(fault);
const dropType = (type: string) => (drafts: BeliefEventDraft[]) => drafts.filter(d => d.eventType !== type);
const keyParts = (e: BeliefEvent) => JSON.parse(e.subject_key) as unknown[];

async function seeded(b: BeliefBrain) {
  await b.put('people/alice-example', beliefPage({ type: 'person', title: 'Alice Example' }));
  await b.put('companies/acme-example', page());
  return b.lastId();
}

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe(`belief ledger lifecycle (${engineCase.name})`, () => {
    const brain = (run: (b: BeliefBrain) => Promise<void>, managed = true) => beliefBrain(run, { managed, databaseUrl: engineCase.databaseUrl });

    test('probe 39: a create is one snapshot page.published; the first fact edit carries the snapshot body\'s prior value', async () => {
      await brain(async b => {
        const before = await b.lastId();
        await b.put('people/alice-example', beliefPage({ type: 'person', title: 'Alice Example' }));
        await b.put('companies/acme-example', page());
        const created = (await b.events(before)).filter(e => e.slug === 'companies/acme-example');
        expect(shape(created)).toEqual(['page:page.published']);
        expect(created[0]!.value).toMatchObject({ snapshot: true, revision_before: null, counts: { facts: 3, takes: 2, links: 1, link_transitions: 0 } });
        const lifetime = created[0]!.page_lifetime!;
        const body = (await b.engine.executeRaw<{ compiled_truth: string }>(`SELECT compiled_truth FROM pages WHERE source_id=$1 AND slug='companies/acme-example'`, [b.sourceId]))[0]!.compiled_truth;
        const row = parseFactsFence(body).facts.find(f => f.claim === 'Acme has ten staff')!;
        const mark = await b.lastId();
        await b.put('companies/acme-example', page({ facts: ['Acme raised a seed round', { claim: 'Acme has ten staff', confidence: '0.5' }, 'Acme sells widgets'] }));
        const edit = await b.events(mark);
        expect(shape(edit)).toEqual(['page:page.published', 'fact:fact.revised']);
        const revised = edit[1]!;
        expect(keyParts(revised).slice(0, 3)).toEqual(['f', lifetimeRef(lifetime), 2]);
        const stored = (await b.engine.executeRaw<Record<string, unknown>>(`SELECT valid_from FROM facts WHERE source_id=$1 AND fact='Acme has ten staff' AND expired_at IS NULL`, [b.sourceId]))[0]!;
        const prior = factValue({ id: 0, entity_slug: 'companies/acme-example', sms: 'companies/acme-example', entity_page_id: null, fact: row.claim, fp: '', kind: row.kind,
          visibility: row.visibility, notability: row.notability, context: row.context ?? null, confidence: row.confidence, valid_from: new Date(stored.valid_from as string).toISOString(),
          valid_until: null, claim_metric: null, claim_value: null, claim_unit: null, claim_period: null, event_type: null, dimension: null, value: null, value_hash: null,
          row_num: 2, tier: '' }, lifetimeRef(lifetime), 1);
        expect(revised.prior_hash).toBe(valueHash(prior));
        expect(revised.value).toMatchObject({ fact: 'Acme has ten staff', confidence: 0.5 });
        // Forced probe: an emitter that writes per-subject creation events beside the snapshot is caught.
        without(drafts => drafts.flatMap(d => d.eventType === 'page.published' && (d.value as { snapshot?: boolean }).snapshot
          ? [d, { ...d, subjectKind: 'fact' as const, subjectKey: '["f","forced"]', eventType: 'fact.asserted' }] : [d]));
        const forced = await b.lastId();
        await b.put('companies/forced-example', page());
        expect(shape(await b.events(forced))).not.toEqual(['page:page.published']);
      });
    }, 120_000);

    test('probe 39: a database-only fact and a page over 1 MiB get per-subject creation events', async () => {
      await brain(async b => {
        const mark = await b.lastId();
        await submitRememberMutation(b.ctx, { fact: 'Bob example prefers tea', entity: 'people/bob-example', provenance: 'probe' });
        const remembered = await b.events(mark);
        expect(shape(remembered)).toEqual(['fact:fact.asserted']);
        expect(keyParts(remembered[0]!)[1]).toBe(`S:${remembered[0]!.source_incarnation}:people/bob-example`);
        expect(remembered[0]!.page_lifetime).toBeNull();
        const big = await b.lastId();
        await b.put('companies/huge-example', page({ prose: `${'Long prose. '.repeat(100_000)}` }));
        const huge = await b.events(big);
        expect(huge[0]!.value).toMatchObject({ snapshot: false });
        const counts = huge[0]!.value!.counts as Record<string, number>;
        expect(counts).toMatchObject({ facts: 3, takes: 2 });
        expect(shape(huge).sort()).toEqual(['page:page.published', ...Array(counts.facts).fill('fact:fact.asserted'), ...Array(counts.links).fill('link:link.asserted'),
          ...Array(counts.takes).fill('take:take.asserted')].sort());
      });
    }, 180_000);

    test('probes 1 and 2: a no-op reimport appends nothing; a prose-only edit appends exactly one page.published', async () => {
      await brain(async b => {
        await seeded(b);
        const mark = await b.lastId();
        await b.put('companies/acme-example', page());
        expect(await b.events(mark)).toEqual([]);
        await b.put('companies/acme-example', page({ prose: 'Rewritten prose with no belief change.' }));
        const prose = await b.events(mark);
        expect(shape(prose)).toEqual(['page:page.published']);
        expect(Object.keys(prose[0]!.value!).sort()).toEqual(['revision_after', 'revision_before']);
        expect(prose[0]!.value!.revision_before).not.toBe(prose[0]!.value!.revision_after);
        // Forced probe: an emitter that also writes a spurious fact event is caught.
        without(drafts => [...drafts, ...drafts.filter(d => d.subjectKind === 'page').map(d => ({ ...d, subjectKind: 'fact' as const, subjectKey: '["f","spurious"]', eventType: 'fact.revised' }))]);
        const forced = await b.lastId();
        await b.put('companies/acme-example', page({ prose: 'Prose again.' }));
        expect(shape(await b.events(forced))).not.toEqual(['page:page.published']);
      });
    }, 120_000);

    test('probe 5: row reuse retracts and asserts linked by replaces; an in-place take edit likewise; a pure take renumber appends nothing', async () => {
      await brain(async b => {
        await seeded(b);
        let mark = await b.lastId();
        await b.put('companies/acme-example', page({ facts: ['Acme raised a seed round', 'Acme has ten staff', 'Acme sells gadgets'] }));
        let ev = await b.events(mark);
        expect(shape(ev).sort()).toEqual(['fact:fact.asserted', 'fact:fact.retracted', 'page:page.published']);
        const asserted = ev.find(e => e.event_type === 'fact.asserted');
        const retracted = ev.find(e => e.event_type === 'fact.retracted');
        expect(asserted!.cause.replaces).toBe(retracted!.subject_key);
        expect(retracted!.cause.replaced_by).toBe(asserted!.subject_key);
        expect(asserted!.value!.fact).toBe('Acme sells gadgets');
        expect(retracted!.value).toBeNull();
        expect(keyParts(retracted!)[3]).toBe(retracted!.claim_fp);
        mark = await b.lastId();
        await b.put('companies/acme-example', page({ facts: ['Acme raised a seed round', 'Acme has ten staff', 'Acme sells gadgets'], takes: ['Acme will win its market', 'Acme will hire slowly'] }));
        ev = await b.events(mark);
        expect(shape(ev).sort()).toEqual(['page:page.published', 'take:take.asserted', 'take:take.retracted']);
        expect(ev.find(e => e.event_type === 'take.asserted')!.cause.replaces).toBe(ev.find(e => e.event_type === 'take.retracted')!.subject_key);
        mark = await b.lastId();
        await b.put('companies/acme-example', page({ facts: ['Acme raised a seed round', 'Acme has ten staff', 'Acme sells gadgets'], takes: ['Acme will hire slowly', 'Acme will win its market'] }));
        expect(shape(await b.events(mark))).toEqual(['page:page.published']);
        // Forced probe: an emitter that drops the replaces link is caught.
        without(drafts => drafts.map(d => ({ ...d, cause: { ...d.cause, replaces: undefined } })));
        mark = await b.lastId();
        await b.put('companies/acme-example', page({ facts: ['Acme raised a seed round', 'Acme has ten staff', 'Acme sells sprockets'], takes: ['Acme will hire slowly', 'Acme will win its market'] }));
        ev = await b.events(mark);
        expect(ev.find(e => e.event_type === 'fact.asserted')!.cause.replaces).toBeUndefined();
      });
    }, 120_000);

    test('probe 3: a restart between writes and a replayed request append no duplicate event_key and keep the state chain', async () => {
      await brain(async b => {
        await seeded(b);
        const requestId = randomUUID();
        await b.put('companies/acme-example', page({ prose: 'Edit one.' }), { request_id: requestId });
        const { disposePersistenceConsumer } = await import('../src/core/persistence/service.ts');
        await disposePersistenceConsumer(b.engine);
        const mark = await b.lastId();
        await b.put('companies/acme-example', page({ prose: 'Edit one.' }), { request_id: requestId });
        expect(await b.events(mark)).toEqual([]);
        await b.put('companies/acme-example', page({ prose: 'Edit two.' }));
        const all = await b.events();
        expect(new Set(all.map(e => e.event_key)).size).toBe(all.length);
        const pageEvents = all.filter(e => e.slug === 'companies/acme-example' && e.subject_kind === 'page');
        for (let i = 1; i < pageEvents.length; i++) expect(pageEvents[i]!.value!.revision_before).toBe(pageEvents[i - 1]!.value!.revision_after);
        // Forced probe: an emitter that re-keys a replay (a fresh publication id) would duplicate the subject: the unique key no longer protects it.
        const [{ n }] = await b.engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM belief_events WHERE source_id=$1', [b.sourceId]);
        without(drafts => drafts.map(d => ({ ...d, cause: { ...d.cause, op: `${d.cause.op}-rekeyed` } })));
        await b.put('companies/acme-example', page({ prose: 'Edit three.' }));
        const [{ n: after }] = await b.engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM belief_events WHERE source_id=$1', [b.sourceId]);
        expect(after).toBe(n + 1);
      });
    }, 120_000);

    test('probe 7: a crash after durable publication but before acknowledgement; the retry appends nothing', async () => {
      await brain(async b => {
        await seeded(b);
        const requestId = randomUUID();
        let crashed = false;
        installFaultHook(async point => { if (point === 'publication:after_commit' && !crashed) { crashed = true; throw new Error('simulated crash before acknowledgement'); } });
        await b.put('companies/acme-example', page({ prose: 'Crash edit.' }), { request_id: requestId }).catch(() => undefined);
        installFaultHook(undefined);
        expect(crashed).toBe(true);
        const committed = await b.events();
        expect(committed.filter(e => e.cause.request && e.event_type === 'page.published').length).toBeGreaterThan(0);
        const mark = await b.lastId();
        const retried = await b.put('companies/acme-example', page({ prose: 'Crash edit.' }), { request_id: requestId });
        expect(retried.revision).toBeDefined();
        expect(await b.events(mark)).toEqual([]);
      });
    }, 120_000);

    test('probe 21: the finalization contract refuses a slug whose page key the transaction does not hold', async () => {
      await brain(async b => {
        await seeded(b);
        const attempt = b.engine.transaction(tx => withBeliefBatch(tx, { sourceId: b.sourceId, slugs: ['companies/acme-example'], op: 'probe' }, async () => undefined));
        await expect(attempt).rejects.toMatchObject({ code: 'belief_page_key_not_held' });
        const held = await b.engine.transaction(async tx => {
          await tx.lockPageKeys([{ sourceId: b.sourceId, slug: 'companies/acme-example' }]);
          return withBeliefBatch(tx, { sourceId: b.sourceId, slugs: ['companies/acme-example'], op: 'probe' }, async () => 'ok');
        });
        expect(held).toBe('ok');
      });
    }, 120_000);

    test('probe 18: two links in one publication to identically spelled slugs in two sources are two keys', async () => {
      await beliefBrain(async b => {
        await b.engine.executeRaw(`INSERT INTO sources(id,name) VALUES('other-example','other-example') ON CONFLICT DO NOTHING`);
        await b.put('people/alice-example', beliefPage({ type: 'person', title: 'Alice Example' }));
        await b.put('companies/acme-example', beliefPage({ prose: 'No links yet.' }));
        await b.engine.executeRaw(`INSERT INTO pages(source_id,slug,type,title,compiled_truth,timeline,frontmatter) VALUES('other-example','people/alice-example','person','Alice Elsewhere','x','','{}'::jsonb)`);
        const mark = await b.lastId();
        const publish = (drop: boolean) => b.engine.transaction(async tx => {
          await tx.lockPageKeys([{ sourceId: b.sourceId, slug: 'companies/acme-example' }]);
          if (drop) await tx.executeRaw(`DELETE FROM links WHERE from_page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug='companies/acme-example')`, [b.sourceId]);
          else await withBeliefBatch(tx, { sourceId: b.sourceId, slugs: ['companies/acme-example'], op: 'probe_links' }, () => tx.addLinksBatch(
            [b.sourceId, 'other-example'].map(to => ({ from_slug: 'companies/acme-example', to_slug: 'people/alice-example', from_source_id: b.sourceId, to_source_id: to,
              link_type: 'mentions', context: 'Works with Alice', link_source: 'manual' })), { auditSite: 'addLinksBatch' }));
        });
        await publish(false);
        const links = (await b.events(mark)).filter(e => e.subject_kind === 'link');
        expect(shape(links)).toEqual(['link:link.asserted', 'link:link.asserted']);
        expect(new Set(links.map(e => e.subject_key)).size).toBe(2);
        expect(links.map(e => (e.cause.label as { to: string[] }).to.join('/')).sort()).toEqual([`${b.sourceId}/people/alice-example`, 'other-example/people/alice-example'].sort());
        expect(links.every(e => e.trust_tier === e.writer_tier || e.tier_basis === 'writer')).toBe(true);
        // Forced probe: an emitter keyed on the slug alone collapses the two links into one key.
        await publish(true);
        without(drafts => drafts.map(d => d.subjectKind === 'link' ? { ...d, subjectKey: JSON.stringify(['l', 'people/alice-example']) } : d));
        const forced = await b.lastId();
        await publish(false);
        expect((await b.events(forced)).filter(e => e.subject_kind === 'link').length).toBe(1);
      }, { databaseUrl: engineCase.databaseUrl });
    }, 120_000);
  });
}
