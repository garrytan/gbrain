/**
 * GBRA-585 A: what a setup re-run does to the member keys an earlier run minted with a source list.
 *
 * 1. Protects: a re-run re-grants a member key only while the key's source list is still the one setup last gave it
 *    (recorded on the key as permissions.setup_reads), so a key an admin narrowed by hand keeps its list, and the
 *    receipt names it as skipped with the rescope command that adds the sources; and a source archived since the key
 *    was minted is dropped from the list instead of failing every later re-run with invalid_grant.
 * 2. Fails when: a re-run gives back a source an admin took off a key, names no skipped key, fails on an archived
 *    source, or stops adding new sources to a key it left as it minted it.
 * 3. Existing coverage: setup-company-access.test.ts covers the first mint and the company regrant, not a hand rescope
 *    or an archived source.
 * 4. No production seam: the real labelling and rescope on PGLite.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { labelSeveral, receiptLines } from '../src/commands/access-serves.ts';
import { rescopeLegacyToken } from '../src/core/grants/legacy-token.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mintToken } from '../src/commands/auth-mint.ts';
import { addMember } from '../src/core/access/members.ts';
import { withEnv } from './helpers/with-env.ts';
import { memoryBrain, removeTempDirs, tempDir } from './helpers/setup-serves-box.ts';

afterAll(removeTempDirs);

const reads = async (e: PGLiteEngine, name: string) => [...((await e.executeRaw<{ f: string[] }>('SELECT federated_read AS f FROM access_tokens WHERE name = $1 AND revoked_at IS NULL', [name]))[0]?.f ?? [])];
const addSource = (e: PGLiteEngine, id: string, federated = false) => e.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, $2::jsonb)`, [id, JSON.stringify(federated ? { federated: true } : {})]);
async function brain() {
  const e = await memoryBrain();
  const home = tempDir('gbrain-regrant-');
  const label = (roster: string[]) => withEnv({ GBRAIN_HOME: home, GBRAIN_SETUP_ABORT_AFTER: undefined }, () => labelSeveral(e, roster, 'default', true, true));
  return { e, label, home };
}

describe('setup re-run and the member keys it minted', () => {
  test('a key an admin changed by hand is skipped and named, and keeps its list', async () => {
    const { e, label } = await brain();
    await addSource(e, 'company');
    await addSource(e, 'team-b', true);
    await label(['alice-example']);
    expect(await reads(e, 'member-alice-example')).toEqual(['default', 'company', 'team-b']);
    await rescopeLegacyToken(e, { target: { name: 'member-alice-example' }, sources: ['default', 'team-b'], reset: [], refreshOperations: false, allNew: false, dryRun: false, json: true });
    const r = await label(['alice-example', 'bob-example']);
    expect(r.error).toBeUndefined();
    expect(await reads(e, 'member-alice-example')).toEqual(['default', 'team-b']);
    expect(await reads(e, 'member-bob-example')).toEqual(['default', 'company', 'team-b']);
    const alice = r.keys.find(k => k.member === 'alice-example')!;
    expect(alice.action).toBe('skipped');
    expect(alice.adds).toBeUndefined();
    expect(alice.detail).toContain('gbrain auth rescope --token member-alice-example --sources default,team-b,company');
    expect(receiptLines(r).join('\n')).toContain('key        alice-example: ');
    expect(receiptLines(r).find(l => l.includes('alice-example:'))).toContain('skipped');
    await e.disconnect();
  }, 120_000);

  test('a source archived since the key was minted is dropped, not a re-run failure', async () => {
    const { e, label } = await brain();
    await addSource(e, 'team-b', true);
    await label(['alice-example']);
    expect(await reads(e, 'member-alice-example')).toEqual(['default', 'team-b']);
    await e.executeRaw("UPDATE sources SET archived = true WHERE id = 'team-b'");
    await addSource(e, 'company');
    const r = await label(['alice-example']);
    expect(r.error).toBeUndefined();
    expect(r.keys[0]).toMatchObject({ action: 'keep', adds: ['company'], reads: ['default', 'company'] });
    expect(await reads(e, 'member-alice-example')).toEqual(['default', 'company']);
    await e.disconnect();
  }, 120_000);

  test('a key whose write source is archived is blocked and keeps its write source', async () => {
    const e = await memoryBrain();
    const home = tempDir('gbrain-regrant-');
    const label = () => withEnv({ GBRAIN_HOME: home, GBRAIN_SETUP_ABORT_AFTER: undefined }, () => labelSeveral(e, ['alice-example'], 'team-a', true, true));
    const row = async () => (await e.executeRaw<{ source_id: string; f: string[] }>("SELECT source_id, federated_read AS f FROM access_tokens WHERE name = 'member-alice-example' AND revoked_at IS NULL"))[0]!;
    await addSource(e, 'team-a');
    await label();
    const before = await row();
    expect(before.source_id).toBe('team-a');
    await e.executeRaw("UPDATE sources SET archived = true WHERE id = 'team-a'");
    await addSource(e, 'company');
    const r = await label();
    const after = await row();
    expect(after.source_id).toBe('team-a');
    expect([...after.f]).toEqual([...before.f]);
    expect(r.applied).toBe(false);
    expect(r.keys[0]).toMatchObject({ action: 'blocked' });
    expect(r.keys[0]!.detail).toContain('write source team-a is archived');
    expect(r.keys[0]!.detail).toContain('gbrain auth rescope --token member-alice-example --sources <new write source>');
    expect(r.keys[0]!.detail).toContain('gbrain auth revoke member-alice-example');
    expect(receiptLines(r).find(l => l.includes('alice-example:'))).toContain('BLOCKED');
    await e.disconnect();
  }, 120_000);

  test('a key a released gbrain minted (default grant, no setup_reads) is kept unchanged, never skipped', async () => {
    const { e, label, home } = await brain();
    await addMember(e, 'alice-example');
    const minted = await mintToken(e, 'member-alice-example', { scopes: ['read', 'write'], binding: { member: 'alice-example' } });
    mkdirSync(join(home, '.gbrain', 'member-keys'), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, '.gbrain', 'member-keys', 'alice-example.key'), `${minted.token}\n`, { mode: 0o600 });
    await addSource(e, 'company');
    const r = await label(['alice-example']);
    expect(r.error).toBeUndefined();
    expect(r.keys[0]).toMatchObject({ action: 'keep' });
    expect(r.keys[0]!.adds).toBeUndefined();
    expect((await e.executeRaw<{ g: string }>("SELECT source_grant AS g FROM access_tokens WHERE name = 'member-alice-example' AND revoked_at IS NULL"))[0]!.g).toBe('default');
    await e.disconnect();
  }, 120_000);

  test('a key left as setup minted it still gains new sources on each re-run', async () => {
    const { e, label } = await brain();
    await label(['alice-example']);
    expect(await reads(e, 'member-alice-example')).toEqual(['default']);
    await addSource(e, 'company');
    expect((await label(['alice-example'])).keys[0]).toMatchObject({ action: 'keep', adds: ['company'] });
    await addSource(e, 'team-c', true);
    expect((await label(['alice-example'])).keys[0]).toMatchObject({ action: 'keep', adds: ['team-c'] });
    expect(await reads(e, 'member-alice-example')).toEqual(['default', 'company', 'team-c']);
    await e.disconnect();
  }, 120_000);
  test('GST-4043: a re-run for another source moves a key setup minted to write there, keeping its secret and what it read', async () => {
    const { e, home } = await brain();
    await addSource(e, 'source-a');
    const label = (source: string) => withEnv({ GBRAIN_HOME: home, GBRAIN_SETUP_ABORT_AFTER: undefined }, () => labelSeveral(e, ['alice-example'], source, true, true));
    const row = async () => (await e.executeRaw<{ id: string; token_hash: string; source_id: string }>("SELECT id, token_hash, source_id FROM access_tokens WHERE name = 'member-alice-example' AND revoked_at IS NULL"))[0]!;
    await label('default');
    const before = await row();
    expect(before.source_id).toBe('default');
    const r = await label('source-a');
    expect(r.error).toBeUndefined();
    expect(r.keys[0]).toMatchObject({ action: 'keep', moves: 'default' });
    expect(receiptLines(r).find(l => l.includes('alice-example:'))).toContain('now writes to source-a instead of default');
    const after = await row();
    expect(after).toMatchObject({ id: before.id, token_hash: before.token_hash, source_id: 'source-a' });
    expect(await reads(e, 'member-alice-example')).toEqual(['source-a', 'default']);
    expect((await label('source-a')).keys[0]).toMatchObject({ action: 'keep' });
    expect((await label('source-a')).keys[0]!.moves).toBeUndefined();
    await e.disconnect();
  }, 120_000);

  test('GST-4043: a key writing to another source that setup did not mint with a source list is skipped with its rescope command, never kept as if it wrote here', async () => {
    const e = await memoryBrain();
    const home = tempDir('gbrain-regrant-');
    await addSource(e, 'source-a');
    await addMember(e, 'alice-example');
    const minted = await mintToken(e, 'member-alice-example', { scopes: ['read', 'write'], binding: { member: 'alice-example' } });
    mkdirSync(join(home, '.gbrain', 'member-keys'), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, '.gbrain', 'member-keys', 'alice-example.key'), `${minted.token}\n`, { mode: 0o600 });
    const r = await withEnv({ GBRAIN_HOME: home, GBRAIN_SETUP_ABORT_AFTER: undefined }, () => labelSeveral(e, ['alice-example'], 'source-a', true, true));
    expect(r.keys[0]).toMatchObject({ action: 'skipped' });
    expect(r.keys[0]!.detail).toContain('gbrain auth rescope --token member-alice-example --sources source-a');
    await e.disconnect();
  }, 120_000);
});
