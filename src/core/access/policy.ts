/**
 * GBRA-218 (PR A2): the folder-rule policy lifecycle, one engine for both stores.
 *
 * Every source with a policy has one access_policy_state row (its lock), an
 * append-only access_policy_revisions log of desired rulebooks, and the
 * applied rulebook in access_rules, which page writes stamp folder_rule_ids
 * from (migration v275). The store (`sources.config.access_store`, git or
 * database) only decides where desired revisions come from: `gbrain access rule`
 * on a database store, the committed `.gbrain/access.yml` on a git store
 * (policy-git.ts). From there the lifecycle is the same:
 *
 *  - proposeRevision records the desired rulebook and installs the narrowing
 *    part of the change at once (classifyRulebook): new prefixes are marked
 *    pending (they read as nobody), pages are restamped in batches, a final
 *    pass under the source lock restamps anything written meanwhile, and only
 *    then does the pending coverage go and the revision count as applied.
 *  - the widening part is held: the applied rules stay until
 *    applyApproved (`gbrain access apply --yes --expect <plan_hash>`) installs a
 *    previewed revision; a plan hash over the desired and applied digests
 *    refuses `preview_changed` when either moved.
 *  - resume finishes an interrupted narrowing; it is idempotent and only ever
 *    restamps toward the applied rulebook.
 */
import { createHash, randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import type { BrainEngine } from '../engine.ts';
import { opError } from '../ops/contract.ts';
import { classifyRulebook, folderRulesAllow, rulebookDigest, rulesFromJson, sortRules, type Classification, type FolderRule, type RuleChange } from './folder-rules.ts';
import { identityFor } from './principals.ts';
import { listMembers } from './members.ts';

export type AccessStore = 'git' | 'database';
type Exec = Pick<BrainEngine, 'executeRaw'>;

export const RESTAMP_BATCH = 2000;

/** Test seam: runs after a narrowing is installed (rules and pending coverage committed) and before its restamp. */
export const policySeams: { afterInstall?: (sourceId: string) => Promise<void> | void } = {};

export interface RevisionRow {
  revision: number;
  rules: FolderRule[];
  digest: string;
  change_kind: Classification['kind'];
  origin: string;
  operation_id: string | null;
  proposed_by: string | null;
  approved_by: string | null;
  created_at: string;
  applied_at: string | null;
  approved_at: string | null;
}

export interface CoverageRow { prefix: string; reason: 'pending' | 'invalid'; revision: number | null; detail: unknown }

export type ProposalState = 'applied' | 'pending' | 'recorded' | 'unchanged';

export interface ProposalResult {
  source_id: string;
  operation_id: string | null;
  revision: number | null;
  /** applied: everything in force; recorded: the narrowing part is in force and a widening waits for gbrain access apply; pending: a narrowing is still being stamped (gbrain access resume finishes it); unchanged: the desired rulebook already matched. */
  state: ProposalState;
  change_kind: Classification['kind'];
  changes: RuleChange[];
  held: RuleChange[];
  pages_restamped: number;
  reconciled?: boolean;
}

/** The local operator recorded on revisions this process writes. */
export function localActor(): string {
  try { return `local:${userInfo().username}`; } catch { return 'local'; }
}

function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v.toISOString() : String(v);
}

function toRevision(row: Record<string, unknown>): RevisionRow {
  return {
    revision: Number(row.revision), rules: rulesFromJson(row.rules), digest: String(row.digest),
    change_kind: row.change_kind as RevisionRow['change_kind'], origin: String(row.origin),
    operation_id: (row.operation_id as string | null) ?? null, proposed_by: (row.proposed_by as string | null) ?? null,
    approved_by: (row.approved_by as string | null) ?? null, created_at: iso(row.created_at)!, applied_at: iso(row.applied_at), approved_at: iso(row.approved_at),
  };
}

/** The persisted store of a source, or null when it has never had a rule. Refuses an unknown source. */
export async function readAccessStore(engine: Exec, sourceId: string): Promise<AccessStore | null> {
  const [row] = await engine.executeRaw<{ store: string | null }>(`SELECT config->>'access_store' AS store FROM sources WHERE id = $1`, [sourceId]);
  if (!row) throw opError('unknown_source', `No source "${sourceId}".`, 'List sources with gbrain sources list.');
  return row.store === 'git' || row.store === 'database' ? row.store : null;
}

/** Persists the store (set with the first rule, changed only by gbrain access rule migrate). */
export async function writeAccessStore(engine: Exec, sourceId: string, store: AccessStore): Promise<void> {
  await engine.executeRaw(`UPDATE sources SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{access_store}', to_jsonb($2::text)) WHERE id = $1`, [sourceId, store]);
}

/** Creates the source's lock row in its own committed statement, so concurrent page writes start taking it before any rule exists. */
export async function ensurePolicyState(engine: Exec, sourceId: string): Promise<void> {
  await engine.executeRaw('INSERT INTO access_policy_state (source_id) VALUES ($1) ON CONFLICT (source_id) DO NOTHING', [sourceId]);
}

/**
 * The source row first, then its policy row: page writers hold `sources FOR SHARE` before their stamping trigger takes
 * the policy row, so the same order lets a write already in flight finish (and be stamped here) instead of deadlocking.
 */
export async function lockSource(tx: Exec, sourceId: string): Promise<void> {
  await tx.executeRaw('SELECT 1 FROM sources WHERE id = $1 FOR NO KEY UPDATE', [sourceId]);
  await tx.executeRaw('SELECT 1 FROM access_policy_state WHERE source_id = $1 FOR UPDATE', [sourceId]);
}

export async function appliedRules(engine: Exec, sourceId: string): Promise<FolderRule[]> {
  const rows = await engine.executeRaw<{ rule_id: string; prefix: string; readable_by: string[] }>(
    'SELECT rule_id, prefix, readable_by FROM access_rules WHERE source_id = $1 ORDER BY rule_id', [sourceId]);
  return sortRules(rows.map(r => ({ id: r.rule_id, prefix: r.prefix, readable_by: [...(r.readable_by ?? [])] })));
}

export async function listRevisions(engine: Exec, sourceId: string, limit = 50): Promise<RevisionRow[]> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    'SELECT * FROM access_policy_revisions WHERE source_id = $1 ORDER BY revision DESC LIMIT $2', [sourceId, limit]);
  return rows.map(toRevision);
}

export async function getRevision(engine: Exec, sourceId: string, revision?: number): Promise<RevisionRow | null> {
  const rows = revision === undefined
    ? await engine.executeRaw<Record<string, unknown>>('SELECT * FROM access_policy_revisions WHERE source_id = $1 ORDER BY revision DESC LIMIT 1', [sourceId])
    : await engine.executeRaw<Record<string, unknown>>('SELECT * FROM access_policy_revisions WHERE source_id = $1 AND revision = $2', [sourceId, revision]);
  return rows[0] ? toRevision(rows[0]) : null;
}

export async function coverageRows(engine: Exec, sourceId: string): Promise<CoverageRow[]> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    'SELECT prefix, reason, revision, detail FROM access_pending_coverage WHERE source_id = $1 ORDER BY reason, prefix', [sourceId]);
  return rows.map(r => ({ prefix: String(r.prefix), reason: r.reason as CoverageRow['reason'], revision: r.revision === null ? null : Number(r.revision),
    detail: typeof r.detail === 'string' ? JSON.parse(r.detail) : r.detail ?? null }));
}

const key = (r: FolderRule) => `${r.id}\u0000${r.prefix}`;

/**
 * Makes `target` the applied rulebook inside the caller's locked transaction. Rules whose (id, prefix) pair is new get
 * pending coverage until the restamp finishes. Returns whether pages need restamping.
 */
async function installRulebook(tx: Exec, sourceId: string, target: readonly FolderRule[], revision: number, actor: string): Promise<boolean> {
  const current = await appliedRules(tx, sourceId);
  const before = new Map(current.map(r => [r.id, r]));
  const after = new Map(target.map(r => [r.id, r]));
  const currentKeys = new Set(current.map(key));
  const targetKeys = new Set(target.map(key));
  for (const r of current) {
    const next = after.get(r.id);
    if (!next || next.prefix !== r.prefix || next.readable_by.join('\u0000') !== r.readable_by.join('\u0000')) {
      await tx.executeRaw('DELETE FROM access_rules WHERE source_id = $1 AND rule_id = $2', [sourceId, r.id]);
    }
  }
  for (const r of target) {
    const prior = before.get(r.id);
    if (prior && prior.prefix === r.prefix && prior.readable_by.join('\u0000') === r.readable_by.join('\u0000')) continue;
    await tx.executeRaw('INSERT INTO access_rules (source_id, rule_id, prefix, readable_by, revision, created_by) VALUES ($1, $2, $3, $4::text[], $5, $6)',
      [sourceId, r.id, r.prefix, r.readable_by, revision, actor]);
  }
  const added = target.filter(r => !currentKeys.has(key(r)));
  for (const r of added) {
    await tx.executeRaw(`INSERT INTO access_pending_coverage (source_id, prefix, reason, revision) VALUES ($1, $2, 'pending', $3)
      ON CONFLICT (source_id, prefix, reason) DO UPDATE SET revision = EXCLUDED.revision`, [sourceId, r.prefix, revision]);
  }
  return added.length > 0 || current.some(r => !targetKeys.has(key(r)));
}

export interface RestampProgress { pages_scanned: number; pages_restamped: number }

/**
 * Restamps folder_rule_ids toward the applied rulebook in id-ordered windows (each its own statement, so page writes
 * are never blocked for long), then finishes under the source lock: one more pass over the whole source catches pages
 * written meanwhile, the pending coverage goes, and pending revisions count as applied, atomically.
 */
export async function restampSource(engine: BrainEngine, sourceId: string, opts: { batch?: number; onProgress?: (p: RestampProgress) => void } = {}): Promise<RestampProgress> {
  const batch = opts.batch ?? RESTAMP_BATCH;
  const progress: RestampProgress = { pages_scanned: 0, pages_restamped: 0 };
  let after = 0;
  for (;;) {
    const [row] = await engine.executeRaw<{ last: number | null; scanned: number; changed: number }>(
      `WITH w AS (SELECT id FROM pages WHERE source_id = $1 AND id > $2 ORDER BY id LIMIT $3),
        u AS (UPDATE pages p SET folder_rule_ids = gbrain_access_folder_rules(p.source_id, p.slug) FROM w
              WHERE p.id = w.id AND p.folder_rule_ids IS DISTINCT FROM gbrain_access_folder_rules(p.source_id, p.slug) RETURNING p.id)
      SELECT (SELECT max(id) FROM w) AS last, (SELECT count(*) FROM w)::int AS scanned, (SELECT count(*) FROM u)::int AS changed`,
      [sourceId, after, batch]);
    if (!row || row.last === null || row.last === undefined) break;
    after = Number(row.last);
    progress.pages_scanned += Number(row.scanned);
    progress.pages_restamped += Number(row.changed);
    opts.onProgress?.({ ...progress });
  }
  await engine.transaction(async tx => {
    await lockSource(tx, sourceId);
    const changed = await tx.executeRaw<{ id: number }>(
      `UPDATE pages SET folder_rule_ids = gbrain_access_folder_rules(source_id, slug)
        WHERE source_id = $1 AND folder_rule_ids IS DISTINCT FROM gbrain_access_folder_rules(source_id, slug) RETURNING id`, [sourceId]);
    progress.pages_restamped += changed.length;
    await tx.executeRaw(`DELETE FROM access_pending_coverage WHERE source_id = $1 AND reason = 'pending'`, [sourceId]);
    await tx.executeRaw('UPDATE access_policy_revisions SET applied_at = now() WHERE source_id = $1 AND applied_at IS NULL', [sourceId]);
  });
  return progress;
}

export interface ProposeMeta {
  origin: 'cli' | 'git' | 'git-approved' | 'import' | 'revert' | 'migrate';
  proposedBy?: string;
  /** Idempotency key: a retry with the same id returns the recorded revision instead of writing a second one. */
  operationId?: string;
  /** The desired revision the caller previewed; a different one refuses preview_changed. */
  expectDesired?: number;
  /** Persist this store when the source has none (the first rule). */
  store?: AccessStore;
  /** Record the revision as approved whatever it classifies as (a git source's committed access.approved on a rebuild). */
  approved?: boolean;
  onProgress?: (p: RestampProgress) => void;
}

/** Records a desired rulebook and installs its narrowing part (see the module comment). */
export async function proposeRevision(engine: BrainEngine, sourceId: string, desired: readonly FolderRule[], meta: ProposeMeta): Promise<ProposalResult> {
  await readAccessStore(engine, sourceId);
  await ensurePolicyState(engine, sourceId);
  const rules = sortRules(desired);
  const digest = rulebookDigest(rules);
  const actor = meta.proposedBy ?? localActor();
  const step = await engine.transaction(async tx => {
    await lockSource(tx, sourceId);
    if (meta.operationId) {
      const [prior] = await tx.executeRaw<Record<string, unknown>>('SELECT * FROM access_policy_revisions WHERE operation_id = $1', [meta.operationId]);
      if (prior) return { reconciled: toRevision(prior) };
    }
    const latest = await getRevision(tx as BrainEngine, sourceId);
    if (meta.expectDesired !== undefined && (latest?.revision ?? 0) !== meta.expectDesired) {
      throw opError('preview_changed', `Source ${sourceId}'s folder rules changed since the preview (previewed revision ${meta.expectDesired}, now ${latest?.revision ?? 0}); nothing was written.`,
        `Preview again (gbrain access rule list --source ${sourceId}) and rerun with the new --expect value.`);
    }
    const current = await appliedRules(tx, sourceId);
    const cls = meta.approved ? { ...classifyRulebook(current, rules), target: rules, held: [] } : classifyRulebook(current, rules);
    if (meta.store && !(await readAccessStore(tx, sourceId))) await writeAccessStore(tx, sourceId, meta.store);
    if (latest && latest.digest === digest && !meta.approved) {
      const needs = rulebookDigest(cls.target) !== rulebookDigest(current) && await installRulebook(tx, sourceId, cls.target, latest.revision, actor);
      return { unchanged: latest, cls, needs };
    }
    const revision = (latest?.revision ?? 0) + 1;
    const approved = cls.held.length === 0;
    await tx.executeRaw(`INSERT INTO access_policy_revisions (source_id, revision, rules, digest, change_kind, origin, operation_id, proposed_by, approved_by, approved_at)
      VALUES ($1, $2, $3::text::jsonb, $4, $5, $6, $7, $8, $9, CASE WHEN $10::boolean THEN now() END)`,
      [sourceId, revision, JSON.stringify(rules), digest, cls.kind, meta.origin, meta.operationId ?? null, actor,
        approved ? (meta.approved ? actor : 'auto:narrowing') : null, approved]);
    const needs = await installRulebook(tx, sourceId, cls.target, revision, actor);
    if (!needs) await tx.executeRaw('UPDATE access_policy_revisions SET applied_at = now() WHERE source_id = $1 AND applied_at IS NULL', [sourceId]);
    return { revision, cls, needs };
  });
  if ('reconciled' in step && step.reconciled) {
    const rev = step.reconciled;
    const status = await policyStatus(engine, sourceId);
    return { source_id: sourceId, operation_id: rev.operation_id, revision: rev.revision, reconciled: true,
      state: status.pending.length ? 'pending' : status.held.length && status.desired?.revision === rev.revision ? 'recorded' : 'applied',
      change_kind: rev.change_kind, changes: [], held: status.desired?.revision === rev.revision ? status.held : [], pages_restamped: 0 };
  }
  if ('unchanged' in step && step.unchanged) {
    const resume = step.needs || (await coverageRows(engine, sourceId)).some(c => c.reason === 'pending');
    const restamped = resume ? (await restampSource(engine, sourceId, { onProgress: meta.onProgress })).pages_restamped : 0;
    return { source_id: sourceId, operation_id: step.unchanged.operation_id, revision: step.unchanged.revision, state: step.cls.held.length ? 'recorded' : 'unchanged',
      change_kind: 'unchanged', changes: [], held: step.cls.held, pages_restamped: restamped };
  }
  const { revision, cls, needs } = step as { revision: number; cls: Classification; needs: boolean };
  if (needs) await policySeams.afterInstall?.(sourceId);
  const restamp = needs ? await restampSource(engine, sourceId, { onProgress: meta.onProgress }) : { pages_restamped: 0 };
  return { source_id: sourceId, operation_id: meta.operationId ?? null, revision, state: cls.held.length ? 'recorded' : 'applied',
    change_kind: cls.kind, changes: cls.changes, held: cls.held, pages_restamped: restamp.pages_restamped };
}

/** Finishes an interrupted narrowing (pending coverage or stamps that drifted from the applied rulebook). Idempotent. */
export async function resumePolicy(engine: BrainEngine, sourceId: string, onProgress?: (p: RestampProgress) => void): Promise<RestampProgress & { pending_before: string[] }> {
  await readAccessStore(engine, sourceId);
  const pending = (await coverageRows(engine, sourceId)).filter(c => c.reason === 'pending').map(c => c.prefix);
  const [state] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM access_policy_state WHERE source_id = $1', [sourceId]);
  if (!state?.n) return { pages_scanned: 0, pages_restamped: 0, pending_before: [] };
  const progress = await restampSource(engine, sourceId, { onProgress });
  return { ...progress, pending_before: pending };
}

export interface WideningImpact {
  change: RuleChange;
  pages: number;
  sample: string[];
  /** Members who read at least one page after the change that they cannot read now; 'every_source_reader' when unbound callers gain too. */
  gains: string[] | 'every_source_reader';
}

export interface ApplyPreview {
  source_id: string;
  store: AccessStore | null;
  applied_digest: string;
  desired: { revision: number; digest: string; proposed_by: string | null; created_at: string; origin: string } | null;
  proposals: Array<{ revision: number; change_kind: string; proposed_by: string | null; created_at: string }>;
  widening: WideningImpact[];
  plan_hash: string | null;
}

function planHash(sourceId: string, revision: number, desiredDigest: string, appliedDigest: string): string {
  return createHash('sha256').update(JSON.stringify({ sourceId, revision, desiredDigest, appliedDigest })).digest('hex').slice(0, 16);
}

/** What `gbrain access apply` would install: each held widening with the pages and members gaining access, and the plan hash binding it. */
export async function previewApply(engine: BrainEngine, sourceId: string, revision?: number): Promise<ApplyPreview> {
  const store = await readAccessStore(engine, sourceId);
  const current = await appliedRules(engine, sourceId);
  const appliedDigest = rulebookDigest(current);
  const desired = await getRevision(engine, sourceId, revision);
  if (revision !== undefined && !desired) throw opError('not_found', `Source ${sourceId} has no folder-rule revision ${revision}.`, `List revisions with gbrain access rule history --source ${sourceId}.`);
  const proposals = (await listRevisions(engine, sourceId, 200)).filter(r => !r.approved_at).reverse()
    .map(r => ({ revision: r.revision, change_kind: r.change_kind, proposed_by: r.proposed_by, created_at: r.created_at }));
  const base = { source_id: sourceId, store, applied_digest: appliedDigest, proposals };
  if (!desired) return { ...base, desired: null, widening: [], plan_hash: null };
  const cls = classifyRulebook(current, desired.rules);
  const desiredView = { revision: desired.revision, digest: desired.digest, proposed_by: desired.proposed_by, created_at: desired.created_at, origin: desired.origin };
  if (!cls.held.length && rulebookDigest(cls.target) === appliedDigest) return { ...base, desired: desiredView, widening: [], plan_hash: null };
  const members = (await listMembers(engine)).filter(m => m.status === 'enabled');
  const widening: WideningImpact[] = [];
  for (const change of cls.held) {
    const old = current.find(r => r.id === change.rule);
    const prefixes = [...new Set([old?.prefix, change.prefix].filter((p): p is string => !!p))];
    const slugs = (await engine.executeRaw<{ slug: string }>(
      'SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM unnest($2::text[]) AS pfx WHERE starts_with(slug, pfx)) ORDER BY slug',
      [sourceId, prefixes])).map(r => r.slug);
    const gaining = (identity: string[]) => slugs.filter(s => !folderRulesAllow(s, current, identity) && folderRulesAllow(s, desired.rules, identity));
    const unbound = gaining([]);
    const pages = new Set(unbound);
    const gainers: string[] = [];
    for (const m of members) {
      const g = gaining(identityFor(m.id, m.groups));
      if (g.length) gainers.push(m.id);
      for (const s of g) pages.add(s);
    }
    widening.push({ change, pages: pages.size, sample: [...pages].sort().slice(0, 20), gains: unbound.length ? 'every_source_reader' : gainers });
  }
  return { ...base, desired: desiredView, widening, plan_hash: planHash(sourceId, desired.revision, desired.digest, appliedDigest) };
}

/** Installs a previewed revision in full (its widening included) when `expect` still matches its plan hash. */
export async function applyApproved(engine: BrainEngine, sourceId: string, opts: { revision?: number; expect: string; approvedBy?: string; onProgress?: (p: RestampProgress) => void }): Promise<ProposalResult & { plan_hash: string }> {
  await readAccessStore(engine, sourceId);
  await ensurePolicyState(engine, sourceId);
  const actor = opts.approvedBy ?? localActor();
  const installed = await engine.transaction(async tx => {
    await lockSource(tx, sourceId);
    const current = await appliedRules(tx, sourceId);
    const desired = await getRevision(tx as BrainEngine, sourceId, opts.revision);
    const hash = desired ? planHash(sourceId, desired.revision, desired.digest, rulebookDigest(current)) : null;
    if (!desired || hash !== opts.expect) {
      throw opError('preview_changed', `Source ${sourceId}'s folder rules changed since the preview (approved plan ${opts.expect}, current plan ${hash ?? 'none'}); nothing was applied.`,
        `Preview again with gbrain access apply --source ${sourceId}${opts.revision ? ` --revision ${opts.revision}` : ''} and approve the new plan_hash.`);
    }
    const cls = classifyRulebook(current, desired.rules);
    const needs = await installRulebook(tx, sourceId, desired.rules, desired.revision, actor);
    await tx.executeRaw('UPDATE access_policy_revisions SET approved_by = $3, approved_at = now() WHERE source_id = $1 AND revision = $2', [sourceId, desired.revision, actor]);
    if (!needs) await tx.executeRaw('UPDATE access_policy_revisions SET applied_at = now() WHERE source_id = $1 AND applied_at IS NULL AND revision <= $2', [sourceId, desired.revision]);
    return { desired, cls, needs, hash: hash! };
  });
  const restamp = installed.needs ? await restampSource(engine, sourceId, { onProgress: opts.onProgress }) : { pages_restamped: 0 };
  const latest = await getRevision(engine, sourceId);
  let held: RuleChange[] = [];
  if (latest && latest.revision > installed.desired.revision) {
    held = (await proposeRevision(engine, sourceId, latest.rules, { origin: latest.origin as ProposeMeta['origin'], proposedBy: actor, onProgress: opts.onProgress })).held;
  }
  return { source_id: sourceId, operation_id: installed.desired.operation_id, revision: installed.desired.revision, state: held.length ? 'recorded' : 'applied',
    change_kind: installed.cls.kind, changes: installed.cls.changes, held, pages_restamped: restamp.pages_restamped, plan_hash: installed.hash };
}

export interface PolicyStatus {
  source_id: string;
  store: AccessStore | null;
  rules: FolderRule[];
  applied_digest: string;
  desired: RevisionRow | null;
  applied_revision: number | null;
  approved_revision: number | null;
  held: RuleChange[];
  pending: CoverageRow[];
  invalid: CoverageRow[];
  operation?: { operation_id: string; revision: number | null; state: ProposalState | 'not_found' };
}

/** Where a source's folder policy stands: store, applied rules, desired, applied and approved revisions, held and pending work. */
export async function policyStatus(engine: BrainEngine, sourceId: string, operationId?: string): Promise<PolicyStatus> {
  const store = await readAccessStore(engine, sourceId);
  const rules = await appliedRules(engine, sourceId);
  const desired = await getRevision(engine, sourceId);
  const [marks] = await engine.executeRaw<{ applied: number | null; approved: number | null }>(
    'SELECT max(revision) FILTER (WHERE applied_at IS NOT NULL) AS applied, max(revision) FILTER (WHERE approved_at IS NOT NULL) AS approved FROM access_policy_revisions WHERE source_id = $1', [sourceId]);
  const coverage = await coverageRows(engine, sourceId);
  const held = desired ? classifyRulebook(rules, desired.rules).held : [];
  const status: PolicyStatus = {
    source_id: sourceId, store, rules, applied_digest: rulebookDigest(rules), desired,
    applied_revision: marks?.applied === null || marks?.applied === undefined ? null : Number(marks.applied),
    approved_revision: marks?.approved === null || marks?.approved === undefined ? null : Number(marks.approved),
    held, pending: coverage.filter(c => c.reason === 'pending'), invalid: coverage.filter(c => c.reason === 'invalid'),
  };
  if (operationId !== undefined) {
    const [row] = await engine.executeRaw<{ revision: number; applied_at: unknown; approved_at: unknown }>(
      'SELECT revision, applied_at, approved_at FROM access_policy_revisions WHERE source_id = $1 AND operation_id = $2', [sourceId, operationId]);
    status.operation = !row ? { operation_id: operationId, revision: null, state: 'not_found' }
      : { operation_id: operationId, revision: Number(row.revision),
        state: !row.applied_at ? 'pending' : held.length && desired?.revision === Number(row.revision) ? 'recorded' : 'applied' };
  }
  return status;
}

/** A new idempotency key for one rule edit (printed so a lost reply can be reconciled with gbrain access rule status --operation). */
export function newOperationId(): string {
  return `acc_${randomUUID()}`;
}

/** Installs `invalid` coverage for prefixes a policy file that does not validate touches ('' for the whole source), replacing any earlier. */
export async function markPolicyInvalid(engine: BrainEngine, sourceId: string, prefixes: string[] | null, detail: unknown): Promise<void> {
  await ensurePolicyState(engine, sourceId);
  await engine.transaction(async tx => {
    await lockSource(tx, sourceId);
    await tx.executeRaw(`DELETE FROM access_pending_coverage WHERE source_id = $1 AND reason = 'invalid'`, [sourceId]);
    for (const prefix of prefixes ?? ['']) {
      await tx.executeRaw(`INSERT INTO access_pending_coverage (source_id, prefix, reason, detail) VALUES ($1, $2, 'invalid', $3::text::jsonb)`, [sourceId, prefix, JSON.stringify(detail)]);
    }
  });
}

export async function clearPolicyInvalid(engine: Exec, sourceId: string): Promise<void> {
  await engine.executeRaw(`DELETE FROM access_pending_coverage WHERE source_id = $1 AND reason = 'invalid'`, [sourceId]);
}
