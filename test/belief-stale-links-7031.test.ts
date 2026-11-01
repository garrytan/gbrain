/**
 * #7031: on a belief-covered managed source, every link the managed stale extraction writes is journaled, so the
 * cycle's drift check finds nothing to reconcile and the page interval stays certified.
 *
 * 1. Protects: a page published before the person it names had a page gets its links filled in later by
 *    extractManagedStaleLinks: the derived (markdown) link and the mention pass's plain mention link. Each is recorded
 *    as an unmanaged, marked publication, and scanBeliefDrift reports no drift for the page.
 * 2. Fails when: a writer in the stale extraction (the mention pass) adds or removes links outside a belief batch:
 *    the page reads as drift and the cycle reconciles it as permanently uncertified.
 * 3. Why existing coverage misses it: the projection-point probe in belief-ledger-coverage.test.ts runs the unmanaged
 *    extract path with links only; no probe runs the mention pass on a covered source.
 */
import { describe, expect, test } from 'bun:test';
import { scanBeliefDrift } from '../src/core/belief/coverage-report.ts';
import { extractManagedStaleLinks } from '../src/core/persistence/links-maintenance.ts';
import { beliefBrain, beliefEngineCase, beliefPage } from './helpers/belief-ledger.ts';
import { testBackends } from './helpers/test-backends.ts';

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe('#7031 managed stale link extraction on a belief-covered source (' + engineCase.name + ')', () => {
    test('links filled in by the stale extraction and its mention pass are journaled and leave no drift', async () => {
      await beliefBrain(async b => {
        await b.put('companies/acme-example', beliefPage({ prose: 'Acme Example met Bob Example last week.', links: ['people/alice-example'] }));
        await b.put('people/alice-example', beliefPage({ type: 'person', title: 'Alice Example' }));
        await b.put('people/bob-example', beliefPage({ type: 'person', title: 'Bob Example' }));
        const links = async () => (await b.engine.executeRaw<{ to: string; source: string }>(
          "SELECT t.slug AS to, l.link_source AS source FROM links l JOIN pages a ON a.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id WHERE a.slug = 'companies/acme-example' ORDER BY 1"))
          .map(r => r.to + ':' + r.source);
        expect((await scanBeliefDrift(b.engine, b.sourceId, { deep: true })).drifted).toEqual([]);
        const before = await b.lastId();
        await extractManagedStaleLinks(b.engine, { sourceId: b.sourceId, slugs: ['companies/acme-example'] });
        expect(await links()).toEqual(['people/alice-example:markdown', 'people/bob-example:mentions']);
        const events = await b.events(before);
        const publications = [...new Set(events.map(e => e.publication_id))];
        const marks = await b.engine.executeRaw('SELECT 1 FROM belief_commit_marks WHERE publication_id = ANY($1::uuid[])', [publications]);
        expect(marks.length).toBe(publications.length);
        expect((await scanBeliefDrift(b.engine, b.sourceId, { deep: true })).drifted).toEqual([]);
        expect(events.filter(e => e.subject_kind === 'link').map(e => [e.slug, e.event_type, e.origin, e.cause.op]))
          .toEqual([['companies/acme-example', 'link.asserted', 'unmanaged', 'derived_links'], ['companies/acme-example', 'link.asserted', 'unmanaged', 'mention_pass']]);
        // The mention is edited away: the pass removes its link, journaled the same way.
        await b.put('companies/acme-example', beliefPage({ prose: 'Acme Example met nobody last week.', links: ['people/alice-example'] }));
        const removal = await b.lastId();
        await extractManagedStaleLinks(b.engine, { sourceId: b.sourceId, slugs: ['companies/acme-example'] });
        expect(await links()).toEqual(['people/alice-example:markdown']);
        expect((await b.events(removal)).filter(e => e.subject_kind === 'link').map(e => [e.event_type, e.cause.op])).toEqual([['link.retracted', 'mention_pass']]);
        expect((await scanBeliefDrift(b.engine, b.sourceId, { deep: true })).drifted).toEqual([]);
      }, { managed: true, databaseUrl: engineCase.databaseUrl });
    }, 180_000);
  });
}
