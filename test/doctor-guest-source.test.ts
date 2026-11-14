/**
 * guest_source doctor check (GBRA-504 slice 4).
 *
 * Protects: not_applicable without a guest source; ok for a guest source with its flags, ceiling and a live writer
 * whose grant is exactly the guest source, read by every owner credential; fail when a source is marked guest but the
 * brain's guests.present marker is unset (reads would skip the warning), when a source says guest without its
 * guest_sources row, when a writer names a removed client, or when a writer's grant reaches another source; warn, with
 * the exact grant command, when an owner credential cannot read the guest source, and when its min_trust floor hides
 * guest notes (F9). The check reads only: no grant changes. PGLite in-memory, no repository.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { initGuestSource } from '../src/core/guests/sources.ts';
import { GUEST_SOURCES_PRESENT_KEY } from '../src/core/guests/marker.ts';
import { guestSourceCheck } from '../src/commands/doctor/checks/guest-source.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import { setMinTrust } from '../src/core/trust/min-trust.ts';

const SRC = 'guests';
const PLAIN = 'source-a';
const OWNER = 'alice-example';

let engine: PGLiteEngine;
const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
const client = async (name: string, source: string, reads?: string[]) => (await provider().registerClientManual(name, ['client_credentials'], 'read write', [], source, reads)).clientId;
const federated = async (id: string) => (await engine.executeRaw<{ federated_read: string[] }>('SELECT federated_read FROM oauth_clients WHERE client_id = $1', [id]))[0]!.federated_read;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); }, 60_000);

async function healthyBrain(): Promise<{ broker: string; ownerClient: string }> {
  await addMember(engine, OWNER);
  await setOwner(engine, OWNER);
  await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [PLAIN]);
  await initGuestSource(engine, SRC, []);
  const broker = await client('broker-example', SRC, [SRC]);
  await engine.executeRaw('UPDATE guest_sources SET writers = $2::text[] WHERE source_id = $1', [SRC, ['oauth_client:' + broker]]);
  const ownerClient = await client('owner-bot-example', PLAIN, [PLAIN, SRC]);
  await bindCredential(engine, { kind: 'client', id: ownerClient }, { member: OWNER });
  return { broker, ownerClient };
}

describe('guest_source doctor check', () => {
  beforeEach(async () => { await resetPgliteState(engine); });

  test('a brain with no guest source is not applicable', async () => {
    const check = await guestSourceCheck(engine);
    expect({ status: check.status, state: check.readiness_state }).toEqual({ status: 'ok', state: 'not_applicable' });
    expect(categorizeCheck('guest_source')).toBe('brain');
  }, 60_000);

  test('flags, ceiling, a live writer granted only the guest source and owner reads: ok', async () => {
    await healthyBrain();
    const check = await guestSourceCheck(engine);
    expect({ status: check.status, message: check.message }).toEqual({ status: 'ok', message: expect.stringContaining(SRC) });
  }, 60_000);

  test('a source marked guest while guests.present is unset fails', async () => {
    await healthyBrain();
    await engine.executeRaw('DELETE FROM config WHERE key = $1', [GUEST_SOURCES_PRESENT_KEY]);
    const check = await guestSourceCheck(engine);
    expect(check.status).toBe('fail');
    expect(check.message).toContain(GUEST_SOURCES_PRESENT_KEY);
    expect(check.fix?.argv).toEqual(['gbrain', 'guests', 'init', '--source', SRC, '--yes']);
  }, 60_000);

  test('a source whose config says guest but has no guest_sources row fails', async () => {
    await healthyBrain();
    await engine.executeRaw("UPDATE sources SET config = config || '{\"guest\": true}'::jsonb WHERE id = $1", [PLAIN]);
    const check = await guestSourceCheck(engine);
    expect(check.status).toBe('fail');
    expect(check.message).toContain(PLAIN);
  }, 60_000);

  test('a writer naming a removed client, or a writer granted another source, fails', async () => {
    const { broker } = await healthyBrain();
    await engine.executeRaw('UPDATE oauth_clients SET federated_read = $2::text[] WHERE client_id = $1', [broker, [SRC, PLAIN]]);
    const wide = await guestSourceCheck(engine);
    expect(wide.status).toBe('fail');
    expect(wide.message).toContain('oauth_client:' + broker);
    await engine.executeRaw('UPDATE oauth_clients SET deleted_at = now() WHERE client_id = $1', [broker]);
    const gone = await guestSourceCheck(engine);
    expect(gone.status).toBe('fail');
    expect(gone.message).toContain('oauth_client:' + broker);
  }, 60_000);

  test('an owner client that cannot read the guest source warns with the exact grant command, and nothing changes', async () => {
    const { ownerClient } = await healthyBrain();
    await engine.executeRaw('UPDATE oauth_clients SET federated_read = $2::text[] WHERE client_id = $1', [ownerClient, [PLAIN]]);
    const [rev] = await engine.executeRaw<{ grant_revision: number }>('SELECT grant_revision FROM oauth_clients WHERE client_id = $1', [ownerClient]);
    const check = await guestSourceCheck(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('gbrain auth rescope --client ' + ownerClient + ' --read-sources ' + PLAIN + ',' + SRC + ' --if-version ' + rev!.grant_revision);
    expect(check.message).toContain('gbrain guests grant-owner-clients');
    expect(await federated(ownerClient)).toEqual([PLAIN]);
  }, 60_000);

  test('an owner client whose min_trust floor hides guest notes warns (F9)', async () => {
    const { ownerClient } = await healthyBrain();
    await setMinTrust(engine, ownerClient, 'operator_curated');
    const check = await guestSourceCheck(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('min_trust');
    expect(check.message).toContain('gbrain auth set-min-trust ' + ownerClient + ' external_untrusted');
  }, 60_000);
});
