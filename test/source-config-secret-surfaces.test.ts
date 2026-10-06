/**
 * Behavioral secret-exposure contract for every surface that reads and
 * serializes `sources.config` (source-config security audit; audited surface
 * list lives in the header of scripts/check-source-config-leak.sh).
 *
 * Each test stores a secret-bearing config (`webhook_secret`, the only
 * secret-valued key in SECRET_KEYS) and drives the real surface: the
 * `gbrain sources` CLI, `gbrain call`, MCP source operations for remote
 * callers, `doctor --json`, managed source administration and its retained
 * receipts, and parse warnings. The secret must never appear in their
 * output. The two intentional reveals, `sources webhook set` and
 * `sources webhook rotate`, must print the NEW secret exactly once.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import type { AuthInfo, OperationContext } from '../src/core/operations.ts';
import { runSources } from '../src/commands/sources.ts';
import { runCall } from '../src/commands/call.ts';
import { runDoctor } from '../src/commands/doctor.ts';
import { setCliOptions } from '../src/core/cli-options.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { runManagedSourceLifecycle } from '../src/core/persistence/source-lifecycle.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let home: string;
let secret: string;

const HOOKED = 'hooked';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  setCliOptions({ quiet: true, progressJson: false, progressInterval: 1000, explain: false, timeoutMs: null, brain: null });
}, 60_000);

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  secret = `whsec-sentinel-${randomUUID()}`;
});

function freshHome(): string {
  home = mkdtempSync(join(tmpdir(), 'gbrain-source-secret-'));
  return home;
}

async function inHome<T>(fn: () => Promise<T>): Promise<T> {
  const dir = freshHome();
  try {
    return await withEnv({ GBRAIN_HOME: dir, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_SOURCE: undefined }, fn);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function insertSource(id: string, localPath: string | null, config: unknown): Promise<void> {
  await engine.executeRaw(
    'INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, $3::text::jsonb)',
    [id, localPath, JSON.stringify(config)],
  );
}

function hookedConfig(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { federated: true, github_repo: 'acme-example/brain', tracked_branch: 'main', webhook_secret: secret, ...extra };
}

function gitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const git = (args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t.co']);
  git(['config', 'user.name', 't']);
  writeFileSync(join(dir, 'note.md'), '# Note\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);
  return dir;
}

/** Capture everything the CLI writes to console.* and treat process.exit as a throw. */
async function captureCli(fn: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const saved = { log: console.log, error: console.error, warn: console.warn, info: console.info, exit: process.exit };
  const sink = (...args: unknown[]) => { lines.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  console.log = sink; console.error = sink; console.warn = sink; console.info = sink;
  (process as { exit: unknown }).exit = ((code?: number) => { throw new Error(`__exit ${code ?? 0}`); }) as unknown as typeof process.exit;
  try {
    await fn();
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith('__exit'))) throw error;
  } finally {
    console.log = saved.log; console.error = saved.error; console.warn = saved.warn; console.info = saved.info;
    (process as { exit: unknown }).exit = saved.exit;
    _resetCliExitVerdictForTests();
    process.exitCode = 0;
  }
  return lines.join('\n');
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

function remoteCtx(allowedSources: string[], scopes = ['read', 'admin']): OperationContext {
  const auth: AuthInfo = {
    token: 'gbrain_at_fixture', clientId: 'gbrain_cl_fixture', clientName: 'fixture-client',
    scopes, expiresAt: Math.floor(Date.now() / 1000) + 3600, allowedSources,
  };
  return {
    engine, config: { engine: 'pglite' } as OperationContext['config'],
    logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: true, auth, sourceId: allowedSources[0],
  };
}

function op(name: string) {
  const found = operations.find(o => o.name === name);
  if (!found) throw new Error(`op not found: ${name}`);
  return found;
}

describe('sources CLI output never contains a stored webhook secret', () => {
  test('list, status, webhook show, current, archived and remove --dry-run', () => inHome(async () => {
    const dir = gitRepo(join(home, 'repo'));
    await insertSource(HOOKED, dir, hookedConfig());
    await insertSource('parked', null, hookedConfig());
    await runSources(engine, ['archive', 'parked']);
    const output = await captureCli(async () => {
      for (const args of [
        ['list'], ['list', '--json'], ['status'], ['status', '--json'],
        ['webhook', 'show', HOOKED], ['current', '--source', HOOKED, '--json'],
        ['archived'], ['archived', '--json'], ['remove', HOOKED, '--dry-run'],
      ]) await runSources(engine, args);
    });
    expect(output).toContain(HOOKED);
    expect(output).toContain('<set — use `webhook rotate` to reveal a new one>');
    expect(output).not.toContain(secret);
  }), 60_000);

  test('a re-wrapped config warns without echoing its secret', () => inHome(async () => {
    await engine.executeRaw(
      'INSERT INTO sources (id, name, config) VALUES ($1, $1, to_jsonb($2::text))',
      [HOOKED, JSON.stringify(JSON.stringify(hookedConfig()))],
    );
    const output = await captureCli(async () => {
      await runSources(engine, ['list', '--json']);
      await runSources(engine, ['webhook', 'show', HOOKED]);
    });
    expect(output).toContain('source config was stored as a');
    expect(output).not.toContain(secret);
  }), 60_000);
});

describe('intentional one-time reveals', () => {
  test('webhook set prints the new secret exactly once', () => inHome(async () => {
    await insertSource(HOOKED, null, { federated: true });
    const output = await captureCli(() => runSources(engine, ['webhook', 'set', HOOKED, '--github-repo', 'acme-example/brain']));
    const [row] = await engine.executeRaw<{ secret: string }>("SELECT config->>'webhook_secret' AS secret FROM sources WHERE id = $1", [HOOKED]);
    expect(row.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(occurrences(output, row.secret)).toBe(1);
    expect(output).toContain(`Secret:       ${row.secret}`);
    const later = await captureCli(async () => {
      await runSources(engine, ['webhook', 'show', HOOKED]);
      await runSources(engine, ['list', '--json']);
    });
    expect(later).not.toContain(row.secret);
  }), 60_000);

  test('webhook rotate prints only the new secret, exactly once', () => inHome(async () => {
    await insertSource(HOOKED, null, hookedConfig());
    const output = await captureCli(() => runSources(engine, ['webhook', 'rotate', HOOKED]));
    const [row] = await engine.executeRaw<{ secret: string }>("SELECT config->>'webhook_secret' AS secret FROM sources WHERE id = $1", [HOOKED]);
    expect(row.secret).not.toBe(secret);
    expect(occurrences(output, row.secret)).toBe(1);
    expect(output).not.toContain(secret);
  }), 60_000);
});

describe('operation surfaces never return a stored webhook secret', () => {
  test('gbrain call sources_add attaching a path to a secret-bearing source', () => inHome(async () => {
    const dir = gitRepo(join(home, 'attach'));
    await insertSource(HOOKED, null, hookedConfig());
    let printed = '';
    await runCall(engine, ['sources_add', JSON.stringify({ id: HOOKED, path: dir })], async (payload) => { printed += payload; });
    const result = JSON.parse(printed);
    expect(result.local_path).toBe(dir);
    expect(result.config.webhook_secret).toBe('<redacted>');
    expect(result.config.github_repo).toBe('acme-example/brain');
    expect(printed).not.toContain(secret);
    const [stored] = await engine.executeRaw<{ secret: string }>("SELECT config->>'webhook_secret' AS secret FROM sources WHERE id = $1", [HOOKED]);
    expect(stored.secret).toBe(secret);
  }), 60_000);

  test('remote MCP sources_list, sources_status and get_status_snapshot', () => inHome(async () => {
    await insertSource(HOOKED, null, hookedConfig());
    const ctx = remoteCtx([HOOKED]);
    const listed = await op('sources_list').handler(ctx, {});
    expect(JSON.stringify(listed)).toContain(HOOKED);
    const payloads = [
      listed,
      await op('sources_status').handler(ctx, { id: HOOKED }),
      await op('get_status_snapshot').handler(ctx, {}),
    ];
    for (const payload of payloads) expect(JSON.stringify(payload)).not.toContain(secret);
  }), 60_000);

  test('local doctor --json and remote run_doctor', () => inHome(async () => {
    await insertSource(HOOKED, null, hookedConfig());
    const output = await captureCli(() => runDoctor(engine, ['--json']));
    expect(output).toContain('"source_config_shape"');
    expect(output).not.toContain(secret);
    const remote = JSON.stringify(await op('run_doctor').handler(remoteCtx([HOOKED]), {}));
    expect(remote).toContain('federation_health');
    expect(remote).not.toContain(secret);
  }), 120_000);
});

describe('managed source administration never returns or retains a stored webhook secret', () => {
  test('attaching a path returns and replays a redacted receipt', () => inHome(async () => {
    await registerLocalWriter(engine, 'cli');
    const owned = join(home, 'owned');
    mkdirSync(owned);
    writeFileSync(join(owned, 'note.md'), '---\ntitle: Note\ntype: note\n---\n\nOwned\n');
    await insertSource('owned', owned, {});
    await claimWorktree(engine, 'owned', owned);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    await engine.executeRaw("SELECT set_config('gbrain.topology_change','on',false)");
    await insertSource(HOOKED, null, hookedConfig());
    await engine.executeRaw("SELECT set_config('gbrain.topology_change','off',false)");
    const dir = join(home, 'attach');
    mkdirSync(dir);
    writeFileSync(join(dir, 'note.md'), '# Note\n');
    const requestId = randomUUID();
    const result = await runManagedSourceLifecycle(engine, { operation: 'add', sourceId: HOOKED, path: dir, requestId });
    expect(result.state).toBe('committed');
    expect((result.config as Record<string, unknown>).webhook_secret).toBe('<redacted>');
    const replayed = await runManagedSourceLifecycle(engine, { operation: 'add', sourceId: HOOKED, path: dir, requestId });
    const viaAdministration = await runPersistenceAdministration(engine, 'source_lifecycle', { action: 'add', source_id: HOOKED, path: dir, request_id: requestId });
    const journal = await engine.executeRaw('SELECT * FROM persistence_topology_changes');
    for (const payload of [result, replayed, viaAdministration, journal]) expect(JSON.stringify(payload)).not.toContain(secret);
    const [stored] = await engine.executeRaw<{ secret: string }>("SELECT config->>'webhook_secret' AS secret FROM sources WHERE id = $1", [HOOKED]);
    expect(stored.secret).toBe(secret);
    for (const file of filesUnder(home)) {
      if (file.endsWith('.jsonl') || file.endsWith('.log')) expect(readFileSync(file, 'utf8')).not.toContain(secret);
    }
  }), 60_000);
});
