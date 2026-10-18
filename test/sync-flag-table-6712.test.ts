/**
 * #6712 PR 2 (L3): every `gbrain sync` flag is classified once, in `SYNC_FLAGS` (src/core/sync-flags.ts). The serve
 * ladder, its wire validator and the PGLite owner lane derive their allowlists from it.
 *
 * Protects:
 *   - every flag the sync argv parsers read is in the table, and every table flag is in the generated flag registry;
 *   - the three hand-offs agree with the table (a flag the table forwards is forwarded by each, one it routes to the
 *     client is accepted and never sent, everything else refuses);
 *   - a retired wire field (src/core/wire-skew.ts) is never sent by a newer client, and a newer resident accepts it
 *     from an older one, drops it and prints one notice naming it, on both hand-offs;
 *   - the PGLite owner lane accepts `--lanes N` and `--no-lanes` (it used to refuse them) without sending them.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type net from 'node:net';
import { SYNC_FLAGS, syncFlagsRouted, syncWireFields, type SyncFlagSpec } from '../src/core/sync-flags.ts';
import { WIRE_SKEW_WINDOWS, retiredWireFields } from '../src/core/wire-skew.ts';
import { CLI_FLAG_REGISTRY } from '../src/core/cli-flag-registry.generated.ts';
import { IGNORED_FLAGS, VALUE_FLAGS, WIRE_BOOL_FLAGS, maybeDelegateManagedSyncToServe, parseDelegatedSyncArgs } from '../src/commands/sync-delegate.ts';
import { DELEGATED_SYNC_OPTION_FIELDS, validateDelegatedSyncOptions } from '../src/core/context/sync-ipc.ts';
import { SYNC_BOOLEAN_FLAGS, SYNC_CLIENT_FLAGS, SYNC_VALUE_FLAGS, validateSyncWireParams } from '../src/core/persistence/sync-wire.ts';
import { parsePersistenceSyncArgs } from '../src/commands/sync-persistence-delegate.ts';
import { startResolveIpcServer } from '../src/core/context/resolve-ipc.ts';
import { localIpcSocketPath } from '../src/core/context/ipc-path.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __resetDelegatedSyncForTests, startDelegatedSync } from '../src/core/serve-sync-runner.ts';
import type { SyncOpts } from '../src/commands/sync.ts';
import type { ConsumerRow } from '../src/core/persistence/consumer-heartbeat.ts';
import { withEnv } from './helpers/with-env.ts';

const flags = SYNC_FLAGS as Record<string, SyncFlagSpec>;
const retired = Object.values(WIRE_SKEW_WINDOWS).map(window => window.field);
let engine: PGLiteEngine;
const servers: net.Server[] = [];
const home = mkdtempSync(join(tmpdir(), 'gbrain-sync-flags-'));
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => {
  for (const server of servers) server.close();
  __resetDelegatedSyncForTests();
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

test('every flag the sync argv parsers read is in the one table, and every table flag is in the flag registry', () => {
  const parsers = ['src/commands/sync/args.ts', 'src/commands/sync/run.ts'].map(path => readFileSync(path, 'utf8')).join('\n');
  const read = new Set([...parsers.matchAll(/args(?:\[i - 1\]|\[i\]|\[i\s*-\s*1\])?\s*(?:===|\.includes\(|\.indexOf\()\s*'(--[a-z][a-z-]*)'/g)].map(match => match[1]!));
  for (const match of parsers.matchAll(/args\.(?:includes|indexOf)\('(--[a-z][a-z-]*)'\)/g)) read.add(match[1]!);
  // `--retry-held` is refused by name with its own fix; `--help` is the router's.
  const unclassified = [...read].filter(flag => !(flag in flags) && !['--retry-held', '--help'].includes(flag));
  expect(read.size).toBeGreaterThan(25);
  expect(unclassified).toEqual([]);
  const registry = new Set(CLI_FLAG_REGISTRY.sync);
  expect(Object.keys(flags).filter(flag => !registry.has(flag))).toEqual([]);
});

test('the serve ladder, its wire validator and the owner lane are views of the table', () => {
  for (const [flag, spec] of Object.entries(flags)) {
    // Serve ladder: forward → on the wire (or fixed), client → accepted and not sent, refuse → refused by name.
    const argv = spec.arity === 'boolean' ? [flag] : [flag, flag === '--lanes' ? '4' : 'x'];
    const parsed = parseDelegatedSyncArgs(argv);
    if (spec.serve === 'refuse') expect(parsed).toEqual({ ok: false, refused: flag });
    else {
      expect(parsed.ok).toBe(true);
      const sent = parsed.ok ? Object.keys(parsed.options) : [];
      expect(sent).toEqual(spec.serve === 'forward' && spec.field ? [spec.field] : []);
      if (spec.serve === 'forward') expect(spec.field! in DELEGATED_SYNC_OPTION_FIELDS).toBe(true);
    }
    // Owner lane: forward → a wire field, client → consumed by the CLI, refuse → absent.
    const owner = spec.owner === 'forward' ? (spec.arity === 'boolean' ? SYNC_BOOLEAN_FLAGS[flag] : SYNC_VALUE_FLAGS[flag]) : undefined;
    expect(owner).toBe(spec.owner === 'forward' ? spec.field : undefined);
    expect(SYNC_CLIENT_FLAGS.has(flag)).toBe(spec.owner === 'client');
  }
  expect(Object.keys(WIRE_BOOL_FLAGS).sort()).toEqual(syncFlagsRouted('serve', 'forward').filter(flag => flags[flag].arity === 'boolean' && flags[flag].sets === undefined).sort());
  expect([...VALUE_FLAGS].sort()).toEqual(['--hard-deadline', '--lanes', '--source', '--timeout']);
  expect([...IGNORED_FLAGS].sort()).toEqual(['--json', '--no-delegate', '--no-hard-deadline', '--yes']);
  expect(Object.keys(syncWireFields('owner')).sort()).toEqual(['dryRun', 'exclude', 'full', 'includeGitignored', 'includeHidden', 'noBulk', 'noEmbed', 'noExtract',
    'noPull', 'noSchemaPack', 'repoPath', 'resetCheckpoint', 'retryFailed', 'skipFailed', 'sourceId', 'srcSubpath', 'strategy', 'workingTree']);
});

test('a retired wire field is never in the table and is accepted, dropped and named once by both residents', async () => {
  expect(retired).toContain('explicitProcessing');
  for (const field of retired) {
    expect(Object.values(flags).map(spec => spec.field)).not.toContain(field);
    expect(field in DELEGATED_SYNC_OPTION_FIELDS).toBe(false);
  }
  // Serve: accepted by shape, dropped, reported as ignored; a wrong shape still refuses.
  expect(validateDelegatedSyncOptions({ noPull: true, explicitProcessing: ['noEmbed'], timeoutSeconds: 5 }))
    .toEqual({ ok: true, options: { noPull: true, timeoutSeconds: 5 }, ignored: ['explicitProcessing'] });
  expect(validateDelegatedSyncOptions({ explicitProcessing: ['repoPath'], timeoutSeconds: 5 })).toEqual({ ok: false, error: 'invalid_options:explicitProcessing' });
  // Owner lane: the same window, the same drop.
  const wire = validateSyncWireParams({ options: { sourceId: 'notes', noPull: true, explicitProcessing: [] }, cwd: home, timeoutSeconds: 5 });
  expect(wire).toEqual({ options: { sourceId: 'notes', noPull: true }, cwd: home, timeoutSeconds: 5, ignored: ['explicitProcessing'] });
  expect(() => validateSyncWireParams({ options: { explicitProcessing: 'noEmbed' }, cwd: home, timeoutSeconds: 5 })).toThrow();
  expect([...retiredWireFields('owner').keys()]).toEqual([...retiredWireFields('serve').keys()]);
  // The serve prints one notice naming the field, its floor and its window.
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  // A runServe shutdown earlier in this process (another file) leaves the runner shutting down: start from a fresh runner.
  __resetDelegatedSyncForTests();
  try {
    const started = await startDelegatedSync(engine, { sourceId: 'missing-source', dryRun: true, explicitProcessing: ['noEmbed'], timeoutSeconds: 5 }, randomUUID());
    expect(started.ok).toBe(true);
  } finally { process.stderr.write = write; }
  const notices = lines.filter(line => line.includes('[gbrain notice]'));
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain('`explicitProcessing`');
  expect(notices[0]).toContain(WIRE_SKEW_WINDOWS.explicitProcessing.accept_until);
  __resetDelegatedSyncForTests();
});

test('a newer CLI never sends a retired field to the serve, whatever its options carry', async () => {
  const secret = randomBytes(32).toString('hex');
  const sock = localIpcSocketPath(join(mkdtempSync(join(home, 'sock-')), 'resolve.sock'));
  const received: Array<Record<string, unknown>> = [];
  const server = await startResolveIpcServer(sock, {
    resolve: async () => null,
    sync_start: (req: { options: unknown }) => { received.push(req.options as Record<string, unknown>); return { ok: false, protocol: 2, error: 'shutting_down' }; },
    sync_status: () => ({ ok: false, protocol: 2, error: 'unknown_job' }),
    sync_abort: () => ({ ok: true, protocol: 2 as const }),
  } as never, { secret });
  servers.push(server!);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const serve: ConsumerRow = { host_id: 'host', pid: 4242, nonce: 'n1', pid_ns: null, kind: 'serve', mode: 'full', started_at: new Date().toISOString(),
    renewed_at: new Date().toISOString(), restart_required: false, root_barrier_age_ms: null, pool: null, host_json_path: '/tmp/host.json', persistence_home: '/tmp',
    minted_under: null, version: 'test' };
  const err = console.error; console.error = () => {};
  const write = process.stderr.write.bind(process.stderr); process.stderr.write = (() => true) as typeof process.stderr.write;
  let outcome: unknown;
  try {
    outcome = await withEnv({ GBRAIN_HOME: home }, () => maybeDelegateManagedSyncToServe(engine, ['--source', 'notes', '--no-pull', '--no-embed'],
      { sourceId: 'notes', noPull: true, noEmbed: true, explicitProcessing: ['noEmbed'] } as unknown as SyncOpts,
      { config: { engine: 'postgres', database_url: 'postgresql://example.invalid/brain' }, probe: async () => serve, socket: async () => ({ sock, secret }), env: {} }));
  } finally { console.error = err; process.stderr.write = write; }
  expect(outcome).toMatchObject({ kind: 'own_consumer', reason: 'serve_refused' });
  expect(received).toHaveLength(1);
  expect(received[0]).toMatchObject({ sourceId: 'notes', noPull: true, noEmbed: true });
  for (const options of received) for (const field of retired) expect(field in options).toBe(false);
  for (const options of received) expect(Object.keys(options).every(key => key in DELEGATED_SYNC_OPTION_FIELDS)).toBe(true);
});

test('the PGLite owner lane accepts --lanes N and --no-lanes and never sends them', async () => {
  const params = await parsePersistenceSyncArgs(['--source', 'notes', '--no-pull', '--no-bulk', '--no-lanes', '--lanes', '4', '--hard-deadline', '13m', '--json'], home);
  expect(params.options).toEqual({ sourceId: 'notes', noPull: true, noBulk: true });
  await expect(parsePersistenceSyncArgs(['--source', 'notes', '--lanes'], home)).rejects.toMatchObject({ code: 'invalid_params' });
});
