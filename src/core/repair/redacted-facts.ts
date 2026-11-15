/**
 * `gbrain repair redacted-facts` (#7125): restore the words the prompt
 * sanitizer deleted from stored facts.
 *
 * Before the fix, fact extraction applied the prompt-injection patterns
 * (`think/sanitize.ts`) to the turn before the model call and to every
 * extracted fact afterwards, and the `eval-shell` rule matched the English
 * word "system" before a parenthesis: "Business System (ABS)" was stored as
 * "Business [redacted](ABS)". The fix stops new damage (stored text is never
 * rewritten; `eval-shell` matches only the code-call shape); this kind repairs
 * the facts already stored.
 *
 * Candidates are active facts of the scoped sources whose text holds a
 * redaction marker. Each is classified against the pages it can have come
 * from: the page its context names (the turn's page or transcript), and the
 * page that holds the row (`source_markdown_slug`), each as it reads now and
 * in its retained versions. `restoreNeutralized` (with the pre-fix
 * `eval-shell` shape) proves a restoration from one text when the words
 * around every marker occur there around exactly one span the marker's
 * pattern matches:
 *   - evidenced: every text that proves a restoration proves the same one;
 *     `--apply --expect <hash>` writes it.
 *   - ambiguous: a text holds more than one distinct span around the words,
 *     or texts prove different restorations; listed, never changed.
 *   - unproven: no text proves one (no source page, or the words are gone);
 *     listed, never changed.
 *   - segmented: proved, but the row sits in the facts fence of a page
 *     stored in segments, which this repair does not rewrite; listed with
 *     its restoration, never changed.
 * A row with a row number is a fence row only while its page's `## Facts`
 * fence holds an active row with its text at that number. A conversation-extractor row keeps the
 * row number the extractor gave it on a page with no such row (#8820) and is
 * restored like a database-only row; any other row whose fence row is gone
 * is unproven (`fence_row_missing`), listed with its restoration, never
 * changed.
 * A segmented source page is read as evidence through the segment reader
 * (up to 16 MiB).
 *
 * The apply rewrites only the evidenced facts that are still exactly as
 * previewed. A fenced row (`row_num` on its page) gets its claim rewritten in
 * the page's `## Facts` fence by one revision-bound `put_page` per page, so
 * the canonical projection replaces the row and the page's chunks are
 * re-embedded by its publication. A database-only or conversation-extractor
 * row gets its text rewritten
 * by one database-only maintenance request on a managed brain (one
 * transaction on an unmanaged brain); its vector is then stale by its text
 * hash and `gbrain embed` re-embeds it. Page history keeps the damaged
 * revisions. Nothing runs on upgrade.
 */
import type { BrainEngine } from '../engine.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { parseFactsFence } from '../facts-fence.ts';
import { strikeFenceRow } from '../facts/forget.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { digest } from '../persistence/digest.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { maintenancePreflight, submitDatabaseMaintenanceIntent } from '../persistence/prepared-maintenance.ts';
import { authorizeWrite } from '../persistence/authority.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { submitPageMutation } from '../persistence/page-mutations.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { INJECTION_PATTERNS, LEGACY_EVAL_SHELL, restoreNeutralized } from '../think/sanitize.ts';
import { afterCursor, repairRequestId, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairListing, type RepairPlan, type RepairScope } from './core.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { isSegmentedPage } from '../page-body/page-shape.ts';
import { readBodyRange } from '../page-body/read-range.ts';

export const REDACTED_FACTS_INTENT = 'managed_maintenance_restore_redacted_facts';
const RESTORE_PATTERNS = [...INJECTION_PATTERNS, LEGACY_EVAL_SHELL];
const RESTORED_CONTEXT = 'restored: redacted-facts repair';
/** Retained versions read per source page, newest first. */
const VERSIONS_PER_PAGE = 50;
/** A segmented source body longer than this is not read as evidence. */
const TEXT_MAX_BYTES = 16 * 1024 * 1024;

export type RedactedFactClass = 'evidenced' | 'ambiguous' | 'unproven' | 'segmented';

export interface RedactedFactCandidate {
  id: number;
  source_id: string;
  /** The page the fact lives on (fenced rows) or its entity key (database-only rows). */
  slug: string;
  row_num: number | null;
  /** `fence`: rewritten in its page's Facts fence; `database`: rewritten in place (no row number, or a conversation-extractor row with no fence row). */
  route: 'fence' | 'database';
  class: RedactedFactClass;
  /** `restorable`, `conflicting_sources`, `no_source_page`, `not_in_source`, `segmented_page` or `fence_row_missing`. */
  reason: string;
  /** The stored text, and the restored text when evidenced (or proved on a segmented page). */
  fact: string;
  restored: string | null;
  /** The texts that proved the restoration (`<slug>` or `<slug>@version:<id>`). */
  evidence: string[];
  /** The row's visibility, entity and holding page; the publication rewrites the row only while they are unchanged. */
  visibility: string;
  entity_slug: string | null;
  source_markdown_slug: string | null;
  /** Digest of the row's claim, visibility, entity and fence position, so an edited row is not rewritten. */
  fact_hash: string;
}

export interface RedactedFactsPage { source_id: string; slug: string; scope: string[]; facts: RedactedFactCandidate[] }

interface PageItem extends RepairItem { page: RedactedFactsPage; hash: string; last: boolean }

interface FactRow {
  id: number | string; source_id: string; fact: string; visibility: string; entity_slug: string | null;
  row_num: number | null; source_markdown_slug: string | null; context: string | null; source: string | null;
}

const factHash = (row: FactRow) => digest(['redacted-fact-v1', row.fact, row.visibility, row.entity_slug, row.row_num, row.source_markdown_slug]);
const targetSlug = (row: Pick<FactRow, 'source_markdown_slug' | 'entity_slug'>) => row.source_markdown_slug ?? row.entity_slug ?? 'memory/unattributed';
/** The page a fact's context names: its first cell, when it reads as a slug. */
const contextSlug = (context: string | null) => {
  const first = (context ?? '').split(' | ')[0]!.trim();
  return /^[^\s|]+$/.test(first) ? first : null;
};

interface PageTexts { segmented: boolean; fenceRows: Map<number, string> | null; texts: Array<{ label: string; text: string }> }

/** A segmented body's stored text, read segment by segment; null when it is over TEXT_MAX_BYTES (it proves nothing). */
async function segmentedText(db: BrainEngine, pageId: number): Promise<string | null> {
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  let bytes = 0;
  let text = '';
  for await (const piece of readBodyRange(db, { pageId, space: 'stored', start: 0, end: Infinity, audience: 'trusted' })) {
    bytes += piece.bytes.length;
    if (bytes > TEXT_MAX_BYTES) return null;
    text += decoder.decode(piece.bytes, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * The texts a page offers as evidence: its body as it reads now and its
 * retained versions that hold a body copy. A segmented page's body is read
 * through the segment reader; a segmented version carries no body copy and is
 * not read.
 */
async function pageTexts(db: BrainEngine, sourceId: string, slug: string): Promise<PageTexts> {
  const snapshot = await db.readPageSnapshot(slug, { sourceId }).catch(() => null);
  if (!snapshot) return { segmented: false, fenceRows: new Map(), texts: [] };
  const texts: PageTexts['texts'] = [];
  const segmented = isSegmentedPage(snapshot.page);
  let fenceBody: string | null;
  if (segmented) {
    fenceBody = await segmentedText(db, snapshot.page.id);
    if (fenceBody !== null) texts.push({ label: slug, text: fenceBody });
  } else {
    fenceBody = snapshot.page.compiled_truth ?? '';
    texts.push({ label: slug, text: [snapshot.page.compiled_truth ?? '', snapshot.page.timeline ?? ''].join('\n') });
  }
  const versions = await db.executeRaw<{ id: number | string; compiled_truth: string }>(`SELECT id, compiled_truth FROM page_versions
    WHERE page_id=$1 AND compiled_truth IS NOT NULL ORDER BY id DESC LIMIT ${VERSIONS_PER_PAGE}`, [snapshot.page.id]);
  for (const v of versions) texts.push({ label: `${slug}@version:${v.id}`, text: v.compiled_truth });
  const fenceRows = fenceBody === null ? null : new Map(parseFactsFence(fenceBody).facts.filter(row => row.active).map(row => [row.rowNum, row.claim.trim()]));
  return { segmented, fenceRows, texts };
}

/** Read-only: every active fact of these sources whose text holds a redaction marker, classified, in (source, page, id) order. */
export async function classifyRedactedFacts(db: BrainEngine, sourceIds: string[], opts: { ids?: number[] } = {}): Promise<RedactedFactCandidate[]> {
  const rows = await db.executeRaw<FactRow>(`
    SELECT f.id, f.source_id, f.fact, f.visibility, f.entity_slug, f.row_num, f.source_markdown_slug, f.context, f.source
      FROM facts f
     WHERE f.source_id=ANY($1::text[]) AND f.expired_at IS NULL AND f.superseded_by IS NULL
       AND f.fact LIKE '%[redacted%' AND ($2::bigint[] IS NULL OR f.id=ANY($2::bigint[]))
     ORDER BY f.source_id, f.id`, [sourceIds, opts.ids ?? null]);
  const pages = new Map<string, PageTexts>();
  const sourceTexts = async (sourceId: string, slug: string) => {
    const key = `${sourceId}\u0000${slug}`;
    if (!pages.has(key)) pages.set(key, await pageTexts(db, sourceId, slug));
    return pages.get(key)!;
  };
  const candidates: RedactedFactCandidate[] = [];
  for (const row of rows) {
    const slugs = [...new Set([contextSlug(row.context), row.source_markdown_slug].filter((s): s is string => !!s))];
    const proofs = new Map<string, string[]>();
    let read = 0;
    let conflicting = false;
    for (const slug of slugs) {
      for (const { label, text } of (await sourceTexts(row.source_id, slug)).texts) {
        read++;
        const result = restoreNeutralized(row.fact, text, RESTORE_PATTERNS);
        if (result.ambiguous) conflicting = true;
        else if (result.restored && !result.unresolved) proofs.set(result.text, [...(proofs.get(result.text) ?? []), label]);
      }
    }
    const proved = !conflicting && proofs.size === 1;
    const holder = row.row_num !== null && row.source_markdown_slug !== null ? await sourceTexts(row.source_id, row.source_markdown_slug) : null;
    const extractor = (row.source ?? '').startsWith('cli:extract-conversation-facts');
    const inFence = !!holder && (holder.fenceRows === null || holder.fenceRows.get(Number(row.row_num)) === row.fact.trim() || holder.segmented && !extractor);
    const route = row.row_num === null || !inFence && extractor ? 'database' : 'fence';
    const fenceGone = route === 'fence' && !inFence;
    const [klass, reason]: [RedactedFactClass, string] = conflicting || proofs.size > 1 ? ['ambiguous', 'conflicting_sources']
      : proved && holder?.segmented && route === 'fence' ? ['segmented', 'segmented_page'] : proved && fenceGone ? ['unproven', 'fence_row_missing']
        : proved ? ['evidenced', 'restorable'] : ['unproven', read ? 'not_in_source' : 'no_source_page'];
    const [restored, evidence] = proved ? [...proofs][0]! : [null, [...proofs.values()].flat()];
    candidates.push({ id: Number(row.id), source_id: row.source_id, slug: targetSlug(row), row_num: row.row_num === null ? null : Number(row.row_num), route,
      class: klass, reason, fact: row.fact, restored, evidence, visibility: row.visibility, entity_slug: row.entity_slug,
      source_markdown_slug: row.source_markdown_slug, fact_hash: factHash(row) });
  }
  candidates.sort((a, b) => a.source_id.localeCompare(b.source_id) || a.slug.localeCompare(b.slug) || a.id - b.id);
  return candidates;
}

const DETAILS: Record<string, string> = {
  conflicting_sources: 'its source texts hold different spans around the same words, so nothing proves one restoration; left unchanged',
  no_source_page: 'no page it came from exists any more, so nothing can prove the original words; left unchanged',
  not_in_source: 'the words around the marker are not in any page it came from, so nothing proves the original words; left unchanged',
  segmented_page: 'its row sits in the facts fence of a page stored in segments, and this repair rewrites a fence by publishing the whole body; left unchanged',
  fence_row_missing: 'its row number names no active row with its text in its page\'s Facts fence, so neither the fence nor the row can be rewritten safely; left unchanged',
};

function previewCommand(scope: RepairScope, all: string[]): string {
  return `gbrain repair redacted-facts${scope.source_ids.length === 1 && all.length > 1 ? ` --source ${scope.source_ids[0]}` : ''}`;
}

async function activeSources(engine: BrainEngine): Promise<string[]> {
  return (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id')).map(row => row.id);
}

async function hashParts(engine: BrainEngine, scope: RepairScope, facts: RedactedFactCandidate[]) {
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id FROM persistence_brain WHERE singleton=1').catch(() => []);
  return ['redacted-facts-v1', brain?.brain_id ?? 'host', scope.source_ids, facts.map(f => [f.id, f.class, f.reason, f.fact_hash, f.restored, f.route])];
}

function pageItem(page: RedactedFactsPage, hash: string, index: number, last: boolean): PageItem {
  return { cursor: { phase: 0, id: index }, source_id: page.source_id, slug: page.slug, chars: 0,
    action: `restore the text of ${page.facts.length} fact(s)`, page, hash, last };
}

export const redactedFactsRepair: RepairHandler = {
  kind: 'redacted-facts',
  embeds: false,
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    const command = previewCommand(scope, await activeSources(engine));
    if (!opts?.apply) {
      const candidates = await classifyRedactedFacts(engine, scope.source_ids);
      const hash = previewHash(await hashParts(engine, scope, candidates));
      const pages = new Map<string, RedactedFactsPage>();
      for (const fact of candidates.filter(c => c.class === 'evidenced')) {
        const key = `${fact.source_id}\u0000${fact.slug}`;
        const page = pages.get(key) ?? { source_id: fact.source_id, slug: fact.slug, scope: scope.source_ids, facts: [] };
        page.facts.push(fact);
        pages.set(key, page);
      }
      const approved = [...pages.values()];
      if (approved.length) await saveApprovedSet(engine, { command: 'redacted-facts', hash }, approved);
      const count = (klass: RedactedFactClass) => candidates.filter(c => c.class === klass).length;
      const listing: RepairListing[] = candidates.map(c => ({ item: `${c.source_id}:${c.slug}#${c.id}`, class: c.class,
        detail: c.class === 'evidenced' ? `"${c.fact}" -> "${c.restored}" (proved by ${c.evidence.join(', ')})`
          : c.restored ? `"${c.fact}" -> "${c.restored}" (proved by ${c.evidence.join(', ')}): ${DETAILS[c.reason]}` : `"${c.fact}": ${DETAILS[c.reason]}` }));
      return { items: approved.map((page, i) => pageItem(page, hash, i, i === approved.length - 1)), preview_hash: hash, listing,
        residuals: { evidenced: count('evidenced'), ambiguous: count('ambiguous'), unproven: count('unproven'), segmented: count('segmented') } };
    }
    if (!opts.expect) {
      throw new OperationError('invalid_params', 'gbrain repair redacted-facts --apply restores only the set a preview printed.',
        `Preview first: ${command} — then run the apply command it prints: ${command} --apply --expect <preview-hash>`,
        'docs/guides/repair.md#redacted-facts');
    }
    const approved = await loadApprovedSet<RedactedFactsPage>(engine, { command: 'redacted-facts', hash: opts.expect, previewCommand: command,
      emptyHash: async () => previewHash(await hashParts(engine, scope, [])) });
    if (approved.items.some(page => JSON.stringify(page.scope) !== JSON.stringify(scope.source_ids))) throw previewChangedError(opts.expect, command);
    const items = approved.items.map((page, i) => pageItem(page, opts.expect!, i, i === approved.items.length - 1))
      .filter(item => afterCursor(item.cursor, after));
    if (!items.length) await clearApprovedSet(engine, { command: 'redacted-facts', hash: opts.expect });
    return { items, preview_hash: opts.expect, residuals: { approved_pages: approved.items.length, pending_pages: items.length } };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const { page, hash, last } = entry as PageItem;
    const engine = ctx.engine;
    // Recheck each approved fact against its live row: still evidenced, same text, row and restoration.
    const live = new Map((await classifyRedactedFacts(engine, [page.source_id], { ids: page.facts.map(f => f.id) })).map(c => [c.id, c]));
    const unchanged = page.facts.filter(f => {
      const current = live.get(f.id);
      return !!current && (['class', 'fact_hash', 'slug', 'row_num', 'route', 'restored'] as const).every(field => current[field] === f[field]);
    });
    const restored: number[] = [];
    const dbOnly = unchanged.filter(f => f.route === 'database');
    if (dbOnly.length) restored.push(...await restoreDatabaseRows(engine, page, hash, dbOnly));
    const fenced = unchanged.filter(f => f.route === 'fence');
    if (fenced.length) restored.push(...await restoreFencedRows(ctx, entry, page, fenced));
    if (last) await clearApprovedSet(engine, { command: 'redacted-facts', hash });
    const changed = page.facts.filter(f => !restored.includes(f.id)).map(f => f.id);
    return { applied: restored.length > 0, outcome: !changed.length ? 'restored' : restored.length ? 'partially_restored' : 'changed_since_preview',
      ...(changed.length ? { reason: `${restored.length} of ${page.facts.length} restored; changed since the preview: ${changed.join(', ')}` } : {}) };
  },
};

/** One approved in-place rewrite: the row as previewed (text, visibility, entity, holding page, row number) and its restored text. */
export interface Restore { id: number; from: string; to: string; visibility: string; entity_slug: string | null; source_markdown_slug: string | null; row_num?: number | null }

/**
 * Rewrites each row still exactly as previewed. The compare runs in the
 * UPDATE itself, which locks the row and rechecks it after any concurrent
 * write, so a row changed after the apply's own recheck is left alone and not
 * reported restored.
 */
export const restoreRedactedRows = (tx: BrainEngine, sourceId: string, restores: Restore[]) => tx.executeRaw<{ id: number | string }>(`UPDATE facts f
    SET fact=r.to_text, context=concat_ws(' | ', NULLIF(f.context,''), $3::text)
   FROM jsonb_to_recordset($2::text::jsonb) AS r(id bigint, from_text text, to_text text, visibility text, entity_slug text, source_markdown_slug text, row_num int)
  WHERE f.source_id=$1 AND f.id=r.id AND f.fact=r.from_text AND f.visibility=r.visibility AND f.entity_slug IS NOT DISTINCT FROM r.entity_slug
    AND f.source_markdown_slug IS NOT DISTINCT FROM r.source_markdown_slug AND f.expired_at IS NULL AND f.superseded_by IS NULL
    AND f.row_num IS NOT DISTINCT FROM r.row_num AND (r.row_num IS NULL OR f.source LIKE 'cli:extract-conversation-facts%')
  RETURNING f.id`,
[sourceId, JSON.stringify(restores.map(r => ({ id: r.id, from_text: r.from, to_text: r.to, visibility: r.visibility, entity_slug: r.entity_slug,
  source_markdown_slug: r.source_markdown_slug, row_num: r.row_num ?? null }))), RESTORED_CONTEXT]);

/**
 * Database-only and conversation-extractor rows: on a managed brain one database-only maintenance
 * request on the page key (owner-checked, with a publication receipt); on an
 * unmanaged brain one transaction.
 */
async function restoreDatabaseRows(engine: BrainEngine, page: RedactedFactsPage, hash: string, facts: RedactedFactCandidate[]): Promise<number[]> {
  const restores: Restore[] = facts.map(f => ({ id: f.id, from: f.fact, to: f.restored!, visibility: f.visibility, entity_slug: f.entity_slug,
    source_markdown_slug: f.source_markdown_slug, row_num: f.row_num }));
  if (!await managedPersistenceEnabled(engine)) {
    return (await maintenanceTransaction(engine, tx => restoreRedactedRows(tx, page.source_id, restores))).map(row => Number(row.id));
  }
  const authority = (await maintenancePreflight(engine, page.source_id))!;
  const snapshot = await engine.readPageSnapshot(page.slug, { sourceId: page.source_id });
  const h = digest(['redacted-facts-restore-v1', hash, page.source_id, page.slug, restores, snapshot?.revision ?? null]);
  const receipt = await submitDatabaseMaintenanceIntent(engine, authority, page.slug,
    { kind: REDACTED_FACTS_INTENT, expected_revision: snapshot?.revision ?? null, restores },
    `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`);
  return (receipt.restored as number[] | undefined) ?? [];
}

/** Preparer for `managed_maintenance_restore_redacted_facts`: rewrites the named database-only and conversation-extractor rows still holding their previewed text. */
export async function prepareRedactedFactsRestore(engine: BrainEngine, row: WriteRequest): Promise<PreparedMutation> {
  const restores = (row.intent as { restores?: unknown } | null)?.restores;
  const text = (v: unknown) => typeof v === 'string';
  const valid = Array.isArray(restores) && restores.every(r => !!r && typeof r === 'object' && Number.isSafeInteger((r as Restore).id)
    && text((r as Restore).from) && text((r as Restore).to) && text((r as Restore).visibility)
    && ((r as Restore).entity_slug === null || text((r as Restore).entity_slug)) && ((r as Restore).source_markdown_slug === null || text((r as Restore).source_markdown_slug))
    && ((r as Restore).row_num == null || Number.isSafeInteger((r as Restore).row_num)));
  if (!valid) {
    throw opError('invalid_params', 'The redacted facts restore intent does not name its facts.',
      `Request ${row.request_id} in source ${row.source_id} does not name the facts to restore, so nothing changed. Preview the repair again and apply the new preview after the user approves.`,
      { fix: readFix('Previews the redacted-facts repair without changing anything.', { argv: ['gbrain', 'repair', 'redacted-facts', '--source', row.source_id, '--json'] }) });
  }
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
  await authorizeWrite(engine, row.authority, 'submit_job', row.slug);
  return { observedRevision: snapshot?.revision ?? null, noop: true,
    validate: async tx => { await authorizeWrite(tx, row.authority, 'submit_job', row.slug); },
    apply: async tx => ({ status: 'completed', restored: (await restoreRedactedRows(tx, row.source_id, restores as Restore[])).map(r => Number(r.id)) }) };
}

/**
 * Fenced rows: rewrite each still-matching active fence row's claim and
 * publish the page once, bound to the revision read; the canonical projection
 * replaces the row. Returns the facts whose fence rows were rewritten and
 * now project the restored text.
 */
async function restoreFencedRows(ctx: Parameters<RepairHandler['apply']>[0], item: RepairItem, page: RedactedFactsPage, facts: RedactedFactCandidate[]): Promise<number[]> {
  const engine = ctx.engine;
  const snapshot = await engine.readPageSnapshot(page.slug, { sourceId: page.source_id });
  if (!snapshot || isSegmentedPage(snapshot.page)) return [];
  let body = snapshot.page.compiled_truth ?? '';
  const rewritten: RedactedFactCandidate[] = [];
  for (const fact of facts) {
    const fenceRow = parseFactsFence(body).facts.find(f => f.rowNum === fact.row_num);
    if (!fenceRow?.active || fenceRow.claim.trim() !== fact.fact.trim()) continue;
    const next = strikeFenceRow(body, fact.row_num!, row => ({ ...row, claim: fact.restored! }));
    if (next === null) continue;
    body = next;
    rewritten.push(fact);
  }
  if (!rewritten.length) return [];
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug: page.slug, source_id: page.source_id,
    content: serializePageToMarkdown({ ...snapshot.page, compiled_truth: body }, snapshot.tags), expected_revision: snapshot.revision,
    request_id: await repairRequestId(ctx, 'redacted-facts', item, snapshot.revision) } });
  const projected = new Set((await engine.executeRaw<{ row_num: number }>(`SELECT row_num FROM facts
    WHERE source_id=$1 AND source_markdown_slug=$2 AND expired_at IS NULL AND row_num=ANY($3::int[]) AND fact=ANY($4::text[])`,
  [page.source_id, page.slug, rewritten.map(f => f.row_num), rewritten.map(f => f.restored)])).map(r => Number(r.row_num)));
  return rewritten.filter(f => projected.has(f.row_num!)).map(f => f.id);
}
