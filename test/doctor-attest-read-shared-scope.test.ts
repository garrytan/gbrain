/**
 * GST-1158 F3: the attest_read_shared_scope doctor check.
 *
 * 1. Protects: an attest credential set --attest-read person whose read grant includes a source another attest
 *    credential reads as the scope (attest_read scope, or unset) is warned about, by name and source; nothing is changed.
 * 2. Fails when: such a credential passes as ok, a source read only by person credentials or by credentials without the
 *    attest right is flagged, or the check writes anything.
 * 3. Real seams: OAuth clients and legacy tokens registered through the provider and the token service, bound with
 *    bindCredential, on a repo-less brain (PGLite always, Postgres when DATABASE_URL is set).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { bindCredential } from '../src/core/access/members.ts';
import { attestReadAccessEntry } from '../src/commands/doctor/checks/attest-read-access.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

for (const kind of testBackends()) {
  describe('attest_read_shared_scope doctor check (' + kind + ', repo-less)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const run = async () => (await attestReadAccessEntry.run({ engine } as unknown as DoctorContext) as Array<{ name: string; status: string; message: string; readiness_state?: string; details?: any }>)[0]!;
    const client = async (name: string, reads: string[], patch: Parameters<typeof bindCredential>[2] | null) => {
      const c = await provider().registerClientManual(name + '-' + randomUUID().slice(0, 8), ['client_credentials'], 'read', [], reads[0]!);
      await provider().rescopeClient(c.clientId, { federatedRead: reads });
      if (patch) await bindCredential(engine, { kind: 'client', id: c.clientId }, patch);
      return c.clientId;
    };
    const credentialRows = () => engine.executeRaw('SELECT client_id, attest_actor, attest_read, federated_read FROM oauth_clients ORDER BY client_id');

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      for (const id of ['source-a', 'source-room', 'source-solo']) await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [id]);
    }, 120_000);
    afterAll(async () => { await close?.(); }, 60_000);

    test('not applicable while no attest credential reads as the person; a brain category check', async () => {
      await client('scope-room', ['source-room'], { attestActor: 'qm' });
      const check = await run();
      expect({ name: check.name, status: check.status, state: check.readiness_state }).toEqual({ name: 'attest_read_shared_scope', status: 'ok', state: 'not_applicable' });
      expect(categorizeCheck('attest_read_shared_scope')).toBe('brain');
    }, 60_000);

    test('a person credential reading only sources no scope credential reads is ok, whatever plain or person credentials read', async () => {
      await client('person-solo', ['source-solo'], { attestActor: 'qm', attestRead: 'person' });
      await client('person-solo-two', ['source-solo'], { attestActor: 'qm', attestRead: 'person' });
      await client('plain-solo', ['source-solo'], null);
      expect((await run()).status).toBe('ok');
    }, 60_000);

    test('a person credential reading a source an unset or scope attest credential reads is warned, by name and source, and nothing is written', async () => {
      const person = await client('person-shared', ['source-a', 'source-room'], { attestActor: 'qm', attestRead: 'person' });
      const before = await credentialRows();
      const check = await run();
      expect(check.status).toBe('warn');
      expect(check.message).toContain('person-shared');
      expect(check.details.credentials).toEqual([{ kind: 'client', name: expect.stringContaining('person-shared'), shared_sources: ['source-room'] }]);
      expect(await credentialRows()).toEqual(before);
      await bindCredential(engine, { kind: 'client', id: person }, { attestRead: 'scope' });
      expect((await run()).status).toBe('ok');
      const legacy = await mintLegacyToken(engine, { name: 'person-legacy-' + randomUUID().slice(0, 8), scopes: ['read'], takesHolders: ['world'], sourceGrant: ['source-solo'] });
      await bindCredential(engine, { kind: 'token', id: legacy.id }, { attestActor: 'qm', attestRead: 'person' });
      expect((await run()).status).toBe('ok');
      await client('unset-solo', ['source-solo'], { attestActor: 'qm' });
      const token = await run();
      expect(token.status).toBe('warn');
      expect(token.details.credentials).toHaveLength(3);
      expect(token.details.credentials).toContainEqual({ kind: 'token', name: expect.stringContaining('person-legacy'), shared_sources: ['source-solo'] });
      expect(token.message).toContain('person-solo');
    }, 60_000);
  });
}
