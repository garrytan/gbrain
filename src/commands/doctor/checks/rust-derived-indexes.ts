/**
 * `rust_derived_indexes`: the health of the Rust store's keyword index (the `R` records in records.redb, written in
 * the same transaction as each record; rust/docs/store/keyword.md, "Doctor"). A Rust brain only: the SQL engines keep
 * their indexes in the database, and their doctor output has no row for this check.
 *
 * The check reads one snapshot and writes nothing. Its states:
 *   - ok: the state is complete and the postings of the checked pages match the postings rebuilt from their records;
 *   - fail (mismatch): a checked posting is missing, changed or orphan, so keyword results can be wrong;
 *   - warn (unreadable, stalled, building, absent, other_layout): keyword search scans the records instead of the
 *     postings, which gives the right results more slowly (about 7-8 s a query at 50k pages / 200k chunks).
 * The posting comparison reads the first DEFAULT_MAX_PAGES pages; `--tier deep` compares every page.
 *
 * `gbrain doctor --fix` rebuilds the index from the records (every state but `building`, whose running build owns
 * the index), then checks again. The rebuild writes only index records; its receipt counts them. The core term
 * postings (`T` records) are not checked or rebuilt here.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { DerivedIndexHealth, DerivedIndexRebuild } from '../../../core/engine-members/doctor.ts';
import type { Check } from '../../doctor.ts';
import { agentFix, checkError } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

export const RUST_DERIVED_INDEXES_CHECK = 'rust_derived_indexes';

/** Pages the posting comparison reads under the standard tier (about 1 s at the 50k-page verify rate). */
export const DEFAULT_MAX_PAGES = 2000;

const SCAN_COST = 'keyword search scans the records instead (right results, slower: about 7-8 s a query at 50k pages / 200k chunks)';
const NOT_CHECKED = 'The core term postings are not checked.';
const FIX_ARGV = ['gbrain', 'doctor', '--fix', '--only', RUST_DERIVED_INDEXES_CHECK, '--json'];

function fix(why: string) {
  return agentFix(FIX_ARGV, why, RUST_DERIVED_INDEXES_CHECK, { docs: 'rust/docs/store/keyword.md#doctor' });
}

function builderNote(h: DerivedIndexHealth): string {
  return h.builder_error ? ` The background build failed: ${h.builder_error}.` : '';
}

/** The check row for one health read. */
export function derivedIndexCheck(h: DerivedIndexHealth): Check {
  const details = { keyword: h };
  const rebuild = 'gbrain doctor --fix rebuilds it from the records and writes no record.';
  switch (h.status) {
    case 'ok': {
      const v = h.verify;
      const scope = v ? `${v.pages} page(s) checked, ${v.expected} posting(s)` : 'complete';
      return { name: RUST_DERIVED_INDEXES_CHECK, status: 'ok', message: `Keyword index complete and matching its records (${scope}). ${NOT_CHECKED}`, details };
    }
    case 'mismatch': {
      const v = h.verify;
      const counts = v ? `${v.missing} missing, ${v.changed} changed, ${v.orphan ?? 'unchecked'} orphan posting(s) over ${v.pages} page(s)` : 'postings differ';
      return {
        name: RUST_DERIVED_INDEXES_CHECK, status: 'fail', details,
        message: `Keyword index does not match its records (${counts}): keyword search can miss or misrank pages. ${rebuild} ${NOT_CHECKED}`,
        fix: fix('The keyword index postings differ from the postings its records give; the rebuild resets the index and writes it again from the records.'),
      };
    }
    case 'building':
      return {
        name: RUST_DERIVED_INDEXES_CHECK, status: 'warn', details,
        message: `Keyword index is building (cursor ${h.state?.cursor ?? 'start'}); until it completes ${SCAN_COST}. ${NOT_CHECKED}`,
        fix_unavailable_reason: 'no_safe_automatic_fix',
      };
    default: {
      const what = h.status === 'unreadable' ? `Keyword index state does not parse (${h.state_error ?? 'unknown error'})`
        : h.status === 'stalled' ? `Keyword index build stopped before it completed (cursor ${h.state?.cursor ?? 'start'})`
          : h.status === 'absent' ? 'Keyword index has no state record'
            : `Keyword index has a state of another layout (version ${h.state?.version ?? '?'})`;
      return {
        name: RUST_DERIVED_INDEXES_CHECK, status: 'warn', details,
        message: `${what}; ${SCAN_COST}.${builderNote(h)} ${rebuild} ${NOT_CHECKED}`,
        fix: fix('Keyword search scans every record until the index is complete; the rebuild writes the index again from the records.'),
      };
    }
  }
}

/** The check, and under `--fix` the rebuild and a second check. Null for an engine that is not Rust. */
export async function rustDerivedIndexesCheck(engine: BrainEngine, opts: { doFix: boolean; deep: boolean }): Promise<Check | null> {
  if (engine.kind !== 'rust' || !engine.checkDerivedIndexes) return null;
  const maxPages = opts.deep ? undefined : DEFAULT_MAX_PAGES;
  let health: DerivedIndexHealth;
  try {
    health = await engine.checkDerivedIndexes({ maxPages });
  } catch (err) {
    return checkError(RUST_DERIVED_INDEXES_CHECK, 'read the keyword index state', err);
  }
  if (!opts.doFix || health.status === 'ok' || health.status === 'building' || !engine.rebuildDerivedIndexes) return derivedIndexCheck(health);
  let receipt: DerivedIndexRebuild;
  try {
    receipt = await engine.rebuildDerivedIndexes();
    health = await engine.checkDerivedIndexes({ maxPages });
  } catch (err) {
    return checkError(RUST_DERIVED_INDEXES_CHECK, 'rebuild the keyword index', err, { status: 'fail', details: { keyword: health } });
  }
  const after = derivedIndexCheck(health);
  const done = `Rebuilt the keyword index from the records (${receipt.index_puts} index write(s), ${receipt.index_deletes} delete(s) in ${receipt.transactions} transaction(s), ${receipt.record_writes} record write(s)).`;
  return { ...after, message: `${done} ${after.message}`, details: { ...after.details, rebuild: receipt } };
}

async function runRustDerivedIndexes(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  if (engine.kind !== 'rust') return [];
  ctx.progress.heartbeat(RUST_DERIVED_INDEXES_CHECK);
  const checks: Check[] = [];
  const check = await rustDerivedIndexesCheck(engine, { doFix: ctx.doFix && !ctx.dryRun, deep: ctx.tier === 'deep' });
  if (check) checks.push({ ...check, name: 'rust_derived_indexes' });
  return checks;
}

export const rustDerivedIndexesEntry: DoctorEntry = {
  name: 'rust_derived_indexes',
  emits: ['rust_derived_indexes'],
  run: runRustDerivedIndexes,
};
