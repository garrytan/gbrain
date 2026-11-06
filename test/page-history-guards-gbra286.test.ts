/**
 * GBRA-286 lane D: master's read guards on the GBRA-217 page-history reads (get_versions replaced_because,
 * get_page as_of), which were written before member access (GBRA-218 readable_by) and the trust-tier quote fence
 * (GST-687) reached master.
 *
 * 1. Protects: a snapshot that names readers hides from every caller its readers do not name, on both reads: its
 *    edition (as_of answers not found, never an older edition) and its write's reason (the predecessor's
 *    replaced_because). A listed member still reads both. Text below the owner's tier (an edition's body and
 *    metadata, a reason given by a write below that tier) reaches a remote reader quoted.
 * 2. Fails when: an unlisted remote caller sees a restricted edition or its reason, a listed member is refused, or an
 *    agent-written edition or reason reaches a remote reader unquoted.
 * 3. Real handlers (put_page, get_versions, get_page) on a keyless repo-less brain: PGLite always, Postgres when
 *    DATABASE_URL is set (test/postgres-unit-arms.txt). Trust tiers are set with SQL under an owner promotion setting (put_page
 *    writes agent_written; no seam raises a tier without the owner); the member is a caller-access record, as dispatch builds for a member-bound credential.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { withCallerAccess } from '../src/core/search/private-visibility.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { testBackends, requirePostgresTestDatabase } from './helpers/test-backends.ts';

type R = Record<string, any>;
const outcomeOf = (r: R) => (r.outcome ?? r) as R;
const page = (body: string, fm: string[] = []) => ['---', 'title: Policy', 'type: note', ...fm, '---', '', body, ''].join('\n');
let n = 0;
const fresh = (name: string) => 'policies/' + name + '-' + (++n) + '-' + Math.random().toString(36).slice(2, 8);
const ALICE = ['member:alice-example'];

for (const backend of testBackends()) {
  describe(backend + ': page history reads keep member access and the quote fence', () => {
    let engine: BrainEngine;
    beforeAll(async () => {
      if (backend === 'postgres') {
        const pg = new PostgresEngine();
        await pg.connect({ database_url: requirePostgresTestDatabase() });
        engine = pg;
      } else {
        const lite = new PGLiteEngine();
        await lite.connect({});
        engine = lite;
      }
      await engine.initSchema();
    }, 180_000);
    afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); resetGateway(); });

    const ctx = (remote: boolean): OperationContext => ({ engine, config: { engine: backend } as never, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote, sourceId: 'default' } as OperationContext);
    const call = (name: string, params: R, remote = false) => operationsByName[name]!.handler(ctx(remote), params) as Promise<R>;
    const asMember = <T>(fn: () => Promise<T>) => withCallerAccess({ identity: ALICE, restricted: true }, fn);
    const versions = async (slug: string, remote: boolean, extra: R = {}) => await call('get_versions', { slug, ...extra }, remote) as unknown as R[];
    async function put(slug: string, body: string, fm: string[] = [], reason?: string): Promise<R> {
      const cur = await call('get_page', { slug, body: 'none' }).catch(() => null);
      return outcomeOf(await call('put_page', { slug, content: page(body, fm), ...(cur ? { expected_revision: cur.revision } : {}), ...(reason ? { reason } : {}), wait_ms: 30_000 }));
    }
    /** Sets the page's (and with `versions`, its snapshots') stored tier as an owner-confirmed promotion does. */
    async function setTier(slug: string, tier: string, versions = false): Promise<void> {
      await engine.transaction(async tx => {
        await tx.executeRaw("SELECT set_config('gbrain.write_trust_promotion', $1, true)", [tier]);
        await tx.executeRaw(versions ? 'UPDATE page_versions SET trust_tier = $2 WHERE page_id = (SELECT id FROM pages WHERE slug = $1)'
          : 'UPDATE pages SET trust_tier = $2 WHERE slug = $1', [slug, tier]);
      });
    }
    const refused = (p: Promise<unknown>) => p.then(() => null, (e: unknown) => e as { code?: string; message?: string });

    test('a restricted successor withholds its reason from an unlisted remote reader; a listed member reads it', async () => {
      const slug = fresh('rb');
      await put(slug, 'Open edition one.');
      await put(slug, 'Restricted draft.', ['readable_by: [alice-example]'], 'restricted-time reason canaryrbreason');
      await put(slug, 'Open edition two.', [], 'opened again');
      expect((await versions(slug, false)).map(v => v.replaced_because)).toEqual(['opened again', 'restricted-time reason canaryrbreason']);

      const unlisted = await versions(slug, true);
      expect(unlisted).toHaveLength(1);
      expect(unlisted[0]!.replaced_because).toBeNull();
      expect(JSON.stringify(unlisted)).not.toContain('canaryrbreason');
      expect(JSON.stringify(await versions(slug, true, { include_body: true }))).not.toContain('canaryrbreason');

      const member = await asMember(() => versions(slug, true));
      expect(member).toHaveLength(2);
      expect(member[0]!.replaced_because).toContain('opened again');
      expect(member[1]!.replaced_because).toContain('restricted-time reason canaryrbreason');
    });

    test('as_of: an edition that names readers reads as not found for an unlisted remote reader, and as text for a listed member', async () => {
      const slug = fresh('asof');
      await put(slug, 'Restricted edition canaryasofbody.', ["valid_from: '2026-01-01'", 'readable_by: [alice-example]']);
      await put(slug, 'Open edition.', ["valid_from: '2026-06-01'"], 'opened to everyone canaryasofreason');

      const e = await refused(call('get_page', { slug, as_of: '2026-03-01' }, true));
      expect(e?.code).toBe('page_not_found');
      expect(JSON.stringify(e)).not.toContain('canaryasofbody');

      const open = await call('get_page', { slug, as_of: '2026-07-01' }, true);
      expect(open.valid_time.status).toBe('in_force');
      expect(open.compiled_truth).toContain('Open edition.');

      const member = await asMember(() => call('get_page', { slug, as_of: '2026-03-01' }, true));
      expect(member.valid_time.status).toBe('in_force');
      expect(member.compiled_truth).toContain('canaryasofbody');
      expect(member.valid_time.replaced_because).toContain('opened to everyone canaryasofreason');
    });

    test('as_of: an unlisted remote reader never sees a reason whose successor edition names readers', async () => {
      const slug = fresh('asofreason');
      await put(slug, 'Open edition.', ["valid_from: '2026-01-01'"]);
      await put(slug, 'Restricted edition.', ["valid_from: '2026-06-01'", 'readable_by: [alice-example]'], 'restricted canaryasofsuccessor');
      await put(slug, 'Open again.', ["valid_from: '2026-09-01'"]);

      const old = await call('get_page', { slug, as_of: '2026-03-01' }, true);
      expect(old.valid_time.status).toBe('in_force');
      expect(old.valid_time.replaced_because).toBeNull();
      expect(JSON.stringify(old)).not.toContain('canaryasofsuccessor');
      const member = await asMember(() => call('get_page', { slug, as_of: '2026-03-01' }, true));
      expect(member.valid_time.replaced_because).toContain('restricted canaryasofsuccessor');
    });

    test('as_of and get_versions quote text below the owner tier for a remote reader', async () => {
      const slug = fresh('quote');
      await put(slug, 'Owner edition text.', ["valid_from: '2026-01-01'"]);
      await put(slug, 'Agent edition text.', ["valid_from: '2026-06-01'"], 'agent reason text');
      await setTier(slug, 'operator_curated');
      await setTier(slug, 'operator_curated', true);

      const ownerRead = await call('get_page', { slug, as_of: '2026-07-01' }, true);
      expect(ownerRead.compiled_truth.trim()).toBe('Agent edition text.');
      expect(ownerRead.quoted).toBeUndefined();
      expect((await versions(slug, true))[0]!.replaced_because).toBe('agent reason text');

      await setTier(slug, 'agent_written');
      const agentRead = await call('get_page', { slug, as_of: '2026-07-01' }, true);
      expect(agentRead.quoted).toBe('transcript');
      expect(agentRead.compiled_truth).toContain('Agent edition text.');
      expect(agentRead.compiled_truth.trim()).not.toBe('Agent edition text.');
      expect(agentRead.title).toContain('Policy');
      expect(agentRead.title).not.toBe('Policy');
      expect(agentRead.valid_time.introduced_because).toContain('agent reason text');
      expect(agentRead.valid_time.introduced_because).not.toBe('agent reason text');
      const quotedReason = (await versions(slug, true))[0]!.replaced_because as string;
      expect(quotedReason).toContain('agent reason text');
      expect(quotedReason).not.toBe('agent reason text');
      expect((await call('get_page', { slug, as_of: '2026-07-01' }, false)).compiled_truth.trim()).toBe('Agent edition text.');
      expect((await versions(slug, false))[0]!.replaced_because).toBe('agent reason text');

      const oldOwner = await call('get_page', { slug, as_of: '2026-03-01' }, true);
      expect(oldOwner.compiled_truth.trim()).toBe('Owner edition text.');
      expect(oldOwner.quoted).toBeUndefined();
      await setTier(slug, 'agent_written', true);
      const oldAgent = await call('get_page', { slug, as_of: '2026-03-01' }, true);
      expect(oldAgent.quoted).toBe('transcript');
      expect(oldAgent.compiled_truth).toContain('Owner edition text.');
      expect(oldAgent.compiled_truth.trim()).not.toBe('Owner edition text.');
    });
  });
}
