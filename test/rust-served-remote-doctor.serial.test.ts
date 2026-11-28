/**
 * A remote run_doctor over the served wire (multi-user lane L3, slice S1): an agent-facing (remote) admin caller of a
 * served client runs doctor, and doctor crosses as ONE whole operation (`runOperation`) that the brain server runs as the
 * owner (rust-engine/served/remote-whole-ops.ts REMOTE_WHOLE_OPERATIONS).
 *
 * Mode: the owner opens with GBRAIN_RUST_MULTIUSER=1 set in-run (after the preload); the test asserts its store reports
 * `multiuser: true` and the client reports `served` and `multi_writer`.
 *
 * 1. Protects:
 *    - while the doctor handler runs on the client, the client sends exactly one frame, `fn runOperation run_doctor`, and
 *      no member call (test-local recorder on the client's connection, counted only inside the handler's invocation
 *      window; the MCP dispatch's own access reads before the handler are outside it and still run);
 *    - the served report equals the report the same remote call gives in process on the owner engine, as canonical JSON
 *      (sorted keys, timings and timestamps normalized), in the three report forms (focused, tier ops, page-class checks);
 *    - no check says "Unknown: this check could not run for the remote caller";
 *    - no local-only data reaches the remote caller: a private page body, a config value and the brain's directory never
 *      appear in any report;
 *    - the server checks the claimed grant's scope: a claim without admin is refused `permission_denied` with reason
 *      `scope_missing` and the doctor handler never runs on the server; an admin claim runs it once;
 *    - replay (served/session.ts): a run_doctor whose answer was lost and whose request record is gone (a restart or an
 *      eviction) runs again and makes no second write of its own: no doctor-last-known checkpoint row, no queued
 *      doctor-refresh job, no page. Every doctor run, on every engine, refreshes one derived cache, the fence census
 *      (fence_integrity's scan record); the replay refreshes it exactly as a second call does (the same write members
 *      and the same number of commits), and writes nothing else. A lost add_tag (a write the journal does not cover)
 *      still ends `outcome_unknown` and never runs again.
 * 2. Fails on: a client that runs doctor itself (member frames, refused reads, "could not run" checks), a served report
 *    that differs from the in-process one, local-only data in a report, a non-admin claim that runs doctor, a lost
 *    run_doctor that cannot be replayed or that writes more than a second call (or anything but the fence census) when
 *    replayed, or a replay rule that lets a lost write run again.
 * 3. Seam: none below the engine: a real owner, a real v3 listener, a real served client, the MCP dispatch. The frame
 *    recorder and the handler counter are test-local wrappers on the client's connection object and the registered
 *    operation; no production code changes for them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import net, { type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LAST_KNOWN_OP, REFRESH_JOB } from '../src/commands/doctor/last-known.ts';
import { PAGE_CHECK_NAMES } from '../src/core/doctor-categories.ts';
import { IGNORED_WRITE_MEMBERS, UNMAPPED_WRITE_MEMBERS, memberKind } from '../src/shadow/write-map.ts';
import { operationsByName } from '../src/core/operations.ts';
import { withRemoteCaller } from '../src/core/remote-caller.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { decodeError, encodeValue, type Wire } from '../src/core/rust-engine/owner-ipc/codec.ts';
import { OWNER_RUN_OPERATION } from '../src/core/rust-engine/owner-ipc/forwarded-names.ts';
import { byteBudget, encodeLengthFrame, readLengthFrames } from '../src/core/rust-engine/served/framing.ts';
import { listenServed, type ServedListener } from '../src/core/rust-engine/served/listener.ts';
import { storePositionReader } from '../src/core/rust-engine/served/positions.ts';
import { servedConnectionOf } from '../src/core/rust-engine/served/store-returning.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { loadRustArmAddon, rustArmAddonPath } from './engine-parity/rust-arm.ts';

const HAVE_ADDON = existsSync(rustArmAddonPath());
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${rustArmAddonPath()} does not exist`);
const describeAddon = HAVE_ADDON ? describe : describe.skip;

const saved = process.env.GBRAIN_RUST_MULTIUSER;
const TOKEN = 'remote-doctor-owner-token';
const STDIO = { remote: true, admissionOrigin: 'interactive', transport: 'stdio', takesHoldersAllowList: ['world'], sourceId: 'default' } as const;
const SECRET_BODY = 'doctor-marker-private-body-7f3a';
const SECRET_CONFIG = 'doctor-marker-config-value-91c2';
const COULD_NOT_RUN = 'Unknown: this check could not run for the remote caller';
const FORMS: Array<Record<string, unknown>> = [{}, { tier: 'ops' }, { only: [...PAGE_CHECK_NAMES] }];
const formName = (params: Record<string, unknown>) => Object.keys(params).join(',') || 'focused';
type Conn = { request(kind: 'call' | 'fn', member: string, args: unknown[], opts?: { txn?: string }): Promise<unknown> };
type ReportCheck = { name?: unknown; message?: unknown };
type Form = { form: string; frames: string[]; error: boolean; text: string; inProcess: string };
let dir = '';
let owner: RustEngine;
let listener: ServedListener;
let client: RustEngine;
const forms: Form[] = [];
let depth = 0;
let invocations = 0;
let frames: string[] = [];
let restore: () => void = () => undefined;

/** The report text of a tool result. */
const textOf = (out: { content: Array<{ text?: string }> }) => out.content.map(c => c.text ?? '').join('\n');

/** Canonical JSON: sorted keys; timings (`*_ms`, `elapsed*`, `duration*`) and ISO timestamps normalized. */
function canonical(text: string): string {
  const norm = (value: unknown, key = ''): unknown => {
    if (Array.isArray(value)) return value.map(v => norm(v));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort().map(k => [k, norm((value as Record<string, unknown>)[k], k)]));
    }
    if (typeof value === 'number' && /(_ms|^elapsed|^duration|_seconds)$/i.test(key)) return 0;
    if (typeof value === 'string') return value.replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)/g, '<ts>').replace(/\b\d+(\.\d+)?\s?ms\b/g, '<n>ms');
    return value;
  };
  let body: unknown;
  try { body = JSON.parse(text); } catch { return text; }
  return JSON.stringify(norm(body), null, 1);
}

function checksOf(text: string): ReportCheck[] {
  try {
    const checks = (JSON.parse(text) as { checks?: unknown }).checks;
    return Array.isArray(checks) ? checks as ReportCheck[] : [];
  } catch { return []; }
}

/** The code, reason and detail of a refused call (undefined when it resolved). */
async function refusalOf(call: Promise<unknown>): Promise<{ code: unknown; reason: unknown; ranFalse: boolean } | undefined> {
  try { await call; return undefined; } catch (error) {
    const e = error as { code?: unknown; reason?: unknown; detail?: unknown; envelope?: { reason?: unknown; detail?: unknown } };
    const detail = String(e.detail ?? e.envelope?.detail ?? '');
    return { code: e.code, reason: e.reason ?? e.envelope?.reason, ranFalse: detail.includes('ran=false') };
  }
}

/** A raw protocol v3 peer of the listener, past its hello as the owner (the test sends frames by hand). */
function rawPeer(): Promise<{ socket: Socket; send(frame: object): void; next(): Promise<Record<string, unknown>> }> {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: '127.0.0.1', port: listener.port }, () => {
      const queue: Record<string, unknown>[] = [];
      const waiters: Array<(f: Record<string, unknown>) => void> = [];
      readLengthFrames(socket, { maxFrameBytes: () => 1 << 26, budget: byteBudget(1 << 30), onFrame: f => { const w = waiters.shift(); if (w) w(f); else queue.push(f); }, onBad: () => {} });
      const peer = { socket, send: (f: object) => { socket.write(encodeLengthFrame(f)!); }, next: () => queue.length ? Promise.resolve(queue.shift()!) : new Promise<Record<string, unknown>>(r => waiters.push(r)) };
      peer.send({ t: 'hello', v: 3, version: 3, caps: ['request_ids', 'positions'], auth: { scheme: 'bearer', token: TOKEN } });
      void peer.next().then(() => resolve(peer));
    });
    socket.on('error', () => {});
  });
}

/** What a second run would have written: doctor-last-known rows, queued doctor-refresh jobs, the durable commit sequence. */
async function writeMarks(): Promise<{ lastKnown: number; refreshJobs: number; pages: number; sequence: number }> {
  return {
    lastKnown: (await owner.readDoctorLastKnown(LAST_KNOWN_OP)).length,
    refreshJobs: (await owner.listJobs({ name: REFRESH_JOB })).length,
    pages: (await owner.getAllSlugs()).size,
    sequence: (await storePositionReader(owner)())?.sequence ?? -1,
  };
}

/** The fence census cache every doctor run refreshes (fence_integrity; src/core/fence-repair/census-store.ts). */
const FENCE_CENSUS_WRITES = new Set(['clearFenceCandidateParts', 'upsertFenceCandidatePart', 'writeFenceScanRecord']);

/** Runs `fn` and answers the owner engine's write members it called (test-local wrappers, restored after). */
async function ownerWrites(fn: () => Promise<unknown>): Promise<string[]> {
  const called = new Set<string>();
  const names = new Set<string>();
  for (let o: object | null = owner; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) for (const n of Object.getOwnPropertyNames(o)) names.add(n);
  const own = new Map<string, PropertyDescriptor | undefined>();
  const target = owner as unknown as Record<string, unknown>;
  for (const n of names) {
    const f = target[n];
    const write = memberKind(n) === 'mapped' || UNMAPPED_WRITE_MEMBERS.has(n) || IGNORED_WRITE_MEMBERS.has(n);
    if (n === 'constructor' || typeof f !== 'function' || !write) continue;
    own.set(n, Object.getOwnPropertyDescriptor(owner, n));
    target[n] = function (this: unknown, ...a: unknown[]) { called.add(n); return (f as (...x: unknown[]) => unknown).apply(this, a); };
  }
  try { await fn(); } finally {
    for (const [n, d] of own) { if (d) Object.defineProperty(owner, n, d); else delete target[n]; }
  }
  return [...called].sort();
}

describeAddon('a remote run_doctor over the served wire', () => {
  beforeAll(async () => {
    process.env.GBRAIN_RUST_MULTIUSER = '1';
    dir = mkdtempSync(join(tmpdir(), 'gbrain-remote-doctor-'));
    owner = openRustEngine({ addon: await loadRustArmAddon(), databasePath: dir, servedOptions: {
      verify: {
        verify: async (_engine, t) => { if (t !== TOKEN) throw new Error('Invalid token'); return { principal: { kind: 'legacy_token', id: 'owner' }, scopes: ['read', 'write', 'admin'], sourceId: 'default', hasSourceGrant: false, member: null, mayActFor: null, attest: null }; },
        ownerIds: async () => new Set(['owner']),
      },
    } });
    await owner.connect({ engine: 'rust', database_path: dir } as never);
    await owner.putPage('notes/secret', { type: 'note', title: 'Secret', compiled_truth: SECRET_BODY, timeline: '', frontmatter: { visibility: 'private' } } as never);
    await owner.setConfig('doctor.test_marker', SECRET_CONFIG);
    listener = await listenServed(owner.ownerServer()!, { host: '127.0.0.1', port: 0 });
    client = openRustEngine({ addon: await loadRustArmAddon(), databasePath: dir, served: { url: `gbrain+tcp://127.0.0.1:${listener.port}`, token: TOKEN } });
    await client.connect({ engine: 'rust', database_path: dir } as never);

    // Test-local instrumentation: the doctor handler's invocation window (the registered operation, which the client's
    // dispatch and the server's runOperation both call in this one process) and every request the client's connection
    // is asked to send while that window is open.
    const op = operationsByName.run_doctor!;
    const handler = op.handler;
    op.handler = async (ctx, params) => {
      depth++; invocations++;
      try { return await handler(ctx, params); } finally { depth--; }
    };
    const conn = servedConnectionOf(client) as unknown as Conn;
    const request = conn.request;
    conn.request = (kind, member, args, opts) => {
      if (depth > 0) frames.push(kind === 'fn' && member === OWNER_RUN_OPERATION ? `fn ${member} ${String(args[0])}` : `${kind} ${member}`);
      return request(kind, member, args, opts);
    };
    restore = () => { op.handler = handler; conn.request = request; };

    for (const params of FORMS) {
      frames = [];
      const out = await dispatchToolCall(client, 'run_doctor', params, STDIO as never);
      const seen = frames;
      frames = [];
      const local = await dispatchToolCall(owner, 'run_doctor', params, STDIO as never);
      forms.push({ form: formName(params), frames: seen, error: out.isError === true, text: textOf(out), inProcess: textOf(local) });
    }
  }, 300_000);

  afterAll(async () => {
    restore();
    await client?.disconnect().catch(() => undefined);
    await listener?.close().catch(() => undefined);
    await owner?.disconnect().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.GBRAIN_RUST_MULTIUSER; else process.env.GBRAIN_RUST_MULTIUSER = saved;
  });

  test('the owner runs multi-user and the client is a served multi-writer client', () => {
    expect({ multiuser: owner.openStore('remote-doctor').multiuser, served: client.capabilities.has('served'), mw: client.capabilities.has('multi_writer') })
      .toEqual({ multiuser: true, served: true, mw: true });
  });

  // Value: protects=run_doctor crosses whole; fails_when=the client runs doctor itself and sends (or refuses) member calls; why_new=the client ran doctor and refused its local-only reads
  test('inside the doctor handler the client sends exactly one runOperation run_doctor frame and no member call, in each form', () => {
    expect(forms.map(f => ({ form: f.form, error: f.error, frames: f.frames })))
      .toEqual(FORMS.map(p => ({ form: formName(p), error: false, frames: [`fn ${OWNER_RUN_OPERATION} run_doctor`] })));
  });

  // Value: protects=a served remote doctor reports what the owner's in-process remote doctor reports; fails_when=a check differs or could not run; why_new=no test compared the two reports
  test('the served report equals the in-process remote report on the owner engine (canonical JSON), and no check says it could not run', () => {
    for (const f of forms) {
      expect({ form: f.form, hasChecks: checksOf(f.text).length > 0 }).toEqual({ form: f.form, hasChecks: true });
      expect({ form: f.form, report: canonical(f.text) }).toEqual({ form: f.form, report: canonical(f.inProcess) });
    }
    expect(forms.flatMap(f => checksOf(f.text).filter(c => typeof c.message === 'string' && c.message.startsWith(COULD_NOT_RUN))
      .map(c => `${f.form}:${String(c.name)}`))).toEqual([]);
  });

  test('no local-only data reaches the remote caller', () => {
    const text = forms.map(f => f.text).join('\n');
    expect({ body: text.includes(SECRET_BODY), config: text.includes(SECRET_CONFIG), dir: text.includes(dir) })
      .toEqual({ body: false, config: false, dir: false });
  });

  // Value: protects=the server checks the claimed grant's admin scope before doctor runs; fails_when=a non-admin claim runs doctor on the owner's floor; why_new=run_doctor is the first admin-scope remote whole operation
  test('a claim without admin is refused scope_missing and doctor never runs on the server; an admin claim runs it once', async () => {
    const conn = servedConnectionOf(client) as unknown as Conn;
    const send = (scopes: string[]) => withRemoteCaller(true, () => conn.request('fn', OWNER_RUN_OPERATION,
      ['run_doctor', {}, { sourceId: 'default', transport: 'http' }, { auth: { clientId: 'c', scopes } }]));
    invocations = 0;
    const refused = await refusalOf(send(['read', 'write']));
    const ranRefused = invocations;
    invocations = 0;
    const admin = await send(['read', 'write', 'admin']).then(v => ({ ok: true, value: v }), (e: unknown) => ({ ok: false, value: e }));
    expect({ refused, ranRefused, admin: admin.ok, ranAdmin: invocations })
      .toEqual({ refused: { code: 'permission_denied', reason: 'scope_missing', ranFalse: true }, ranRefused: 0, admin: true, ranAdmin: 1 });
  });

  // Value: protects=a lost run_doctor answer is replayed with no second write of its own, while a lost write still ends outcome_unknown; fails_when=run_doctor replay is refused, writes more than a second call, or the replay rule covers a write; why_new=run_doctor is the first whole operation replayed with no record
  test('a lost run_doctor runs again on replay with no second write of its own; a lost add_tag still ends outcome_unknown', async () => {
    await owner.putPage('notes/tagged', { type: 'note', title: 'Tagged', compiled_truth: 'Tag me.', timeline: '', frontmatter: {} } as never);
    const p = await rawPeer();
    const context = { sourceId: 'default', transport: 'stdio', admissionOrigin: 'interactive' };
    const frame = (id: number, args: unknown[], extra: object = {}) =>
      ({ t: 'fn', id, name: OWNER_RUN_OPERATION, args: encodeValue(args), req: Bun.randomUUIDv7(), remote: true, ...extra });
    const outcome = async () => {
      const reply = await p.next();
      if (reply.ok === true) return { ok: true };
      const e = decodeError(reply.error as Wire) as { code?: unknown; reason?: unknown };
      return { ok: false, code: e.code, reason: e.reason };
    };
    const doctor = ['run_doctor', {}, context, { auth: null }];
    // The first run answers. A second, fresh call measures what any doctor run writes.
    p.send(frame(1, doctor));
    const first = await outcome();
    const m1 = await writeMarks();
    let second: unknown;
    const secondWrites = await ownerWrites(async () => { p.send(frame(2, doctor)); second = await outcome(); });
    const m2 = await writeMarks();
    // The answer of a call is then "lost": a retry under a request id the server has no record of.
    invocations = 0;
    let replay: unknown;
    const replayWrites = await ownerWrites(async () => { p.send(frame(3, doctor, { retry: true })); replay = await outcome(); });
    const ranReplay = invocations;
    const m3 = await writeMarks();
    const tag = ['add_tag', { slug: 'notes/tagged', tag: 'replayed' }, context, { auth: null }];
    p.send(frame(4, tag, { retry: true }));
    const lostWrite = await outcome();
    const m4 = await writeMarks();
    p.socket.destroy();
    expect({
      first, second, replay, ranReplay, lostWrite,
      replayWritesOnlyTheCensus: replayWrites.filter(n => !FENCE_CENSUS_WRITES.has(n)),
      replayWritesAsASecondCall: replayWrites, replayCommits: m3.sequence - m2.sequence,
      unchanged: { ...m3, sequence: 0 }, lostWriteCommits: m4.sequence - m3.sequence,
      tagged: (await owner.getTags('notes/tagged')).includes('replayed'),
    }).toEqual({
      first: { ok: true }, second: { ok: true }, replay: { ok: true }, ranReplay: 1,
      lostWrite: { ok: false, code: 'owner_unavailable', reason: 'outcome_unknown' },
      replayWritesOnlyTheCensus: [], replayWritesAsASecondCall: secondWrites, replayCommits: m2.sequence - m1.sequence,
      unchanged: { ...m1, sequence: 0 }, lostWriteCommits: 0, tagged: false,
    });
  });
});
