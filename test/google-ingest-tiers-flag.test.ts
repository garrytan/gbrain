/**
 * Value: protects=sources add accepts one Google ingest-tier flag and retains the access default when neither is passed; fails_when=CLI validation, parsing or config serialization drops an opt-in or opt-out, writes an implicit override, or admits a conflicting or misplaced flag; why_new=existing tests read stored overrides but do not pass them through sources add; seam=exit and console spies on legacy refusals; no_claim=Gmail sync behavior
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { validateCommandFlags } from '../src/cli/flag-validation.ts';
import { parseSourceLifecycleArgs } from '../src/commands/sources-lifecycle-args.ts';
import { runSources } from '../src/commands/sources.ts';
import { googleTuningConfig, parseGoogleSourceConfig } from '../src/core/google/source-config.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { AddSourceOpts } from '../src/core/sources-ops.ts';

const googleAdd = ['add', 'mail', '--kind', 'google', '--account', 'alice@example.com'];
const githubAdd = ['add', 'issues', '--kind', 'github'];
const tiersFlags = ['--ingest-tiers', '--no-ingest-tiers'];

function parseGoogleAdd(...flags: string[]) {
  const { params } = parseSourceLifecycleArgs([...googleAdd, ...flags]);
  return (params.options as AddSourceOpts).google!;
}

function googleConfig(google: NonNullable<AddSourceOpts['google']>) {
  return { g_account: google.account, g_services: google.services.join(','), g_access: google.access, ...googleTuningConfig(google) };
}

describe('sources add Gmail ingest tiers', () => {
  test.each(tiersFlags)('the CLI validator accepts %s', (flag) => {
    expect(validateCommandFlags('sources', [...googleAdd, flag])).toBeNull();
  });

  test('--ingest-tiers reaches the vault source config as true', () => {
    const google = parseGoogleAdd('--ingest-tiers');
    expect(google.ingestTiers).toBe(true);
    const config = googleConfig(google);
    expect(config).toHaveProperty('g_ingest_tiers', true);
    expect(parseGoogleSourceConfig(config, google.dir).ingestTiers).toBe(true);
  });

  test('--no-ingest-tiers reaches gbrainio as false and turns tiers off', () => {
    const google = parseGoogleAdd('--access', 'gbrainio', '--no-ingest-tiers');
    expect(google.ingestTiers).toBe(false);
    const config = googleConfig(google);
    expect(config).toHaveProperty('g_ingest_tiers', false);
    expect(parseGoogleSourceConfig(config, google.dir).ingestTiers).toBeUndefined();
  });

  test('no flag omits the key and keeps the vault and gbrainio defaults', () => {
    const vault = parseGoogleAdd();
    expect(vault).not.toHaveProperty('ingestTiers');
    expect(googleTuningConfig(vault)).not.toHaveProperty('g_ingest_tiers');
    expect(parseGoogleSourceConfig(googleConfig(vault), vault.dir).ingestTiers).toBeUndefined();

    const relay = parseGoogleAdd('--access', 'gbrainio');
    expect(relay).not.toHaveProperty('ingestTiers');
    expect(googleTuningConfig(relay)).not.toHaveProperty('g_ingest_tiers');
    expect(parseGoogleSourceConfig(googleConfig(relay), relay.dir).ingestTiers).toBe(true);
  });

  test('the managed parser refuses both flags together', () => {
    expect(() => parseGoogleAdd(...tiersFlags)).toThrow('Choose one Gmail ingest tier setting.');
  });

  test.each(tiersFlags)('the managed parser refuses %s on a GitHub source', (flag) => {
    expect(() => parseSourceLifecycleArgs([...githubAdd, flag])).toThrow(`${flag} requires --kind google.`);
  });
});

describe('legacy sources add Gmail ingest tiers', () => {
  test('refuses both flags before source creation', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    const error = spyOn(console, 'error').mockImplementation(() => {});
    const exit = spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    try {
      await expect(runSources(engine, [...googleAdd, ...tiersFlags])).rejects.toThrow('process.exit');
      expect(exit).toHaveBeenCalledWith(2);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('Pass either --ingest-tiers or --no-ingest-tiers, not both.'));
    } finally {
      exit.mockRestore();
      error.mockRestore();
      await engine.disconnect();
    }
  });
});
