import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BrainEngine, TakeKind } from './engine.ts';
import { parseTakesFence, upsertTakeRow } from './takes-fence.ts';
import { withPageLock } from './page-lock.ts';

export interface TakeProposalRow {
  id: number;
  source_id: string;
  page_slug: string;
  status: 'pending' | 'accepted' | 'rejected' | 'superseded';
  claim_text: string;
  kind: TakeKind;
  holder: string;
  weight: number;
  domain?: string | null;
  dedup_against_fence_rows?: unknown;
  model_id: string;
  proposed_at: string;
  acted_at?: string | null;
  acted_by?: string | null;
  promoted_row_num?: number | null;
  predicted_brier?: number | null;
  predicted_brier_bucket_n?: number | null;
  effective_date?: string | null;
  effective_date_source?: string | null;
}

export interface TakeProposalAcceptResult {
  ok: true;
  proposal_id: number;
  page_slug: string;
  row_num: number;
  status: 'accepted';
  idempotent: boolean;
  since_date?: string;
}

export interface TakeProposalRejectResult {
  ok: true;
  proposal_id: number;
  status: 'rejected';
  idempotent: boolean;
  reason?: string;
}

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function dateOnlyOrUndefined(value: unknown, source: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (source === 'fallback') return undefined;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const raw = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : undefined;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function mapProposalRow(row: Record<string, unknown>): TakeProposalRow {
  return {
    id: Number(row.id),
    source_id: String(row.source_id),
    page_slug: String(row.page_slug),
    status: row.status as TakeProposalRow['status'],
    claim_text: String(row.claim_text),
    kind: String(row.kind) as TakeKind,
    holder: String(row.holder),
    weight: Number(row.weight),
    domain: row.domain === undefined ? null : row.domain as string | null,
    dedup_against_fence_rows: row.dedup_against_fence_rows,
    model_id: String(row.model_id),
    proposed_at: isoOrNull(row.proposed_at) ?? '',
    acted_at: isoOrNull(row.acted_at),
    acted_by: row.acted_by === undefined ? null : row.acted_by as string | null,
    promoted_row_num: numberOrNull(row.promoted_row_num),
    predicted_brier: numberOrNull(row.predicted_brier),
    predicted_brier_bucket_n: numberOrNull(row.predicted_brier_bucket_n),
    effective_date: isoOrNull(row.effective_date),
    effective_date_source: row.effective_date_source === undefined ? null : row.effective_date_source as string | null,
  };
}

async function resolveBrainDir(engine: BrainEngine, explicitDir?: string): Promise<string> {
  if (explicitDir) return explicitDir;
  const configured = await engine.getConfig('sync.repo_path');
  if (configured) return configured;
  throw new Error('No brain directory configured. Pass brainDir or set sync.repo_path.');
}

function pageFilePath(brainDir: string, slug: string): string {
  return join(brainDir, `${slug}.md`);
}

export async function listTakeProposals(
  engine: BrainEngine,
  opts: {
    limit?: number;
    offset?: number;
    status?: TakeProposalRow['status'];
    sourceId?: string;
  } = {},
): Promise<TakeProposalRow[]> {
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 50)));
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const rows = await engine.executeRaw(
    `SELECT
       tp.id, tp.source_id, tp.page_slug, tp.status, tp.claim_text,
       tp.kind, tp.holder, tp.weight, tp.domain, tp.dedup_against_fence_rows,
       tp.model_id, tp.proposed_at, tp.acted_at, tp.acted_by,
       tp.promoted_row_num, tp.predicted_brier, tp.predicted_brier_bucket_n,
       p.effective_date, p.effective_date_source
     FROM take_proposals tp
     LEFT JOIN pages p ON p.slug = tp.page_slug AND p.source_id = tp.source_id
     WHERE ($1::text IS NULL OR tp.status = $1)
       AND ($2::text IS NULL OR tp.source_id = $2)
     ORDER BY
       CASE WHEN tp.predicted_brier IS NULL THEN 1 ELSE 0 END,
       tp.predicted_brier ASC NULLS LAST,
       tp.proposed_at DESC
     LIMIT $3 OFFSET $4`,
    [opts.status ?? 'pending', opts.sourceId ?? null, limit, offset],
  );
  return rows.map((r) => mapProposalRow(r as Record<string, unknown>));
}

export async function acceptTakeProposal(
  engine: BrainEngine,
  proposalId: number,
  opts: { brainDir?: string; actedBy?: string; sourceId?: string } = {},
): Promise<TakeProposalAcceptResult> {
  const proposalLookup = await engine.executeRaw<{ page_slug: string; source_id: string; status: string; promoted_row_num: number | null }>(
    `SELECT page_slug, source_id, status, promoted_row_num
     FROM take_proposals WHERE id = $1 LIMIT 1`,
    [proposalId],
  );
  const existing = proposalLookup[0];
  if (!existing) throw new Error(`take proposal not found: ${proposalId}`);
  if (opts.sourceId && existing.source_id !== opts.sourceId) {
    throw new Error(`take proposal ${proposalId} is outside source scope ${opts.sourceId}`);
  }

  const actedBy = opts.actedBy ?? 'gbrain-cli';
  const brainDir = await resolveBrainDir(engine, opts.brainDir);

  return withPageLock(existing.page_slug, async () => {
    const path = pageFilePath(brainDir, existing.page_slug);
    if (!existsSync(path)) {
      throw new Error(`source markdown page not found: ${path}`);
    }

    let originalBody: string | null = null;
    let wroteBody = false;

    try {
      return await engine.transaction(async (tx) => {
        const rows = await tx.executeRaw<Record<string, unknown>>(
          `SELECT
             tp.id, tp.source_id, tp.page_slug, tp.status, tp.claim_text,
             tp.kind, tp.holder, tp.weight, tp.model_id, tp.promoted_row_num,
             p.id AS page_id, p.effective_date, p.effective_date_source
           FROM take_proposals tp
           JOIN pages p ON p.slug = tp.page_slug AND p.source_id = tp.source_id
           WHERE tp.id = $1
           FOR UPDATE OF tp`,
          [proposalId],
        );
        const row = rows[0];
        if (!row) throw new Error(`take proposal not found: ${proposalId}`);
        if (opts.sourceId && row.source_id !== opts.sourceId) {
          throw new Error(`take proposal ${proposalId} is outside source scope ${opts.sourceId}`);
        }

        const promotedRowNum = numberOrNull(row.promoted_row_num);
        if (row.status === 'accepted' && promotedRowNum !== null) {
          return {
            ok: true,
            proposal_id: proposalId,
            page_slug: String(row.page_slug),
            row_num: promotedRowNum,
            status: 'accepted',
            idempotent: true,
            since_date: dateOnlyOrUndefined(row.effective_date, row.effective_date_source),
          } satisfies TakeProposalAcceptResult;
        }
        if (row.status !== 'pending') {
          throw new Error(`take proposal ${proposalId} is ${row.status}; only pending proposals can be accepted`);
        }

        const pageId = Number(row.page_id);
        await tx.executeRaw('SELECT pg_advisory_xact_lock($1::bigint)', [pageId]);

        const dupes = await tx.executeRaw<{ row_num: number }>(
          `SELECT row_num
           FROM takes
           WHERE page_id = $1 AND active = true
             AND lower(trim(claim)) = lower(trim($2))
           LIMIT 1`,
          [pageId, row.claim_text],
        );
        if (dupes.length > 0) {
          throw new Error(`take proposal ${proposalId} duplicates existing take row #${dupes[0].row_num}`);
        }

        originalBody = readFileSync(path, 'utf-8');
        const sinceDate = dateOnlyOrUndefined(row.effective_date, row.effective_date_source);
        const { body: nextBody, rowNum } = upsertTakeRow(originalBody, {
          claim: String(row.claim_text),
          kind: String(row.kind),
          holder: String(row.holder),
          weight: Number(row.weight),
          source: `proposal:${proposalId}`,
          sinceDate,
          active: true,
        });
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, nextBody, 'utf-8');
        wroteBody = true;

        await tx.addTakesBatch([{
          page_id: pageId,
          row_num: rowNum,
          claim: String(row.claim_text),
          kind: String(row.kind),
          holder: String(row.holder),
          weight: Number(row.weight),
          since_date: sinceDate,
          source: `proposal:${proposalId}`,
          active: true,
          superseded_by: null,
        }]);
        const stamped = await tx.executeRaw<{ promoted_row_num: number }>(
          `UPDATE take_proposals
           SET status = 'accepted',
               acted_at = now(),
               acted_by = $2,
               promoted_row_num = $3
           WHERE id = $1 AND status = 'pending'
           RETURNING promoted_row_num`,
          [proposalId, actedBy, rowNum],
        );
        if (stamped.length === 0) {
          throw new Error(`take proposal ${proposalId} was not stamped accepted`);
        }
        return {
          ok: true,
          proposal_id: proposalId,
          page_slug: String(row.page_slug),
          row_num: rowNum,
          status: 'accepted',
          idempotent: false,
          since_date: sinceDate,
        } satisfies TakeProposalAcceptResult;
      });
    } catch (err) {
      if (wroteBody && originalBody !== null) {
        writeFileSync(path, originalBody, 'utf-8');
      }
      throw err;
    }
  });
}

export async function rejectTakeProposal(
  engine: BrainEngine,
  proposalId: number,
  opts: { actedBy?: string; reason?: string; sourceId?: string } = {},
): Promise<TakeProposalRejectResult> {
  const actedBy = opts.actedBy ?? 'gbrain-cli';
  return engine.transaction(async (tx) => {
    const rows = await tx.executeRaw<Record<string, unknown>>(
      `SELECT id, source_id, status, promoted_row_num
       FROM take_proposals WHERE id = $1
       FOR UPDATE`,
      [proposalId],
    );
    const row = rows[0];
    if (!row) throw new Error(`take proposal not found: ${proposalId}`);
    if (opts.sourceId && row.source_id !== opts.sourceId) {
      throw new Error(`take proposal ${proposalId} is outside source scope ${opts.sourceId}`);
    }
    if (row.status === 'rejected') {
      return { ok: true, proposal_id: proposalId, status: 'rejected', idempotent: true, reason: opts.reason };
    }
    if (row.status === 'accepted' || numberOrNull(row.promoted_row_num) !== null) {
      throw new Error(`take proposal ${proposalId} is already accepted and cannot be rejected`);
    }
    await tx.executeRaw(
      `UPDATE take_proposals
       SET status = 'rejected',
           acted_at = now(),
           acted_by = $2
       WHERE id = $1`,
      [proposalId, actedBy],
    );
    return { ok: true, proposal_id: proposalId, status: 'rejected', idempotent: false, reason: opts.reason };
  });
}
