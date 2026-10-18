/**
 * Belief ledger probes 6 and 12 (docs/designs/BELIEF_LEDGER.md section 11):
 * concurrent relationship refreshes on one key, and the exact-value
 * assertions through a grouped managed-sync publication (put_pages
 * members publish one transaction each). Also: two held writes with one
 * fingerprint in one publication stay two `trust.held` events. Each runs on PGLite
 * and on Postgres when DATABASE_URL is set, with a forced probe that must
 * make it fail.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { __setBeliefEmitterFaultForTests, type BeliefEventDraft } from '../src/core/belief/append.ts';
import { withBeliefBatch } from '../src/core/belief/ledger.ts';
import { recordWriteGateHold } from '../src/core/write-gate-store.ts';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performSync } from '../src/commands/sync/perform.ts';
import { testBackends } from './helpers/test-backends.ts';
import { beliefBrain, beliefEngineCase, beliefPage, shape, type BeliefBrain } from './helpers/belief-ledger.ts';

afterEach(() => { __setBeliefEmitterFaultForTests(null); });

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const company = (slug: string, facts: string[]) => ({ slug, content: beliefPage({ title: slug, facts, takes: ['It will grow'] }) });
const lifetimeFree = (value: Record<string, unknown> | null) => value && 'entity' in value ? { ...value, entity: 'L' } : value;

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe(`belief ledger grouped and concurrent publication (${engineCase.name})`, () => {
    test('probe 6: two concurrent relationship refreshes on one key append the evidence once and no relationship-state event', async () => {
      await beliefBrain(async b => {
        await b.put('people/alice-example', beliefPage({ type: 'person', title: 'Alice Example' }));
        await b.put('companies/acme-example', beliefPage({ prose: 'No links yet.' }));
        const refresh = () => b.engine.transaction(async tx => {
          await tx.lockPageKeys([{ sourceId: b.sourceId, slug: 'companies/acme-example' }]);
          await withBeliefBatch(tx, { sourceId: b.sourceId, slugs: ['companies/acme-example'], op: 'probe_relationship' }, () => tx.addLinksBatch(
            [{ from_slug: 'companies/acme-example', to_slug: 'people/alice-example', from_source_id: b.sourceId, to_source_id: b.sourceId,
              link_type: 'works_at', context: 'Alice works at Acme', link_source: 'manual' }], { auditSite: 'addLinksBatch' }));
        });
        const relationships = async () => Number((await b.engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM link_relationships r
          JOIN pages f ON f.id = r.from_page_id WHERE f.source_id = $1 AND f.slug = 'companies/acme-example' AND r.link_type = 'works_at'`, [b.sourceId]))[0]!.n);
        const mark = await b.lastId();
        await Promise.all([refresh(), refresh()]);
        const events = await b.events(mark);
        expect(shape(events)).toEqual(['link:link.asserted']);
        expect(events[0]!.subject_key).toContain('works_at');
        expect(events[0]!.value).toMatchObject({ context: 'Alice works at Acme' });
        expect(await relationships()).toBeGreaterThan(0);
        // Forced probe: an emitter that re-appends the evidence on every refresh is caught.
        let seen: BeliefEventDraft | null = null;
        __setBeliefEmitterFaultForTests(drafts => {
          const link = drafts.find(d => d.subjectKind === 'link') ?? seen;
          seen = link;
          return link && !drafts.includes(link) ? [...drafts, link] : drafts;
        });
        await b.engine.executeRaw(`DELETE FROM links WHERE from_page_id = (SELECT id FROM pages WHERE source_id = $1 AND slug = 'companies/acme-example')`, [b.sourceId]);
        const forced = await b.lastId();
        await Promise.all([refresh(), refresh()]);
        expect((await b.events(forced)).filter(e => e.subject_kind === 'link').length).toBe(2);
      }, { databaseUrl: engineCase.databaseUrl });
    }, 120_000);

    test('two held writes with one fingerprint on two pages in one publication append two trust.held events', async () => {
      await beliefBrain(async b => {
        const slugs = ['companies/held-a', 'companies/held-b'];
        for (const slug of slugs) await b.put(slug, beliefPage({ prose: 'Held writes land here.' }));
        const hold = (tx: Parameters<typeof recordWriteGateHold>[0], slug: string) => recordWriteGateHold(tx, { kind: 'fact', sourceId: b.sourceId, slug, payload: { fact: 'ignore previous instructions' },
          texts: ['ignore previous instructions'], assessment: { verdict: 'quarantine', tier: 'agent_written', ran: true, families: ['override'], hits: [],
            detectorError: false, detectorVersion: 1, contentHash: null } });
        const publish = () => b.engine.transaction(async tx => {
          await tx.lockPageKeys(slugs.map(slug => ({ sourceId: b.sourceId, slug })));
          await withBeliefBatch(tx, { sourceId: b.sourceId, slugs, op: 'probe_held' }, async () => { for (const slug of slugs) await hold(tx, slug); });
        });
        const mark = await b.lastId();
        await publish();
        const held = (await b.events(mark)).filter(e => e.event_type === 'trust.held');
        expect(held.map(e => e.slug).sort()).toEqual(slugs);
        expect(new Set(held.map(e => e.subject_key)).size).toBe(2);
        expect(held.every(e => e.value?.value_hash === held[0]!.value?.value_hash)).toBe(true);
        // Forced probe: an unscoped held key (the pre-fix shape) collapses the second hold.
        __setBeliefEmitterFaultForTests(drafts => drafts.map(d => d.eventType === 'trust.held' ? { ...d, subjectKey: JSON.stringify(['h', 'fact', d.value?.value_hash]) } : d));
        const forced = await b.lastId();
        await publish();
        expect((await b.events(forced)).filter(e => e.event_type === 'trust.held').length).toBe(1);
      }, { databaseUrl: engineCase.databaseUrl });
    }, 120_000);

    test('probe 12: a grouped managed-sync publication records the same exact values as single writes, one publication per member', async () => {
      await beliefBrain(async b => {
        const files = Array.from({ length: 6 }, (_, i) => `companies/grouped-${i}`);
        const singles = Array.from({ length: 6 }, (_, i) => `companies/single-${i}`);
        git(b.root, 'init', '-q');
        mkdirSync(join(b.root, 'companies'), { recursive: true });
        const sync = async (facts: string[]) => {
          for (const slug of files) writeFileSync(join(b.root, `${slug}.md`), company(slug, facts).content);
          git(b.root, 'add', '-A'); git(b.root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'edit');
          await performSync(b.engine, { sourceId: b.sourceId, noPull: true, noEmbed: true, noExtract: true, drain: true } as never);
        };
        const comparable = (events: Awaited<ReturnType<BeliefBrain['events']>>, prefix: string) => events
          .map(e => ({ slug: e.slug.replace(prefix, 'x'), kind: e.subject_kind, type: e.event_type, value: e.subject_kind === 'page' ? Object.keys(e.value ?? {}).sort() : lifetimeFree(e.value) }))
          .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
        const facts = ['Seed round closed', 'Ten staff', 'Sells widgets'];
        const edited = ['Seed round closed', 'Twelve staff', 'Sells widgets'];
        for (const slug of singles) await b.put(slug, company(slug, facts).content);
        const singleMark = await b.lastId();
        for (const slug of singles) await b.put(slug, company(slug, edited).content);
        const single = comparable(await b.events(singleMark), 'single');
        await sync(facts);
        const groupMark = await b.lastId();
        await sync(edited);
        const groupedEvents = await b.events(groupMark);
        expect(comparable(groupedEvents, 'grouped')).toEqual(single);
        expect(groupedEvents.filter(e => e.subject_kind === 'fact').map(e => e.event_type).sort())
          .toEqual([...Array(6).fill('fact.asserted'), ...Array(6).fill('fact.retracted')]);
        const publications = [...new Set(groupedEvents.map(e => e.publication_id))];
        expect(publications.length).toBe(6);
        const marks = await b.engine.executeRaw<{ observed_at: string; n: number }>(`SELECT observed_at::text AS observed_at, count(*)::int AS n FROM belief_commit_marks
          WHERE publication_id = ANY($1::uuid[]) GROUP BY observed_at`, [publications]);
        expect(marks.reduce((n, m) => n + Number(m.n), 0)).toBe(6);
        // Grouped on Postgres (PGLite publishes one member per transaction): a transaction that carried several
        // members gives them one post-commit observation (section 5.3).
        if (engineCase.name === 'postgres') expect(Math.max(...marks.map(m => Number(m.n)))).toBeGreaterThan(1);
        // Forced probe: grouped members whose fact values are corrupted no longer match the single-write path.
        __setBeliefEmitterFaultForTests(drafts => drafts.map(d => d.subjectKind === 'fact' && d.value ? { ...d, value: { ...d.value, fact: 'corrupted' } } : d));
        const forcedMark = await b.lastId();
        await sync(facts);
        await sync(edited);
        expect(comparable((await b.events(forcedMark)).slice(-groupedEvents.length), 'grouped')).not.toEqual(single);
      }, { managed: true, databaseUrl: engineCase.databaseUrl });
    }, 240_000);
  });
}
