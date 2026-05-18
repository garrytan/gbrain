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
 * Reuses existing infrastructure where it can: `softDeletePage`,
 * `rewriteLinks`, `deleteFactsForPage`, fence parser. Adds TWO new
 * primitives (codex outside-voice round of /plan-eng-review):
 *
 *   1. `resolvePhantomCanonical` (src/core/entities/resolve.ts) bypasses
 *      `resolveEntitySlug`'s exact-self-match step, which would have
 *      returned the phantom slug itself and made the whole pass a no-op.
 *
 *   2. `engine.migrateFactsToCanonical` (BrainEngine) is a DB-side
 *      UPDATE that preserves every fact-row column (embedding,
 *      validUntil, kind, status, source_session, ...). `writeFactsToFence`
 *      was tempting to reuse but is APPEND-only-with-new-row-numbers and
 *      drops embeddings + supersession metadata, so migrating through it
 *      would resurrect forgotten facts and lose embeddings.
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

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import {
  resolvePhantomCanonical,
  findPrefixCandidates,
} from '../entities/resolve.ts';
import {
  parseFactsFence,
  renderFactsTable,
  FACTS_FENCE_BEGIN,
  FACTS_FENCE_END,
  type ParsedFact,
} from '../facts-fence.ts';
import { parseMarkdown, splitBody, serializeMarkdown } from '../markdown.ts';
import { tryAcquireDbLock, SYNC_LOCK_ID, type DbLockHandle } from '../db-lock.ts';
import { logPhantomEvent, type PhantomOutcome } from '../facts/phantom-audit.ts';

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
}

export interface PhantomPassResult {
  scanned: number;
  redirected: number;
  ambiguous: number;
  skipped_drift: number;
  no_canonical: number;
  not_phantom: number;
  /** True iff the pass was skipped wholesale because the writer lock was busy. */
  lock_busy: boolean;
  /** True iff more phantoms exist than the per-cycle cap — caller surfaces to operator. */
  more_pending: boolean;
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
    lock_busy: false,
    more_pending: false,
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
  const beginIdx = working.indexOf(FACTS_FENCE_BEGIN);
  const endIdx = beginIdx >= 0
    ? working.indexOf(FACTS_FENCE_END, beginIdx + FACTS_FENCE_BEGIN.length)
    : -1;
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
 * Compute the canonical content_hash for a page. Matches
 * `src/core/import-file.ts:241`'s shape exactly so `gbrain sync`'s
 * idempotency check sees the redirected canonical as unchanged.
 */
function computePageContentHash(parsed: {
  title: string;
  type: string;
  compiled_truth: string;
  timeline: string;
  frontmatter: Record<string, unknown>;
  tags: string[];
}): string {
  return createHash('sha256')
    .update(JSON.stringify({
      title: parsed.title,
      type: parsed.type,
      compiled_truth: parsed.compiled_truth,
      timeline: parsed.timeline,
      frontmatter: parsed.frontmatter,
      tags: [...parsed.tags].sort(),
    }))
    .digest('hex');
}

/**
 * Block-on-busy lock acquisition with bounded retry. Returns null when
 * total timeout elapses without a successful acquire.
 */
async function acquireLockWithRetry(
  engine: BrainEngine,
  lockId: string,
): Promise<DbLockHandle | null> {
  const deadline = Date.now() + LOCK_TOTAL_TIMEOUT_MS;
  let handle = await tryAcquireDbLock(engine, lockId, LOCK_TTL_MINUTES);
  while (!handle) {
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_INTERVAL_MS));
    handle = await tryAcquireDbLock(engine, lockId, LOCK_TTL_MINUTES);
  }
  return handle;
}

/**
 * Append the phantom's fact rows to the canonical's disk fence, dedup-
 * guarded by (claim, valid_from). Atomic via `.tmp` + rename.
 *
 * Returns the count of rows actually appended (i.e. NOT counting dedupped).
 * The disk write happens BEFORE the DB migration in the redirect handler,
 * so if this throws (rename fails, disk full, parse-validation rejects)
 * the DB migration won't run and the cycle can retry next run.
 */
function appendPhantomFenceRowsToCanonical(
  canonicalPath: string,
  phantomFacts: ParsedFact[],
): number {
  if (phantomFacts.length === 0) return 0;
  const body = fs.readFileSync(canonicalPath, 'utf-8');
  const { facts: existingFacts } = parseFactsFence(body);

  // Dedup key combines claim + valid_from. We deliberately do NOT include
  // valid_until or status in the key so that a "fact about Alice" already
  // present at canonical doesn't get duplicated even if the strike-through
  // state differs between phantom and canonical (the operator can
  // reconcile manually after redirect).
  const existingKeys = new Set(
    existingFacts.map((f) => `${f.claim}|${f.validFrom ?? ''}`),
  );
  let nextRowNum = existingFacts.length > 0
    ? Math.max(...existingFacts.map((f) => f.rowNum)) + 1
    : 1;

  let appended = 0;
  const merged: ParsedFact[] = [...existingFacts];
  for (const pf of phantomFacts) {
    const key = `${pf.claim}|${pf.validFrom ?? ''}`;
    if (existingKeys.has(key)) continue;
    merged.push({ ...pf, rowNum: nextRowNum });
    existingKeys.add(key);
    nextRowNum += 1;
    appended += 1;
  }

  if (appended === 0) return 0;

  const newFence = renderFactsTable(merged);
  const beginIdx = body.indexOf(FACTS_FENCE_BEGIN);
  const endIdx = body.indexOf(FACTS_FENCE_END, beginIdx + FACTS_FENCE_BEGIN.length);
  let newBody: string;
  if (beginIdx !== -1 && endIdx !== -1) {
    newBody = body.slice(0, beginIdx) + newFence + body.slice(endIdx + FACTS_FENCE_END.length);
  } else {
    const sep = body.endsWith('\n') ? '\n' : '\n\n';
    newBody = `${body}${sep}## Facts\n\n${newFence}\n`;
  }

  // Atomic write: .tmp first, parse-validate, rename.
  const tmpPath = `${canonicalPath}.tmp`;
  fs.writeFileSync(tmpPath, newBody, 'utf-8');
  const reparsed = parseFactsFence(newBody);
  if (reparsed.warnings.length > 0) {
    // Leave .tmp as quarantine evidence; do NOT rename.
    throw new Error(
      `phantom-redirect: rendered fence failed re-parse: ${reparsed.warnings.join('; ')}`,
    );
  }
  fs.renameSync(tmpPath, canonicalPath);
  return appended;
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
  // a facts fence.
  const residue = stripFenceAndFrontmatterAndLeadingH1(page.compiled_truth ?? '');
  if (residue.length > 0) {
    logPhantomEvent({
      phantom_slug: page.slug,
      outcome: 'not_phantom_has_residue',
      source_id: sourceId,
    });
    return { outcome: 'not_phantom' };
  }

  // Codex #1: phantom-specific resolver bypasses exact-self-match.
  const canonical = await resolvePhantomCanonical(engine, sourceId, page.slug);
  if (!canonical) {
    logPhantomEvent({
      phantom_slug: page.slug,
      outcome: 'no_canonical',
      source_id: sourceId,
    });
    return { outcome: 'no_canonical' };
  }

  // D5 + codex #11: standalone ambiguity query.
  const candidates = await findPrefixCandidates(engine, sourceId, page.slug);
  if (candidates.length > 1) {
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

  // D10: dry-run preview — no FS / DB / audit writes.
  if (dryRun) return { outcome: 'redirected', canonical };

  // ─── Commit phase (codex #3/#4/#6/#7) ─────────────────────────────
  const canonicalPath = path.join(brainDir, `${canonical}.md`);
  await materializeCanonicalToDisk(engine, canonical, sourceId, canonicalPath);

  // Disk-side first: parse phantom's fence and append to canonical's
  // disk fence (dedup-guarded). If this throws, no DB state has moved
  // and the cycle can retry next run.
  const phantomFence = parseFactsFence(page.compiled_truth ?? '');
  appendPhantomFenceRowsToCanonical(canonicalPath, phantomFence.facts);

  // Codex #7: refresh canonical's compiled_truth + content_hash so the
  // next `gbrain sync` sees the canonical as unchanged. We re-parse the
  // disk body and recompute the hash with the same shape import-file
  // uses, so the idempotency check round-trips byte-for-byte.
  const newCanonicalBody = fs.readFileSync(canonicalPath, 'utf-8');
  const reparsed = parseMarkdown(newCanonicalBody, `${canonical}.md`);
  const canonicalTags = await engine.getTags(canonical, { sourceId });
  const newContentHash = computePageContentHash({
    title: reparsed.title,
    type: reparsed.type,
    compiled_truth: reparsed.compiled_truth,
    timeline: reparsed.timeline,
    frontmatter: reparsed.frontmatter,
    tags: canonicalTags,
  });
  await engine.refreshPageBody(
    canonical,
    sourceId,
    reparsed.compiled_truth,
    reparsed.timeline,
    newContentHash,
  );

  // Codex #3/#4/#12: lossless DB migration. Re-runs return migrated=0.
  const migrated = await engine.migrateFactsToCanonical(page.slug, canonical, sourceId);

  // D6: DB FK rewrite for the links table (wiki-link text rewrite is a
  // documented follow-up — codex #5).
  await engine.rewriteLinks(page.slug, canonical);

  // Round 19/20: soft-delete + unlink. Order matters — softDelete first
  // so a concurrent sync that observes the phantom .md gone treats it as
  // a normal deletion (not a regression).
  await engine.softDeletePage(page.slug, { sourceId });
  // Wipe any stale phantom DB facts that may have escaped the migration
  // (e.g. expired rows that the migration WHERE clause skipped).
  await engine.deleteFactsForPage(page.slug, sourceId);
  const phantomPath = path.join(brainDir, `${page.slug}.md`);
  if (fs.existsSync(phantomPath)) {
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

  logPhantomEvent({
    phantom_slug: page.slug,
    canonical_slug: canonical,
    outcome: 'redirected',
    fact_count: migrated.migrated,
    source_id: sourceId,
  });
  return { outcome: 'redirected', canonical };
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
  const lock = await acquireLockWithRetry(engine, SYNC_LOCK_ID);
  if (!lock) {
    logPhantomEvent({ outcome: 'pass_skipped_lock_busy', source_id: sourceId });
    result.lock_busy = true;
    return result;
  }

  try {
    // Find unprefixed phantoms in this source. We over-fetch by 1 so
    // `more_pending` reflects whether the cap actually clipped work.
    const rows = await engine.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages
       WHERE source_id = $1
         AND deleted_at IS NULL
         AND slug NOT LIKE '%/%'
       ORDER BY slug ASC
       LIMIT $2`,
      [sourceId, limit + 1],
    );
    result.more_pending = rows.length > limit;

    const touchedSet = new Set<string>();
    for (let i = 0; i < Math.min(rows.length, limit); i++) {
      const slug = rows[i].slug;
      const page = await engine.getPage(slug, { sourceId });
      if (!page) continue;
      result.scanned += 1;

      let redirectResult: RedirectResult;
      try {
        redirectResult = await tryRedirectPhantom(engine, page, sourceId, brainDir, dryRun);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[gbrain] phantom-redirect: ${slug} failed (${msg}); skipping\n`);
        logPhantomEvent({
          phantom_slug: slug,
          outcome: 'drift',
          source_id: sourceId,
          reason: `exception: ${msg.slice(0, 200)}`,
        });
        redirectResult = { outcome: 'drift' };
      }

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
