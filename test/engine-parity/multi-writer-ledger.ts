/**
 * The multi-writer outcome ledger: one JSON line per (case, arm) with a terminal outcome.
 *
 * The parity harness appends a line to the file named by GBRAIN_TEST_MW_LEDGER after each `mwCase` case reached an outcome
 * on an arm (harness.ts); `multi-writer-bar.ts` reads the file back and fails closed on anything it does not expect. Pure
 * data and file helpers: no engine and no `bun:test` import, so the bar (a plain script) and the harness share it.
 */
import { appendFileSync } from 'node:fs';
import type { MwEngineArm } from './multi-writer-cases.ts';
import { ENTRY_ID } from './multi-writer-entries.ts';

export const MW_LEDGER_ENV = 'GBRAIN_TEST_MW_LEDGER';

/**
 * The arm labels a ledger line carries. The `rust-mu` view has two routes to the multi-user switch (the environment variable
 * and the brain's config row), and each is its own label so a run says which one it was; both read the matrix's one `rust-mu`
 * cell (`cellArm`). `rust-mu-ambient` is the Rust arm of a process that started with GBRAIN_RUST_MULTIUSER=1 (the self-check
 * lane, kept through the preload by GBRAIN_TEST_KEEP_AMBIENT_ENV=1): its store is multi-user too, so it reads the same cell.
 */
export const LEDGER_ARMS = ['pglite', 'postgres', 'rust', 'rust-mu-env', 'rust-mu-config', 'rust-mu-ambient'] as const;
export type LedgerArm = typeof LEDGER_ARMS[number];

/** The matrix cell a ledger arm label reads. */
export function cellArm(arm: LedgerArm): MwEngineArm {
  return arm === 'rust-mu-env' || arm === 'rust-mu-config' || arm === 'rust-mu-ambient' ? 'rust-mu' : arm;
}

export const LEDGER_OUTCOMES = ['pass', 'fail', 'pending', 'n/a', 'prerequisite_missing'] as const;
export type LedgerOutcome = typeof LEDGER_OUTCOMES[number];

export interface LedgerLine {
  /** A case id (`C06`) or a variant id (`C06.partition`). */
  case: string;
  arm: LedgerArm;
  outcome: LedgerOutcome;
  detail: string;
}

/** One line, no newline inside the detail, bounded: a ledger line is appended in one write. */
export function renderLedgerLine(line: LedgerLine): string {
  const detail = line.detail.replace(/\s+/g, ' ').trim().slice(0, 400);
  return `${JSON.stringify({ case: line.case, arm: line.arm, outcome: line.outcome, detail })}\n`;
}

/** Append `line` to the ledger the environment names; nothing happens when the variable is unset. */
export function appendLedger(line: LedgerLine, env: Record<string, string | undefined> = process.env): void {
  const path = env[MW_LEDGER_ENV];
  if (path === undefined || path === '') return;
  appendFileSync(path, renderLedgerLine(line));
}

export interface ParsedLedger {
  lines: LedgerLine[];
  /** One entry per line that is not a valid ledger line (truncated, unknown id or arm or outcome, extra or missing keys). */
  malformed: string[];
}

/**
 * Parse ledger text. A final line with no newline is truncated by definition (the writer ends every line with one), so it
 * is reported as malformed even when it happens to parse.
 */
export function parseLedger(text: string): ParsedLedger {
  const lines: LedgerLine[] = [];
  const malformed: string[] = [];
  if (text === '') return { lines, malformed };
  const parts = text.split('\n');
  const truncatedTail = parts[parts.length - 1] !== '';
  // The last part is either empty (the text ends with a newline) or the truncated tail.
  const complete = parts.slice(0, -1);
  complete.forEach((raw, index) => {
    const label = `line ${index + 1}`;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      malformed.push(`${label}: not JSON (${raw.slice(0, 60)})`);
      return;
    }
    const problem = ledgerLineProblem(value);
    if (problem !== null) malformed.push(`${label}: ${problem}`);
    else lines.push(value as LedgerLine);
  });
  if (truncatedTail) malformed.push(`line ${parts.length}: truncated (no closing newline): ${parts[parts.length - 1]!.slice(0, 60)}`);
  return { lines, malformed };
}

function ledgerLineProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'not an object';
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'arm,case,detail,outcome') return `keys are ${keys}, expected arm,case,detail,outcome`;
  const v = value as Record<string, unknown>;
  if (typeof v.case !== 'string' || !ENTRY_ID.test(v.case)) return `unknown case ${JSON.stringify(v.case)}`;
  if (!(LEDGER_ARMS as readonly unknown[]).includes(v.arm)) return `unknown arm ${JSON.stringify(v.arm)}`;
  if (!(LEDGER_OUTCOMES as readonly unknown[]).includes(v.outcome)) return `unknown outcome ${JSON.stringify(v.outcome)}`;
  if (typeof v.detail !== 'string') return 'detail is not a string';
  return null;
}
