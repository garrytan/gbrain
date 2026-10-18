/**
 * Belief ledger probe 14 (docs/designs/BELIEF_LEDGER.md sections 8 and 11):
 * remote history reads leak nothing across private -> public, public ->
 * private, a reused slug, a private fact on a public page, and a link with a
 * private endpoint. PGLite and Postgres, each assertion with a forced probe.
 */
import { describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { readBeliefHistory } from '../src/core/belief/history.ts';
import { testBackends } from './helpers/test-backends.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { beliefBrain, beliefEngineCase, beliefPage, type BeliefBrain } from './helpers/belief-ledger.ts';

const remote = (b: BeliefBrain, slug?: string) => readBeliefHistory(b.engine, { sourceId: b.sourceId, slug, remote: true });
const local = (b: BeliefBrain, slug?: string) => readBeliefHistory(b.engine, { sourceId: b.sourceId, slug, remote: false });
const priv = { visibility: 'private' };

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe(`belief ledger privacy (${engineCase.name})`, () => {
    test('probe 14: private -> public shows only events recorded while world; public -> private hides the whole stream', async () => {
      await beliefBrain(async b => {
        await b.put('companies/acme-example', beliefPage({ frontmatter: priv, facts: ['Acme is secretly hiring'] }));
        expect(await remote(b, 'companies/acme-example')).toEqual([]);
        await b.put('companies/acme-example', beliefPage({ facts: ['Acme is secretly hiring', 'Acme ships in May'] }));
        const shown = await remote(b, 'companies/acme-example');
        const all = await local(b, 'companies/acme-example');
        expect(all.length).toBeGreaterThan(shown.length);
        expect(shown.length).toBeGreaterThan(0);
        expect(shown.every(e => e.visibility === 'world')).toBe(true);
        expect(all.some(e => e.visibility === 'private' && e.event_type === 'page.published')).toBe(true);
        await b.put('companies/acme-example', beliefPage({ frontmatter: priv, facts: ['Acme is secretly hiring', 'Acme ships in May'] }));
        expect(await remote(b, 'companies/acme-example')).toEqual([]);
        // Forced probe: a reader that checks only the recorded visibility would leak the earlier world events.
        const recordedOnly = (await local(b, 'companies/acme-example')).filter(e => e.visibility === 'world');
        expect(recordedOnly.length).toBeGreaterThan(0);
      }, { managed: true, databaseUrl: engineCase.databaseUrl });
    }, 120_000);

    test('probe 14: a private fact on a public page and a reused slug stay hidden', async () => {
      await beliefBrain(async b => {
        await b.put('companies/acme-example', beliefPage({ facts: ['Acme sells widgets'] }));
        const mark = await b.lastId();
        await b.put('companies/acme-example', beliefPage({ facts: ['Acme sells widgets', { claim: 'Acme payroll is late', visibility: 'private' }] }));
        const fact = (await local(b, 'companies/acme-example')).filter(e => e.id > mark && e.subject_kind === 'fact');
        expect(fact.map(e => [e.event_type, e.visibility])).toEqual([['fact.asserted', 'private']]);
        expect((await remote(b, 'companies/acme-example')).some(e => e.id > mark && e.subject_kind === 'fact')).toBe(false);
        const oldLifetime = (await local(b, 'companies/acme-example'))[0]!.page_lifetime;
        await b.engine.transaction(async tx => {
          await tx.lockPageKeys([{ sourceId: b.sourceId, slug: 'companies/acme-example' }]);
          await tx.executeRaw(`DELETE FROM pages WHERE source_id=$1 AND slug='companies/acme-example'`, [b.sourceId]);
        });
        rmSync(join(b.root, 'companies/acme-example.md'), { force: true });
        await b.put('companies/acme-example', beliefPage({ title: 'Acme Reborn', facts: ['Acme is a new company'] }));
        const reborn = await remote(b, 'companies/acme-example');
        expect(reborn.length).toBeGreaterThan(0);
        expect(reborn.every(e => e.page_lifetime !== oldLifetime)).toBe(true);
        // Forced probe: a reader that resolves an ended lifetime by slug alone would show the old page's history.
        const bySlug = (await local(b, 'companies/acme-example')).filter(e => e.page_lifetime === oldLifetime && e.visibility === 'world');
        expect(bySlug.length).toBeGreaterThan(0);
      }, { databaseUrl: engineCase.databaseUrl });
    }, 120_000);

    test('probe 14: a fact made private hides its earlier world history; a re-added source reads none of the old history', async () => {
      await beliefBrain(async b => {
        await b.put('companies/acme-example', beliefPage({ facts: ['Acme sells widgets'] }));
        await b.put('companies/acme-example', beliefPage({ facts: ['Acme sells widgets', 'Acme payroll is late'] }));
        expect((await remote(b, 'companies/acme-example')).some(e => JSON.stringify(e.value ?? {}).includes('payroll'))).toBe(true);
        await b.put('companies/acme-example', beliefPage({ facts: ['Acme sells widgets', { claim: 'Acme payroll is late', visibility: 'private' }] }));
        const leaked = (await remote(b, 'companies/acme-example')).filter(e => JSON.stringify(e.value ?? {}).includes('payroll'));
        expect(leaked).toEqual([]);
        expect((await remote(b, 'companies/acme-example')).length).toBeGreaterThan(0);
        // Forced probe: the recorded-visibility rule alone still shows the world assertion of the claim made private.
        expect((await local(b, 'companies/acme-example')).some(e => e.visibility === 'world' && JSON.stringify(e.value ?? {}).includes('payroll'))).toBe(true);
        // A re-added source is a new incarnation of the same id (probe 17).
        // The background consumer keeps writing page guards for the old incarnation, so stop it, then swap under the source row lock.
        await disposePersistenceConsumer(b.engine);
        await b.engine.transaction(async tx => {
          await tx.executeRaw('SELECT 1 FROM sources WHERE id = $1 FOR UPDATE', [b.sourceId]);
          await tx.executeRaw('DELETE FROM page_write_guards WHERE source_incarnation = (SELECT incarnation FROM sources WHERE id = $1)', [b.sourceId]);
          await tx.executeRaw('UPDATE sources SET incarnation = gen_random_uuid() WHERE id = $1', [b.sourceId]);
        });
        expect(await local(b, 'companies/acme-example')).toEqual([]);
      }, { databaseUrl: engineCase.databaseUrl });
    }, 120_000);

    test('probe 14: a link with a private endpoint is hidden until the endpoint is public', async () => {
      await beliefBrain(async b => {
        await b.put('people/alice-example', beliefPage({ type: 'person', title: 'Alice Example', frontmatter: priv }));
        await b.put('companies/acme-example', beliefPage({ prose: 'No links.' }));
        const mark = await b.lastId();
        await b.put('companies/acme-example', beliefPage({ prose: 'Now linked.', links: ['people/alice-example'] }));
        const linkEvents = (await local(b, 'companies/acme-example')).filter(e => e.id > mark && e.subject_kind === 'link');
        expect(linkEvents.map(e => e.event_type)).toEqual(['link.asserted']);
        expect((await remote(b, 'companies/acme-example')).filter(e => e.subject_kind === 'link')).toEqual([]);
        await b.put('people/alice-example', beliefPage({ type: 'person', title: 'Alice Example' }));
        expect((await remote(b, 'companies/acme-example')).filter(e => e.subject_kind === 'link').map(e => e.event_type)).toEqual(['link.asserted']);
        // Forced probe: a reader that checks only the stream page would have shown the link while Alice was private.
        expect(linkEvents[0]!.visibility).toBe('world');
      }, { databaseUrl: engineCase.databaseUrl });
    }, 120_000);
  });
}
