/**
 * Value: protects=sources add accepts one Google ingest-tier flag and retains the access default when neither is passed; fails_when=CLI validation, parsing or config serialization drops an opt-in or opt-out, writes an implicit override, or admits a conflicting or misplaced flag; why_new=existing tests read stored overrides but do not pass them through sources add; seam=exit and console spies on legacy refusals; no_claim=Gmail sync behavior
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCommandFlags } from '../src/cli/flag-validation.ts';
import { parseSourceLifecycleArgs } from '../src/commands/sources-lifecycle-args.ts';
import { runSources } from '../src/commands/sources.ts';
import { googleTuningConfig, parseGoogleSourceConfig } from '../src/core/google/source-config.ts';
import { managedSourceAddInput } from '../src/core/persistence/managed-sources.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { AddSourceOpts } from '../src/core/sources-ops.ts';

const googleAdd = ['add', 'mail', '--kind', 'google', '--account', 'alice@example.com'];
const githubAdd = ['add', 'issues', '--kind', 'github'];
const tiersFlags = ['--ingest-tiers', '--no-ingest-tiers'];

function parseGoogleAdd(...flags: string[]) {
  const { params } = parseSourceLifecycleArgs([...googleAdd, ...flags]);
  const opts = params.options as AddSourceOpts;
  return { google: opts.google!, config: managedSourceAddInput(opts).config! };
}

describe('sources add Gmail ingest tiers', () => {
  test.each(tiersFlags)('the CLI validator accepts %s', (flag) => {
    expect(validateCommandFlags('sources', [...googleAdd, flag])).toBeNull();
  });

  test('--ingest-tiers reaches the vault source config as true', () => {
    const { google, config } = parseGoogleAdd('--ingest-tiers');
    expect(google.ingestTiers).toBe(true);
    expect(config).toHaveProperty('g_ingest_tiers', true);
    expect(parseGoogleSourceConfig(config, google.dir).ingestTiers).toBe(true);
  });

  test('--no-ingest-tiers reaches gbrainio as false and turns tiers off', () => {
    const { google, config } = parseGoogleAdd('--access', 'gbrainio', '--no-ingest-tiers');
    expect(google.ingestTiers).toBe(false);
    expect(config).toHaveProperty('g_ingest_tiers', false);
    expect(parseGoogleSourceConfig(config, google.dir).ingestTiers).toBeUndefined();
  });

  test('no flag omits the key and keeps the vault and gbrainio defaults', () => {
    const { google: vault, config: vaultConfig } = parseGoogleAdd();
    expect(vault).not.toHaveProperty('ingestTiers');
    expect(googleTuningConfig(vault)).not.toHaveProperty('g_ingest_tiers');
    expect(vaultConfig).not.toHaveProperty('g_ingest_tiers');
    expect(parseGoogleSourceConfig(vaultConfig, vault.dir).ingestTiers).toBeUndefined();

    const { google: relay, config: relayConfig } = parseGoogleAdd('--access', 'gbrainio');
    expect(relay).not.toHaveProperty('ingestTiers');
    expect(googleTuningConfig(relay)).not.toHaveProperty('g_ingest_tiers');
    expect(relayConfig).not.toHaveProperty('g_ingest_tiers');
    expect(parseGoogleSourceConfig(relayConfig, relay.dir).ingestTiers).toBe(true);
  });

  test('the managed parser refuses both flags together', () => {
    expect(() => parseGoogleAdd(...tiersFlags)).toThrow('Choose one Gmail ingest tier setting.');
  });

  test.each(tiersFlags)('the managed parser refuses %s on a GitHub source', (flag) => {
    expect(() => parseSourceLifecycleArgs([...githubAdd, flag])).toThrow(`${flag} requires --kind google.`);
  });
});

describe('legacy sources add Gmail ingest tiers', () => {
  test('stores true with --ingest-tiers and omits the key without it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-ingest-tiers-'));
    const engine = new PGLiteEngine();
    try {
      await engine.connect({});
      await engine.initSchema();
      const args = ['--kind', 'google', '--account', 'alice@example.invalid', '--services', 'gmail',
        '--access', 'env', '--token-env', 'SOME_FAKE_VAR'];
      await runSources(engine, ['add', 'mail-default', ...args, '--dir', join(dir, 'default')]);
      await runSources(engine, ['add', 'mail-on', ...args, '--dir', join(dir, 'on'), '--ingest-tiers']);
      const [defaultRow, enabledRow] = await engine.executeRaw<{ id: string; config: Record<string, unknown> }>(
        'SELECT id, config FROM sources WHERE id IN ($1, $2) ORDER BY id', ['mail-default', 'mail-on'],
      );
      expect(defaultRow?.id).toBe('mail-default');
      expect(defaultRow.config).not.toHaveProperty('g_ingest_tiers');
      expect(enabledRow?.id).toBe('mail-on');
      expect(enabledRow.config.g_ingest_tiers).toBe(true);
    } finally {
      await engine.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses --ingest-tiers without --kind google', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    const error = spyOn(console, 'error').mockImplementation(() => {});
    const exit = spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit'); });
    try {
      await expect(runSources(engine, ['add', 'mail', '--ingest-tiers'])).rejects.toThrow('process.exit');
      expect(exit).toHaveBeenCalledWith(2);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('requires --kind google'));
    } finally {
      exit.mockRestore();
      error.mockRestore();
      await engine.disconnect();
    }
  });

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
