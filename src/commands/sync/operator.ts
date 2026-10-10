/**
 * #6340: `gbrain sync status` and `gbrain sync unblock`, the operator contract
 * for a managed catch-up (core in `src/core/persistence/sync-status.ts`,
 * decision table in `sync-fault-class.ts`, prose in
 * `docs/guides/sync-unblock-runbook.md`). Both speak the agent operator
 * protocol: `--json` prints one envelope with `next` rendered as a fix. Since
 * #6377 `unblock --apply` also runs the content-repair lane on the holds it
 * clears (`--no-llm`, `--no-repair`), and each repaired path prints its
 * location-only receipt.
 */
import type { BrainEngine } from '../../core/engine.ts';
import { cliRenderContext, renderAction } from '../../core/agent-output.ts';
import { opError } from '../../core/ops/contract.ts';
import { readSyncStatus, unblockSync } from '../../core/persistence/sync-status.ts';
import { HOLD_ATTEMPTS_NEEDS_HUMAN } from '../../core/persistence/sync-fault-class.ts';
import { CONTENT_REPAIR_HOLD_KINDS } from '../../core/repair/content-lane.ts';
import { resolveSourceIdEngineFree } from '../../core/source-resolver.ts';

/** The hold codes the content-repair lane clears today, for the help text. */
const CONTENT_HOLD_CODES = Object.entries(CONTENT_REPAIR_HOLD_KINDS).filter(([, kind]) => kind).map(([code]) => code).join(', ');

export function printSyncStatusHelp(): void {
  console.log(`Usage: gbrain sync status --source <id> [--json]

Where a managed catch-up stands and what to do next, for an operator agent:
the cursor (index/total, pinned target, last advance), pages committed in the
last 10 minutes, every held file and the last recorded failure, each with
  class         page | connection | systemic
  safe_actions  retry | retry_when_clean | repair | reconcile | upgrade | none
  needs_human   whether a person has to decide or act (human_reason says why)
and one \`next\` action. The loop: run this every few minutes; when
committed_last_10m is 0 and needs_human is false, run
\`gbrain sync unblock --source <id> --apply\`, then the sync it prints; when
needs_human is true, page a person with the slug it names.

Decision table: docs/guides/sync-unblock-runbook.md
`);
}

export function printSyncUnblockHelp(): void {
  console.log(`Usage: gbrain sync unblock --source <id> [--apply] [--no-llm] [--no-repair] [--json]

Performs the safe action for every held file of a managed source and refuses
the rest by name. Without --apply it previews. Idempotent; it writes only
hash-bound repairs (each with its receipt), never drops content and never
clears a hold except by repairing its file: refusing is the only way it
leaves a file out, and each refusal names the file, why, and its fix.

  worktree_dirty        re-screened when its working-tree bytes are committed
                        at HEAD now (still dirty: refused still_dirty)
  preparation_stalled   re-screened (the writer, not the file, stalled)
  concurrent_write      refused: a person reconciles the two versions
  ${CONTENT_HOLD_CODES.padEnd(22)}repaired by the content-repair lane (gbrain repair content,
                        each file bound to the bytes its plan read, under the
                        fences.repair caps), then re-screened; per
                        path: repaired | held | needs_human | skipped with the reason,
                        the receipt and the next step. A hold whose stored state waits
                        on a person, the user's spend decision or the owner host is
                        listed, not retried.
  other repair holds    refused with the repair preview to run
  held ${HOLD_ATTEMPTS_NEEDS_HUMAN} times          refused: the page keeps moving; needs a person

  --no-llm              repairs keep to their free tiers (model-tier files stay held)
  --no-repair           refuse every repair-class hold instead (the pre-#6377 behaviour)

Then run the sync \`next\` names (the cursor's own options).
Runbook: docs/guides/sync-unblock-runbook.md
`);
}

function sourceOf(args: string[]): string {
  const explicit = args.find((a, i) => args[i - 1] === '--source') ?? null;
  const source = resolveSourceIdEngineFree(explicit, process.cwd());
  if (!source || source === '__all__') throw opError('invalid_params', 'sync status and sync unblock need one source.', 'Name one source with --source; the fix lists the ids.',
    { fix: { argv: ['gbrain', 'sources', 'list', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Lists the source ids, read-only; then rerun with --source and one of them.' } });
  return source;
}

export async function runSyncStatus(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) return printSyncStatusHelp();
  const sourceId = sourceOf(args);
  const status = await readSyncStatus(engine, sourceId);
  const ctx = cliRenderContext();
  const rendered = { ...status, holds: status.holds.map(hold => ({ ...hold, fix: renderAction(hold.fix, ctx) })), next: status.next ? renderAction(status.next, ctx) : null };
  if (args.includes('--json')) { console.log(JSON.stringify(rendered, null, 2)); return; }
  const c = status.cursor;
  console.log(`Source ${sourceId}: ${c ? c.done ? `last run finished at ${c.index}/${c.total} (pinned ${c.pinned_target?.slice(0, 8) ?? '?'})` : `cursor ${c.index}/${c.total} at pinned target ${c.pinned_target?.slice(0, 8) ?? '?'}`
    + `${c.last_advance_at ? `, last advance ${c.last_advance_at}` : ''}` : 'no managed cursor'}`);
  console.log(`  committed in the last 10 minutes: ${status.committed_last_10m}${status.rate_pages_per_min !== null ? `, ${status.rate_pages_per_min} pages/min` : ''}`);
  console.log(`  holds: ${status.holds.length}${status.holds.length ? ` (${status.holds.filter(h => h.needs_human).length} need a person)` : ''}; last error: ${status.last_error ? `${status.last_error.code} [${status.last_error.class}]` : 'none'}`);
  for (const hold of status.holds) console.log(`    ${hold.path}${hold.slug ? ` (${hold.slug})` : ''}: ${hold.code} [${hold.class}] safe: ${hold.safe_actions.join(',')}${hold.needs_human ? ` NEEDS HUMAN: ${hold.human_reason}` : ''}${hold.attempts > 1 ? ` (held ${hold.attempts} times)` : ''}`);
  if (status.last_error) console.log(`    ${status.last_error.path ?? ''}: ${status.last_error.code} safe: ${status.last_error.safe_actions.join(',')}${status.last_error.needs_human ? ` NEEDS HUMAN: ${status.last_error.human_reason}` : ''}`);
  if (rendered.next) console.log(`  Next: ${rendered.next.command ?? rendered.next.argv?.join(' ')}\n  Why: ${rendered.next.why}`);
  else console.log('  Next: nothing; the source is synced and holds nothing.');
}

export async function runSyncUnblock(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) return printSyncUnblockHelp();
  const sourceId = sourceOf(args);
  const outcome = await unblockSync(engine, sourceId, { apply: args.includes('--apply'), noLlm: args.includes('--no-llm'), noRepair: args.includes('--no-repair') });
  const ctx = cliRenderContext();
  const rendered = { ...outcome,
    applied: outcome.applied.map(entry => entry.action === 'repair' ? { ...entry, repair: { ...entry.repair, next: renderAction(entry.repair.next, ctx) } } : entry),
    refused: outcome.refused.map(entry => ({ ...entry, fix: renderAction(entry.fix, ctx) })), next: outcome.next ? renderAction(outcome.next, ctx) : null };
  if (args.includes('--json')) { console.log(JSON.stringify(rendered, null, 2)); return; }
  const repaired = outcome.applied.filter(entry => entry.action === 'repair').length;
  console.log(`Source ${sourceId}: ${outcome.applied.length} held file(s) ${outcome.apply ? `${repaired ? 'repaired or ' : ''}scheduled for a re-screen` : `would be ${repaired ? 'repaired or ' : ''}scheduled for a re-screen (preview; add --apply)`}, ${outcome.refused.length} refused.`);
  for (const entry of outcome.applied) {
    console.log(`  ${entry.path}: ${entry.code} → ${entry.action}: ${entry.detail}`);
    if (entry.action === 'repair' && entry.repair.receipt) console.log(`    receipt: ${Object.entries(entry.repair.receipt).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  for (const entry of outcome.refused) console.log(`  ${entry.path}: ${entry.code} refused (${entry.reason})${entry.needs_human ? ' NEEDS HUMAN' : ''}`);
  if (rendered.next) console.log(`  Next: ${rendered.next.command ?? rendered.next.argv?.join(' ')}\n  Why: ${rendered.next.why}`);
  else console.log('  Next: nothing held.');
}
