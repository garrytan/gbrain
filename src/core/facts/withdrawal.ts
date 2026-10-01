import type { BrainEngine } from '../engine.ts';
import { renderFactsTable, type ParsedFact } from '../facts-fence.ts';
import { OperationError } from '../ops/contract.ts';
import { withdrawnFact, withdrawalFenceBlocks } from './withdrawal-overlay.ts';
import { ambiguousFenceClaims, discoverWithdrawalTargets, withdrawalDiscoveryFailure } from './withdrawal-discovery.ts';

export interface WithdrawalCommit {
  withdrawn: boolean;
  pages: Array<{ sourceId: string; slug: string; revision: string }>;
}

/** DB-first: no filesystem ownership, provider work or root lock is required. */
export async function recordFactWithdrawal(
  engine: BrainEngine, id: number, sourceId: string, worldOnly = false,
  opts: { requestId?: string } = {},
): Promise<WithdrawalCommit> {
  return engine.transaction(async tx => {
    // A managed caller takes this EXCLUSIVE source lock before authority,
    // counters and request rows. Repeating an already-held lock is safe.
    await tx.executeRaw('SELECT id FROM sources WHERE id=$1 FOR UPDATE', [sourceId]);
    const visible = await tx.executeRaw<{ visibility: 'private' | 'world'; fact: string; fact_hash: string; subject: string }>(
      `SELECT visibility,fact,gbrain_fact_fingerprint(fact) AS fact_hash,COALESCE(entity_slug,'*') AS subject FROM facts WHERE id=$1 AND source_id=$2
        AND ($3::boolean=false OR visibility='world')`, [id, sourceId, worldOnly]);
    if (!visible.length) return { withdrawn: false, pages: [] };
    const { visibility, fact, fact_hash, subject } = visible[0];
    // Discovery is keyed on the claim and its subject: a subject-scoped
    // withdrawal changes only that entity's pages and its facts' provenance.
    // Only an existing withdrawal covering this subject makes it a no-op.
    const existing = await tx.executeRaw(`SELECT 1 FROM fact_withdrawals
      WHERE source_id=$1 AND visibility=$2 AND fact_hash IN ($3,gbrain_fact_fingerprint_v1($5)) AND (subject='*' OR subject=$4) LIMIT 1`,
    [sourceId, visibility, fact_hash, subject, fact]);
    const affected = existing.length ? [] : await discoverWithdrawalTargets(tx, sourceId, [{ visibility, fact_hash, subject, claim: fact }]).catch(withdrawalDiscoveryFailure);
    await tx.lockPageKeys(affected.map(({ slug }) => ({ sourceId, slug })));
    const rows = await tx.executeRaw<{ visibility: string; fact: string; subject: string }>(
      `SELECT visibility,fact,COALESCE(entity_slug,'*') AS subject FROM facts WHERE id=$1 AND source_id=$2
        AND ($3::boolean=false OR visibility='world') FOR UPDATE`, [id, sourceId, worldOnly]);
    if (!rows.length) return { withdrawn: false, pages: [] };
    const row = rows[0];
    // Scoped to the forgotten row's entity: the same claim about another
    // entity stays active and rememberable. A subjectless fact withdraws
    // source-wide ('*').
    const inserted = await tx.executeRaw(`INSERT INTO fact_withdrawals(source_id,visibility,subject,fact_hash)
      VALUES ($1,$2,$4,gbrain_fact_fingerprint($3)) ON CONFLICT DO NOTHING RETURNING fact_hash`, [sourceId,row.visibility,row.fact,row.subject]);
    await tx.executeRaw(`UPDATE facts SET expired_at=now(),valid_until=LEAST(COALESCE(valid_until,now()),now())
      WHERE source_id=$1 AND visibility=$2 AND gbrain_fact_fingerprint(fact)=gbrain_fact_fingerprint($3)
        AND ($4='*' OR entity_slug=$4) AND expired_at IS NULL`, [sourceId,row.visibility,row.fact,row.subject]);
    if (!inserted.length) return { withdrawn: false, pages: [] };
    // Logical revision and projection invalidation commit with the withdrawal.
    // The revision trigger queues durable rebuild work even for unmanaged calls.
    const pages = affected.length ? await tx.executeRaw<{ id: number; slug: string; knowledge_revision: string }>(
      `UPDATE pages SET knowledge_revision=gen_random_uuid(),text_projection_revision=NULL,embedding_signature=NULL
        WHERE source_id=$1 AND slug=ANY($2::text[]) RETURNING id,slug,knowledge_revision`, [sourceId, affected.map(page => page.slug)]) : [];
    if (pages.length) await tx.executeRaw('DELETE FROM content_chunks WHERE page_id=ANY($1::integer[])', [pages.map(page => page.id)]);
    if (opts.requestId) {
      await tx.executeRaw(`INSERT INTO persistence_effects(request_id,kind,data,source_id,source_incarnation,worktree_id)
        SELECT $1::uuid,k.kind,$3::text::jsonb,s.id,s.incarnation,b.worktree_id
        FROM sources s LEFT JOIN persistence_source_bindings b ON b.source_id=s.id AND b.source_incarnation=s.incarnation
        CROSS JOIN (VALUES ('withdrawal-mirror'),('git'),('embedding')) AS k(kind)
        WHERE s.id=$2 ON CONFLICT(request_id,kind) DO NOTHING`, [opts.requestId, sourceId, JSON.stringify({ version: 2, targets: pages.map(page => ({ slug: page.slug, page_id: page.id, revision: page.knowledge_revision })).sort((a, b) => a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0) })]);
    }
    return { withdrawn: true, pages: pages.map(page => ({ sourceId, slug: page.slug, revision: page.knowledge_revision })) };
  });
}

// Fingerprint each incoming claim once. Inside the join condition the planner
// re-evaluates both fingerprint functions for every (claim, withdrawal) pair,
// so a 28-row fence against 400 withdrawals spent 4 s in this query.
const FINGERPRINTED_CLAIMS = 'SELECT i.visibility, gbrain_fact_fingerprint(i.claim) AS fp, gbrain_fact_fingerprint_v1(i.claim) AS fp_v1';

async function ambiguousFenceMatchesWithdrawal(engine: BrainEngine, sourceId: string, bodies: readonly string[], subject: string | null): Promise<boolean> {
  const claims = bodies.flatMap(ambiguousFenceClaims);
  if (!claims.length) return false;
  const rows = await engine.executeRaw(`WITH incoming AS MATERIALIZED (${FINGERPRINTED_CLAIMS}
      FROM jsonb_to_recordset($2::text::jsonb) i(claim text,visibility text))
    SELECT 1 FROM incoming
    JOIN fact_withdrawals w ON w.source_id=$1 AND w.fact_hash IN (incoming.fp,incoming.fp_v1)
      AND (incoming.visibility IS NULL OR w.visibility=incoming.visibility)
      AND ($3::text IS NULL OR w.subject = '*' OR w.subject = $3::text) LIMIT 1`,
  [sourceId, JSON.stringify(claims), subject]);
  return rows.length > 0;
}

async function withdrawalDates(engine: BrainEngine, sourceId: string, facts: readonly ParsedFact[], subject: string | null): Promise<Map<number,string>> {
  if (!facts.length) return new Map();
  const rows = await engine.executeRaw<{ row_num: number; withdrawn_at: string }>(
    `WITH incoming AS MATERIALIZED (${FINGERPRINTED_CLAIMS}, i.row_num
        FROM jsonb_to_recordset($2::text::jsonb) AS i(row_num integer,claim text,visibility text))
      SELECT incoming.row_num, min(w.withdrawn_at)::text AS withdrawn_at FROM incoming
      JOIN fact_withdrawals w ON w.source_id=$1 AND w.visibility=incoming.visibility
        AND w.fact_hash IN (incoming.fp,incoming.fp_v1)
        AND ($3::text IS NULL OR w.subject = '*' OR w.subject = $3::text)
      GROUP BY incoming.row_num`,
    [sourceId, JSON.stringify(facts.map(f => ({ row_num:f.rowNum, claim:f.claim, visibility:f.visibility }))), subject],
  );
  return new Map(rows.map(r => [r.row_num, new Date(r.withdrawn_at).toISOString().slice(0,10)]));
}

/**
 * Overlay stale source files before hashing/chunking, retaining an explicit
 * retraction. Fence rows belong to the page's entity, so pass the page slug
 * as `subject`; without it every subject's withdrawal applies (conservative).
 */
export async function preserveWithdrawnFenceRows(engine: BrainEngine, sourceId: string, body: string, subject?: string): Promise<string> {
  if (!body.includes('gbrain:facts:begin')) return body;
  const blocks = withdrawalFenceBlocks(body);
  for (const block of blocks.reverse()) {
    // Preserve malformed-fence diagnostics; never re-render a partial parse.
    if (block.parsed.warnings.length) continue;
    const dates = await withdrawalDates(engine, sourceId, block.parsed.facts, subject ?? null);
    if (!dates.size) continue;
    const facts = block.parsed.facts.map(f => {
      const date = dates.get(f.rowNum);
      return date ? withdrawnFact(f, date) : f;
    });
    body = body.slice(0, block.start) + renderFactsTable(facts) + body.slice(block.end);
  }
  return body;
}

/**
 * Refuse provider-free preparation that raced a newly committed withdrawal.
 * `subject` is the page slug the prepared body belongs to (see
 * preserveWithdrawnFenceRows); without it every subject's withdrawal counts.
 */
export async function assertPreparedFactWithdrawals(engine: BrainEngine, sourceId: string, body: string, timeline: string, subject?: string): Promise<void> {
  const changed = await preserveWithdrawnFenceRows(engine, sourceId, body, subject) !== body ||
    await preserveWithdrawnFenceRows(engine, sourceId, timeline, subject) !== timeline;
  const blocked = await ambiguousFenceMatchesWithdrawal(engine, sourceId, [body, timeline], subject ?? null);
  if (changed) {
    throw new OperationError('revision_conflict', 'A fact withdrawal changed during import preparation. Retry the import.',
      'Read the current page revision, then submit the updated import with a new request_id.');
  }
  if (blocked) {
    throw new OperationError('invalid_params', 'A malformed fact fence contains a withdrawn claim.',
      'Repair the matching fence row, then retry the import.');
  }
}

/** Explicit remember is not an implicit restore operation for that entity. */
export async function isFactWithdrawn(
  engine: BrainEngine, sourceId: string, visibility: string, claim: string, entitySlug: string | null,
): Promise<boolean> {
  const rows = await engine.executeRaw(`SELECT 1 FROM fact_withdrawals
    WHERE source_id=$1 AND visibility=$2 AND fact_hash IN (gbrain_fact_fingerprint($3),gbrain_fact_fingerprint_v1($3))
      AND (subject = '*' OR subject = $4::text)`, [sourceId,visibility,claim,entitySlug]);
  return rows.length > 0;
}
