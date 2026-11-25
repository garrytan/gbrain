/**
 * Write admission for agent policy pages (decision F1). No remote caller writes a policy page:
 * not at its fixed slug, not by declaring type agent_policy, not by retyping or renaming one, the
 * owner's own MCP connections included. Every admitted write is stored `visibility: private`.
 * A trusted local write that did not come through gbrain policy lands as a revision no approval
 * covers, so it is never served until the owner accepts it.
 */
import type { Action } from '../agent-output.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import { AGENT_POLICY_TYPE, isPolicySlug } from './slugs.ts';

function ownerOnly(slug: string): OperationError {
  const fix: Action = {
    argv: ['gbrain', 'policy', 'show'], consent: [], actor: 'user', requires_exclusive: false,
    why: 'The agent policy changes only through gbrain policy, confirmed by the owner in their own terminal.',
    user_message: 'Your agent asked to change your agent policy. To change it yourself, run gbrain policy allow|ask|deny <verb> (or gbrain policy edit) in your own terminal, outside the agent session.',
  };
  return opError('policy_owner_only', `${slug} is the agent policy; only its owner changes it, with gbrain policy on the brain host. Nothing was written.`,
    'Do not retry. Read the policy with agent_policy or policy_check; ask the user to change it with gbrain policy in their own terminal if they want it changed.', { fix });
}

/** Before anything is journaled: a remote write naming a policy slug (as target or as rename destination). */
export function assertPolicySlugWrite(remote: boolean, params: Record<string, unknown>): void {
  if (!remote) return;
  for (const key of ['slug', 'new_slug', 'to_slug', 'target_slug']) {
    if (isPolicySlug(params[key])) throw ownerOnly(String(params[key]));
  }
}

/** At preparation: a page that is, or would become, an agent_policy page. Remote is refused; local is forced private. */
export function admitPolicyFrontmatter(remote: boolean, slug: string, page: { type?: unknown; frontmatter: Record<string, unknown> }, storedType: unknown): void {
  const policy = isPolicySlug(slug) || page.type === AGENT_POLICY_TYPE || page.frontmatter.type === AGENT_POLICY_TYPE || storedType === AGENT_POLICY_TYPE;
  if (!policy) return;
  if (remote) throw ownerOnly(slug);
  page.frontmatter.visibility = 'private';
}
