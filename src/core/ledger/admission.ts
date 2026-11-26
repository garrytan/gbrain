/**
 * Write admission for agent_action pages (L2). A remote caller records an action only through
 * log_action or policy_reserve, which stamp the actor and compute claim_basis on the server; a
 * remote put_page, rename or retype onto an action page is refused. A trusted local write is
 * validated strictly and stored private.
 */
import type { Action } from '../agent-output.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import { AGENT_ACTION_TYPE, isActionSlug, validateActionFrontmatter } from './action.ts';

function logActionOnly(slug: string): OperationError {
  const fix: Action = { mcp: { tool: 'log_action', arguments: { verb: 'spend', summary: '<what was done>', request_id: '<a new UUID>' } }, consent: [], actor: 'agent', requires_exclusive: false,
    why: 'Record an outside action with log_action: gbrain stamps who logged it and works out whether its evidence holds.' };
  return opError('ledger_log_action_only', `${slug} is an action ledger page; remote callers record actions with log_action, not by writing the page. Nothing was written.`,
    'Call log_action (or policy_reserve for a budget hold) instead of writing the page.', { fix });
}

export function assertActionSlugWrite(remote: boolean, params: Record<string, unknown>): void {
  if (!remote) return;
  for (const key of ['slug', 'new_slug', 'to_slug', 'target_slug']) {
    if (isActionSlug(params[key])) throw logActionOnly(String(params[key]));
  }
}

export function admitActionFrontmatter(remote: boolean, slug: string, page: { type?: unknown; frontmatter: Record<string, unknown> }, storedType: unknown): void {
  const action = isActionSlug(slug) || page.type === AGENT_ACTION_TYPE || page.frontmatter.type === AGENT_ACTION_TYPE || storedType === AGENT_ACTION_TYPE;
  if (!action) return;
  if (remote) throw logActionOnly(slug);
  if (!isActionSlug(slug)) throw opError('action_invalid', `An agent_action page lives at actions/YYYY/MM/<id>, not ${slug}. Nothing was written.`, 'Record actions with gbrain ledger add or log_action.');
  const checked = validateActionFrontmatter(page.frontmatter);
  if (!checked.ok) throw opError('action_invalid', `${slug}: ${checked.message}. Nothing was written.`, 'Record actions with gbrain ledger add or log_action, which write the exact shape.', { detail: checked.field });
  page.frontmatter.visibility = 'private';
}
