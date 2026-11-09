/**
 * `gbrain repair unwithdrawn-facts` (#8819): restore fact rows a facts-fence generation retired although no fence of
 * their page ever held them.
 *
 * Before the fix, the page publication's projection and the extract_facts reconcile retired every fact row attached to a
 * page with a row number that the incoming fence did not hold. A put_page row (or one an older writer stamped) that was
 * never in the fence was expired by a write that changed nothing in it, often the page's first fact generation, which
 * has no predecessor for `repair generations --kind fact_fence` to restore. The ledger kept each retired row's
 * before-state, which is what this kind restores.
 *
 * Candidates: a `retired` item with a fact preimage in a fact_fence generation, whose fact is still exactly as the
 * retirement left it: expired at that generation's instant, row number cleared, same claim and visibility, not
 * superseded, and not a conversation-extractor row (`repair extractor-facts` owns those). Each is classified:
 *   - excluded (listed, never restored): the page is missing or deleted; the fact was superseded or withdrawn
 *     (`fact_withdrawals`, for its entity, every subject or the owned memory page it sits on); a fence held it (a
 *     fact_fence generation recorded it, or the page or a stored version of it carries it at the same row number, claim
 *     and visibility: a genuine withdrawal); the page's fence states the claim; an active, still valid fact with the
 *     same text, entity and a compatible speaker (facts/attribution.ts) is on the page, at any visibility; another
 *     candidate with the same text, entity and a compatible speaker, at the same or a narrower visibility, is restored
 *     instead; or
 *     the brain is unmanaged, whose extract_facts reconcile retires a row its fence lacks as drift and would retire a
 *     restored row again.
 *   - ambiguous (restored only with `--include-ambiguous` and that preview's hash): the page's version history has a
 *     gap (pruned, or an import that consumed several commits) or was not read whole, so an earlier fence holding the
 *     row cannot be ruled out.
 *   - evidenced: everything else.
 *
 * The preview binds each page's revision. The apply restores exactly the approved set under the page key: a managed
 * brain publishes one database-only `managed_maintenance_restore_unwithdrawn_facts` request per page bound to the
 * previewed revision; on an unmanaged (or repo-less) brain, where nothing is restorable, an approved set from a preview
 * taken while it was managed is reclassified in one page-locked maintenance transaction after the revision check. A changed page refuses whole (`changed_since_preview`); each fact is reclassified and restored only when
 * its class and evidence are unchanged. A restored fact keeps its id and gets back its recorded lifecycle (`expired_at`,
 * `valid_until`, `superseded_by`, consolidation marks) and its row number, or a fresh number above the page's rows
 * when a fence row took it. No page is rewritten; the fix keeps restored rows active on later writes.
 */
import type { BrainEngine } from '../engine.ts';
import type { PreparedMutation } from '../persistence/coordinator.ts';
import type { WriteRequest } from '../persistence/model.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { digest } from '../persistence/digest.ts';
import { authorizeWrite } from '../persistence/authority.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { maintenancePreflight, submitDatabaseMaintenanceIntent } from '../persistence/prepared-maintenance.ts';
import { clearApprovedSet, loadApprovedSet, previewChangedError, previewHash, saveApprovedSet } from '../persistence/preview-approval.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { FACT_FENCE_KIND } from '../generations/fence.ts';
import { factsFenceHeld, pageFenceRowKeys } from '../generations/fence-evidence.ts';
import { withdrawalCoversFactSql } from '../access/member-facts.ts';
import { attributionCompatible } from '../facts/attribution.ts';
import type { FactAttribution } from '../engine.ts';
import type { FactPreimage } from '../generations/adapters/fact-rows.ts';
import { afterCursor, type RepairHandler, type RepairItem, type RepairItemOutcome, type RepairListing, type RepairPlan, type RepairScope } from './core.ts';

export const UNWITHDRAWN_FACTS_INTENT = 'managed_maintenance_restore_unwithdrawn_facts';
const previewFix = (sourceId: string) => readFix('Previews the unwithdrawn-facts repair without changing anything.',
  { argv: ['gbrain', 'repair', 'unwithdrawn-facts', '--source', sourceId, '--json'] });

export type UnwithdrawnFactClass = 'evidenced' | 'ambiguous' | 'excluded';

const INSTANT = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** One candidate as the preview showed it; the apply rechecks every field. */
export interface UnwithdrawnFactCandidate {
  id: number;
  source_id: string;
  slug: string;
  class: UnwithdrawnFactClass;
  reason: string;
  /** The fact_fence generation that retired it, and that generation's instant (UTC, microseconds). */
  generation_id: number;
  generation: number;
  retired_at: string;
  /** Digest of the claim, visibility and entity, so an edited row is not restored. */
  fact_hash: string;
  /** The before-state the ledger recorded, restored as it is. */
  preimage: FactPreimage;
}

/** One approved page: its revision at preview, its restorable facts and the request id its managed restore uses. */
export interface UnwithdrawnFactsPage {
  source_id: string;
  slug: string;
  page_id: number;
  revision: string;
  request_id: string;
  include_ambiguous: boolean;
  scope: string[];
  facts: UnwithdrawnFactCandidate[];
}

interface PageItem extends RepairItem { page: UnwithdrawnFactsPage; hash: string; last: boolean }

interface CandidateRow {
  id: number | string; source_id: string; slug: string; fact: string; visibility: string; entity_slug: string | null; attributed_to: FactAttribution | null; superseded: boolean;
  generation_id: number | string; generation: number | string; retired_at: string; expired_at: string; preimage: FactPreimage;
  page_id: number | string | null; page_deleted: boolean | null; history_gap: boolean | null; withdrawn: boolean; active_duplicate: boolean; fingerprint: string;
}

/** Every candidate of these sources (or of one page), classified, in (source, page, id) order. Read-only. */
export async function classifyUnwithdrawnFacts(db: BrainEngine, sourceIds: string[], opts: { slug?: string } = {}): Promise<UnwithdrawnFactCandidate[]> {
  const rows = await db.executeRaw<CandidateRow>(`
    WITH retired AS (
      SELECT DISTINCT ON ((i.preimage->>'id')::bigint) (i.preimage->>'id')::bigint AS fact_id, g.id AS generation_id, g.generation, g.source_id,
             substr(g.owner_key, 6) AS slug, ${INSTANT('g.created_at')} AS retired_at, i.preimage
        FROM derived_generation_items i JOIN derived_generations g ON g.id = i.generation_id
       WHERE g.kind = $3 AND g.source_id = ANY($1::text[]) AND g.state <> 'held' AND i.action = 'retired' AND left(g.owner_key, 5) = 'page:'
         AND jsonb_typeof(i.preimage) = 'object' AND i.preimage ? 'id' AND i.preimage->>'expired_at' IS NULL AND i.preimage->>'row_num' IS NOT NULL
         AND ($2::text IS NULL OR g.owner_key = 'page:' || $2::text)
       ORDER BY (i.preimage->>'id')::bigint, g.id DESC
    )
    SELECT f.id, r.source_id, r.slug, f.fact, f.visibility, f.entity_slug, f.attributed_to, f.superseded_by IS NOT NULL AS superseded, r.generation_id, r.generation,
           r.retired_at, ${INSTANT('f.expired_at')} AS expired_at, r.preimage, gbrain_fact_fingerprint(f.fact) AS fingerprint,
           p.id AS page_id, p.deleted_at IS NOT NULL AS page_deleted, p.version_history_gap_at IS NOT NULL AS history_gap,
           EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id = f.source_id AND w.visibility = f.visibility
             AND w.fact_hash IN (gbrain_fact_fingerprint(f.fact), gbrain_fact_fingerprint_v1(f.fact))
             AND ${withdrawalCoversFactSql('w', 'f')}) AS withdrawn,
           EXISTS (SELECT 1 FROM facts a WHERE a.source_id = f.source_id AND a.source_markdown_slug = r.slug
             AND a.expired_at IS NULL AND (a.valid_until IS NULL OR a.valid_until > now())
             AND gbrain_fact_fingerprint(a.fact) = gbrain_fact_fingerprint(f.fact) AND a.entity_slug IS NOT DISTINCT FROM f.entity_slug
             AND (a.attributed_to IS NULL OR f.attributed_to IS NULL OR a.attributed_to = f.attributed_to)) AS active_duplicate
      FROM retired r
      JOIN facts f ON f.id = r.fact_id AND f.source_id = r.source_id
      LEFT JOIN pages p ON p.source_id = r.source_id AND p.slug = r.slug
     WHERE f.expired_at IS NOT NULL AND f.row_num IS NULL AND f.fact = r.preimage->>'fact' AND f.visibility = r.preimage->>'visibility'
       AND COALESCE(f.source, '') NOT LIKE 'cli:extract-conversation-facts%'
     ORDER BY r.source_id, r.slug, f.id`, [sourceIds, opts.slug ?? null, FACT_FENCE_KIND]);
  // A fence that held the row (a generation, the page, a stored version) means the row was withdrawn by an edit of it.
  const evidence = new Map<string, { held: Set<number>; complete: boolean; claims: Set<string> }>();
  for (const row of rows) {
    const key = `${row.source_id}\u0000${row.slug}`;
    if (evidence.has(key) || row.page_id === null) continue;
    const page = rows.filter(other => other.source_id === row.source_id && other.slug === row.slug);
    const [current] = await db.executeRaw<{ id: number; compiled_truth: string | null; timeline: string | null; body_storage: string | null }>(
      `SELECT id, CASE WHEN body_storage = 'segmented' THEN NULL ELSE compiled_truth END AS compiled_truth,
        CASE WHEN body_storage = 'segmented' THEN NULL ELSE timeline END AS timeline, body_storage FROM pages WHERE id = $1`, [row.page_id]);
    const prior = current ? await pageFenceRowKeys(db, current, row.slug, row.source_id) : null;
    const held = await factsFenceHeld(db, { sourceId: row.source_id, slug: row.slug, prior,
      rows: page.map(other => ({ id: Number(other.id), row_num: Number(other.preimage.row_num), fact: other.preimage.fact, visibility: other.preimage.visibility })) });
    evidence.set(key, { ...held, claims: new Set([...(prior ?? [])].map(rowKey => rowKey.split('\u0000')[1]!)) });
  }
  const managed = await managedPersistenceEnabled(db);
  const base = rows.map(row => classify(row, evidence.get(`${row.source_id}\u0000${row.slug}`), managed));
  // One copy of a claim comes back per page, entity and speaker, the narrowest visibility first, then a still valid copy
  // before one whose validity had lapsed, so no wider copy returns beside it; copies from different known speakers are
  // not duplicates (facts/attribution.ts), so each comes back.
  const key = (row: CandidateRow) => JSON.stringify([row.source_id, row.slug, row.entity_slug, row.fingerprint]);
  const lapsed = (i: number) => rows[i]!.preimage.valid_until != null && Date.parse(rows[i]!.preimage.valid_until!) <= Date.now();
  const rank = (i: number) => (rows[i]!.visibility === 'world' ? 4 : 0) + (lapsed(i) ? 2 : 0) + (base[i]![0] === 'evidenced' ? 0 : 1);
  const chosen = new Map<string, number[]>();
  const order = rows.map((_, i) => i).filter(i => base[i]![0] !== 'excluded').sort((a, b) => rank(a) - rank(b) || a - b);
  const restored = new Set<number>();
  for (const i of order) {
    const group = chosen.get(key(rows[i]!)) ?? [];
    if (group.some(j => attributionCompatible(rows[j]!.attributed_to, rows[i]!.attributed_to))) continue;
    chosen.set(key(rows[i]!), [...group, i]);
    restored.add(i);
  }
  return rows.map((row, i) => {
    const duplicate = base[i]![0] !== 'excluded' && !restored.has(i);
    const [klass, reason] = duplicate ? ['excluded' as const, 'duplicate_candidate'] : base[i]!;
    return { id: Number(row.id), source_id: row.source_id, slug: row.slug, class: klass, reason, generation_id: Number(row.generation_id),
      generation: Number(row.generation), retired_at: row.retired_at, fact_hash: digest([row.fact, row.visibility, row.entity_slug]), preimage: row.preimage };
  });
}

function classify(row: CandidateRow, evidence: { held: Set<number>; complete: boolean; claims: Set<string> } | undefined, managed: boolean): [UnwithdrawnFactClass, string] {
  if (row.page_id === null || row.page_deleted || !evidence) return ['excluded', 'page_missing'];
  if (row.superseded) return ['excluded', 'superseded'];
  if (row.withdrawn) return ['excluded', 'withdrawn'];
  if (row.expired_at !== row.retired_at) return ['excluded', 'changed_since_retirement'];
  if (evidence.held.has(Number(row.id))) return ['excluded', 'fence_held'];
  if (evidence.claims.has(row.fact)) return ['excluded', 'fence_states_claim'];
  if (row.active_duplicate) return ['excluded', 'active_duplicate'];
  if (!managed) return ['excluded', 'unmanaged_reconcile'];
  if (row.history_gap) return ['ambiguous', 'version_history_gap'];
  if (!evidence.complete) return ['ambiguous', 'version_history_unread'];
  return ['evidenced', 'never_in_fence'];
}

const DETAILS: Record<string, string> = {
  page_missing: 'its page is missing or deleted',
  superseded: 'a newer fact superseded it',
  withdrawn: 'its claim was withdrawn (forget)',
  changed_since_retirement: 'it changed after the generation retired it',
  fence_held: 'a fence of the page held it, so an edit of the fence withdrew it',
  fence_states_claim: "the page's fence states this claim, so its next write would retire a restored copy again",
  active_duplicate: 'an active fact with the same text, entity and speaker is already on the page',
  duplicate_candidate: 'another candidate of the page with the same text, entity and speaker is restored instead',
  unmanaged_reconcile: "this brain is unmanaged: its extract_facts reconcile treats a numbered row the page's fence lacks as drift and would retire a restored row again",
  version_history_gap: "the page's version history has a gap, so an earlier fence holding it cannot be ruled out",
  version_history_unread: "the page has more stored versions than one preview reads, so an earlier fence holding it cannot be ruled out",
};

function detail(fact: UnwithdrawnFactCandidate): string {
  if (fact.class !== 'evidenced') return DETAILS[fact.reason] ?? fact.reason;
  return `retired at ${fact.retired_at} by facts-fence generation ${fact.generation} of the page; no fence of the page ever held it`;
}

async function previewCommand(engine: BrainEngine, scope: RepairScope, includeAmbiguous: boolean): Promise<string> {
  const [{ n }] = await engine.executeRaw<{ n: number | string }>('SELECT count(*)::int AS n FROM sources WHERE archived IS NOT TRUE');
  const narrowed = scope.source_ids.length === 1 && Number(n) > 1;
  return `gbrain repair unwithdrawn-facts${narrowed ? ` --source ${scope.source_ids[0]}` : ''}${includeAmbiguous ? ' --include-ambiguous' : ''}`;
}

function requestIdFor(hash: string, page: Pick<UnwithdrawnFactsPage, 'source_id' | 'slug'>): string {
  const h = digest(['unwithdrawn-facts-request-v1', hash, page.source_id, page.slug]);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

async function hashParts(engine: BrainEngine, scope: RepairScope, includeAmbiguous: boolean, facts: UnwithdrawnFactCandidate[], revisions: Record<string, string>) {
  const sources = await engine.executeRaw<{ id: string; incarnation: string }>(
    'SELECT id, incarnation::text AS incarnation FROM sources WHERE id=ANY($1::text[]) ORDER BY id', [scope.source_ids]);
  return { kind: 'unwithdrawn-facts-v1', brain_id: scope.brain_id, sources, selection: { source_ids: scope.source_ids, include_ambiguous: includeAmbiguous },
    facts: facts.map(({ preimage: _preimage, ...fact }) => fact), revisions };
}

function pageItem(page: UnwithdrawnFactsPage, hash: string, index: number, last: boolean): PageItem {
  return { cursor: { phase: 0, id: index + 1 }, source_id: page.source_id, slug: page.slug, chars: 0,
    action: `restore ${page.facts.length} fact(s) no fence withdrew`, page, hash, last };
}

export const unwithdrawnFactsRepair: RepairHandler = {
  kind: 'unwithdrawn-facts',
  embeds: false,
  async plan(engine, scope, after, opts): Promise<RepairPlan> {
    const includeAmbiguous = opts?.includeAmbiguous === true;
    if (!opts?.apply) {
      const facts = await classifyUnwithdrawnFacts(engine, scope.source_ids);
      const snapshots = new Map<string, { id: number; revision: string }>();
      for (const fact of facts) {
        const key = `${fact.source_id}\u0000${fact.slug}`;
        if (fact.class === 'excluded' || snapshots.has(key)) continue;
        const snapshot = await engine.readPageSnapshot(fact.slug, { sourceId: fact.source_id });
        if (snapshot) snapshots.set(key, { id: snapshot.page.id, revision: snapshot.revision });
      }
      const revisions = Object.fromEntries([...snapshots].map(([key, value]) => [key, value.revision]));
      const hash = previewHash(await hashParts(engine, scope, includeAmbiguous, facts, revisions));
      const pages = new Map<string, UnwithdrawnFactsPage>();
      for (const fact of facts) {
        if (fact.class === 'excluded' || fact.class === 'ambiguous' && !includeAmbiguous) continue;
        const key = `${fact.source_id}\u0000${fact.slug}`;
        const snapshot = snapshots.get(key);
        if (!snapshot) continue;
        const page = pages.get(key) ?? { source_id: fact.source_id, slug: fact.slug, page_id: snapshot.id, revision: snapshot.revision,
          request_id: requestIdFor(hash, fact), include_ambiguous: includeAmbiguous, scope: scope.source_ids, facts: [] };
        page.facts.push(fact);
        pages.set(key, page);
      }
      const approved = [...pages.values()];
      if (approved.length) await saveApprovedSet(engine, { command: 'unwithdrawn-facts', hash }, approved);
      const count = (klass: UnwithdrawnFactClass) => facts.filter(f => f.class === klass).length;
      const listing: RepairListing[] = facts.map(fact => ({ item: `${fact.source_id}:${fact.slug}#${fact.id}`,
        class: fact.class === 'excluded' ? `excluded:${fact.reason}` : fact.class, detail: detail(fact) }));
      return { items: approved.map((page, index) => pageItem(page, hash, index, index === approved.length - 1)), preview_hash: hash,
        residuals: { evidenced: count('evidenced'), ambiguous: count('ambiguous'), excluded: count('excluded') }, listing };
    }
    const command = await previewCommand(engine, scope, includeAmbiguous);
    if (!opts.expect) {
      throw new OperationError('invalid_params', 'gbrain repair unwithdrawn-facts --apply restores only the set a preview printed.',
        `Preview first: ${command} — then run the apply command it prints: ${command} --apply --expect <preview-hash>`,
        'docs/guides/repair.md#explicit-only-repair-kinds');
    }
    const approved = await loadApprovedSet<UnwithdrawnFactsPage>(engine, { command: 'unwithdrawn-facts', hash: opts.expect, previewCommand: command,
      emptyHash: async () => previewHash(await hashParts(engine, scope, includeAmbiguous, [], {})) });
    const scopeKey = JSON.stringify(scope.source_ids);
    if (approved.items.some(page => page.include_ambiguous !== includeAmbiguous || JSON.stringify(page.scope) !== scopeKey)) throw previewChangedError(opts.expect, command);
    const items = approved.items.map((page, index) => pageItem(page, opts.expect!, index, index === approved.items.length - 1))
      .filter(item => afterCursor(item.cursor, after));
    if (!items.length) await clearApprovedSet(engine, { command: 'unwithdrawn-facts', hash: opts.expect });
    return { items, preview_hash: opts.expect, residuals: { already_passed_pages: approved.items.length - items.length } };
  },
  async apply(ctx, entry): Promise<RepairItemOutcome> {
    const { page, hash, last } = entry as PageItem;
    const result = await managedPersistenceEnabled(ctx.engine)
      ? await restoreManaged(ctx.engine, page, hash)
      : await maintenanceTransaction(ctx.engine, async tx => {
        await tx.lockPageKeys([{ sourceId: page.source_id, slug: page.slug }]);
        const snapshot = await tx.readPageSnapshot(page.slug, { sourceId: page.source_id });
        if (!snapshot || snapshot.page.id !== page.page_id || snapshot.revision !== page.revision) return { restored: [], changed: page.facts.map(f => f.id) };
        return restorePageFacts(tx, page);
      });
    if (last) await clearApprovedSet(ctx.engine, { command: 'unwithdrawn-facts', hash });
    const changed = page.facts.length - result.restored.length;
    return { applied: result.restored.length > 0, outcome: !changed ? 'restored' : result.restored.length ? 'partially_restored' : 'changed_since_preview',
      ...(changed ? { reason: `${result.restored.length} of ${page.facts.length} restored; changed since the preview: ${result.changed.join(', ')}` } : {}) };
  },
};

interface RestoreResult { restored: number[]; changed: number[] }

async function restoreManaged(engine: BrainEngine, page: UnwithdrawnFactsPage, hash: string): Promise<RestoreResult> {
  const unchanged: RestoreResult = { restored: [], changed: page.facts.map(f => f.id) };
  const authority = (await maintenancePreflight(engine, page.source_id))!;
  try {
    const receipt = await submitDatabaseMaintenanceIntent(engine, authority, page.slug,
      { kind: UNWITHDRAWN_FACTS_INTENT, expected_revision: page.revision, preview_hash: hash, page }, page.request_id);
    return { restored: (receipt.restored as number[] | undefined) ?? [], changed: (receipt.changed_since_preview as number[] | undefined) ?? [] };
  } catch (error) {
    if (error instanceof OperationError && ['revision_conflict', 'page_not_found', 'page_identity_changed'].includes(error.code)) return unchanged;
    throw error;
  }
}

/**
 * Restores the page's approved facts that are still exactly as previewed, under the page key, inside the managed
 * publication or the unmanaged transaction: each keeps its id and gets its recorded lifecycle back, at its recorded row
 * number when that number is free on the page, else one above every row of the page and its fence.
 */
async function restorePageFacts(tx: BrainEngine, page: UnwithdrawnFactsPage): Promise<RestoreResult> {
  const ids = page.facts.map(f => f.id);
  await tx.executeRaw('SELECT id FROM facts WHERE source_id=$1 AND id=ANY($2::bigint[]) FOR UPDATE', [page.source_id, ids]);
  const live = new Map((await classifyUnwithdrawnFacts(tx, [page.source_id], { slug: page.slug })).map(f => [f.id, f]));
  const result: RestoreResult = { restored: [], changed: [] };
  for (const approved of page.facts) {
    const current = live.get(approved.id);
    const same = !!current && (['class', 'reason', 'generation_id', 'retired_at', 'fact_hash'] as const).every(field => current[field] === approved[field]);
    const p = approved.preimage;
    const updated = same ? await tx.executeRaw<{ id: number }>(`UPDATE facts f SET expired_at=$4::timestamptz, valid_until=$5::timestamptz, superseded_by=$6::bigint,
        consolidated_at=$7::timestamptz, consolidated_into=$8::bigint,
        row_num=CASE WHEN NOT EXISTS (SELECT 1 FROM facts o WHERE o.source_id=f.source_id AND o.source_markdown_slug=$10 AND o.row_num=$9::integer) THEN $9::integer
          ELSE (SELECT COALESCE(max(o.row_num), 0) + 1 FROM facts o WHERE o.source_id=f.source_id AND o.source_markdown_slug=$10) END
      WHERE f.source_id=$1 AND f.id=$2::bigint AND f.fact=$3 AND f.row_num IS NULL AND f.superseded_by IS NULL AND ${INSTANT('f.expired_at')}=$11
      RETURNING f.id`, [page.source_id, approved.id, p.fact, p.expired_at, p.valid_until, p.superseded_by, p.consolidated_at, p.consolidated_into,
      p.row_num, page.slug, approved.retired_at]) : [];
    if (updated.length) result.restored.push(approved.id); else result.changed.push(approved.id);
  }
  return result;
}

/**
 * Preparer for `managed_maintenance_restore_unwithdrawn_facts`: a database-only publication on the page key, bound to the
 * revision the preview saw, that reclassifies and restores the approved facts of one page and reports the rest as
 * `changed_since_preview`.
 */
export async function prepareUnwithdrawnFactsRestore(engine: BrainEngine, row: WriteRequest): Promise<PreparedMutation> {
  const intent = row.intent as { page?: UnwithdrawnFactsPage; preview_hash?: unknown } | null;
  const page = intent?.page;
  if (!page || page.source_id !== row.source_id || page.slug !== row.slug || typeof intent?.preview_hash !== 'string' || !Array.isArray(page.facts)) {
    throw opError('invalid_params', 'The unwithdrawn facts restore intent does not name its page.',
      `Request ${row.request_id} for ${row.slug} in source ${row.source_id} does not name the page and preview it restores, so nothing changed. Preview the repair again and apply the new preview after the user approves.`,
      { fix: previewFix(row.source_id) });
  }
  const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
  if (!snapshot || snapshot.page.id !== Number(row.page_id) || snapshot.page.id !== page.page_id) {
    throw opError('page_identity_changed', 'The page was deleted or replaced before its facts were restored.',
      `Page ${row.slug} in source ${row.source_id} was deleted or replaced after the preview, so request ${row.request_id} restored nothing. Preview the repair again; it reflects the current pages.`,
      { fix: previewFix(row.source_id) });
  }
  if (snapshot.revision !== page.revision) {
    throw opError('revision_conflict', 'The page changed after the unwithdrawn-facts preview.',
      `Page ${row.slug} in source ${row.source_id} was written after the preview, so request ${row.request_id} restored nothing. Preview the repair again; it reflects the current page.`,
      { fix: previewFix(row.source_id) });
  }
  await authorizeWrite(engine, row.authority, 'submit_job', row.slug);
  return { observedRevision: snapshot.revision, noop: true,
    validate: async tx => { await authorizeWrite(tx, row.authority, 'submit_job', row.slug); },
    apply: async tx => {
      const result = await restorePageFacts(tx, page);
      return { status: 'completed', preview_hash: intent!.preview_hash, restored: result.restored, changed_since_preview: result.changed };
    } };
}
