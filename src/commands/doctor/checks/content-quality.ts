/**
 * Content quality: oversized / scraper-junk pages and the content-sanity audit, quarantined and flagged pages, unverified extractions, frontmatter integrity.
 *
 * Doctor registry entry module (refactor wave 1, W4 doctor). Each run*(ctx)
 * function holds one block of the former `buildChecks` body, moved
 * verbatim; the check order and the check-name categories are owned by
 * src/commands/doctor/registry.ts and src/core/doctor-categories.ts.
 */

import { startHeartbeat } from '../../../core/progress.ts';
import { checkUnverifiedExtractions } from './extraction-sync.ts';
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { agentFix, checkError, doctorVerify, withSkippedSegmented } from '../check-fix.ts';
import { capabilityRefusal, capabilityUnknownCheck, scanDeadline } from '../budget.ts';
import { isMissingSchemaObject } from '../../../core/utils.ts';
import { rethrowCapabilityMissing } from '../../../core/rust-engine/errors.ts';
import { boundUnknownDetails } from '../bounded-unknown.ts';

/** Oversized pages `oversized_pages` lists before it reports a floor. */
const OVERSIZED_LIST_LIMIT = 100;

async function runContentSanity(ctx: DoctorContext): Promise<Check[]> {
  const { args, progress } = ctx;
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];

  // 11b. Content sanity checks (v0.41).
  //
  // Three sibling checks all backed by the shared assessor in
  // src/core/content-sanity.ts so the surface stays aligned with the
  // ingest gate at importFromContent and the lint rules at lintContent.
  //
  // - oversized_pages: indexed-free table scan (~100ms on 100K-page brains)
  //   counting pages whose body (compiled_truth + timeline, UTF-8 bytes
  //   via octet_length per Codex r2 #13) exceeds the block threshold.
  //   Status warn when 1+ rows; never fail (oversize is now a soft state).
  //   Excludes frontmatter.embed_skip pages via the canonical
  //   EMBED_SKIP_FILTER_FRAGMENT (src/core/embed-skip.ts) — key existence,
  //   not a boolean value comparison, matching every other embed-skip
  //   consumer in the codebase. The warn message itself says "existing
  //   oversized pages can be ... accepted as non-embeddable" (i.e.
  //   embed_skip set), so a page that already took that accepted
  //   remediation must not still count against this check — otherwise the
  //   warning can never clear for a page an operator already resolved the
  //   documented way (found via dogfooding: a page with embed_skip set
  //   kept re-appearing in this check's output every run).
  // - scraper_junk_pages: capped 1000-most-recent default + --content-audit
  //   opt-in for full scan (D10 mirrors --index-audit precedent). Applies
  //   the assessor per-page on title + 2KB head-slice + frontmatter.
  // - content_sanity_audit_recent: reads ~/.gbrain/audit/content-sanity-*.jsonl
  //   over the last 7 days, aggregates by event type + source. Caveat
  //   (Codex r1 #14): JSONL is local-only — multi-host operators should
  //   share GBRAIN_AUDIT_DIR. Message names this so the limitation is
  //   visible at the doctor surface.
  const fullContentAudit = args.includes('--content-audit');
  progress.heartbeat('oversized_pages');
  try {
    // #6526: the write gate's bytes_block (the DB config plane over file and env),
    // so a `gbrain config set content_sanity.bytes_block N` reaches this check too.
    const bytesBlock = await (await import('../../../core/import-screen.ts')).effectiveBytesBlock(engine);
    // The engine's typed read (engine-sql/doctor-pages.ts), so a Rust brain answers it too.
    const rows = await engine.listOversizedPages(bytesBlock);
    // #7145: a full list means more pages exceed the block; the count is then a floor.
    const capped = rows.length > OVERSIZED_LIST_LIMIT;
    // Pages an older gbrain stored chunkless for size that now fit under the block: the free backfill re-indexes them.
    const skipped = await engine.countOversizedEmbedSkips(bytesBlock);
    const backfillable = skipped.marked;
    const chunklessMarked = skipped.chunkless;
    // Decision #10: a segmented page's body columns are NULL, so both size scans above pass it by.
    // A typed count (engine-sql/doctor-tallies.ts), so a Rust brain answers it; a failure fails the check below.
    const segmented = await engine.countLiveSegmentedPages();
    const oversizedCheck = (check: Check) => checks.push(withSkippedSegmented(check, segmented));
    if (backfillable > 0) {
      oversizedCheck({
        name: 'oversized_pages',
        status: 'warn',
        // #7184: a marked page keeps its chunks once healed or rewritten, so say how many are truly invisible.
        message: `${backfillable} page(s) still carry the size-skip marker an older gbrain wrote, and now fit under the ${bytesBlock}-byte bytes_block: `
          + `${chunklessMarked} have no chunks, so not even keyword search finds them, and ${backfillable - chunklessMarked} are keyword-only with no vectors. `
          + 'A page whose rewrite fails (an invalid fence, for example) keeps the marker until its content is repaired. Fix: gbrain reindex --oversized (free, CPU only; pages over 1 MiB then wait for embedding approval).',
        details: { marked: backfillable, chunkless: chunklessMarked },
        fix: agentFix(['gbrain', 'reindex', '--oversized'], 'Re-chunks the size-skipped pages so keyword search finds them; it calls no paid provider and holds large pages for embedding approval.',
          'oversized_pages', { docs: 'docs/guides/memory-boundaries.md#large-pages-upgrade' }),
      });
    } else if (rows.length === 0) {
      oversizedCheck({
        name: 'oversized_pages',
        status: 'ok',
        message: `No pages exceed ${bytesBlock} bytes (excluding embed_skip pages, which already took the accepted non-embeddable remediation)`,
      });
    } else {
      const oversizeRows = rows as unknown as Array<{ slug: string; source_id: string; bytes: number }>;
      const top = oversizeRows.slice(0, 3)
        .map(r => `${r.slug} (${r.bytes}b, src=${r.source_id})`)
        .join('; ');
      oversizedCheck({
        name: 'oversized_pages',
        status: 'warn',
        details: { count: Math.min(rows.length, OVERSIZED_LIST_LIMIT), exact: !capped, ...(capped ? { limit: OVERSIZED_LIST_LIMIT } : {}) },
        message: `${capped ? `At least ${OVERSIZED_LIST_LIMIT}` : rows.length} page(s) exceed the ${bytesBlock}-byte content_sanity.bytes_block. Top: ${top}. A page over the block is stored without chunks on its next write. `
          + 'Raise content_sanity.bytes_block (up to the 24 MiB page ceiling) to make them searchable, or exclude them from the source.',
      });
    }
  } catch (err) {
    // #7145: a scan that failed found nothing either way.
    checks.push(checkError('oversized_pages', 'check for oversized pages', err, { details: { health: 'unknown' } }));
  }

  progress.heartbeat('scraper_junk_pages');
  try {
    const { assessContentSanity } = await import('../../../core/content-sanity.ts');
    const { loadOperatorLiterals } = await import('../../../core/content-sanity-literals.ts');
    const literals = loadOperatorLiterals();
    const scanLimit = fullContentAudit ? null : 1000;
    const rows = await engine.listScraperJunkCandidates(scanLimit);
    const hits: Array<{ slug: string; matched: string[] }> = [];
    const scanRows = rows;
    // Decision #10: a segmented row's body heads are NULL, so only its title was assessed; the scan rows say which.
    const segmentedScanned = scanRows.filter(r => r.segmented === true).length;
    for (const r of scanRows) {
      const sanity = assessContentSanity({
        compiled_truth: r.body_head ?? '',
        timeline: r.tl_head ?? '',
        title: r.title ?? '',
        bytes_warn: Number.MAX_SAFE_INTEGER, // we ONLY care about junk-pattern hits here
        bytes_block: Number.MAX_SAFE_INTEGER,
        extra_literals: literals,
      });
      if (sanity.shouldHardBlock) {
        hits.push({
          slug: r.slug,
          matched: [...sanity.junk_pattern_matches, ...sanity.literal_substring_matches],
        });
      }
    }
    if (hits.length === 0) {
      checks.push(withSkippedSegmented({
        name: 'scraper_junk_pages',
        status: 'ok',
        message: scanLimit
          ? `No junk-pattern hits in ${rows.length} recent page(s) (use --content-audit for full scan)`
          : `No junk-pattern hits in ${rows.length} page(s) (full audit)`,
      }, segmentedScanned));
    } else {
      const top = hits.slice(0, 3).map(h => `${h.slug} [${h.matched.join(',')}]`).join('; ');
      checks.push(withSkippedSegmented({
        name: 'scraper_junk_pages',
        status: 'warn',
        message: `${hits.length} page(s) match junk patterns. Top: ${top}. ${scanLimit ? '(scanned 1000 most-recent; rerun with --content-audit for full scan)' : '(full audit)'} New ingests with these shapes are now hard-blocked; existing inventory should be cleaned at source.`,
      }, segmentedScanned));
    }
  } catch (err) {
    const refusal = capabilityRefusal(err);
    const msg = err instanceof Error ? err.message : String(err);
    if (refusal) checks.push(capabilityUnknownCheck('scraper_junk_pages', refusal));
    else checks.push({
      name: 'scraper_junk_pages',
      status: 'ok',
      message: `Skipped (${msg})`,
    });
  }

  progress.heartbeat('content_sanity_audit_recent');
  try {
    const { readRecentContentSanityEvents, summarizeContentSanityEvents } =
      await import('../../../core/audit/content-sanity-audit.ts');
    const events = readRecentContentSanityEvents(7);
    if (events.length === 0) {
      checks.push({
        name: 'content_sanity_audit_recent',
        status: 'ok',
        message: 'No content-sanity events in last 7 days (audit JSONL is local to this host; share GBRAIN_AUDIT_DIR for multi-host visibility)',
      });
    } else {
      const summary = summarizeContentSanityEvents(events);
      const topPatterns = summary.top_patterns.slice(0, 3).map(p => `${p.name}=${p.count}`).join(', ');
      const topSources = Object.entries(summary.by_source)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([s, n]) => `${s}=${n}`)
        .join(', ');
      // Audit events are evidence, not automatically breakage. A large code
      // source can legitimately emit many WARN events (oversize/markup-heavy)
      // while remaining searchable and intentionally flagged. Fail on hard
      // dispositions (content actually blocked or hidden); warn on soft
      // dispositions or volume. This keeps doctor from treating expected
      // code-corpus telemetry as an unhealthy brain.
      //
      // v0.42 renamed the hard path: a rejected page emits `reject` and a
      // quarantined (hidden) junk page emits `quarantine`; `hard_block` is now
      // only the pre-v0.42 legacy alias. Counting `hard_block` alone let fresh
      // junk-ingest evidence (`reject`/`quarantine`) clear as `ok` whenever
      // fewer than 10 events landed. `flag` is a warn disposition (still
      // searchable, agent warned on retrieval), so it joins `soft_block`.
      const hardBlocked =
        summary.by_type.hard_block + summary.by_type.reject + summary.by_type.quarantine;
      const softBlocked = summary.by_type.soft_block + summary.by_type.flag;
      const status: 'ok' | 'warn' | 'fail' =
        hardBlocked > 0 ? 'fail' :
          (softBlocked > 0 || events.length >= 10) ? 'warn' : 'ok';
      checks.push({
        name: 'content_sanity_audit_recent',
        status,
        message: `${events.length} events (hard=${hardBlocked} [hard_block=${summary.by_type.hard_block} reject=${summary.by_type.reject} quarantine=${summary.by_type.quarantine}] soft=${softBlocked} [soft_block=${summary.by_type.soft_block} flag=${summary.by_type.flag}] warn=${summary.by_type.warn})${topPatterns ? ', patterns: ' + topPatterns : ''}${topSources ? ', sources: ' + topSources : ''}. (Local audit only — multi-host operators set GBRAIN_AUDIT_DIR.)`,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({
      name: 'content_sanity_audit_recent',
      status: 'ok',
      message: `Skipped (${msg})`,
    });
  }
  return checks;
}

export const contentSanityEntry: DoctorEntry = {
  name: 'oversized_pages',
  emits: ['oversized_pages', 'scraper_junk_pages', 'content_sanity_audit_recent'],
  run: runContentSanity,
};

/**
 * #6803 part 3: its own entry, so the full `pages` scans above never spend its
 * budget and `--only partial_embedding` runs only this indexed read. The
 * finding, its per-source approve Actions and their N live in core/held-embedding.ts.
 */
async function runPartialEmbedding(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  ctx.progress.heartbeat('partial_embedding');
  try {
    const { budgetLimitedFinding } = await import('../../../core/held-embedding.ts');
    const { currentEmbeddingSignature } = await import('../../../core/embedding.ts');
    const found = await budgetLimitedFinding(engine, currentEmbeddingSignature());
    if (!found) checks.push({ name: 'partial_embedding', status: 'ok', message: 'No large page has chunks waiting for embedding approval (held or capped by embed.max_usd_per_page).' });
    else checks.push({ name: 'partial_embedding', status: 'warn', message: found.message, fix: found.fix, details: found.details });
  } catch (err) {
    checks.push(checkError('partial_embedding', 'read the per-page embedding budget', err));
  }
  return checks;
}

export const partialEmbeddingEntry: DoctorEntry = {
  name: 'partial_embedding',
  emits: ['partial_embedding'],
  tier: 'quick',
  run: runPartialEmbedding,
};

async function runQuarantine(ctx: DoctorContext): Promise<Check[]> {
  const { orphanRatioSourceId, progress } = ctx;
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];

  // v0.42 (#1699) content-quality gate: quarantined (hidden junk) +
  // flagged (warned, still searchable) page counts. Both are simple
  // JSONB key-existence scans (cheap; the marked subset stays small).
  progress.heartbeat('quarantined_pages');
  try {
    // engine.executeRaw (NOT db.getConnection() — that's the postgres singleton,
    // dead on the default PGLite engine). The JSONB `?` existence operator is
    // literal SQL through executeRaw on both engines.
    const n = await engine.countMarkedPages('quarantine');
    checks.push({
      name: 'quarantined_pages',
      status: n > 0 ? 'warn' : 'ok',
      message: n > 0
        ? `${n} page(s) quarantined as junk (hidden from search). Review with 'gbrain quarantine list'; clear a false positive with 'gbrain quarantine clear <slug> --force' (it stays cleared until the page changes; a pattern that misfires brain-wide is turned off with content_sanity.disabled_patterns).`
        : 'No quarantined pages',
    });
  } catch (err) {
    // A Rust engine that does not serve the read reports unknown health; only a missing pages table is a clean skip;
    // any other failure (#9924) is not a clean result.
    const refusal = capabilityRefusal(err);
    checks.push(refusal ? capabilityUnknownCheck('quarantined_pages', refusal)
      : isMissingSchemaObject(err, 'table', 'pages')
        ? { name: 'quarantined_pages', status: 'ok', message: 'Skipped (pages table unavailable)' }
        : checkError('quarantined_pages', 'count quarantined pages', err));
  }

  progress.heartbeat('flagged_pages');
  try {
    const n = await engine.countMarkedPages('content_flag');
    // Flagged pages are "examine me", not "broken" — warn so they're visible
    // but the message is non-alarming.
    checks.push({
      name: 'flagged_pages',
      status: n > 0 ? 'warn' : 'ok',
      message: n > 0
        ? `${n} page(s) flagged (markup-heavy or oversize) — still searchable, agent warned on retrieval. Review with 'gbrain quarantine list --include-flagged'.`
        : 'No flagged pages',
    });
  } catch (err) {
    const refusal = capabilityRefusal(err);
    checks.push(refusal ? capabilityUnknownCheck('flagged_pages', refusal)
      : isMissingSchemaObject(err, 'table', 'pages')
        ? { name: 'flagged_pages', status: 'ok', message: 'Skipped (pages table unavailable)' }
        : checkError('flagged_pages', 'count flagged pages', err));
  }

  // issue #160: extraction quarantine lane review nudge.
  progress.heartbeat('unverified_extractions');
  checks.push(await checkUnverifiedExtractions(engine, { sourceId: orphanRatioSourceId }));
  return checks;
}

export const quarantineEntry: DoctorEntry = {
  name: 'quarantined_pages',
  emits: ['quarantined_pages', 'flagged_pages', 'unverified_extractions'],
  run: runQuarantine,
};

async function runFrontmatter(ctx: DoctorContext): Promise<Check[]> {
  const { progress } = ctx;
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];

  // 11a. Frontmatter integrity (v0.22.4, hardened in v0.38.2.0).
  // scanBrainSources walks every registered source's local_path on disk
  // (not from the DB), invoking parseMarkdown(..., {validate:true}) per
  // file. Reports per-source counts grouped by error code. The fix path is
  // `gbrain frontmatter validate <source-path> --fix`, which writes .bak
  // backups so it works for both git and non-git brain repos.
  //
  // v0.38.2.0 wave (this PR supersedes PR #1287):
  //  - `pruneDir` now applies at descent inside brain-writer.ts:walkDir so
  //    the scan no longer recurses into node_modules / .git / .obsidian /
  //    *.raw / ops. That alone takes the 216K-page user from "hangs
  //    forever" to "completes in seconds" on the typical brain.
  //  - `deadline` (per-file Date.now() check inside the sync loop) is the
  //    load-bearing wall-clock bound. AbortSignal.timeout (kept for
  //    between-source aborts) cannot interrupt sync readdirSync /
  //    readFileSync — codex outside-voice C1 caught the original plan's
  //    assumption that it could.
  //  - Partial-result surfacing: per-source status ('scanned' | 'partial' |
  //    'skipped'), files_scanned numerator, and an honest "scanned ~N files
  //    (source has ~M pages in DB)" message when the deadline fires. The
  //    `partial` and `aborted_at_source` fields on AuditReport feed the
  //    JSON consumer.
  //  - Configurable via GBRAIN_DOCTOR_FM_TIMEOUT_MS (default 30000ms).
  progress.heartbeat('frontmatter_integrity');
  const fmHb = startHeartbeat(progress, 'scanning frontmatter…');
  const { frontmatterScanTimeoutMs, frontmatterRepairableFromReport } = await import('./frontmatter-repairable.ts');
  // #6803 C3: the walk also stops at the entry's (and so the run's) deadline, and reports what it read.
  const fmDeadline = scanDeadline(ctx, frontmatterScanTimeoutMs());
  const fmTimeoutMs = Math.max(0, fmDeadline - Date.now());
  try {
    const { scanBrainSources } = await import('../../../core/brain-writer.ts');
    const fmAbort = AbortSignal.timeout(fmTimeoutMs);
    // Per-source DB denominator. Coarse — DB pages and on-disk syncable
    // files are overlapping but not identical (unsynced disk files,
    // soft-deleted DB rows, auto-generated pages). Wording in the partial
    // message makes the mismatch honest. Failure of the COUNT degrades to
    // null and the message falls back to bare numerator.
    const dbPageCountForSource = async (sourceId: string): Promise<number | null> => {
      if (Date.now() >= fmDeadline) return null;
      try {
        // The typed count (same predicate), so a Rust brain answers it.
        const n = await engine.countLivePagesInSource(sourceId);
        return Number.isFinite(n) ? n : null;
      } catch (e) {
        rethrowCapabilityMissing(e);
        return null;
      }
    };
    const report = await scanBrainSources(engine, {
      signal: fmAbort,
      deadline: fmDeadline,
      dbPageCountForSource,
      frontmatterOnly: true,
    });

    const missing = report.per_source.filter(src => src.status === 'missing');
    if (report.total === 0 && !report.partial && !missing.length) {
      const sources = report.per_source.length;
      checks.push({
        name: 'frontmatter_integrity',
        status: 'ok',
        message: sources === 0
          ? 'No registered sources to scan'
          : `${sources} source(s) clean — no frontmatter issues`,
      });
    } else {
      // Build per-source breakdown that distinguishes scanned / partial /
      // skipped so the user can tell which sources weren't checked.
      const sourceMessages: string[] = [];
      for (const src of report.per_source) {
        if (src.status === 'missing') {
          sourceMessages.push(`${src.source_id}: NOT SCANNED (its directory ${src.source_path} is missing)`);
          continue;
        }
        if (src.status === 'skipped') {
          // Codex adversarial #1: `gbrain frontmatter validate` takes a
          // filesystem PATH, not a source id. Pre-fix the hint pointed users
          // at a command that would fail with "no such directory" — breaking
          // the very remediation path this PR ships to give them.
          sourceMessages.push(
            `${src.source_id}: NOT SCANNED (timeout — run \`gbrain frontmatter validate ${src.source_path}\`)`,
          );
          continue;
        }
        if (src.status === 'partial') {
          const denom = src.db_page_count != null ? ` (source has ~${src.db_page_count} pages in DB)` : '';
          const codes = src.total > 0
            ? `, ${Object.entries(src.errors_by_code).map(([k, v]) => `${k}=${v}`).join(', ')}`
            : '';
          sourceMessages.push(
            `${src.source_id}: PARTIAL — scanned ~${src.files_scanned} files${denom}, ${src.total} issue(s) so far${codes}`,
          );
          continue;
        }
        // status === 'scanned'
        if (src.total === 0) continue; // clean source — don't clutter the message
        const codes = Object.entries(src.errors_by_code)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ');
        sourceMessages.push(`${src.source_id}: ${src.total} (${codes})`);
      }
      const repairHint = 'Fix: gbrain repair frontmatter --source <id> previews the line fix for every file it can repair (and names the manual fix for the rest, '
        + 'such as a missing opening ---); on an unmanaged checkout gbrain frontmatter validate <source-path> --fix applies the same safe fixes';
      const sourcesWithIssues = report.per_source.filter(src => src.total > 0).map(src => src.source_id);
      const missingHint = missing.length ? `Restore the missing directory, or point the source at its checkout with gbrain sources set-path <id> <path>. ` : '';
      const fixHint = missingHint + (report.partial
        ? `Raise GBRAIN_DOCTOR_FM_TIMEOUT_MS or run \`gbrain frontmatter validate <source-path>\` directly. ${repairHint}`
        : repairHint);
      checks.push({
        name: 'frontmatter_integrity',
        status: 'warn',
        // #7145: a partial walk is a floor with health unknown past it, readable without parsing the message.
        details: { count: report.total, partial: report.partial, exact: !report.partial && !missing.length,
          ...(missing.length ? { missing_sources: missing.map(src => src.source_id) } : {}),
          ...(report.partial ? { ...boundUnknownDetails('time'), limit: fmTimeoutMs } : {}) },
        message:
          `${report.total} frontmatter issue(s)` +
          (report.partial ? ` (PARTIAL SCAN — timeout after ${fmTimeoutMs / 1000}s)` : '') +
          `. ${sourceMessages.join('; ')}. ${fixHint}`,
        ...(sourcesWithIssues.length === 1 ? { fix: agentFix(['gbrain', 'repair', 'frontmatter', '--source', sourcesWithIssues[0]!],
          'Previews the line fix for each file the repair can fix and names the manual fix for the rest; it writes nothing.', 'frontmatter_integrity',
          { docs: 'docs/guides/repair.md#frontmatter' }) } : missing.length ? { fix_unavailable_reason: 'operator_judgement' as const } : {}),
      });
    }
    checks.push(frontmatterRepairableFromReport(report, fmTimeoutMs));
  } catch (e) {
    // Codex outside-voice D4: the abort path returns cleanly via partial
    // state — this catch is purely for unexpected errors (FS permission,
    // OOM, disk full, etc.). Pre-v0.38.2.0 (PR #1287) had an unreachable
    // abort-classifier branch here; removed because timer-based aborts
    // in a sync walker can't surface as a thrown error anyway.
    const refusal = capabilityRefusal(e);
    checks.push(refusal ? capabilityUnknownCheck('frontmatter_integrity', refusal) : checkError('frontmatter_integrity', 'scan frontmatter', e));
  } finally {
    fmHb();
  }
  return checks;
}

export const frontmatterEntry: DoctorEntry = {
  name: 'frontmatter_integrity',
  emits: ['frontmatter_integrity', 'frontmatter_repairable'],
  run: runFrontmatter,
};
