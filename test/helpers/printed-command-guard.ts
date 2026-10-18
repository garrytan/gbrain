/**
 * The printed-command guard (#6803 plan B7): every command a surface prints
 * for an operator or agent to run is rendered through `renderAction` with
 * routing set, then executed in dry form through the real dispatcher on a
 * two-source fixture, and must exit 0. A command that does not exist, a
 * literal `<N>` placeholder, an approve that a multi-source brain refuses, or
 * a listing narrowed by the routing pin fails here.
 *
 * Extension point: `PRINTED_COMMAND_PRODUCERS` is the list the guard runs.
 * Each producer seeds what its surface needs on the fixture brain and returns
 * the text (or rendered commands) the surface printed; the guard extracts
 * every `gbrain ...` command from it. Lane B (#6803 part 3) registers
 * `sizeStateLines`, `budget_limited` (`embed --stale`), doctor
 * `partial_embedding`, the `meterPageBatch` hold line, `embed --held` and
 * the edited docs. Lane A's projection texts (A9) join by pushing producers
 * here (`registerPrintedCommandProducer`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CliResult } from './cli-spawn.ts';
import type { HeldBrain } from './held-embedding-fixture.ts';

/** What a producer gets: the fixture brain (two sources, `default` and `alpha`) and the real CLI against it. */
export interface GuardFixture {
  brain: HeldBrain;
  /** The real CLI (argv without `gbrain`); `env` overlays the fixture env. */
  run(args: string[], env?: Record<string, string | undefined>): Promise<CliResult>;
  /** The routing every in-process render uses (`installCliRouting`): the fixture's brain and source `alpha`. */
  routing: { brain: string; source: string };
}

export interface PrintedCommandProducer {
  /** The surface, for the failure message. */
  name: string;
  /** The printed text; every `gbrain ...` command in it is guarded. */
  text(fixture: GuardFixture): Promise<string>;
  /** Placeholders a doc command carries, filled before the run (`<id>` -> a fixture source). */
  fill?: Record<string, string>;
  /** Which extracted commands this producer owns (a doc section also names unrelated, mutating commands such as `gbrain upgrade`); default all. */
  owns?: (argv: string[]) => boolean;
  /** Env overlay for this producer's command runs (a surface that names a multimodal-only command runs on a multimodal brain). */
  env?: Record<string, string | undefined>;
}

export const PRINTED_COMMAND_PRODUCERS: PrintedCommandProducer[] = [];

export function registerPrintedCommandProducer(producer: PrintedCommandProducer): void {
  PRINTED_COMMAND_PRODUCERS.push(producer);
}

const TOKEN = String.raw`[^\s;()\x60,"]+`;
const COMMAND = new RegExp(`gbrain(?: ${TOKEN})+`, 'g');

/** Every `gbrain ...` command in `text` (single-space separated tokens), sentence punctuation trimmed. */
export function extractCommands(text: string): string[] {
  return [...new Set((text.match(COMMAND) ?? []).map(c => c.replace(/[.:]+$/, '')))];
}

/** The dry form: an approval (`--max-usd`) runs as its `--dry-run`; read-only commands run as printed. */
export function dryForm(argv: string[]): string[] {
  return argv.includes('--max-usd') && !argv.includes('--dry-run') ? [...argv, '--dry-run'] : argv;
}

/** A doc section: from the line containing `from` up to the line containing `to` (just that line without `to`). */
export function docSection(rel: string, from: string, to?: string): string {
  const lines = readFileSync(join(import.meta.dir, '..', '..', rel), 'utf8').split('\n');
  const start = lines.findIndex(l => l.includes(from));
  const end = to === undefined ? start + 1 : lines.findIndex((l, i) => i > start && l.includes(to));
  if (start < 0 || end < 0) throw new Error(`docSection: ${rel} has no section ${from} .. ${to}`);
  return lines.slice(start, end).join('\n');
}
