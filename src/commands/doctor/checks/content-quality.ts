/**
 * Content quality: oversized / scraper-junk pages and the content-sanity audit, quarantined and flagged pages, unverified extractions, frontmatter integrity.
 *
 * Doctor registry entry module (refactor wave 1, W4 doctor). Each run*(ctx)
 * function holds one block of the former `buildChecks` body, moved
 * verbatim; the check order and the check-name categories are owned by
 * src/commands/doctor/registry.ts and src/core/doctor-categories.ts.
 */

import { EMBED_SKIP_FILTER_FRAGMENT } from '../../../core/embed-skip.ts';
import { startHeartbeat } from '../../../core/progress.ts';
import { checkUnverifiedExtractions } from './extraction-sync.ts';
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { checkError } from '../check-fix.ts';

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
    // Read effective bytes_block from the cached effectiveCfg loaded
    // earlier in this doctor run if available; otherwise default.
    // (We re-read here per-check to avoid threading config through
    // every check — bytes_block is read once per doctor run via
    // loadConfig which caches in module-level config layer.)
    const { loadConfig: _loadCfg } = await import('../../../core/config.ts');
    const _cfg = _loadCfg();
    const bytesBlock = _cfg?.content_sanity?.bytes_block ?? 500_000;
    // #1871: engine.executeRaw, not the dead-on-PGLite postgres singleton.
    const rows = await engine.executeRaw<{ slug: string; source_id: string; bytes: number }>(
      `SELECT p.slug, p.source_id,
              octet_length(p.compiled_truth) + octet_length(COALESCE(p.timeline, '')) AS bytes
       FROM pages p
       WHERE p.deleted_at IS NULL
         AND ${EMBED_SKIP_FILTER_FRAGMENT}
         AND (octet_length(p.compiled_truth) + octet_length(COALESCE(p.timeline, ''))) > $1
       ORDER BY bytes DESC
       LIMIT 100`,
      [bytesBlock],
    );
    if (rows.length === 0) {
      checks.push({
        name: 'oversized_pages',
        status: 'ok',
        message: `No pages exceed ${bytesBlock} bytes (excluding embed_skip pages, which already took the accepted non-embeddable remediation)`,
      });
    } else {
      const oversizeRows = rows as unknown as Array<{ slug: string; source_id: string; bytes: number }>;
      const top = oversizeRows.slice(0, 3)
        .map(r => `${r.slug} (${r.bytes}b, src=${r.source_id})`)
        .join('; ');
      checks.push({
        name: 'oversized_pages',
        status: 'warn',
        message: `${rows.length} page(s) exceed ${bytesBlock}-byte block threshold. Top: ${top}. New ingests with the same shape get frontmatter.embed_skip set automatically; existing oversized pages can be split or accepted as non-embeddable.`,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({
      name: 'oversized_pages',
      status: 'ok',
      message: `Skipped (${msg})`,
    });
  }

  progress.heartbeat('scraper_junk_pages');
  try {
    const { assessContentSanity } = await import('../../../core/content-sanity.ts');
    const { loadOperatorLiterals } = await import('../../../core/content-sanity-literals.ts');
    const literals = loadOperatorLiterals();
    const scanLimit = fullContentAudit ? null : 1000;
    // #1871: engine.executeRaw, not the dead-on-PGLite postgres singleton.
    const rows = scanLimit
      ? await engine.executeRaw(
          `SELECT p.slug, p.source_id, p.title,
                  LEFT(p.compiled_truth, 2048) AS body_head,
                  LEFT(COALESCE(p.timeline, ''), 1024) AS tl_head,
                  p.frontmatter
             FROM pages p
            WHERE p.deleted_at IS NULL
            ORDER BY p.updated_at DESC
            LIMIT $1`,
          [scanLimit],
        )
      : await engine.executeRaw(
          `SELECT p.slug, p.source_id, p.title,
                  LEFT(p.compiled_truth, 2048) AS body_head,
                  LEFT(COALESCE(p.timeline, ''), 1024) AS tl_head,
                  p.frontmatter
             FROM pages p
            WHERE p.deleted_at IS NULL`,
        );
    const hits: Array<{ slug: string; matched: string[] }> = [];
    const scanRows = rows as unknown as Array<{ slug: string; source_id: string; title: string; body_head: string; tl_head: string; frontmatter: Record<string, unknown> | null }>;
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
      checks.push({
        name: 'scraper_junk_pages',
        status: 'ok',
        message: scanLimit
          ? `No junk-pattern hits in ${rows.length} recent page(s) (use --content-audit for full scan)`
          : `No junk-pattern hits in ${rows.length} page(s) (full audit)`,
      });
    } else {
      const top = hits.slice(0, 3).map(h => `${h.slug} [${h.matched.join(',')}]`).join('; ');
      checks.push({
        name: 'scraper_junk_pages',
        status: 'warn',
        message: `${hits.length} page(s) match junk patterns. Top: ${top}. ${scanLimit ? '(scanned 1000 most-recent; rerun with --content-audit for full scan)' : '(full audit)'} New ingests with these shapes are now hard-blocked; existing inventory should be cleaned at source.`,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({
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
    const rows = await engine.executeRaw<{ n: string | number }>(
      `SELECT COUNT(*)::int AS n FROM pages p WHERE p.deleted_at IS NULL AND p.frontmatter ? 'quarantine'`,
    );
    const n = Number(rows[0]?.n ?? 0);
    checks.push({
      name: 'quarantined_pages',
      status: n > 0 ? 'warn' : 'ok',
      message: n > 0
        ? `${n} page(s) quarantined as junk (hidden from search). Review with 'gbrain quarantine list'; clear a false positive with 'gbrain quarantine clear <slug>'.`
        : 'No quarantined pages',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({ name: 'quarantined_pages', status: 'ok', message: `Skipped (${msg})` });
  }

  progress.heartbeat('flagged_pages');
  try {
    const rows = await engine.executeRaw<{ n: string | number }>(
      `SELECT COUNT(*)::int AS n FROM pages p WHERE p.deleted_at IS NULL AND p.frontmatter ? 'content_flag'`,
    );
    const n = Number(rows[0]?.n ?? 0);
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
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({ name: 'flagged_pages', status: 'ok', message: `Skipped (${msg})` });
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
  const fmTimeoutMs = (() => {
    const raw = process.env.GBRAIN_DOCTOR_FM_TIMEOUT_MS;
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 30000;
  })();
  try {
    const { scanBrainSources } = await import('../../../core/brain-writer.ts');
    const fmDeadline = Date.now() + fmTimeoutMs;
    const fmAbort = AbortSignal.timeout(fmTimeoutMs);
    // Per-source DB denominator. Coarse — DB pages and on-disk syncable
    // files are overlapping but not identical (unsynced disk files,
    // soft-deleted DB rows, auto-generated pages). Wording in the partial
    // message makes the mismatch honest. Failure of the COUNT degrades to
    // null and the message falls back to bare numerator.
    const dbPageCountForSource = async (sourceId: string): Promise<number | null> => {
      try {
        const rows = await engine.executeRaw<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM pages WHERE source_id = $1 AND deleted_at IS NULL`,
          [sourceId],
        );
        if (rows.length === 0) return null;
        const parsed = parseInt(rows[0].n, 10);
        return Number.isFinite(parsed) ? parsed : null;
      } catch {
        return null;
      }
    };
    const report = await scanBrainSources(engine, {
      signal: fmAbort,
      deadline: fmDeadline,
      dbPageCountForSource,
    });

    if (report.total === 0 && !report.partial) {
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
      const fixHint = report.partial
        ? `Raise GBRAIN_DOCTOR_FM_TIMEOUT_MS or run \`gbrain frontmatter validate <source>\` directly. Fix issues: \`gbrain frontmatter validate <source> --fix\``
        : `Fix: gbrain frontmatter validate <source-path> --fix`;
      checks.push({
        name: 'frontmatter_integrity',
        status: 'warn',
        message:
          `${report.total} frontmatter issue(s)` +
          (report.partial ? ` (PARTIAL SCAN — timeout after ${fmTimeoutMs / 1000}s)` : '') +
          `. ${sourceMessages.join('; ')}. ${fixHint}`,
      });
    }
  } catch (e) {
    // Codex outside-voice D4: the abort path returns cleanly via partial
    // state — this catch is purely for unexpected errors (FS permission,
    // OOM, disk full, etc.). Pre-v0.38.2.0 (PR #1287) had an unreachable
    // abort-classifier branch here; removed because timer-based aborts
    // in a sync walker can't surface as a thrown error anyway.
    checks.push(checkError('frontmatter_integrity', 'scan frontmatter', e));
  } finally {
    fmHb();
  }
  return checks;
}

export const frontmatterEntry: DoctorEntry = {
  name: 'frontmatter_integrity',
  emits: ['frontmatter_integrity'],
  run: runFrontmatter,
};
