// @ts-nocheck
// Pinned audit sites: code copied verbatim from src/commands/doctor/checks/calibration.ts at origin/master 7ef3d53a47 (parsed by the guard test, never run).
// The test asserts each catch below is counted under the path#function key that scripts/silent-read-catches-baseline.tsv uses.

export async function checkLinkResolutionOpportunity(engine: any) {
  // verbatim src/commands/doctor/checks/calibration.ts:247-361
  try {
    if (await isGlobalBasenameEnabled(engine)) {
      return { name, status: 'ok', message: 'global_basename mode already enabled' };
    }
    // A remote caller's grant confines the slug index, the page total and the
    // scanned sample to its own sources.
    let allSlugs: Set<string>;
    if (opts.sourceIds) {
      allSlugs = new Set();
      for (const sourceId of opts.sourceIds) for (const slug of await engine.getAllSlugs({ sourceId })) allSlugs.add(slug);
    } else {
      allSlugs = await engine.getAllSlugs();
    }
    const scope = opts.sourceIds ? ' AND source_id = ANY($1::text[])' : '';
    const scopeParams = opts.sourceIds ? [opts.sourceIds] : undefined;
    if (allSlugs.size === 0) {
      return { name, status: 'ok', message: 'Brain is empty — nothing to scan' };
    }
    // Build a basename → slug[] index ONCE for the entire scan via the shared
    // builder (issue #972 codex [P2] DRY) — same key set (raw/lower/slugified)
    // as extraction, so this estimate matches what extraction actually
    // resolves. Pre-fix the doctor omitted the slugified key and undercounted.
    const basenameIndex = buildBasenameIndex(allSlugs);

    let bareCount = 0;
    let wouldResolveCount = 0;
    const distinctTargets = new Set<string>();

    // Issue #972 (codex [P2] perf): batch-load the most-recent N pages in ONE
    // query instead of listAllPageRefs() + a getPage() per page. The prior
    // full N-page walk hit the 60s budget every run on large brains and
    // returned a perpetual partial; this bounds the work to a fixed sample.
    const SAMPLE_LIMIT = 1000;
    const sampled = await engine.executeRaw<{ compiled_truth: string | null; timeline: string | null }>(
      `SELECT compiled_truth, timeline FROM pages WHERE deleted_at IS NULL${scope} ORDER BY id DESC LIMIT ${SAMPLE_LIMIT}`,
      scopeParams,
    );
    // Decision #10: a segmented page's body columns are NULL, so the sample scans it as an empty body.
    const [segmented] = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM (SELECT body_storage FROM pages WHERE deleted_at IS NULL${scope} ORDER BY id DESC LIMIT ${SAMPLE_LIMIT}) s WHERE s.body_storage = 'segmented'`,
      scopeParams,
    ).catch(() => []);
    const result = (check: Check) => withSkippedSegmented(check, Number(segmented?.n ?? 0));
    const totalPages = allSlugs.size;
    const sampledNote = totalPages > SAMPLE_LIMIT
      ? ` (scanned the ${SAMPLE_LIMIT} most-recent of ${totalPages} pages)`
      : '';
    // #7145: a sample is not the brain: every verdict below names it and carries exact: false.
    const sampleDetails = totalPages > SAMPLE_LIMIT ? { exact: false, bound: 'sample', limit: SAMPLE_LIMIT, sampled: sampled.length, total_pages: totalPages } : undefined;
    const deadline = Date.now() + 60_000;
    let stoppedAtDeadline = false;
    const hb = progress ? startHeartbeat(progress, `scanning ${sampled.length} pages for bare wikilinks…`) : null;
    try {
      for (const row of sampled) {
        if (Date.now() > deadline) { stoppedAtDeadline = true; break; } // backstop; in-memory scan rarely hits it
        const content = (row.compiled_truth ?? '') + '\n' + (row.timeline ?? '');
        for (const e of extractEntityRefs(content)) {
          if (!e.needsResolution) continue;
          bareCount++;
          // Issue #972 (codex): match on the wikilink TARGET (e.slug), not
          // the display alias (e.name), via the shared query so the doctor
          // estimate equals what extraction actually resolves.
          const matches = queryBasenameIndex(basenameIndex, e.slug);
          if (matches.length > 0) {
            wouldResolveCount++;
            for (const m of matches) distinctTargets.add(m);
          }
        }
      }
    } finally {
      hb?.();
    }

    if (stoppedAtDeadline) {
      return result({ name, status: 'warn', details: { ...boundUnknownDetails('time'), limit: 60_000, bare_wikilinks_so_far: bareCount },
        message: `Link resolution opportunity unknown: the scan stopped at its 60 s limit before reading every sampled page${sampledNote}; ${bareCount} bare wikilink(s) seen so far.` });
    }
    if (bareCount === 0) {
      return result({ name, status: 'ok', message: `No bare wikilinks found${sampledNote}`, ...(sampleDetails ? { details: sampleDetails } : {}) });
    }
    if (wouldResolveCount === 0) {
      return result({
        name,
        status: 'ok',
        message: `${bareCount} bare wikilink(s) found${sampledNote}, but none have basename matches in the brain.`,
        ...(sampleDetails ? { details: sampleDetails } : {}),
      });
    }
    const ratio = wouldResolveCount / bareCount;
    if (wouldResolveCount >= 5 && ratio >= 0.20) {
      const pct = Math.round(ratio * 100);
      return result({
        name,
        status: 'warn',
        message:
          `${wouldResolveCount} of ${bareCount} bare wikilinks (${pct}%) would resolve to ` +
          `${distinctTargets.size} distinct page(s) under global_basename mode${sampledNote}. ` +
          `Enable with: gbrain config set link_resolution.global_basename true`,
        ...(sampleDetails ? { details: sampleDetails } : {}),
      });
    }
    const pct = Math.round(ratio * 100);
    return result({
      name,
      status: 'ok',
      message: `${wouldResolveCount}/${bareCount} bare wikilinks (${pct}%) would resolve — below the 20% / 5-link threshold for surfacing a hint${sampledNote}.`,
      ...(sampleDetails ? { details: sampleDetails } : {}),
    });
  } catch (e) {
    return {
      name,
      status: 'ok',
      message: `Skipped (${e instanceof Error ? e.message : String(e)})`,
    };
  }
}
