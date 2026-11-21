/**
 * Master's text for the statements N8's callers ran before they moved behind BrainEngine members (the N8 base
 * ff952b0e57, before the move). Each literal below is expanded from the call site by file and line (the line is the
 * one scripts/sql-move-check.mjs reports as the statement's origin, or the master line for a statement the check does
 * not list because its text is a one-line literal); nothing is retyped from the members. The run-time text building
 * each site did around its statement is copied with it.
 *
 * test/n8-sql-move-parity.test.ts runs these against the members the callers now use.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import { codeReadFilter, type CodeReadScope } from '../../src/core/code-intel/read-scope.ts';
import { currentTextProjectionFilter } from '../../src/core/search/safe-chunks.ts';
import { CLIENT_INSPECTION_COLUMNS } from '../../src/core/harness/client-setup.ts';
import { hashToken } from '../../src/core/utils.ts';
import { registerClientNameLockKey } from '../../src/commands/agent-register.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';

type Q = Pick<BrainEngine, 'executeRaw'>;
type Row = Record<string, unknown>;

/** src/commands/access.ts:280. */
export const accessClientRow = async (e: Q, clientId: string) =>
  (await e.executeRaw<Row>('SELECT member_id, may_act_for, reads_unscoped FROM oauth_clients WHERE client_id = $1', [clientId]))[0] ?? null;

/** src/commands/doctor/checks/content-quality.ts:77 (`bytesBlock` as the caller passed it). */
export const oversizedEmbedSkipRow = async (e: Q, bytesBlock: number) => (await e.executeRaw<{ n: number; chunkless: number }>(`SELECT COUNT(*)::int AS n,
         COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM content_chunks cc WHERE cc.page_id = p.id))::int AS chunkless FROM pages p
       WHERE p.deleted_at IS NULL AND p.frontmatter->'embed_skip'->>'reason' = 'oversized'
         AND (octet_length(p.compiled_truth) + octet_length(COALESCE(p.timeline, ''))) <= $1`, [bytesBlock]))[0];

/** src/core/access/requester-scope.ts:209. */
export const credentialScopeRow = async (e: Q, principalId: string) =>
  (await e.executeRaw<{ reads_unscoped: unknown; client_id_issued_at: unknown }>('SELECT reads_unscoped, client_id_issued_at FROM oauth_clients WHERE client_id = $1 AND deleted_at IS NULL', [principalId]))[0];

/** src/core/harness/client-setup.ts:20. */
export const inspectedClientRow = async (e: Q, clientId: string) =>
  (await e.executeRaw(`SELECT ${CLIENT_INSPECTION_COLUMNS} FROM oauth_clients WHERE client_id = $1`, [clientId]))[0] ?? null;

/** src/commands/agent-register.ts:760 (`projection` as the caller built it from the pre-flight column set). */
export const reissueClientRows = (e: Q, clientId: string, projection: string[]) =>
  e.executeRaw<Row>(`SELECT ${projection.join(', ')} FROM oauth_clients WHERE client_id = $1`, [clientId]);

/** src/commands/agent-register.ts:821, with the transaction and the name-scoped advisory lock around it. */
export async function rotateClientSecretMaster(engine: BrainEngine, clientId: string, clientName: string, newSecret: string): Promise<void> {
  await engine.transaction(async (tx) => {
    const txSql = sqlQueryForEngine(tx);
    await tx.executeRaw(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [registerClientNameLockKey(clientName)]);
    const updated = await txSql`
      UPDATE oauth_clients SET client_secret_hash = ${hashToken(newSecret)}
      WHERE client_id = ${clientId}
      RETURNING client_id
    `;
    if (updated.length === 0) throw new Error(`client "${clientId}" vanished mid-rotation.`);
  });
}

/** src/core/code-intel/recursive-walk.ts:91 (the exact-match candidates, LIMIT 25). */
export const exactQualifiedNames = async (e: Q, sourceId: string, bare: string) => (await e.executeRaw<{ symbol_name_qualified: string }>(
      `SELECT DISTINCT symbol_name_qualified
         FROM content_chunks
         JOIN pages p ON p.id = content_chunks.page_id
        WHERE p.source_id = $1 AND ${codeReadFilter([], {})}
          AND symbol_name_qualified IS NOT NULL
          AND (symbol_name = $2 OR symbol_name_qualified = $2)
        LIMIT 25`,
      [sourceId, bare],
    )).map(r => r.symbol_name_qualified);

/** src/core/code-intel/recursive-walk.ts:106 (the did-you-mean candidates, LIMIT 5). */
export const fuzzyQualifiedNames = async (e: Q, sourceId: string, bare: string) => (await e.executeRaw<{ symbol_name_qualified: string }>(
      `SELECT DISTINCT symbol_name_qualified
         FROM content_chunks
         JOIN pages p ON p.id = content_chunks.page_id
        WHERE p.source_id = $1 AND ${codeReadFilter([], {})}
          AND symbol_name_qualified IS NOT NULL
          AND symbol_name_qualified ILIKE $2
        LIMIT 5`,
      [sourceId, `%${bare}%`],
    )).map(r => r.symbol_name_qualified);

/** src/core/ops/usage.ts:55 (the window sums). */
export const usageWindowRows = (e: Q, days: number) => e.executeRaw<Row>(
        `SELECT model,
                phase,
                count(*)::int                                        AS calls,
                sum(input_tokens)::float8                            AS input_tokens,
                sum(output_tokens)::float8                           AS output_tokens,
                sum(cache_read_tokens)::float8                       AS cache_read_tokens,
                sum(cache_write_tokens)::float8                      AS cache_write_tokens,
                sum(cost_usd)::float8                                AS cost_usd,
                count(*) FILTER (WHERE cost_usd IS NULL)::int        AS unpriced_calls
         FROM chat_usage_log
         WHERE created_at >= now() - make_interval(days => $1)
         GROUP BY model, phase
         ORDER BY sum(cost_usd) DESC NULLS LAST`,
        [days],
      );

/** src/core/ops/usage.ts:71 (the first logged time). */
export const usageSinceRows = (e: Q) => e.executeRaw<{ since: string | null }>(
        `SELECT min(created_at)::text AS since FROM chat_usage_log`,
        [],
      );

/** src/core/page-body/segmented-embedding.ts:61 (`ref` as the caller took it). */
export async function segmentedEmbedPageRow(e: Q, ref: { id: number } | { sourceId: string; slug: string }) {
  const [where, params] = 'id' in ref ? ['p.id = $1', [ref.id]] : ['p.source_id = $1 AND p.slug = $2', [ref.sourceId, ref.slug]];
  const [row] = await e.executeRaw<{ id: number; slug: string; source_id: string; title: string; contextual_retrieval_mode: string | null; body_bytes: number | string }>(
    `SELECT p.id, p.slug, p.source_id, p.title, p.contextual_retrieval_mode, p.body_bytes
       FROM pages p JOIN sources s ON s.id = p.source_id
      WHERE ${where} AND p.body_storage = 'segmented' AND p.deleted_at IS NULL AND NOT s.archived AND ${currentTextProjectionFilter('p')}`, params);
  return row ? { ...row, id: Number(row.id), body_storage: 'segmented', body_bytes: Number(row.body_bytes) } : null;
}

/** src/core/persistence/filesystem-guard.ts:18. */
export const persistenceBrainPresent = async (e: Q) =>
  (await e.executeRaw<{ present: boolean }>("SELECT to_regclass('persistence_brain') IS NOT NULL AS present"))[0];

/** src/core/persistence/filesystem-guard.ts:30 (`host` as hostIdFor returned it). */
export const managedRootRows = (e: Q, host: string) => e.executeRaw<Row>(`SELECT h.local_path,s.source_id,s.source_incarnation,s.worktree_id,s.topology_generation
      FROM persistence_host_bindings h JOIN persistence_source_bindings s ON s.worktree_id=h.worktree_id WHERE h.host_id=$1::uuid
      UNION SELECT local_path,id,incarnation,NULL,NULL FROM sources WHERE local_path IS NOT NULL`, [host]);

/** src/core/persistence/page-append.ts:437. */
export const pageBodySizeRow = async (tx: Q, pageId: number) => (await tx.executeRaw<{ bytes: string | null; truth: string | null }>(`SELECT COALESCE(body_bytes, octet_length(COALESCE(compiled_truth,'')) + octet_length(COALESCE(timeline,'')))::text AS bytes,
      (CASE WHEN body_storage='segmented' THEN truth_bytes ELSE octet_length(COALESCE(compiled_truth,'')) END)::text AS truth FROM pages WHERE id=$1`, [pageId]))[0];

/** src/core/persistence/worktree-refresh.ts:1226 (`host` and `budgetMs` as the caller computed them). */
export const resumableRefreshRows = (e: Q, host: string, budgetMs: number) => e.executeRaw<Row>(`SELECT f.*,f.updated_at<now()-($2::double precision*interval '1 millisecond') AS stale FROM persistence_worktree_refreshes f
    JOIN persistence_worktrees w ON w.id=f.worktree_id WHERE w.owner_host_id=$1::uuid AND f.state IN ('draining','fenced','merged','syncing') AND (f.state<>'syncing'
      OR f.updated_at<now()-($2::double precision*interval '1 millisecond') OR NOT EXISTS (SELECT 1 FROM sources s WHERE s.id=ANY(f.source_ids) AND (s.last_commit IS NULL OR s.last_commit=f.old_head)))
    ORDER BY f.state='syncing', f.created_at LIMIT 16`, [host, budgetMs]);

/** src/core/persistence/worktree-refresh.ts:1237 (`sourceIds` is the refresh row's list). */
export const sourceLastCommitRows = (e: Q, sourceIds: string[]) => e.executeRaw<{ last_commit: string | null }>(
      'SELECT last_commit FROM sources WHERE id=ANY($1::text[]) ORDER BY id', [sourceIds]);

export type { CodeReadScope };
