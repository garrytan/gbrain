/**
 * Wave C 1H-a (spec §3.1 steps 7-8, §17 eng-r3-native-1, eng-r3-outside-3): what a strict git-first publication of a
 * segmented page writes in its door transaction, after the ref compare-and-swap. No page metadata changes: the page's
 * `page_pending_heads` row records the committed head (commit, blob, the revision the flip installs, size and sha256, title,
 * type, frontmatter, lead, access state), and an `index-split-page` effect bound to the source's worktree (so only the owner
 * host claims it) derives the rows from the committed blob (the consumer registered in git-first-gate.ts). The request becomes `indexing`: its
 * physical publication is complete (recovery record and reservation clear as for a committed write) and its receipt stays
 * pending until the flip.
 *
 * A newer commit to the same page replaces the row (the token), so an older index job finds it moved and ends its request
 * `superseded`. Pages up to PAGE_MAX_BYTES only (unsplit, 1H-a); a split page is PR 5's.
 */
import { createHash, randomUUID } from 'node:crypto';
import { relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { INDEX_SPLIT_PAGE_EFFECT } from './git-first-gate.ts';
import type { WriteRequest } from './model.ts';
import { headBlob } from './pending-import.ts';

/** The metadata a deferred segmented write carries to its door transaction (page-prepare.ts). */
export interface IndexFromGit {
  title: string;
  type: string;
  frontmatter: Record<string, unknown>;
  /** Receipt fields the preparation decided before the door (the write gate's outcome, a quarantine). */
  outcome?: Record<string, unknown>;
}

/** Lead text kept on a pending head: what a partial read during the lag shows. */
export const PENDING_LEAD_MAX_CHARS = 4096;

/** The committed file's first PENDING_LEAD_MAX_CHARS characters after its frontmatter block. */
export function pendingLead(file: string): string {
  const head = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(file.slice(0, 1024 * 1024));
  return file.slice(head ? head[0].length : 0, (head ? head[0].length : 0) + PENDING_LEAD_MAX_CHARS).replace(/^\s+/, '');
}

/** The receipt's `index` object (spec §3.1 step 8). */
export interface IndexReceipt {
  state: 'pending' | 'indexed' | 'held' | 'superseded';
  commit: string;
  /** While pending: the revision a write's precondition names to replace the committed head before the flip (pendingPrecondition). */
  revision?: string;
  hold_code?: string;
  superseded_by?: string;
}

/**
 * Upserts the page's pending head for the commit just landed and queues its index effect. `content` is the committed
 * file's text; `root` and `path` name the checkout and the file.
 */
export async function queueIndexFromGit(tx: BrainEngine, row: WriteRequest, index: IndexFromGit, content: string, snapshot: PageSnapshot | null,
  commit: string, root: string, path: string): Promise<IndexReceipt> {
  const headOid = await headBlob(root, path);
  if (!headOid) throw new Error(`The door commit ${commit} landed without a blob at ${path}.`);
  const rel = relative(root, path).split(sep).join('/');
  const bytes = Buffer.from(content, 'utf8');
  const revision = randomUUID();
  await tx.executeRaw(`INSERT INTO page_pending_heads (source_id, slug, page_id, request_id, commit_oid, head_oid, path, revision, body_bytes, body_sha256,
      title, type, frontmatter, lead_text, access_state)
    VALUES ($1, $2, $3::int, $4::uuid, $5, $6, $7, $8::uuid, $9::bigint, decode($10, 'hex'), $11, $12, $13::text::jsonb, $14, 'world')
    ON CONFLICT (source_id, slug) DO UPDATE SET page_id = EXCLUDED.page_id, request_id = EXCLUDED.request_id, commit_oid = EXCLUDED.commit_oid,
      head_oid = EXCLUDED.head_oid, path = EXCLUDED.path, revision = EXCLUDED.revision, body_bytes = EXCLUDED.body_bytes, body_sha256 = EXCLUDED.body_sha256,
      title = EXCLUDED.title, type = EXCLUDED.type, frontmatter = EXCLUDED.frontmatter, lead_text = EXCLUDED.lead_text, access_state = EXCLUDED.access_state,
      hold_code = NULL, queued_at = now()`,
  [row.source_id, row.slug, snapshot?.page.id ?? null, row.id, commit, headOid, rel, revision, bytes.byteLength,
    createHash('sha256').update(bytes).digest('hex'), index.title, index.type, JSON.stringify(index.frontmatter), pendingLead(content)]);
  await tx.executeRaw(`INSERT INTO persistence_effects (request_id, kind, revision, data, source_id, source_incarnation, worktree_id)
    VALUES ($1::uuid, $2, NULL, $3::text::jsonb, $4, $5::uuid, $6::uuid) ON CONFLICT (request_id, kind) DO NOTHING`,
  [row.id, INDEX_SPLIT_PAGE_EFFECT, JSON.stringify({ slug: row.slug, commit, head_oid: headOid, path: rel, pending_revision: revision }),
    row.source_id, row.source_incarnation, row.worktree_id]);
  return { state: 'pending', commit, revision };
}

/** The page's pending head, or null when the page has none (indexed, or never written through the git-first path). */
export interface PendingHead {
  source_id: string; slug: string; page_id: number | null; request_id: string; commit_oid: string; head_oid: string; path: string;
  revision: string; body_bytes: number; body_sha256: string; title: string | null; type: string | null; frontmatter: Record<string, unknown> | null;
  lead_text: string | null; access_state: 'world' | 'private'; hold_code: string | null; queued_at: string;
}

export async function readPendingHead(exec: Pick<BrainEngine, 'executeRaw'>, sourceId: string, slug: string, opts: { lock?: boolean } = {}): Promise<PendingHead | null> {
  const [row] = await exec.executeRaw<PendingHead>(`SELECT source_id, slug, page_id, request_id::text AS request_id, commit_oid, head_oid, path,
      revision::text AS revision, body_bytes, encode(body_sha256, 'hex') AS body_sha256, title, type, frontmatter, lead_text, access_state, hold_code, queued_at
    FROM page_pending_heads WHERE source_id = $1 AND slug = $2${opts.lock ? ' FOR UPDATE' : ''}`, [sourceId, slug]);
  return row ? { ...row, body_bytes: Number(row.body_bytes), page_id: row.page_id == null ? null : Number(row.page_id) } : null;
}

/** Removes the pending heads of `slugs` (a door publication that replaced or removed those pages). */
export async function clearPendingHeads(tx: Pick<BrainEngine, 'executeRaw'>, sourceId: string, slugs: string[]): Promise<void> {
  await tx.executeRaw('DELETE FROM page_pending_heads WHERE source_id = $1 AND slug = ANY($2::text[])', [sourceId, slugs]);
}

/**
 * `index_pending`: the page's newest committed head is not indexed yet, so the database still shows the generation before
 * it. Retryable: the index step flips it shortly, and the committed write's receipt shows when.
 */
export function indexPendingError(slug: string, requestId: string): OperationError {
  return opError('index_pending', `Page ${slug} has a committed write (request ${requestId}) that is not indexed yet, so this write was not applied to stale rows; nothing was written.`,
    'Wait a few seconds for the index step, then read the page again and submit the write with a new request_id.',
    { fix: { argv: ['gbrain', 'write-request', '--', requestId], consent: [], actor: 'agent', requires_exclusive: false,
      why: 'Read-only: the committed write\'s receipt says when its index step has flipped the page.' } });
}

/**
 * Wave C (ceo-r3-outside-1, read side): the revision a write's precondition is checked against while the page has a
 * pending head. The rows still describe the generation before the committed head, so the head's revision (the indexing
 * receipt's `index.revision`) is the current one; a precondition naming the rows' revision read stale content and
 * refuses index_pending (retryable) until the flip.
 */
export function pendingPrecondition(slug: string, pending: PendingHead, rowsRevision: string | null | undefined, expected: unknown): string {
  const named = typeof expected === 'string' ? expected.toLowerCase() : null;
  if (named !== null && named === rowsRevision && named !== pending.revision) throw indexPendingError(slug, pending.request_id);
  return pending.revision;
}
