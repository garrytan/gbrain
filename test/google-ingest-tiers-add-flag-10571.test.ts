/**
 * #10571: `gbrain sources add --kind google` takes --ingest-tiers / --no-ingest-tiers, on the managed parser
 * (sources-lifecycle-args.ts, then managedSourceAddInput) and the legacy runAdd (sources.ts, then sources-ops.ts).
 * Fails when: either flag is refused as unknown, an explicit choice is not written as g_ingest_tiers, the stored
 * choice does not read back through parseGoogleSourceConfig, a source added with neither flag gets the key (an
 * existing user's config shape would change), or the flags pass on a non-Google kind or together.
 * Synthetic accounts only (alice@example.com).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { runSources } from '../src/commands/sources.ts';
import { parseSourceLifecycleArgs } from '../src/commands/sources-lifecycle-args.ts';
import { managedSourceAddInput } from '../src/core/persistence/managed-sources.ts';
import { parseGoogleSourceConfig } from '../src/core/google/source-config.ts';
import type { AddSourceOpts } from '../src/core/sources-ops.ts';

const account = ['--account', 'alice@example.com'];
const managed = (...flags: string[]) => {
  const parsed = parseSourceLifecycleArgs(['add', 'mail', '--kind', 'google', ...account, '--dir', mkdtempSync(join(tmpdir(), 'gbrain-10571-')), ...flags]);
  const options = parsed.params.options as AddSourceOpts;
  const { config } = managedSourceAddInput(options);
  return { options, config: config as Record<string, unknown>, tiers: parseGoogleSourceConfig(config as Record<string, unknown>, '/unused').ingestTiers === true };
};

describe('managed sources add --kind google ingest tiers (#10571)', () => {
  test('--ingest-tiers turns tiers on for a vault source', () => {
    const added = managed('--ingest-tiers');
    expect(added.options.google?.ingestTiers).toBe(true);
    expect(added.config.g_ingest_tiers).toBe(true);
    expect(added.tiers).toBe(true);
  });

  test('--no-ingest-tiers turns tiers off for a gbrainio source', () => {
    const added = managed('--access', 'gbrainio', '--no-ingest-tiers');
    expect(added.config.g_ingest_tiers).toBe(false);
    expect(added.tiers).toBe(false);
  });

  test('with neither flag the config has no g_ingest_tiers key and each access mode keeps its default', () => {
    const vault = managed();
    expect('g_ingest_tiers' in vault.config).toBe(false);
    expect(vault.tiers).toBe(false);
    const gbrainio = managed('--access', 'gbrainio');
    expect('g_ingest_tiers' in gbrainio.config).toBe(false);
    expect(gbrainio.tiers).toBe(true);
  });

  test('both flags, or either flag on another kind or with no kind, refuse as invalid_params', () => {
    expect(() => managed('--ingest-tiers', '--no-ingest-tiers')).toThrow(expect.objectContaining({ code: 'invalid_params' }));
    expect(() => parseSourceLifecycleArgs(['add', 'repo', '--kind', 'github', '--repos', 'acme-example/app', '--ingest-tiers'])).toThrow(expect.objectContaining({ code: 'invalid_params' }));
    expect(() => parseSourceLifecycleArgs(['add', 'notes', '--path', '/tmp/notes', '--no-ingest-tiers'])).toThrow(expect.objectContaining({ code: 'invalid_params' }));
    expect(() => parseSourceLifecycleArgs(['add', 'mail', '--kind', 'google', ...account, '--ingest-tiers=yes'])).toThrow(expect.objectContaining({ code: 'invalid_params' }));
  });
});

describe('legacy sources add --kind google ingest tiers (#10571)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => { await resetPgliteState(engine); });

  function seedVault(home: string): void {
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'credentials.json'), JSON.stringify({ version: 1, clients: [], credentials: { 'google:alice@example.com': {
      id: 'google:alice@example.com', provider: 'google', kind: 'oauth2', client_ref: 'byo',
      secret: { access_token: 't', refresh_token: 'r', expiry: new Date(Date.now() + 3_600_000).toISOString() },
      meta: { account: 'alice@example.com', connected_at: new Date().toISOString() } } } }), { mode: 0o600 });
  }

  async function add(id: string, args: string[]): Promise<{ exit: number | undefined; err: string }> {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-10571-home-'));
    seedVault(home);
    const log = console.log, error = console.error, exit = process.exit, write = process.stderr.write.bind(process.stderr);
    const err: string[] = [];
    let code: number | undefined;
    console.log = () => {};
    console.error = (...a: unknown[]) => { err.push(a.map(String).join(' ')); };
    process.stderr.write = ((chunk: string | Uint8Array) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
    process.exit = ((c?: number) => { code = c ?? 0; throw new Error('__exit__'); }) as typeof process.exit;
    try {
      await withEnv({ GBRAIN_HOME: home }, () => runSources(engine, ['add', id, ...args]));
    } catch (e) {
      if ((e as Error).message !== '__exit__') throw e;
    } finally {
      console.log = log; console.error = error; process.exit = exit; process.stderr.write = write;
    }
    return { exit: code, err: err.join('\n') };
  }

  async function config(id: string): Promise<Record<string, unknown> | null> {
    const [row] = await engine.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id=$1', [id]);
    if (!row) return null;
    return typeof row.config === 'string' ? JSON.parse(row.config) : row.config as Record<string, unknown>;
  }

  test('--ingest-tiers stores g_ingest_tiers true and reads back as tiers on', async () => {
    const result = await add('gtiers', ['--kind', 'google', ...account, '--ingest-tiers']);
    expect(result.exit).toBeUndefined();
    const stored = (await config('gtiers'))!;
    expect(stored.g_ingest_tiers).toBe(true);
    expect(parseGoogleSourceConfig(stored, '/unused').ingestTiers).toBe(true);
  });

  test('with neither flag the stored config has no g_ingest_tiers key', async () => {
    const result = await add('gplain', ['--kind', 'google', ...account]);
    expect(result.exit).toBeUndefined();
    expect('g_ingest_tiers' in (await config('gplain'))!).toBe(false);
  });

  test('both flags, or a flag without --kind google, exit 2 and register nothing', async () => {
    const both = await add('gboth', ['--kind', 'google', ...account, '--ingest-tiers', '--no-ingest-tiers']);
    expect(both.exit).toBe(2);
    expect(both.err).toContain('not both');
    expect(await config('gboth')).toBeNull();
    const github = await add('gh-tiers', ['--kind', 'github', '--repos', 'acme-example/app', '--no-ingest-tiers']);
    expect(github.exit).toBe(2);
    expect(github.err).toContain('requires --kind google');
    expect(await config('gh-tiers')).toBeNull();
  });
});
