/**
 * The multi-writer conformance support matrix: one row per case C01..C22
 * (docs/designs/rust-engine/multi-user-server.md, "Tests to write now", 1), and for each row where the case runs,
 * where it is not applicable and where it is pending, per arm.
 *
 * Pure data: no engine and no `bun:test` import. Three readers share it, so they can never disagree:
 *  - the parity harness (harness.ts) decides at runtime whether a `mwCase` case runs on an arm, and holds a `runs`
 *    cell to strict acceptance (the whole scenario and its inline invariant complete; a typed refusal, an adapter
 *    pending error or a named stop fails it);
 *  - `coverage.ts` renders the matrix into the generated coverage list;
 *  - `multi-writer-bar.ts` knows the expected (case, arm) set from it and fails closed on a missing result.
 *
 * Case ids and titles are shared names with the gbrain-evals multi-writer suite: never renumber or retitle a case.
 *
 * Un-pending a case when its lane lands is an edit to its cells here (plus, at store level, the adapter stub in
 * rust/crates/gbrain-store/tests/common/mu.rs), with the owning lane's tests green.
 */

/** Engine arms (parity harness) and store arms (cargo, `rust/crates/gbrain-store/tests/multi_writer_conformance.rs`). */
export const MW_ENGINE_ARMS = ['pglite', 'postgres', 'rust', 'rust-mu'] as const;
export const MW_STORE_ARMS = ['store-single', 'store-optimistic'] as const;
export const MW_ARMS = [...MW_ENGINE_ARMS, ...MW_STORE_ARMS] as const;
export type MwEngineArm = typeof MW_ENGINE_ARMS[number];
export type MwStoreArm = typeof MW_STORE_ARMS[number];
export type MwArm = typeof MW_ARMS[number];

export const MW_CASE_IDS = [
  'C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09', 'C10', 'C11',
  'C12', 'C13', 'C14', 'C15', 'C16', 'C17', 'C18', 'C19', 'C20', 'C21', 'C22',
] as const;
export type MwCaseId = typeof MW_CASE_IDS[number];

/**
 * A cell: `runs` (the case must pass, strictly), `n/a` (the arm cannot express the case, with why), or `pending`
 * (the arm will run it once `owner`'s work lands; `why` names the missing interface).
 */
export type MwCell =
  | { status: 'runs' }
  | { status: 'n/a'; why: string }
  | { status: 'pending'; owner: string; why: string };

export interface MwCase {
  id: MwCaseId;
  /** The design table's title, verbatim (shared with gbrain-evals). */
  title: string;
  /** The typed operation the case exercises (design table column 2). */
  operation: string;
  /** What must hold (design table column 3); the scenario asserts it inline. */
  invariant: string;
  /**
   * `compare`: the engine case returns observables the arms must agree on, so a Rust or rust-mu run needs a
   * reference arm that ran the case first (PGLite or Postgres); without one it records `prerequisite_missing` and
   * fails. `standalone`: the scenario asserts its invariant only and is counted in its own column, never as equal.
   */
  reference: 'compare' | 'standalone';
  /** A capability the engine itself must report on an arm whose cell is `runs` (I-8 name), checked at runtime. */
  needs?: 'multi_writer';
  /** The exact typed BrainEngine members the engine-level case calls (also its parityTest `methods`). */
  members: readonly string[];
  /** Cargo test names in multi_writer_conformance.rs: run on a `runs` store cell; listed (not run) when pending. */
  storeTests: { runnable: readonly string[]; pending: readonly string[] };
  cells: Readonly<Record<MwArm, MwCell>>;
}

/** Shorthands for the rows below. */
const RUNS: MwCell = { status: 'runs' };
const na = (why: string): MwCell => ({ status: 'n/a', why });
const pending = (owner: string, why: string): MwCell => ({ status: 'pending', owner, why });

/**
 * The rows. FILLED BY THE CONFORMANCE-CASE WORK: every id in MW_CASE_IDS appears exactly once, in order
 * (multi-writer-cases.test.ts checks it and that each row matches its parityTest declaration).
 */
export const MW_CASES: readonly MwCase[] = [];

void RUNS; void na; void pending;

export function mwCase(id: MwCaseId): MwCase {
  const row = MW_CASES.find((c) => c.id === id);
  if (row === undefined) throw new Error(`multi-writer-cases: no row for ${id}`);
  return row;
}

/** The cell for `id` on `arm`. */
export function mwCell(id: MwCaseId, arm: MwArm): MwCell {
  return mwCase(id).cells[arm];
}
