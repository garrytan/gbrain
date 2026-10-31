/**
 * #5042: on Postgres the resolve socket is keyed by database URL + source, so
 * several serves bound to different sources of one brain each own a socket
 * and each hook reaches the serve for its own source.
 *
 * Protects: a second serve for another source binds instead of deferring to
 * the first (pre-fix both computed the URL-only path, the second got a null
 * binding, and every hook naming its source got `source_mismatch` from the
 * first); hooks fall back to the legacy URL-only socket (older serves, hooks
 * naming no source); the persistence socket stays brain-keyed (O-ENG-15).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { Server } from 'node:net';
import { bindResolveIpcForServe, type ResolveIpcBinding } from '../src/mcp/resolve-ipc-binding.ts';
import { hookResolveSocketForConfig, IPC_UNAVAILABLE, readIpcSecretForConfig, requestSyncStatus, resolveSocketPathForConfig, resolveViaIpc, socketHasLiveListener, startResolveIpcServer } from '../src/core/context/resolve-ipc.ts';
import { persistenceSocketPathForConfig } from '../src/core/persistence/ipc.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'gb-ipc-source-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

const cfg = { engine: 'postgres' as const, database_url: 'postgresql://user:secret@db.example.com:5432/brain' };
const inBrain = <T>(fn: () => Promise<T>, env: Record<string, string | undefined> = {}) => {
  mkdirSync(join(tmp, '.gbrain'), { recursive: true });
  writeFileSync(join(tmp, '.gbrain', 'config.json'), JSON.stringify(cfg));
  return withEnv({ GBRAIN_HOME: tmp, GBRAIN_DATABASE_URL: undefined, DATABASE_URL: undefined, GBRAIN_SERVE_SYNC_IPC: '0', ...env }, fn);
};
async function closeAll(bindings: ResolveIpcBinding[], servers: Array<Server | null> = []) {
  const all = [...bindings.map(b => b.server), ...servers].filter(Boolean) as Server[];
  const closed = all.map(server => once(server, 'close'));
  for (const binding of bindings) binding.close();
  for (const server of servers) server?.close();
  await Promise.all(closed);
}

describe('source-keyed resolve socket (#5042)', () => {
  it('serves for different sources coexist and each hook reaches its own source', async () => {
    await inBrain(async () => {
      const alpha = await bindResolveIpcForServe({} as BrainEngine, 'alpha');
      const beta = await bindResolveIpcForServe({} as BrainEngine, 'beta');
      try {
        expect(alpha.server).not.toBeNull();
        expect(beta.server).not.toBeNull();
        expect(alpha.socketPath).toBe(resolveSocketPathForConfig(cfg, 'resolve', 'alpha'));
        expect(beta.socketPath).toBe(resolveSocketPathForConfig(cfg, 'resolve', 'beta'));
        expect(alpha.socketPath).not.toBe(beta.socketPath);

        for (const source of ['alpha', 'beta']) {
          const socket = await hookResolveSocketForConfig(cfg, source);
          expect(socket).toBe(resolveSocketPathForConfig(cfg, 'resolve', source));
          expect(await resolveViaIpc(socket!, { candidates: [], sourceId: source })).toBeNull();
        }
        // A hook naming no source falls back to the legacy socket, which the first serve also holds.
        const legacy = resolveSocketPathForConfig(cfg)!;
        expect(await hookResolveSocketForConfig(cfg, undefined)).toBe(legacy);
        expect(await resolveViaIpc(legacy, { candidates: [] })).toBeNull();
        // The legacy socket alone is what every hook used to reach: wrong source for beta.
        expect(await resolveViaIpc(legacy, { candidates: [], sourceId: 'beta' })).toBe(IPC_UNAVAILABLE);
      } finally { await closeAll([alpha, beta]); }
    });
  });

  it('a hook still reaches an older serve that bound only the legacy socket', async () => {
    await inBrain(async () => {
      const legacy = resolveSocketPathForConfig(cfg)!;
      const old = await startResolveIpcServer(legacy, { resolve: async () => null }, { boundSourceId: 'beta' });
      try {
        expect(old).not.toBeNull();
        expect(await hookResolveSocketForConfig(cfg, 'beta')).toBe(legacy);
        expect(await resolveViaIpc(legacy, { candidates: [], sourceId: 'beta' })).toBeNull();
      } finally { await closeAll([], [old]); }
    });
  });

  it('#7612: a lean serve never holds the delegation sockets, so a later read-write serve for the same source owns them', async () => {
    await inBrain(async () => {
      const keyed = resolveSocketPathForConfig(cfg, 'resolve', 'alpha')!;
      const legacy = resolveSocketPathForConfig(cfg)!;
      const lean = await bindResolveIpcForServe({} as BrainEngine, 'alpha', undefined, { lean: true });
      const bindings = [lean];
      try {
        expect(lean.server).not.toBeNull();
        // Alone, the lean serve still answers the hook lane for its source.
        const hookSocket = await hookResolveSocketForConfig(cfg, 'alpha');
        expect(hookSocket).toBe(lean.socketPath);
        expect(await resolveViaIpc(hookSocket!, { candidates: [], sourceId: 'alpha' })).toBeNull();
        expect(await socketHasLiveListener(keyed)).toBe(false);
        expect(await socketHasLiveListener(legacy)).toBe(false);

        const full = await bindResolveIpcForServe({} as BrainEngine, 'alpha');
        bindings.push(full);
        expect(full.socketPath).toBe(keyed);
        const secret = readIpcSecretForConfig(cfg)!;
        const delegation = await hookResolveSocketForConfig(cfg, 'alpha', { delegation: true });
        expect(delegation).toBe(keyed);
        for (const socket of [keyed, legacy]) {
          expect(((await requestSyncStatus(socket, { secret, jobId: 'no-such-job' })) as { error?: string }).error).toBe('unknown_job');
        }
        // Hooks prefer the read-write serve once it is up.
        expect(await hookResolveSocketForConfig(cfg, 'alpha')).toBe(keyed);
        // A delegation client never targets the lean socket, even when it is the only one listening.
        bindings.pop();
        await closeAll([full]);
        expect(await hookResolveSocketForConfig(cfg, 'alpha', { delegation: true })).toBe(legacy);
        expect(await hookResolveSocketForConfig(cfg, 'alpha')).toBe(lean.socketPath);
      } finally { await closeAll(bindings); }
    }, { GBRAIN_SERVE_SYNC_IPC: undefined });
  });

  it('the persistence socket stays brain-keyed and PGLite keeps one path', async () => {
    await inBrain(async () => {
      const persistence = persistenceSocketPathForConfig(cfg)!;
      expect(persistence).toBe(resolveSocketPathForConfig(cfg, 'persistence', 'alpha')!);
      expect(persistence).toBe(resolveSocketPathForConfig(cfg)!.replace(/resolve-([0-9a-f]{12})\.sock$/, 'persistence-$1.sock'));
      const pglite = { engine: 'pglite' as const, database_path: join(tmp, 'db') };
      expect(resolveSocketPathForConfig(pglite, 'resolve', 'alpha')).toBe(resolveSocketPathForConfig(pglite));
      // #7612: a PGLite serve is never lean, so PGLite has no read socket.
      expect(resolveSocketPathForConfig(pglite, 'read', 'alpha')).toBeNull();
    });
  });
});
