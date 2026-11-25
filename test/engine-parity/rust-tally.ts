/**
 * The Rust arm's pinned tally (test/engine-parity/rust-tally.tsv): for each parity file, how many cases the Rust arm
 * answered equal to PGLite and how many stopped on a typed refusal. A Rust parity run fails when a file has fewer equal
 * cases or more stopped cases than its pin, so a member that regresses to a typed refusal no longer passes. A file that
 * gains equal cases or loses stopped cases passes and prints the new counts to pin.
 *
 * The check runs only when every case of the file reached an outcome, so a `-t` filter or a failed case never trips it.
 *
 * A row may end in a fourth column: the reason its stopped cases stop by design, one line, kept by the regenerate
 * command while the file still has stopped cases.
 *
 * Regenerate the pin (one command; it runs every parity file with the Rust arm, one Bun process per file as CI does,
 * and writes the file only when every run passes):
 *   bun test/engine-parity/rust-tally.ts --write
 */
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const RUST_TALLY_PATH = join(import.meta.dir, 'rust-tally.tsv');
export const RUST_TALLY_REGEN = 'bun test/engine-parity/rust-tally.ts --write';
/** Set by the regenerate command: each finished file appends its row here instead of checking its pin. */
const OUT_ENV = 'GBRAIN_TEST_PARITY_TALLY_OUT';
const HEADER = 'file\tequal\tstopped\tstop_reason';

/** A file's pinned counts; `reason` says why its stopped cases stop by design (no tab or newline). */
export interface TallyPin { equal: number; stopped: number; reason?: string }
/**
 * What the Rust arm did with one file's cases (harness.ts RustTally plus the cases an `n/a` capability skipped).
 * `standalone` counts multi-writer cases that passed on their inline invariant alone (no reference arm to compare with):
 * they are a column of their own, join the sum check so a file of them can finish, and never raise `compared` (the pin's
 * `equal`), so a standalone case is never counted as equal to PGLite.
 */
export interface FileTally {
  compared: number; refused: number; diverged: number; skipped: number; standalone?: number;
  /**
   * The `rust-mu` view only. Cases the matrix runs on `rust` but holds pending on `rust-mu` (a known gap of the multi-user
   * view). They stay in `skipped` and never in `compared`; the pin check accepts `compared + knownGaps >= pin.equal` so the
   * view is held to the off pin for everything else. The caller names them in its printed line.
   */
  knownGaps?: number;
  /** Set by a `rust-mu` run: it never writes the regenerate output (the pin is the off arm's count). */
  muView?: boolean;
}

export function parsePins(text: string): Map<string, TallyPin> {
  const pins = new Map<string, TallyPin>();
  for (const line of text.split('\n').slice(1)) {
    if (line.trim() === '') continue;
    const [file, equal, stopped, reason] = line.split('\t');
    pins.set(file!, { equal: Number(equal), stopped: Number(stopped), ...(reason ? { reason } : {}) });
  }
  return pins;
}

export function renderPins(rows: Iterable<[string, TallyPin]>): string {
  const sortedRows = [...rows].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return [HEADER, ...sortedRows.map(([file, pin]) => `${file}\t${pin.equal}\t${pin.stopped}${pin.reason ? `\t${pin.reason}` : ''}`)].join('\n') + '\n';
}

/** The regenerated pins with each earlier stop reason kept, for a file that still has stopped cases. */
export function keepStopReasons(fresh: Map<string, TallyPin>, earlier: Map<string, TallyPin>): Map<string, TallyPin> {
  const out = new Map<string, TallyPin>();
  for (const [file, pin] of fresh) {
    const reason = earlier.get(file)?.reason;
    out.set(file, reason && pin.stopped > 0 ? { ...pin, reason } : pin);
  }
  return out;
}

function readPins(): Map<string, TallyPin> {
  try {
    return parsePins(readFileSync(RUST_TALLY_PATH, 'utf8'));
  } catch {
    return new Map();
  }
}

/**
 * Compare one finished file's tally with its pin. Returns the line to print when the file did better than its pin, or
 * null; throws when it did worse or has no pin. `registered` is the number of parity cases the file declared.
 */
export function checkRustTally(file: string, tally: FileTally, registered: number,
  pins: Map<string, TallyPin> = readPins(), env: Record<string, string | undefined> = process.env): string | null {
  if (tally.compared + tally.refused + tally.diverged + tally.skipped + (tally.standalone ?? 0) !== registered) return null;
  // The pin covers test/engine-parity/ only. A file outside it that runs the parity harness (doctor-catalog-probes,
  // rust-arm-harness) has no parity file name and no pin row.
  if (file === '') return null;
  const out = env[OUT_ENV];
  // The pin is what the off Rust arm answers: a rust-mu run is checked against it and never regenerates it.
  if (out && tally.muView === true) return null;
  if (out) {
    appendFileSync(out, `${file}\t${tally.compared}\t${tally.refused}\n`);
    return null;
  }
  const pin = pins.get(file);
  const now = `${file}\t${tally.compared}\t${tally.refused}`;
  if (pin === undefined) throw new Error(`[rust arm] ${file} has no row in test/engine-parity/rust-tally.tsv; run ${RUST_TALLY_REGEN}`);
  const gaps = tally.muView === true ? tally.knownGaps ?? 0 : 0;
  if (tally.compared + gaps < pin.equal || tally.refused > pin.stopped) {
    throw new Error(`[rust arm] ${file}: ${tally.compared} equal and ${tally.refused} stopped, but rust-tally.tsv pins ` +
      `${pin.equal} equal and ${pin.stopped} stopped. A case that PGLite answers now stops on a typed refusal on Rust. ` +
      `Fix the member, or, when the change is intended, run ${RUST_TALLY_REGEN}`);
  }
  if (tally.compared + gaps > pin.equal || tally.refused < pin.stopped) {
    return `[rust arm] ${file} did better than its pin; pin the new counts (${now.replaceAll('\t', ' ')}) with ${RUST_TALLY_REGEN}`;
  }
  return null;
}

async function regenerate(): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'rust-tally-'));
  const out = join(dir, 'rows.tsv');
  writeFileSync(out, '');
  try {
    const files = readdirSync(import.meta.dir).filter((f) => f.endsWith('.test.ts')).sort();
    let failed = 0;
    for (const f of files) {
      const proc = Bun.spawn(['bun', 'test', '--timeout=60000', `test/engine-parity/${f}`], {
        cwd: join(import.meta.dir, '..', '..'),
        env: { ...process.env, GBRAIN_TEST_RUST_ARM: '1', [OUT_ENV]: out },
        stdout: 'inherit', stderr: 'inherit',
      });
      if ((await proc.exited) !== 0) { failed++; console.error(`rust-tally: test/engine-parity/${f} failed`); }
    }
    if (failed > 0) {
      console.error(`rust-tally: ${failed} file(s) failed; rust-tally.tsv is unchanged`);
      return 1;
    }
    writeFileSync(RUST_TALLY_PATH, renderPins(keepStopReasons(parsePins(`${HEADER}\n${readFileSync(out, 'utf8')}`), readPins())));
    console.log(`rust-tally: wrote ${RUST_TALLY_PATH}`);
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  if (!process.argv.includes('--write')) {
    console.error(`usage: ${RUST_TALLY_REGEN}`);
    process.exit(2);
  }
  process.exit(await regenerate());
}
