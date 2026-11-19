/**
 * Where an owned-folder source's pages live (GST-3022), for `gbrain sources status` (`pages_in`) and Apple status:
 * the folder or the database (and why), the last batch commit, whether that commit is on the remote branch, the last
 * push outcome, and how many days are held. Read-only: it reads the source's connector state and local Git refs, and
 * never fetches.
 */
import type { BrainEngine } from '../engine.ts';
import { connectorDbCursorKey, readConnectorDbCursor } from '../connectors/db-cursor.ts';
import { connectorIdentity } from '../persistence/connector-identity.ts';
import type { ConnectorKind } from '../persistence/connector-kinds.ts';
import { git } from '../git/git-run.ts';
import { getLastPushOutcome } from '../brain-repo-durability.ts';
import { isOwnedFolderKind, ownedFolderRel } from './paths.ts';
import { adoptRedactions, readOwnedState } from './writer.ts';
import { defaultCheckout } from './destination.ts';

export interface PagesIn {
  record: 'folder' | 'database' | 'unknown';
  folder: string | null;
  reason: string | null;
  detail: string | null;
  last_batch: string | null;
  last_batch_at: string | null;
  /** pushed: the last batch is on the branch's upstream; local_only: the checkout has no push remote; failed: the last push needs attention; pending: not pushed yet. */
  pushed: 'pushed' | 'pending' | 'failed' | 'local_only' | null;
  last_push: { status: string; at: string | null; detail: string } | null;
  days_held: number;
  files: number;
}

interface StoredState { record_status?: { record: 'folder' | 'database'; folder: string | null; reason: string | null; detail: string | null } }

function pushState(root: string, rel: string, sha: string, pushUrls: readonly string[]): Pick<PagesIn, 'pushed' | 'last_push'> {
  const branch = git(root, ['symbolic-ref', '-q', '--short', 'HEAD']).stdout.trim();
  const outcome = branch ? getLastPushOutcome(branch, root) : null;
  const last_push = outcome ? { status: outcome.status, at: outcome.at ?? null, detail: outcome.detail } : null;
  if (!pushUrls.length) return { pushed: 'local_only', last_push };
  if (git(root, ['merge-base', '--is-ancestor', sha, '@{upstream}']).code === 0) return { pushed: 'pushed', last_push };
  // A pull that rebased the batch gives it a new sha on the remote: the folder the remote holds is what counts.
  const tree = (rev: string) => git(root, ['rev-parse', '--verify', '-q', `${rev}:${rel}`]).stdout.trim();
  if (tree('@{upstream}') && tree('@{upstream}') === tree('HEAD')) return { pushed: 'pushed', last_push };
  return { pushed: outcome?.status === 'needs_attention' ? 'failed' : 'pending', last_push };
}

/** pages_in for every owned-folder source among `sourceIds`; other sources are left out. */
export async function readPagesIn(engine: BrainEngine, sourceIds: string[]): Promise<Map<string, PagesIn>> {
  const out = new Map<string, PagesIn>();
  if (!sourceIds.length) return out;
  const rows = await engine.executeRaw<{ id: string; incarnation: string; local_path: string | null; config: Record<string, unknown> | null }>(
    'SELECT id, incarnation::text AS incarnation, local_path, config FROM sources WHERE id = ANY($1::text[])', [sourceIds]);
  let root: string | null | undefined;
  for (const row of rows) {
    if (!isOwnedFolderKind(row.config)) continue;
    if (root === undefined) { const checkout = await defaultCheckout(engine); root = 'root' in checkout ? checkout.root : null; }
    const kind = row.config!.kind as ConnectorKind;
    const state = (await readConnectorDbCursor(engine, connectorDbCursorKey(row.id, row.incarnation, connectorIdentity(kind, row.config!, row.local_path))).catch(() => null))?.state as StoredState | null;
    const stored = await readOwnedState(engine, row.id, row.incarnation, kind).catch(() => undefined);
    const owned = stored && { ...stored, files: { ...stored.files } };
    if (owned && root) adoptRedactions(root, ownedFolderRel(row.id), owned);
    const status = state?.record_status;
    const files = Object.keys(owned?.files ?? {}).filter(p => p !== 'OWNER.json' && p !== 'README.md').length;
    const batch = owned?.last_batch ?? null;
    out.set(row.id, {
      record: status?.record ?? 'unknown', folder: status?.record === 'folder' || files ? ownedFolderRel(row.id) : null,
      reason: status?.reason ?? null, detail: status?.detail ?? null, last_batch: batch, last_batch_at: owned?.last_batch_at ?? null,
      ...(batch && root ? pushState(root, ownedFolderRel(row.id), batch, owned!.push_urls) : { pushed: null, last_push: null }),
      days_held: Object.keys(owned?.held ?? {}).length, files,
    });
  }
  return out;
}

export function pagesInLine(sourceId: string, p: PagesIn): string {
  const held = p.days_held ? `; ${p.days_held} day(s) held (gbrain sync --source ${sourceId} names them)` : '';
  const batch = p.last_batch ? `, last commit ${p.last_batch.slice(0, 12)}${p.pushed ? ` (${p.pushed === 'local_only' ? 'this checkout only' : p.pushed})` : ''}` : '';
  if (p.record === 'folder') return `  ${sourceId}: pages in ${p.folder}/ (${p.files} day file(s))${batch}${held}`;
  if (p.record === 'database') return `  ${sourceId}: pages in the database only (${p.reason}: ${p.detail})${p.files ? `; ${p.files} day file(s) stay in ${p.folder}/${batch}` : ''}${held}`;
  return `  ${sourceId}: pages not synced yet`;
}
