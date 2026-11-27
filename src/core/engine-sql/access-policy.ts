/**
 * Folder-rule policy writes and the reads beside them (access/policy.ts): one SQL implementation for both engines.
 * Each statement is the text policy.ts ran through `executeRaw` at 6e123afe98, byte for byte
 * (test/engine-sql-caller-raw-sql-pins.test.ts). The lock, the rule changes, the restamp's final pass and the
 * revision writes run inside the caller's transaction; every member runs on the executor it is given, so a member of a
 * transaction-bound engine runs on that transaction.
 */

/** The engine's own executeRaw (a transaction-bound engine inside a transaction). */
export interface AccessPolicyExec {
  executeRaw<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
}

/** One applied folder rule of a source, as `access_rules` stores it. */
export interface AccessRuleRow { rule_id: string; prefix: string; readable_by: string[]; covers_derived: boolean }

/** A rule to insert: its id, prefix, readers and whether it covers what is derived from its pages. */
export type AccessRuleInsert = AccessRuleRow;

/**
 * One change to a source's applied rulebook: drop the rules `remove` names, insert `insert` (stamped with `revision`
 * and `actor`), then mark each `pending` prefix pending at `revision` (an existing pending row takes the new revision).
 */
export interface AccessRuleChanges { remove: string[]; insert: AccessRuleInsert[]; pending: string[]; revision: number; actor: string }

/** Which revisions to read: the newest, one by number, the newest `limit`, or the one an operation id recorded (any source). */
export type AccessRevisionQuery =
  | { by: 'latest'; sourceId: string }
  | { by: 'revision'; sourceId: string; revision: number }
  | { by: 'recent'; sourceId: string; limit: number }
  | { by: 'operation'; operationId: string };

/** A revision row as stored (`SELECT *`); timestamps are a Date or text, `rules` JSON or its text. */
export type AccessRevisionRow = Record<string, unknown>;

/** A pending or invalid prefix row of one source (`detail` JSON or its text). */
export interface AccessCoverageRow { prefix: string; reason: string; revision: number | string | null; detail: unknown }

/** One window of the batched restamp: the last page id it read (null when none), pages read and pages restamped. */
export interface AccessRestampWindow { last: number | null; scanned: number; changed: number }

/** A revision to record. `approved` stamps approved_at with the transaction's time. */
export interface AccessRevisionInsert {
  source_id: string;
  revision: number;
  rules: unknown;
  digest: string;
  change_kind: string;
  origin: string;
  operation_id: string | null;
  proposed_by: string | null;
  approved_by: string | null;
  approved: boolean;
}

/** The newest applied and approved revision of a source, and (when asked) the revision one operation id recorded there. */
export interface AccessPolicyMarks {
  applied: number | null;
  approved: number | null;
  operation?: { revision: number; applied_at: unknown; approved_at: unknown } | null;
}

/** The BrainEngine members that serve access/policy.ts (declared on BrainEngine in engine.ts). */
export const ACCESS_STORE_SQL = `SELECT config->>'access_store' AS store FROM sources WHERE id = $1`;
export const WRITE_ACCESS_STORE_SQL = `UPDATE sources SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{access_store}', to_jsonb($2::text)) WHERE id = $1`;
export const ENSURE_POLICY_STATE_SQL = 'INSERT INTO access_policy_state (source_id) VALUES ($1) ON CONFLICT (source_id) DO NOTHING';
export const LOCK_SOURCE_SQL = 'SELECT 1 FROM sources WHERE id = $1 FOR NO KEY UPDATE';
export const LOCK_POLICY_STATE_SQL = 'SELECT 1 FROM access_policy_state WHERE source_id = $1 FOR UPDATE';
export const APPLIED_RULES_SQL = 'SELECT rule_id, prefix, readable_by, covers_derived FROM access_rules WHERE source_id = $1 ORDER BY rule_id COLLATE "C"';
export const RECENT_REVISIONS_SQL = 'SELECT * FROM access_policy_revisions WHERE source_id = $1 ORDER BY revision DESC LIMIT $2';
export const LATEST_REVISION_SQL = 'SELECT * FROM access_policy_revisions WHERE source_id = $1 ORDER BY revision DESC LIMIT 1';
export const REVISION_SQL = 'SELECT * FROM access_policy_revisions WHERE source_id = $1 AND revision = $2';
export const OPERATION_REVISION_SQL = 'SELECT * FROM access_policy_revisions WHERE operation_id = $1';
export const COVERAGE_ROWS_SQL = 'SELECT prefix, reason, revision, detail FROM access_pending_coverage WHERE source_id = $1 ORDER BY reason COLLATE "C", prefix COLLATE "C"';
export const STATE_UNREADABLE_SQL = 'SELECT gbrain_access_state_unreadable() AS unreadable';
export const DELETE_RULE_SQL = 'DELETE FROM access_rules WHERE source_id = $1 AND rule_id = $2';
export const INSERT_RULE_SQL = 'INSERT INTO access_rules (source_id, rule_id, prefix, readable_by, revision, created_by, covers_derived) VALUES ($1, $2, $3, $4::text[], $5, $6, $7)';
export const UPSERT_PENDING_SQL = `INSERT INTO access_pending_coverage (source_id, prefix, reason, revision) VALUES ($1, $2, 'pending', $3)
      ON CONFLICT (source_id, prefix, reason) DO UPDATE SET revision = EXCLUDED.revision`;
export const RESTAMP_WINDOW_SQL = `WITH w AS (SELECT id FROM pages WHERE source_id = $1 AND id > $2 ORDER BY id LIMIT $3),
        u AS (UPDATE pages p SET folder_rule_ids = gbrain_access_folder_rules(p.source_id, p.slug) FROM w
              WHERE p.id = w.id AND p.folder_rule_ids IS DISTINCT FROM gbrain_access_folder_rules(p.source_id, p.slug) RETURNING p.id)
      SELECT (SELECT max(id) FROM w) AS last, (SELECT count(*) FROM w)::int AS scanned, (SELECT count(*) FROM u)::int AS changed`;
export const RESTAMP_ALL_SQL = `UPDATE pages SET folder_rule_ids = gbrain_access_folder_rules(source_id, slug)
        WHERE source_id = $1 AND folder_rule_ids IS DISTINCT FROM gbrain_access_folder_rules(source_id, slug) RETURNING id`;
export const DELETE_PENDING_SQL = `DELETE FROM access_pending_coverage WHERE source_id = $1 AND reason = 'pending'`;
export const MARK_APPLIED_SQL = 'UPDATE access_policy_revisions SET applied_at = now() WHERE source_id = $1 AND applied_at IS NULL';
export const MARK_APPLIED_UP_TO_SQL = 'UPDATE access_policy_revisions SET applied_at = now() WHERE source_id = $1 AND applied_at IS NULL AND revision <= $2';
export const INSERT_REVISION_SQL = `INSERT INTO access_policy_revisions (source_id, revision, rules, digest, change_kind, origin, operation_id, proposed_by, approved_by, approved_at)
      VALUES ($1, $2, $3::text::jsonb, $4, $5, $6, $7, $8, $9, CASE WHEN $10::boolean THEN now() END)`;
export const APPROVE_REVISION_SQL = 'UPDATE access_policy_revisions SET approved_by = $3, approved_at = now() WHERE source_id = $1 AND revision = $2';
export const POLICY_STATE_COUNT_SQL = 'SELECT count(*)::int AS n FROM access_policy_state WHERE source_id = $1';
export const PREFIX_SLUGS_SQL = 'SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND starts_with(slug, $2) ORDER BY slug COLLATE "C"';
export const PREFIXES_SLUGS_SQL = 'SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM unnest($2::text[]) AS pfx WHERE starts_with(slug, pfx)) ORDER BY slug COLLATE "C"';
export const POLICY_MARKS_SQL = 'SELECT max(revision) FILTER (WHERE applied_at IS NOT NULL) AS applied, max(revision) FILTER (WHERE approved_at IS NOT NULL) AS approved FROM access_policy_revisions WHERE source_id = $1';
export const OPERATION_MARKS_SQL = 'SELECT revision, applied_at, approved_at FROM access_policy_revisions WHERE source_id = $1 AND operation_id = $2';
export const DELETE_INVALID_SQL = `DELETE FROM access_pending_coverage WHERE source_id = $1 AND reason = 'invalid'`;
export const INSERT_INVALID_SQL = `INSERT INTO access_pending_coverage (source_id, prefix, reason, detail) VALUES ($1, $2, 'invalid', $3::text::jsonb)`;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** The source's `config.access_store` text (null when unset), or null when the source does not exist. */
export async function readAccessStoreConfig(exec: AccessPolicyExec, sourceId: string): Promise<{ store: string | null } | null> {
  const [row] = await exec.executeRaw<{ store: string | null }>(ACCESS_STORE_SQL, [sourceId]);
  return row ? { store: row.store ?? null } : null;
}

/** Sets the source's `config.access_store`; a missing source changes nothing. */
export async function writeAccessStoreConfig(exec: AccessPolicyExec, sourceId: string, store: string): Promise<void> {
  await exec.executeRaw(WRITE_ACCESS_STORE_SQL, [sourceId, store]);
}

/** Creates the source's access_policy_state row (its policy lock) unless it exists. */
export async function ensureAccessPolicyState(exec: AccessPolicyExec, sourceId: string): Promise<void> {
  await exec.executeRaw(ENSURE_POLICY_STATE_SQL, [sourceId]);
}

/** Locks the source row, then its policy row, until the caller's transaction ends (the order page writers take them in). */
export async function lockAccessPolicy(exec: AccessPolicyExec, sourceId: string): Promise<void> {
  await exec.executeRaw(LOCK_SOURCE_SQL, [sourceId]);
  await exec.executeRaw(LOCK_POLICY_STATE_SQL, [sourceId]);
}

/** The applied rules of a source, by rule id. */
export async function listAccessRules(exec: AccessPolicyExec, sourceId: string): Promise<AccessRuleRow[]> {
  const rows = await exec.executeRaw<{ rule_id: string; prefix: string; readable_by: string[] | null; covers_derived: boolean }>(APPLIED_RULES_SQL, [sourceId]);
  return rows.map(r => ({ rule_id: r.rule_id, prefix: r.prefix, readable_by: [...(r.readable_by ?? [])], covers_derived: r.covers_derived !== false }));
}

/** Revision rows as `query` selects them, newest first. */
export async function readAccessPolicyRevisions(exec: AccessPolicyExec, query: AccessRevisionQuery): Promise<AccessRevisionRow[]> {
  switch (query.by) {
    case 'latest': return exec.executeRaw(LATEST_REVISION_SQL, [query.sourceId]);
    case 'revision': return exec.executeRaw(REVISION_SQL, [query.sourceId, query.revision]);
    case 'recent': return exec.executeRaw(RECENT_REVISIONS_SQL, [query.sourceId, query.limit]);
    case 'operation': return exec.executeRaw(OPERATION_REVISION_SQL, [query.operationId]);
  }
}

/** The pending and invalid prefixes of a source, by reason and prefix. */
export async function listAccessCoverage(exec: AccessPolicyExec, sourceId: string): Promise<AccessCoverageRow[]> {
  return exec.executeRaw<AccessCoverageRow>(COVERAGE_ROWS_SQL, [sourceId]);
}

/** The pages of a source whose kept folder rule ids differ from the rules that cover them now. */
export async function countAccessFolderDrift(exec: AccessPolicyExec, sourceId: string): Promise<number> {
  const [row] = await exec.executeRaw<{ n: number }>(
    'SELECT count(*)::int AS n FROM pages WHERE source_id = $1 AND folder_rule_ids IS DISTINCT FROM gbrain_access_folder_rules(source_id, slug)', [sourceId]);
  return Number(row?.n ?? 0);
}

/** Whether row-level security keeps this database role from reading the folder access tables. */
export async function readAccessStateUnreadable(exec: AccessPolicyExec): Promise<boolean> {
  const [row] = await exec.executeRaw<{ unreadable: boolean }>(STATE_UNREADABLE_SQL);
  return row?.unreadable === true;
}

/** Applies one rulebook change in the caller's transaction: deletes, then inserts, then pending prefixes. */
export async function applyAccessRuleChanges(exec: AccessPolicyExec, sourceId: string, changes: AccessRuleChanges): Promise<void> {
  for (const id of changes.remove) await exec.executeRaw(DELETE_RULE_SQL, [sourceId, id]);
  for (const r of changes.insert) {
    await exec.executeRaw(INSERT_RULE_SQL, [sourceId, r.rule_id, r.prefix, r.readable_by, changes.revision, changes.actor, r.covers_derived]);
  }
  for (const prefix of changes.pending) await exec.executeRaw(UPSERT_PENDING_SQL, [sourceId, prefix, changes.revision]);
}

/** Restamps the pages of a source with id above `after`, `batch` at most, in id order. */
export async function restampAccessWindow(exec: AccessPolicyExec, sourceId: string, after: number, batch: number): Promise<AccessRestampWindow> {
  const [row] = await exec.executeRaw<{ last: number | string | null; scanned: number; changed: number }>(RESTAMP_WINDOW_SQL, [sourceId, after, batch]);
  return { last: num(row?.last), scanned: Number(row?.scanned ?? 0), changed: Number(row?.changed ?? 0) };
}

/**
 * The restamp's final pass, in the caller's locked transaction: restamps every page of the source that drifted, drops
 * its pending prefixes and marks its unapplied revisions applied. Returns the pages restamped.
 */
export async function finishAccessRestamp(exec: AccessPolicyExec, sourceId: string): Promise<number> {
  const changed = await exec.executeRaw<{ id: number }>(RESTAMP_ALL_SQL, [sourceId]);
  await exec.executeRaw(DELETE_PENDING_SQL, [sourceId]);
  await exec.executeRaw(MARK_APPLIED_SQL, [sourceId]);
  return changed.length;
}

/** Records a revision. A revision number or operation id the source already has refuses (the primary key, the unique index). */
export async function insertAccessPolicyRevision(exec: AccessPolicyExec, row: AccessRevisionInsert): Promise<void> {
  await exec.executeRaw(INSERT_REVISION_SQL, [row.source_id, row.revision, JSON.stringify(row.rules), row.digest, row.change_kind, row.origin,
    row.operation_id, row.proposed_by, row.approved_by, row.approved]);
}

/** Marks the unapplied revisions of a source applied, those up to `upTo` only when given. */
export async function markAccessRevisionsApplied(exec: AccessPolicyExec, sourceId: string, upTo?: number): Promise<void> {
  if (upTo === undefined) await exec.executeRaw(MARK_APPLIED_SQL, [sourceId]);
  else await exec.executeRaw(MARK_APPLIED_UP_TO_SQL, [sourceId, upTo]);
}

/** Records who approved one revision, now. */
export async function approveAccessPolicyRevision(exec: AccessPolicyExec, sourceId: string, revision: number, actor: string): Promise<void> {
  await exec.executeRaw(APPROVE_REVISION_SQL, [sourceId, revision, actor]);
}

/** Whether the source has an access_policy_state row. */
export async function hasAccessPolicyState(exec: AccessPolicyExec, sourceId: string): Promise<boolean> {
  const [row] = await exec.executeRaw<{ n: number }>(POLICY_STATE_COUNT_SQL, [sourceId]);
  return Number(row?.n ?? 0) > 0;
}

/** The slugs of the live pages of a source that start with `prefixes` (one prefix, or any of several), by slug. */
export async function listAccessPrefixSlugs(exec: AccessPolicyExec, sourceId: string, prefixes: string | readonly string[]): Promise<string[]> {
  const rows = typeof prefixes === 'string'
    ? await exec.executeRaw<{ slug: string }>(PREFIX_SLUGS_SQL, [sourceId, prefixes])
    : await exec.executeRaw<{ slug: string }>(PREFIXES_SLUGS_SQL, [sourceId, [...prefixes]]);
  return rows.map(r => r.slug);
}

/** The newest applied and approved revision of a source, and the revision `operationId` recorded there when given. */
export async function readAccessPolicyMarks(exec: AccessPolicyExec, sourceId: string, operationId?: string): Promise<AccessPolicyMarks> {
  const [marks] = await exec.executeRaw<{ applied: number | string | null; approved: number | string | null }>(POLICY_MARKS_SQL, [sourceId]);
  const out: AccessPolicyMarks = { applied: num(marks?.applied), approved: num(marks?.approved) };
  if (operationId !== undefined) {
    const [row] = await exec.executeRaw<{ revision: number | string; applied_at: unknown; approved_at: unknown }>(OPERATION_MARKS_SQL, [sourceId, operationId]);
    out.operation = row ? { revision: Number(row.revision), applied_at: row.applied_at ?? null, approved_at: row.approved_at ?? null } : null;
  }
  return out;
}

/** Replaces the source's invalid prefixes with `prefixes` (each with `detail`); an empty list only clears them. */
export async function replaceAccessInvalidCoverage(exec: AccessPolicyExec, sourceId: string, prefixes: readonly string[], detail: unknown): Promise<void> {
  await exec.executeRaw(DELETE_INVALID_SQL, [sourceId]);
  for (const prefix of prefixes) await exec.executeRaw(INSERT_INVALID_SQL, [sourceId, prefix, JSON.stringify(detail)]);
}
