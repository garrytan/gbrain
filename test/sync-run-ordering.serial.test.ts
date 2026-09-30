/**
 * Refactor wave 1, W4 sync (A17 + Eng contract "Sync"): controlled-order
 * tests for the SyncRun phases.
 *
 * Each test pins one interleaving between an awaited phase step and a
 * concurrent actor (the stall watchdog, a caller --timeout/SIGINT abort, the
 * SIGTERM cleanup pass, a commit landing mid-run), then asserts the DURABLE
 * state after a restart — a fresh engine on the same PGLite data directory —
 * not just the returned status: the bookmark (`sync.last_commit`), the
 * op-checkpoint rows, and that a resumed run converges without re-importing
 * banked files.
 *
 * Interleavings are forced with latches, never sleeps: `getPage(slug,
 * {includeDeleted: true})` is the first engine call of every per-file import
 * (src/core/import-file.ts), so holding it holds one file's import "in
 * flight"; `executeRawDirect` carries every checkpoint write
 * (src/core/op-checkpoint.ts). The stall watchdog runs on real timers with a
 * 1s budget and is observed through its stderr line.
 *
 * Serial: spawns git, mutates GBRAIN_SYNC_* env, drives the process-cleanup
 * SIGTERM handler, and shares one on-disk PGLite brain.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { execSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BrainEngine } from '../src/core/engine.ts';
import { loadOpCheckpoint, syncFingerprint } from '../src/core/op-checkpoint.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { _resetForTests as resetProcessCleanup, installSignalHandlers } from '../src/core/process-cleanup.ts';
import { performSync } from '../src/commands/sync.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const ENV_KEYS = [
  'GBRAIN_SYNC_STALL_ABORT_SECONDS',
  'GBRAIN_SYNC_CHECKPOINT_EVERY',
  'GBRAIN_SYNC_CHECKPOINT_SECONDS',
] as const;

let brainDir: string;
let engine: PGLiteEngine;
let repoPath: string;

async function openEngine(init: boolean): Promise<PGLiteEngine> {
  const e = new PGLiteEngine();
  await e.connect({ engine: 'pglite', database_path: join(brainDir, 'brain.pglite') });
  if (init) await e.initSchema();
  return e;
}

/** Restart: drop the engine and reopen the same (already initialized) data directory. */
async function restart(): Promise<void> {
  await engine.disconnect();
  engine = await openEngine(false);
}

function git(args: string): string {
  return execSync(`git ${args}`, { cwd: repoPath, stdio: 'pipe' }).toString().trim();
}

function commitPages(names: string[], msg: string): string {
  mkdirSync(join(repoPath, 'notes'), { recursive: true });
  for (const n of names) writeFileSync(join(repoPath, 'notes', `${n}.md`), `---\ntype: concept\ntitle: ${n}\n---\n\nBody for ${n}.\n`);
  git('add -A');
  git(`commit -q -m ${JSON.stringify(msg)}`);
  return git('rev-parse HEAD');
}

async function bookmark(): Promise<string | null> {
  return engine.getConfig('sync.last_commit');
}

async function banked(lastCommit: string): Promise<string[]> {
  return (await loadOpCheckpoint(engine, { op: 'sync', fingerprint: syncFingerprint({ lastCommit }) })).sort();
}

async function pinned(lastCommit: string): Promise<string[]> {
  return loadOpCheckpoint(engine, { op: 'sync-target', fingerprint: syncFingerprint({ lastCommit }) });
}

type Gate = { reached: Promise<string>; release: () => void };

/**
 * Hold the Nth per-file import at its first engine call (one import may read
 * its page more than once; only the first read of each slug counts). Returns
 * the gate and a restore handle; `imported` records every slug whose import
 * started, in order.
 */
function latchImport(target: BrainEngine, nth: number): { gate: Gate; imported: string[]; restore: () => void } {
  const orig = target.getPage;
  const imported: string[] = [];
  let release!: () => void;
  let reach!: (slug: string) => void;
  const held = new Promise<void>((r) => { release = r; });
  const reached = new Promise<string>((r) => { reach = r; });
  target.getPage = async function (this: BrainEngine, slug: string, opts?: Parameters<BrainEngine['getPage']>[1]) {
    if (opts && (opts as { includeDeleted?: boolean }).includeDeleted === true && !imported.includes(slug)) {
      imported.push(slug);
      if (imported.length === nth) { reach(slug); await held; }
    }
    return orig.call(this, slug, opts);
  } as BrainEngine['getPage'];
  return { gate: { reached, release }, imported, restore: () => { target.getPage = orig; } };
}

/** Count per-file imports that start while `fn` runs. */
async function countImports<T>(fn: () => Promise<T>): Promise<{ value: T; imports: string[] }> {
  const { gate, imported, restore } = latchImport(engine, Number.MAX_SAFE_INTEGER);
  void gate;
  try { return { value: await fn(), imports: imported }; } finally { restore(); }
}

/** Capture stderr lines (serr routes through console.error) and resolve when one matches. */
function watchStderr(pattern: RegExp): { seen: Promise<void>; lines: string[]; restore: () => void } {
  const lines: string[] = [];
  let hit!: () => void;
  const seen = new Promise<void>((r) => { hit = r; });
  const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    const line = args.map(String).join(' ');
    lines.push(line);
    if (pattern.test(line)) hit();
  });
  return { seen, lines, restore: () => spy.mockRestore() };
}

describe('SyncRun controlled-order interleavings (W4 sync, A17)', () => {
  beforeAll(async () => {
    brainDir = mkdtempSync(join(tmpdir(), 'gbrain-syncrun-order-'));
    engine = await openEngine(true);
  }, 120_000);

  afterAll(async () => {
    if (engine) await engine.disconnect();
    rmSync(brainDir, { recursive: true, force: true });
  }, 60_000);

  let c0: string;
  beforeEach(async () => {
    await resetPgliteState(engine);
    repoPath = mkdtempSync(join(tmpdir(), 'gbrain-syncrun-repo-'));
    execSync('git init -q', { cwd: repoPath });
    git('config user.email "test@example.com"');
    git('config user.name "Test"');
    commitPages(['base'], 'initial');
    const first = await performSync(engine, { repoPath, full: true, noPull: true, noEmbed: true });
    expect(first.status).toBe('first_sync');
    c0 = (await bookmark())!;
    process.env.GBRAIN_SYNC_CHECKPOINT_EVERY = '1';
  }, 60_000);

  afterEach(() => {
    for (const k of ENV_KEYS) delete process.env[k];
    rmSync(repoPath, { recursive: true, force: true });
  });

  test('watchdog fires while an import is in flight: the file completes, partial stall_timeout, banked work survives restart', async () => {
    process.env.GBRAIN_SYNC_STALL_ABORT_SECONDS = '1';
    const c1 = commitPages(['a', 'b', 'c'], 'three');
    const { gate, imported, restore } = latchImport(engine, 2);
    const stderr = watchStderr(/no import progress for 1s — aborting \(stall watchdog\)/);
    try {
      const running = performSync(engine, { repoPath, noPull: true, noEmbed: true });
      const inFlight = await gate.reached;
      await stderr.seen; // the watchdog fired while file 2 was still awaiting
      gate.release();
      const res = await running;
      expect(res.status).toBe('partial');
      expect(res.reason).toBe('stall_timeout');
      expect(res.filesImported).toBe(2); // the in-flight file finished (no mid-import kill)
      expect(imported.length).toBe(2); // the drain stopped before file 3
      expect(await engine.getPage(inFlight)).not.toBeNull();
    } finally { stderr.restore(); restore(); }

    await restart();
    expect(await bookmark()).toBe(c0); // never advanced on a partial
    expect((await banked(c0)).length).toBe(2);
    expect(await pinned(c0)).toEqual([c1]);

    delete process.env.GBRAIN_SYNC_STALL_ABORT_SECONDS;
    const resumed = await countImports(() => performSync(engine, { repoPath, noPull: true, noEmbed: true }));
    expect(resumed.value.status).toBe('synced');
    expect(resumed.imports.length).toBe(1); // only the unbanked file re-enters the drain
    expect(await bookmark()).toBe(c1);
    expect(await banked(c0)).toEqual([]);
    for (const s of ['notes/a', 'notes/b', 'notes/c']) expect(await engine.getPage(s)).not.toBeNull();
  }, 60_000);

  test('the in-flight import completes before the watchdog budget: progress resets and the run converges', async () => {
    process.env.GBRAIN_SYNC_STALL_ABORT_SECONDS = '1';
    const c1 = commitPages(['a', 'b', 'c'], 'three');
    const { gate, restore } = latchImport(engine, 2);
    const stderr = watchStderr(/stall watchdog/);
    try {
      const running = performSync(engine, { repoPath, noPull: true, noEmbed: true });
      await gate.reached;
      gate.release(); // completes well inside the 1s budget
      const res = await running;
      expect(res.status).toBe('synced');
      expect(stderr.lines.some((l) => /stall watchdog/.test(l))).toBe(false);
    } finally { stderr.restore(); restore(); }

    await restart();
    expect(await bookmark()).toBe(c1);
    expect(await banked(c0)).toEqual([]);
    expect(await pinned(c0)).toEqual([]);
  }, 60_000);

  test('caller abort lands while an import is awaiting: the next per-file check stops the drain with partial timeout', async () => {
    const c1 = commitPages(['a', 'b', 'c'], 'three');
    const ac = new AbortController();
    const { gate, imported, restore } = latchImport(engine, 2);
    try {
      const running = performSync(engine, { repoPath, noPull: true, noEmbed: true, signal: ac.signal });
      await gate.reached;
      ac.abort();
      gate.release();
      const res = await running;
      expect(res.status).toBe('partial');
      expect(res.reason).toBe('timeout');
      expect(res.filesImported).toBe(2);
      expect(res.bankedFiles).toBe(2);
      expect(imported.length).toBe(2);
    } finally { restore(); }

    await restart();
    expect(await bookmark()).toBe(c0);
    expect((await banked(c0)).length).toBe(2);
    expect(await pinned(c0)).toEqual([c1]);
    const resumed = await countImports(() => performSync(engine, { repoPath, noPull: true, noEmbed: true }));
    expect(resumed.value.status).toBe('synced');
    expect(resumed.imports.length).toBe(1);
    expect(await bookmark()).toBe(c1);
  }, 60_000);

  test('caller abort lands during the LAST import: the drain finishes and the post-drain check still refuses to advance', async () => {
    const c1 = commitPages(['a', 'b', 'c'], 'three');
    const ac = new AbortController();
    const { gate, imported, restore } = latchImport(engine, 3);
    try {
      const running = performSync(engine, { repoPath, noPull: true, noEmbed: true, signal: ac.signal });
      await gate.reached;
      ac.abort();
      gate.release();
      const res = await running;
      expect(res.status).toBe('partial');
      expect(res.reason).toBe('timeout');
      expect(res.filesImported).toBe(3);
      expect(imported.length).toBe(3);
    } finally { restore(); }

    await restart();
    expect(await bookmark()).toBe(c0); // D-V3-1: abort never advances last_commit
    expect((await banked(c0)).length).toBe(3);
    const resumed = await countImports(() => performSync(engine, { repoPath, noPull: true, noEmbed: true }));
    expect(resumed.value.status).toBe('synced');
    expect(resumed.imports).toEqual([]); // everything was banked; the resume only advances
    expect(await bookmark()).toBe(c1);
    expect(await banked(c0)).toEqual([]);
  }, 60_000);

  test('watchdog fires during a checkpoint write: the write lands, the banked count matches the durable rows', async () => {
    process.env.GBRAIN_SYNC_STALL_ABORT_SECONDS = '1';
    const c1 = commitPages(['a', 'b', 'c'], 'three');
    const orig = engine.executeRawDirect;
    let release!: () => void;
    let reach!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const reached = new Promise<void>((r) => { reach = r; });
    let pathWrites = 0;
    engine.executeRawDirect = async function (this: BrainEngine, sql: string, params?: unknown[]) {
      if (Array.isArray(params) && params[0] === 'sync' && Array.isArray(params[2]) && ++pathWrites === 2) {
        reach();
        await held;
      }
      return orig.call(this, sql, params);
    } as BrainEngine['executeRawDirect'];
    const stderr = watchStderr(/no import progress for 1s — aborting \(stall watchdog\)/);
    try {
      const running = performSync(engine, { repoPath, noPull: true, noEmbed: true });
      await reached; // the second file's checkpoint flush is mid-write
      await stderr.seen; // the watchdog fired during the write
      release();
      const res = await running;
      expect(res.status).toBe('partial');
      expect(res.reason).toBe('stall_timeout');
      expect(res.bankedFiles).toBe(2);
      expect(res.filesImported).toBe(2);
    } finally { stderr.restore(); engine.executeRawDirect = orig; }

    await restart();
    expect(await bookmark()).toBe(c0);
    expect((await banked(c0)).length).toBe(2); // the in-flight write is durable and counted exactly once
    expect(await pinned(c0)).toEqual([c1]);
  }, 60_000);

  test('SIGTERM cleanup banks the unflushed delta while an import is in flight', async () => {
    process.env.GBRAIN_SYNC_CHECKPOINT_EVERY = '1000'; // only the first-file flush fires on its own
    process.env.GBRAIN_SYNC_CHECKPOINT_SECONDS = '3600';
    const c1 = commitPages(['a', 'b', 'c', 'd'], 'four');
    const ac = new AbortController();
    const { gate, restore } = latchImport(engine, 4);
    const exits: number[] = [];
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => { exits.push(code ?? 0); }) as typeof process.exit);
    resetProcessCleanup();
    installSignalHandlers();
    try {
      const running = performSync(engine, { repoPath, noPull: true, noEmbed: true, signal: ac.signal });
      await gate.reached; // three files completed; only the first was flushed
      expect((await banked(c0)).length).toBe(1);
      process.emit('SIGTERM');
      for (let i = 0; i < 200 && exits.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
      expect(exits).toEqual([143]);
      // The cleanup pass banked the delta with no retry and moved nothing else.
      expect((await banked(c0)).length).toBe(3);
      expect(await bookmark()).toBe(c0);
      ac.abort();
      gate.release();
      const res = await running;
      expect(res.status).toBe('partial');
    } finally {
      restore();
      exitSpy.mockRestore();
      resetProcessCleanup();
    }

    await restart();
    expect(await bookmark()).toBe(c0);
    expect(await pinned(c0)).toEqual([c1]);
    delete process.env.GBRAIN_SYNC_CHECKPOINT_EVERY;
    delete process.env.GBRAIN_SYNC_CHECKPOINT_SECONDS;
    const resumed = await countImports(() => performSync(engine, { repoPath, noPull: true, noEmbed: true }));
    expect(resumed.value.status).toBe('synced');
    expect(resumed.imports).toEqual([]); // partial() banked the last file too
    expect(await bookmark()).toBe(c1);
  }, 60_000);

  test('a commit landing mid-drain: the bookmark advances to the pin, and the next run picks up the new commit', async () => {
    const c1 = commitPages(['a', 'b'], 'two');
    const { gate, restore } = latchImport(engine, 1);
    let c2 = '';
    try {
      const running = performSync(engine, { repoPath, noPull: true, noEmbed: true });
      await gate.reached;
      c2 = commitPages(['late'], 'forward commit during the drain');
      gate.release();
      const res = await running;
      expect(res.status).toBe('synced');
      expect(res.toCommit).toBe(c1);
    } finally { restore(); }

    await restart();
    expect(await bookmark()).toBe(c1); // pinned target, not live HEAD
    expect(await engine.getPage('notes/late')).toBeNull();
    const next = await countImports(() => performSync(engine, { repoPath, noPull: true, noEmbed: true }));
    expect(next.value.status).toBe('synced');
    expect(next.imports).toEqual(['notes/late']);
    expect(await bookmark()).toBe(c2);
  }, 60_000);

  test('a gc\'d bookmark object falls back to full sync: the bookmark reaches HEAD, removed files are reconciled, and a restart is up to date', async () => {
    const opts = { repoPath, noPull: true, noEmbed: true, sourceId: 'default' } as const;
    const sourceAnchor = async () =>
      (await engine.executeRaw<{ last_commit: string | null }>(`SELECT last_commit FROM sources WHERE id = 'default'`))[0]?.last_commit ?? null;
    await performSync(engine, { ...opts, full: true });
    commitPages(['keep', 'gone'], 'two');
    expect((await performSync(engine, opts)).status).toBe('synced');
    const stored = (await sourceAnchor())!;
    // Rewrite history so the stored bookmark object no longer exists anywhere;
    // the rewritten line still commits gone.md before deleting it (a file that
    // was never committed is kept as DB-only content, #2426).
    git('checkout -q --orphan rewritten');
    git('add -A');
    git('commit -q -m rewritten');
    git('rm -q notes/gone.md');
    git('commit -q -m "remove gone"');
    git('branch -D master 2>/dev/null || git branch -D main 2>/dev/null || true');
    git('reflog expire --expire=now --all');
    git('gc -q --prune=now');
    const head = git('rev-parse HEAD');
    expect(() => git(`cat-file -t ${stored}`)).toThrow();

    const stderr = watchStderr(/object missing \(gc'd after history rewrite\)\. Running full reimport\./);
    let res;
    try { res = await performSync(engine, opts); } finally { stderr.restore(); }
    expect(stderr.lines.some((l) => /Running full reimport/.test(l))).toBe(true);
    expect(res.status).toBe('first_sync');
    expect(res.deleted).toBe(1);

    await restart();
    expect(await sourceAnchor()).toBe(head);
    expect(await engine.getPage('notes/gone')).toBeNull();
    expect(await engine.getPage('notes/keep')).not.toBeNull();
    expect((await performSync(engine, opts)).status).toBe('up_to_date');
  }, 90_000);
});
