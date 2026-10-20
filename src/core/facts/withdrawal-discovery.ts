import type { BrainEngine } from '../engine.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { getCode } from '../retry-matcher.ts';
import { parseRowCells, isSeparatorRow, stripStrikethrough } from '../fence-shared.ts';
import { withdrawalFenceBlocks, ambiguousWithdrawalFenceSegments } from './withdrawal-overlay.ts';
import { fenceTooLargeError, readStoredFence } from '../page-body/read-range.ts';
import { FENCE_MAX_BYTES } from '../page-body/limits.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../facts-fence.ts';
import type { BodyRegion } from '../page-body/types.ts';

export const WITHDRAWAL_LIMITS = { targets: 256, targetBytes: 1024 * 1024, scanMs: 10_000, batch: 128, matchRows: 16_384, matchBytes: 8 * 1024 * 1024 } as const;
export interface WithdrawalTarget { slug: string; page_id: number; revision: string }
/** `subject` is the ledger subject ('*' = every entity); `claim` is the fact text when the caller already holds it. */
export interface WithdrawalClaim { visibility: string; fact_hash: string; subject?: string | null; claim?: string | null }
interface KeyedClaim { visibility: string; fact_hash: string; subject: string; norm: string | null }

const RECOVERY = 'See docs/guides/concurrent-writes.md#withdrawal-recovery.';

function refuse(code = 'withdrawal_capacity'): never {
  throw new OperationError(code, 'Withdrawal discovery could not prove a bounded complete target set. This attempt committed no withdrawal or page changes; earlier durable intent remains retained.',
    `Do not retry unchanged or split/delete the source. Keep mutation workers quiesced and inspect the source with the host operator; repair malformed fact fences before retrying. ${RECOVERY}`);
}

async function refuseAffected(engine: BrainEngine, sourceId: string, affected: Set<number>): Promise<never> {
  const sample = await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1 AND id=ANY($2::int[]) ORDER BY slug LIMIT 20',
    [sourceId, [...affected]]);
  throw new OperationError('withdrawal_capacity',
    `This claim is carried by more than ${WITHDRAWAL_LIMITS.targets} pages (${affected.size} matched before discovery stopped), the bound for one atomic withdrawal. Source size is not the limit. Nothing was committed; earlier durable intent remains retained.`,
    `Reduce the pages that carry this claim, then retry: forget the entity-scoped copies of the fact first (each changes only its own entity's pages), or edit the claim out of pages that should not carry it. Matched pages include: ${sample.map(row => row.slug).join(', ')}. ${RECOVERY}`);
}

export function ambiguousFenceClaims(body: string): Array<{ claim: string; visibility: string | null }> {
  const claims: Array<{ claim: string; visibility: string | null }> = [];
  for (const segment of ambiguousWithdrawalFenceSegments(body)) for (const line of segment.split('\n')) {
    const cells = parseRowCells(line);
    if (!cells || isSeparatorRow(cells) || cells[1]?.trim().toLowerCase() === 'claim') continue;
    const { text, struck } = stripStrikethrough((cells[1] ?? '').trim());
    if (!struck && text) claims.push({ claim: text, visibility: ['private', 'world'].includes(cells[4]?.toLowerCase()) ? cells[4].toLowerCase() : null });
  }
  return claims;
}

/**
 * One facts fence a forced cut split is matched whole, in one check bounded by WITHDRAWAL_LIMITS.matchRows/matchBytes:
 * a fence over that bound refuses, naming the fence and how to bring it under the bound.
 */
function splitFenceTooLarge(sourceId: string, slug: string, rows: number, bytes: number): never {
  throw opError('withdrawal_capacity',
    `Page ${slug} (source ${sourceId}) has a facts fence split across stored segments with ${rows} rows (${bytes} bytes to check), over the ${WITHDRAWAL_LIMITS.matchRows}-row / ${WITHDRAWAL_LIMITS.matchBytes / 1024 ** 2} MiB limit withdrawal discovery checks one split fence within. Source size and the withdrawal ledger are not the limit; this fence is. Nothing was committed; earlier durable intent remains retained.`,
    `Split that facts fence into smaller fences of at most ${WITHDRAWAL_LIMITS.matchRows} rows each (close it with ${FACTS_FENCE_END}, open the next with ${FACTS_FENCE_BEGIN} and the header row), write the page again, then retry. ${RECOVERY}`,
    { reason: 'split_fence_rows', why: `Discovery reads a fence a forced segment cut splits whole and checks every row of it at once, up to ${WITHDRAWAL_LIMITS.matchRows} rows.`,
      fix: { ask_user: true, actor: 'user', consent: [], requires_exclusive: false,
        why: 'Only an edit of the page brings the fence under the bound; it changes the page layout, not its facts.',
        user_message: `Page ${slug} has a facts fence of ${rows} rows, more than the ${WITHDRAWAL_LIMITS.matchRows} rows a withdrawal checks in one fence. Split it into fences of at most ${WITHDRAWAL_LIMITS.matchRows} rows each and write the page again? Then retry the withdrawal.`,
        verify: { argv: ['gbrain', 'get', '--source', sourceId, '--', slug], mcp: { tool: 'get_page', arguments: { slug, source_id: sourceId, body: 'none' } } } } });
}

/** A fence's claims as discovery matches them: every row of a clean block, and every ambiguous row. */
function fenceClaims(id: number, slug: string, body: string): Array<{ id: number; slug: string; claim: string; visibility: string | null; ambiguous: boolean }> {
  return [
    ...withdrawalFenceBlocks(body).filter(block => !block.parsed.warnings.length).flatMap(block => block.parsed.facts.map(f => ({ id, slug, claim: f.claim, visibility: f.visibility, ambiguous: false }))),
    ...ambiguousFenceClaims(body).map(f => ({ id, slug, ...f, ambiguous: true })),
  ];
}

/**
 * Wave B (spec 11): every live facts fence of a segmented page that a forced
 * cut split (its slots carry `open_start`), read from its begin marker through
 * its end marker across the cuts (readStoredFence: a cut inside either marker
 * leaves part of it outside every slot) and kept when its lowered text holds
 * every token of a claim keyed to the page. Private rows never reach chunks, so
 * this is the only scan that sees them. A fence above FENCE_MAX_BYTES is
 * refused, never skipped. Keyset by (page, region, fence start); one fence in
 * memory.
 */
async function* splitFactsFences(engine: BrainEngine, sourceId: string, keyed: readonly KeyedClaim[], subjects: string[] | null, deadline: number):
  AsyncIterable<{ id: number; slug: string; fence: string }> {
  for (let after: [number, string, number] = [0, '', -1]; ;) {
    if (performance.now() > deadline) refuse();
    const fences = await engine.executeRaw<{ page_id: number; slug: string; region: string; open_start: string; bytes: string }>(`SELECT m.page_id,p.slug,m.region,
        (s->>'open_start')::bigint::text AS open_start,sum((s->>'end')::bigint-(s->>'start')::bigint)::text AS bytes
      FROM page_body_manifest m JOIN pages p ON p.id=m.page_id CROSS JOIN LATERAL jsonb_array_elements(m.facts_slots) s
      WHERE p.source_id=$1 AND p.body_storage='segmented' AND m.gen_to IS NULL AND m.staging_id IS NULL AND m.facts_slots<>'[]'::jsonb AND s ? 'open_start'
        AND ($2::text[] IS NULL OR p.slug=ANY($2::text[])) AND (m.page_id,m.region,(s->>'open_start')::bigint)>($3::int,$4::text,$5::bigint)
      GROUP BY m.page_id,p.slug,m.region,(s->>'open_start')::bigint ORDER BY m.page_id,m.region,(s->>'open_start')::bigint LIMIT $6`,
    [sourceId, subjects, after[0], after[1], after[2], WITHDRAWAL_LIMITS.batch]);
    for (const f of fences) {
      if (performance.now() > deadline) refuse();
      // Its slots hold part of the fence (a cut inside a marker leaves the marker's bytes outside them), so slots over the
      // bound prove the fence is, before any of it is read.
      if (Number(f.bytes) > FENCE_MAX_BYTES) throw fenceTooLargeError(f.slug, sourceId, Number(f.bytes));
      const fence = await readStoredFence(engine, { id: Number(f.page_id), slug: f.slug, sourceId }, f.region as BodyRegion, Number(f.open_start));
      const lowered = fence.toLowerCase();
      if (keyed.some(k => (k.subject === '*' || k.subject === f.slug) && (k.norm ?? '').split(' ').filter(Boolean).every(token => lowered.includes(token)))) {
        yield { id: Number(f.page_id), slug: f.slug, fence };
      }
    }
    if (fences.length < WITHDRAWAL_LIMITS.batch) return;
    const last = fences[fences.length - 1]!;
    after = [Number(last.page_id), last.region, Number(last.open_start)];
  }
}

/**
 * Claim-keyed discovery. Every fence row, chunk row or whole chunk whose
 * fingerprint equals the claim contains each of the claim's normalized tokens
 * as a substring of its lowercased text (normalization only turns punctuation
 * and whitespace into token boundaries), so pages and chunks are shortlisted
 * in SQL by those tokens, streamed by keyset, then verified exactly. Work and
 * the target bound scale with the claim's affected set, never with source size.
 */
export async function discoverWithdrawalTargets(engine: BrainEngine, sourceId: string, claims: readonly WithdrawalClaim[]): Promise<WithdrawalTarget[]> {
  if (!claims.length) return [];
  if (claims.length > WITHDRAWAL_LIMITS.targets) refuse();
  const deadline = performance.now() + WITHDRAWAL_LIMITS.scanMs;
  const keyed = await engine.executeRaw<KeyedClaim>(`WITH w AS (
      SELECT w.visibility,w.fact_hash,COALESCE(w.subject,'*') AS subject,gbrain_fact_normalize(COALESCE(w.claim,
        (SELECT f.fact FROM facts f WHERE f.source_id=$1 AND f.visibility=w.visibility AND gbrain_fact_fingerprint(f.fact)=w.fact_hash LIMIT 1),
        (SELECT f.fact FROM facts f WHERE f.source_id=$1 AND f.visibility=w.visibility AND gbrain_fact_fingerprint_v1(f.fact)=w.fact_hash LIMIT 1))) AS norm
      FROM jsonb_to_recordset($2::text::jsonb) w(visibility text,fact_hash text,subject text,claim text)
    ) SELECT * FROM w`,
  [sourceId, JSON.stringify(claims.map(c => ({ visibility: c.visibility, fact_hash: c.fact_hash, subject: c.subject ?? '*', claim: c.claim ?? null })))]);
  const keys = JSON.stringify(keyed.map(k => ({ ...k,
    patterns: (k.norm ? k.norm.split(' ').filter(Boolean) : []).map(token => `%${token.replace(/[\\%_]/g, '\\$&')}%`),
  })));
  const subjects = keyed.some(k => k.subject === '*') ? null : [...new Set(keyed.map(k => k.subject))];
  const affected = new Set<number>();
  const provenance = await engine.executeRaw<{ id: number }>(`SELECT DISTINCT p.id
    FROM jsonb_to_recordset($2::text::jsonb) k(visibility text,fact_hash text,subject text,norm text)
    JOIN facts f ON f.source_id=$1 AND f.visibility=k.visibility
      AND gbrain_fact_fingerprint(f.fact)=COALESCE(encode(sha256(convert_to(k.norm,'UTF8')),'hex'),k.fact_hash)
      AND (k.subject='*' OR f.entity_slug=k.subject)
    JOIN pages p ON p.source_id=f.source_id AND p.slug=COALESCE(f.source_markdown_slug,f.entity_slug)`, [sourceId, keys]);
  for (const row of provenance) affected.add(row.id);
  if (affected.size > WITHDRAWAL_LIMITS.targets) await refuseAffected(engine, sourceId, affected);
  const match = async (incoming: Array<{ id: number; slug: string; claim: string; visibility: string | null; ambiguous: boolean }>, splitFence?: string) => {
    if (!incoming.length) return;
    const bytes = Buffer.byteLength(JSON.stringify(incoming));
    if (incoming.length > WITHDRAWAL_LIMITS.matchRows || bytes > WITHDRAWAL_LIMITS.matchBytes) {
      if (splitFence !== undefined) splitFenceTooLarge(sourceId, splitFence, incoming.length, bytes);
      refuse();
    }
    const matches = await engine.executeRaw<{ id: number; ambiguous: boolean }>(`SELECT DISTINCT i.id,i.ambiguous
      FROM jsonb_to_recordset($1::text::jsonb) i(id integer,slug text,claim text,visibility text,ambiguous boolean)
      JOIN jsonb_to_recordset($2::text::jsonb) w(visibility text,fact_hash text,subject text)
        ON (i.visibility IS NULL OR i.visibility=w.visibility) AND (w.subject='*' OR w.subject=i.slug)
          AND w.fact_hash IN (gbrain_fact_fingerprint(i.claim),gbrain_fact_fingerprint_v1(i.claim))`, [JSON.stringify(incoming), keys]);
    if (matches.some(row => row.ambiguous)) refuse('withdrawal_provenance');
    for (const row of matches) affected.add(row.id);
    if (affected.size > WITHDRAWAL_LIMITS.targets) await refuseAffected(engine, sourceId, affected);
  };
  const shortlist = (text: string) => `lower(${text}) LIKE ALL(k.patterns)`;
  for (let after = 0; ;) {
    if (performance.now() > deadline) refuse();
    const pages = await engine.executeRaw<{ id: number; slug: string; compiled_truth: string; timeline: string }>(`SELECT p.id,p.slug,p.compiled_truth,p.timeline FROM pages p
      WHERE p.source_id=$1 AND p.id>$3 AND ($5::text[] IS NULL OR p.slug=ANY($5::text[]))
        AND (strpos(p.compiled_truth,'gbrain:facts:')>0 OR strpos(p.timeline,'gbrain:facts:')>0)
        AND EXISTS (SELECT 1 FROM jsonb_to_recordset($2::text::jsonb) k(subject text,patterns text[])
          WHERE (k.subject='*' OR k.subject=p.slug) AND ((${shortlist('p.compiled_truth')}) OR (${shortlist('p.timeline')})))
      ORDER BY p.id LIMIT $4`, [sourceId, keys, after, WITHDRAWAL_LIMITS.batch, subjects]);
    await match(pages.flatMap(page => [page.compiled_truth, page.timeline].flatMap(body => fenceClaims(page.id, page.slug, body))));
    if (pages.length < WITHDRAWAL_LIMITS.batch) break;
    after = pages[pages.length - 1].id;
  }
  // Wave B (spec 11): a segmented page's fences live in its segments; only live rows flagged with facts slots are
  // read, and only each slot's bytes; a fence split by a forced cut is joined across it (splitFactsFences).
  const slotText = `convert_from(substring(t.body from (s->>'start')::int + 1 for (s->>'end')::int - (s->>'start')::int),'UTF8')`;
  for (let after = [0, 0]; ;) {
    if (performance.now() > deadline) refuse();
    const rows = await engine.executeRaw<{ id: number; occurrence_id: string; slug: string; fences: string[] }>(`SELECT p.id,m.occurrence_id::text AS occurrence_id,p.slug,
        ARRAY(SELECT ${slotText} FROM jsonb_array_elements(m.facts_slots) s WHERE NOT s ? 'open_start') AS fences
      FROM page_body_manifest m JOIN pages p ON p.id=m.page_id JOIN page_segment_texts t ON t.source_id=m.source_id AND t.sha256=m.sha256
      WHERE p.source_id=$1 AND p.body_storage='segmented' AND m.gen_to IS NULL AND m.staging_id IS NULL AND m.facts_slots<>'[]'::jsonb
        AND (m.page_id,m.occurrence_id)>($3::int,$6::bigint) AND ($5::text[] IS NULL OR p.slug=ANY($5::text[]))
        AND EXISTS (SELECT 1 FROM jsonb_to_recordset($2::text::jsonb) k(subject text,patterns text[]), jsonb_array_elements(m.facts_slots) s
          WHERE (k.subject='*' OR k.subject=p.slug) AND NOT s ? 'open_start' AND ${shortlist(slotText)})
      ORDER BY m.page_id,m.occurrence_id LIMIT $4`, [sourceId, keys, after[0], WITHDRAWAL_LIMITS.batch, subjects, after[1]]);
    await match(rows.flatMap(row => row.fences.flatMap(fence => fenceClaims(Number(row.id), row.slug, fence))));
    if (rows.length < WITHDRAWAL_LIMITS.batch) break;
    after = [Number(rows[rows.length - 1].id), Number(rows[rows.length - 1].occurrence_id)];
  }
  for await (const split of splitFactsFences(engine, sourceId, keyed, subjects, deadline)) await match(fenceClaims(split.id, split.slug, split.fence), split.slug);
  for (let after = 0; ;) {
    if (performance.now() > deadline) refuse();
    const chunks = await engine.executeRaw<{ id: number; page_id: number; slug: string; chunk_text: string }>(`SELECT c.id,c.page_id,p.slug,c.chunk_text
      FROM content_chunks c JOIN pages p ON p.id=c.page_id
      WHERE p.source_id=$1 AND c.id>$3 AND ($5::text[] IS NULL OR p.slug=ANY($5::text[]))
        AND EXISTS (SELECT 1 FROM jsonb_to_recordset($2::text::jsonb) k(subject text,patterns text[])
          WHERE (k.subject='*' OR k.subject=p.slug) AND ${shortlist('c.chunk_text')})
      ORDER BY c.id LIMIT $4`, [sourceId, keys, after, WITHDRAWAL_LIMITS.batch, subjects]);
    await match(chunks.flatMap(chunk => {
      const rows = [{ id: chunk.page_id, slug: chunk.slug, claim: chunk.chunk_text, visibility: null as string | null, ambiguous: false }];
      for (const line of chunk.chunk_text.split('\n')) {
        const cells = parseRowCells(line.slice(Math.max(0, line.indexOf('|'))));
        if (!cells || isSeparatorRow(cells) || !cells[1]) continue;
        const { text, struck } = stripStrikethrough(cells[1]);
        if (!struck) rows.push({ id: chunk.page_id, slug: chunk.slug, claim: text, visibility: ['private', 'world'].includes(cells[4]) ? cells[4] : null, ambiguous: false });
      }
      return rows;
    }));
    if (chunks.length < WITHDRAWAL_LIMITS.batch) break;
    after = chunks[chunks.length - 1].id;
  }
  const targets = await engine.executeRaw<WithdrawalTarget>('SELECT slug,id AS page_id,knowledge_revision AS revision FROM pages WHERE source_id=$1 AND id=ANY($2::int[])', [sourceId, [...affected]]);
  if (performance.now() > deadline || Buffer.byteLength(JSON.stringify(targets)) > WITHDRAWAL_LIMITS.targetBytes) refuse();
  return targets.sort((a, b) => a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
}

export function withdrawalDiscoveryFailure(error: unknown): never {
  if (getCode(error) === '57014') refuse();
  throw error;
}
