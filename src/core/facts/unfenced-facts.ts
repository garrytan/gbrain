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
 * entity slug, a missing page or file, or a source without a checkout here.
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
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

import type { BrainEngine } from '../engine.ts';
import { sanitizeText } from '../batch-rows.ts';
import { isDurabilityHardened } from '../brain-repo-durability.ts';
import { formatFenceDate, parseFactsFence, renderFactsTable, replaceOrInsertFactsFence } from '../facts-fence.ts';
import { parseMarkdown, serializePageToMarkdown } from '../markdown.ts';
import { assertSourceFilesystemActive, hasSourceFilesystemLock, withSourceFilesystemLock } from '../minions/source-filesystem.ts';
import { withPageLock } from '../page-lock.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { assertLifetimeIdHeadroom } from '../persistence/journal.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { maintenancePreflight, submitFactFenceAdoption, type MaintenanceAuthority } from '../persistence/prepared-maintenance.ts';
import { contentHash } from '../utils.ts';
import { resolvePageWriteTarget } from '../write-through.ts';
import { commitFactFenceFile, gitPathState } from './fence-write.ts';

interface UnfencedFactRow {
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
  page_exists: boolean;
}

export interface UnfencedFactsOutcome {
  scanned: number;
  fenced: number;
  skipped_no_entity: number;
  skipped_no_local_path: number;
  skipped_no_page: number;
  skipped_archived: number;
  pages_touched: number;
  /** `<slug> (<reason>)` per page whose fence write failed; its rows stay unfenced. */
  failed_pages: string[];
  /** Slugs whose fence this run wrote. */
  fenced_slugs: string[];
  /** Unmanaged: `<slug> (<reason>)` per live page whose canonical file is not on this host (counted in skipped_no_page). */
  missing_files: string[];
}

export interface UnfencedFactsPlan {
  managed: boolean;
  /** Fenceable rows grouped per page, keyed `<source_id>\0<entity_slug>`. */
  groups: Map<string, UnfencedFactRow[]>;
  /** Unmanaged: the canonical file per group key. */
  filePaths: Map<string, string>;
  localPathById: Map<string, string | null>;
  outcome: UnfencedFactsOutcome;
}

/** Rows in the fenceable groups. */
export function fenceableRowCount(plan: UnfencedFactsPlan): number {
  return [...plan.groups.values()].reduce((n, group) => n + group.length, 0);
}

/** Read the unfenced active rows of one source (or every source) and group the fenceable ones per page. */
export async function planUnfencedFacts(engine: BrainEngine, opts: { sourceId?: string } = {}): Promise<UnfencedFactsPlan> {
  const managed = await managedPersistenceEnabled(engine);
  const sources = await engine.executeRaw<{ id: string; local_path: string | null; archived?: boolean }>(
    'SELECT id, local_path, archived FROM sources',
  );
  const localPathById = new Map(sources.map(s => [s.id, s.local_path] as const));
  const archived = new Set(sources.filter(s => s.archived).map(s => s.id));
  const rows = await engine.executeRaw<UnfencedFactRow>(
    `SELECT id, source_id, entity_slug, fact, kind, visibility, notability,
            context, valid_from, valid_until, source, confidence,
            claim_metric, claim_value, claim_unit, claim_period,
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
    skipped_archived: 0, pages_touched: 0, failed_pages: [], fenced_slugs: [], missing_files: [],
  };
  const groups = new Map<string, UnfencedFactRow[]>();
  for (const row of rows) {
    if (row.entity_slug === null) { outcome.skipped_no_entity += 1; continue; }
    // A managed brain publishes through the source's maintenance authority,
    // which an archived source does not grant; it never blocks the others.
    if (managed && archived.has(row.source_id)) { outcome.skipped_archived += 1; continue; }
    if (!localPathById.get(row.source_id) && !managed) { outcome.skipped_no_local_path += 1; continue; }
    if (!row.page_exists) { outcome.skipped_no_page += 1; continue; }
    const key = `${row.source_id}\0${row.entity_slug}`;
    groups.set(key, [...groups.get(key) ?? [], row]);
  }
  const filePaths = new Map<string, string>();
  for (const [key, group] of managed ? [] : [...groups]) {
    const [sourceId, entitySlug] = key.split('\0');
    const target = await resolvePageWriteTarget(engine, entitySlug, sourceId);
    if (!target.ok || !existsSync(target.filePath)) {
      outcome.skipped_no_page += group.length;
      outcome.missing_files.push(`${entitySlug} (${target.ok ? `canonical file ${target.filePath} does not exist on this host` : `no canonical file: ${target.skipped}`})`);
      groups.delete(key);
      continue;
    }
    filePaths.set(key, target.filePath);
  }
  return { managed, groups, filePaths, localPathById, outcome };
}

/**
 * Append a page's unfenced rows to its facts fence. Row numbering starts above
 * every occupied `row_num` on the page, conversation-extractor rows included,
 * so no fence row can take an extractor row's position. A fence row left by a
 * partial earlier run with the same claim and source and no database owner is
 * reused instead of appended again.
 */
async function planFence(engine: BrainEngine, sourceId: string, entitySlug: string, body: string, group: UnfencedFactRow[]):
  Promise<{ body: string; assignments: Array<{ id: string; row_num: number }> } | { warnings: string[] }> {
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
  const assignments: Array<{ id: string; row_num: number }> = [];
  for (const row of group) {
    const existing = existingFence.facts.find(f => {
      const owner = occupied.get(f.rowNum);
      return f.active && !claimed.has(f.rowNum) && f.claim === row.fact &&
        (f.source ?? '') === (row.source ?? '') &&
        (!owner || owner.fact !== f.claim || (owner.source ?? '') !== (f.source ?? ''));
    });
    if (existing) {
      if (occupied.has(existing.rowNum)) existing.rowNum = nextRowNum++;
      assignments.push({ id: row.id, row_num: existing.rowNum });
      claimed.add(existing.rowNum);
      continue;
    }
    // Full timestamps survive the fence (date-only at midnight UTC), so the
    // canonical projection writes back the value the row already holds.
    const validFromStr = formatFenceDate(row.valid_from instanceof Date ? row.valid_from : new Date(row.valid_from));
    const validUntilStr = row.valid_until
      ? formatFenceDate(row.valid_until instanceof Date ? row.valid_until : new Date(row.valid_until))
      : undefined;
    const rowNum = nextRowNum++;
    existingFence.facts.push({
      rowNum,
      active: true,
      claim:      row.fact,
      kind:       row.kind,
      confidence: row.confidence,
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
    });
    assignments.push({ id: row.id, row_num: rowNum });
    claimed.add(rowNum);
  }
  return { body: replaceOrInsertFactsFence(body, renderFactsTable(existingFence.facts)), assignments };
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
  // One admission per page: refuse up front, before any page publishes,
  // when the permanent request-ID caps cannot cover them all.
  const [first] = authorities.values();
  if (first) await assertLifetimeIdHeadroom(engine, first.writer.principal, groups.size);
  for (const [key, group] of groups) {
    const [sourceId, entitySlug] = key.split('\0');
    try {
      const authority = authorities.get(sourceId)!;
      const snapshot = await engine.readPageSnapshot(entitySlug, { sourceId });
      if (!snapshot) { outcome.skipped_no_page += group.length; continue; }
      const fence = await planFence(engine, sourceId, entitySlug, serializePageToMarkdown(snapshot.page, snapshot.tags), group);
      if ('warnings' in fence) {
        outcome.failed_pages.push(`${entitySlug} (${fence.warnings.join('; ')})`);
        continue;
      }
      const target = await resolvePageWriteTarget(engine, entitySlug, sourceId);
      await submitFactFenceAdoption(engine, authority, entitySlug, {
        content: fence.body, expectedRevision: snapshot.revision,
        assignments: fence.assignments.map(a => ({ id: Number(a.id), row_num: a.row_num })),
        file: Boolean(snapshot.page.source_path) || snapshot.page.source_uri?.startsWith('file:') === true || (target.ok && existsSync(target.filePath)),
      });
      outcome.fenced += fence.assignments.length;
      outcome.pages_touched += 1;
      outcome.fenced_slugs.push(entitySlug);
    } catch (err) {
      outcome.failed_pages.push(`${entitySlug} (${err instanceof Error ? err.message : String(err)})`);
    }
  }
}

/** One unmanaged page: file first (atomic), then the page mirror and row stamps in one maintenance transaction. */
async function fenceFilePage(engine: BrainEngine, sourceId: string, entitySlug: string, filePath: string,
  group: UnfencedFactRow[], outcome: UnfencedFactsOutcome, lockRoot?: string): Promise<void> {
  const target = await resolvePageWriteTarget(engine, entitySlug, sourceId);
  if (!target.ok) { outcome.skipped_no_page += group.length; return; }
  const { writeRoot } = target;
  const write = () => withPageLock(entitySlug, async () => {
    const fence = await planFence(engine, sourceId, entitySlug, readFileSync(filePath, 'utf-8'), group);
    if ('warnings' in fence) {
      outcome.failed_pages.push(`${entitySlug} (${fence.warnings.join('; ')})`);
      return;
    }
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
    renameSync(tmpPath, filePath);
    // Mirror the file into pages so this run's reconcile and get_page read the
    // new fence (same body-only mirror as fence-write.ts: the row keeps its
    // content_hash, so the next sync re-imports and re-chunks the page).
    const reparsed = parseMarkdown(tmpBody, `${entitySlug}.md`);
    await maintenanceTransaction(engine, async tx => {
      const existing = await tx.getPage(entitySlug, { sourceId });
      if (existing) {
        await tx.refreshPageBody(entitySlug, sourceId, sanitizeText(reparsed.compiled_truth), sanitizeText(reparsed.timeline),
          existing.content_hash || contentHash(existing));
      }
      for (const a of fence.assignments) {
        await tx.executeRaw(
          `UPDATE facts SET row_num = $1, source_markdown_slug = $2
            WHERE id = $3 AND source_id = $4 AND row_num IS NULL`,
          [a.row_num, entitySlug, a.id, sourceId],
        );
      }
    });
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
    await fenceFilePage(engine, sourceId, entitySlug, plan.filePaths.get(key)!, group, plan.outcome, opts.pageLockRoot);
  }
  return plan.outcome;
}
