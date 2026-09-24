import type { BrainEngine } from '../engine.ts';
import { renderFactsTable, type ParsedFact } from '../facts-fence.ts';
import { escapeFenceCell } from '../fence-shared.ts';
import { OperationError } from '../ops/contract.ts';
import type { PageWithdrawal } from '../page-state/types.ts';
import { hasAmbiguousWithdrawalFence, overlayWithdrawalBody, withdrawnFact, withdrawalFenceBlocks } from './withdrawal-overlay.ts';

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
    const visible = await tx.executeRaw<{ visibility: 'private' | 'world'; fact: string; fact_hash: string }>(
      `SELECT visibility,fact,gbrain_fact_fingerprint(fact) AS fact_hash FROM facts WHERE id=$1 AND source_id=$2
        AND ($3::boolean=false OR visibility='world')`, [id, sourceId, worldOnly]);
    if (!visible.length) return { withdrawn: false, pages: [] };
    const target = visible[0];
    // Provenance may be incomplete on legacy rows, so also inspect pages that
    // actually contain a facts fence. A DB-only subjectless memory has neither
    // provenance nor a matching fence and must not invalidate unrelated pages.
    const candidates = await tx.executeRaw<{ slug: string; compiled_truth: string; timeline: string; fingerprint_body: string; fingerprint_timeline: string; provenance: boolean; chunk_match: boolean; body_match: boolean; timeline_match: boolean }>(
      `WITH target AS (
          SELECT regexp_replace(lower(btrim($3::text)),'[[:space:]]+',' ','g') AS claim,
            regexp_replace(lower(btrim($4::text)),'[[:space:]]+',' ','g') AS escaped_claim
        ), provenance AS (
          SELECT DISTINCT COALESCE(source_markdown_slug,entity_slug) AS slug FROM facts
          WHERE source_id=$1 AND visibility=$2
            AND gbrain_fact_fingerprint(fact)=gbrain_fact_fingerprint($3)
            AND COALESCE(source_markdown_slug,entity_slug) IS NOT NULL
        ), chunk_pages AS MATERIALIZED (
          SELECT DISTINCT c.page_id FROM content_chunks c JOIN pages cp ON cp.id=c.page_id CROSS JOIN target
          WHERE cp.source_id=$1 AND target.claim<>'' AND (
            position(target.claim in regexp_replace(lower(c.chunk_text),'[[:space:]]+',' ','g'))>0 OR
            position(target.escaped_claim in regexp_replace(lower(c.chunk_text),'[[:space:]]+',' ','g'))>0)
        ), searchable AS MATERIALIZED (
          SELECT p.slug,p.compiled_truth,p.timeline,(provenance.slug IS NOT NULL) AS provenance,
            (chunk_pages.page_id IS NOT NULL) AS chunk_match,
            regexp_replace(lower(p.compiled_truth),'[[:space:]]+',' ','g') AS body_text,
            regexp_replace(lower(p.timeline),'[[:space:]]+',' ','g') AS timeline_text
          FROM pages p LEFT JOIN provenance ON provenance.slug=p.slug LEFT JOIN chunk_pages ON chunk_pages.page_id=p.id
            CROSS JOIN target
          WHERE p.source_id=$1 AND (provenance.slug IS NOT NULL OR chunk_pages.page_id IS NOT NULL OR target.claim<>'' AND (
            position('gbrain:facts:begin' in p.compiled_truth)>0 OR position('gbrain:facts:begin' in p.timeline)>0))
        ), candidates AS MATERIALIZED (
          SELECT p.*,
            (position(target.claim in p.body_text)>0 OR position(target.escaped_claim in p.body_text)>0) AS body_match,
            (position(target.claim in p.timeline_text)>0 OR position(target.escaped_claim in p.timeline_text)>0) AS timeline_match
          FROM searchable p CROSS JOIN target
          WHERE p.provenance OR p.chunk_match OR target.claim<>'' AND (
            position(target.claim in p.body_text)>0 OR position(target.escaped_claim in p.body_text)>0 OR
            position(target.claim in p.timeline_text)>0 OR position(target.escaped_claim in p.timeline_text)>0)
        ) SELECT p.slug,p.compiled_truth,p.timeline,p.provenance,p.chunk_match,p.body_match,p.timeline_match,
          (SELECT string_agg(regexp_replace(lower(line),'[[:space:]]+',' ','g'),chr(10) ORDER BY ord)
            FROM unnest(string_to_array(p.compiled_truth,chr(10))) WITH ORDINALITY AS lines(line,ord)) AS fingerprint_body,
          (SELECT string_agg(regexp_replace(lower(line),'[[:space:]]+',' ','g'),chr(10) ORDER BY ord)
            FROM unnest(string_to_array(p.timeline,chr(10))) WITH ORDINALITY AS lines(line,ord)) AS fingerprint_timeline
        FROM candidates p ORDER BY p.slug`, [sourceId, target.visibility, target.fact, escapeFenceCell(target.fact)]);
    const withdrawal: PageWithdrawal = { visibility: target.visibility, fact_hash: target.fact_hash, withdrawn_at: new Date().toISOString() };
    const affected = candidates.filter(page =>
      page.provenance || page.chunk_match ||
      overlayWithdrawalBody(page.compiled_truth, page.fingerprint_body ?? '', [withdrawal]) !== page.compiled_truth ||
      overlayWithdrawalBody(page.timeline, page.fingerprint_timeline ?? '', [withdrawal]) !== page.timeline ||
      page.body_match && hasAmbiguousWithdrawalFence(page.compiled_truth) ||
      page.timeline_match && hasAmbiguousWithdrawalFence(page.timeline),
    ).map(page => page.slug);
    await tx.lockPageKeys(affected.map(slug => ({ sourceId, slug })));
    const rows = await tx.executeRaw<{ visibility: string; fact: string }>(
      `SELECT visibility,fact FROM facts WHERE id=$1 AND source_id=$2
        AND ($3::boolean=false OR visibility='world') FOR UPDATE`, [id, sourceId, worldOnly]);
    if (!rows.length) return { withdrawn: false, pages: [] };
    const row = rows[0];
    const inserted = await tx.executeRaw(`INSERT INTO fact_withdrawals(source_id,visibility,fact_hash)
      VALUES ($1,$2,gbrain_fact_fingerprint($3)) ON CONFLICT DO NOTHING RETURNING fact_hash`, [sourceId,row.visibility,row.fact]);
    await tx.executeRaw(`UPDATE facts SET expired_at=now(),valid_until=LEAST(COALESCE(valid_until,now()),now())
      WHERE source_id=$1 AND visibility=$2 AND gbrain_fact_fingerprint(fact)=gbrain_fact_fingerprint($3)
        AND expired_at IS NULL`, [sourceId,row.visibility,row.fact]);
    if (!inserted.length) return { withdrawn: false, pages: [] };
    // Logical revision and projection invalidation commit with the withdrawal.
    // The revision trigger queues durable rebuild work even for unmanaged calls.
    const pages = affected.length ? await tx.executeRaw<{ id: number; slug: string; knowledge_revision: string }>(
      `UPDATE pages SET knowledge_revision=gen_random_uuid(),text_projection_revision=NULL,embedding_signature=NULL
        WHERE source_id=$1 AND slug=ANY($2::text[]) RETURNING id,slug,knowledge_revision`, [sourceId, affected]) : [];
    if (pages.length) await tx.executeRaw('DELETE FROM content_chunks WHERE page_id=ANY($1::integer[])', [pages.map(page => page.id)]);
    if (opts.requestId && pages.length) {
      await tx.executeRaw(`INSERT INTO persistence_effects(request_id,kind,data,source_id,source_incarnation,worktree_id)
        SELECT $1::uuid,k.kind,jsonb_build_object('source_id',s.id,'source_scan',true),s.id,s.incarnation,b.worktree_id
        FROM sources s LEFT JOIN persistence_source_bindings b ON b.source_id=s.id AND b.source_incarnation=s.incarnation
        CROSS JOIN (VALUES ('withdrawal-mirror'),('git'),('embedding')) AS k(kind)
        WHERE s.id=$2 ON CONFLICT(request_id,kind) DO NOTHING`, [opts.requestId, sourceId]);
    }
    return { withdrawn: true, pages: pages.map(page => ({ sourceId, slug: page.slug, revision: page.knowledge_revision })) };
  });
}

async function withdrawalDates(engine: BrainEngine, sourceId: string, facts: readonly ParsedFact[]): Promise<Map<number,string>> {
  if (!facts.length) return new Map();
  const rows = await engine.executeRaw<{ row_num: number; withdrawn_at: string }>(
    `SELECT incoming.row_num, w.withdrawn_at::text FROM jsonb_to_recordset($2::text::jsonb)
      AS incoming(row_num integer,claim text,visibility text)
      JOIN fact_withdrawals w ON w.source_id=$1 AND w.visibility=incoming.visibility
        AND w.fact_hash=gbrain_fact_fingerprint(incoming.claim)`,
    [sourceId, JSON.stringify(facts.map(f => ({ row_num:f.rowNum, claim:f.claim, visibility:f.visibility })))],
  );
  return new Map(rows.map(r => [r.row_num, new Date(r.withdrawn_at).toISOString().slice(0,10)]));
}

/** Overlay stale source files before hashing/chunking, retaining an explicit retraction. */
export async function preserveWithdrawnFenceRows(engine: BrainEngine, sourceId: string, body: string): Promise<string> {
  if (!body.includes('gbrain:facts:begin')) return body;
  const blocks = withdrawalFenceBlocks(body);
  for (const block of blocks.reverse()) {
    // Preserve malformed-fence diagnostics; never re-render a partial parse.
    if (block.parsed.warnings.length) continue;
    const dates = await withdrawalDates(engine, sourceId, block.parsed.facts);
    if (!dates.size) continue;
    const facts = block.parsed.facts.map(f => {
      const date = dates.get(f.rowNum);
      return date ? withdrawnFact(f, date) : f;
    });
    body = body.slice(0, block.start) + renderFactsTable(facts) + body.slice(block.end);
  }
  return body;
}

/** Refuse provider-free preparation that raced a newly committed withdrawal. */
export async function assertPreparedFactWithdrawals(engine: BrainEngine, sourceId: string, body: string, timeline: string): Promise<void> {
  const changed = await preserveWithdrawnFenceRows(engine, sourceId, body) !== body ||
    await preserveWithdrawnFenceRows(engine, sourceId, timeline) !== timeline;
  const ambiguous = hasAmbiguousWithdrawalFence(body) || hasAmbiguousWithdrawalFence(timeline);
  const blocked = ambiguous && (await engine.executeRaw('SELECT 1 FROM fact_withdrawals WHERE source_id=$1 LIMIT 1', [sourceId])).length > 0;
  if (changed) {
    throw new OperationError('revision_conflict', 'A fact withdrawal changed during import preparation. Retry the import.');
  }
  if (blocked) {
    throw new OperationError('invalid_params', 'A fact fence is malformed while this source has withdrawn facts. Repair the fence before importing.');
  }
}

/** Explicit remember is not an implicit restore operation. */
export async function isFactWithdrawn(engine: BrainEngine, sourceId: string, visibility: string, claim: string): Promise<boolean> {
  const rows = await engine.executeRaw(`SELECT 1 FROM fact_withdrawals
    WHERE source_id=$1 AND visibility=$2 AND fact_hash=gbrain_fact_fingerprint($3)`, [sourceId,visibility,claim]);
  return rows.length > 0;
}
