/**
 * The installed-base transcript secret audit (#6147 follow-through).
 * Conversation pages imported before the `labeled_credential` detector
 * shipped keep any prose credential they carried: re-ingest skips them
 * (content hash and `--since last`), and nothing rewrites a page on its own.
 * `gbrain transcripts audit-secrets` scans those pages with the same
 * transcript-lane detectors the importer uses now and lists the affected
 * page slugs with hit counts per pattern. It never prints, returns or stores
 * a matched value or a preview, and it changes no page. Its summary is
 * cached in the config row `transcripts.secret_audit` so the
 * `transcript_secret_exposure` doctor check reads it instead of scanning.
 *
 * Bounded memory: conversation parts run to ~300 KB, so pages stream in id
 * order in small keyset batches.
 */
import type { BrainEngine } from '../engine.ts';
import { scanText } from '../secret-scan.ts';

/** Bump when the transcript-lane detectors change, so doctor asks for a fresh audit. */
export const TRANSCRIPT_SECRET_AUDIT_VERSION = 1;
export const TRANSCRIPT_SECRET_AUDIT_KEY = 'transcripts.secret_audit';
const BATCH = 25;
const LINES_PER_PAGE = 20;

/** The page set the importer writes: conversation pages stamped with `transcript_import`. */
export const TRANSCRIPT_PAGE_PREDICATE = `type = 'conversation' AND deleted_at IS NULL AND frontmatter ? 'transcript_import'`;

export interface TranscriptSecretAuditPage {
  slug: string;
  source_id: string;
  hits: Record<string, number>;
  /** 1-based body line numbers of the hits (first 20), so a reviewer can find them; never the text. */
  lines: number[];
}

export interface TranscriptSecretAuditSummary {
  detector_version: number;
  scanned_at: string;
  source_id: string | null;
  pages_scanned: number;
  pages_affected: number;
  hits_total: number;
  by_pattern: Record<string, number>;
}

export interface TranscriptSecretAuditResult extends TranscriptSecretAuditSummary {
  pages: TranscriptSecretAuditPage[];
}

export async function auditTranscriptSecrets(
  engine: BrainEngine,
  opts: { sourceId?: string; now?: () => Date } = {},
): Promise<TranscriptSecretAuditResult> {
  const pages: TranscriptSecretAuditPage[] = [];
  const byPattern: Record<string, number> = {};
  let pagesScanned = 0;
  let cursor = 0;
  for (;;) {
    const params: unknown[] = [cursor, BATCH];
    if (opts.sourceId) params.push(opts.sourceId);
    const rows = await engine.executeRaw<{ id: number | string; slug: string; source_id: string; title: string; compiled_truth: string }>(
      `SELECT id, slug, source_id, title, compiled_truth FROM pages
        WHERE ${TRANSCRIPT_PAGE_PREDICATE} AND id > $1${opts.sourceId ? ' AND source_id = $3' : ''}
        ORDER BY id LIMIT $2`,
      params,
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      cursor = Number(row.id);
      pagesScanned++;
      const findings = [
        ...scanText(row.title ?? '', { highEntropy: true, labeledCredentials: true }).map((f) => ({ ...f, line: 0 })),
        ...scanText(row.compiled_truth ?? '', { highEntropy: true, labeledCredentials: true }),
      ];
      if (findings.length === 0) continue;
      const hits: Record<string, number> = {};
      for (const f of findings) {
        hits[f.pattern] = (hits[f.pattern] ?? 0) + 1;
        byPattern[f.pattern] = (byPattern[f.pattern] ?? 0) + 1;
      }
      const lines = [...new Set(findings.map((f) => f.line).filter((l) => l > 0))].slice(0, LINES_PER_PAGE);
      pages.push({ slug: row.slug, source_id: row.source_id, hits, lines });
    }
    if (rows.length < BATCH) break;
  }
  return {
    detector_version: TRANSCRIPT_SECRET_AUDIT_VERSION,
    scanned_at: (opts.now?.() ?? new Date()).toISOString(),
    source_id: opts.sourceId ?? null,
    pages_scanned: pagesScanned,
    pages_affected: pages.length,
    hits_total: Object.values(byPattern).reduce((n, v) => n + v, 0),
    by_pattern: byPattern,
    pages,
  };
}

/** Cache the summary (no slugs, no values) for the doctor check. Best effort. */
export async function saveTranscriptSecretAudit(engine: BrainEngine, result: TranscriptSecretAuditResult): Promise<boolean> {
  const { pages: _pages, ...summary } = result;
  try {
    await engine.setConfig(TRANSCRIPT_SECRET_AUDIT_KEY, JSON.stringify(summary));
    return true;
  } catch {
    return false;
  }
}

export async function loadTranscriptSecretAudit(engine: BrainEngine): Promise<TranscriptSecretAuditSummary | null> {
  try {
    const raw = await engine.getConfig(TRANSCRIPT_SECRET_AUDIT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TranscriptSecretAuditSummary;
    return typeof parsed.scanned_at === 'string' && typeof parsed.hits_total === 'number' ? parsed : null;
  } catch {
    return null;
  }
}
