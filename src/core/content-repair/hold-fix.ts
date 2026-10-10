/**
 * #6377: what a `frontmatter_slug_conflict` sync hold tells an agent, by the
 * content-repair lane's recorded state (`meta.content_repair`, written by
 * `recordContentHoldRepair`). The command is always that file's
 * `gbrain repair content --source <id> --only <path>` (Lane C's lane runner:
 * fences, then slug conflicts, for one selection); the step it calls for
 * depends on the state:
 *
 * - no state: the lane has not judged it yet. gbrain repairs it by itself on
 *   the next maintenance run or on `sync unblock --apply`; the preview is
 *   read-only and calls no model.
 * - `merge_into` (`merge_recommended`): a person merges the two pages; the
 *   fix is addressed to the user with the rendered paragraph
 *   (`contentRepairHumanReason`: codes and slugs, never model prose).
 * - `needs_human` (`content_repair_needs_human`): the model could not decide;
 *   the user chooses which page keeps the slug.
 * - `pending` on a paid reason (`llm_disabled`, `budget_exhausted`,
 *   `no_measured_model`, `no_pricing`): waits on spend the user controls; the
 *   fix names the setting with consent `paid`.
 * - `pending` on a transient reason (`llm_unavailable`,
 *   `ledger_unavailable`, `sync_in_progress`, `claimed_elsewhere`): the next
 *   run retries after `next_attempt_after`.
 * - `remove_slug` recorded (the edit could not be written: `canonical_overlay`,
 *   `still_invalid`, `changed_since_read`): the exact one-line edit by hand.
 *
 * Location only: path, slugs, codes and amounts.
 */
import type { Action, ActionInput, Effect } from '../agent-output.ts';
import { CONTENT_REPAIR_MEASURED_MODELS } from './measured.ts';
import type { ContentHoldRepairState } from '../persistence/sync-holds.ts';
import { contentRepairHumanReason } from '../persistence/sync-fault-class.ts';

const PAID: ReadonlySet<string> = new Set(['llm_disabled', 'budget_exhausted', 'no_measured_model', 'no_pricing']);

/** The read-only preview of one held file's content repair. */
export function contentPreviewArgv(sourceId: string, path?: string): string[] {
  return ['gbrain', 'repair', 'content', '--source', sourceId, ...(path ? ['--only', path] : [])];
}

/** The docs anchor a judged hold points at (the hold code's own anchor otherwise). */
export function contentHoldDocs(state: ContentHoldRepairState | undefined): string {
  if (state?.action === 'merge_into') return 'docs/guides/write-refusals.md#merge_recommended';
  if (state?.action === 'needs_human') return 'docs/guides/write-refusals.md#content_repair_needs_human';
  return 'docs/guides/write-refusals.md#frontmatter_slug_conflict';
}

/** The paid setting a pending hold waits on, with the inputs a placeholder needs. */
function paidStep(reason: string, model: string | undefined): { argv: string[]; inputs?: ActionInput[] } {
  if (reason === 'llm_disabled') return { argv: ['gbrain', 'config', 'set', 'fences.repair.llm', 'true'] };
  if (reason === 'no_measured_model') return { argv: ['gbrain', 'config', 'set', 'models.content_repair', '<model>'],
    inputs: [{ name: 'model', how: `The provider:model the user chooses to trust with the slug-conflict judgment. Measured: ${CONTENT_REPAIR_MEASURED_MODELS.join(', ')}; each needs its provider's key.` }] };
  if (reason === 'no_pricing') return { argv: ['gbrain', 'pricing', 'set', model ?? '<model>', '--input', '<usd>', '--output', '<usd>'],
    inputs: [...(model ? [] : [{ name: 'model', how: 'The content-repair model: models.content_repair in gbrain models --json.' }]),
      { name: 'usd', how: "The provider's price in USD per 1M input tokens after --input and per 1M output tokens after --output, from its pricing page." }] };
  return { argv: ['gbrain', 'config', 'set', 'fences.repair.max_usd_per_day', '<usd>'],
    inputs: [{ name: 'usd', how: 'The daily cap in USD the user agreed to; read the current one with gbrain config get fences.repair.max_usd_per_day.' }] };
}

export function contentHoldFix(record: { source_id: string; path: string; slug?: string | null; meta: { content_repair?: ContentHoldRepairState } }): Action {
  const source = record.source_id;
  const preview = contentPreviewArgv(source, record.path);
  const verify = { argv: ['gbrain', 'sources', 'status', source, '--json'] };
  const docs = contentHoldDocs(record.meta.content_repair);
  const state = record.meta.content_repair;
  const base = { argv: preview, consent: [] as Effect[], requires_exclusive: false, verify, docs };
  if (!state) {
    return { ...base, actor: 'agent',
      why: `The frontmatter slug of ${record.path} names another page. The content-repair lane clears this itself on the next maintenance run or with gbrain sync unblock --source ${source} --apply: `
        + 'a stray slug (no such page, or a page of another type with nothing in common) is removed deterministically; anything else is judged by the content-repair model under the fences.repair caps. '
        + 'The preview is read-only and calls no model: it lists the planned action, the estimated model cost and the cap left, and prints the apply command.' };
  }
  const paragraph = contentRepairHumanReason({ ...state, path: record.path, slug: record.slug ?? null });
  if (paragraph) {
    return { ...base, actor: 'user', user_message: paragraph,
      why: state.action === 'merge_into'
        ? `The content-repair model judged ${record.path} and page ${state.canonical ?? state.named ?? '?'} to be the same page (merge_recommended). gbrain does not merge pages by itself yet, so a person merges them; nothing was written. `
          + 'Removing the slug: line instead would mint a second page for the same thing, so the deterministic repair never applies here.'
        : `The content-repair model could not decide whether ${record.path} and the page its slug: line names are the same page (content_repair_needs_human), so nothing was written and nothing retries it until the file changes. `
          + 'A person decides which page keeps the slug.' };
  }
  if (state.action === 'pending' && PAID.has(state.reason)) {
    return { ...base, actor: 'agent', consent: ['paid' as Effect], ...paidStep(state.reason, state.model),
      why: `${record.path} waits for the content-repair model (${state.reason}): ${state.reason === 'llm_disabled' ? 'model repair is off (fences.repair.llm false)'
        : state.reason === 'no_measured_model' ? 'no measured model has a provider key here and models.content_repair is unset'
        : state.reason === 'no_pricing' ? `gbrain has no price for ${state.model ?? 'the model'} under a user-set cap` : 'the daily content-repair budget is spent'}. `
        + `Spending is the user's call; ask before changing it. Until then the file stays held${state.next_attempt_after ? ` and the maintenance run tries again after ${state.next_attempt_after}` : ''}. `
        + `Preview: ${preview.join(' ')}`,
      user_message: `${record.path} has a frontmatter slug conflict only a model call can judge, and ${state.reason === 'llm_disabled' ? 'model repair is turned off' : state.reason === 'budget_exhausted' ? 'the daily model budget for content repair is spent'
        : state.reason === 'no_pricing' ? 'gbrain has no price for the configured model' : 'no measured model has a key here'}. Allow the spend, or leave the file held?` };
  }
  if (state.action === 'pending') {
    return { ...base, actor: 'agent',
      why: `${record.path} is held until the content-repair model can judge it (${state.reason}); the maintenance run tries again${state.next_attempt_after ? ` after ${state.next_attempt_after}` : ''}. `
        + `Run the preview now to retry immediately (read-only), then its apply command.` };
  }
  return { ...base, actor: 'agent',
    why: `gbrain decided to remove the slug: line of ${record.path} but could not write it (${state.reason}); the preview shows the current state. `
      + `By hand: delete the slug: line of ${record.path} (the path decides the slug), commit, and run gbrain sync --source ${source} --no-pull.` };
}
