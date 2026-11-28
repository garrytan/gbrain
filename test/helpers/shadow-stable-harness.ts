/**
 * A serving process and a shadow child in ONE process, joined by the real supervisor and the real follower: the
 * supervisor's `spawn` hands back pipes into `runShadowChild`, whose Rust engine and follow store are fakes the test
 * steers. Used by test/shadow-privacy.test.ts and test/shadow-rerun.test.ts (no Rust addon needed).
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import type { BrainEngine } from '../../src/core/engine.ts';
import { withoutCallerAccess } from '../../src/core/search/private-visibility.ts';
import { attachShadowParts, type AttachedShadow, type AttachShadowDeps } from '../../src/shadow/attach.ts';
import { runShadowChild, type ShadowChildDeps } from '../../src/shadow/child.ts';
import type { FollowStore } from '../../src/shadow/follow-child.ts';
import { writeSeedRecord, type SeedRecord } from '../../src/shadow/seed.ts';

export const SEED = { version: 1, seed_id: 'seed-1', started_at: '2026-01-01T00:00:00.000Z', finished_at: '2026-01-01T00:01:00.000Z', unseeded_gap_rows_total: 0, unseeded_gap_rows: {}, relations: {}, digests: true } as unknown as SeedRecord;
const APPLIED = { upserted: 1, deleted: 0, skipped_older: 0, displaced: 0, dropped: 0, unmapped_columns: [], losses: {} };
export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(fn: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) { if (Date.now() > end) throw new Error('timed out waiting'); await sleep(10); }
}

export interface Rig {
  dir: string;
  attached: AttachedShadow<BrainEngine>;
  /** The wrapped primary: reads through it are mirrored at sample rate 1. */
  engine: BrainEngine;
  /** Rust's answers, by member; change them between reads. */
  rust: Record<string, (...args: unknown[]) => unknown>;
  /** Everything the fake follow store was asked to apply, in order. */
  applied: Array<{ relation: string; keys: number }>;
  /** The rows the child has recorded so far (before they are flushed to the ledger). */
  rows(): Array<Record<string, unknown>>;
  /** The unresolved rows (`rerun: 'pending'`) the child wrote before their reruns started. */
  pending(): Array<Record<string, unknown>>;
  /** Every control line the children wrote to the serving process, and every `answer` line the serving process wrote back. */
  control: { fromChild: string[]; answers: string[] };
  /** Ends the running child the way a crash does (no flush, no completion rows); the next send starts a new one. */
  killChild(): void;
  /** Starts the child and makes its coverage watermark valid, as a finished reconcile pass would. */
  settled(): Promise<void>;
  /** Why mirroring had stopped when `finish` was called (the privacy pause), else null. */
  stoppedBy: string | null;
  /** Waits until the child has recorded `n` rows, ends it (it flushes) and returns them. */
  finish(n?: number): Promise<Array<Record<string, unknown>>>;
  cleanup(): void;
}

export interface RigOptions {
  primary: BrainEngine;
  /** The follow store's calls; default applies and reports one upserted row. */
  store?: Partial<FollowStore>;
  child?: Partial<ShadowChildDeps>;
  /** Supervisor options a test shortens (the heartbeat watchdog window). */
  supervisor?: Record<string, unknown>;
  /** Keep the brain unseeded: no follower, no epoch. */
  unseeded?: boolean;
  /** A brain dir to reuse (a restart of the serving process on the same brain); default a new one. */
  dir?: string;
  /** More attach deps (the seal-check seam). */
  attach?: Partial<AttachShadowDeps>;
  /** Shadow state the rig attaches with (default: a PGLite primary, started_at 'x'). */
  state?: Record<string, unknown>;
}

export async function startRig(opts: RigOptions): Promise<Rig> {
  const o: RigOptions = { ...opts, child: { sleep: async () => {}, ...opts.child } }; // no wait before a rerun unless a test asks for one
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'gbrain-shadow-rig-'));
  if (!o.unseeded) writeSeedRecord(dir, SEED);
  const rust: Rig['rust'] = {};
  const applied: Rig['applied'] = [];
  const store: FollowStore = {
    replaceRelationRows: async (_id, relation, _gen, keys) => { applied.push({ relation: String(relation), keys: (keys as unknown[]).length }); return APPLIED; },
    replaceInterval: async () => APPLIED, relationDigest: async () => ({ rows: 0, digest: '' }), relationEntries: async () => [], allocatorCheck: async () => [],
    factFingerprints: async (texts) => texts.map(() => ({ fingerprint: 'a', fingerprint_v1: 'b' })),
    seedPlan: async () => ({ relations: [{ relation: 'config', key: ['key'], removable: true }], carried: [], not_copied: [], gap_columns: [] }) as never,
    ...o.store,
  };
  const engine = new Proxy({ async connect() {}, async disconnect() {}, storeFor: async () => store, ownerRole: null } as Record<string, unknown>, {
    get: (target, prop) => (typeof prop === 'string' && prop in rust ? rust[prop] : Reflect.get(target, prop)),
  });
  let childDone: Promise<number> | null = null;
  const control = { fromChild: [] as string[], answers: [] as string[] };
  const procs: Array<EventEmitter & { stdin: PassThrough; stdout: PassThrough }> = [];
  const spawn = ((_command: string, _args: string[], options: { env?: Record<string, string | undefined> }): ChildProcess => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const proc = Object.assign(new EventEmitter(), { stdin, stdout, stderr: null, pid: 4242, unref() {}, kill() {} });
    procs.push(proc);
    const write = stdin.write.bind(stdin) as (chunk: unknown, ...rest: unknown[]) => boolean;
    (stdin as unknown as { write: typeof write }).write = (chunk: unknown, ...rest: unknown[]) => { if (String(chunk).startsWith('{"t":"answer"')) control.answers.push(String(chunk)); return write(chunk, ...rest); };
    childDone = withoutCallerAccess(() => runShadowChild(dir, {
      input: stdin, writeControl: (line) => { control.fromChild.push(line); stdout.write(line); }, heartbeatMs: 60_000, childId: 'rig',
      loadAddon: async () => ({ ok: true as const, addon: { target: 'linux-x64-glibc', engineAbi: 1, engineBuild: 'b1', catalogVersion: 3 } as never }),
      addonSha256: () => 'a'.repeat(64), capabilities: () => ['pages'], readinessPolicyHash: () => 'p1',
      openEngine: () => engine as never, session: options.env?.GBRAIN_SHADOW_SESSION, onRow: (row) => { (row.rerun === 'pending' ? waiting : seen).push({ ...row }); }, ...o.child,
    })); // a real child is another process: it inherits no caller record from the writer's async context
    return proc as unknown as ChildProcess;
  }) as never;
  const state = o.state ?? { version: 1, enabled: true, started_at: 'x', sample_rate: 1, queue_bound: 64, plan_hash: 'h', brain: 'b', primary_engine: 'pglite' };
  const attached = attachShadowParts(o.primary, dir, state as never, { gbrainArgv: ['never'], ...o.attach, supervisor: { spawn: spawn as never, stillEnabled: () => true, minBackoffMs: 0, maxBackoffMs: 0, ...o.supervisor } });
  await attached.lsnWatch.ready(); // a sample captured from here on carries the freshness token it is held to
  const seen: Array<Record<string, unknown>> = [];
  const waiting: Array<Record<string, unknown>> = [];
  const rows = (): Array<Record<string, unknown>> => seen;
  mkdirSync(join(dir, 'evidence'), { recursive: true });
  const rig: Rig = {
    dir, attached, engine: attached.engine, rust, applied, rows, pending: () => waiting, control, stoppedBy: null,
    killChild() { const p = procs[procs.length - 1]!; p.stdout.end(); p.emit('exit', 137, 'SIGKILL'); },
    async settled() {
      await attached.supervisor.request('state');
      await attached.supervisor.request('watermark', { since: Date.now() + 1 });
    },
    async finish(n = 1) {
      await until(() => seen.length >= n);
      rig.stoppedBy = attached.supervisor.disabled;
      attached.supervisor.stop();
      await childDone;
      return rows();
    },
    cleanup() { attached.supervisor.stop(); attached.reconciler?.stop(); rmSync(dir, { recursive: true, force: true }); },
  };
  return rig;
}

export const gate = () => { let open!: () => void; const wait = new Promise<void>((resolve) => { open = resolve; }); return { wait, open }; };
export const batch = (seq: number, items: unknown[]) => ({ seq, committed_at: Date.now(), items: items as never });
/** One read through the wrapped primary, which the child compares against the Rust fake. */
export const sample = (rig: Rig) => rig.engine.listPages({ limit: 100 });

/**
 * A commit that is none of the test's own (autovacuum, another session on a shared cluster) moves the primary's freshness token, and a
 * check that expects a POSITIVE outcome (proven, clean, cleared, a violation found) is then asked again from a new capture, read and check, as
 * production does when it reruns a moved sample. Runs `attempt` up to `attempts` times: `moved(result)` says a result was refused as moved,
 * and an attempt that throws an error coded `moved` counts too. Fails when every attempt moved. A test that expects `moved` never uses this:
 * it must see it on the first try.
 */
export async function untilNotMoved<T>(attempt: () => Promise<T>, moved: (result: T) => boolean = () => false, attempts = 5): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await attempt();
      if (!moved(result)) return result;
      last = result;
    } catch (error) {
      if ((error as { code?: string } | null)?.code !== 'moved') throw error;
      last = error;
    }
  }
  let shown: string;
  try { shown = JSON.stringify(last) ?? String(last); } catch { shown = String(last); }
  throw new Error(`the freshness token moved on all ${attempts} attempts; the last one: ${shown.slice(0, 600)}`);
}
