/**
 * Write comparisons, the shadow child's part (write-compare.ts has the design). Each full sample is replayed on a SCRATCH Rust
 * store: opened in a new directory under the shadow directory, seeded with the sample's preimage rows through `importRelation`,
 * given the same write, read back and deleted. The live shadow store and the primary are never touched, and no Rust code beyond
 * what the shadow already uses is involved. One sample runs at a time; a sample that finds the queue full, or a scratch run that
 * hangs, is counted `uncomparable`, never `comparable`.
 */
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RustEngineAddonLoad } from '../core/rust-engine/addon-loader.ts';
import { openRustEngine, type RustEngineAddonHandle } from '../core/rust-engine.ts';
import { safeCode } from './child-checks.ts';
import { decodeValue, encodeValue } from './codec.ts';
import { pageRefs, pageSet, readBack, readBackText, type WriteEvent, type WriteOutcome, type WriteTally } from './write-compare.ts';

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
  /** Where scratch stores are made; default the system temp directory (a seam for tests). */
  scratchRoot?: string;
}
type Verdict = [WriteOutcome, string?];

export function createWriteComparer(d: WriteComparerDeps): { handle(event: WriteEvent): void; idle(): Promise<void> } {
  // Scratch stores live outside the shadow directory, each in a private directory named for this process: `stop --delete` cannot be undone by a store
  // that is still opening, and another child never deletes this one's. Directories of processes that no longer exist are removed here.
  const scratchRoot = d.scratchRoot ?? tmpdir();
  const prefix = `gbrain-write-compare-${process.pid}-`;
  try {
    for (const name of readdirSync(scratchRoot)) {
      const pid = /^gbrain-write-compare-(\d+)-/.exec(name)?.[1];
      if (!pid || Number(pid) === process.pid) continue;
      try { process.kill(Number(pid), 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') rmSync(join(scratchRoot, name), { recursive: true, force: true }); }
    }
  } catch { /* an unreadable temp directory leaves old stores for the system to clean */ }
  let chain: Promise<void> = Promise.resolve();
  let queued = 0;
  let runs = 0;
  let wedged = false;

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
    const run = mkdtempSync(join(scratchRoot, prefix)); // the store, its lock and its socket all live in here (mode 0700) and go together
    const dir = join(run, 'store');
    const engine = (d.openEngine ?? ((addon, path) => openRustEngine({ addon, databasePath: path }) as unknown as Record<string, any>))(d.load.addon as RustEngineAddonHandle, dir);
    try {
      await engine.connect({ database_path: dir });
      const store = await engine.storeFor('seed');
      for (const [relation, rows] of [['sources', pre.sources], ['pages', pre.pages], ['links', pre.links]] as const) {
        if (!rows.length) continue;
        const done = await store.importRelation(`write-compare-${runs}`, relation, rows);
        // The scratch store must hold exactly the rows the primary held: a skipped, dropped or lossy import is not that copy.
        if (done.imported !== rows.length || done.skipped || done.dropped || Object.keys(done.losses).length) return ['uncomparable', 'preimage_not_loaded'];
      }
      try { await engine[event.op](...args); } catch (error) { d.onError?.('write', error); return ['uncomparable', `rust_write_failed`]; }
      const theirs = readBackText(encodeValue(await readBack(engine, targets, pageSet(targets, pre))));
      if (theirs === readBackText(event.post)) return ['comparable'];
      return ['unexplained_difference'];
    } finally {
      await engine.disconnect().catch(() => undefined);
      try { rmSync(run, { recursive: true, force: true }); } catch { /* removed with the shadow directory */ }
    }
  }

  async function run(event: WriteEvent): Promise<void> {
    let verdict: Verdict;
    try {
      if (wedged) verdict = ['uncomparable', 'scratch_wedged'];
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
    d.tally.note(verdict[0], verdict[1]);
  }

  return {
    handle(event) {
      if (Number.isInteger(event.dropped) && event.dropped! > 0) d.tally.note('uncomparable', 'send_shed', Math.min(event.dropped!, 10_000));
      // The serving process can only report what it saw itself; a verdict (`comparable`, `unexplained_difference`) is made here, from a replay.
      if (event.outcome === 'capability_missing' || event.outcome === 'uncomparable') { d.tally.note(event.outcome, event.family ?? event.reason); return; }
      if (!event.pre || !event.args) { d.tally.note('uncomparable', 'no_sample'); return; }
      if (queued >= WRITE_QUEUE_BOUND) { d.tally.note('uncomparable', 'queue_full'); return; }
      queued++;
      chain = chain.then(() => run(event)).finally(() => { queued--; });
    },
    idle: () => chain,
  };
}
