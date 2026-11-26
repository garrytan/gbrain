/**
 * #10094: `loops.owner_addresses` parsing, and `gbrain config set` refusing a value Gmail sync could not read.
 * The sweep behaviour (no loop from an owner mailbox, a reply from one closes the loop) lives in
 * test/google-source-materialize.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { parseLoopOwnerAddresses, validateLoopOwnerAddressesConfigValue } from '../src/core/google/loops-owner-addresses.ts';
import { runCli } from './helpers/cli-spawn.ts';

describe('#10094 parseLoopOwnerAddresses', () => {
  test('accepts comma, semicolon and newline lists and JSON arrays, bare or Name <address>, lowercased and deduplicated', () => {
    expect(parseLoopOwnerAddresses('me@example.net, Me Other <ME@Example.org>; me@example.net')).toEqual(['me@example.net', 'me@example.org']);
    expect(parseLoopOwnerAddresses('me@example.net\nother@example.org\n')).toEqual(['me@example.net', 'other@example.org']);
    expect(parseLoopOwnerAddresses('["me@example.net", "Other <other@example.org>"]')).toEqual(['me@example.net', 'other@example.org']);
  });

  test('empty or unset means no extra addresses', () => {
    expect(parseLoopOwnerAddresses(null)).toEqual([]);
    expect(parseLoopOwnerAddresses('   ')).toEqual([]);
    expect(parseLoopOwnerAddresses('[]')).toEqual([]);
  });

  test('anything that is not a mailbox is refused as a whole', () => {
    expect(parseLoopOwnerAddresses('me@example.net, not-an-address')).toBeNull();
    expect(parseLoopOwnerAddresses('["me@example.net", 7]')).toBeNull();
    expect(parseLoopOwnerAddresses('{"a":"me@example.net"}')).toBeNull();
    expect(parseLoopOwnerAddresses('[me@example.net')).toBeNull();
  });

  test('the config-set validator only judges its own key', () => {
    expect(validateLoopOwnerAddressesConfigValue('loops.owner_addresses', 'nope')).toContain('Nothing was written');
    expect(validateLoopOwnerAddressesConfigValue('loops.owner_addresses', 'me@example.net')).toBeNull();
    expect(validateLoopOwnerAddressesConfigValue('loops.extract_max_usd_per_day', 'nope')).toBeNull();
  });
});

describe('#10094 gbrain config set loops.owner_addresses', () => {
  let home: string;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-owner-addresses-'));
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    const dbPath = join(home, '.gbrain', 'brain.pglite');
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: dbPath, embedding_dimensions: 1536 }) + '\n');
    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dbPath });
    await engine.initSchema();
    await engine.disconnect();
  }, 240_000);

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('a malformed value is refused and nothing is written; a valid list is stored as given', async () => {
    const env = { GBRAIN_BRAIN_ID: '', GBRAIN_SOURCE: '' };
    const bad = await runCli(['config', 'set', 'loops.owner_addresses', 'me@example.net, not-an-address'], { home, env, timeoutMs: 120_000 });
    expect(bad.exitCode).not.toBe(0);
    expect(bad.stderr).toContain('loops.owner_addresses must be a comma-separated list of email addresses');
    const unset = await runCli(['config', 'get', 'loops.owner_addresses'], { home, env, timeoutMs: 120_000 });
    expect(unset.stdout.trim()).not.toContain('not-an-address');

    const good = await runCli(['config', 'set', 'loops.owner_addresses', 'me@example.net, Me <me@example.org>'], { home, env, timeoutMs: 120_000 });
    expect(good.stderr).not.toContain('Unknown config key');
    expect(good.exitCode).toBe(0);
    const get = await runCli(['config', 'get', 'loops.owner_addresses'], { home, env, timeoutMs: 120_000 });
    expect(get.exitCode).toBe(0);
    expect(get.stdout.trim()).toBe('me@example.net, Me <me@example.org>');
  }, 240_000);
});
