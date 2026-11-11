/**
 * `gbrain repair atom-fence-rows`: world atoms that carry text of a fence row
 * their source page shows only to the owner.
 *
 * Atoms extracted before the extraction input was the page as a world reader
 * sees it (extract-atoms-input.ts) could copy such a row into their title, body
 * or verified `source_quote`, and a world atom serves it to remote callers. A
 * live page-bound atom stamped `visibility: world` is listed when its title,
 * body or source_quote contains (case and whitespace folded) the claim of a
 * facts row of its live source page whose visibility is not world, or of a
 * takes row whose holder is not world, unless the page's world text
 * (`publicBody`) holds the same claim too. Claims under MIN_CLAIM_CHARS are
 * not matched. A source page stored in segments is not read; its atoms are
 * counted as `origin_unread`.
 *
 * Explicit-only and preview-bound: the preview lists each atom with its source
 * page and the row kinds and numbers it carries, never the row text, and
 * changes nothing; `--apply --expect <hash>` narrows exactly that set to
 * `visibility: private` through a revision-bound put_page (re-chunked and
 * re-embedded by its publication). An atom whose revision, source page or
 * matched rows changed since reports `changed_since_preview` and is kept.
 * The same scan backs doctor's `atom_fence_rows` check.
 */
import type { BrainEngine } from '../engine.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END, parseFactsFence } from '../facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END, parseTakesFence } from '../takes-fence.ts';
import { protectedRegions } from '../fence-scan.ts';
import { publicBody } from '../mentions/aliases.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { OperationError } from '../ops/contract.ts';
import { submitPageMutation } from '../persistence/page-mutations.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { afterCursor, repairRequestId, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairPlan, type RepairScope } from './core.ts';

export const MIN_CLAIM_CHARS = 12;
const BATCH = 500;

export interface HiddenRowMatch { kind: 'facts' | 'takes'; row: number }

export interface AtomFenceRow {
  id: number;
  source_id: string;
  slug: string;
  revision: string;
  origin_slug: string;
  origin_id: number;
  origin_hash: string | null;
  rows: HiddenRowMatch[];
}

interface ScanOptions { atomId?: number; timeoutMs?: number }

const fold = (text: string) => text.replace(/~~/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Every fence publicBody removes (one quoted in a code block and an unterminated tail included), each closed for parsing. */
function fenceRegions(body: string, begin: string, end: string): string[] {
  const { regions, truncatedAt } = protectedRegions(body, [{ begin, end }]);
  const texts = regions.map(region => body.slice(region.start, region.end));
  return truncatedAt === -1 ? texts : [...texts, `${body.slice(truncatedAt)}\n${end}`];
}

/** Claims of the page's facts rows other than world and takes rows held by someone other than world, absent from its world text. */
function hiddenRows(body: string): Array<HiddenRowMatch & { claim: string }> {
  const world = fold(publicBody(body));
  const rows = [
    ...fenceRegions(body, FACTS_FENCE_BEGIN, FACTS_FENCE_END).flatMap(text => parseFactsFence(text).facts)
      .filter(f => f.visibility !== 'world').map(f => ({ kind: 'facts' as const, row: f.rowNum, claim: fold(f.claim) })),
    ...fenceRegions(body, TAKES_FENCE_BEGIN, TAKES_FENCE_END).flatMap(text => parseTakesFence(text).takes)
      .filter(t => t.holder !== 'world').map(t => ({ kind: 'takes' as const, row: t.rowNum, claim: fold(t.claim) })),
  ];
  return rows.filter(r => r.claim.length >= MIN_CLAIM_CHARS && !world.includes(r.claim));
}

/**
 * World atoms of these sources that carry a hidden row of their source page, in id order, and the number of world
 * atoms whose source page is stored in segments (not read). One keyset-paged pass over the sources' world atoms whose
 * source page names a facts or takes fence, plus one read of each such page.
 */
export async function findAtomFenceRows(engine: BrainEngine, sourceIds: string[], opts: ScanOptions = {}): Promise<{ atoms: AtomFenceRow[]; origin_unread: number }> {
  const atoms: AtomFenceRow[] = [];
  const origins = new Map<number, Array<HiddenRowMatch & { claim: string }>>();
  let originUnread = 0;
  let after = 0;
  for (;;) {
    const rows = await engine.executeRaw<{ id: number; source_id: string; slug: string; revision: string; text: string; origin_id: number; origin_slug: string;
      origin_hash: string | null; origin_unread: boolean }>(
      `SELECT a.id, a.source_id, a.slug, a.knowledge_revision::text AS revision,
              concat_ws(E'\\n', a.title, a.compiled_truth, a.frontmatter->>'source_quote') AS text,
              o.id AS origin_id, o.slug AS origin_slug, o.content_hash AS origin_hash, o.compiled_truth IS NULL AS origin_unread
         FROM pages a
         JOIN pages o ON o.source_id=a.source_id AND o.slug=a.frontmatter->>'source_slug' AND o.deleted_at IS NULL
        WHERE a.source_id=ANY($1::text[]) AND a.type='atom' AND a.deleted_at IS NULL AND a.frontmatter->>'visibility'='world'
          AND ($2::int IS NULL OR a.id=$2::int) AND a.id>$3
          AND (o.compiled_truth IS NULL OR strpos(o.compiled_truth, 'gbrain:facts:begin')>0 OR strpos(o.compiled_truth, 'gbrain:takes:begin')>0)
        ORDER BY a.id LIMIT $4`, [sourceIds, opts.atomId ?? null, after, BATCH], opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : undefined);
    if (!rows.length) break;
    const unseen = [...new Set(rows.filter(r => !r.origin_unread).map(r => Number(r.origin_id)))].filter(id => !origins.has(id));
    if (unseen.length) {
      const bodies = await engine.executeRaw<{ id: number; body: string | null }>('SELECT id, compiled_truth AS body FROM pages WHERE id=ANY($1::int[])',
        [unseen], opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : undefined);
      for (const page of bodies) origins.set(Number(page.id), hiddenRows(page.body ?? ''));
    }
    for (const row of rows) {
      if (row.origin_unread) { originUnread++; continue; }
      const text = fold(row.text ?? '');
      const matched = (origins.get(Number(row.origin_id)) ?? []).filter(hidden => text.includes(hidden.claim)).map(({ kind, row: n }) => ({ kind, row: n }));
      if (matched.length) atoms.push({ id: Number(row.id), source_id: row.source_id, slug: row.slug, revision: row.revision, origin_slug: row.origin_slug,
        origin_id: Number(row.origin_id), origin_hash: row.origin_hash, rows: matched });
    }
    after = Number(rows.at(-1)!.id);
    if (rows.length < BATCH) break;
  }
  return { atoms, origin_unread: originUnread };
}

export function atomFenceRowsPreviewCommand(sourceIds: string[]): string {
  return `gbrain repair atom-fence-rows${sourceIds.length === 1 ? ` --source ${sourceIds[0]}` : ''}`;
}

interface AtomFenceRowItem extends RepairItem { atom: AtomFenceRow; hash: string; last: boolean }

interface ApprovedAtom extends AtomFenceRow { selection: string[] }

const rowLabel = (atom: AtomFenceRow) => atom.rows.map(r => `${r.kind} row ${r.row}`).join(', ');

const sameAtom = (live: AtomFenceRow | undefined, approved: AtomFenceRow) => !!live
  && (['id', 'source_id', 'slug', 'revision', 'origin_slug', 'origin_id', 'origin_hash'] as const).every(field => live[field] === approved[field])
  && rowLabel(live) === rowLabel(approved);

function item(atom: AtomFenceRow, hash: string, last: boolean): AtomFenceRowItem {
  return { cursor: { phase: 1, id: atom.id }, source_id: atom.source_id, slug: atom.slug, chars: 0,
    action: 'narrow:private', change: { from: 'world', to: 'private' }, atom, hash, last };
}

async function hashParts(engine: BrainEngine, scope: RepairScope, atoms: AtomFenceRow[]) {
  const sources = await engine.executeRaw<{ id: string; incarnation: string }>(
    'SELECT id, incarnation::text AS incarnation FROM sources WHERE id=ANY($1::text[]) ORDER BY id', [scope.source_ids]);
  return { kind: 'atom-fence-rows-v1', brain_id: scope.brain_id, sources, selection: { source_ids: scope.source_ids }, atoms };
}

export const atomFenceRowsRepair: RepairHandler = {
  kind: 'atom-fence-rows',
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    const command = atomFenceRowsPreviewCommand(scope.source_ids);
    if (!opts?.apply) {
      const { atoms, origin_unread } = await findAtomFenceRows(engine, scope.source_ids);
      const hash = previewHash(await hashParts(engine, scope, atoms));
      if (atoms.length) await saveApprovedSet<ApprovedAtom>(engine, { command: 'atom-fence-rows', hash }, atoms.map(atom => ({ ...atom, selection: scope.source_ids })));
      return { items: atoms.map((atom, index) => item(atom, hash, index === atoms.length - 1)), preview_hash: hash,
        residuals: { origin_unread },
        listing: atoms.map(atom => ({ item: `${atom.source_id}:${atom.slug}`, class: [...new Set(atom.rows.map(r => r.kind))].join('+'),
          detail: `source page ${atom.origin_slug}: ${rowLabel(atom)}` })) };
    }
    if (!opts.expect) {
      throw new OperationError('invalid_params', 'gbrain repair atom-fence-rows --apply narrows only the set a preview printed.',
        `Preview first: ${command} — then run the apply command it prints: ${command} --apply --expect <preview-hash>`,
        'docs/guides/repair.md#atom-fence-rows');
    }
    const approved = await loadApprovedSet<ApprovedAtom>(engine, { command: 'atom-fence-rows', hash: opts.expect, previewCommand: command,
      emptyHash: async () => previewHash(await hashParts(engine, scope, [])) });
    if (approved.items.some(atom => JSON.stringify(atom.selection) !== JSON.stringify(scope.source_ids))) throw previewChangedError(opts.expect, command);
    const items = approved.items.map(({ selection: _selection, ...atom }, index) => item(atom, opts.expect!, index === approved.items.length - 1));
    return { items: items.filter(entry => afterCursor(entry.cursor, after)), preview_hash: opts.expect, residuals: {} };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const { atom, hash, last } = entry as AtomFenceRowItem;
    try {
      const changed = (reason: string): RepairItemOutcome => ({ applied: false, outcome: 'changed_since_preview', reason });
      if (!sameAtom((await findAtomFenceRows(ctx.engine, [atom.source_id], { atomId: atom.id })).atoms[0], atom)) return changed('the atom, its source page or the rows it carries changed');
      const snapshot = await ctx.engine.readPageSnapshot(atom.slug, { sourceId: atom.source_id });
      if (!snapshot || Number(snapshot.page.id) !== atom.id || snapshot.revision !== atom.revision) return changed('the atom changed');
      const page = { ...snapshot.page, frontmatter: { ...snapshot.page.frontmatter, visibility: 'private' } };
      await submitPageMutation(ctx, { operation: 'put_page', params: { slug: atom.slug, source_id: atom.source_id,
        content: serializePageToMarkdown(page, snapshot.tags), expected_revision: snapshot.revision,
        request_id: await repairRequestId(ctx, 'atom-fence-rows', entry, snapshot.revision) } });
      return { applied: true, outcome: 'narrowed' };
    } catch (error) {
      if (error instanceof OperationError && ['revision_conflict', 'page_not_found', 'page_identity_changed'].includes(error.code)) {
        return { applied: false, outcome: 'changed_since_preview', reason: error.message };
      }
      throw error;
    } finally {
      if (last) await clearApprovedSet(ctx.engine, { command: 'atom-fence-rows', hash });
    }
  },
};
