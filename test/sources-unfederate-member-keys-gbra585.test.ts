/**
 * GBRA-585 A: `gbrain sources unfederate <id>` names the member keys that still read the source.
 *
 * 1. Protects: a member key setup mints holds a fixed read list (its write source, `company` and every source federated
 *    at mint time), so unfederating a source no longer takes it away from that key the way it did for an unscoped
 *    key. The unfederate output names each live member-bound key whose list still holds the source, with the
 *    `gbrain auth rescope` command that drops it, on stdout and under --json as keys_still_reading.
 * 2. Fails when: unfederate stays silent about those keys, names a key that no longer holds the source, or prints a
 *    command that keeps the source or loses the key's write source.
 * 3. Existing coverage: setup-company-access.test.ts covers what the minted lists hold, never unfederate.
 * 4. No production seam: the real labelling and sources commands on PGLite, console spies only.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { labelSeveral } from '../src/commands/access-serves.ts';
import { runSources } from '../src/commands/sources.ts';
import { withEnv } from './helpers/with-env.ts';
import { memoryBrain, removeTempDirs, tempDir } from './helpers/setup-serves-box.ts';

let engine: PGLiteEngine;
let home: string;

async function sources(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  const warn = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
  try {
    await runSources(engine, args);
  } finally {
    log.mockRestore();
    warn.mockRestore();
  }
  return { stdout: out.join('\n'), stderr: err.join('\n') };
}

beforeAll(async () => {
  engine = await memoryBrain();
  home = tempDir('gbrain-unfederate-keys-');
  await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('team-b', 'team-b', '{"federated": true}'::jsonb) ON CONFLICT (id) DO NOTHING`);
  await withEnv({ GBRAIN_HOME: home, GBRAIN_SETUP_ABORT_AFTER: undefined }, () => labelSeveral(engine, ['alice-example', 'bob-example'], 'default', true, true));
}, 120_000);

afterAll(async () => {
  await engine?.disconnect();
  removeTempDirs();
});

describe('sources unfederate and the member keys setup minted', () => {
  test('the minted keys hold team-b, and unfederate names each with the rescope command that drops it', async () => {
    const rows = await engine.executeRaw<{ name: string; federated_read: string[] }>("SELECT name, federated_read FROM access_tokens WHERE name LIKE 'member-%' AND revoked_at IS NULL ORDER BY name");
    expect(rows.map(r => [r.name, [...r.federated_read]])).toEqual([['member-alice-example', ['default', 'team-b']], ['member-bob-example', ['default', 'team-b']]]);
    const { stdout } = await sources(['unfederate', 'team-b']);
    expect(stdout).toContain('isolated');
    expect(stdout).toContain('2 member keys still read source team-b');
    expect(stdout).toContain('gbrain auth rescope --token member-alice-example --sources default');
    expect(stdout).toContain('gbrain auth rescope --token member-bob-example --sources default');
  });

  test('--json carries keys_still_reading, and a key rescoped off the source drops out', async () => {
    await engine.executeRaw("UPDATE access_tokens SET federated_read = ARRAY['default']::text[] WHERE name = 'member-bob-example'");
    const { stdout } = await sources(['unfederate', 'team-b', '--json']);
    const doc = JSON.parse(stdout.split('\n').filter(Boolean).pop()!);
    expect(doc.keys_still_reading).toEqual([{ token: 'member-alice-example', member: 'alice-example', command: 'gbrain auth rescope --token member-alice-example --sources default' }]);
  });

  test('federating prints no key list', async () => {
    const { stdout } = await sources(['federate', 'team-b', '--json']);
    expect(JSON.parse(stdout.split('\n').filter(Boolean).pop()!).keys_still_reading).toBeUndefined();
  });
});
