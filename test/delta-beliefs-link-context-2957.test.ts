/**
 * GST-2957: delta {beliefs: true} carries each changed link's stored context, an excerpt of a page body that can hold
 * private facts-fence rows. A remote caller whose fact reads are world-only gets the link change without that text; the
 * local CLI still reads it. PGLite, and Postgres when DATABASE_URL is set. Synthetic data only.
 */
import { describe, expect, test } from 'bun:test';
import { operationsByName } from '../src/core/operations.ts';
import { testBackends } from './helpers/test-backends.ts';
import { beliefBrain, beliefEngineCase, beliefPage, type BeliefBrain } from './helpers/belief-ledger.ts';

const CANARY = 'falconbeliefprivcanary';
const slug = 'companies/acme-example';
const pause = () => new Promise(resolve => setTimeout(resolve, 25));
const at = async (b: BeliefBrain) => { await pause(); const t = new Date((await b.engine.executeRaw<{ t: string }>('SELECT clock_timestamp() AS t'))[0]!.t).toISOString(); await pause(); return t; };

for (const engineCase of testBackends().map(beliefEngineCase)) {
  describe('GST-2957 delta beliefs link context (' + engineCase.name + ')', () => {
    test('a world-only remote caller gets the link change without its stored context; the local CLI keeps it', () => beliefBrain(async b => {
      await b.put('companies/widget-co', beliefPage({ title: 'Widget' }));
      await b.put(slug, beliefPage({ facts: ['Acme sells widgets'] }));
      const t0 = await at(b);
      await b.put(slug, beliefPage({ facts: [{ claim: 'Acme owes [[companies/widget-co]] money ' + CANARY, visibility: 'private' }, 'Acme sells widgets'] }));
      await pause(); await pause();
      await new Promise(r => setTimeout(r, 2_500));
      const delta = (remote: boolean) => operationsByName.delta!.handler({ ...b.ctx, remote, ...(remote ? { auth: { clientId: 'gst2957-remote', scopes: ['read'] } } : {}) } as never,
        { since: t0, beliefs: true }) as Promise<Record<string, any>>;
      const local = await delta(false);
      const links = (r: Record<string, any>) => r.beliefs.changes.filter((c: { kind: string }) => c.kind === 'link');
      expect(links(local).length).toBeGreaterThan(0);
      expect(JSON.stringify(links(local))).toContain(CANARY);
      const remote = await delta(true);
      expect(links(remote).map((c: { subject: unknown }) => c.subject)).toEqual(links(local).map((c: { subject: unknown }) => c.subject));
      expect(JSON.stringify(remote)).not.toContain(CANARY);
    }, { managed: true, databaseUrl: engineCase.databaseUrl }), 120_000);
  });
}
