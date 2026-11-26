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
import { ID_TARGET_WRITES, nothingToCompare, pageRefs, pageSet, readBack, readBackText, type PageRef, type StateColumnsRead, type WriteEvent, type WriteOutcome, type WriteTally } from './write-compare.ts';

/** Columns the seed always reports as unmapped and the typed read-back never shows (rust/docs/store/seed.md, "Some unmapped columns are expected": `pages.generation`, the primary's cache clock). */
const EXPECTED_UNMAPPED: ReadonlySet<string> = new Set(['generation']);
export const WRITE_QUEUE_BOUND = 16;
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
/** The pages a sample says it touched: only well-formed refs, and none at all when any is malformed. */
const namedPages = (v: unknown): PageRef[] => (Array.isArray(v) && v.every((r) => typeof r?.source === 'string' && r.source && typeof r?.slug === 'string' && r.slug) ? v.map((r) => ({ source: r.source, slug: r.slug })) : []);

export function createWriteComparer(d: WriteComparerDeps): { handle(event: WriteEvent): void; idle(): Promise<void>; abandon(): void } {
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
  let runs = 0;
  let wedged = false;
  const waiting = new Set<WriteEvent>(); // queued replays that have not started

  async function replay(event: WriteEvent): Promise<Verdict> {
    if (!d.load.ok) return ['uncomparable', 'addon_unavailable'];
    if (!d.alive()) return ['uncomparable', 'shadow_dir_deleted'];
    if (event.moved) return ['uncomparable', 'moved']; // another write landed in between: neither verdict can be trusted, a match included
    const args = decodeValue(event.args) as unknown[];
    const pre = event.pre!;
    // The pages come from the arguments; a write that names them by id has them looked up by the serving process, which sends them (any other write's `targets` is ignored).
    const targets = ID_TARGET_WRITES.has(event.op) ? namedPages(event.targets) : pageRefs(event.op, args);
    if (!targets.length) return ['uncomparable', 'target_unresolved']; // nothing to read back from either side: a match would prove nothing
    // A write whose pages the copy does not hold, or a link removal with no link to remove, changes nothing on either side: it compares nothing.
    const vacuous = nothingToCompare(event.op, args, targets, pre);
    if (vacuous) return ['uncomparable', vacuous];
    runs++;
    let run = ''; let engine: Record<string, any> | null = null;
    try {
      mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
      run = mkdtempSync(join(scratchRoot, prefix)); // mode 0700: the store, its lock and its socket all live in here and go together
      const dir = join(run, 'store');
      engine = (d.openEngine ?? ((addon, path) => openRustEngine({ addon, databasePath: path }) as unknown as Record<string, any>))(d.load.addon as RustEngineAddonHandle, dir);
      await engine.connect({ database_path: dir });
      const store = await engine.storeFor('seed');
      // The three page columns the typed reads do not return come from one read-only store call. An addon without it cannot be compared (a store with no `brain` is a test double).
      if (store.brain && typeof store.brain.readPageComparisonColumns !== 'function') return ['uncomparable', 'addon_unavailable'];
      const columns: StateColumnsRead | undefined = store.brain && (async (refs: PageRef[]) => store.brain.readPageComparisonColumns(refs.map((r) => ({ source_id: r.source, slug: r.slug }))));
      for (const [relation, rows] of [['sources', pre.sources], ['pages', pre.pages], ['links', pre.links]] as const) {
        if (!rows.length) continue;
        const done = await store.importRelation(`write-compare-${runs}`, relation, rows);
        // The scratch store must hold exactly the rows the primary held: a skipped, dropped or lossy import, or a column it does not keep, is not that copy.
        if (done.imported !== rows.length || done.skipped || done.dropped || Object.keys(done.losses).length || done.unmapped_columns?.some((c: string) => !EXPECTED_UNMAPPED.has(c))) return ['uncomparable', 'preimage_not_loaded'];
      }
      // A write that names pages by id needs the scratch store to hold the same ids, or it would change other pages there.
      if (ID_TARGET_WRITES.has(event.op)) {
        const wanted = new Set(((args[0] as { ids?: unknown[] } | undefined)?.ids ?? []).map(String));
        const held = await Promise.all(targets.map(async (r) => String((await engine!.getPage(r.slug, { sourceId: r.source, includeDeleted: true }))?.id)));
        if (held.some((id) => !wanted.has(id)) || new Set(held).size !== wanted.size) return ['uncomparable', 'preimage_not_loaded'];
      }
      try { await engine[event.op](...args); for (const call of event.then ?? []) await engine.updatePageContextualRetrievalState(...decodeValue(call) as unknown[]); } catch (error) { d.onError?.('write', error); return ['uncomparable', `rust_write_failed`]; }
      const theirs = readBackText(encodeValue(await readBack(engine, targets, pageSet(targets, pre), columns)));
      if (theirs === readBackText(event.post)) return ['comparable'];
      return ['unexplained_difference'];
    } finally {
      await engine?.disconnect().catch(() => undefined);
      if (run) try { rmSync(run, { recursive: true, force: true }); } catch { /* swept at the next shadow start */ }
    }
  }

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
    d.tally.note(verdict[0], verdict[1], 1, true); // the replay is over: its verdict ends its in-flight mark
  }

  return {
    handle(event) {
      if (Number.isInteger(event.dropped) && event.dropped! > 0) d.tally.note('uncomparable', 'send_shed', Math.min(event.dropped!, 10_000));
      // The serving process can only report what it saw itself; a verdict (`comparable`, `unexplained_difference`) is made here, from a replay.
      if (event.outcome === 'capability_missing' || event.outcome === 'uncomparable') { d.tally.note(event.outcome, event.family ?? event.reason); return; }
      if (!event.pre || !event.args) { d.tally.note('uncomparable', 'no_sample'); return; }
      if (queued >= WRITE_QUEUE_BOUND) { d.tally.note('uncomparable', 'queue_full'); return; }
      queued++; waiting.add(event);
      chain = chain.then(() => run(event)).finally(() => { queued--; });
    },
    idle: () => chain.then(() => { d.tally.save(); }), // the last save also folds the lost samples the serving process recorded
    /** At the child's exit deadline: replays still queued will never run, so each is counted `uncomparable`, then one last save. The running replay keeps its in-flight mark. */
    abandon() {
      if (waiting.size) d.tally.note('uncomparable', 'child_exit_deadline', waiting.size);
      waiting.clear();
      d.tally.save();
    },
  };
}
