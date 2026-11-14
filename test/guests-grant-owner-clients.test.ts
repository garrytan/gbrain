/**
 * gbrain guests grant-owner-clients (GBRA-504 slice 4, F10).
 *
 * Protects: the preview lists every credential bound to the brain owner that cannot read the guest source, with its
 * read list before and after, and writes nothing; --yes adds the guest source to each one's read list with a
 * compare-and-set on its grant revision (a grant changed since the preview is refused grant_conflict and left as it
 * is), keeps every source it already read, and leaves credentials that already read it untouched; making a guest
 * source never widens any grant. PGLite in-memory, no repository.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { initGuestSource } from '../src/core/guests/sources.ts';
import { grantOwnerCredentials, ownerCredentials } from '../src/core/guests/owner-credentials.ts';
import { rescopeClientGrant } from '../src/core/grants/service.ts';
import { runGuests } from '../src/commands/guests.ts';

const SRC = 'guests';
const PLAIN = 'source-a';
const OTHER = 'source-b';
const OWNER = 'alice-example';

let engine: PGLiteEngine;
let out: string[] = [];
let spies: Array<{ mockRestore: () => void }> = [];
const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
const client = async (name: string, source: string, reads: string[]) => (await provider().registerClientManual(name, ['client_credentials'], 'read write', [], source, reads)).clientId;
const grantOf = async (id: string) => (await engine.executeRaw<{ federated_read: string[]; grant_revision: number }>(
  'SELECT federated_read, grant_revision FROM oauth_clients WHERE client_id = $1', [id]))[0]!;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); }, 60_000);
afterEach(() => { for (const s of spies) s.mockRestore(); spies = []; out = []; });

async function brain() {
  await addMember(engine, OWNER);
  await addMember(engine, 'bob-example');
  await setOwner(engine, OWNER);
  for (const id of [PLAIN, OTHER]) await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [id]);
  const narrow = await client('owner-bot-example', PLAIN, [PLAIN, OTHER]);
  const reading = await client('owner-reader-example', PLAIN, [PLAIN]);
  const member = await client('bob-bot-example', PLAIN, [PLAIN]);
  await bindCredential(engine, { kind: 'client', id: narrow }, { member: OWNER });
  await bindCredential(engine, { kind: 'client', id: reading }, { member: OWNER });
  await bindCredential(engine, { kind: 'client', id: member }, { member: 'bob-example' });
  const token = await mintLegacyToken(engine, { name: 'owner-token-example', scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: [PLAIN] });
  await bindCredential(engine, { kind: 'token', id: token.id }, { member: OWNER });
  const before = { narrow: await grantOf(narrow), reading: await grantOf(reading), member: await grantOf(member) };
  await initGuestSource(engine, SRC, []);
  await engine.executeRaw('UPDATE oauth_clients SET federated_read = $2::text[] WHERE client_id = $1', [reading, [PLAIN, SRC]]);
  return { narrow, reading, member, token: token.id, before };
}

describe('gbrain guests grant-owner-clients', () => {
  beforeEach(async () => {
    await resetPgliteState(engine);
    spies = [spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); })];
  });

  test('making a guest source widens no grant', async () => {
    const { narrow, member, before } = await brain();
    expect(await grantOf(narrow)).toEqual(before.narrow);
    expect(await grantOf(member)).toEqual(before.member);
  }, 60_000);

  test('the preview lists owner credentials that cannot read the guest source and writes nothing', async () => {
    const { narrow, reading, member, token } = await brain();
    const before = await grantOf(narrow);
    await runGuests(engine, ['grant-owner-clients']);
    const text = out.join('\n');
    expect(text).toContain(narrow);
    expect(text).toContain(PLAIN + ', ' + OTHER + ' -> ' + PLAIN + ', ' + OTHER + ', ' + SRC);
    expect(text).toContain('owner-token-example');
    expect(text).not.toContain(member);
    expect(text).not.toContain(reading);
    expect(text).toContain('--yes');
    expect(await grantOf(narrow)).toEqual(before);
    const listed = (await ownerCredentials(engine, SRC)).credentials.filter(c => !c.readsGuest).map(c => c.id).sort();
    expect(listed).toEqual([narrow, token].sort());
  }, 60_000);

  test('--yes adds the guest source to each read list with a compare-and-set, keeping every source', async () => {
    const { narrow, reading, member, token } = await brain();
    const readingBefore = await grantOf(reading);
    const memberBefore = await grantOf(member);
    await runGuests(engine, ['grant-owner-clients', '--yes']);
    const after = await grantOf(narrow);
    expect(after.federated_read).toEqual([PLAIN, OTHER, SRC]);
    expect(await grantOf(reading)).toEqual(readingBefore);
    expect(await grantOf(member)).toEqual(memberBefore);
    const tokenView = (await ownerCredentials(engine, SRC)).credentials.find(c => c.id === token)!;
    expect({ reads: tokenView.readsGuest, sources: tokenView.readSources }).toEqual({ reads: true, sources: [PLAIN, SRC] });
    expect((await ownerCredentials(engine, SRC)).credentials.every(c => c.readsGuest)).toBe(true);
  }, 60_000);

  test('a grant changed after the preview is refused grant_conflict and left as it is', async () => {
    const { narrow } = await brain();
    const plan = (await ownerCredentials(engine, SRC)).credentials.filter(c => !c.readsGuest);
    await rescopeClientGrant(engine, narrow, { federatedRead: [PLAIN] }, { actor: 'operator:test' });
    const changed = await grantOf(narrow);
    const outcome = await grantOwnerCredentials(engine, SRC, plan);
    expect(outcome.find(o => o.id === narrow)).toMatchObject({ outcome: 'conflict' });
    expect(await grantOf(narrow)).toEqual(changed);
  }, 60_000);
});
