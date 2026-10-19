/**
 * v0.35.5 — phantom-page redirect pass.
 *
 * Runs at the top of `extract_facts` after the legacy-row guard, BEFORE
 * the main reconcile loop. Walks unprefixed-slug pages in the source
 * (e.g. `alice.md` at brain root), tries to resolve each to a canonical
 * prefixed slug (`people/alice-example`), migrates fact rows + disk
 * fence, soft-deletes the phantom, unlinks the `.md`. Bounded at 50
 * phantoms per cycle (configurable via `GBRAIN_PHANTOM_REDIRECT_LIMIT`).
 *
 * Reuses existing infrastructure where it can: `softDeletePage`, the shared
 * write-target resolver (`resolvePageWriteTarget`, so the canonical fence
 * lands in the page's file of record), `recordRenameAlias`, fence parser.
 * The merge is lossless: `resolvePhantomCanonical` bypasses
 * `resolveEntitySlug`'s exact-self-match step and takes a fuzzy hit only
 * with a clear margin, a canonical that disagrees with the single prefix
 * candidate is ambiguous, every phantom fact row moves to the canonical by
 * id (rows appended to the canonical fence take exactly the row numbers
 * written to disk; history and duplicates move expired and detached, never
 * deleted), `superseded by #N` references follow the renumber, the
 * phantom's links move to the canonical page id, and the phantom slug is
 * recorded in `slug_aliases`.
 *
 * Lock contract: single `gbrain-sync` writer-lock acquisition at the top
 * of the pass, held across all up-to-50 phantoms. Single 30s timeout.
 * On contention, the entire pass skips this cycle with one audit entry
 * (`pass_skipped_lock_busy`); next cycle retries.
 *
 * Idempotency: re-run on a half-redirected phantom is safe — the
 * migration UPDATE matches no rows (already migrated), the disk-side
 * fence append dedups by (claim, valid_from), and every other step is
 * idempotent (softDelete is no-op on already-deleted, unlink is ENOENT-
 * safe).
 */

import type { Action } from '../agent-output.ts';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { BrainEngine } from '../engine.ts';
import { contentHash } from '../utils.ts';
import { assertInlineBody } from '../page-body/page-shape.ts';
import type { Page } from '../types.ts';
import {
  resolvePhantomCanonical,
  findPrefixCandidates,
} from '../entities/resolve.ts';
import {
  parseFactsFence,
  renderFactsTable,
  replaceOrInsertFactsFence,
  FACTS_FENCE_BEGIN,
  FACTS_FENCE_END,
  type ParsedFact,
} from '../facts-fence.ts';
import { locateOutsideCode } from '../fence-scan.ts';
import { assertFenceRewritable } from '../fence-shared.ts';
import { parseMarkdown, splitBody, serializeMarkdown } from '../markdown.ts';
import { tryAcquireDbLock, syncLockId, type DbLockHandle } from '../db-lock.ts';
import { isAborted } from '../abort-check.ts';
import { logPhantomEvent, type PhantomOutcome } from '../facts/phantom-audit.ts';
import { MOVE_WITHDRAWAL_SUBJECT_SQL } from '../facts/withdrawal-schema.ts';
import { isWriteThroughDisabled, resolvePageWriteTarget } from '../write-through.ts';
import { fileBodyMatchesStored, fileDatabaseDriftToken, mirrorFileBody, readStoredBody, replaceStoredBody, replaceableFile } from '../facts/file-body-guard.ts';
import { recordRenameAlias } from '../page-state/rename-alias.ts';
import { maintenanceTransaction } from '../persistence/attribution.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import { ItemRun } from '../item-failure.ts';
import { rotationAfter, saveRotation } from '../repair/rotation.ts';

/** Tagged-union outcome of a single phantom-redirect attempt. */
export type RedirectOutcome =
  | 'not_phantom'
  | 'redirected'
  | 'ambiguous'
  | 'drift'
  | 'no_canonical';

/** Result envelope for the single-phantom handler. */
export interface RedirectResult {
  outcome: RedirectOutcome;
  /** Canonical slug, populated only on outcome === 'redirected' (incl. dry-run preview). */
  canonical?: string;
  /** #6982: the `file_database_drift` entry when a file or database body was left in place (with outcome drift, or a kept phantom file). */
  held?: string;
}

export interface PhantomPassResult {
  scanned: number;
  redirected: number;
  ambiguous: number;
  skipped_drift: number;
  no_canonical: number;
  not_phantom: number;
  /**
   * #6650: top-level pages held this pass because they own legacy (unfenced)
   * fact rows: the redirect moves rows by fence position and would strand
   * them on the deleted phantom. Every other phantom of the source proceeds.
   */
  held_legacy_rows: number;
  /** #6982: `<slug> (file_database_drift: …)` entries for pages whose file or database body the pass left in place, each with its fix. */
  held: string[];
  /** True iff the pass was skipped wholesale because the writer lock was busy. */
  lock_busy: boolean;
  /** True iff live root pages remain after this pass's window; the next pass resumes after the last slug examined. */
  more_pending: boolean;
  /** Root pages whose redirect threw an item-scoped error this pass; each is retried when the cursor next reaches it. */
  failures: Array<{ key: string; code: string; message: string; fix: Action }>;
  /** Set when most examined pages failed (item_failures_systemic): the pass stopped and its cursor did not move. */
  stopped?: { code: string; message: string };
  /**
   * Canonical slugs whose disk fence was merged with phantom rows this pass.
   * `extract_facts`'s main reconcile loop UNIONs these into its slug set so
   * the canonical's DB facts derive from the just-merged fence — without
   * this, scenario B (phantom has only-on-disk fence, no DB facts yet) would
   * leave canonical's DB facts stale until the next full-walk cycle.
   *
   * Scenario A (phantom HAD DB facts that migrateFactsToCanonical moved) is
   * also covered: the main loop's reconcile wipes+reinserts the migrated
   * rows from the merged fence, dropping the embedding column. That's the
   * same fence→DB roundtrip extract_facts already performs every cycle, so
   * it's not a phantom-redirect-specific regression.
   */
  touched_canonicals: string[];
}

const DEFAULT_PHANTOM_LIMIT = 50;
/** op_checkpoints op (fingerprint: source id) holding the last root slug a pass examined; '' after a pass reaches the end. */
export const PHANTOM_REDIRECT_CURSOR_OP = 'phantom-redirect-cursor';
const LOCK_TTL_MINUTES = 5;
const LOCK_RETRY_INTERVAL_MS = 1000;
const LOCK_TOTAL_TIMEOUT_MS = 30_000;

/** Empty counters helper (used by the legacy-guard fast-path in extract-facts). */
export function emptyPhantomPassResult(): PhantomPassResult {
  return {
    scanned: 0,
    redirected: 0,
    ambiguous: 0,
    skipped_drift: 0,
    no_canonical: 0,
    not_phantom: 0,
    held_legacy_rows: 0,
    held: [],
    lock_busy: false,
    more_pending: false,
    failures: [],
    touched_canonicals: [],
  };
}

/**
 * Strip frontmatter (already absent from `compiled_truth`), the leading H1
 * heading, and the entire `## Facts` fenced block. Returns the residue
 * with whitespace trimmed. Used by the body-shape gate (codex #2).
 *
 * Real top-level pages have prose / lists / paragraphs that aren't fenced
 * facts and aren't a one-line H1. Phantoms have only the stub shape
 * (`# alice` + maybe a facts fence). Zero-length residue is the gate.
 *
 * The fence strip walks both fence-marker pairs (with the leading
 * `## Facts` heading if present) so a phantom with just a facts table
 * still gates as empty residue.
 */
export function stripFenceAndFrontmatterAndLeadingH1(body: string): string {
  if (!body) return '';
  let working = body;

  // 1. Strip the entire `## Facts\n\n<fence>...<fence>` block. We grab
  //    the `## Facts` heading too (with surrounding blank lines) so the
  //    section header doesn't count as residue.
  const located = locateOutsideCode(working, FACTS_FENCE_BEGIN, FACTS_FENCE_END);
  const beginIdx = located.beginIdx;
  const endIdx = beginIdx >= 0 ? located.endIdx : -1;
  if (beginIdx !== -1 && endIdx !== -1) {
    // Walk backward from beginIdx to swallow a leading `## Facts\n\n`
    // (or `## facts\n\n` — case-insensitive markdown headings).
    let headingStart = beginIdx;
    // Skip whitespace-only lines before the marker.
    while (headingStart > 0 && working[headingStart - 1] !== '\n') headingStart--;
    // Walk back over the blank line(s).
    while (headingStart > 0) {
      const prevLineEnd = headingStart - 1;
      const prevLineStart = working.lastIndexOf('\n', prevLineEnd - 1) + 1;
      const prevLine = working.slice(prevLineStart, prevLineEnd);
      if (prevLine.trim() === '') {
        headingStart = prevLineStart;
        continue;
      }
      if (/^#{1,6}\s+facts\b/i.test(prevLine)) {
        headingStart = prevLineStart;
      }
      break;
    }
    working = working.slice(0, headingStart)
      + working.slice(endIdx + FACTS_FENCE_END.length);
  }

  // 2. Strip the leading H1 (` # text\n` at the very top — phantom stubs
  //    open with `# <slug>`).
  working = working.replace(/^\s*#\s+[^\n]*\n?/, '');

  // 3. Whitespace-trim. Empty (or only whitespace) is the gate.
  return working.trim();
}

/**
 * Block-on-busy lock acquisition with bounded retry. Returns null when
 * total timeout elapses without a successful acquire.
 */
async function acquireLockWithRetry(
  engine: BrainEngine,
  lockId: string,
  signal?: AbortSignal,
): Promise<DbLockHandle | null> {
  const deadline = Date.now() + LOCK_TOTAL_TIMEOUT_MS;
  let handle = await tryAcquireDbLock(engine, lockId, LOCK_TTL_MINUTES);
  while (!handle) {
    // #1972: bail immediately on abort instead of retrying for the full 30s —
    // otherwise this loop alone can blow past the worker's 30s force-evict.
    if (isAborted(signal)) return null;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_INTERVAL_MS));
    handle = await tryAcquireDbLock(engine, lockId, LOCK_TTL_MINUTES);
  }
  return handle;
}

/**
 * Append the phantom's fact rows to the canonical's file of record, dedup-
 * guarded by (claim, valid_from), and mirror the file into the canonical's
 * database body. Atomic via `.tmp` + rename.
 *
 * New rows number from past both the file's and the DB's highest row number
 * (the DB may hold numbers the file lost), and `superseded by #N` references
 * are rewritten to the canonical numbering. Returns the phantom row number
 * -> canonical row number map, including rows that dedup onto an existing
 * canonical fence row (a retry after a crash between the disk write and the
 * DB move finds every row already on disk).
 *
 * #6982: the rows are planned on the file only when its body and timeline
 * equal the canonical's database body, so the mirror can only add them. The
 * canonical row is then locked and re-read in a maintenance transaction: when
 * the database body moved since the comparison, nothing is written and the
 * phantom is held (`file_database_drift`). Otherwise the prior body is kept in
 * page_versions, the body is mirrored and stamped with the hash the importer
 * computes for the new file, and the file is re-read immediately before the
 * `.tmp` is renamed last: a file that moved rolls the transaction back and
 * holds the phantom the same way.
 * A parse-validation failure throws before any DB state has moved.
 */
async function mergeIntoCanonicalFile(
  engine: BrainEngine,
  phantomSlug: string,
  canonical: string,
  sourceId: string,
  canonicalPath: string,
  phantomFacts: ParsedFact[],
  dbMaxRowNum: number,
): Promise<{ renumber: Map<number, number> } | { held: string }> {
  if (phantomFacts.length === 0) return { renumber: new Map<number, number>() };
  await materializeCanonicalToDisk(engine, canonical, sourceId, canonicalPath);
  const bytes = fs.readFileSync(canonicalPath, 'utf-8');
  const { body: newBody, renumber } = mergePhantomFenceRows(bytes, phantomFacts, dbMaxRowNum);
  const stored = await readStoredBody(engine, sourceId, canonical);
  if (stored && !fileBodyMatchesStored(bytes, canonical, stored)) return { held: canonicalDriftToken(canonical, phantomSlug, sourceId, 'before') };
  if (newBody === null) return { renumber };

  const tmpPath = `${canonicalPath}.tmp`;
  fs.writeFileSync(tmpPath, newBody, 'utf-8');
  const reparsed = parseFactsFence(newBody);
  if (reparsed.warnings.length > 0) {
    // Leave .tmp as quarantine evidence; do NOT rename.
    throw new Error(
      `phantom-redirect: rendered fence failed re-parse: ${reparsed.warnings.join('; ')}`,
    );
  }
  if (!stored) {
    fs.renameSync(tmpPath, canonicalPath);
    return { renumber };
  }
  const parsed = parseMarkdown(newBody, `${canonical}.md`);
  const hash = contentHash({ title: parsed.title, type: parsed.type, compiled_truth: parsed.compiled_truth, timeline: parsed.timeline,
    frontmatter: parsed.frontmatter, tags: await engine.getTags(canonical, { sourceId }) });
  const fileMoved = new Error('canonical file changed during the phantom redirect');
  const written = await maintenanceTransaction(engine, async tx => {
    if (!await mirrorFileBody(tx, sourceId, canonical, newBody, stored, hash)) return false;
    if (fs.readFileSync(canonicalPath, 'utf-8') !== bytes) throw fileMoved;
    fs.renameSync(tmpPath, canonicalPath);
    return true;
  }).catch(err => { if (err === fileMoved) return false; throw err; });
  if (written) return { renumber };
  fs.rmSync(tmpPath, { force: true });
  return { held: canonicalDriftToken(canonical, phantomSlug, sourceId, 'during') };
}

/**
 * #6982, write-through off: the database is the copy of record, so the
 * phantom's rows merge into the canonical's database body under a row lock,
 * keeping the prior body in page_versions; no file is read or written. A body
 * that moved since it was read holds the phantom.
 */
async function mergeIntoCanonicalBody(
  engine: BrainEngine,
  canonical: Page | null,
  sourceId: string,
  phantomFacts: ParsedFact[],
  dbMaxRowNum: number,
): Promise<{ renumber: Map<number, number> } | { held: string }> {
  const expected = canonical && await readStoredBody(engine, sourceId, canonical.slug);
  if (!canonical || !expected) throw new Error('canonical page is gone');
  const { body, renumber } = mergePhantomFenceRows(expected.compiled_truth ?? '', phantomFacts, dbMaxRowNum);
  if (body === null) return { renumber };
  const written = await maintenanceTransaction(engine, tx =>
    replaceStoredBody(tx, sourceId, canonical.slug, { compiled_truth: body, timeline: expected.timeline ?? '' }, expected));
  return written ? { renumber } : { held: fileDatabaseDriftToken(canonical.slug, sourceId, 'during', 'the phantom was not redirected; the next cycle retries', 'the phantom redirect') };
}

/** #6982: the hold entry for a phantom whose canonical file and database body differ (or moved during the redirect). */
function canonicalDriftToken(canonical: string, phantomSlug: string, sourceId: string, when: 'before' | 'during'): string {
  return fileDatabaseDriftToken(canonical, sourceId, when, `the phantom ${phantomSlug} was not redirected`, 'the phantom redirect');
}

/** #6982: the hold entry for a phantom whose own file holds content its database row lacks (or changed before the unlink). */
function phantomFileDriftToken(phantomSlug: string, sourceId: string, when: 'before' | 'during'): string {
  return fileDatabaseDriftToken(phantomSlug, sourceId, when, when === 'before' ? 'the phantom was not redirected'
    : 'the redirect moved its rows to the canonical page but kept the file, which sync imports again as a page until the user deletes it', 'the phantom redirect');
}

/** A phantom left in place by a `file_database_drift` hold: audited as drift and reported by the pass. */
function driftHold(phantomSlug: string, sourceId: string, canonical: string, held: string): RedirectResult {
  logPhantomEvent({ phantom_slug: phantomSlug, outcome: 'drift', source_id: sourceId, reason: held.slice(0, 200) });
  return { outcome: 'drift', canonical, held };
}

/**
 * The canonical body with the phantom's rows appended (null when every row
 * dedups onto an existing canonical row) and the phantom -> canonical row
 * number map. Shared by the file writer above and the managed redirect.
 * Throws `FenceRewriteRefusal` when the canonical fence does not parse
 * cleanly; the pass records the phantom as `drift` and moves nothing.
 */
export function mergePhantomFenceRows(
  body: string,
  phantomFacts: ParsedFact[],
  dbMaxRowNum: number,
): { body: string | null; renumber: Map<number, number> } {
  const renumber = new Map<number, number>();
  const parsed = parseFactsFence(body);
  // Re-rendering a canonical fence the parser skipped rows of would delete them.
  assertFenceRewritable('facts', parsed);
  const existingFacts = parsed.facts;

  // Dedup key combines claim + valid_from. We deliberately do NOT include
  // valid_until or status in the key so that a "fact about Alice" already
  // present at canonical doesn't get duplicated even if the strike-through
  // state differs between phantom and canonical (the operator can
  // reconcile manually after redirect).
  const existingByKey = new Map(existingFacts.map((f) => [`${f.claim}|${f.validFrom ?? ''}`, f.rowNum]));
  let nextRowNum = Math.max(dbMaxRowNum, 0, ...existingFacts.map((f) => f.rowNum)) + 1;

  const pending: ParsedFact[] = [];
  for (const pf of phantomFacts) {
    const key = `${pf.claim}|${pf.validFrom ?? ''}`;
    const existing = existingByKey.get(key);
    if (existing !== undefined) {
      renumber.set(pf.rowNum, existing);
      continue;
    }
    renumber.set(pf.rowNum, nextRowNum);
    existingByKey.set(key, nextRowNum);
    pending.push({ ...pf, rowNum: nextRowNum });
    nextRowNum += 1;
  }

  if (pending.length === 0) return { body: null, renumber };

  const merged: ParsedFact[] = [...existingFacts, ...pending.map((f) => {
    const target = f.supersededBy === undefined ? undefined : renumber.get(f.supersededBy);
    if (target === undefined) return f;
    return { ...f, supersededBy: target, context: f.context?.replace(/superseded by #\d+/i, `superseded by #${target}`) };
  })];

  // Shared placement rule (#4756): replace in place, else insert ABOVE the
  // timeline sentinel — never a blind EOF append below `## Timeline`.
  return { body: replaceOrInsertFactsFence(body, renderFactsTable(merged)), renumber };
}

/**
 * Move every phantom fact row to the canonical in one transaction, keeping
 * ids, embeddings and history. A row takes exactly the canonical row number
 * its fence row has on disk, so the canonical's next reconcile matches it
 * instead of replacing it. A row whose number the canonical index already
 * holds (a duplicate of a canonical fact) or that is absent from the fence
 * moves expired and detached (row_num NULL) instead of being deleted.
 * Returns the number of rows that moved into the canonical fence.
 */
async function migratePhantomFacts(
  engine: BrainEngine,
  sourceId: string,
  phantomSlug: string,
  canonicalSlug: string,
  rowMap: ReadonlyMap<number, number>,
): Promise<number> {
  return maintenanceTransaction(engine, tx => movePhantomFacts(tx, sourceId, phantomSlug, canonicalSlug, rowMap));
}

/** The body of migratePhantomFacts inside the caller's transaction. */
export async function movePhantomFacts(
  tx: BrainEngine,
  sourceId: string,
  phantomSlug: string,
  canonicalSlug: string,
  rowMap: ReadonlyMap<number, number>,
): Promise<number> {
  const rows = await tx.executeRaw<{ id: number; row_num: number | null }>(
    'SELECT id, row_num FROM facts WHERE source_id = $1 AND source_markdown_slug = $2',
    [sourceId, phantomSlug],
  );
  const taken = new Set((await tx.executeRaw<{ row_num: number }>(
    'SELECT row_num FROM facts WHERE source_id = $1 AND source_markdown_slug = $2 AND row_num IS NOT NULL',
    [sourceId, canonicalSlug],
  )).map(r => Number(r.row_num)));
  let moved = 0;
  for (const row of rows) {
    const mapped = row.row_num == null ? undefined : rowMap.get(Number(row.row_num));
    const target = mapped !== undefined && !taken.has(mapped) ? mapped : undefined;
    if (target !== undefined) {
      taken.add(target);
      moved += 1;
    }
    await tx.executeRaw(
      `UPDATE facts SET entity_slug = $3, source_markdown_slug = $3, row_num = $4::integer,
          expired_at = CASE WHEN $4::integer IS NULL THEN COALESCE(expired_at, now()) ELSE expired_at END
        WHERE id = $1 AND source_id = $2`,
      [row.id, sourceId, canonicalSlug, target ?? null],
    );
  }
  return moved;
}

/**
 * Point the phantom's links at the canonical page (a merge between two page
 * ids, not a rename, so nothing else moves them). A link the canonical
 * already carries, or one that would become a self-link, stays on the
 * soft-deleted phantom.
 */
export async function mergePhantomLinks(engine: BrainEngine, phantomId: number, canonicalId: number): Promise<void> {
  await engine.executeRaw(
    `UPDATE links l SET to_page_id = $2
      WHERE l.to_page_id = $1 AND l.from_page_id <> $2
        AND NOT EXISTS (SELECT 1 FROM links d
          WHERE d.from_page_id = l.from_page_id AND d.to_page_id = $2 AND d.link_type = l.link_type
            AND d.link_source IS NOT DISTINCT FROM l.link_source
            AND d.origin_page_id IS NOT DISTINCT FROM l.origin_page_id)`,
    [phantomId, canonicalId],
  );
  await engine.executeRaw(
    `UPDATE links l SET from_page_id = $2
      WHERE l.from_page_id = $1 AND l.to_page_id <> $2
        AND NOT EXISTS (SELECT 1 FROM links d
          WHERE d.from_page_id = $2 AND d.to_page_id = l.to_page_id AND d.link_type = l.link_type
            AND d.link_source IS NOT DISTINCT FROM l.link_source
            AND d.origin_page_id IS NOT DISTINCT FROM l.origin_page_id)`,
    [phantomId, canonicalId],
  );
}

/**
 * Check bi-directional drift between phantom's DB body and its disk file.
 * When both exist and disagree on the parsed fence row set (by claim +
 * valid_from), classify as `drift` — operator triages manually.
 *
 * When the disk file is absent, the DB body is the truth; not drift.
 */
function fenceDbDrift(page: Page, brainDir: string): boolean {
  const phantomPath = path.join(brainDir, `${page.slug}.md`);
  if (!fs.existsSync(phantomPath)) return false;

  const dbBody = page.compiled_truth ?? '';
  const dbParse = parseFactsFence(dbBody);
  const dbKeys = new Set(dbParse.facts.map((f) => `${f.claim}|${f.validFrom ?? ''}`));

  let diskBody: string;
  try {
    diskBody = fs.readFileSync(phantomPath, 'utf-8');
  } catch {
    // File vanished between exists check and read — treat as DB-only,
    // no drift.
    return false;
  }
  // Strip frontmatter from the disk read so we compare the body portion
  // only. parseMarkdown handles frontmatter + body+timeline split.
  let diskCompiled = diskBody;
  try {
    const parsed = parseMarkdown(diskBody, `${page.slug}.md`);
    diskCompiled = parsed.compiled_truth;
  } catch {
    // Bad markdown on disk — treat as drift (operator should triage).
    return true;
  }
  const diskParse = parseFactsFence(diskCompiled);
  const diskKeys = new Set(diskParse.facts.map((f) => `${f.claim}|${f.validFrom ?? ''}`));

  if (dbKeys.size !== diskKeys.size) return true;
  for (const k of dbKeys) {
    if (!diskKeys.has(k)) return true;
  }
  return false;
}

/**
 * Materialize a DB-only canonical page to disk by serializing its full
 * page state (frontmatter + body + timeline). Reuses `serializeMarkdown`
 * so the output round-trips through `parseMarkdown` cleanly.
 */
async function materializeCanonicalToDisk(
  engine: BrainEngine,
  canonicalSlug: string,
  sourceId: string,
  canonicalPath: string,
): Promise<void> {
  if (fs.existsSync(canonicalPath)) return;
  const canonicalPage = await engine.getPage(canonicalSlug, { sourceId });
  if (!canonicalPage) {
    // Canonical doesn't exist in DB either. Materialize a minimal stub
    // so the subsequent fence append has somewhere to land.
    fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
    const titleFromSlug = canonicalSlug.split('/').pop() ?? canonicalSlug;
    const stubBody = serializeMarkdown(
      {},
      `# ${titleFromSlug}\n`,
      '',
      { type: 'concept', title: titleFromSlug, tags: [] },
    );
    fs.writeFileSync(canonicalPath, stubBody, 'utf-8');
    return;
  }
  const tags = await engine.getTags(canonicalSlug, { sourceId });
  const body = serializeMarkdown(
    canonicalPage.frontmatter ?? {},
    canonicalPage.compiled_truth ?? '',
    canonicalPage.timeline ?? '',
    {
      type: canonicalPage.type,
      title: canonicalPage.title,
      tags,
    },
  );
  fs.mkdirSync(path.dirname(canonicalPath), { recursive: true });
  fs.writeFileSync(canonicalPath, body, 'utf-8');
}

/** Frontmatter a bare phantom stub may carry; any other key is residue. */
const PHANTOM_STUB_FRONTMATTER = new Set(['title', 'type', 'tags']);

/** Anything a redirect would lose: body beyond the fence, timeline text or rows, custom frontmatter. */
export async function phantomHasResidue(engine: BrainEngine, page: Page): Promise<boolean> {
  const residue = stripFenceAndFrontmatterAndLeadingH1(page.compiled_truth ?? '')
    + (page.timeline ?? '').trim()
    + Object.keys(page.frontmatter ?? {}).filter(key => !PHANTOM_STUB_FRONTMATTER.has(key)).join(',');
  if (residue.length > 0) return true;
  return (await engine.executeRaw('SELECT 1 FROM timeline_entries WHERE page_id=$1 LIMIT 1', [page.id])).length > 0;
}

/**
 * Single-phantom redirect. Caller (the pass) is responsible for the
 * outer lock + the audit-log cap.
 */
export async function tryRedirectPhantom(
  engine: BrainEngine,
  page: Page,
  sourceId: string,
  brainDir: string,
  dryRun: boolean,
): Promise<RedirectResult> {
  // Predicate (D2): unprefixed AND alive (deleted_at filter done by caller).
  if (page.slug.includes('/')) return { outcome: 'not_phantom' };

  // A3 + codex #2: strict zero-residue body-shape gate. Real top-level
  // pages have prose; phantoms have only the stub-shape `# slug` + maybe
  // a facts fence. Only fence rows migrate, so anything else the page holds
  // (timeline text or rows, custom frontmatter) is residue that a redirect
  // would delete.
  if (await phantomHasResidue(engine, page)) {
    logPhantomEvent({
      phantom_slug: page.slug,
      outcome: 'not_phantom_has_residue',
      source_id: sourceId,
    });
    return { outcome: 'not_phantom' };
  }

  // Codex #1: phantom-specific resolver bypasses exact-self-match.
  const canonical = await resolvePhantomCanonical(engine, sourceId, page.slug, { type: page.type });
  if (!canonical) {
    logPhantomEvent({
      phantom_slug: page.slug,
      outcome: 'no_canonical',
      source_id: sourceId,
    });
    return { outcome: 'no_canonical' };
  }

  // D5 + codex #11: standalone ambiguity query. A canonical that is not the
  // single prefix candidate (e.g. a fuzzy hit on another page) is ambiguous
  // too.
  const candidates = await findPrefixCandidates(engine, sourceId, page.slug);
  if (candidates.length > 1 || (candidates.length === 1 && candidates[0].slug !== canonical)) {
    logPhantomEvent({
      phantom_slug: page.slug,
      outcome: 'ambiguous',
      candidates,
      source_id: sourceId,
    });
    return { outcome: 'ambiguous', canonical };
  }

  // Round 27/29/30: bi-directional drift check.
  if (fenceDbDrift(page, brainDir)) {
    logPhantomEvent({
      phantom_slug: page.slug,
      outcome: 'drift',
      source_id: sourceId,
    });
    return { outcome: 'drift', canonical };
  }

  // Only parsed rows move and the phantom is then deleted, so a phantom fence
  // the parser skipped rows of would lose them: leave it for a person.
  if (parseFactsFence(page.compiled_truth ?? '').warnings.length > 0) {
    logPhantomEvent({
      phantom_slug: page.slug,
      outcome: 'drift',
      source_id: sourceId,
      reason: 'phantom facts fence does not parse cleanly',
    });
    return { outcome: 'drift', canonical };
  }

  // D10: dry-run preview — no FS / DB / audit writes.
  if (dryRun) return { outcome: 'redirected', canonical };

  if (await managedPersistenceEnabled(engine)) {
    const { redirectManagedPhantom } = await import('./phantom-redirect-managed.ts');
    return redirectManagedPhantom(engine, page, canonical, sourceId);
  }

  // ─── Commit phase (codex #3/#4/#6/#7) ─────────────────────────────
  // #6982: with write-through off the database is the copy of record, so the
  // rows merge into the canonical's database body and no file is written or
  // removed. Otherwise the phantom's file goes only when it holds nothing its
  // row lacks, and the canonical file takes the rows only when it agrees with
  // the canonical's database body.
  const writeThroughOff = await isWriteThroughDisabled(engine);
  const phantomPath = path.join(brainDir, `${page.slug}.md`);
  const phantomFile = writeThroughOff ? null : await replaceableFile(engine, sourceId, page.slug, phantomPath);
  if (phantomFile && !phantomFile.ok) return driftHold(page.slug, sourceId, canonical, phantomFileDriftToken(page.slug, sourceId, 'before'));

  const target = await engine.getPage(canonical, { sourceId });
  if (target) assertInlineBody(target, 'phantom redirect');
  const phantomFence = parseFactsFence(page.compiled_truth ?? '');
  const [dbMax] = await engine.executeRaw<{ n: number | string | null }>(
    'SELECT MAX(row_num) AS n FROM facts WHERE source_id = $1 AND source_markdown_slug = $2',
    [sourceId, canonical],
  );
  let merged: Awaited<ReturnType<typeof mergeIntoCanonicalFile>>;
  if (writeThroughOff) merged = await mergeIntoCanonicalBody(engine, target, sourceId, phantomFence.facts, Number(dbMax?.n ?? 0));
  else {
    // The canonical file is the page's file of record (recorded source_path,
    // own-local_path roots), resolved like every other fence writer. Only a
    // brain with no configured root falls back to the pass's brainDir.
    const writeTarget = await resolvePageWriteTarget(engine, canonical, sourceId);
    if (!writeTarget.ok && writeTarget.skipped !== 'no_repo_configured') {
      logPhantomEvent({
        phantom_slug: page.slug,
        outcome: 'drift',
        source_id: sourceId,
        reason: `canonical write target unavailable: ${writeTarget.skipped}`,
      });
      return { outcome: 'drift', canonical };
    }
    const canonicalPath = writeTarget.ok ? writeTarget.filePath : path.join(brainDir, `${canonical}.md`);
    merged = await mergeIntoCanonicalFile(engine, page.slug, canonical, sourceId, canonicalPath, phantomFence.facts, Number(dbMax?.n ?? 0));
  }
  if ('held' in merged) return driftHold(page.slug, sourceId, canonical, merged.held);
  const rowMap = merged.renumber;

  // Withdrawals are scoped to the entity; the phantom was the canonical
  // entity. Moved first, so the withdrawal trigger honors them as the
  // phantom's rows take the canonical subject.
  await engine.executeRaw(MOVE_WITHDRAWAL_SUBJECT_SQL, [sourceId, page.slug, canonical]);
  const migrated = await migratePhantomFacts(engine, sourceId, page.slug, canonical, rowMap);

  const canonicalPage = await engine.getPage(canonical, { sourceId });
  if (canonicalPage) await mergePhantomLinks(engine, page.id, canonicalPage.id);
  await recordRenameAlias(engine, sourceId, page.slug, canonical);

  // Round 19/20: soft-delete + unlink. Order matters — softDelete first
  // so a concurrent sync that observes the phantom .md gone treats it as
  // a normal deletion (not a regression). The file is re-read right before
  // the unlink: one that changed since it was compared is kept and reported.
  await maintenanceTransaction(engine, tx => tx.softDeletePage(page.slug, { sourceId }));
  let held: string | undefined;
  if (phantomFile && fs.existsSync(phantomPath)) {
    let current: string | null = null;
    try { current = fs.readFileSync(phantomPath, 'utf-8'); } catch { /* vanished: nothing to remove */ }
    if (current !== null && current !== phantomFile.expectedFileBytes) held = phantomFileDriftToken(page.slug, sourceId, 'during');
    else if (current !== null) {
      try {
        fs.unlinkSync(phantomPath);
      } catch (err) {
        // ENOENT is fine (someone else got there first). Anything else
        // is logged but doesn't unwind the redirect — the next sync will
        // notice the dangling .md and soft-delete-on-disk-miss it.
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') {
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `[gbrain] phantom-redirect: unlink ${phantomPath} failed (${msg}); cycle continues\n`,
          );
        }
      }
    }
  }

  logPhantomEvent({
    phantom_slug: page.slug,
    canonical_slug: canonical,
    outcome: 'redirected',
    fact_count: migrated,
    source_id: sourceId,
  });
  return { outcome: 'redirected', canonical, ...(held ? { held } : {}) };
}

/**
 * The per-cycle phantom-redirect pass. Runs INSIDE `runExtractFacts` after
 * the legacy-row guard fires its empty fast-path. Single per-cycle lock
 * acquisition with bounded retry; if lock is busy the entire pass is
 * skipped this cycle (next cycle retries cleanly).
 */
export async function runPhantomRedirectPass(
  engine: BrainEngine,
  brainDir: string,
  sourceId: string,
  dryRun: boolean,
  signal?: AbortSignal,
  holdSlugs: ReadonlySet<string> = new Set(),
): Promise<PhantomPassResult> {
  const result = emptyPhantomPassResult();
  const limitRaw = process.env.GBRAIN_PHANTOM_REDIRECT_LIMIT;
  const limit = (() => {
    if (limitRaw === undefined || limitRaw === '') return DEFAULT_PHANTOM_LIMIT;
    const n = parseInt(limitRaw, 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_PHANTOM_LIMIT;
  })();

  // Bounded-retry lock acquisition. tryAcquireDbLock returns null on
  // contention; we loop with 1s backoff up to 30s total.
  // v0.40 D16: per-source lock matching performSync's posture. Phantom + same-
  // source sync still serialize; cross-source parallel sync proceeds unblocked.
  const lock = await acquireLockWithRetry(engine, syncLockId(sourceId), signal);
  if (!lock) {
    logPhantomEvent({ outcome: 'pass_skipped_lock_busy', source_id: sourceId });
    result.lock_busy = true;
    return result;
  }

  try {
    // Find unprefixed phantoms in this source. We over-fetch by 1 so
    // `more_pending` reflects whether the cap actually clipped work.
    // #6650: held phantoms are excluded before the cap, so they never use up
    // the pass's candidate positions. GBRA-130 A-24: a root page that is not a
    // phantom stays live, so the pass resumes after the last slug the previous
    // pass examined and wraps at the end; otherwise 50+ root notes would fill
    // the window every run and a phantom sorting after them would never be seen.
    const held = [...holdSlugs].filter(slug => !slug.includes('/'));
    result.held_legacy_rows = held.length;
    const after = await rotationAfter(engine, PHANTOM_REDIRECT_CURSOR_OP, sourceId) ?? '';
    const rows = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages
       WHERE source_id = $1
         AND deleted_at IS NULL
         AND slug NOT LIKE '%/%'
         AND slug <> ALL($3::text[])
         AND slug > $4
       ORDER BY slug ASC
       LIMIT $2`,
      [sourceId, limit + 1, held, after],
    );
    result.more_pending = rows.length > limit;

    const touchedSet = new Set<string>();
    const run = new ItemRun('extract_facts.phantom_redirect');
    let examined: string | null = null;
    for (let i = 0; i < Math.min(rows.length, limit); i++) {
      // #1972: bail between phantoms on abort (each is independently committed).
      if (isAborted(signal)) break;
      const slug = rows[i].slug;
      const page = await engine.getPage(slug, { sourceId });
      examined = slug;
      if (!page) continue;
      result.scanned += 1;

      let redirectResult: RedirectResult;
      try {
        redirectResult = await tryRedirectPhantom(engine, page, sourceId, brainDir, dryRun);
        run.succeed();
      } catch (err) {
        const { failure, systemic } = run.record(slug, err);
        process.stderr.write(`[gbrain] phantom-redirect: ${slug} failed (${failure.code}: ${failure.message}); skipping\n`);
        logPhantomEvent({
          phantom_slug: slug,
          outcome: 'drift',
          source_id: sourceId,
          reason: `exception: ${failure.message.slice(0, 200)}`,
        });
        result.failures.push({ key: slug, code: failure.code, message: failure.message,
          fix: { argv: ['gbrain', 'dream', '--phase', 'extract_facts', '--source', sourceId], consent: [], actor: 'agent', requires_exclusive: false,
            why: `Reruns the facts phase for ${sourceId}; the phantom pass retries ${slug} after its cursor wraps.` } });
        if (systemic) {
          result.stopped = { code: 'item_failures_systemic', message: systemic.message };
          break;
        }
        redirectResult = { outcome: 'drift' };
      }

      if (redirectResult.held) result.held.push(redirectResult.held);
      switch (redirectResult.outcome) {
        case 'redirected':
          result.redirected += 1;
          // Track the canonical so the main reconcile loop can pick it up
          // (scenario B fix: phantom had only-on-disk fence; canonical's
          // DB facts now need to derive from the merged disk fence).
          if (!dryRun && redirectResult.canonical) {
            touchedSet.add(redirectResult.canonical);
          }
          break;
        case 'ambiguous':    result.ambiguous += 1; break;
        case 'drift':        result.skipped_drift += 1; break;
        case 'no_canonical': result.no_canonical += 1; break;
        case 'not_phantom':  result.not_phantom += 1; break;
      }
    }
    result.touched_canonicals = Array.from(touchedSet).sort();
    const next = !isAborted(signal) && rows.length <= limit ? '' : examined;
    if (!dryRun && !result.stopped && next !== null && next !== after) await saveRotation(engine, PHANTOM_REDIRECT_CURSOR_OP, sourceId, next);
  } finally {
    try {
      await lock.release();
    } catch {
      // TTL expiry will reclaim eventually.
    }
  }

  return result;
}

// Re-export type for cycle.ts consumers.
export type { PhantomOutcome };
