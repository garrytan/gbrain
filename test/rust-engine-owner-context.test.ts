/**
 * The Rust engine runs its owner election in the empty async context, wherever its module was first loaded
 * (src/core/rust-engine.ts `emptyAsyncContext`).
 *
 * 1. Protects: (a) an engine whose module was first loaded inside a remote job's call, a remote caller's mark and a
 *    request signal still serves its owner socket with none of them; (b) the runtime fact the empty context rests on:
 *    a MessagePort listener runs with no caller store.
 *    (c) on a runtime that carried the caller's context into a MessagePort listener, the engine refuses to elect
 *    before it opens the store, and a later election on a runtime that does not succeeds.
 * 2. Fails on: the election running in a context taken at module load (a lazy load inside a request makes that
 *    request the owner's context), or in the caller's context; a runtime that carries the caller's context into a
 *    MessagePort listener.
 * 3. Existing coverage: rust-owner-ipc.test.ts checks a takeover a remote job's call starts, with the module loaded at
 *    the top of the file, outside any request.
 * 4. Seam: a stub addon store; the module is required fresh (a query on its specifier) inside the request scopes.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { connectOwner, installOwnerClient } from '../src/core/rust-engine/owner-ipc/client.ts';
import { ownerSocketPath } from '../src/core/rust-engine/owner-ipc/protocol.ts';
import { currentSubmissionAuthority, withSubmissionAuthority, type SubmissionAuthority } from '../src/core/minions/submission-authority.ts';
import { isRemoteCaller, withRemoteCaller } from '../src/core/remote-caller.ts';
import { requestSignal, withRequestSignal } from '../src/core/request-signal.ts';

const dir = mkdtempSync(join(tmpdir(), 'gbrain-rust-owner-context-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The signal of the request that loaded the module and started the election. */
let callerSignal: AbortSignal | undefined;
/** What code the owner runs can see of the caller that started the election. */
const callerSeen = () => JSON.stringify({ authority: currentSubmissionAuthority()?.kind ?? null, remote: isRemoteCaller(), callerSignal: callerSignal !== undefined && requestSignal() === callerSignal });
/** What the store saw when the election opened it. */
let seenAtOpen: string | undefined;

class SeeingBrain { async open() { seenAtOpen = callerSeen(); } async close() {} async getConfig(key: string): Promise<string | null> { return key === 'caller' ? callerSeen() : null; } }
const addon = { target: 'linux-x64-glibc', engine_abi: 1, Pool: class { async shutdown() {} }, Brain: SeeingBrain } as never;

describe('the Rust engine owner context', () => {
  // Value: protects=the owner a lazily loaded engine starts serves every later caller with no job authority, no remote mark and no request signal; fails_when=the election runs in a context snapshot taken when the module loaded, which a load inside a remote job's call makes that job's; why_new=the takeover test loads the module outside any request, so a module-load snapshot passed it; seam=stub addon store, module loaded fresh inside the scopes; no_claim=the real native store
  test('an engine whose module first loaded inside a remote job\'s call opens its store and serves its owner socket with no caller context', async () => {
    const db = join(dir, 'brain.rust');
    const remoteJob = { version: 1, kind: 'remote_generic' } as unknown as SubmissionAuthority;
    const controller = new AbortController();
    callerSignal = controller.signal;
    const rust = await withSubmissionAuthority(remoteJob, () => withRemoteCaller(true, () => withRequestSignal(controller.signal, async () => {
      expect(JSON.parse(callerSeen())).toEqual({ authority: 'remote_generic', remote: true, callerSignal: true });
      // A synchronous require evaluates the module in the caller's context (a dynamic import does not, on Bun), so this
      // load is the one a module-load snapshot would have captured as the owner's context.
      const fresh = require('../src/core/rust-engine.ts?owner-context-probe') as typeof import('../src/core/rust-engine.ts');
      const engine = fresh.openRustEngine({ addon, databasePath: db, ownerWaitMs: 5_000 });
      await engine.connect({});
      return engine;
    })));
    try {
      expect(rust.ownerRole).toBe('owner');
      // The store opened in the election's context.
      expect(JSON.parse(seenAtOpen!)).toEqual({ authority: null, remote: false, callerSignal: false });
      const connection = await connectOwner(ownerSocketPath(db));
      const client = { kind: 'rust', capabilities: new Set<string>() } as unknown as BrainEngine;
      const close = installOwnerClient(client, connection);
      try {
        expect(JSON.parse((await client.getConfig('caller'))!)).toEqual({ authority: null, remote: false, callerSignal: false });
      } finally { close(); }
    } finally {
      await rust.disconnect();
    }
  }, 60_000);

  // Value: protects=the runtime fact emptyAsyncContext rests on, so a Bun upgrade that changes it fails here and not silently in production; fails_when=a MessagePort listener runs in the context that posted to it; why_new=the empty context is new; seam=none; no_claim=other runtimes
  test('a MessagePort listener runs with no caller store, and emptyAsyncContext runs its function there', async () => {
    const store = new AsyncLocalStorage<string>();
    const { emptyAsyncContext } = await import('../src/core/rust-engine.ts');
    const seen = await store.run('caller', async () => {
      const listener = await new Promise<string | undefined>(resolve => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(store.getStore()); };
        channel.port2.postMessage(null);
      });
      const run = await emptyAsyncContext();
      return { inside: store.getStore(), listener, empty: run(() => store.getStore()), after: store.getStore() };
    });
    expect(seen).toEqual({ inside: 'caller', listener: undefined, empty: undefined, after: 'caller' });
  });

  // Value: protects=the refusal branch of emptyAsyncContext: a runtime that runs a MessagePort listener in the posting context makes connect refuse before the store opens, and the refusal is not cached; fails_when=the probe check is removed (the election then runs in the caller's context) or a refusal stays memoized; why_new=on Bun the listener never sees the caller, so the branch never ran; seam=a stand-in MessageChannel that calls its listener synchronously inside postMessage, the module required fresh so its memo is empty; no_claim=which real runtimes do this
  test('a runtime that carries the caller\'s context into a MessagePort listener makes connect refuse before the store opens; the next election succeeds', async () => {
    const db = join(dir, 'brain-refusal.rust');
    const fresh = require('../src/core/rust-engine.ts?owner-context-refusal') as typeof import('../src/core/rust-engine.ts');
    const native = globalThis.MessageChannel;
    let opened = 0;
    class CountingBrain extends SeeingBrain { override async open() { opened++; await super.open(); } }
    const counting = { ...(addon as object), Brain: CountingBrain } as never;
    const closed: string[] = [];
    class CarryingChannel {
      port1 = { onmessage: null as null | ((event: unknown) => void), close: () => { closed.push('port1'); } };
      port2 = { postMessage: (data: unknown) => { this.port1.onmessage?.({ data }); }, close: () => { closed.push('port2'); } };
    }
    const engine = fresh.openRustEngine({ addon: counting, databasePath: db, ownerWaitMs: 5_000 });
    globalThis.MessageChannel = CarryingChannel as unknown as typeof MessageChannel;
    let refusal: unknown;
    try {
      refusal = await engine.connect({}).then(() => null, (error: unknown) => error);
    } finally { globalThis.MessageChannel = native; }
    expect(String((refusal as Error | null)?.message)).toContain('could not take an empty async context');
    expect(opened).toBe(0);
    expect(closed.sort()).toEqual(['port1', 'port2']);
    await engine.connect({});
    try {
      expect(engine.ownerRole).toBe('owner');
      expect(opened).toBe(1);
    } finally { await engine.disconnect(); }
  }, 60_000);
});
