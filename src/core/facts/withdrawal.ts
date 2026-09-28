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
    const visible = await tx.executeRaw<{ visibility: 'private' | 'world'; fact: string; fact_hash: string }>(
      `SELECT visibility,fact,gbrain_fact_fingerprint(fact) AS fact_hash FROM facts WHERE id=$1 AND source_id=$2
        AND ($3::boolean=false OR visibility='world')`, [id, sourceId, worldOnly]);
    if (!visible.length) return { withdrawn: false, pages: [] };
    const target = visible[0];
    const existing = await tx.executeRaw(`SELECT 1 FROM fact_withdrawals
      WHERE source_id=$1 AND visibility=$2 AND fact_hash=$3 LIMIT 1`, [sourceId, target.visibility, target.fact_hash]);
    const affected = existing.length ? [] : await discoverWithdrawalTargets(tx, sourceId, [target]).catch(withdrawalDiscoveryFailure);
    await tx.lockPageKeys(affected.map(({ slug }) => ({ sourceId, slug })));
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

async function ambiguousFenceMatchesWithdrawal(engine: BrainEngine, sourceId: string, bodies: readonly string[]): Promise<boolean> {
  const claims = bodies.flatMap(ambiguousFenceClaims);
  if (!claims.length) return false;
  const rows = await engine.executeRaw(`SELECT 1 FROM jsonb_to_recordset($2::text::jsonb) incoming(claim text,visibility text)
    JOIN fact_withdrawals w ON w.source_id=$1 AND w.fact_hash=gbrain_fact_fingerprint(incoming.claim)
      AND (incoming.visibility IS NULL OR w.visibility=incoming.visibility) LIMIT 1`,
  [sourceId, JSON.stringify(claims)]);
  return rows.length > 0;
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
  const blocked = await ambiguousFenceMatchesWithdrawal(engine, sourceId, [body, timeline]);
  if (changed) {
    throw new OperationError('revision_conflict', 'A fact withdrawal changed during import preparation. Retry the import.',
      'Read the current page revision, then submit the updated import with a new request_id.');
  }
  if (blocked) {
    throw new OperationError('invalid_params', 'A malformed fact fence contains a withdrawn claim.',
      'Repair the matching fence row, then retry the import.');
  }
}

/** Explicit remember is not an implicit restore operation. */
export async function isFactWithdrawn(engine: BrainEngine, sourceId: string, visibility: string, claim: string): Promise<boolean> {
  const rows = await engine.executeRaw(`SELECT 1 FROM fact_withdrawals
    WHERE source_id=$1 AND visibility=$2 AND fact_hash=gbrain_fact_fingerprint($3)`, [sourceId,visibility,claim]);
  return rows.length > 0;
}
