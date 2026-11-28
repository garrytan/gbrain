/**
 * Write comparisons, the shadow child's part (write-compare.ts has the design). Each full sample is replayed on a SCRATCH Rust
 * store: opened in a private directory of its own (see `scratchRootDefault`), seeded with the sample's preimage rows through `importRelation`,
 * given the same write, read back and deleted. The live shadow store and the primary are never touched, and no Rust code beyond
 * what the shadow already uses is involved. One sample runs at a time; a sample that finds the queue full, or a scratch run that
 * hangs, is counted `uncomparable`, never `comparable`.
 */
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { RustEngineAddonLoad } from '../core/rust-engine/addon-loader.ts';
import { openRustEngine, type RustEngineAddonHandle } from '../core/rust-engine.ts';
import { configDir } from '../core/config.ts';
import { safeCode } from './child-checks.ts';
import { decodeValue, encodeValue } from './codec.ts';
import { droppedWeight, pageRefs, pageSet, readBack, readBackText, SAVE_FAILURE_EXIT_MS, type WriteEvent, type WriteOutcome, type WriteTally } from './write-compare.ts';

/** Columns the seed always reports as unmapped and the typed read-back never shows (rust/docs/store/seed.md, "Some unmapped columns are expected": `pages.generation`, the primary's cache clock, and `pages.content_author` / `content_author_hash`, who wrote the text, which no typed read returns). */
const EXPECTED_UNMAPPED: ReadonlySet<string> = new Set(['generation', 'content_author', 'content_author_hash']);
/**
 * Replays waiting behind the one that runs: a sync sends a page sample every 15-25 ms and a replay takes about 42 ms, so a burst of 28 edits found room for 16 and shed 12 (`queue_full`).
 * 256 samples is about 11 s of replay (inside the 30 s exit deadline), a few MB for the usual few-KB sample; the byte bound holds the worst case (a sample line is at most 512 KB), counted at
 * the line's size (the parsed event is a few times larger in memory). A sample past either bound is still counted `uncomparable` / `queue_full` (except a disk-write failure, a known limit in the changelog), never dropped by the queue and never comparable.
 */
export const WRITE_QUEUE_BOUND = 256;
export const WRITE_QUEUE_BYTES = 16 * 1024 * 1024;
export const WRITE_COMPARE_TIMEOUT_MS = 30_000;

export interface WriteComparerDeps {
  dir: string;
  load: RustEngineAddonLoad;
  tally: WriteTally;
  /** False once the shadow directory is gone (`stop --delete`): nothing is created or counted then. */
  alive: () => boolean;
  openEngine?: (addon: RustEngineAddonHandle, path: string) => Record<string, any>;
  onError?: (where: string, error: unknown) => void;
  timeoutMs?: number;
  /** Where scratch stores are made; default `scratchRootDefault()` (a seam for tests). */
  scratchRoot?: string;
}

/**
 * Scratch stores hold copies of primary page content, which may be private: they live in the gbrain data home (the same disk and owner as the brain),
 * in a `scratch/` directory beside `shadow/`, never in a shared system temp directory and never under the shadow directory (so `stop --delete` and a
 * store that is still opening cannot undo each other, and a replay needs no drill lock). Shadow evidence itself holds no page content.
 */
export const scratchRootDefault = (): string => join(configDir(), 'scratch');
type Verdict = [WriteOutcome, string?];

export function createWriteComparer(d: WriteComparerDeps): { handle(event: WriteEvent, bytes?: number, qualifying?: number): void; unreadable(weight: number, qualifying: number): void; idle(): Promise<boolean>; abandon(): void; flush(): boolean; pass(): boolean; missing(n: number, nonqualifying?: number, windowLost?: number): void; finish(): boolean } {
  // Each replay gets a private (0700) directory named for this process, removed when the replay ends, whatever its outcome. Directories of processes
  // that no longer exist (a killed child) are swept here, at shadow start; another child never deletes a live one.
  const scratchRoot = d.scratchRoot ?? scratchRootDefault();
  const prefix = `write-compare-${process.pid}-`;
  try {
    mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
    chmodSync(scratchRoot, 0o700);
    for (const name of readdirSync(scratchRoot)) {
      const pid = /^write-compare-(\d+)-/.exec(name)?.[1];
      if (!pid || Number(pid) === process.pid) continue;
      try { process.kill(Number(pid), 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') rmSync(join(scratchRoot, name), { recursive: true, force: true }); }
    }
  } catch { /* silent-read-ok: an unreadable scratch directory only leaves old scratch stores behind; nothing is counted from it, and a replay then fails as uncomparable */ }
  d.tally.recover(); // a replay a killed process left unresolved
  let chain: Promise<void> = Promise.resolve();
  let queued = 0;
  let queuedBytes = 0;
  let runs = 0;
  let wedged = false;
  const waiting = new Set<WriteEvent>(); // queued replays that have not started

  async function replay(event: WriteEvent): Promise<Verdict> {
    if (!d.load.ok) return ['uncomparable', 'addon_unavailable'];
    if (!d.alive()) return ['uncomparable', 'shadow_dir_deleted'];
    if (event.moved) return ['uncomparable', 'moved']; // another write landed in between: neither verdict can be trusted, a match included
    const args = decodeValue(event.args) as unknown[];
    const pre = event.pre!;
    const targets = pageRefs(event.op, args);
    // A delete or a link removal compares nothing when the preimage lacks the page: the copy could not be validated.
    if (event.op === 'deletePage' && !pre.pages.some((p) => p.source_id === targets[0]!.source && p.slug === targets[0]!.slug)) return ['uncomparable', 'target_absent'];
    runs++;
    let run = ''; let engine: Record<string, any> | null = null;
    try {
      mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
      run = mkdtempSync(join(scratchRoot, prefix)); // mode 0700: the store, its lock and its socket all live in here and go together
      const dir = join(run, 'store');
      engine = (d.openEngine ?? ((addon, path) => openRustEngine({ addon, databasePath: path }) as unknown as Record<string, any>))(d.load.addon as RustEngineAddonHandle, dir);
      await engine.connect({ database_path: dir });
      const store = await engine.storeFor('seed');
      for (const [relation, rows] of [['sources', pre.sources], ['pages', pre.pages], ['links', pre.links]] as const) {
        if (!rows.length) continue;
        const done = await store.importRelation(`write-compare-${runs}`, relation, rows);
        // The scratch store must hold exactly the rows the primary held: a skipped, dropped or lossy import, or a column it does not keep, is not that copy.
        if (done.imported !== rows.length || done.skipped || done.dropped || Object.keys(done.losses).length || done.unmapped_columns?.some((c: string) => !EXPECTED_UNMAPPED.has(c))) return ['uncomparable', 'preimage_not_loaded'];
      }
      try { await engine[event.op](...args); for (const call of event.then ?? []) await engine.updatePageContextualRetrievalState(...decodeValue(call) as unknown[]); } catch (error) { d.onError?.('write', error); return ['uncomparable', `rust_write_failed`]; }
      const theirs = readBackText(encodeValue(await readBack(engine, targets, pageSet(targets, pre))));
      if (theirs === readBackText(event.post)) return ['comparable'];
      return ['unexplained_difference'];
    } finally {
      await engine?.disconnect().catch(() => undefined);
      if (run) try { rmSync(run, { recursive: true, force: true }); } catch { /* swept at the next shadow start */ }
    }
  }

  /** The page-and-link part of each queued sample's own weight (0 or 1), as the line's bytes stated it: its verdict settles that much of `settled_qualifying`. */
  const ownQualifying = new WeakMap<WriteEvent, number>();
  async function run(event: WriteEvent): Promise<void> {
    if (!waiting.delete(event)) return; // counted by abandon() at the exit deadline
    let verdict: Verdict;
    try {
      if (wedged) verdict = ['uncomparable', 'scratch_wedged'];
      else if (!d.tally.begin()) verdict = ['uncomparable', 'mark_unwritten']; // the in-flight mark is not on disk, so no replay runs: its verdict could be lost
      else {
        const work = replay(event);
        verdict = await new Promise<Verdict>((resolve, reject) => {
          const timer = setTimeout(() => { wedged = true; resolve(['uncomparable', 'timeout']); }, d.timeoutMs ?? WRITE_COMPARE_TIMEOUT_MS);
          work.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
        });
      }
    } catch (error) {
      d.onError?.('write', error);
      verdict = ['uncomparable', safeCode((error as { code?: unknown })?.code)];
    }
    d.tally.note(verdict[0], verdict[1], 1, true, 1, ownQualifying.get(event) ?? 0); // the replay is over: its verdict ends its in-flight mark and settles the sample's own weight (1)
  }

  return {
    /** `bytes`: the size of the line the sample arrived in (0 when not known). */
    handle(event, bytes = 0, qualifying = 0) {
      // A line stands for 1 + `dropped` owed samples (supervisor.ts sampleWeight): the earlier losses it carries settle here, at once, and the sample itself settles with its own last outcome, so each is credited once.
      // `qualifying`: the line's page-and-link part (write-compare.ts sampleQualifyingWeight on its bytes, as the serving process counted it); never more of it is settled as qualifying than that.
      const shed = droppedWeight(event.dropped);
      const shedQ = Math.min(shed, qualifying); const ownQ = Math.min(1, Math.max(0, qualifying - shedQ));
      if (shed > 0) d.tally.note('uncomparable', 'send_shed', shed, false, shed, shedQ);
      // The serving process can only report what it saw itself; a verdict (`comparable`, `unexplained_difference`) is made here, from a replay.
      if (event.outcome === 'capability_missing' || event.outcome === 'uncomparable') { d.tally.note(event.outcome, event.family ?? event.reason, 1, false, 1, ownQ); return; }
      if (!event.pre || !event.args) { d.tally.note('uncomparable', 'no_sample', 1, false, 1, ownQ); return; }
      if (queued >= WRITE_QUEUE_BOUND || queuedBytes + bytes > WRITE_QUEUE_BYTES) { d.tally.note('uncomparable', 'queue_full', 1, false, 1, ownQ); return; }
      ownQualifying.set(event, ownQ);
      queued++; queuedBytes += bytes; waiting.add(event);
      chain = chain.then(() => run(event)).finally(() => { queued--; queuedBytes -= bytes; }); // every path (a replay, an abandoned one, an early return) ends here
    },
    /**
     * A write line that could not be read (the weight its text states, `sampleWeight`), settled whole so it cannot hold its session unsettled. Only its page and link writes (`qualifying`, `sampleQualifyingWeight`) are `uncomparable` / `line_unreadable`;
     * the rest are writes the shadow never compares, booked as `capability_missing` / `line_unreadable_nonqualifying` (the split the owed record used), never as uncomparable page and link writes.
     */
    unreadable(weight, qualifying) {
      const q = Math.min(weight, Math.max(0, qualifying));
      if (q > 0) d.tally.note('uncomparable', 'line_unreadable', q, false, q, q);
      if (weight - q > 0) d.tally.note('capability_missing', 'line_unreadable_nonqualifying', weight - q, false, weight - q, 0);
    },
    /** The lost lines a client or retired child holds are written (the 2 s flusher); true when none is left. */
    flush: () => d.tally.flush(),
    /** The 10 s pass: one more save, the lost lines held, the gone sessions settled. True when saves have been failing for `SAVE_FAILURE_EXIT_MS` with outcomes held: the child should exit (it is restarted, and the next owner books what it never settled). */
    pass() { d.tally.save(); return d.tally.stuckMs() >= SAVE_FAILURE_EXIT_MS; },
    /** Samples the serving process owed that never reached this child's pipe: `uncomparable` / `pipe_unflushed`, except `nonqualifying` of them, writes the shadow never compares (capability_missing / `pipe_unflushed_nonqualifying`); `windowLost` (1 for an open marker never closed) is one of the page and link writes, booked as the lost window. */
    missing: (n, nonqualifying = 0, windowLost = 0) => d.tally.missing(n, nonqualifying, windowLost),
    /** After the final save: removes this session's owed file when it is closed and settled. */
    finish: () => d.tally.finish(),
    idle: () => chain.then(() => d.tally.save()), // the last save also folds the lost samples the serving process recorded; true only when everything this child counted is saved (the caller keeps the sent count when it is not)
    /** At the child's exit deadline: replays still queued will never run, so each is counted `uncomparable`, then one last save. The running replay keeps its in-flight mark. */
    abandon() {
      if (waiting.size) { let q = 0; for (const e of waiting) q += ownQualifying.get(e) ?? 0; d.tally.note('uncomparable', 'child_exit_deadline', waiting.size, false, waiting.size, q); }
      waiting.clear();
      d.tally.save();
    },
  };
}
