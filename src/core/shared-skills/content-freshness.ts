import { isAbsolute, resolve } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { graduationVerifyInheritsPersistence } from '../persistence/ownership.ts';
import { isMissingSchemaObject } from '../utils.ts';

/** Objects ownedContentFreshness reads that an older schema may lack; any other SQL error surfaces (#6599). */
const OWNED_CONTENT_TABLES = [
  'persistence_brain', 'persistence_source_bindings', 'persistence_worktrees', 'persistence_host_bindings',
  'persistence_requests', 'persistence_effects', 'source_ingestion_receipts',
] as const;
const OWNED_CONTENT_COLUMNS = ['incarnation', 'source_incarnation', 'recovery', 'owner_host_id'] as const;

/** True only when the error names a table or column ownedContentFreshness reads and the schema predates it. */
export function isOwnedContentSchemaMissing(error: unknown): boolean {
  return isMissingSchemaObject(error, 'table', OWNED_CONTENT_TABLES) || isMissingSchemaObject(error, 'column', OWNED_CONTENT_COLUMNS);
}

export interface OwnedContentFreshness {
  sourceId: string;
  pending: number;
  recovering: number;
}

/** C-7: a gbrain-owned content source whose complete receipt names another root than the source and its owner binding. */
export interface StaleOwnedContent {
  sourceId: string;
  receiptRoot: string | null;
  /** The owner host's binding root joined with the source's relative_path. */
  ownerRoot: string | null;
  localPath: string;
}

interface OwnedContentRow {
  id: string; incarnation: string; local_path: string; config: unknown; last_commit: string | null;
  brain_id: string; receipt: string; owner_root: string; relative_path: string; pending: number; recovering: number;
}

async function ownedContentRows(engine: BrainEngine, sourceIds?: string[]): Promise<OwnedContentRow[]> {
  return engine.executeRaw<OwnedContentRow>(`SELECT s.id,s.incarnation,s.local_path,s.config,s.last_commit,p.brain_id,c.value AS receipt,
      h.local_path AS owner_root,b.relative_path,
      ((SELECT COUNT(*) FROM persistence_requests r WHERE r.source_id=s.id AND r.source_incarnation=s.incarnation
        AND r.state IN ('queued','running') AND r.recovery IS NULL)
       +(SELECT COUNT(*) FROM persistence_effects e WHERE e.source_id=s.id AND e.source_incarnation=s.incarnation
        AND e.kind='withdrawal-mirror' AND e.state IN ('queued','running') AND e.recovery IS NULL))::integer AS pending,
      ((SELECT COUNT(*) FROM persistence_requests r WHERE r.source_id=s.id AND r.source_incarnation=s.incarnation
        AND (r.state='recovering' OR r.recovery IS NOT NULL))
       +(SELECT COUNT(*) FROM persistence_effects e WHERE e.source_id=s.id AND e.source_incarnation=s.incarnation
        AND e.recovery IS NOT NULL))::integer AS recovering
    FROM sources s JOIN persistence_brain p ON p.singleton=1 AND (p.enabled OR $2::boolean)
    JOIN config c ON c.key='shared_skills.content.v1.'||s.id||'.'||s.incarnation::text
    JOIN persistence_source_bindings b ON b.source_id=s.id AND b.source_incarnation=s.incarnation
    JOIN persistence_worktrees w ON w.id=b.worktree_id AND w.state='active' AND w.owner_host_id IS NOT NULL
    JOIN persistence_host_bindings h ON h.worktree_id=w.id AND h.host_id=w.owner_host_id
    WHERE NOT s.archived AND s.local_path IS NOT NULL AND ($1::text[] IS NULL OR s.id=ANY($1::text[]))
      AND NOT EXISTS (SELECT 1 FROM source_ingestion_receipts r WHERE r.source_id=s.id AND r.source_incarnation=s.incarnation AND r.profile='company-brain')`, [sourceIds ?? null, await graduationVerifyInheritsPersistence(engine)]);
}

/** The row's complete, ready, owned receipt of a plain content source (no connector, clone or company brain), else null. */
function completeOwnedReceipt(row: OwnedContentRow, sourceIds?: string[]): Record<string, unknown> | null {
  if (sourceIds && !sourceIds.includes(row.id)) return null;
  if (!row.config || typeof row.config !== 'object' || Array.isArray(row.config) || row.last_commit !== null) return null;
  const config = row.config as Record<string, unknown>;
  if (config.kind != null || config.remote_url != null || config.managed_clone === true || config.company_brain != null) return null;
  let receipt: Record<string, unknown>;
  try { receipt = JSON.parse(row.receipt); } catch { return null; }
  return receipt && receipt.version === 1 && receipt.brain_id === row.brain_id && receipt.source_id === row.id
    && receipt.source_incarnation === row.incarnation && receipt.owned_root === true && receipt.stage === 'complete'
    && receipt.status === 'ready' && ['content_directory', 'git'].includes(String(receipt.repository_kind)) ? receipt : null;
}

const ownerRootOf = (row: OwnedContentRow) => typeof row.owner_root === 'string' && typeof row.relative_path === 'string' ? resolve(row.owner_root, row.relative_path) : null;

/** The receipt, the source's local_path and the owner binding name one absolute root. */
function rootsAgree(row: OwnedContentRow, receipt: Record<string, unknown>): boolean {
  return receipt.root === row.local_path && typeof row.local_path === 'string' && isAbsolute(row.local_path) && ownerRootOf(row) === row.local_path;
}

export async function ownedContentFreshness(engine: BrainEngine, sourceIds?: string[]): Promise<OwnedContentFreshness[]> {
  const result: OwnedContentFreshness[] = [];
  for (const row of await ownedContentRows(engine, sourceIds)) {
    const receipt = completeOwnedReceipt(row, sourceIds);
    if (receipt && rootsAgree(row, receipt)) result.push({ sourceId: row.id, pending: Number(row.pending), recovering: Number(row.recovering) });
  }
  return result;
}

/**
 * C-7: owned content sources whose complete receipt, local_path and owner binding disagree on the root (a transfer or
 * relocation an older release ran, or a set-path still to run). Doctor names `gbrain repair content-receipt-root` for them.
 */
export async function staleOwnedContent(engine: BrainEngine, sourceIds?: string[]): Promise<StaleOwnedContent[]> {
  const result: StaleOwnedContent[] = [];
  for (const row of await ownedContentRows(engine, sourceIds)) {
    const receipt = completeOwnedReceipt(row, sourceIds);
    if (receipt && !rootsAgree(row, receipt)) result.push({ sourceId: row.id, receiptRoot: typeof receipt.root === 'string' ? receipt.root : null, ownerRoot: ownerRootOf(row), localPath: row.local_path });
  }
  return result;
}
