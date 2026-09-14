/**
 * Single-record provenance re-coordinate operator (v0.50 — bp-u49.4.4.7).
 *
 * Moves ONE existing live *orphan* fact (`row_num IS NULL` and
 * `source_markdown_slug IS NULL`) onto ONE freshly appended fence row on its
 * canonical page, preserving the original fact id and creating ZERO new fact
 * rows, behind a DURABLE, PHASE-AWARE crash boundary.
 *
 * Why a phase machine, not just locks: every coordinate-producing insert funnels
 * through `engine.insertFacts`, whose fence↔DB reconcile matches DB rows to
 * fence rows by (claim, source) over facts ALREADY coordinated to the page — so
 * an uncoordinated orphan is not matched and a concurrent sync duplicates it in
 * the publish→coordinate window. Locks close that window only while the operator
 * process is alive; a crash across the Git↔PostgreSQL boundary drops the locks.
 * The durable `fact_recoordinations` marker records the exact boundary reached
 * (`phase`), the pre/post fence-file hashes, and the durable commit id, so
 * recovery — under the SAME source+page locks and in-lock revalidation — knows
 * precisely what happened and NEVER coordinates the DB to evidence that is not
 * durably published.
 *
 * The central adoption seam in `engine.insertFacts` honours an active marker
 * ONLY at phase `published_verified` (round-4 #1) — entered only after BOTH the
 * local file and the CURRENT remote branch tip are proven to carry the exact
 * postimage — and only after re-checking the live target's exact identity and
 * values. Every marker phase/status/ref transition is a compare-and-set on
 * `status='pending'` (round-4 #4): a lost race reloads and honours the already
 * terminal outcome, never overwrites it. This operator never claims Git+DB
 * atomicity — only durable fail-forward recovery, and it reports rollback
 * truthfully.
 *
 * NEVER calls `writeFactsToFence` (that inserts a new fact). Uses the native
 * mode-preserving atomic writer, refreshes `compiled_truth` (fail-closed, with
 * the canonical `content_hash` shape native import uses, verified byte-for-byte
 * incl. timeline + hash), and coordinates LAST.
 */

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { parseFactsFence, upsertFactRow, type FactKind, type FactVisibility, type FactNotability } from '../facts-fence.ts';
import { parseMarkdown } from '../markdown.ts';
import { sanitizeText } from '../batch-rows.ts';
import { contentHash } from '../utils.ts';
import { resolvePageWriteTarget } from '../write-through.ts';
import { withPageLock } from '../page-lock.ts';
import { withSourceFilesystemLock } from '../minions/source-filesystem.ts';
import { atomicWriteFileSync } from '../atomic-write.ts';
import { normalizeClaim, normalizeSource } from './recoordinate-normalize.ts';

export { normalizeClaim, normalizeSource };

function sha256hex(x: string): string { return createHash('sha256').update(x).digest('hex'); }

export type RecoordStatus = 'pending' | 'applied' | 'rolled_back' | 'failed';
export type RecoordPhase = 'marker_created' | 'written' | 'committed' | 'published_verified' | 'rolling_back' | 'applied' | 'rolled_back' | 'failed';

export interface PendingMarker {
  id: string;
  fact_id: string;
  source_id: string;
  slug: string;
  row_num: number;
  claim_norm: string;
  source_norm: string;
  status: RecoordStatus;
  phase: RecoordPhase;
  preimage_hash: string | null;
  postimage_hash: string | null;
  commit_id: string | null;
  remote_ref: string | null;
  note: string | null;
}

/**
 * Durability injection (corrections 6/7 + msg-285 issues 3/4 + round 3/4). The
 * real CLI passes the hardened brain-repo git helpers; hermetic tests pass a
 * local git repo with a bare remote.
 *
 * `commitAndPush` is resumable (commits the target's working-tree change if any
 * — PATH-SCOPED, never blocked by unrelated staged files — then pushes
 * synchronously to the tracked branch) and returns the durable commit id plus
 * the branch ref pushed to; it throws if the push cannot be confirmed, or if
 * HEAD is detached / the ref is invalid (fail-closed, never pushes a branch
 * literally named `HEAD`).
 *
 * `currentRemoteFileHash` returns the sha256 of the target file's bytes at the
 * CURRENT tip of `ref` on the remote (after a bounded fetch), or null if absent.
 * Durability is bound to the CURRENT remote branch state — NOT ancestry of an
 * old commit — so a later restoring commit that removes the fence row is
 * reflected (305#1/#2). There is deliberately no historical-commit reader.
 */
export interface Durability {
  isHardened(writeRoot: string): boolean;
  commitAndPush(filePath: string, writeRoot: string, slug: string): Promise<{ commitId: string; ref: string }>;
  currentRemoteFileHash(writeRoot: string, ref: string, filePath: string): Promise<string | null>;
}

/**
 * The live-identity guarded coordinate UPDATE (correction 8 + issue 6). Params:
 * [row_num, slug, fact_id, claim_norm, source_norm, source_id]. Coordinates ONLY
 * if the orphan is still uncoordinated AND its live exact identity/values still
 * match: same source, same entity page, same normalized claim/source, still
 * live. Used by the operator, recovery, and (inlined) the engine adoption seam.
 */
export const GUARDED_COORDINATE_UPDATE = `
  UPDATE facts
     SET row_num = $1, source_markdown_slug = $2
   WHERE id = $3
     AND source_id = $6
     AND row_num IS NULL AND source_markdown_slug IS NULL
     AND entity_slug = $2
     AND btrim(fact) = $4
     AND btrim(COALESCE(source, '')) = $5
     AND expired_at IS NULL AND (valid_until IS NULL OR valid_until > now())
  RETURNING id`;

// ── Marker CRUD ──────────────────────────────────────────────────────────────

export async function insertPendingMarker(engine: BrainEngine, m: {
  fact_id: string; source_id: string; slug: string; row_num: number;
  claim: string; source: string | null; preimage_hash?: string; postimage_hash?: string; note?: string;
}): Promise<string> {
  const rows = await engine.executeRaw<{ id: string | number }>(
    `INSERT INTO fact_recoordinations
       (fact_id, source_id, slug, row_num, claim_norm, source_norm, phase, preimage_hash, postimage_hash, note)
     VALUES ($1,$2,$3,$4,$5,$6,'marker_created',$7,$8,$9) RETURNING id`,
    [m.fact_id, m.source_id, m.slug, m.row_num, normalizeClaim(m.claim), normalizeSource(m.source),
     m.preimage_hash ?? null, m.postimage_hash ?? null, m.note ?? null],
  );
  return String(rows[0].id);
}

function mapMarker(r: Record<string, unknown>): PendingMarker {
  return {
    id: String(r.id), fact_id: String(r.fact_id), source_id: String(r.source_id), slug: String(r.slug),
    row_num: Number(r.row_num), claim_norm: String(r.claim_norm), source_norm: String(r.source_norm),
    status: String(r.status) as RecoordStatus, phase: String(r.phase) as RecoordPhase,
    preimage_hash: r.preimage_hash == null ? null : String(r.preimage_hash),
    postimage_hash: r.postimage_hash == null ? null : String(r.postimage_hash),
    commit_id: r.commit_id == null ? null : String(r.commit_id),
    remote_ref: r.remote_ref == null ? null : String(r.remote_ref),
    note: r.note == null ? null : String(r.note),
  };
}

const MARKER_COLS = `id, fact_id, source_id, slug, row_num, claim_norm, source_norm, status, phase, preimage_hash, postimage_hash, commit_id, remote_ref, note`;

export async function listPendingMarkers(engine: BrainEngine, factId?: string): Promise<PendingMarker[]> {
  const where = factId ? `WHERE status = 'pending' AND fact_id = $1` : `WHERE status = 'pending'`;
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT ${MARKER_COLS} FROM fact_recoordinations ${where} ORDER BY created_at ASC`, factId ? [factId] : []);
  return rows.map(mapMarker);
}

async function getMarker(engine: BrainEngine, markerId: string): Promise<PendingMarker | null> {
  const rows = await engine.executeRaw<Record<string, unknown>>(`SELECT ${MARKER_COLS} FROM fact_recoordinations WHERE id = $1`, [markerId]);
  return rows[0] ? mapMarker(rows[0]) : null;
}

const ALL_PHASES: readonly RecoordPhase[] = ['marker_created', 'written', 'committed', 'published_verified', 'rolling_back', 'applied', 'rolled_back', 'failed'];

/**
 * Compare-and-set a phase transition (round-4 #4). Applies ONLY while the marker
 * is still `status='pending'` and — when `expect` is given — its phase is one of
 * `expect`. Returns the number of rows changed: 0 means a concurrent actor
 * already advanced/terminalized the marker (a LOST RACE), and the caller must
 * reload and honour the terminal outcome — never overwrite it. `expect` values
 * are compile-time enum constants (validated against ALL_PHASES), never user
 * input, so they are inlined safely.
 */
async function casPhase(engine: BrainEngine, markerId: string, expect: RecoordPhase[] | null, phase: RecoordPhase, extra?: { commit_id?: string; remote_ref?: string; note?: string }): Promise<number> {
  let guard = '';
  if (expect && expect.length) {
    for (const p of expect) if (!ALL_PHASES.includes(p)) throw new Error(`casPhase: unknown expected phase ${p}`);
    guard = `AND phase IN (${expect.map(p => `'${p}'`).join(', ')})`;
  }
  const rows = await engine.executeRaw<{ id: string | number }>(
    `UPDATE fact_recoordinations
        SET phase = $2,
            commit_id = COALESCE($3, commit_id),
            remote_ref = COALESCE($5, remote_ref),
            note = COALESCE($4, note),
            status = CASE WHEN $2 = 'applied' THEN 'applied'
                          WHEN $2 = 'rolled_back' THEN 'rolled_back'
                          WHEN $2 = 'failed' THEN 'failed'
                          ELSE status END,
            applied_at = CASE WHEN $2 = 'applied' THEN now() ELSE applied_at END
      WHERE id = $1 AND status = 'pending' ${guard}
      RETURNING id`,
    [markerId, phase, extra?.commit_id ?? null, extra?.note ?? null, extra?.remote_ref ?? null]);
  return rows.length;
}

/** Record the durable commit id + remote ref on the marker (no phase change).
 *  CAS on `status='pending'` so a terminalized marker is never mutated. */
async function setCommitRef(engine: BrainEngine, markerId: string, commitId: string, ref: string): Promise<void> {
  await engine.executeRaw(`UPDATE fact_recoordinations SET commit_id = $2, remote_ref = $3 WHERE id = $1 AND status = 'pending'`, [markerId, commitId, ref]);
}

/** Update only the note; NEVER changes status/phase (keeps the active guard).
 *  CAS on `status='pending'` so a terminalized marker is never mutated. */
async function keepPendingNote(engine: BrainEngine, markerId: string, note: string): Promise<void> {
  await engine.executeRaw(`UPDATE fact_recoordinations SET note = $2 WHERE id = $1 AND status = 'pending'`, [markerId, note]);
}

export type ApplyOutcome = 'coordinated' | 'already_coordinated' | 'conflict' | 'not_eligible';

/** Internal sentinel: a terminal `applied` CAS affected zero rows, so the whole
 *  transaction (including the fact coordinate) must roll back (round-5 #1). */
class RecoordCasLost extends Error { constructor() { super('recoord: applied CAS lost — rolling back coordinate'); } }

/**
 * Atomically coordinate the orphan from a durable marker (round-5 #1). ONE DB
 * transaction: lock the marker `FOR UPDATE`, require EXACTLY
 * `status='pending' AND phase='published_verified'`, run the live-identity
 * guarded coordinate, then the applied transition — which MUST affect exactly
 * the locked row or the whole transaction rolls back (zero fact mutation). So
 * the marker is NEVER coordinated from `committed`/`rolling_back`, and a lost
 * applied CAS can never leave a coordinated fact behind a non-applied marker.
 *
 *  - `coordinated`         — this call moved the orphan onto its row.
 *  - `already_coordinated` — the exact target was already coordinated (a
 *                            concurrent seam won the race); marker is applied.
 *  - `not_eligible`        — the marker is not (pending, published_verified):
 *                            terminalized or not yet durable. No mutation.
 *  - `conflict`            — the live orphan drifted (identity/values). No mutation.
 */
export async function applyPendingMarker(engine: BrainEngine, m: PendingMarker): Promise<ApplyOutcome> {
  try {
    return await engine.transaction(async (tx) => {
      const lock = await tx.executeRaw<{ status: string; phase: string }>(
        `SELECT status, phase FROM fact_recoordinations WHERE id = $1 FOR UPDATE`, [m.id]);
      const cur = lock[0];
      const coordinatedToTarget = async (): Promise<boolean> => {
        const f = (await tx.executeRaw<{ row_num: number | null; slug: string | null }>(
          `SELECT row_num, source_markdown_slug AS slug FROM facts WHERE id = $1 AND source_id = $2`, [m.fact_id, m.source_id]))[0];
        return !!f && Number(f.row_num) === m.row_num && String(f.slug) === m.slug;
      };
      if (!cur || String(cur.status) !== 'pending' || String(cur.phase) !== 'published_verified') {
        // Not eligible. If a concurrent seam already coordinated our EXACT
        // target, report that truthfully; otherwise the marker moved on without
        // our coordinate landing → not eligible. Neither path mutates a fact.
        return (await coordinatedToTarget()) ? 'already_coordinated' : 'not_eligible';
      }
      const updated = await tx.executeRaw<{ id: string | number }>(
        GUARDED_COORDINATE_UPDATE, [m.row_num, m.slug, m.fact_id, m.claim_norm, m.source_norm, m.source_id]);
      const already = updated.length === 0 && (await coordinatedToTarget());
      if (updated.length === 0 && !already) return 'conflict'; // live orphan drifted — no mutation
      const applied = await tx.executeRaw<{ id: string | number }>(
        `UPDATE fact_recoordinations SET status='applied', phase='applied', applied_at=now()
          WHERE id = $1 AND status='pending' AND phase='published_verified' RETURNING id`, [m.id]);
      if (applied.length !== 1) throw new RecoordCasLost(); // roll the whole tx back — undo the coordinate
      return updated.length > 0 ? 'coordinated' : 'already_coordinated';
    });
  } catch (e) {
    if (e instanceof RecoordCasLost) return 'conflict'; // coordinate rolled back — zero mutation
    throw e;
  }
}

// ── Revalidation (fail-closed) ───────────────────────────────────────────────

export interface RevalContext {
  fact_id: string; source_id: string; slug: string; claim: string; source: string;
  kind: FactKind; visibility: FactVisibility; notability: FactNotability; confidence: number;
  valid_from: string | null; valid_until: string | null; context: string | null;
  claim_metric: string | null; claim_value: number | null; claim_unit: string | null; claim_period: string | null;
  filePath: string; writeRoot: string; body: string; preimage_fence_sha256: string;
}
export interface RevalResult { ok: boolean; reason: string | null; ctx: RevalContext | null; }

function backingPathIsSafe(filePath: string, writeRoot: string): boolean {
  const root = resolve(writeRoot); const target = resolve(filePath);
  if (target === root) return false;
  const rootSep = root.endsWith(sep) ? root : root + sep;
  return target.startsWith(rootSep);
}

export async function revalidate(engine: BrainEngine, factId: string): Promise<RevalResult> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT id, source_id, entity_slug, source_markdown_slug, row_num,
            (expired_at IS NULL AND (valid_until IS NULL OR valid_until > now())) AS is_live,
            fact, kind, visibility, notability, confidence,
            to_char(valid_from, 'YYYY-MM-DD') AS valid_from, to_char(valid_until, 'YYYY-MM-DD') AS valid_until,
            context, source, claim_metric, claim_value, claim_unit, claim_period
       FROM facts WHERE id = $1`, [factId]);
  if (rows.length === 0) return { ok: false, reason: 'fact_not_found', ctx: null };
  const f = rows[0];
  if (f.is_live !== true && f.is_live !== 't' && f.is_live !== 1) return { ok: false, reason: 'fact_not_live', ctx: null };
  if (f.row_num != null || f.source_markdown_slug != null) return { ok: false, reason: 'already_coordinated', ctx: null };
  const entitySlug = f.entity_slug == null ? null : String(f.entity_slug);
  if (!entitySlug) return { ok: false, reason: 'no_entity_slug', ctx: null };
  const sourceId = String(f.source_id);

  const liveCount = await engine.executeRaw<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL`, [sourceId, entitySlug]);
  if ((liveCount[0]?.n ?? 0) !== 1) return { ok: false, reason: 'entity_page_absent_or_ambiguous', ctx: null };

  let target: { filePath: string; writeRoot: string };
  try {
    const t = await resolvePageWriteTarget(engine, entitySlug, sourceId);
    if (!t.ok) return { ok: false, reason: 'source_tree_absent', ctx: null };
    target = { filePath: t.filePath, writeRoot: t.writeRoot };
  } catch { return { ok: false, reason: 'source_tree_absent', ctx: null }; }
  if (!backingPathIsSafe(target.filePath, target.writeRoot)) return { ok: false, reason: 'unsafe_backing_path', ctx: null };
  if (!existsSync(target.filePath)) return { ok: false, reason: 'backing_file_missing', ctx: null };

  const body = readFileSync(target.filePath, 'utf8');
  if (!body.includes('gbrain:facts:begin')) return { ok: false, reason: 'fence_missing', ctx: null };
  const parsed = parseFactsFence(body);
  if (parsed.warnings.length > 0) return { ok: false, reason: 'fence_unparseable', ctx: null };
  const claim = String(f.fact); const source = String(f.source ?? '');
  if (parsed.facts.some(pf => pf.claim === claim.trim() && (pf.source ?? '') === source.trim())) return { ok: false, reason: 'exact_fence_match_exists', ctx: null };

  return { ok: true, reason: null, ctx: {
    fact_id: String(f.id), source_id: sourceId, slug: entitySlug, claim, source,
    kind: String(f.kind) as FactKind, visibility: String(f.visibility) as FactVisibility, notability: String(f.notability) as FactNotability,
    confidence: f.confidence == null ? 1.0 : Number(f.confidence),
    valid_from: f.valid_from == null ? null : String(f.valid_from), valid_until: f.valid_until == null ? null : String(f.valid_until),
    context: f.context == null ? null : String(f.context),
    claim_metric: f.claim_metric == null ? null : String(f.claim_metric), claim_value: f.claim_value == null ? null : Number(f.claim_value),
    claim_unit: f.claim_unit == null ? null : String(f.claim_unit), claim_period: f.claim_period == null ? null : String(f.claim_period),
    filePath: target.filePath, writeRoot: target.writeRoot, body, preimage_fence_sha256: sha256hex(body),
  } };
}

/**
 * Load the active schema pack exactly as native import's caller does (thin
 * `{ page_types }` shape), so `parseMarkdown` here infers the SAME `type` and
 * the recomputed `content_hash` matches what the next `gbrain sync` computes —
 * making that next import a genuine no-op (round-4 #3). Falls back to `undefined`
 * (legacy typing) on any failure, mirroring the importer's own fallback, so
 * both diverge or agree together. Lazy import keeps `config`/schema-pack deps
 * off this module's top level; this module is never on the engine-live path.
 */
async function loadActivePackSafe(sourceId: string): Promise<{ page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string>; aliases?: ReadonlyArray<string> }> } | undefined> {
  try {
    const { loadActivePack } = await import('../schema-pack/load-active.ts');
    const { loadConfig } = await import('../config.ts');
    const resolved = await loadActivePack({ cfg: loadConfig(), remote: false, sourceId });
    return { page_types: resolved.manifest.page_types };
  } catch { return undefined; }
}

/**
 * Refresh `compiled_truth` from `body` — FAIL CLOSED and verified BYTE-FOR-BYTE
 * (issue 8 + round-4 #3). Reparses the ACTUAL body (with the active schema pack,
 * for type parity), computes the CANONICAL `content_hash` — the exact
 * `contentHash({ title, type, compiled_truth, timeline, frontmatter, tags })`
 * shape native import writes, over the sanitized fields with sorted tags — then
 * stamps it via the narrow `refreshPageBody` UPDATE and verifies the stored
 * `compiled_truth`, `timeline` AND `content_hash` all match exactly. Storing the
 * stale existing hash (the previous bug) would let the next sync treat changed
 * content as unchanged — the precise failure `refreshPageBody` exists to prevent.
 */
async function refreshAndVerifyPageBody(engine: BrainEngine, slug: string, sourceId: string, body: string): Promise<void> {
  const activePack = await loadActivePackSafe(sourceId);
  const parsed = parseMarkdown(body, `${slug}.md`, { validate: true, ...(activePack ? { activePack } : {}) });
  const existing = await engine.getPage(slug, { sourceId });
  if (!existing) throw new Error('refresh_page_body: page row absent');
  // Round-5 #4: mirror native import (#1035) — absence of an EXPLICIT frontmatter
  // `type:` on an EXISTING page means "preserve the stored type", not "re-infer
  // from the path". Using the path-inferred type here would stamp a hash the
  // next native import (which preserves existing.type) can't reproduce, so its
  // no-op short-circuit would miss and it would needlessly re-chunk/re-embed.
  const effType = parsed.typeExplicit === true ? parsed.type : String((existing as unknown as { type?: string }).type ?? parsed.type);
  const wantCompiled = sanitizeText(parsed.compiled_truth);
  const wantTimeline = sanitizeText(parsed.timeline) || '';
  const wantTitle = sanitizeText(parsed.title);
  const wantTags = [...parsed.tags].map(t => String(t)).sort();
  const wantHash = contentHash({
    title: wantTitle,
    type: effType,
    compiled_truth: wantCompiled,
    timeline: wantTimeline,
    frontmatter: parsed.frontmatter,
    tags: wantTags,
  });
  await engine.refreshPageBody(slug, sourceId, wantCompiled, wantTimeline, wantHash);
  const after = await engine.getPage(slug, { sourceId });
  const a = after as unknown as { compiled_truth?: string; timeline?: string; content_hash?: string } | null;
  if (String(a?.compiled_truth ?? '') !== wantCompiled) throw new Error('refresh_page_body: compiled_truth exact verification failed');
  if (String(a?.timeline ?? '') !== wantTimeline) throw new Error('refresh_page_body: timeline exact verification failed');
  if (String(a?.content_hash ?? '') !== wantHash) throw new Error('refresh_page_body: content_hash exact verification failed');
}

export interface RecoordResult {
  ok: boolean; reason: string | null; fact_id: string; marker_id: string | null;
  proposed_row_num: number | null; preimage_fence_sha256: string | null; postimage_fence_sha256: string | null;
  phase: RecoordPhase | null; coordinate_outcome: 'coordinated' | 'already_coordinated' | 'conflict' | 'rolled_back' | 'rollback_failed' | null;
}

async function resolveWriteRoot(engine: BrainEngine, slug: string, sourceId: string): Promise<string | null> {
  try { const t = await resolvePageWriteTarget(engine, slug, sourceId); return t.ok ? t.writeRoot : null; } catch { return null; }
}

/**
 * The operator. Refuses to apply unless durability is hardened. Acquires
 * source+page locks, revalidates INSIDE them, verifies the in-lock resolved
 * identity matches the pre-read lock keys (issue 5), then advances through the
 * durable phases:
 *   marker_created → written → committed → published_verified → applied
 * `published_verified` (round-4 #1) is entered ONLY after the CURRENT local AND
 * CURRENT remote both carry the exact postimage; the engine adoption seam and
 * the final guarded coordinate act only from that phase. Any post-marker failure
 * runs an explicit, TRUTHFUL rollback. Every transition is a CAS: a lost race
 * reloads and returns the terminal outcome.
 */
export async function recoordinateFact(
  engine: BrainEngine, factId: string, opts: { durability: Durability },
): Promise<RecoordResult> {
  const base: RecoordResult = { ok: false, reason: null, fact_id: factId, marker_id: null, proposed_row_num: null,
    preimage_fence_sha256: null, postimage_fence_sha256: null, phase: null, coordinate_outcome: null };

  const pre = await engine.executeRaw<{ source_id: string; entity_slug: string | null }>(
    `SELECT source_id, entity_slug FROM facts WHERE id = $1`, [factId]);
  if (pre.length === 0) return { ...base, reason: 'fact_not_found' };
  const preSourceId = String(pre[0].source_id);
  const preSlug = pre[0].entity_slug == null ? null : String(pre[0].entity_slug);
  if (!preSlug) return { ...base, reason: 'no_entity_slug' };
  const preWriteRoot = await resolveWriteRoot(engine, preSlug, preSourceId);
  if (!preWriteRoot) return { ...base, reason: 'source_tree_absent' };
  if (!opts.durability.isHardened(preWriteRoot)) return { ...base, reason: 'durability_not_hardened' };

  return withSourceFilesystemLock(engine, preWriteRoot, () => withPageLock(preSlug, async () => {
    const reval = await revalidate(engine, factId);
    if (!reval.ok || !reval.ctx) return { ...base, reason: reval.reason };
    const c = reval.ctx;
    // Issue 5: the in-lock resolved identity MUST match the pre-read lock keys.
    if (c.source_id !== preSourceId || c.slug !== preSlug || c.writeRoot !== preWriteRoot) {
      return { ...base, reason: 'lock_key_drift' };
    }

    const { body: newBody, rowNum } = upsertFactRow(c.body, {
      claim: c.claim, kind: c.kind, confidence: c.confidence, visibility: c.visibility, notability: c.notability,
      validFrom: c.valid_from ?? undefined, validUntil: c.valid_until ?? undefined, source: c.source, context: c.context ?? undefined,
      claimMetric: c.claim_metric ?? undefined, claimValue: c.claim_value ?? undefined, claimUnit: c.claim_unit ?? undefined, claimPeriod: c.claim_period ?? undefined,
    });
    const postimage = sha256hex(newBody);

    // Durable marker FIRST (phase=marker_created), fail-closed on active ownership.
    let markerId: string;
    try {
      markerId = await insertPendingMarker(engine, { fact_id: c.fact_id, source_id: c.source_id, slug: c.slug, row_num: rowNum,
        claim: c.claim, source: c.source, preimage_hash: c.preimage_fence_sha256, postimage_hash: postimage });
    } catch { return { ...base, reason: 'active_marker_conflict', proposed_row_num: rowNum }; }
    const r = { ...base, marker_id: markerId, proposed_row_num: rowNum, preimage_fence_sha256: c.preimage_fence_sha256, postimage_fence_sha256: postimage };
    // Reload the marker and honour a terminal outcome instead of a stale write
    // (round-5 #2: every CAS result is checked before the next side effect).
    const bailTerminal = async (): Promise<RecoordResult> => {
      const cur = await getMarker(engine, markerId);
      if (cur?.status === 'applied') return { ...r, ok: true, phase: 'applied', coordinate_outcome: 'already_coordinated' };
      return { ...r, reason: `lost_race_${cur?.status ?? 'gone'}`, phase: cur?.phase ?? null, coordinate_outcome: cur?.status === 'rolled_back' ? 'rolled_back' : 'conflict' };
    };

    // Atomic write (mode-preserving, verified) → phase=written.
    try {
      atomicWriteFileSync(c.filePath, newBody, { verify: (onDisk) => { if (parseFactsFence(onDisk).warnings.length > 0) throw new Error('tmp_unparseable'); } });
    } catch { await casPhase(engine, markerId, ['marker_created'], 'failed', { note: 'atomic_write_failed' }); return { ...r, reason: 'atomic_write_failed', phase: 'failed' }; }
    if ((await casPhase(engine, markerId, ['marker_created'], 'written')) === 0) return bailTerminal(); // round-5 #2

    // Refresh compiled_truth (fail-closed + exact). Nothing durable yet. Only
    // release the guard (rolled_back) if we can PROVE the append is gone (file
    // restored EXACTLY to preimage AND the DB body restored + verified);
    // otherwise keep the marker pending so a later reconcile cannot insert a
    // fresh fact against a lingering append (298#4).
    try { await refreshAndVerifyPageBody(engine, c.slug, c.source_id, newBody); }
    catch {
      if (await tryRestorePreimage(engine, c)) {
        if ((await casPhase(engine, markerId, ['written'], 'rolled_back', { note: 'refresh_failed_pre_commit_restored' })) === 0) return bailTerminal();
        return { ...r, reason: 'refresh_page_body_failed', phase: 'rolled_back', coordinate_outcome: 'rolled_back' };
      }
      await keepPendingNote(engine, markerId, 'refresh_failed_restore_unproven'); // phase stays 'written', guard held
      return { ...r, reason: 'refresh_page_body_failed_guard_held', phase: 'written', coordinate_outcome: null };
    }

    // Durable commit + SYNCHRONOUS push → phase=committed, record commit id + ref.
    let ref: string;
    try { const res = await opts.durability.commitAndPush(c.filePath, c.writeRoot, c.slug); ref = res.ref; await setCommitRef(engine, markerId, res.commitId, res.ref); }
    catch { const oc = await rollbackPublished(engine, opts.durability, c, markerId, 'commit_failed'); return { ...r, reason: 'commit_failed', phase: oc === 'rolled_back' ? 'rolled_back' : null, coordinate_outcome: oc }; }
    if ((await casPhase(engine, markerId, ['written'], 'committed')) === 0) return bailTerminal(); // round-5 #2

    // Bind durability to the CURRENT remote branch tip (305#1): the coordinate
    // is authorized ONLY if the CURRENT local AND CURRENT remote both carry the
    // exact postimage. Prove it, THEN enter published_verified (round-4 #1) — the
    // one phase from which the engine adoption seam and the final guarded
    // coordinate may act. Adoption cannot fire on a not-yet-durable append.
    const localHash = existsSync(c.filePath) ? sha256hex(readFileSync(c.filePath, 'utf8')) : null;
    const remoteHash = await opts.durability.currentRemoteFileHash(c.writeRoot, ref, c.filePath);
    if (localHash !== postimage || remoteHash !== postimage) {
      const oc = await rollbackPublished(engine, opts.durability, c, markerId, 'not_durably_published');
      return { ...r, reason: 'not_durably_published', phase: oc === 'rolled_back' ? 'rolled_back' : null, coordinate_outcome: oc };
    }
    if ((await casPhase(engine, markerId, ['committed'], 'published_verified', { note: 'durable_publication_proven' })) === 0) return bailTerminal(); // round-5 #2

    // Coordinate LAST, atomically (round-5 #1). applyPendingMarker locks + requires
    // (pending, published_verified) in one tx, so a concurrent adoption seam that
    // won the applied-between-proof race is reported as already_coordinated, a
    // terminalization is not_eligible, and a drifted orphan is a conflict — none
    // overwrite a terminal marker or coordinate from a non-published phase.
    const marker = await getMarker(engine, markerId);
    if (!marker) return bailTerminal();
    const outcome = await applyPendingMarker(engine, marker);
    if (outcome === 'coordinated' || outcome === 'already_coordinated') return { ...r, ok: true, phase: 'applied', coordinate_outcome: outcome };
    if (outcome === 'not_eligible') return bailTerminal();
    const oc = await rollbackPublished(engine, opts.durability, c, markerId, 'coordinate_conflict'); // 'conflict' — orphan drifted
    return { ...r, reason: 'coordinate_conflict', phase: oc === 'rolled_back' ? 'rolled_back' : null, coordinate_outcome: oc };
  }));
}

/** Restore the backing file to preimage + refresh compiled_truth back, and PROVE
 *  the local file is exactly the preimage AND the DB body is restored+verified.
 *  Returns true only on proven restore (round-4 #2 — never releases a guard on
 *  an unproven DB body). */
async function tryRestorePreimage(engine: BrainEngine, c: RevalContext): Promise<boolean> {
  try {
    atomicWriteFileSync(c.filePath, c.body);
    if (sha256hex(readFileSync(c.filePath, 'utf8')) !== c.preimage_fence_sha256) return false;
    await refreshAndVerifyPageBody(engine, c.slug, c.source_id, c.body);
    return true;
  } catch { return false; }
}

/**
 * Explicit, TRUTHFUL rollback of a PUBLISHED (or maybe-published) fence append
 * (298#1). Journals the intent (`rolling_back`), restores the file to preimage
 * (proven), refreshes compiled_truth back (fail-closed + verified), lands a NEW
 * scoped restoring commit, and PROVES the CURRENT remote tip carries exactly the
 * preimage. Returns 'rolled_back' ONLY then; otherwise the append may still be
 * published, so the marker is KEPT PENDING (guard held, fail-forward) and
 * 'rollback_failed' is returned — never a false 'rolled_back'.
 */
export async function rollbackPublished(engine: BrainEngine, durability: Durability, c: RevalContext, markerId: string, note: string): Promise<'rolled_back' | 'rollback_failed'> {
  // JOURNAL the rollback intent as a CAS (305#2). Round-5 #2: if this loses to a
  // concurrent adoption (the marker was terminalized to `applied`), we must NOT
  // restore or push the preimage — that would delete evidence backing a fact
  // that is now coordinated. Stop before any side effect and honour the terminal.
  if ((await casPhase(engine, markerId, ['written', 'committed', 'published_verified'], 'rolling_back', { note })) === 0) {
    const cur = await getMarker(engine, markerId);
    return cur?.status === 'rolled_back' ? 'rolled_back' : 'rollback_failed';
  }
  try {
    if (!(await tryRestorePreimage(engine, c))) throw new Error('preimage restore unproven');
    const { commitId, ref } = await durability.commitAndPush(c.filePath, c.writeRoot, c.slug);
    // Prove the CURRENT remote tip carries the preimage (not mere ancestry) — 305#1/#2.
    if ((await durability.currentRemoteFileHash(c.writeRoot, ref, c.filePath)) !== c.preimage_fence_sha256) throw new Error('current remote not preimage');
    const done = await casPhase(engine, markerId, ['rolling_back'], 'rolled_back', { commit_id: commitId, remote_ref: ref, note });
    if (done === 0) { const cur = await getMarker(engine, markerId); return cur?.status === 'rolled_back' ? 'rolled_back' : 'rollback_failed'; }
    return 'rolled_back';
  } catch {
    await keepPendingNote(engine, markerId, `${note}:rollback_unproven`); // phase stays 'rolling_back', guard HELD
    return 'rollback_failed';
  }
}

// ── Recovery (fail-forward, phase-aware, locked, CAS) ─────────────────────────

export interface RecoverOutcome { marker_id: string; fact_id: string; phase: RecoordPhase; outcome: string; }

/**
 * Recover a single marker; MUST be called inside the source+page locks with a
 * marker RELOADED under those locks and still `status='pending'` (round-4 #4 —
 * the caller reloads and short-circuits terminal markers).
 *
 * INVARIANT (298#2/#4/#5 + round-4 #2): the active-marker guard is released
 * (status set to a terminal value) ONLY when the durable state is unambiguous —
 * either the coordinate is fully APPLIED, or the append is PROVEN gone (on-disk
 * bytes == exact preimage AND the DB page body is restored + verified). Any
 * ambiguity, or any failure to prove the DB body, keeps the marker PENDING
 * (guard held) so a later reconcile cannot insert a fresh fact against a
 * lingering append. Every transition is a CAS.
 */
async function recoverMarkerLocked(engine: BrainEngine, m: PendingMarker, durability: Durability): Promise<RecoverOutcome> {
  const done = (outcome: string, phase: RecoordPhase) => ({ marker_id: m.id, fact_id: m.fact_id, phase, outcome });
  const lostRace = async (): Promise<RecoverOutcome> => { const cur = await getMarker(engine, m.id); return done(`already_${cur?.status ?? 'gone'}`, cur?.phase ?? m.phase); };

  const reval = await revalidate(engine, m.fact_id);
  if (reval.reason === 'fact_not_found') { await keepPendingNote(engine, m.id, 'fact_gone'); return done('deferred_fact_gone', m.phase); }

  // Resolve the backing file for this marker's slug (identity preserved).
  let filePath: string | null = null; let writeRoot: string | null = null;
  try { const t = await resolvePageWriteTarget(engine, m.slug, m.source_id); if (t.ok) { filePath = t.filePath; writeRoot = t.writeRoot; } } catch { /* absent */ }
  if (!filePath || !writeRoot) return done('deferred_source_absent', m.phase);
  const onDisk = existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
  const onHash = onDisk == null ? null : sha256hex(onDisk);
  const isPreimage = onHash != null && onHash === m.preimage_hash;
  const isPostimage = onHash != null && onHash === m.postimage_hash;

  // Restore the DB page body to the on-disk preimage and PROVE it, then release
  // the guard. If the restore/verify cannot be proven, keep pending (round-4 #2):
  // the file/remote may be preimage while `pages` still holds the postimage
  // compiled body, so releasing the uniqueness/adoption guard would be unsafe.
  const releaseToPreimage = async (fromPhases: RecoordPhase[], label: string, remoteRef?: string): Promise<RecoverOutcome> => {
    try { await refreshAndVerifyPageBody(engine, m.slug, m.source_id, onDisk!); }
    catch { await keepPendingNote(engine, m.id, 'preimage_db_body_unproven'); return done('deferred_refresh_failed_preimage', m.phase); }
    const rolled = await casPhase(engine, m.id, fromPhases, 'rolled_back', { ...(remoteRef ? { remote_ref: remoteRef } : {}), note: 'reconciled_to_preimage' });
    if (rolled === 0) return lostRace();
    return done(label, 'rolled_back');
  };

  // 298#2: a crash after atomic rename but before written leaves the marker at
  // marker_created with the POSTIMAGE already on disk (the DB body was never
  // refreshed — refresh runs only after 'written'). Decide by exact on-disk hash.
  if (m.phase === 'marker_created') {
    if (isPreimage) { const c = await casPhase(engine, m.id, ['marker_created'], 'rolled_back', { note: 'aborted_marker_only_preimage' }); return c === 0 ? lostRace() : done('aborted_marker_only', 'rolled_back'); }
    if (isPostimage) { const c = await casPhase(engine, m.id, ['marker_created'], 'written', { note: 'resumed_from_marker_created' }); if (c === 0) return lostRace(); m = { ...m, phase: 'written' }; }
    else return done('deferred_ambiguous_marker_created', m.phase); // guard HELD
  }

  if (m.phase === 'written') {
    if (isPostimage) { const c = await casPhase(engine, m.id, ['written'], 'committed', { note: 'resumed_from_written' }); if (c === 0) return lostRace(); m = { ...m, phase: 'committed' }; } // fall through to reconcile
    else if (isPreimage) return releaseToPreimage(['written'], 'rolled_back_append_gone'); // round-4 #2: verify DB body restored before release
    else { await keepPendingNote(engine, m.id, 'written_bytes_ambiguous'); return done('deferred_ambiguous_written', 'written'); } // guard HELD
  }

  if (m.phase === 'committed' || m.phase === 'published_verified' || m.phase === 'rolling_back') {
    // Sync the CURRENT local bytes to the remote (idempotent, path-scoped push),
    // then decide from the CURRENT local + CURRENT remote file hashes bound to the
    // remote TIP — never old-commit ancestry (305#1/#2). Coordinate ONLY when both
    // carry the exact postimage; release ONLY when both carry the exact preimage
    // AND the DB body is restored+verified; otherwise keep the guard (pending).
    if (onHash == null) return done('deferred_file_missing', m.phase);
    let ref: string;
    try { const res = await durability.commitAndPush(filePath, writeRoot, m.slug); ref = res.ref; await setCommitRef(engine, m.id, res.commitId, res.ref); }
    catch { return done('deferred_commit_failed', m.phase); } // guard HELD
    const remoteHash = await durability.currentRemoteFileHash(writeRoot, ref, filePath);
    if (remoteHash !== onHash) { await keepPendingNote(engine, m.id, 'remote_local_disagree'); return done('deferred_remote_local_disagree', m.phase); } // guard HELD
    if (onHash === m.postimage_hash) {
      // Durable postimage on local + remote: refresh DB, enter published_verified
      // (so the direct coordinate — like the engine seam — acts only from that
      // phase, round-4 #1/#3), then coordinate under the live-identity guard.
      try { await refreshAndVerifyPageBody(engine, m.slug, m.source_id, onDisk!); } catch { return done('deferred_refresh_failed', m.phase); }
      const adv = await casPhase(engine, m.id, ['committed', 'published_verified', 'rolling_back'], 'published_verified', { remote_ref: ref, note: 'recovery_published_verified' });
      if (adv === 0) return lostRace();
      const fresh = await getMarker(engine, m.id);
      if (!fresh || fresh.status !== 'pending') return lostRace();
      const outcome = await applyPendingMarker(engine, fresh); // atomic; only coordinates from (pending, published_verified)
      if (outcome === 'coordinated' || outcome === 'already_coordinated') return done(outcome, 'applied');
      if (outcome === 'not_eligible') return lostRace();
      return done('conflict', fresh.phase); // orphan drifted → guard HELD
    }
    if (onHash === m.preimage_hash) return releaseToPreimage(['committed', 'published_verified', 'rolling_back'], 'rolled_back', ref); // round-4 #2
    await keepPendingNote(engine, m.id, 'ambiguous_bytes'); return done('deferred_ambiguous', m.phase); // NEVER release on ambiguous bytes
  }

  return done('deferred_unknown_phase', m.phase);
}

/**
 * Fail-forward recovery. Acquires the SAME source+page locks the operator uses;
 * RELOADS the marker under those locks (round-4 #4) and short-circuits any that
 * a concurrent adoption/operator terminalized between the pending-list read and
 * the lock (applied-before-recovery-lock race). Drives each still-pending marker
 * through its phase-aware, CAS recovery (issue 1). Never coordinates to
 * non-durable evidence; supports marker-only safe abort; reports truthfully.
 */
export async function recoverPending(engine: BrainEngine, opts: { durability: Durability; factId?: string }): Promise<RecoverOutcome[]> {
  const markers = await listPendingMarkers(engine, opts.factId);
  const out: RecoverOutcome[] = [];
  for (const m of markers) {
    // Resolve lock keys for THIS marker (source id is preserved on the marker).
    const wr = await resolveWriteRoot(engine, m.slug, m.source_id);
    if (!wr) { out.push({ marker_id: m.id, fact_id: m.fact_id, phase: m.phase, outcome: 'deferred_source_absent' }); continue; }
    const res = await withSourceFilesystemLock(engine, wr, () => withPageLock(m.slug, async () => {
      // Reload under the lock: honour a marker terminalized after the list read.
      const fresh = await getMarker(engine, m.id);
      if (!fresh) return { marker_id: m.id, fact_id: m.fact_id, phase: m.phase, outcome: 'already_gone' };
      if (fresh.status !== 'pending') return { marker_id: fresh.id, fact_id: fresh.fact_id, phase: fresh.phase, outcome: `already_${fresh.status}` };
      return recoverMarkerLocked(engine, fresh, opts.durability);
    }));
    out.push(res);
  }
  return out;
}
