import { createHash } from 'node:crypto';
import { renderFactsTable } from '../facts-fence.ts';
import { withdrawnFact, withdrawalFenceBlocks } from '../facts/withdrawal-overlay.ts';
import { privatePagesFilterFragment } from '../search/private-visibility.ts';
import type { ReadQuery } from '../search/read-enrichment.ts';
import { rowToPage } from '../utils.ts';
import type { PageSnapshot, PageSnapshotOptions, PageWithdrawal } from './types.ts';
import { PageSnapshotAmbiguousError } from './types.ts';

/** The DB normalizes companion lines, preserving its lower()/POSIX-space semantics. */
function overlayWithdrawals(body: string, normalizedBody: string, withdrawals: PageWithdrawal[]): string {
  if (!withdrawals.length || !body.includes('gbrain:facts:begin')) return body;
  const ledger = new Map(withdrawals.map(w => [`${w.visibility}:${w.fact_hash}`, w.withdrawn_at]));
  const blocks = withdrawalFenceBlocks(body), normalized = withdrawalFenceBlocks(normalizedBody);
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i], norm = normalized[i];
    if (!norm || block.parsed.warnings.length || norm.parsed.warnings.length) continue;
    const claims = new Map(norm.parsed.facts.map(f => [f.rowNum, f.claim]));
    let changed = false;
    const facts = block.parsed.facts.map(f => {
      const claim = claims.get(f.rowNum);
      if (claim === undefined) return f;
      const at = ledger.get(`${f.visibility}:${createHash('sha256').update(claim).digest('hex')}`);
      if (!at) return f;
      changed = true;
      return withdrawnFact(f, new Date(at).toISOString().slice(0, 10));
    });
    if (changed) body = body.slice(0, block.start) + renderFactsTable(facts) + body.slice(block.end);
  }
  return body;
}

/** Normalize filesystem bytes with the exact ledger fingerprint rules before comparing them. */
export async function overlayCanonicalBodies(query: ReadQuery, body: string, timeline: string, withdrawals: PageWithdrawal[]): Promise<{ compiled_truth: string; timeline: string }> {
  if (!withdrawals.length) return { compiled_truth: body, timeline };
  const [normalized] = await query<{ body: string; timeline: string }>(`SELECT
    (SELECT string_agg(regexp_replace(lower(line),'[[:space:]]+',' ','g'),chr(10) ORDER BY ord)
      FROM unnest(string_to_array($1::text,chr(10))) WITH ORDINALITY AS lines(line,ord)) AS body,
    (SELECT string_agg(regexp_replace(lower(line),'[[:space:]]+',' ','g'),chr(10) ORDER BY ord)
      FROM unnest(string_to_array($2::text,chr(10))) WITH ORDINALITY AS lines(line,ord)) AS timeline`, [body, timeline]);
  return { compiled_truth: overlayWithdrawals(body, normalized.body ?? '', withdrawals),
    timeline: overlayWithdrawals(timeline, normalized.timeline ?? '', withdrawals) };
}

/** One MVCC statement binds content, tags, identity and withdrawals to one revision. */
export async function readPageSnapshot(query: ReadQuery, slug: string, opts?: PageSnapshotOptions): Promise<PageSnapshot | null> {
  const params: unknown[] = [slug, opts?.resolveAlias === true];
  const where = [`(p.slug=$1 OR ($2::boolean
    ${opts?.preserveExactIdentity ? 'AND NOT EXISTS (SELECT 1 FROM pages exact_page WHERE exact_page.source_id=p.source_id AND exact_page.slug=$1)' : ''}
    AND EXISTS (SELECT 1 FROM slug_aliases a
    WHERE a.alias_slug=$1 AND a.source_id=p.source_id AND a.canonical_slug=p.slug
      AND EXISTS (SELECT 1 FROM sources alias_source WHERE alias_source.id=a.source_id ${opts?.includeDeleted ? '' : 'AND NOT alias_source.archived'}))))`];
  if (opts?.sourceIds?.length) {
    params.push(opts.sourceIds);
    where.push(`p.source_id=ANY($${params.length}::text[])`);
  } else if (opts?.sourceId) {
    params.push(opts.sourceId);
    where.push(`p.source_id=$${params.length}`);
  }
  if (!opts?.includeDeleted) where.push('p.deleted_at IS NULL');
  if (opts?.excludePrivate) where.push(privatePagesFilterFragment('p'));
  if (opts?.requireLiveSource) where.push('EXISTS (SELECT 1 FROM sources s WHERE s.id=p.source_id AND NOT s.archived)');
  params.push(opts?.sourceIds?.[0] ?? 'default');
  const rows = await query<Record<string, unknown>>(`WITH chosen AS (
    SELECT p.*${opts?.requireUnambiguous ? ', count(*) OVER () AS snapshot_matches' : ''} FROM pages p WHERE ${where.join(' AND ')}
    ORDER BY (p.slug=$1) DESC, (p.source_id=$${params.length}) DESC, p.source_id ASC LIMIT 1
  ) SELECT p.*,
    (SELECT s.incarnation FROM sources s WHERE s.id=p.source_id) AS source_incarnation,
    COALESCE((SELECT jsonb_agg(t.tag ORDER BY t.tag) FROM tags t WHERE t.page_id=p.id), '[]'::jsonb) AS snapshot_tags,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('visibility',w.visibility,'fact_hash',w.fact_hash,'withdrawn_at',w.withdrawn_at)
      ORDER BY w.visibility,w.fact_hash) FROM fact_withdrawals w WHERE w.source_id=p.source_id
      ${opts?.excludePrivate ? "AND w.visibility='world'" : ''}), '[]'::jsonb) AS snapshot_withdrawals,
    (SELECT string_agg(regexp_replace(lower(line), '[[:space:]]+', ' ', 'g'), chr(10) ORDER BY ord)
      FROM unnest(string_to_array(p.compiled_truth,chr(10))) WITH ORDINALITY AS lines(line,ord)) AS fingerprint_body,
    (SELECT string_agg(regexp_replace(lower(line), '[[:space:]]+', ' ', 'g'), chr(10) ORDER BY ord)
      FROM unnest(string_to_array(p.timeline,chr(10))) WITH ORDINALITY AS lines(line,ord)) AS fingerprint_timeline
    FROM chosen p`, params);
  if (!rows.length) return null;
  const row = rows[0];
  if (opts?.requireUnambiguous && Number(row.snapshot_matches) > 1) throw new PageSnapshotAmbiguousError();
  const page = rowToPage(row);
  const withdrawals = row.snapshot_withdrawals as PageWithdrawal[];
  page.compiled_truth = overlayWithdrawals(page.compiled_truth, String(row.fingerprint_body ?? ''), withdrawals);
  page.timeline = overlayWithdrawals(page.timeline, String(row.fingerprint_timeline ?? ''), withdrawals);
  return { page, tags: row.snapshot_tags as string[], revision: String(row.knowledge_revision),
    sourceIncarnation: String(row.source_incarnation), withdrawals };
}
