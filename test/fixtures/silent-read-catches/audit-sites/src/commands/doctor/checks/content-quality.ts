// @ts-nocheck
// Pinned audit sites: code copied verbatim from src/commands/doctor/checks/content-quality.ts at origin/master 7ef3d53a47 (parsed by the guard test, never run).
// The test asserts each catch below is counted under the path#function key that scripts/silent-read-catches-baseline.tsv uses.

// verbatim src/commands/doctor/checks/content-quality.ts:285-338
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
        ? `${n} page(s) quarantined as junk (hidden from search). Review with 'gbrain quarantine list'; clear a false positive with 'gbrain quarantine clear <slug> --force' (it stays cleared until the page changes; a pattern that misfires brain-wide is turned off with content_sanity.disabled_patterns).`
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

export async function runContentSanity(engine: any) {
  // verbatim src/commands/doctor/checks/content-quality.ts:123-194
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
    // Decision #10: a segmented row's body heads are NULL, so only its title was assessed (LIMIT NULL is the full audit).
    const [segmentedRow] = await engine.executeRaw<{ n: number }>(`SELECT COUNT(*)::int AS n FROM (SELECT p.body_storage FROM pages p
       WHERE p.deleted_at IS NULL ORDER BY p.updated_at DESC LIMIT $1) s WHERE s.body_storage = 'segmented'`, [scanLimit]).catch(() => []);
    const segmentedScanned = Number(segmentedRow?.n ?? 0);
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
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({
      name: 'scraper_junk_pages',
      status: 'ok',
      message: `Skipped (${msg})`,
    });
  }
  // ...
  // verbatim src/commands/doctor/checks/content-quality.ts:197-247
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
}
