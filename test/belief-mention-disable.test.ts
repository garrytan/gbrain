import { describe, expect, test } from 'bun:test';
import { scanBeliefDrift } from '../src/core/belief/coverage-report.ts';
import { runMentionPass } from '../src/core/mentions/pass.ts';
import { beliefBrain, beliefEngineCase, beliefPage } from './helpers/belief-ledger.ts';
import { testBackends } from './helpers/test-backends.ts';

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe('mention disable journals deletions (' + engineCase.name + ')', () => {
    test('disabling mentions retracts each origin link without drift', async () => {
      await beliefBrain(async b => {
        await b.engine.setConfig('schema_pack', 'gbrain-base-v2');
        await b.put('companies/zebra-test', beliefPage({ type: 'company', title: 'Zebra Holdings', prose: 'A company.' }));
        await b.put('notes/journal-test', beliefPage({ type: 'note', title: 'Notes', prose: 'Met Zebra Holdings today.' }));
        expect((await runMentionPass(b.engine, { sourceId: b.sourceId })).created).toBe(1);
        expect((await scanBeliefDrift(b.engine, b.sourceId, { deep: true })).drifted).toEqual([]);
        const last = await b.lastId();
        await b.engine.setConfig('mentions.auto_link', 'false');
        const pass = await runMentionPass(b.engine, { sourceId: b.sourceId });
        expect(pass).toMatchObject({ removed: 1, state: 'disabled' });
        const events = (await b.events(last)).filter(e => e.subject_kind === 'link');
        console.log('DISABLE_RECEIPT=' + JSON.stringify({ pass, events: events.map(e => [e.slug, e.event_type, e.origin, e.cause.op]), drift: (await scanBeliefDrift(b.engine, b.sourceId, { deep: true })).drifted }));
        expect(events.map(e => [e.slug, e.event_type, e.origin])).toEqual([['notes/journal-test', 'link.retracted', 'unmanaged']]);
        expect((await scanBeliefDrift(b.engine, b.sourceId, { deep: true })).drifted).toEqual([]);
      }, { managed: true, databaseUrl: engineCase.databaseUrl });
    }, 180_000);
  });
}
