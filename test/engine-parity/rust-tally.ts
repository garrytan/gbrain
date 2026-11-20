/**
 * The Rust arm's pinned tally (test/engine-parity/rust-tally.tsv): for each parity file, how many cases the Rust arm
 * answered equal to PGLite and how many stopped on a typed refusal. A Rust parity run fails when a file has fewer equal
 * cases or more stopped cases than its pin, so a member that regresses to a typed refusal no longer passes. A file that
 * gains equal cases or loses stopped cases passes and prints the new counts to pin.
 *
 * The check runs only when every case of the file reached an outcome, so a `-t` filter or a failed case never trips it.
 *
 * A row may carry a fourth column, a note: who owns each stopped case and why it stops. Regenerating keeps the note.
 *
 * test/engine-parity/rust-tally-seeds.tsv holds the rows that differ when the arm's addon is built with the `test-seeds`
 * cargo feature (rust/docs/store/test-seeds.md): a case that seeds the Rust arm through a test-only member stops on the
 * default addon and can answer equal on the seed addon. The harness reads it over the default pins when the arm's addon
 * exposes the seed members, so each build is checked against its own counts.
 *
 * Regenerate the pin (one command; it runs every parity file with the Rust arm, one Bun process per file as CI does,
 * and writes the file only when every run passes). With --seeds, on a seed addon, it writes the seed rows instead:
 *   bun test/engine-parity/rust-tally.ts --write [--seeds]
 */
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const RUST_TALLY_PATH = join(import.meta.dir, 'rust-tally.tsv');
export const RUST_TALLY_SEEDS_PATH = join(import.meta.dir, 'rust-tally-seeds.tsv');
export const RUST_TALLY_REGEN = 'bun test/engine-parity/rust-tally.ts --write';
export const RUST_TALLY_SEEDS_REGEN = 'bun test/engine-parity/rust-tally.ts --write --seeds';
/** Set by the regenerate command: each finished file appends its row here instead of checking its pin. */
const OUT_ENV = 'GBRAIN_TEST_PARITY_TALLY_OUT';
/** Set by the seed-addon CI job and `--write --seeds`: the parity harness fails when the arm's addon has no seed members. */
export const SEEDS_REQUIRED_ENV = 'GBRAIN_TEST_RUST_SEEDS_REQUIRED';
const HEADER = 'file\tequal\tstopped\tnote';

/** `note`, when present, names the owner and the reason of each stopped case. */
export interface TallyPin { equal: number; stopped: number; note?: string }
/** What the Rust arm did with one file's cases (harness.ts RustTally plus the cases an `n/a` capability skipped). */
export interface FileTally { compared: number; refused: number; diverged: number; skipped: number }

export function parsePins(text: string): Map<string, TallyPin> {
  const pins = new Map<string, TallyPin>();
  for (const line of text.split('\n').slice(1)) {
    if (line.trim() === '') continue;
    const [file, equal, stopped, note] = line.split('\t');
    pins.set(file!, { equal: Number(equal), stopped: Number(stopped), ...(note ? { note } : {}) });
  }
  return pins;
}

export function renderPins(rows: Iterable<[string, TallyPin]>): string {
  const sortedRows = [...rows].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return [HEADER, ...sortedRows.map(([file, pin]) => `${file}\t${pin.equal}\t${pin.stopped}${pin.note ? `\t${pin.note}` : ''}`)]
    .join('\n') + '\n';
}

function readPinFile(path: string): Map<string, TallyPin> {
  try {
    return parsePins(readFileSync(path, 'utf8'));
  } catch {
    return new Map();
  }
}

/** The default pins, with the seed rows read over them when the arm's addon was built with `test-seeds`. */
export function readPins(seeds = false): Map<string, TallyPin> {
  const pins = readPinFile(RUST_TALLY_PATH);
  if (seeds) for (const [file, pin] of readPinFile(RUST_TALLY_SEEDS_PATH)) pins.set(file, pin);
  return pins;
}

/** The seed rows to write: each file whose seed-addon counts differ from its default pin, with its notes kept. */
export function seedRows(measured: Map<string, TallyPin>, base: Map<string, TallyPin>, kept: Map<string, TallyPin>): Map<string, TallyPin> {
  const rows = new Map<string, TallyPin>();
  for (const [file, pin] of measured) {
    const def = base.get(file);
    if (def !== undefined && def.equal === pin.equal && def.stopped === pin.stopped) continue;
    const note = kept.get(file)?.note ?? def?.note;
    rows.set(file, { equal: pin.equal, stopped: pin.stopped, ...(note ? { note } : {}) });
  }
  return rows;
}

/**
 * Compare one finished file's tally with its pin. Returns the line to print when the file did better than its pin, or
 * null; throws when it did worse or has no pin. `registered` is the number of parity cases the file declared.
 */
export function checkRustTally(file: string, tally: FileTally, registered: number,
  pins: Map<string, TallyPin> = readPins(), env: Record<string, string | undefined> = process.env): string | null {
  if (tally.compared + tally.refused + tally.diverged + tally.skipped !== registered) return null;
  // The pin covers test/engine-parity/ only. A file outside it that runs the parity harness (doctor-catalog-probes,
  // rust-arm-harness) has no parity file name and no pin row.
  if (file === '') return null;
  const out = env[OUT_ENV];
  if (out) {
    appendFileSync(out, `${file}\t${tally.compared}\t${tally.refused}\n`);
    return null;
  }
  const pin = pins.get(file);
  const now = `${file}\t${tally.compared}\t${tally.refused}`;
  if (pin === undefined) throw new Error(`[rust arm] ${file} has no row in test/engine-parity/rust-tally.tsv; run ${RUST_TALLY_REGEN}`);
  if (tally.compared < pin.equal || tally.refused > pin.stopped) {
    throw new Error(`[rust arm] ${file}: ${tally.compared} equal and ${tally.refused} stopped, but rust-tally.tsv pins ` +
      `${pin.equal} equal and ${pin.stopped} stopped. A case that PGLite answers now stops on a typed refusal on Rust. ` +
      `Fix the member, or, when the change is intended, run ${RUST_TALLY_REGEN}. On a seed addon, rust-tally-seeds.tsv rows ` +
      `apply over it (${RUST_TALLY_SEEDS_REGEN})`);
  }
  if (tally.compared > pin.equal || tally.refused < pin.stopped) {
    return `[rust arm] ${file} did better than its pin; pin the new counts (${now.replaceAll('\t', ' ')}) with ${RUST_TALLY_REGEN}`;
  }
  return null;
}

async function regenerate(seeds: boolean): Promise<number> {
  const path = seeds ? RUST_TALLY_SEEDS_PATH : RUST_TALLY_PATH;
  const dir = mkdtempSync(join(tmpdir(), 'rust-tally-'));
  const out = join(dir, 'rows.tsv');
  writeFileSync(out, '');
  try {
    const files = readdirSync(import.meta.dir).filter((f) => f.endsWith('.test.ts')).sort();
    let failed = 0;
    for (const f of files) {
      const proc = Bun.spawn(['bun', 'test', '--timeout=60000', `test/engine-parity/${f}`], {
        cwd: join(import.meta.dir, '..', '..'),
        env: { ...process.env, GBRAIN_TEST_RUST_ARM: '1', [OUT_ENV]: out, ...(seeds ? { [SEEDS_REQUIRED_ENV]: '1' } : {}) },
        stdout: 'inherit', stderr: 'inherit',
      });
      if ((await proc.exited) !== 0) { failed++; console.error(`rust-tally: test/engine-parity/${f} failed`); }
    }
    if (failed > 0) {
      console.error(`rust-tally: ${failed} file(s) failed; ${path} is unchanged`);
      return 1;
    }
    const measured = parsePins(`${HEADER}\n${readFileSync(out, 'utf8')}`);
    const kept = readPinFile(path);
    const rows = seeds ? seedRows(measured, readPinFile(RUST_TALLY_PATH), kept)
      : new Map([...measured].map(([file, pin]) => {
        const note = kept.get(file)?.note;
        return [file, { ...pin, ...(note ? { note } : {}) }] as [string, TallyPin];
      }));
    writeFileSync(path, renderPins(rows));
    console.log(`rust-tally: wrote ${path}`);
    return 0;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  if (!process.argv.includes('--write')) {
    console.error(`usage: ${RUST_TALLY_REGEN} [--seeds]`);
    process.exit(2);
  }
  process.exit(await regenerate(process.argv.includes('--seeds')));
}
