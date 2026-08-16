/**
 * v0.46.3 orchestrator — ZeroEntropy sunset notice (detect-and-notify only).
 *
 * Contract pins (registry shape mirrors migration-orchestrator-v0_21_0):
 *  - registered in the TS registry, correctly ordered after 0.43.0;
 *  - the orchestrator NEVER writes config (no pinning — the split-default
 *    made pinning unnecessary) and NEVER invokes migrate embeddings;
 *  - exposed brain → notice + ONE idempotent pending-host-work entry
 *    (re-run appends nothing);
 *  - dry-run takes no side effects (no pending-host-work write);
 *  - no config at all → complete, no nag;
 *  - unknown/unreachable-brain exposure → still `complete` (NOT partial —
 *    three partials would wedge the migration chain behind --force-retry).
 *
 * Serial: sandboxes GBRAIN_HOME + clears GBRAIN_EMBEDDING_* env.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let home: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'GBRAIN_HOME',
  'GBRAIN_EMBEDDING_MODEL',
  'GBRAIN_EMBEDDING_DIMENSIONS',
  'VOYAGE_API_KEY',
  'DATABASE_URL',
  'GBRAIN_DATABASE_URL',
];

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  home = mkdtempSync(join(tmpdir(), 'v047-mig-'));
  process.env.GBRAIN_HOME = home;
  delete process.env.GBRAIN_EMBEDDING_MODEL;
  delete process.env.GBRAIN_EMBEDDING_DIMENSIONS;
  delete process.env.VOYAGE_API_KEY;
  delete process.env.DATABASE_URL;
  delete process.env.GBRAIN_DATABASE_URL;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// GBRAIN_HOME is a HOME-like root: gbrain resolves its dir as
// `$GBRAIN_HOME/.gbrain/` (see configDir() in src/core/config.ts).
function gbrainDir(): string {
  return join(home, '.gbrain');
}

function writeZeConfig(): string {
  mkdirSync(gbrainDir(), { recursive: true });
  const cfgPath = join(gbrainDir(), 'config.json');
  writeFileSync(
    cfgPath,
    JSON.stringify(
      {
        engine: 'pglite',
        database_path: join(gbrainDir(), 'brain'),
        embedding_model: 'zeroentropyai:zembed-1',
        embedding_dimensions: 1280,
      },
      null,
      2,
    ),
  );
  return cfgPath;
}

function pendingPath(): string {
  return join(gbrainDir(), 'migrations', 'pending-host-work.jsonl');
}

function pendingEntries(): Array<{ migration: string }> {
  if (!existsSync(pendingPath())) return [];
  return readFileSync(pendingPath(), 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

describe('v0.46.3 registry contract', () => {
  test('registered, ordered after 0.43.0, pitch names the sunset', async () => {
    const { migrations, getMigration } = await import('../src/commands/migrations/index.ts');
    const versions = migrations.map((m) => m.version);
    expect(versions).toContain('0.46.3');
    expect(versions.indexOf('0.46.3')).toBeGreaterThan(versions.indexOf('0.43.0'));
    const m = getMigration('0.46.3');
    expect(m).not.toBeNull();
    expect(m!.featurePitch.headline).toContain('2026-09-04');
    expect(m!.featurePitch.headline).toContain('Voyage');
    expect(m!.featurePitch.description ?? '').toContain('migrate embeddings --to voyage:voyage-4');
    expect(typeof m!.orchestrator).toBe('function');
  });
});

describe('v0.46.3 orchestrator behavior', () => {
  test('no config at all → complete, no nag, no host-work file', async () => {
    const { v0_46_3 } = await import('../src/commands/migrations/v0_46_3.ts');
    const result = await v0_46_3.orchestrator({ yes: true, dryRun: false, noAutopilotInstall: true });
    expect(result.status).toBe('complete');
    expect(result.phases.some((p) => p.detail?.includes('no brain configured'))).toBe(true);
    expect(existsSync(pendingPath())).toBe(false);
  });

  test('exposed ZE brain → notice + one host-work entry; NO config writes; idempotent re-run', async () => {
    const cfgPath = writeZeConfig();
    const before = readFileSync(cfgPath, 'utf-8');
    const { v0_46_3 } = await import('../src/commands/migrations/v0_46_3.ts');

    const first = await v0_46_3.orchestrator({ yes: true, dryRun: false, noAutopilotInstall: true });
    expect(first.status).toBe('complete');
    expect(first.pending_host_work).toBe(1);
    expect(pendingEntries().filter((e) => e.migration === '0.46.3').length).toBe(1);

    // Detect-and-notify ONLY: the config file is byte-identical afterwards.
    expect(readFileSync(cfgPath, 'utf-8')).toBe(before);

    const second = await v0_46_3.orchestrator({ yes: true, dryRun: false, noAutopilotInstall: true });
    expect(second.status).toBe('complete');
    expect(pendingEntries().filter((e) => e.migration === '0.46.3').length).toBe(1);
    expect(second.phases.some((p) => p.detail === 'already recorded')).toBe(true);
  }, 120_000);

  test('dry-run on an exposed brain takes no side effects', async () => {
    writeZeConfig();
    const { v0_46_3 } = await import('../src/commands/migrations/v0_46_3.ts');
    const result = await v0_46_3.orchestrator({ yes: true, dryRun: true, noAutopilotInstall: true });
    expect(result.status).toBe('complete');
    expect(existsSync(pendingPath())).toBe(false);
    expect(result.phases.some((p) => p.name === 'host-work' && p.status === 'skipped')).toBe(true);
  }, 120_000);

  test('unreachable brain (bad database_url) → complete with fail-safe nag, never partial', async () => {
    mkdirSync(gbrainDir(), { recursive: true });
    writeFileSync(
      join(gbrainDir(), 'config.json'),
      JSON.stringify({
        engine: 'postgres',
        // Credential-free on purpose: port 1 refuses connections, which is
        // all this fixture needs (a user:pass URL trips the push-time
        // secret-scan guardrail even when synthetic).
        database_url: 'postgres://127.0.0.1:1/void',
        embedding_model: 'voyage:voyage-4',
      }),
    );
    const { v0_46_3 } = await import('../src/commands/migrations/v0_46_3.ts');
    const result = await v0_46_3.orchestrator({ yes: true, dryRun: false, noAutopilotInstall: true });
    // A clear-by-config brain whose probes can't run is UNKNOWN → complete
    // (no chain wedge) + host-work nag (fail-safe).
    expect(result.status).toBe('complete');
    expect(pendingEntries().filter((e) => e.migration === '0.46.3').length).toBe(1);
  }, 120_000);
});
