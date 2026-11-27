/**
 * Remote callers on a client of a Rust brain's owner (src/core/rust-engine/owner-ipc/client.ts, src/core/remote-caller.ts):
 * the owner socket does not carry a caller's remote flag, submission authority or verified writer, so a client sends
 * only the read members of OWNER_IPC_REMOTE_READS for a remote caller and refuses every other member before it is
 * sent. A local caller's calls are unchanged.
 *
 * 1. Protects: an agent-facing MCP caller of a second process (or a remote job, or a remote verified writer) never runs
 *    a write on the owner with the owner's authority; its reads still work.
 * 2. Fails on: a client that forwards every member whatever the caller, a read list naming a member that is not
 *    forwarded, or a dispatch that does not mark its handler's scope remote.
 * 3. Existing coverage: rust-owner-ipc.test.ts checks whole operations refuse a non-application authority; nothing
 *    checked single member calls or the MCP dispatch path.
 * 4. Seam: a recording fake owner engine on a real owner socket; the MCP check spies on a PGLite engine's members.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { serveOwnerEngine, type OwnerEngineServer } from '../src/core/rust-engine/owner-ipc/server.ts';
import { connectOwner, installOwnerClient } from '../src/core/rust-engine/owner-ipc/client.ts';
import {
  OWNER_IPC_REMOTE_DENY, OWNER_IPC_REMOTE_HAND_READS, OWNER_IPC_REMOTE_READS, OWNER_IPC_REMOTE_TYPED_READS, OWNER_IPC_ROUTES,
} from '../src/core/rust-engine/owner-ipc/routes.ts';
import { OWNER_IPC_TYPED_CONFIRMING_READS, OWNER_IPC_TYPED_READS } from '../src/core/rust-engine/owner-ipc/typed-member-classes.ts';
import { OWNER_IPC_CONFIRMING_READS } from '../src/core/rust-engine/owner-ipc/confirming-reads.ts';
import { forwardWholeOperation } from '../src/core/rust-engine/owner-ipc/whole-op.ts';
import { isRemoteCaller, withRemoteCaller } from '../src/core/remote-caller.ts';
import { currentSubmissionAuthority, withSubmissionAuthority, APPLICATION_AUTHORITY, type SubmissionAuthority } from '../src/core/minions/submission-authority.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { withVerifiedLocalRegistration, type LocalRegistration, type LocalWriterEngine } from '../src/core/persistence/identity.ts';
import { sha256 } from '../src/core/persistence/digest.ts';

let dir: string;
let server: OwnerEngineServer;
const ran: string[] = [];
let client: Record<string, (...args: unknown[]) => Promise<unknown>>;
let undo: () => void;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'gbrain-owner-remote-'));
  const owner = {
    // The owner reports persistence_journal: a whole operation is sent only to an owner that does (whole-op.ts).
    kind: 'pglite', capabilities: new Set<string>(['persistence_journal']),
    getPage: async (slug: unknown) => { ran.push(`getPage:${String(slug)}`); return { slug }; },
    putPage: async (slug: unknown) => { ran.push(`putPage:${String(slug)}`); return { slug }; },
    executeRaw: async () => { ran.push('executeRaw'); return []; },
    importFromContent: async () => { ran.push('importFromContent'); return {}; },
  } as unknown as BrainEngine;
  server = (await serveOwnerEngine(owner, join(dir, 'owner.sock'), {
    wholeOperations: { importFromContent: async () => { ran.push('fn:importFromContent'); return { ok: true }; } },
  }))!;
  const engine = { kind: 'rust', capabilities: new Set<string>() };
  undo = installOwnerClient(engine, await connectOwner(server.socketPath));
  client = engine as unknown as typeof client;
});

afterAll(async () => {
  undo?.();
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

const refusal = async (promise: Promise<unknown>) => {
  const error = await promise.then(() => null, e => e as OperationError);
  expect(error).toBeInstanceOf(OperationError);
  return { code: error?.code, message: error?.message };
};

/** The hand-listed remote reads as of ruling A (2026-11-26); new remote reads are typed reads (OWNER_IPC_REMOTE_TYPED_READS). */
const HAND_READS_FROZEN_SIZE = 145;

/**
 * The remote read list guard (multi-user lane L3, ruling A on batch 1): a member reaches the remote list only as a typed
 * read (typed-member-classes.ts) or as one of the frozen hand-listed reads, never as a typed write, and never when
 * OWNER_IPC_REMOTE_DENY names it. It does not read OWNER_IPC_LOCAL_ONLY_READS (as spread, that set is every typed read).
 */
function remoteListProblems(lists: { remote: Iterable<string>; hand: ReadonlySet<string>; typed: ReadonlySet<string>; writes: ReadonlySet<string>; deny: ReadonlySet<string> }): string[] {
  const problems: string[] = [];
  for (const member of lists.remote) {
    if (!lists.typed.has(member) && !lists.hand.has(member)) problems.push(`${member}: not a typed read and not on the frozen hand list`);
    if (lists.writes.has(member)) problems.push(`${member}: a typed write`);
    if (lists.deny.has(member)) problems.push(`${member}: denied (${OWNER_IPC_REMOTE_DENY[member] ?? 'fixture'})`);
  }
  return problems;
}

const REAL = {
  hand: OWNER_IPC_REMOTE_HAND_READS,
  typed: new Set(OWNER_IPC_TYPED_READS),
  writes: new Set([...Object.keys(OWNER_IPC_TYPED_CONFIRMING_READS), ...Object.keys(OWNER_IPC_CONFIRMING_READS)]),
  deny: new Set(Object.keys(OWNER_IPC_REMOTE_DENY)),
};

describe('the remote read list guard', () => {
  test('every remote read is a typed read or a frozen hand-listed read, never a typed write, never denied', () => {
    expect(remoteListProblems({ remote: OWNER_IPC_REMOTE_READS, ...REAL })).toEqual([]);
  });

  test('the remote list is exactly the hand list and the typed additions; the hand list is frozen (new reads go to the typed list)', () => {
    expect(new Set(OWNER_IPC_REMOTE_READS)).toEqual(new Set([...OWNER_IPC_REMOTE_HAND_READS, ...OWNER_IPC_REMOTE_TYPED_READS]));
    expect(OWNER_IPC_REMOTE_HAND_READS.size).toBe(HAND_READS_FROZEN_SIZE);
    expect(OWNER_IPC_REMOTE_TYPED_READS.filter(member => !REAL.typed.has(member))).toEqual([]);
  });

  test('the guard fails when a denied member is added to the remote list (readCommitLog, a secret-store read)', () => {
    for (const denied of ['readCommitLog', 'lastCommitPosition', 'beginSnapshotRead', 'readSecretStoreSnapshot']) {
      expect(Object.hasOwn(OWNER_IPC_REMOTE_DENY, denied), `${denied} is on the deny list`).toBe(true);
      expect(remoteListProblems({ remote: [...OWNER_IPC_REMOTE_READS, denied], ...REAL }).some(p => p.startsWith(`${denied}: denied`))).toBe(true);
    }
  });

  test('the guard fails on a typed write and on a member that is neither a typed read nor hand-listed', () => {
    expect(remoteListProblems({ remote: ['putPage'], ...REAL }).some(p => p.startsWith('putPage: a typed write'))).toBe(true);
    expect(remoteListProblems({ remote: ['notAMember'], ...REAL })).toEqual(['notAMember: not a typed read and not on the frozen hand list']);
  });

  test('every denied member names its reason', () => {
    expect(Object.entries(OWNER_IPC_REMOTE_DENY).filter(([, reason]) => reason.trim().length < 15).map(([member]) => member)).toEqual([]);
  });
});

describe('a client of the owner, for a remote caller', () => {
  test('every member of the remote read list is a forwarded member, and no write is on it', () => {
    const routes = OWNER_IPC_ROUTES as Record<string, string>;
    expect([...OWNER_IPC_REMOTE_READS].filter(member => routes[member] !== 'forward')).toEqual([]);
    for (const write of ['putPage', 'deletePage', 'executeRaw', 'executeRawDirect', 'setConfig', 'acquireCycleLock', 'resolveTake', 'applyTransactionSettings']) {
      expect(OWNER_IPC_REMOTE_READS.has(write)).toBe(false);
    }
  });

  test('a write is refused with engine_capability_missing and the owner never runs it', async () => {
    ran.length = 0;
    const out = await refusal(withRemoteCaller(true, () => client.putPage!('remote/page', {})));
    expect(out.code).toBe('engine_capability_missing');
    expect(out.message).toContain("a remote caller's write is not sent to the brain owner");
    expect(await refusal(withRemoteCaller(true, () => client.executeRaw!('DELETE FROM pages')))).toMatchObject({ code: 'engine_capability_missing' });
    expect(ran).toEqual([]);
  });

  test('a read is sent and answered', async () => {
    ran.length = 0;
    expect(await withRemoteCaller(true, () => client.getPage!('remote/page'))).toEqual({ slug: 'remote/page' });
    expect(ran).toEqual(['getPage:remote/page']);
  });

  test('a job whose submission authority is not the application is a remote caller too', async () => {
    ran.length = 0;
    const remoteJob = { version: 1, kind: 'remote_generic' } as unknown as SubmissionAuthority;
    expect(await refusal(withSubmissionAuthority(remoteJob, () => client.putPage!('job/page', {})))).toMatchObject({ code: 'engine_capability_missing' });
    expect(await withSubmissionAuthority(APPLICATION_AUTHORITY, () => client.putPage!('app/page', {}))).toEqual({ slug: 'app/page' });
    expect(ran).toEqual(['putPage:app/page']);
  });

  test('a whole operation from a remote caller is refused; a local one is sent', async () => {
    ran.length = 0;
    expect(await refusal(withRemoteCaller(true, () => forwardWholeOperation(client, 'importFromContent', ['s', 'c'])!))).toMatchObject({ code: 'engine_capability_missing' });
    expect(await forwardWholeOperation<unknown>(client, 'importFromContent', ['s', 'c'])).toEqual({ ok: true });
    expect(ran).toEqual(['fn:importFromContent']);
  });
});

describe('a client of the owner, for a remote verified writer with no other remote marker', () => {
  const registration = (lane: 'cli' | 'stdio'): LocalRegistration => ({ id: '20000000-0000-4000-8000-000000000001', credential: 'c'.repeat(64), lane });
  const writerEngine = (lane: 'cli' | 'stdio') => ({
    readLocalWriterRow: async () => ({ credential_hash: sha256(registration(lane).credential), lane, revoked_at: null,
      grant_ceiling: { sourceIds: ['*'], operations: null, scopes: ['read', 'write'], slugPrefixes: null } }),
  }) as unknown as LocalWriterEngine;

  // Value: protects=a remote verified writer alone keeps a write and whole op off the owner; fails_when=callerIsRemote ignores the writer's remote flag; why_new=other tests set the remote-caller flag or submission authority, never the writer alone; seam=none; no_claim=other remote markers
  test('a remote verified writer alone refuses a write and a whole operation, and a cli writer sends both', async () => {
    ran.length = 0;
    const out = await withVerifiedLocalRegistration(writerEngine('stdio'), registration('stdio'), async writer => {
      // The writer's flag is the only marker: no remote-caller scope and no submission authority.
      expect({ writer: writer.remote, flag: isRemoteCaller(), authority: currentSubmissionAuthority() ?? null }).toEqual({ writer: true, flag: false, authority: null });
      return {
        write: await refusal(client.putPage!('writer/page', {})),
        whole: await refusal(forwardWholeOperation(client, 'importFromContent', ['s', 'c'])!),
        read: await client.getPage!('writer/page'),
      };
    });
    expect(out.write.code).toBe('engine_capability_missing');
    expect(out.write.message).toContain("a remote caller's write is not sent to the brain owner");
    expect(out.whole.code).toBe('engine_capability_missing');
    expect(out.whole.message).toContain("a remote caller's whole operation is not sent to the brain owner");
    expect(out.read).toEqual({ slug: 'writer/page' });
    expect(ran).toEqual(['getPage:writer/page']);
    // Control: a cli writer is not remote, so the same write and whole operation are sent.
    ran.length = 0;
    await withVerifiedLocalRegistration(writerEngine('cli'), registration('cli'), async writer => {
      expect(writer.remote).toBe(false);
      expect(await client.putPage!('cli/page', {})).toEqual({ slug: 'cli/page' });
      expect(await forwardWholeOperation<unknown>(client, 'importFromContent', ['s', 'c'])).toEqual({ ok: true });
    });
    expect(ran).toEqual(['putPage:cli/page', 'fn:importFromContent']);
  });
});

describe('a client of the owner, for a local caller', () => {
  test('a write is sent as before, outside any scope and inside a local one', async () => {
    ran.length = 0;
    expect(await client.putPage!('local/page', {})).toEqual({ slug: 'local/page' });
    expect(await withRemoteCaller(false, () => client.putPage!('local/scoped', {}))).toEqual({ slug: 'local/scoped' });
    expect(ran).toEqual(['putPage:local/page', 'putPage:local/scoped']);
  });
});

describe('the MCP dispatch marks its handler remote or local', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 120_000);
  afterAll(async () => { await engine?.disconnect(); });

  test('engine members a remote get_page calls see a remote caller, and a local one does not', async () => {
    const seen: boolean[] = [];
    const record = engine as unknown as Record<string, unknown>;
    for (const [member, route] of Object.entries(OWNER_IPC_ROUTES)) {
      const original = record[member];
      if (route !== 'forward' || typeof original !== 'function') continue;
      Object.defineProperty(record, member, {
        configurable: true, writable: true,
        value: (...args: unknown[]) => { seen.push(isRemoteCaller()); return (original as (...a: unknown[]) => unknown).apply(engine, args); },
      });
    }
    await dispatchToolCall(engine, 'get_page', { slug: 'missing/page' }, { remote: true, transport: 'stdio', sourceId: 'default', takesHoldersAllowList: ['world'] });
    expect(seen).toContain(true);
    seen.length = 0;
    await dispatchToolCall(engine, 'get_page', { slug: 'missing/page' }, { remote: false, transport: 'stdio', sourceId: 'default' });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).not.toContain(true);
  });
});
