/**
 * GST-3032: the delete triggers behind owner_only_marks (migration v322). Each one marks, before an origin row goes, every
 * row derived from it, so owner-only lineage outlives a removed source or a hard-deleted page, fact, take or timeline
 * row. CREATE TRIGGER needs the table's owner, so a table another role owns is never an aborted upgrade and never
 * skipped silently: the trigger is left, named on stderr by the migration run and by doctor (owner_only_marks_triggers)
 * with the owner fix, and every later migration run creates it once a role that owns the table runs. While one is
 * missing on a brain that holds an owner-only source or a mark, the unguarded mark ('*', 'unguarded') closes owner-only
 * lineage (see v322): every row with a recorded derivation input and every synthesized concept or question reads as
 * owner-only. The SQL is BrainEngine.ownerOnlyMarkTriggers (engine-sql/owner-only-marks.ts).
 */
import type { BrainEngine } from '../engine.ts';

/** The schema version (migration v322) that creates owner_only_marks and the trigger functions; keep it equal on a renumber. */
export const OWNER_ONLY_MARKS_SINCE = 322;

/** The tables a delete trigger guards. */
export type OwnerOnlyTriggerTable = 'sources' | 'pages' | 'facts' | 'takes' | 'timeline_entries';

export interface OwnerOnlyTriggerState {
  /** Tables whose trigger is missing, with the role that owns each and whether the current role may create it. */
  missing: Array<{ table: OwnerOnlyTriggerTable; owner: string; owned: boolean }>;
  /** The current role, quoted for the ALTER TABLE fix. */
  role: string;
  /** The unguarded mark is set: owner-only lineage reads closed. */
  closed: boolean;
  /** The row-security mark is set: a role whose reads row-level security limits deleted a row, so lineage reads closed. */
  rowSecurity: boolean;
  /** The brain has held owner-only data (v322's flag on owner_only_marks), so the guard stays on for good. */
  held: boolean;
  /** Marks exist but the held flag is unset (copied in by graduation or a data-only restore): the guard does not read them. */
  unflagged: boolean;
  /** Logins that read `sources` but cannot read and add marks, quoted, with the quoted names of the policies doctor prints; empty unless `held`. */
  deniedLogins: Array<{ login: string; readPolicy: string; addPolicy: string }>;
}

/** Every migration run: create each delete trigger a role that owns its table can now create; name what is left. Never throws. */
export async function ensureOwnerOnlyMarkTriggersAtRun(engine: BrainEngine, nameLeftovers: boolean): Promise<void> {
  try {
    if (Number(await engine.getConfig('version')) < OWNER_ONLY_MARKS_SINCE) return;
    const left = await engine.ownerOnlyMarkTriggers({ ensure: true });
    if (nameLeftovers && left.missing.length) process.stderr.write(ownerOnlyTriggersLeftLine(left));
  } catch (e) {
    process.stderr.write(`  owner-only marks: checking the delete triggers failed (${e instanceof Error ? e.message : String(e)}); gbrain doctor (owner_only_marks_triggers) names what is missing\n`);
  }
}

/** The stderr line naming the triggers a migration run could not create, with the owner fix. */
export function ownerOnlyTriggersLeftLine(state: OwnerOnlyTriggerState): string {
  const named = state.missing.map(m => `${m.table} (owner ${m.owner})`).join(', ');
  return `  owner-only marks: ${state.missing.length} delete trigger(s) not created (${named}): CREATE TRIGGER needs the table's owner. `
    + `As that role run ${state.missing.map(m => `ALTER TABLE public.${m.table} OWNER TO ${state.role};`).join(' ')} or connect gbrain as it; the next migration run creates them.`
    + (state.closed ? ' Until then owner-only lineage reads closed: every derived row and synthesized concept counts as owner-only.' : '') + '\n';
}
