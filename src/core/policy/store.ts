/**
 * The stored agent policy (decision F1): one private agent_policy page per scope at a fixed slug,
 * and an approval record per scope in config (`policy.approved.<scope>`) holding the approved
 * canonical rules, their digest, the page revision and the owner's proof. The served policy is
 * the approved one: a page revision whose digest no approval matches is foreign, and serving
 * continues from the approval. Reads here are trusted internal reads that callers only ever see
 * through derived fields (decision, rule id, revision, state).
 *
 * Tamper-evident against agents writing through gbrain, not against someone with database access.
 */
import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../ops/contract.ts';
import { opError } from '../ops/contract.ts';
import { loadConfig } from '../config.ts';
import { submitPageMutation } from '../persistence/page-mutations.ts';
import { dumpFrontmatterYaml } from '../data-frontmatter.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';
import { parsePolicyFence, policyDigest, renderPolicyFence, type PolicyParseError, type PolicyRule } from './fence.ts';
import { AGENT_POLICY_TYPE, POLICY_SLUGS, POLICY_SOURCE, type PolicyScope } from './slugs.ts';
import { confirmOnTerminal, confirmRequiredError, POLICY_APPROVAL_PREFIX, terminalAuthorityProblem, withOwnerProof, type OwnerProof, type TerminalProbe } from './authority.ts';

export { AGENT_POLICY_TYPE, isPolicySlug, POLICY_SCOPES, POLICY_SLUGS, POLICY_SOURCE, type PolicyScope } from './slugs.ts';
/** How long a confirmed change is announced in the session-start pack. */
export const CHANGE_NOTICE_MS = 7 * 24 * 3600 * 1000;


export interface PolicyApproval {
  scope: PolicyScope;
  digest: string;
  /** The page revision (knowledge_revision) the owner approved. */
  revision: string;
  rules: PolicyRule[];
  /** One line naming what changed, read by the change notice. */
  change: string;
  proof: OwnerProof;
}

export type PolicyState = 'none' | 'ok' | 'malformed' | 'changed_outside_gbrain' | 'unapproved';

export interface ServedPolicy {
  scope: PolicyScope;
  state: PolicyState;
  /** True when `rules` come from a verified approval and are evaluated; otherwise every outside verb asks. */
  authoritative: boolean;
  rules: PolicyRule[];
  served_revision: string | null;
  page_revision: string | null;
  approval: PolicyApproval | null;
  parse_error?: PolicyParseError;
  foreign?: { revision: string; author: string };
}

interface PolicyPage { body: string; revision: string; author: string }

async function readPolicyPage(engine: BrainEngine, scope: PolicyScope): Promise<PolicyPage | null> {
  const page = await engine.getPage(POLICY_SLUGS[scope], { sourceId: POLICY_SOURCE });
  if (!page) return null;
  // The typed member (a Rust brain serves it), not raw SQL: the policy answer must not stop on raw_sql there.
  const row = await engine.readPageRevisionAttribution(page.id);
  return { body: isSegmentedPage(page) ? '' : page.compiled_truth ?? '', revision: String(page.knowledge_revision ?? ''), author: row?.kind ? `${row.kind}:${row.pid ?? ''}` : 'unrecorded' };
}

/** The approval record, or null when absent or when its digest does not cover its own rules and proof. */
export async function readApproval(engine: BrainEngine, scope: PolicyScope): Promise<PolicyApproval | null> {
  const raw = await engine.getConfig(`${POLICY_APPROVAL_PREFIX}${scope}`);
  if (!raw) return null;
  try {
    const a = JSON.parse(raw) as PolicyApproval;
    if (!Array.isArray(a.rules) || typeof a.digest !== 'string' || typeof a.revision !== 'string' || !a.proof) return null;
    if (policyDigest(a.rules) !== a.digest || a.proof.digest !== a.digest) return null;
    if (a.proof.method !== 'terminal' && a.proof.method !== 'owner_session') return null;
    return { ...a, scope };
  } catch {
    return null;
  }
}

export async function resolvePolicy(engine: BrainEngine, scope: PolicyScope): Promise<ServedPolicy> {
  const [page, approval] = await Promise.all([readPolicyPage(engine, scope), readApproval(engine, scope)]);
  const base = { scope, approval, page_revision: page?.revision ?? null };
  if (!page && !approval) return { ...base, state: 'none', authoritative: false, rules: [], served_revision: null };
  if (!page) return { ...base, state: 'changed_outside_gbrain', authoritative: true, rules: approval!.rules, served_revision: approval!.revision, foreign: { revision: 'deleted', author: 'unrecorded' } };
  const parsed = parsePolicyFence(page.body);
  if (!parsed.ok) return approval
    ? { ...base, state: 'malformed', authoritative: true, rules: approval.rules, served_revision: approval.revision, parse_error: parsed.error }
    : { ...base, state: 'malformed', authoritative: false, rules: [], served_revision: null, parse_error: parsed.error };
  if (!approval) return { ...base, state: 'unapproved', authoritative: false, rules: [], served_revision: null };
  if (policyDigest(parsed.rules) === approval.digest) return { ...base, state: 'ok', authoritative: true, rules: approval.rules, served_revision: page.revision };
  return { ...base, state: 'changed_outside_gbrain', authoritative: true, rules: approval.rules, served_revision: approval.revision, foreign: { revision: page.revision, author: page.author } };
}

/** The page body the policy commands write: a short header and the canonical fence. */
export function renderPolicyPage(scope: PolicyScope, rules: readonly PolicyRule[]): string {
  const frontmatter = dumpFrontmatterYaml({ type: AGENT_POLICY_TYPE, title: scope === 'owner' ? 'Agent policy' : 'Company agent policy', visibility: 'private' });
  return `---\n${frontmatter.trimEnd()}\n---\n\n# ${scope === 'owner' ? 'Agent policy' : 'Company agent policy'}\n\n`
    + 'When an agent may send, spend, delete, sign up, call or publish on the user\'s behalf outside this brain. '
    + 'Advisory: harnesses check it with policy_check and keep their own approvals. Change it with gbrain policy; a change made any other way is not served until the owner accepts it.\n\n'
    + `${renderPolicyFence(rules)}\n`;
}

function localCtx(engine: BrainEngine): OperationContext {
  return { engine, config: loadConfig() ?? { engine: engine.kind }, remote: false, dryRun: false, sourceId: POLICY_SOURCE,
    logger: { info: () => {}, warn: (m: string) => console.error(m), error: (m: string) => console.error(m) } } as unknown as OperationContext;
}

async function writePage(engine: BrainEngine, scope: PolicyScope, rules: readonly PolicyRule[], expected: string | null): Promise<string> {
  await submitPageMutation(localCtx(engine), { operation: 'put_page', params: {
    slug: POLICY_SLUGS[scope], source_id: POLICY_SOURCE, content: renderPolicyPage(scope, rules), ...(expected ? { expected_revision: expected } : {}) } });
  const after = await readPolicyPage(engine, scope);
  if (!after) throw opError('policy_malformed', 'The policy page was not found after writing it.', 'Run gbrain policy show --check.');
  return after.revision;
}

async function saveApproval(engine: BrainEngine, approval: PolicyApproval): Promise<void> {
  await withOwnerProof(approval.proof, () => engine.setConfig(`${POLICY_APPROVAL_PREFIX}${approval.scope}`, JSON.stringify(approval)));
}

export interface PolicyChange {
  scope: PolicyScope;
  rules: PolicyRule[];
  /** One line naming the change, shown at the prompt and in the change notice. */
  change: string;
  probe?: TerminalProbe;
}

export type PolicyWriteResult = { status: 'unchanged'; revision: string | null } | { status: 'approved'; revision: string; digest: string; proof: OwnerProof };

/**
 * Write and approve a policy change. With owner authority (a terminal, no agent marker) the owner
 * confirms first, then the page and its approval are written. Without it the page is saved as a
 * pending revision that changes nothing served, and policy_confirm_required names the exact
 * `gbrain policy accept <revision>` the owner runs.
 */
export async function applyPolicyChange(engine: BrainEngine, c: PolicyChange): Promise<PolicyWriteResult> {
  const current = await resolvePolicy(engine, c.scope);
  const digest = policyDigest(c.rules);
  if (current.state === 'ok' && current.approval?.digest === digest) return { status: 'unchanged', revision: current.served_revision };
  const problem = terminalAuthorityProblem(c.probe);
  if (problem) {
    const revision = await writePage(engine, c.scope, c.rules, current.page_revision);
    throw confirmRequiredError(['gbrain', 'policy', 'accept', revision, ...(c.scope === 'company' ? ['--scope', 'company'] : [])], problem,
      `The change was saved as pending revision ${revision}; agents keep getting the last approved policy until the owner accepts it.`);
  }
  const proof = await confirmOnTerminal({ argv: ['gbrain', 'policy', 'accept'], summary: [`Scope: ${c.scope}`, `Change: ${c.change}`, `Rules after the change: ${c.rules.length}`], digest, probe: c.probe });
  const revision = await writePage(engine, c.scope, c.rules, current.page_revision);
  await saveApproval(engine, { scope: c.scope, digest, revision, rules: c.rules, change: c.change, proof });
  return { status: 'approved', revision, digest, proof };
}

/** Approve the page's current revision, bound to its digest. `proof` comes from the owner session; otherwise the owner confirms at the terminal. */
export async function acceptRevision(engine: BrainEngine, scope: PolicyScope, revision: string, opts: { proof?: (digest: string) => OwnerProof; probe?: TerminalProbe } = {}): Promise<PolicyWriteResult> {
  const page = await readPolicyPage(engine, scope);
  if (!page || page.revision !== revision) {
    throw opError('policy_revision_stale', `Revision ${revision} is not the current ${scope} policy page, so nothing was approved.`,
      'Run gbrain policy show to see the current revision, then accept that one.');
  }
  const parsed = parsePolicyFence(page.body);
  if (!parsed.ok) {
    throw opError('policy_malformed', `The ${scope} policy page is malformed at line ${parsed.error.line}, column ${parsed.error.column}: ${parsed.error.message}. Nothing was approved.`,
      'Fix the fence (gbrain policy show --check names the problem), or set rules with gbrain policy allow|ask|deny.');
  }
  const digest = policyDigest(parsed.rules);
  const current = await readApproval(engine, scope);
  const change = `accepted revision ${revision} (${parsed.rules.length} rules${current ? `, was ${current.rules.length}` : ''})`;
  const proof = opts.proof ? opts.proof(digest)
    : await confirmOnTerminal({ argv: ['gbrain', 'policy', 'accept', revision, ...(scope === 'company' ? ['--scope', 'company'] : [])],
      summary: [`Scope: ${scope}`, `Revision: ${revision}`, `Written by: ${page.author}`, ...renderPolicyFence(parsed.rules).split('\n').slice(1, -1)], digest, probe: opts.probe });
  if (proof.digest !== digest) throw confirmRequiredError(['gbrain', 'policy', 'accept', revision], { reason: 'declined' });
  await saveApproval(engine, { scope, digest, revision, rules: parsed.rules, change, proof });
  return { status: 'approved', revision, digest, proof };
}
