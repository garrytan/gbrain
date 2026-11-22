/**
 * The CLI's owner delegates route a Rust brain the way they route a PGLite brain
 * (src/core/persistence/resident-owner.ts, local-client.ts maybeDelegateLocalAdministration).
 *
 * 1. Protects: while a `gbrain serve` owns a Rust brain and its engine reports `persistence_journal`, the five
 *    administration delegates (sync over the persistence socket, embed --facts, extract --stale, sources refresh,
 *    reindex-code) hand their work to it over its persistence socket, as they do for a PGLite serve; and a Rust owner
 *    that cannot take it (no `persistence_journal`, not a serve, or no persistence socket yet) leaves every command on
 *    the engine path it takes today, with no new `owner_unavailable`. The sync, sync-trigger and sweep delegates stay on
 *    the engine path until a Rust serve's hook socket answers, and sync trigger is recorded through it once it does.
 * 2. Fails on: a delegate gate that still admits PGLite only; administration delegation that refuses a Rust owner
 *    after the gate admitted it (the command would end `owner_unavailable` instead of running); a gate that admits a
 *    Rust owner the persistence path cannot serve.
 * 3. Existing coverage: fact-backfill-resident.test.ts and persistence-admin-recovery.test.ts run administration
 *    against a PGLite owner; nothing routed a Rust brain's command to its owner.
 * 4. Seam: the Rust owner is the real owner socket (serveOwnerEngine) around a stand-in engine that reports its
 *    capabilities; its persistence socket is the real listener (startPersistenceIpcServer) around a recording
 *    provider. The delegates, the probe and local-client.ts run unchanged.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { configDir, type GBrainConfig } from '../src/core/config.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { startPersistenceIpcServer, type PersistenceIpcAdminRequest, type PersistenceIpcBinding } from '../src/core/persistence/ipc.ts';
import { serveOwnerEngine, type OwnerEngineServer } from '../src/core/rust-engine/owner-ipc/server.ts';
import { ownerSocketPath } from '../src/core/rust-engine/owner-ipc/protocol.ts';
import { localIpcSocketPath } from '../src/core/context/ipc-path.ts';
import { maybeDelegateSyncToPersistence } from '../src/commands/sync-persistence-delegate.ts';
import { maybeDelegateFactEmbed } from '../src/commands/embed-facts-delegate.ts';
import { maybeDelegateExtractStale } from '../src/commands/extract-stale-delegate.ts';
import { maybeDelegateSourcesRefresh } from '../src/commands/sources-refresh-delegate.ts';
import { maybeDelegateReindexCode } from '../src/commands/reindex-code-delegate.ts';
import { maybeDelegateSyncToServe, maybeTriggerThroughServe } from '../src/commands/sync-delegate.ts';
import { maybeDelegateSweepToServe } from '../src/commands/sweep-delegate.ts';
import { setStdoutCapture } from '../src/core/cli-force-exit.ts';
import { createServer, type Server } from 'node:net';
import { ensureIpcSecret, resolveSocketPath } from '../src/core/context/resolve-ipc.ts';
import { prepareLocalIpcPath } from '../src/core/context/ipc-path.ts';
import { hookServeStillHolds } from '../src/core/persistence/resident-owner.ts';
import { withEnv } from './helpers/with-env.ts';

const root = mkdtempSync(join(tmpdir(), 'gbrain-rust-delegates-'));
const home = join(root, 'home');
const brainId = randomUUID();
let dbDir: string;
let owner: OwnerEngineServer | null = null;
let persistence: PersistenceIpcBinding | null = null;
/** Administration requests the stand-in owner received. */
const received: PersistenceIpcAdminRequest[] = [];
let out = '';

const inHome = <T>(run: () => Promise<T>) => withEnv({
  GBRAIN_HOME: home, GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: undefined, DATABASE_URL: undefined,
  GBRAIN_SYNC_NO_DELEGATE: undefined, GBRAIN_SWEEP_NO_DELEGATE: undefined,
}, run);
const rustConfig = () => ({ engine: 'rust', database_path: dbDir } as unknown as GBrainConfig);

/** Starts a stand-in Rust owner: its owner socket reports `capabilities` and `serve`; `persistenceSocket` binds its persistence listener. */
async function startRustOwner(opts: { capabilities: string[]; serve: boolean; persistenceSocket: boolean }): Promise<void> {
  const engine = { kind: 'rust', capabilities: new Set(opts.capabilities) } as unknown as BrainEngine;
  owner = await serveOwnerEngine(engine, ownerSocketPath(dbDir), { serve: opts.serve });
  if (!owner) throw new Error('stand-in owner socket did not bind');
  if (!opts.persistenceSocket) return;
  persistence = await startPersistenceIpcServer(localIpcSocketPath(join(dbDir, '.gbrain-persistence.sock')), {
    brainId,
    dispatch: async () => { throw new OperationError('invalid_params', 'stand-in owner takes administration only', 'test'); },
    administer: async request => {
      received.push(request);
      if (request.operation === 'writer_reindex_code') return { reindexed: 2, skipped: 1, failed: 0, codePages: 3 };
      throw new OperationError('invalid_params', `stand-in Rust owner answered ${request.operation}`, 'test stand-in');
    },
  });
  if (!persistence) throw new Error('stand-in persistence socket did not bind');
}

beforeAll(async () => inHome(async () => {
  mkdirSync(join(configDir(), 'persistence'), { recursive: true });
  writeFileSync(join(configDir(), 'persistence', `${brainId}.cli.json`),
    JSON.stringify({ id: randomUUID(), credential: 'a'.repeat(64), lane: 'cli' }));
}));
beforeEach(() => {
  dbDir = mkdtempSync(join(root, 'brain-'));
  received.length = 0;
  out = '';
});
afterEach(async () => {
  persistence?.close(); persistence = null;
  await owner?.close(); owner = null;
  rmSync(dbDir, { recursive: true, force: true });
  process.exitCode = 0;
});
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

/** Runs `fn` with stdout and stderr captured into `out`. */
async function captured<T>(fn: () => Promise<T>): Promise<T> {
  const write = (chunk: unknown) => { out += String(chunk); return true; };
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  const log = console.log; const error = console.error;
  setStdoutCapture(text => { out += text; });
  process.stdout.write = write as typeof process.stdout.write;
  process.stderr.write = write as typeof process.stderr.write;
  console.log = (...args: unknown[]) => { out += args.join(' ') + '\n'; };
  console.error = (...args: unknown[]) => { out += args.join(' ') + '\n'; };
  try { return await fn(); }
  finally { setStdoutCapture(null); process.stdout.write = stdout; process.stderr.write = stderr; console.log = log; console.error = error; }
}

const DELEGATES: Array<{ name: string; operation: string; run: () => Promise<boolean>; answer: string }> = [
  { name: 'sync over the persistence socket', operation: 'writer_sync',
    run: () => maybeDelegateSyncToPersistence(rustConfig(), ['--source', 'default', '--no-pull']), answer: 'stand-in Rust owner answered writer_sync' },
  { name: 'embed --facts', operation: 'writer_embed_facts',
    run: () => maybeDelegateFactEmbed(rustConfig(), ['--stale', '--facts', '--source', 'default', '--dry-run']), answer: 'stand-in Rust owner answered writer_embed_facts' },
  { name: 'extract --stale', operation: 'writer_extract_stale',
    run: () => maybeDelegateExtractStale(rustConfig(), ['--stale']), answer: 'stand-in Rust owner answered writer_extract_stale' },
  { name: 'sources refresh', operation: 'writer_refresh',
    run: () => maybeDelegateSourcesRefresh(rustConfig(), ['default']), answer: 'stand-in Rust owner answered writer_refresh' },
  { name: 'reindex-code', operation: 'writer_reindex_code',
    run: () => maybeDelegateReindexCode(rustConfig(), ['--dry-run']), answer: 'reindex-code: 2 reindexed, 1 skipped, 0 failed (3 code pages).' },
];

describe('a Rust brain whose serve owner reports persistence_journal takes the delegated command', () => {
  for (const delegate of DELEGATES) {
    // Value: protects=the command runs in the serve that owns a Rust brain, over its persistence socket, and prints the owner's answer; fails_when=the gate admits PGLite only, or administration delegation refuses the Rust owner after the gate admitted it; why_new=no test routed a Rust brain's command to its owner; seam=real owner and persistence sockets around stand-ins; no_claim=the owner's own work on a Rust engine, which needs persistence_journal there
    test(`${delegate.name}: sent to the owner as ${delegate.operation}, and the owner's answer is printed`, () => inHome(async () => {
      await startRustOwner({ capabilities: ['persistence_journal'], serve: true, persistenceSocket: true });
      const handled = await captured(delegate.run);
      expect(handled).toBe(true);
      expect(received.map(r => String(r.operation))).toEqual([delegate.operation]);
      expect(received[0]!.brain_id).toBe(brainId);
      expect(out).toContain(delegate.answer);
      expect(out).not.toContain('owner_unavailable');
    }), 30_000);
  }
});

describe('a Rust owner that cannot take persistence work leaves every command on the engine path, as today', () => {
  const cases: Array<{ name: string; opts: { capabilities: string[]; serve: boolean; persistenceSocket: boolean } }> = [
    { name: 'no persistence_journal', opts: { capabilities: ['pages'], serve: true, persistenceSocket: true } },
    { name: 'not a serve', opts: { capabilities: ['persistence_journal'], serve: false, persistenceSocket: true } },
    { name: 'no persistence socket bound yet', opts: { capabilities: ['persistence_journal'], serve: true, persistenceSocket: false } },
  ];
  for (const owned of cases) {
    // Value: protects=a Rust owner the persistence path cannot serve changes nothing for these commands: each falls through to the engine path with no new owner_unavailable; fails_when=a gate admits that owner, so the command ends owner_unavailable or reaches a socket that cannot run it; why_new=opening the gates to Rust adds this case; seam=real owner socket around a stand-in; no_claim=what the engine path then does
    test(`${owned.name}: all five delegates fall through and send nothing`, () => inHome(async () => {
      await startRustOwner(owned.opts);
      for (const delegate of DELEGATES) {
        const handled = await captured(delegate.run);
        expect({ delegate: delegate.name, handled }).toEqual({ delegate: delegate.name, handled: false });
      }
      expect(received).toEqual([]);
      expect(out).toBe('');
    }), 30_000);
  }

  // Value: protects=a Rust brain with no owner at all keeps the engine path for every delegate; fails_when=the probe treats a missing owner socket as an owner; why_new=the Rust probe is new; seam=none; no_claim=the engine path itself
  test('no owner: all five delegates fall through', () => inHome(async () => {
    for (const delegate of DELEGATES) expect(await captured(delegate.run)).toBe(false);
    expect(out).toBe('');
  }), 30_000);
});

describe('sync trigger and sweep through a Rust serve wait for its hook socket', () => {
  // Value: protects=a Rust serve that has not bound the hook socket (master today) leaves sync, sync trigger and sweep on the engine path, with no refusal; fails_when=the gates refuse a Rust brain for a missing hook socket the way they refuse an old PGLite serve; why_new=the gates now admit a Rust serve; seam=real owner socket around a stand-in; no_claim=delegation once the hook socket exists (the trunk binds it)
  test('a Rust serve with no hook socket: sync, sync trigger and sweep fall through and print nothing', () => inHome(async () => {
    await startRustOwner({ capabilities: ['persistence_journal'], serve: true, persistenceSocket: true });
    expect(await captured(() => maybeDelegateSyncToServe(dbDir, ['--source', 'default'], 'rust'))).toBe(false);
    expect(await captured(() => maybeTriggerThroughServe(rustConfig(), ['--source', 'default']))).toBe(false);
    expect(await captured(() => maybeDelegateSweepToServe(dbDir, ['--once'], 'rust'))).toBe(false);
    expect(out).toBe('');
    expect(received).toEqual([]);
  }), 30_000);

  // Value: protects=a secret alone does not make a Rust serve take sync, sync trigger or sweep; its hook socket must answer; fails_when=the live-listener check is dropped, so the delegates refuse or hang on a dead socket; why_new=the case above stops at the missing secret; seam=real owner socket around a stand-in; no_claim=hook handlers
  test('a Rust serve with a secret but no hook listener: sync, sync trigger and sweep still fall through', () => inHome(async () => {
    await startRustOwner({ capabilities: ['persistence_journal'], serve: true, persistenceSocket: true });
    ensureIpcSecret(dbDir);
    expect(await captured(() => maybeDelegateSyncToServe(dbDir, ['--source', 'default'], 'rust'))).toBe(false);
    expect(await captured(() => maybeTriggerThroughServe(rustConfig(), ['--source', 'default']))).toBe(false);
    expect(await captured(() => maybeDelegateSweepToServe(dbDir, ['--once'], 'rust'))).toBe(false);
    expect(out).toBe('');
  }), 30_000);

  // Value: protects=once a Rust serve binds its hook socket, sync trigger is recorded through it, as for a PGLite serve; fails_when=the Rust hook probe never admits a serve (always null) or picks the PGLite holder; why_new=no test reached a Rust serve's hook socket; seam=real owner socket around a stand-in plus a hook listener that answers sync_nudge; no_claim=a Rust serve binding that socket in production (the trunk does)
  test('a Rust serve whose hook socket answers: sync trigger is recorded through it', () => inHome(async () => {
    await startRustOwner({ capabilities: ['persistence_journal'], serve: true, persistenceSocket: false });
    const secret = ensureIpcSecret(dbDir);
    const nudges: Array<Record<string, unknown>> = [];
    const hook: Server = createServer(socket => {
      let buffered = '';
      socket.on('data', chunk => {
        buffered += chunk.toString();
        const end = buffered.indexOf('\n');
        if (end === -1) return;
        const request = JSON.parse(buffered.slice(0, end)) as Record<string, unknown>;
        nudges.push(request);
        socket.end(JSON.stringify({ ok: request.secret === secret, protocol: 2, acked: true, notifier: true, resident: 'serve',
          marker: { source_id: 'default', intent: 'freshness', generation: 4, wanted_head: null } }) + '\n');
      });
    });
    const hookPath = prepareLocalIpcPath(resolveSocketPath(dbDir), true);
    await new Promise<void>(resolve => hook.listen(hookPath, resolve));
    try {
      expect(await captured(() => maybeTriggerThroughServe(rustConfig(), ['--source', 'default', '--json']))).toBe(true);
    } finally { await new Promise<void>(resolve => hook.close(() => resolve())); }
    expect(nudges.map(n => [n.kind, n.sourceId])).toEqual([['sync_nudge', 'default']]);
    expect(out).toContain('"action":"nudged"');
    expect(out).toContain(`"pid":${process.pid}`);
  }), 30_000);

  // Value: protects=after a lost start acknowledgment or between polls, a busy Rust owner that accepts connections but does not answer its hello in time still counts as holding the brain, so the CLI never runs an accepted sync or sweep a second time itself; fails_when=the re-check uses the one-second hello probe, which reads a busy owner as gone, or trusts the owner's advertised pid (not visible from another PID namespace); why_new=an outside review reproduced a delegated sync falling back while the owner still ran it; seam=a real Unix socket that accepts and never answers, at the owner socket path; no_claim=the owner's own work
  test('a busy Rust owner that does not answer its hello still holds the brain, whatever its pid; a refused owner socket does not', () => inHome(async () => {
    const stalled: Server = createServer(() => { /* accepts, never answers */ });
    const ownerPath = prepareLocalIpcPath(ownerSocketPath(dbDir), true);
    await new Promise<void>(resolve => stalled.listen(ownerPath, resolve));
    try {
      expect(await hookServeStillHolds('rust', dbDir)).toBe(true);
    } finally { await new Promise<void>(resolve => stalled.close(() => resolve())); }
    expect(await hookServeStillHolds('rust', dbDir)).toBe(false);
  }), 30_000);
});
