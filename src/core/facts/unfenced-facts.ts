/**
 * Fence unfenced fact rows (#5299): append every active fact row with
 * `row_num IS NULL` to its entity page's `## Facts` fence and stamp the row
 * with its fence row number, so the fence reconciler owns it.
 *
 * Shared by the v0.32.2 migration's Phase B and the `extract_facts` cycle
 * phase. The inline writer's DB-only fallback keeps producing such rows (a
 * write from a host without the source checkout, `sync.write_through=off`),
 * so the cycle fences them on every run instead of waiting for a manual
 * migration retry.
 *
 * Ontology observations (`dimension IS NOT NULL`, written by
 * `mergeOntologyFact`) are never candidates (#6264): they belong to the
 * entity's ontology, keyed by their own provenance in `source_markdown_slug`,
 * and have no row on any page's Facts table. Fencing one rewrote its
 * provenance to the page and handed it to the fence reconciler, which retired
 * it on the next page write that did not list it.
 *
 * Eligibility (`planUnfencedFacts`): the row names an `entity_slug`, its page
 * is live in the row's source, and either the brain is managed (the
 * coordinator publishes database-only pages too; archived sources are
 * skipped) or the source has a `local_path` and the page's canonical file
 * exists on this host. Everything else is counted and left alone: a NULL
 * entity slug, a missing page or file, a source without a checkout here, or
 * (unmanaged, #6946) a clone gbrain owns, whose checkout is never written.
 *
 * Adoption oracle (#6278, `adoptableClaim`): the fence codec trims a claim,
 * folds CRLF/CR to LF, reads `~~x~~` as a struck row and `<br>` as a line
 * break, so a legacy claim is adopted only when `parseFactsFence(
 * renderFactsTable([row]))` hands it back active, non-empty, with the same
 * kind, visibility, validity and source, differing from the stored text by
 * whitespace and line endings alone. The parsed text is what the fence will
 * project, so it is written back into `facts.fact` with the row number (the
 * canonical projection expires any adopted row whose text differs from its
 * fence row). A row the codec would change further, or whose normalized
 * claim, source and visibility another active fence row or planned row
 * already carries (the reconciler indexes a duplicate once and would retire
 * the second),
 * stays a legacy row exactly as it is: never deleted or expired, recorded as
 * an `UnadoptableFactRecord` (source, page, fact id, reason class; never the
 * claim text) and named in `failed_pages` with the stable token
 * `<slug> (fence_unrenderable: N row(s), <class>)`. The other rows of the
 * page still adopt; a page with no adoptable row submits nothing.
 *
 * Write discipline (`fenceUnfencedFacts`):
 * - Managed: one `managed_maintenance_adopt_fact_fence` request per page
 *   through the coordinator, which publishes the fence and adopts the rows
 *   in place (ids, vectors and provenance kept).
 * - Unmanaged: under the source filesystem lock and the page lock, the same
 *   `.tmp` + parse + rename write as `fence-write.ts`, then one maintenance
 *   transaction mirrors the file body into `pages` and stamps the rows; a
 *   durability-hardened checkout commits the file.
 * A page that fails is reported in `failed_pages`; the others still fence.
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';

import type { BrainEngine } from '../engine.ts';
import { sanitizeText } from '../batch-rows.ts';
import { isDurabilityHardened } from '../brain-repo-durability.ts';
import { fenceCellReadBackProblem, formatFenceDate, normalizeClaimWhitespace, parseFactsFence, renderFactsTable, replaceOrInsertFactsFence, type FactAttribution, type ParsedFact } from '../facts-fence.ts';
import { FENCE_SOURCE_DEFAULT } from './extract-from-fence.ts';
import { parseMarkdown, serializePageToMarkdown } from '../markdown.ts';
import { assertSourceFilesystemActive, hasSourceFilesystemLock, withSourceFilesystemLock } from '../minions/source-filesystem.ts';
import { withPageLock } from '../page-lock.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { assertLifetimeIdHeadroom } from '../persistence/journal.ts';
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { maintenancePreflight, planFactFenceAdoption, submitFactFenceAdoption, submitPlannedFactFenceAdoption, type MaintenanceAuthority } from '../persistence/prepared-maintenance.ts';
import { resolveFactWriteTarget } from '../persistence/fact-write-target.ts';
import { submissionAuthority } from '../persistence/authority.ts';
import { currentVerifiedLocalWriter, registerLocalWriter } from '../persistence/identity.ts';
import { assertPersistenceAccepting } from '../persistence/service.ts';
import type { WriteAuthority } from '../persistence/model.ts';
import { UNBOUND_WRITE_KEY } from '../persistence/unbound-source.ts';
import { contentHash } from '../utils.ts';
import { bodyUnread } from '../page-body/page-shape.ts';
import { fileBodyMatchesStored, fileDatabaseDriftToken, mirrorFileBody, readStoredBody } from './file-body-guard.ts';
import { isWriteThroughDisabled, resolvePageWriteTarget } from '../write-through.ts';
import { commitFactFenceFile, gitPathState } from './fence-write.ts';
import { isOwnedClone } from '../url-clone.ts';
import { isSourceDbOnlySlug } from '../persistence/source-storage.ts';

export interface UnfencedFactRow {
  id: string;
  source_id: string;
  entity_slug: string | null;
  fact: string;
  kind: 'event' | 'preference' | 'commitment' | 'belief' | 'fact';
  visibility: 'private' | 'world';
  notability: 'high' | 'medium' | 'low';
  context: string | null;
  valid_from: Date;
  valid_until: Date | null;
  source: string;
  confidence: number;
  claim_metric: string | null;
  claim_value: number | null;
  claim_unit: string | null;
  claim_period: string | null;
  /** Speaker attribution; the fence carries it in its 15th column, so adoption keeps it. */
  attributed_to?: FactAttribution | null;
  page_exists: boolean;
}

export interface UnfencedFactsOutcome {
  scanned: number;
  fenced: number;
  skipped_no_entity: number;
  skipped_no_local_path: number;
  skipped_no_page: number;
  skipped_archived: number;
  /** Unmanaged (#6946): rows of a clone gbrain owns (`sources add --url`), kept database-only so its checkout keeps fast-forwarding. */
  skipped_url_clone: number;
  pages_touched: number;
  /** `<slug> (<reason>)` per page whose fence write failed; its rows stay unfenced. */
  failed_pages: string[];
  /** Slugs whose fence this run wrote. */
  fenced_slugs: string[];
  /** Unmanaged: `<slug> (<reason>)` per live page whose recorded canonical file is not on this host (counted in skipped_no_page). */
  missing_files: string[];
  /**
   * Unmanaged (#6610): database-only pages (no recorded origin, no file at the slug path) of a source with a checkout
   * but no canonical owner, whose rows stay unfenced because `persistence.unbound_write` is not `database_only`.
   * Their rows never gate the run (they are held out of reconciliation only); doctor `fence_integrity` names the opt-in.
   */
  unbound_refused: Array<{ source_id: string; slug: string; rows: number }>;
  /** Legacy rows this run left as they are because the fence codec would change them or the page already carries the claim (#6278). */
  unadoptable_rows: UnadoptableFactRecord[];
}

/**
 * What the fence codec would change about a legacy claim, by column or
 * character class: `empty` (whitespace-only), `struck` (`~~x~~` reads back
 * inactive), `line_break_markup` (a literal `<br>` reads back as a newline),
 * `claim` (any other change to the text), `kind` / `visibility` /
 * `validity` / `source` (another column reads back different), `parse` (the
 * single-row fence does not parse at all), `whole_fence` (the row passes alone
 * but does not read back from the page's whole rendered fence; the page
 * submits nothing), `prior_refusal` (a managed adoption of the same intent was
 * refused in the last day; it is retried a day after the refusal, or at once
 * when `FACT_FENCE_PLANNER` changes).
 */
export type UnrenderableClass = 'empty' | 'struck' | 'line_break_markup' | 'claim' | 'kind' | 'visibility' | 'validity' | 'source' | 'parse'
  | 'whole_fence' | 'prior_refusal';

/** One legacy row left unadopted, by location only: the claim text is never copied into a diagnostic. */
export interface UnadoptableFactRecord {
  source_id: string;
  slug: string;
  fact_id: number;
  reason: 'fence_unrenderable' | 'duplicate_claim';
  class: UnrenderableClass | 'duplicate_claim';
  /** `prior_refusal`: the refused request, readable with `gbrain write-request -- <id>`. */
  request_id?: string;
}

function fenceRowOf(row: UnfencedFactRow, rowNum: number, claim: string): ParsedFact {
  // Full timestamps survive the fence (date-only at midnight UTC), so the
  // canonical projection writes back the value the row already holds.
  const validFromStr = formatFenceDate(row.valid_from instanceof Date ? row.valid_from : new Date(row.valid_from));
  const validUntilStr = row.valid_until
    ? formatFenceDate(row.valid_until instanceof Date ? row.valid_until : new Date(row.valid_until))
    : undefined;
  return {
    rowNum,
    active: true,
    claim,
    kind:       row.kind,
    confidence: Number(row.confidence),
    visibility: row.visibility,
    notability: row.notability,
    validFrom:  validFromStr,
    validUntil: validUntilStr,
    source:     row.source,
    context:    row.context ?? undefined,
    ...(row.claim_metric ? { claimMetric: row.claim_metric } : {}),
    ...(row.claim_value != null ? { claimValue: Number(row.claim_value) } : {}),
    ...(row.claim_unit ? { claimUnit: row.claim_unit } : {}),
    ...(row.claim_period ? { claimPeriod: row.claim_period } : {}),
    ...(row.attributed_to ? { attributedTo: row.attributed_to } : {}),
  };
}

/**
 * The parser as the oracle (#6278): render the row as a one-row fence, parse
 * it back, and accept the parsed claim only when it is active, non-empty,
 * keeps the row's kind, visibility, validity and source, differs from the
 * stored text by whitespace and line endings alone, and survives a second
 * round trip unchanged (it is the text written back into `facts.fact`).
 */
export function adoptableClaim(row: Pick<UnfencedFactRow, 'fact' | 'kind' | 'visibility' | 'notability' | 'confidence' | 'context'
  | 'valid_from' | 'valid_until' | 'source' | 'claim_metric' | 'claim_value' | 'claim_unit' | 'claim_period'>): { claim: string } | { rejected: UnrenderableClass } {
  const desired = fenceRowOf(row as UnfencedFactRow, 1, row.fact);
  const once = parseFactsFence(renderFactsTable([desired]));
  const back = once.facts[0];
  if (once.warnings.length > 0 || once.facts.length !== 1 || !back) return { rejected: 'parse' };
  if (!back.active) return { rejected: 'struck' };
  if (back.claim === '') return { rejected: 'empty' };
  if (normalizeClaimWhitespace(back.claim) !== normalizeClaimWhitespace(row.fact)) {
    return { rejected: /<br\s*\/?>/i.test(row.fact) ? 'line_break_markup' : 'claim' };
  }
  if (back.kind !== desired.kind) return { rejected: 'kind' };
  if (back.visibility !== desired.visibility) return { rejected: 'visibility' };
  if ((back.validFrom ?? '') !== (desired.validFrom ?? '') || (back.validUntil ?? '') !== (desired.validUntil ?? '')) return { rejected: 'validity' };
  if ((back.source ?? '') !== (desired.source ?? '')) return { rejected: 'source' };
  const twice = parseFactsFence(renderFactsTable([{ ...desired, claim: back.claim }])).facts[0];
  if (!twice?.active || twice.claim !== back.claim) return { rejected: 'claim' };
  return { claim: back.claim };
}

/** The `failed_pages` entry for a page with unadoptable rows: `<slug> (fence_unrenderable: N row(s), <class>; duplicate_claim: N row(s))`. */
export function unadoptableRowsToken(slug: string, records: UnadoptableFactRecord[]): string {
  const parts: string[] = [];
  const unrenderable = records.filter(r => r.reason === 'fence_unrenderable');
  if (unrenderable.length) parts.push(`fence_unrenderable: ${unrenderable.length} row(s), ${[...new Set(unrenderable.map(r => r.class))].sort().join(', ')}`);
  const duplicates = records.filter(r => r.reason === 'duplicate_claim');
  if (duplicates.length) parts.push(`duplicate_claim: ${duplicates.length} row(s)`);
  return `${slug} (${parts.join('; ')})`;
}

export interface UnfencedFactsPlan {
  managed: boolean;
  /** Fenceable rows grouped per page, keyed `<source_id>\0<entity_slug>`. */
  groups: Map<string, UnfencedFactRow[]>;
  /** Unmanaged: the canonical file per group key. */
  filePaths: Map<string, string>;
  /** Unmanaged (#6610): groups whose page is database-only, fenced into its database body under this reason (null: a declared `storage.db_only` page, under the writer's own reason). */
  databaseOnly: Map<string, NonNullable<WriteAuthority['databaseOnlyReason']> | null>;
  localPathById: Map<string, string | null>;
  outcome: UnfencedFactsOutcome;
}

/** Rows in the fenceable groups. */
export function fenceableRowCount(plan: UnfencedFactsPlan): number {
  return [...plan.groups.values()].reduce((n, group) => n + group.length, 0);
}

/**
 * #6610: where an unmanaged page with no canonical file on this host gets its fence. A page that records an origin
 * (`source_path` or `source_uri`) has a file on some host: `missing`. A page with no recorded origin and no file at its
 * slug path is database-only, and follows the fact writers' rule (`resolveFactWriteTarget`, #6608): fenced into its
 * database body when that write is database-only (`fence`), `refused` when the source has a checkout but no owner and
 * `persistence.unbound_write` is not `database_only`; a bound source, or one PGLite would claim, stays `missing`.
 */
async function databaseOnlyPlacement(engine: BrainEngine, sourceId: string, slug: string):
  Promise<{ kind: 'fence'; reason: NonNullable<WriteAuthority['databaseOnlyReason']> } | { kind: 'refused' } | { kind: 'missing' }> {
  const [page] = await engine.executeRaw<{ source_path: string | null; source_uri: string | null }>(
    'SELECT source_path, source_uri FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, slug]);
  if (!page || page.source_path?.trim() || page.source_uri?.trim()) return { kind: 'missing' };
  const [source] = await engine.executeRaw<{ local_path: string | null; kind: string | null }>(
    "SELECT local_path, config->>'kind' AS kind FROM sources WHERE id=$1", [sourceId]);
  try {
    const target = await resolveFactWriteTarget(engine, sourceId, source!, { fileBacked: false, remote: false });
    return target.kind === 'publish' && !target.binding ? { kind: 'fence', reason: target.databaseOnlyReason ?? 'no_repo_configured' } : { kind: 'missing' };
  } catch (error) {
    if (error instanceof OperationError && error.detail === 'unbound_source') return { kind: 'refused' };
    throw error;
  }
}

/** `<slug> (<source>): N row(s)` per page the unbound-source policy keeps unfenced, and the opt-in that fences them. */
export function unboundRefusedSentence(pages: UnfencedFactsOutcome['unbound_refused']): string {
  return `${pages.reduce((n, page) => n + page.rows, 0)} unfenced fact row(s) on ${pages.length} database-only page(s) of a source with a checkout but no canonical owner stay unfenced: `
    + `${pages.slice(0, 5).map(page => `${page.slug} (${page.source_id}): ${page.rows} row(s)`).join('; ')}${pages.length > 5 ? '; …' : ''}. `
    + `They stay active and searchable and those pages skip destructive fact reconciliation. To fence them into the database page, the user can allow database-only writes to unbound sources `
    + `with gbrain config set ${UNBOUND_WRITE_KEY} database_only (a brain-wide choice: such pages stay database-only after binding).`;
}

/** Read the unfenced active rows of one source (or every source) and group the fenceable ones per page. */
export async function planUnfencedFacts(engine: BrainEngine, opts: { sourceId?: string } = {}): Promise<UnfencedFactsPlan> {
  const managed = await managedPersistenceEnabled(engine);
  const sources = await engine.executeRaw<{ id: string; local_path: string | null; archived?: boolean; config: unknown }>(
    'SELECT id, local_path, archived, config FROM sources',
  );
  const urlClones = new Set(managed ? [] : sources.filter(isOwnedClone).map(s => s.id));
  const localPathById = new Map(sources.map(s => [s.id, s.local_path] as const));
  const archived = new Set(sources.filter(s => s.archived).map(s => s.id));
  const rows = await engine.executeRaw<UnfencedFactRow>(
    `SELECT id, source_id, entity_slug, fact, kind, visibility, notability,
            context, valid_from, valid_until, source, confidence,
            claim_metric, claim_value, claim_unit, claim_period, attributed_to,
            EXISTS (SELECT 1 FROM pages p WHERE p.source_id = f.source_id
              AND p.slug = f.entity_slug AND p.deleted_at IS NULL) AS page_exists
       FROM facts f
      WHERE row_num IS NULL AND expired_at IS NULL AND dimension IS NULL
        ${opts.sourceId !== undefined ? 'AND source_id = $1' : ''}
      ORDER BY source_id, entity_slug, id`,
    opts.sourceId !== undefined ? [opts.sourceId] : [],
  );
  const outcome: UnfencedFactsOutcome = {
    scanned: rows.length, fenced: 0, skipped_no_entity: 0, skipped_no_local_path: 0, skipped_no_page: 0,
    skipped_archived: 0, skipped_url_clone: 0, pages_touched: 0, failed_pages: [], fenced_slugs: [], missing_files: [], unbound_refused: [], unadoptable_rows: [],
  };
  const groups = new Map<string, UnfencedFactRow[]>();
  for (const row of rows) {
    if (row.entity_slug === null) { outcome.skipped_no_entity += 1; continue; }
    // A managed brain publishes through the source's maintenance authority,
    // which an archived source does not grant; it never blocks the others.
    if (managed && archived.has(row.source_id)) { outcome.skipped_archived += 1; continue; }
    if (urlClones.has(row.source_id)) { outcome.skipped_url_clone += 1; continue; }
    if (!localPathById.get(row.source_id) && !managed) { outcome.skipped_no_local_path += 1; continue; }
    if (!row.page_exists) { outcome.skipped_no_page += 1; continue; }
    const key = `${row.source_id}\0${row.entity_slug}`;
    groups.set(key, [...groups.get(key) ?? [], row]);
  }
  const filePaths = new Map<string, string>();
  const databaseOnly = new Map<string, NonNullable<WriteAuthority['databaseOnlyReason']> | null>();
  const writeThroughOff = !managed && await isWriteThroughDisabled(engine);
  for (const [key, group] of managed ? [] : [...groups]) {
    const [sourceId, entitySlug] = key.split('\0');
    const target = await resolvePageWriteTarget(engine, entitySlug, sourceId);
    if (target.ok && existsSync(target.filePath)) {
      if (writeThroughOff) databaseOnly.set(key, 'disabled_by_config');
      else filePaths.set(key, target.filePath);
      continue;
    }
    // A declared storage.db_only page is canonical in the database; its missing file is by design, not a fault.
    const root = localPathById.get(sourceId);
    if (root && isSourceDbOnlySlug(root, entitySlug, 'not_db_only')) { databaseOnly.set(key, null); continue; }
    const placement = await databaseOnlyPlacement(engine, sourceId, entitySlug);
    if (placement.kind === 'fence') { databaseOnly.set(key, placement.reason); continue; }
    groups.delete(key);
    if (placement.kind === 'refused') { outcome.unbound_refused.push({ source_id: sourceId, slug: entitySlug, rows: group.length }); continue; }
    outcome.skipped_no_page += group.length;
    outcome.missing_files.push(`${entitySlug} (${target.ok ? `canonical file ${target.filePath} does not exist on this host; the page records it, so the cycle on the host that holds the file fences these rows` : `no canonical file: ${target.skipped}`})`);
  }
  return { managed, groups, filePaths, databaseOnly, localPathById, outcome };
}

/**
 * Append a page's adoptable unfenced rows to its facts fence. Row numbering
 * starts above every occupied `row_num` on the page, conversation-extractor
 * rows included, so no fence row can take an extractor row's position. A
 * fence row left by a partial earlier run with the same claim and source and
 * no database owner is reused instead of appended again. Each assignment
 * carries the parsed claim the fence projects, to be written back into
 * `facts.fact` with the row number. Rows the codec would change further, and
 * a second row whose normalized claim and source the page already carries,
 * are returned in `rejected` and left alone.
 */
export async function planFence(engine: BrainEngine, sourceId: string, entitySlug: string, body: string, group: UnfencedFactRow[]):
  Promise<{ body: string; assignments: Array<{ id: string; row_num: number; fact: string }>; rejected: UnadoptableFactRecord[] } | { warnings: string[] }> {
  const existingFence = parseFactsFence(body);
  if (existingFence.warnings.length > 0) return { warnings: existingFence.warnings };
  const occupiedRows = await engine.executeRaw<{ row_num: number; fact: string; source: string | null }>(
    `SELECT row_num, fact, source FROM facts
      WHERE source_id = $1 AND source_markdown_slug = $2 AND row_num IS NOT NULL`,
    [sourceId, entitySlug],
  );
  const occupied = new Map(occupiedRows.map(row => [Number(row.row_num), row]));
  let nextRowNum = Math.max(0, ...occupied.keys(), ...existingFence.facts.map(f => f.rowNum)) + 1;
  const claimed = new Set<number>();
  const assignments: Array<{ id: string; row_num: number; fact: string }> = [];
  const rejected: UnadoptableFactRecord[] = [];
  // The reconciler indexes active rows with one claim and source once (#1781)
  // and retires the later copy, so a claim the page already carries with the
  // same source and visibility (the projection's identity), or that an
  // earlier row of this group plans, is not adopted a second time. A private
  // and a world row with one text are two facts and both adopt, as before.
  const dupKey = (claim: string, source: string | undefined, visibility: string) => `${claim}\u0000${source || FENCE_SOURCE_DEFAULT}\u0000${visibility}`;
  const planned = new Set<string>();
  const ownedKeys = new Set(existingFence.facts.filter(f => {
    const owner = occupied.get(f.rowNum);
    return f.active && owner !== undefined && owner.fact === f.claim && (owner.source ?? '') === (f.source ?? '');
  }).map(f => dupKey(f.claim, f.source, f.visibility)));
  for (const row of group) {
    const oracle = adoptableClaim(row);
    if ('rejected' in oracle) {
      rejected.push({ source_id: sourceId, slug: entitySlug, fact_id: Number(row.id), reason: 'fence_unrenderable', class: oracle.rejected });
      continue;
    }
    const key = dupKey(oracle.claim, row.source, row.visibility);
    if (planned.has(key) || ownedKeys.has(key)) {
      rejected.push({ source_id: sourceId, slug: entitySlug, fact_id: Number(row.id), reason: 'duplicate_claim', class: 'duplicate_claim' });
      continue;
    }
    planned.add(key);
    // #6650: a leftover cell is reused only when re-rendering it from the
    // legacy row cannot widen its visibility (a private cell never becomes
    // world), and it is re-rendered from the row: publication refreshes the
    // fact's kind, validity and metadata from its fence cell, so a stale
    // cell would otherwise overwrite them.
    const existingAt = existingFence.facts.findIndex(f => {
      const owner = occupied.get(f.rowNum);
      return f.active && !claimed.has(f.rowNum) && f.claim === oracle.claim &&
        (f.source ?? '') === (row.source ?? '') && (f.visibility === row.visibility || row.visibility === 'private') &&
        (!owner || owner.fact !== f.claim || (owner.source ?? '') !== (f.source ?? ''));
    });
    if (existingAt >= 0) {
      const at = existingFence.facts[existingAt].rowNum;
      const rowNum = occupied.has(at) ? nextRowNum++ : at;
      existingFence.facts[existingAt] = fenceRowOf(row, rowNum, oracle.claim);
      assignments.push({ id: row.id, row_num: rowNum, fact: oracle.claim });
      claimed.add(rowNum);
      continue;
    }
    const rowNum = nextRowNum++;
    existingFence.facts.push(fenceRowOf(row, rowNum, oracle.claim));
    assignments.push({ id: row.id, row_num: rowNum, fact: oracle.claim });
    claimed.add(rowNum);
  }
  const rendered = replaceOrInsertFactsFence(body, renderFactsTable(existingFence.facts));
  if (assignments.length === 0) return { body: rendered, assignments, rejected };
  // #6650: the page is published only when every assignment reads back from
  // the whole rendered fence the way the publisher will check it.
  const readBack = parseFactsFence(rendered);
  const cells = new Map(readBack.facts.map(f => [f.rowNum, f]));
  const byId = new Map(group.map(row => [row.id, row]));
  if (readBack.warnings.length > 0 || assignments.some(a => fenceCellReadBackProblem(cells.get(a.row_num), byId.get(a.id)!) !== null)) {
    return { body, assignments: [], rejected: [...rejected, ...assignments.map(a => ({ source_id: sourceId, slug: entitySlug, fact_id: Number(a.id),
      reason: 'fence_unrenderable' as const, class: 'whole_fence' as const }))] };
  }
  return { body: rendered, assignments, rejected };
}

/**
 * #6650: whether a fact the adoption pins (read just now) no longer renders
 * as the fence row planned from the earlier read. The pins are the request's
 * hashes, so publishing such a plan would write the older metadata back over
 * the newer row; the page is skipped and replanned next run instead.
 */
function factsChangedSincePlanning(body: string, assignments: Array<{ id: string; row_num: number }>, pinned: Array<{ id: number; value: Record<string, unknown> }>): boolean {
  const cells = new Map(parseFactsFence(body).facts.map(f => [f.rowNum, f]));
  return assignments.some(a => {
    const cell = cells.get(a.row_num);
    const now = pinned.find(f => f.id === Number(a.id))?.value as unknown as UnfencedFactRow | undefined;
    if (!cell || !now || normalizeClaimWhitespace(String(now.fact)) !== normalizeClaimWhitespace(cell.claim)) return true;
    return renderFactsTable([fenceRowOf(now, cell.rowNum, cell.claim)]) !== renderFactsTable([cell]);
  });
}

/** Keep the typed records and name the page once in `failed_pages` with the stable token; the rows stay as they are. */
function recordUnadoptable(outcome: UnfencedFactsOutcome, slug: string, records: UnadoptableFactRecord[]): void {
  if (records.length === 0) return;
  outcome.unadoptable_rows.push(...records);
  outcome.failed_pages.push(unadoptableRowsToken(slug, records));
}

/** One managed page, planned read-only: what the adoption would do with it right now. */
type ManagedPagePlan =
  | { kind: 'no_page' }
  | { kind: 'warnings'; warnings: string[] }
  | { kind: 'unadoptable'; records: UnadoptableFactRecord[] }
  | { kind: 'submit'; snapshot: NonNullable<Awaited<ReturnType<BrainEngine['readPageSnapshot']>>>; fence: { body: string; assignments: Array<{ id: string; row_num: number }>; rejected: UnadoptableFactRecord[] };
      request: Extract<Awaited<ReturnType<typeof planFactFenceAdoption>>, { kind: 'submit' }> };

async function planManagedPage(engine: BrainEngine, authority: MaintenanceAuthority, sourceId: string, entitySlug: string, group: UnfencedFactRow[]): Promise<ManagedPagePlan> {
  const snapshot = await engine.readPageSnapshot(entitySlug, { sourceId });
  if (!snapshot) return { kind: 'no_page' };
  const fence = await planFence(engine, sourceId, entitySlug, serializePageToMarkdown(snapshot.page, snapshot.tags), group);
  if ('warnings' in fence) return { kind: 'warnings', warnings: fence.warnings };
  if (fence.assignments.length === 0) return { kind: 'unadoptable', records: fence.rejected };
  const request = await planFactFenceAdoption(engine, authority, entitySlug, {
    content: fence.body, expectedRevision: snapshot.revision,
    assignments: fence.assignments.map(a => ({ id: Number(a.id), row_num: a.row_num })),
  });
  if (request.kind === 'suppressed') {
    return { kind: 'unadoptable', records: [...fence.rejected, ...fence.assignments.map(a => ({ source_id: sourceId, slug: entitySlug,
      fact_id: Number(a.id), reason: 'fence_unrenderable' as const, class: 'prior_refusal' as const, request_id: request.prior.request_id }))] };
  }
  return { kind: 'submit', snapshot, fence, request };
}

/**
 * Managed brains (#5728 class): the managed writer guard refuses direct fence
 * writes into the canonical worktree and any raw `UPDATE facts`. Each page
 * publishes its rendered fence through the coordinator as one
 * `managed_maintenance_adopt_fact_fence` request that adopts the rows in
 * place. The page body comes from the database, so database-only pages are
 * included. Preflight and capacity refusals throw before any page publishes.
 */
async function fenceManaged(engine: BrainEngine, plan: UnfencedFactsPlan): Promise<void> {
  const { groups, outcome } = plan;
  const authorities = new Map<string, MaintenanceAuthority>();
  for (const key of groups.keys()) {
    const sourceId = key.split('\0')[0];
    if (!authorities.has(sourceId)) authorities.set(sourceId, (await maintenancePreflight(engine, sourceId))!);
  }
  // One admission per page that will submit: refuse up front, before any page publishes, when the permanent
  // request-ID caps cannot cover them. Every page fitting is the common case and costs one read; only when it
  // would refuse does a read-only pre-pass count the pages that will actually submit, so a page that is suppressed
  // (an identical adoption was refused within the day), unadoptable or gone never pushes the step over the cap.
  // The submit loop below plans each page again right before it submits, so the plan it publishes is never
  // older than its own read (the facts-changed-since-planning guard keeps its short window).
  const [first] = authorities.values();
  if (first) await assertLifetimeIdHeadroom(engine, first.writer.principal, groups.size).catch(async (error: unknown) => {
    if (!(error instanceof OperationError) || !['write_quota_exhausted', 'write_quota_insufficient'].includes(error.code)) throw error;
    let submitting = 0;
    for (const [key, group] of groups) {
      const [sourceId, entitySlug] = key.split('\0');
      try { if ((await planManagedPage(engine, authorities.get(sourceId)!, sourceId, entitySlug, group)).kind === 'submit') submitting++; }
      catch { submitting++; }
    }
    await assertLifetimeIdHeadroom(engine, first.writer.principal, submitting);
  });
  for (const [key, group] of groups) {
    const [sourceId, entitySlug] = key.split('\0');
    try {
      const authority = authorities.get(sourceId)!;
      const page = await planManagedPage(engine, authority, sourceId, entitySlug, group);
      if (page.kind === 'no_page') { outcome.skipped_no_page += group.length; continue; }
      if (page.kind === 'warnings') { outcome.failed_pages.push(`${entitySlug} (${page.warnings.join('; ')})`); continue; }
      if (page.kind === 'unadoptable') { recordUnadoptable(outcome, entitySlug, page.records); continue; }
      const { snapshot, fence, request } = page;
      if (factsChangedSincePlanning(fence.body, fence.assignments, request.facts)) {
        outcome.failed_pages.push(`${entitySlug} (a legacy fact changed after its fence row was planned; nothing was submitted and the next run replans it)`);
        continue;
      }
      recordUnadoptable(outcome, entitySlug, fence.rejected);
      const target = await resolvePageWriteTarget(engine, entitySlug, sourceId);
      await submitPlannedFactFenceAdoption(engine, authority, entitySlug, request,
        Boolean(snapshot.page.source_path) || snapshot.page.source_uri?.startsWith('file:') === true || (target.ok && existsSync(target.filePath)));
      outcome.fenced += fence.assignments.length;
      outcome.pages_touched += 1;
      outcome.fenced_slugs.push(entitySlug);
    } catch (err) {
      outcome.failed_pages.push(`${entitySlug} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
}

/**
 * #6610: one unmanaged database-only page, fenced into its database body through the coordinator as one
 * `managed_maintenance_adopt_fact_fence` request with no file target, the publication path `remember` uses for the
 * same page (#6608): the receipt, page version and projection follow, and an `unbound_source` write rechecks at
 * publication that the source is still unbound and the page still has no canonical file.
 */
async function fenceDatabaseOnlyPage(engine: BrainEngine, sourceId: string, entitySlug: string, reason: NonNullable<WriteAuthority['databaseOnlyReason']> | null,
  group: UnfencedFactRow[], outcome: UnfencedFactsOutcome): Promise<void> {
  try {
    const snapshot = await engine.readPageSnapshot(entitySlug, { sourceId });
    if (!snapshot) { outcome.skipped_no_page += group.length; return; }
    const fence = await planFence(engine, sourceId, entitySlug, serializePageToMarkdown(snapshot.page, snapshot.tags), group);
    if ('warnings' in fence) { outcome.failed_pages.push(`${entitySlug} (${fence.warnings.join('; ')})`); return; }
    recordUnadoptable(outcome, entitySlug, fence.rejected);
    if (fence.assignments.length === 0) return;
    assertPersistenceAccepting(engine);
    if (!currentVerifiedLocalWriter()) await registerLocalWriter(engine, 'cli');
    const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]);
    const writer = await submissionAuthority({ engine, remote: false, sourceId } as OperationContext, 'submit_job', sourceId, source!.incarnation, 'maintenance');
    if (reason) writer.databaseOnlyReason = reason;
    await submitFactFenceAdoption(engine, { writer, binding: null }, entitySlug, { content: fence.body, expectedRevision: snapshot.revision,
      assignments: fence.assignments.map(a => ({ id: Number(a.id), row_num: a.row_num })), file: false });
    outcome.fenced += fence.assignments.length;
    outcome.pages_touched += 1;
    outcome.fenced_slugs.push(entitySlug);
  } catch (err) {
    outcome.failed_pages.push(`${entitySlug} (${err instanceof Error ? err.message : String(err)})`);
  }
}

/**
 * One unmanaged page (#6982): the fence is planned on the file only when the file and the database body agree
 * (`fileMatchesSnapshot`, the coordinator's drift comparison), so mirroring the fenced file back can only add the fence.
 * The page row is then locked and re-read in a maintenance transaction: when the database or the file moved since the
 * comparison, nothing is written. Otherwise the prior body is kept in page_versions, the body is mirrored, the rows are
 * stamped, and the `.tmp` is renamed into place last, so a rolled-back transaction leaves the file as it was.
 */
/** Thrown inside the fence transaction when the file changed after the mirror, so the mirror and row stamps roll back. */
class FileChangedDuringFence extends Error {}

async function fenceFilePage(engine: BrainEngine, sourceId: string, entitySlug: string, filePath: string,
  group: UnfencedFactRow[], outcome: UnfencedFactsOutcome, lockRoot?: string): Promise<void> {
  const target = await resolvePageWriteTarget(engine, entitySlug, sourceId);
  if (!target.ok) { outcome.skipped_no_page += group.length; return; }
  const { writeRoot } = target;
  const write = () => withPageLock(entitySlug, async () => {
    const bytes = readFileSync(filePath, 'utf-8');
    const page = await engine.getPage(entitySlug, { sourceId });
    const stored = page && await readStoredBody(engine, sourceId, entitySlug);
    if (!page || !stored) { outcome.skipped_no_page += group.length; return; }
    if (bodyUnread(page)) {
      outcome.failed_pages.push(`${entitySlug} (page_body_segmented: the page is stored in segments, so its file is not compared or rewritten here; its rows stay unfenced, active and searchable)`);
      return;
    }
    if (!fileBodyMatchesStored(bytes, entitySlug, stored)) {
      outcome.failed_pages.push(fileDatabaseDriftToken(entitySlug, sourceId, 'before'));
      return;
    }
    const fence = await planFence(engine, sourceId, entitySlug, bytes, group);
    if ('warnings' in fence) {
      outcome.failed_pages.push(`${entitySlug} (${fence.warnings.join('; ')})`);
      return;
    }
    recordUnadoptable(outcome, entitySlug, fence.rejected);
    if (fence.assignments.length === 0) return;
    const durable = isDurabilityHardened(writeRoot);
    const prewrite = durable ? gitPathState(writeRoot, filePath) : 'clean';
    const tmpPath = `${filePath}.tmp`;
    assertSourceFilesystemActive();
    writeFileSync(tmpPath, fence.body, 'utf-8');
    const tmpBody = readFileSync(tmpPath, 'utf-8');
    const parsed = parseFactsFence(tmpBody);
    if (parsed.warnings.length > 0) {
      // .tmp stays for inspection; the canonical file is untouched.
      outcome.failed_pages.push(`${entitySlug} (${parsed.warnings.join('; ')})`);
      return;
    }
    // Mirror the file into pages so this run's reconcile and get_page read the
    // new fence (same body-only mirror as fence-write.ts).
    const written = await maintenanceTransaction(engine, async tx => {
      if (readFileSync(filePath, 'utf-8') !== bytes || !await mirrorFileBody(tx, sourceId, entitySlug, tmpBody, stored)) return false;
      // The parsed claim is what the fence projects; the row keeps its id,
      // vectors and provenance (the reconcile would retire a row whose text
      // differs from its fence row).
      for (const a of fence.assignments) {
        await tx.executeRaw(
          `UPDATE facts SET row_num = $1, source_markdown_slug = $2, fact = $5
            WHERE id = $3 AND source_id = $4 AND row_num IS NULL`,
          [a.row_num, entitySlug, a.id, sourceId, a.fact],
        );
      }
      assertSourceFilesystemActive();
      if (readFileSync(filePath, 'utf-8') !== bytes) throw new FileChangedDuringFence();
      renameSync(tmpPath, filePath);
      return true;
    }).catch(error => { if (error instanceof FileChangedDuringFence) return false; throw error; });
    if (!written) {
      rmSync(tmpPath, { force: true });
      outcome.failed_pages.push(fileDatabaseDriftToken(entitySlug, sourceId, 'during'));
      return;
    }
    if (durable) await commitFactFenceFile(writeRoot, filePath, entitySlug, sourceId, prewrite);
    outcome.fenced += fence.assignments.length;
    outcome.pages_touched += 1;
    outcome.fenced_slugs.push(entitySlug);
  }, { timeoutMs: 5_000, ...(lockRoot ? { lockRoot } : {}) });
  try {
    await (hasSourceFilesystemLock(writeRoot) ? write() : withSourceFilesystemLock(engine, writeRoot, write));
  } catch (err) {
    outcome.failed_pages.push(`${entitySlug} (${err instanceof Error ? err.message : String(err)})`);
  }
}

/**
 * Read-only (#6278): the rows of a plan the fence step would leave unadopted
 * and why, by location only, for doctor `fence_integrity`. Each page's body
 * is read the way the write path reads it (the database snapshot on a managed
 * brain, the canonical file otherwise) and planned without writing. A plan
 * the deadline cut short reports `complete: false`.
 */
export async function auditUnadoptableFacts(engine: BrainEngine, plan: UnfencedFactsPlan, opts: { deadline?: number } = {}):
  Promise<{ records: UnadoptableFactRecord[]; complete: boolean }> {
  const records: UnadoptableFactRecord[] = [];
  for (const [key, group] of plan.groups) {
    if (opts.deadline !== undefined && Date.now() > opts.deadline) return { records, complete: false };
    const [sourceId, entitySlug] = key.split('\0');
    let body: string;
    if (plan.managed || plan.databaseOnly.has(key)) {
      const snapshot = await engine.readPageSnapshot(entitySlug, { sourceId });
      if (!snapshot) continue;
      body = serializePageToMarkdown(snapshot.page, snapshot.tags);
    } else {
      const filePath = plan.filePaths.get(key);
      if (!filePath || !existsSync(filePath)) continue;
      body = readFileSync(filePath, 'utf-8');
    }
    const fence = await planFence(engine, sourceId, entitySlug, body, group);
    if (!('warnings' in fence)) records.push(...fence.rejected);
  }
  return { records, complete: true };
}

/**
 * Fence every group of the plan through the brain's write path; fills
 * `plan.outcome`. A managed preflight or capacity refusal throws before any
 * page publishes; a per-page failure lands in `failed_pages`.
 */
export async function fenceUnfencedFacts(engine: BrainEngine, plan: UnfencedFactsPlan, opts: { pageLockRoot?: string } = {}): Promise<UnfencedFactsOutcome> {
  if (plan.managed) {
    await fenceManaged(engine, plan);
    return plan.outcome;
  }
  for (const [key, group] of plan.groups) {
    const [sourceId, entitySlug] = key.split('\0');
    if (plan.databaseOnly.has(key)) await fenceDatabaseOnlyPage(engine, sourceId, entitySlug, plan.databaseOnly.get(key)!, group, plan.outcome);
    else await fenceFilePage(engine, sourceId, entitySlug, plan.filePaths.get(key)!, group, plan.outcome, opts.pageLockRoot);
  }
  return plan.outcome;
}
