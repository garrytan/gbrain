/**
 * v0.32.2 migration orchestrator — facts join the system-of-record invariant.
 *
 * Schema migration v51 (src/core/migrate.ts) added the two fence columns
 * (row_num, source_markdown_slug) and the partial UNIQUE index. The
 * orchestrator's job is the data half: walk every existing pre-v51 row
 * in the facts table (row_num IS NULL = "no fence yet") and append it
 * to its entity page's `## Facts` fence, atomically + idempotently.
 *
 * Phases:
 *   A. Schema       — assert migration v51 has run.
 *   B. Fence facts  — backfill DB facts → entity-page fences (dry-run
 *                     by default; explicit --write required).
 *   C. Verify       — re-parse each touched page, count rows, compare
 *                     against the DB rows for that page; partial on
 *                     mismatch.
 *   D. Record       — runner-owned ledger write (apply-migrations.ts).
 *
 * Idempotency: phase B only touches ACTIVE rows with row_num IS NULL
 * (#2646: the backfill predicate is `row_num IS NULL AND expired_at IS
 * NULL` everywhere — dry-run counts, the phase B fetch, the DB stamp,
 * and the drift detection below all agree). Soft-expired legacy rows
 * (what `forget_fact` leaves behind) are never fenced: writing a
 * forgotten claim into a page's fence as an active row would resurrect
 * it in markdown. Re-runs after a partial completion pick up where the
 * previous run stopped. Per-page atomic (.tmp + parse + rename, same
 * primitive as fence-write.ts). Dirty-tree refusal mirrors
 * src/core/dry-fix.ts so the user can review the diff before
 * committing.
 *
 * Facts with NULL entity_slug are structurally unfenceable (no page to
 * fence onto). They're skipped with a warning; the operator decides
 * whether to hand-curate or delete them. Their row_num stays NULL
 * forever; they live in the legacy keyspace permanently.
 *
 * Drift repair (#2646): rows matching the backfill predicate can exist
 * AFTER this migration completed — a lingering pre-fence writer keeps
 * inserting v0.31-shape rows, which the completed backfill never saw,
 * and which permanently trip the extract_facts legacy-row guard.
 * `detectV0_32_2Drift` + the apply-migrations repair lane re-run this
 * orchestrator as a REPAIR when that happens. The completed-migration
 * ledger marker is never touched: "the migration ran" (ledger) and
 * "the DB currently satisfies the post-condition" (drift check) are
 * different statements.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';

import type {
  Migration, OrchestratorOpts, OrchestratorResult, OrchestratorPhaseResult,
} from './types.ts';
import type { BrainEngine } from '../../core/engine.ts';
import { loadConfig, toEngineConfig } from '../../core/config.ts';
import { createEngine } from '../../core/engine-factory.ts';
import { upsertFactRow, parseFactsFence, renderFactsTable } from '../../core/facts-fence.ts';

let testEngineOverride: BrainEngine | null = null;
export function __setTestEngineOverride(engine: BrainEngine | null): void {
  testEngineOverride = engine;
}

async function getEngine(): Promise<BrainEngine | null> {
  if (testEngineOverride) return testEngineOverride;
  try {
    const cfg = loadConfig();
    if (!cfg) return null;
    const engineConfig = toEngineConfig(cfg);
    const engine = await createEngine(engineConfig);
    await engine.connect(engineConfig);
    return engine;
  } catch {
    return null;
  }
}

// ── Phase A — Schema verify ────────────────────────────────

async function phaseASchema(
  engine: BrainEngine | null,
  opts: OrchestratorOpts,
): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'schema', status: 'skipped', detail: 'dry-run' };
  if (!engine) {
    return { name: 'schema', status: 'skipped', detail: 'no_brain_configured' };
  }
  try {
    const versionStr = await engine.getConfig('version');
    const v = parseInt(versionStr || '0', 10);
    if (v < 51) {
      return {
        name: 'schema',
        status: 'failed',
        detail: `expected schema version >= 51 (facts_fence_columns); got ${v}. Run \`gbrain apply-migrations --yes\` to apply.`,
      };
    }
    // Quick post-condition: row_num + source_markdown_slug exist on facts.
    const rows = await engine.executeRaw<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'facts' AND column_name IN ('row_num', 'source_markdown_slug')`,
    );
    if (rows.length < 2) {
      return {
        name: 'schema',
        status: 'failed',
        detail: `expected columns row_num + source_markdown_slug on facts; found ${rows.map(r => r.column_name).join(', ') || 'none'}`,
      };
    }
    return { name: 'schema', status: 'complete' };
  } catch (e) {
    return { name: 'schema', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

// ── Phase B — Fence facts ──────────────────────────────────

interface LegacyFactRow {
  id: string;        // BIGSERIAL — string-typed on the wire for safety
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
}

interface SourceLookup {
  id: string;
  local_path: string | null;
}

interface PhaseBOutcome {
  scanned: number;
  fenced: number;
  skipped_no_entity: number;
  skipped_no_local_path: number;
  /**
   * #2646: active legacy rows whose (claim, source) duplicates a row
   * already assigned on the same page. A fence row_num can only back
   * ONE DB row (partial UNIQUE index), so extras are soft-expired —
   * never hard-deleted — which drains the extract_facts guard while
   * preserving the row as a record.
   */
  expired_duplicates: number;
  /**
   * #2646 (codex P1): fence rows removed again because a concurrent
   * forget_fact expired their DB row between fetch and stamp — the
   * committed fence row was unbacked and would have resurrected a
   * freshly-forgotten claim on the next extract_facts cycle.
   */
  raced_forgets: number;
  pages_touched: number;
  failed_pages: string[];
}

/**
 * #2646: the single backfill-target predicate. Active (not
 * soft-expired) legacy rows only — `forget_fact` soft-expires, so an
 * expired row is an operator's explicit removal and must never be
 * fenced back into markdown. Kept in one place so the dry-run count,
 * the phase B fetch, and the drift detection can never disagree.
 */
const ACTIVE_LEGACY_PREDICATE =
  `row_num IS NULL AND entity_slug IS NOT NULL AND expired_at IS NULL`;

/**
 * Count rows that the v0_32_2 backfill still needs to fence. Exported
 * for the apply-migrations drift-repair lane (#2646) and reused by the
 * dry-run report.
 */
export async function countActiveLegacyRows(engine: BrainEngine): Promise<number> {
  const rows = await engine.executeRaw<{ n: string }>(
    `SELECT COUNT(*) AS n FROM facts WHERE ${ACTIVE_LEGACY_PREDICATE}`,
  );
  return parseInt(rows[0]?.n ?? '0', 10);
}

/**
 * Drift detection for the apply-migrations repair lane (#2646).
 * Returns the active-legacy count, or null when no brain is
 * configured / reachable (detection is best-effort; a missing engine
 * must never block the migration runner).
 */
export async function detectV0_32_2Drift(): Promise<number | null> {
  const engine = await getEngine();
  if (!engine) return null;
  try {
    return await countActiveLegacyRows(engine);
  } catch {
    return null;
  } finally {
    if (!testEngineOverride) {
      // AWAIT the disconnect (codex P2): the caller may open another
      // engine immediately (the repair itself); a fire-and-forget
      // disconnect races the PGLite single-writer lock release — the
      // same race the runner's pre-flight deliberately avoids.
      try { await engine.disconnect(); } catch { /* best-effort */ }
    }
  }
}

/**
 * Dirty-tree refusal: mirror src/core/dry-fix.ts behavior. Refuses to
 * write if any source's local_path has uncommitted changes. Dry-run
 * skips this check (no writes happen anyway).
 */
function isLocalPathDirty(localPath: string): boolean {
  try {
    const out = execFileSync('git', ['-C', localPath, 'status', '--porcelain'], {
      encoding: 'utf-8',
      timeout: 10_000,
    });
    return out.trim().length > 0;
  } catch {
    // Not a git repo OR git not on PATH → treat as "not dirty" (the
    // user opted out of git tracking, which is allowed). The fence
    // writes are still atomic via .tmp + rename.
    return false;
  }
}

async function phaseBFenceFacts(
  engine: BrainEngine | null,
  opts: OrchestratorOpts,
): Promise<OrchestratorPhaseResult & { touchedPages?: string[] }> {
  if (opts.dryRun) {
    // Dry-run: report what WOULD happen without touching FS or DB.
    if (!engine) return { name: 'fence_facts', status: 'skipped', detail: 'no_brain_configured' };
    try {
      // #2646: same active-only predicate as the real fetch below.
      const fenceable = await countActiveLegacyRows(engine);
      const noEntity = await engine.executeRaw<{ n: string }>(
        `SELECT COUNT(*) AS n FROM facts
          WHERE row_num IS NULL AND entity_slug IS NULL AND expired_at IS NULL`,
      );
      const noEntityCount = parseInt(noEntity[0]?.n ?? '0', 10);
      return {
        name: 'fence_facts',
        status: 'skipped',
        detail: `dry-run: would fence ${fenceable} rows; ${noEntityCount} unfenceable (NULL entity_slug)`,
      };
    } catch (e) {
      return { name: 'fence_facts', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
    }
  }

  if (!engine) {
    return { name: 'fence_facts', status: 'skipped', detail: 'no_brain_configured' };
  }

  try {
    // Look up all sources + their local_paths.
    const sources = await engine.executeRaw<SourceLookup>(
      `SELECT id, local_path FROM sources`,
    );
    const localPathById = new Map<string, string | null>();
    for (const s of sources) localPathById.set(s.id, s.local_path);

    // Walk ACTIVE legacy rows (#2646: soft-expired rows are an
    // operator's explicit removal — never fence them back) in
    // (source_id, entity_slug) groups for per-page atomic writes.
    const legacy = await engine.executeRaw<LegacyFactRow>(
      `SELECT id, source_id, entity_slug, fact, kind, visibility, notability,
              context, valid_from, valid_until, source, confidence
         FROM facts
        WHERE ${ACTIVE_LEGACY_PREDICATE}
        ORDER BY source_id, entity_slug, id`,
    );
    // NULL-entity rows are excluded from the fetch by the predicate;
    // count them separately (active only) so the report still names
    // the structurally-unfenceable backlog.
    const noEntityRows = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*) AS n FROM facts
        WHERE row_num IS NULL AND entity_slug IS NULL AND expired_at IS NULL`,
    );

    const outcome: PhaseBOutcome = {
      scanned: legacy.length,
      fenced: 0,
      skipped_no_entity: parseInt(noEntityRows[0]?.n ?? '0', 10),
      skipped_no_local_path: 0,
      expired_duplicates: 0,
      raced_forgets: 0,
      pages_touched: 0,
      failed_pages: [],
    };

    // Group by (source_id, entity_slug) so each page's fence is updated
    // atomically with all its legacy rows.
    const groups = new Map<string, LegacyFactRow[]>();
    for (const row of legacy) {
      const localPath = localPathById.get(row.source_id);
      if (!localPath) {
        outcome.skipped_no_local_path += 1;
        continue;
      }
      const key = `${row.source_id}\0${row.entity_slug}`;
      const list = groups.get(key) ?? [];
      list.push(row);
      groups.set(key, list);
    }

    // Dirty-tree refusal: check ONLY the sources we are about to write
    // into. A dirty tree in an unrelated source (or zero fenceable rows
    // at all) must not block a no-op or a targeted backfill (#927).
    const targetSourceIds = new Set([...groups.keys()].map(k => k.split('\0')[0]));
    for (const id of targetSourceIds) {
      const localPath = localPathById.get(id);
      if (localPath && isLocalPathDirty(localPath)) {
        return {
          name: 'fence_facts',
          status: 'failed',
          detail: `source "${id}" has uncommitted changes in ${localPath}. Commit or stash, then re-run.`,
        };
      }
    }

    // #2646: pages this run actually rewrote, as `source_id\0slug` keys.
    // Phase C scopes its verification to these (verdict: the migration's
    // post-condition is about the pages IT touched, not every fenced
    // page in the brain — unrelated pre-existing drift belongs to
    // doctor, and failing verify on it wedged legitimate runs).
    const touchedPages: string[] = [];

    for (const [key, group] of groups) {
      const [sourceId, entitySlug] = key.split('\0');
      const localPath = localPathById.get(sourceId)!;
      const filePath = join(localPath, `${entitySlug}.md`);
      const tmpPath = `${filePath}.tmp`;

      try {
        // Read existing body or stub-create with minimum frontmatter.
        let body: string;
        if (existsSync(filePath)) {
          body = readFileSync(filePath, 'utf-8');
        } else {
          mkdirSync(dirname(filePath), { recursive: true });
          const prefix = entitySlug.split('/')[0];
          const type =
            prefix === 'people'    ? 'person' :
            prefix === 'companies' ? 'company' :
            prefix === 'deals'     ? 'deal' :
            /* fallback */           'concept';
          const tail = entitySlug.split('/').slice(1).join('/');
          const title = tail.replace(/[-_/]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || entitySlug;
          body = `---\ntype: ${type}\ntitle: ${title}\nslug: ${entitySlug}\n---\n\n# ${title}\n`;
        }

        // Append each legacy row, collecting the assigned row_nums.
        // Already-fenced rows (row_num already set) are skipped at the
        // DB-row level by the WHERE clause, but if the SAME (entity,
        // source, claim, source-text) tuple was previously appended in
        // a partial-completion re-run, parseFactsFence will see the
        // existing row and append a duplicate. We dedup on (claim,
        // source) before append to handle this.
        //
        // #2646: each existing fence row_num is a QUEUE consumed at
        // most once. The old find()-based lookup handed the SAME
        // row_num to every DB row sharing a (claim, source) key, and
        // the second UPDATE then violated the partial UNIQUE index on
        // (source_id, source_markdown_slug, row_num) — leaving the
        // group permanently half-stamped. Rows left over once their
        // key's queue is exhausted AND the key was already assigned
        // this run are true duplicates: soft-expired (never
        // hard-deleted), which drains the extract_facts guard while
        // preserving the row as a record.
        const existingFence = parseFactsFence(body);

        // Fence row_nums already claimed by a stamped DB row are NOT
        // available — handing one out again would collide on the
        // partial UNIQUE index (the mid-stamp interruption case: the
        // rename committed, some rows stamped, the process died).
        // Their keys still count as "already assigned" so a leftover
        // duplicate legacy row is expired, not re-appended.
        const takenRows = await engine.executeRaw<{ row_num: number | string }>(
          `SELECT row_num FROM facts
            WHERE source_id = $1 AND source_markdown_slug = $2 AND row_num IS NOT NULL`,
          [sourceId, entitySlug],
        );
        const takenRowNums = new Set(takenRows.map(r => Number(r.row_num)));

        const availableByKey = new Map<string, number[]>();
        const backedKeys = new Set<string>();
        for (const f of existingFence.facts) {
          const key = `${f.claim}\0${f.source ?? ''}`;
          if (takenRowNums.has(f.rowNum)) {
            backedKeys.add(key);
            continue;
          }
          const queue = availableByKey.get(key) ?? [];
          queue.push(f.rowNum);
          availableByKey.set(key, queue);
        }

        const assignments: Array<{ id: string; row_num: number }> = [];
        const duplicateIds: string[] = [];
        const assignedKeys = new Set<string>(backedKeys);
        for (const row of group) {
          const key = `${row.fact}\0${row.source ?? ''}`;
          const queue = availableByKey.get(key);
          if (queue && queue.length > 0) {
            // Already fenced (idempotent re-run) — consume one fence
            // row_num for this DB row.
            assignments.push({ id: row.id, row_num: queue.shift()! });
            assignedKeys.add(key);
            continue;
          }
          if (assignedKeys.has(key)) {
            // Duplicate legacy row: its (claim, source) is already
            // backed by a DB row this run. Soft-expire below.
            duplicateIds.push(row.id);
            continue;
          }
          // Append a new row.
          const validFromStr = (row.valid_from instanceof Date ? row.valid_from : new Date(row.valid_from))
            .toISOString().slice(0, 10);
          const validUntilStr = row.valid_until
            ? (row.valid_until instanceof Date ? row.valid_until : new Date(row.valid_until))
                .toISOString().slice(0, 10)
            : undefined;
          const { body: updated, rowNum } = upsertFactRow(body, {
            claim:      row.fact,
            kind:       row.kind,
            confidence: row.confidence,
            visibility: row.visibility,
            notability: row.notability,
            validFrom:  validFromStr,
            validUntil: validUntilStr,
            source:     row.source,
            context:    row.context ?? undefined,
          });
          body = updated;
          assignedKeys.add(key);
          assignments.push({ id: row.id, row_num: rowNum });
        }

        // Atomic write: .tmp + parse + rename.
        writeFileSync(tmpPath, body, 'utf-8');
        const tmpBody = readFileSync(tmpPath, 'utf-8');
        const parsed = parseFactsFence(tmpBody);
        if (parsed.warnings.length > 0) {
          outcome.failed_pages.push(`${entitySlug} (${parsed.warnings.join('; ')})`);
          // .tmp stays for inspection; do NOT rename.
          continue;
        }
        renameSync(tmpPath, filePath);

        // UPDATE the DB rows with their new row_nums + source_markdown_slug.
        // #2646: the `row_num IS NULL AND expired_at IS NULL` guard makes
        // the stamp race-safe against a concurrent forget_fact — a row
        // expired between our fetch and this UPDATE stays expired-legacy
        // instead of being revived as an active fence row. RETURNING id
        // tells us whether the stamp actually landed.
        const unbackedRowNums: number[] = [];
        let stampedCount = 0;
        for (const a of assignments) {
          const stamped = await engine.executeRaw<{ id: string }>(
            `UPDATE facts SET row_num = $1, source_markdown_slug = $2
              WHERE id = $3 AND row_num IS NULL AND expired_at IS NULL
              RETURNING id`,
            [a.row_num, entitySlug, a.id],
          );
          if (stamped.length > 0) { stampedCount += 1; continue; }
          // Zero rows stamped: the row changed under us between fetch
          // and stamp. If it is now expired (a concurrent forget_fact
          // won the race), the fence row we just committed is unbacked
          // AND represents a claim the operator explicitly removed —
          // leaving it would let the next extract_facts cycle
          // resurrect the forgotten fact from markdown (codex P1).
          // Collect it for removal below. If instead the row was
          // stamped by a concurrent run, the fence row IS backed —
          // leave it alone.
          const current = await engine.executeRaw<{ row_num: number | string | null; expired_at: Date | null }>(
            `SELECT row_num, expired_at FROM facts WHERE id = $1`,
            [a.id],
          );
          const cur = current[0];
          if (cur && cur.row_num === null && cur.expired_at !== null) {
            unbackedRowNums.push(a.row_num);
          }
        }

        // Remove fence rows orphaned by a raced forget: re-read the
        // canonical file, drop those row_nums, and rewrite with the
        // same atomic .tmp + parse + rename primitive.
        if (unbackedRowNums.length > 0) {
          const unbackedSet = new Set(unbackedRowNums);
          const currentBody = readFileSync(filePath, 'utf-8');
          const currentParsed = parseFactsFence(currentBody);
          const kept = currentParsed.facts.filter(f => !unbackedSet.has(f.rowNum));
          const newFence = renderFactsTable(kept);
          const begin = currentBody.indexOf('<!--- gbrain:facts:begin -->');
          const end   = currentBody.indexOf('<!--- gbrain:facts:end -->', begin + 1);
          if (begin !== -1 && end !== -1) {
            const cleanedBody =
              currentBody.slice(0, begin) + newFence +
              currentBody.slice(end + '<!--- gbrain:facts:end -->'.length);
            writeFileSync(tmpPath, cleanedBody, 'utf-8');
            const cleanedParsed = parseFactsFence(readFileSync(tmpPath, 'utf-8'));
            if (cleanedParsed.warnings.length === 0) {
              renameSync(tmpPath, filePath);
            }
          }
          outcome.raced_forgets += unbackedRowNums.length;
        }
        // #2646: soft-expire duplicate legacy rows (same guard — an
        // already-expired or already-stamped row is left alone).
        for (const id of duplicateIds) {
          await engine.executeRaw(
            `UPDATE facts SET expired_at = now()
              WHERE id = $1 AND row_num IS NULL AND expired_at IS NULL`,
            [id],
          );
        }
        outcome.expired_duplicates += duplicateIds.length;
        outcome.fenced += stampedCount;
        outcome.pages_touched += 1;
        touchedPages.push(key);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        outcome.failed_pages.push(`${entitySlug} (${msg})`);
      }
    }

    const detail = `scanned=${outcome.scanned} fenced=${outcome.fenced} ` +
      `pages=${outcome.pages_touched} skipped_no_entity=${outcome.skipped_no_entity} ` +
      `skipped_no_local_path=${outcome.skipped_no_local_path}` +
      (outcome.expired_duplicates > 0 ? ` expired_duplicates=${outcome.expired_duplicates}` : '') +
      (outcome.raced_forgets > 0 ? ` raced_forgets=${outcome.raced_forgets}` : '') +
      (outcome.failed_pages.length > 0 ? ` failed=${outcome.failed_pages.length}` : '');

    if (outcome.failed_pages.length > 0) {
      return {
        name: 'fence_facts',
        status: 'failed',
        detail: `${detail} :: ${outcome.failed_pages.slice(0, 3).join(' | ')}${outcome.failed_pages.length > 3 ? '...' : ''}`,
        touchedPages,
      };
    }
    return { name: 'fence_facts', status: 'complete', detail, touchedPages };
  } catch (e) {
    return { name: 'fence_facts', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

// ── Phase C — Verify ────────────────────────────────────────

async function phaseCVerify(
  engine: BrainEngine | null,
  opts: OrchestratorOpts,
  touchedPages?: string[],
): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'verify', status: 'skipped', detail: 'dry-run' };
  if (!engine) return { name: 'verify', status: 'skipped', detail: 'no_brain_configured' };

  try {
    // Per touched page (= any page with a fenced row in the DB), re-parse
    // the fence from disk and compare row counts to the DB.
    //
    // #2646: when the caller passes the pages phase B actually rewrote,
    // verification is scoped to THOSE — the migration's post-condition
    // is about what it touched this run. Pre-existing drift on
    // unrelated pages belongs to doctor; failing verify on it turned
    // legitimate (re)runs partial forever. Callers that pass nothing
    // (legacy tests, standalone use) keep the full-brain walk.
    const sources = await engine.executeRaw<SourceLookup>(
      `SELECT id, local_path FROM sources`,
    );
    const localPathById = new Map<string, string | null>();
    for (const s of sources) localPathById.set(s.id, s.local_path);

    const allGroups = await engine.executeRaw<{ source_id: string; source_markdown_slug: string; n: string }>(
      `SELECT source_id, source_markdown_slug, COUNT(*) AS n
         FROM facts
        WHERE row_num IS NOT NULL
        GROUP BY source_id, source_markdown_slug`,
    );
    const touchedSet = touchedPages !== undefined ? new Set(touchedPages) : null;
    const groups = touchedSet === null
      ? allGroups
      : allGroups.filter(g => touchedSet.has(`${g.source_id}\0${g.source_markdown_slug}`));

    const mismatches: string[] = [];
    let pagesChecked = 0;

    for (const g of groups) {
      const localPath = localPathById.get(g.source_id);
      if (!localPath) continue;
      const filePath = join(localPath, `${g.source_markdown_slug}.md`);
      if (!existsSync(filePath)) {
        mismatches.push(`${g.source_markdown_slug} (file missing)`);
        continue;
      }
      const body = readFileSync(filePath, 'utf-8');
      const parsed = parseFactsFence(body);
      const fenceCount = parsed.facts.length;
      const dbCount = parseInt(g.n, 10);
      if (fenceCount !== dbCount) {
        mismatches.push(`${g.source_markdown_slug} (fence=${fenceCount}, db=${dbCount})`);
      }
      pagesChecked += 1;
    }

    if (mismatches.length > 0) {
      return {
        name: 'verify',
        status: 'failed',
        detail: `${mismatches.length} pages drifted: ${mismatches.slice(0, 3).join(' | ')}${mismatches.length > 3 ? '...' : ''}`,
      };
    }
    // #2646: surface the remaining active-legacy backlog as part of the
    // post-condition report. Non-zero is NOT a failure here — rows can
    // legitimately remain (skipped_no_local_path) — but the repair lane
    // and the operator need the number to know whether the
    // extract_facts guard will release.
    const remaining = await countActiveLegacyRows(engine);
    return {
      name: 'verify',
      status: 'complete',
      detail: `pages_checked=${pagesChecked} active_legacy_remaining=${remaining}`,
    };
  } catch (e) {
    return { name: 'verify', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

// ── Orchestrator ────────────────────────────────────────────

async function orchestrator(opts: OrchestratorOpts): Promise<OrchestratorResult> {
  console.log('');
  console.log('=== v0.32.2 — facts join the system-of-record invariant ===');
  if (opts.dryRun) console.log('  (dry-run; no side effects)');
  console.log('');

  const engine = await getEngine();
  const phases: OrchestratorPhaseResult[] = [];

  const a = await phaseASchema(engine, opts);
  phases.push(a);
  if (a.status === 'failed') return finalizeResult(phases, 'failed', engine);

  const b = await phaseBFenceFacts(engine, opts);
  // Strip the internal touchedPages field before the result reaches the
  // ledger — it's a phase-B→C wiring detail, not a persisted record.
  phases.push({ name: b.name, status: b.status, detail: b.detail });
  if (b.status === 'failed') return finalizeResult(phases, 'failed', engine);

  const c = await phaseCVerify(engine, opts, b.touchedPages);
  phases.push(c);

  const overallStatus: 'complete' | 'partial' | 'failed' =
    c.status === 'failed' ? 'partial' : 'complete';

  return finalizeResult(phases, overallStatus, engine);
}

async function finalizeResult(
  phases: OrchestratorPhaseResult[],
  status: 'complete' | 'partial' | 'failed',
  engine: BrainEngine | null,
): Promise<OrchestratorResult> {
  // Best-effort disconnect of the engine we created. testEngineOverride
  // is owned by the test, never disconnected here. AWAITED (#2646 codex
  // round-2 P2): the apply-migrations repair lane opens another engine
  // right after the orchestrator returns (the post-repair recount); a
  // fire-and-forget disconnect races the PGLite single-writer lock
  // release and can turn a successful repair into a false
  // "could not be verified" exit 1.
  if (engine && !testEngineOverride) {
    try { await engine.disconnect(); } catch { /* best-effort */ }
  }
  return {
    version: '0.32.2',
    status,
    phases,
  };
}

export const v0_32_2: Migration = {
  version: '0.32.2',
  featurePitch: {
    headline: 'Facts join the system-of-record — your hot memory now lives in markdown, indexed by the DB',
    description:
      'v0.31 added hot-memory facts but they lived only in the database. v0.32.2 makes the ' +
      'fenced `## Facts` table on each entity page canonical: every new fact writes to markdown ' +
      'first, then stamps the DB index. Existing v0.31 facts are backfilled to fences on this ' +
      'migration. `gbrain rebuild` (v0.32.3) becomes a one-line disaster-recovery flow because ' +
      'the DB is now fully derivable from the repo. Migration is dry-run by default; pass ' +
      '`--write` to apply.',
  },
  orchestrator,
};

/** Exported for unit tests. */
export const __testing = {
  phaseASchema,
  phaseBFenceFacts,
  phaseCVerify,
  isLocalPathDirty,
};
