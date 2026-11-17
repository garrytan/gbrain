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
import { withEnv } from './helpers/with-env.ts';
import { memoryBrain, removeTempDirs, tempDir } from './helpers/setup-serves-box.ts';

afterAll(removeTempDirs);

const reads = async (e: PGLiteEngine, name: string) => [...((await e.executeRaw<{ f: string[] }>('SELECT federated_read AS f FROM access_tokens WHERE name = $1 AND revoked_at IS NULL', [name]))[0]?.f ?? [])];
const addSource = (e: PGLiteEngine, id: string, federated = false) => e.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, $2::jsonb)`, [id, JSON.stringify(federated ? { federated: true } : {})]);
async function brain() {
  const e = await memoryBrain();
  const home = tempDir('gbrain-regrant-');
  const label = (roster: string[]) => withEnv({ GBRAIN_HOME: home, GBRAIN_SETUP_ABORT_AFTER: undefined }, () => labelSeveral(e, roster, 'default', true, true));
  return { e, label };
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
});
