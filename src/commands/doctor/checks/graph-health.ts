/**
 * Graph health: link / timeline coverage and brain score, orphan ratio, stale mentions, timeline orphans, slug collisions and the managed-persistence wave checks.
 *
 * Doctor registry entry module (refactor wave 1, W4 doctor). Each run*(ctx)
 * function holds one block of the former `buildChecks` body, moved
 * verbatim; the check order and the check-name categories are owned by
 * src/commands/doctor/registry.ts and src/core/doctor-categories.ts.
 */

import { startHeartbeat } from '../../../core/progress.ts';
import { quarantineFilterFragment } from '../../../core/quarantine.ts';
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

async function runGraphCoverage(ctx: DoctorContext): Promise<Check[]> {
  const { progress } = ctx;
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];

  // 9. Graph health (link + timeline coverage on entity pages).
  // dead_links removed in v0.10.1: ON DELETE CASCADE on link FKs makes it always 0.
  //
  // Skip when the brain has 0 entity pages (markdown-only wikis, journals,
  // notes brains). The coverage formula divides by entity-page count, so it's
  // structurally undefined when no entities exist — emitting WARN under that
  // condition is a false positive. Closes #530.
  progress.heartbeat('graph_coverage');
  try {
    const health = await engine.getHealth();
    const entityCount = (await engine.executeRaw<{ count: number }>(
      // deleted_at IS NULL: a brain whose only entity pages are soft-deleted has
      // zero LIVE entities, and must take the short-circuit below rather than
      // warn about coverage on pages the rest of the system treats as gone.
      // buildGazetteer (src/core/by-mention.ts) already filters this way, so
      // without it the two disagree about whether entity pages exist at all.
      // #4280: quarantined shells are excluded too — parity with onboard's
      // VISIBLE_ENTITY_PREDICATE, which never counted them.
      `SELECT COUNT(*)::int AS count FROM pages WHERE deleted_at IS NULL AND type IN ('entity', 'person', 'company', 'organization') AND ${quarantineFilterFragment('pages')}`,
    ))[0]?.count ?? 0;

    // Compute coverage against eligible entities only — exclude test fixtures
    // (`tools/gbrain/test/*`) and template stubs (`templates/new-person`) so
    // that brains seeded only with code sources don't get spurious warnings
    // about missing link/timeline coverage on pages that are test fixtures, not
    // real knowledge entities.
    // #4191: an entity counts as CONNECTED with an inbound OR outbound link.
    // Counting outbound only (from_page_id) contradicted onboard's
    // entity_link_coverage (inbound EXISTS, target 70%): a brain of
    // inbound-only entities (meetings link TO people) read ok there and
    // warn here. Same in/out predicate + 70% target both places now.
    const eligibleStats = (await engine.executeRaw<{ entities: number; connected: number; timeline: number }>(
      `WITH eligible AS (
        SELECT id FROM pages
        WHERE deleted_at IS NULL
          AND type IN ('entity','person','company','organization')
          AND ${quarantineFilterFragment('pages')}
          AND slug NOT LIKE 'tools/gbrain/test/%'
          AND slug <> 'templates/new-person'
      )
      SELECT
        (SELECT count(*)::int FROM eligible) AS entities,
        (SELECT count(*)::int FROM eligible e
           WHERE EXISTS (SELECT 1 FROM links l WHERE l.from_page_id = e.id)
              OR EXISTS (SELECT 1 FROM links l WHERE l.to_page_id = e.id)) AS connected,
        (SELECT count(DISTINCT page_id)::int FROM timeline_entries WHERE page_id IN (SELECT id FROM eligible)) AS timeline`,
    ))[0] ?? { entities: entityCount, connected: 0, timeline: 0 };

    const eligibleEntityCount = Number(eligibleStats.entities ?? entityCount);
    const linkCoverage = eligibleEntityCount > 0 ? Number(eligibleStats.connected ?? 0) / eligibleEntityCount : 0;
    const timelineCoverage = eligibleEntityCount > 0 ? Number(eligibleStats.timeline ?? 0) / eligibleEntityCount : 0;
    const linkPct = (linkCoverage * 100).toFixed(0);
    const timelinePct = (timelineCoverage * 100).toFixed(0);
    if (entityCount === 0) {
      // Markdown-only / journal / wiki brain — no entity pages to compute
      // coverage against. Coverage formula is structurally inapplicable.
      checks.push({
        name: 'graph_coverage',
        status: 'ok',
        message: 'No entity pages — graph_coverage not applicable (markdown-only brain)',
      });
    } else if (eligibleEntityCount === 0) {
      checks.push({
        name: 'graph_coverage',
        status: 'ok',
        message: `Only code/test fixture entity pages found (${entityCount}); graph_coverage not applicable`,
      });
    } else if (linkCoverage >= 0.7 && timelineCoverage >= 0.5) {
      checks.push({ name: 'graph_coverage', status: 'ok', message: `Entity connected coverage (in/out) ${linkPct}%, entity timeline coverage ${timelinePct}%` });
    } else {
      checks.push({
        name: 'graph_coverage',
        status: 'warn',
        message: `Entity connected coverage (in/out) ${linkPct}% (target 70%), entity timeline coverage ${timelinePct}% (${eligibleEntityCount} entity pages). Run: gbrain extract all`,
      });
    }

    // Bug 11 — brain_score breakdown. When the total is < 100, show which
    // components contributed the deficit so users know what to fix.
    // Uses distinct *_score field names (not overloading link_coverage /
    // timeline_coverage, which are entity-scoped).
    if (health.brain_score < 100) {
      const parts = [
        `embed ${health.embed_coverage_score}/35`,
        `links ${health.link_density_score}/25`,
        `timeline density (all pages) ${health.timeline_coverage_score}/15`,
        `orphans ${health.no_orphans_score}/15`,
        `dead-links ${health.no_dead_links_score}/10`,
      ];
      checks.push({
        name: 'brain_score',
        status: health.brain_score >= 70 ? 'ok' : 'warn',
        message: `Brain score ${health.brain_score}/100 (${parts.join(', ')})`,
      });
    } else {
      checks.push({ name: 'brain_score', status: 'ok', message: `Brain score 100/100` });
    }
  } catch {
    checks.push({ name: 'graph_coverage', status: 'warn', message: 'Could not check graph coverage' });
  }
  return checks;
}

export const graphCoverageEntry: DoctorEntry = {
  name: 'graph_coverage',
  emits: ['graph_coverage', 'brain_score'],
  run: runGraphCoverage,
};

async function runOrphanRatio(ctx: DoctorContext): Promise<Check[]> {
  const { orphanRatioSourceId, progress } = ctx;
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];

  // 9b. v0.41.18.0 — orphan_ratio check (migration #1 of #1409).
  //
  // Surfaces the fraction of linkable pages with no inbound links.
  // Consumes the same canonical getOrphansData() pure fn as
  // `gbrain orphans --count` (D1), so the two surfaces cannot disagree.
  //
  // Skip when entity count < 100 (vacuous — small brains naturally
  // show high orphan ratio; not actionable signal).
  // Warn at >0.5; fail at >0.8. Both states recommend
  // `gbrain extract links --by-mention` as the fix.
  // v0.41.29.0: explicit `--source <id>` scopes this check to one source
  // (orphanRatioSourceId, parsed at the top of buildChecks). The entity-count
  // gate + getOrphansData both scope to it; messages name the source. Bare
  // doctor (no --source) stays brain-wide.
  progress.heartbeat('orphan_ratio');
  try {
    const { getOrphansData } = await import('../../orphans.ts');
    const srcId = orphanRatioSourceId;
    const inSource = srcId ? ` in source '${srcId}'` : '';
    const entityCount = (await engine.executeRaw<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM pages WHERE type IN ('entity', 'person', 'company', 'organization') AND deleted_at IS NULL${srcId ? ' AND source_id = $1' : ''}`,
      srcId ? [srcId] : [],
    ))[0]?.count ?? 0;
    // Brain-wide (no --source): <100 entities is vacuous — small brains
    // naturally show a high orphan ratio; not actionable signal. Skip.
    if (entityCount < 100 && !srcId) {
      checks.push({
        name: 'orphan_ratio',
        status: 'ok',
        message: `Vacuous: ${entityCount} entity pages (<100). Orphan ratio not meaningful at this scale.`,
      });
    } else {
      // F7 (Codex): under EXPLICIT --source, an operator deliberately asked
      // about one source — answer it even below 100 entities, with a
      // low-scale caveat, instead of swallowing a real per-source failure
      // (e.g. 80 fully-orphaned entity pages) behind a vacuous "ok".
      const data = await getOrphansData(engine, { includePseudo: false, sourceId: srcId });
      const ratio = data.total_linkable > 0 ? data.total_orphans / data.total_linkable : 0;
      const pct = (ratio * 100).toFixed(0);
      const caveat =
        entityCount < 100
          ? ` — low scale (${entityCount} entity pages <100), interpret with caution`
          : '';
      const hint =
        'Run: gbrain extract links --by-mention   (auto-links entity mentions in body text). ' +
        'Run gbrain orphans for the list.';
      if (ratio > 0.8) {
        checks.push({
          name: 'orphan_ratio',
          status: 'fail',
          message: `Orphan ratio ${pct}%${inSource} (${data.total_orphans}/${data.total_linkable} linkable pages have no inbound links)${caveat}. ${hint}`,
        });
      } else if (ratio > 0.5) {
        checks.push({
          name: 'orphan_ratio',
          status: 'warn',
          message: `Orphan ratio ${pct}%${inSource} (${data.total_orphans}/${data.total_linkable} linkable pages have no inbound links)${caveat}. ${hint}`,
        });
      } else {
        checks.push({
          name: 'orphan_ratio',
          status: 'ok',
          message: `Orphan ratio ${pct}%${inSource} (${data.total_orphans}/${data.total_linkable} linkable pages)${caveat}`,
        });
      }
    }
  } catch {
    checks.push({ name: 'orphan_ratio', status: 'warn', message: 'Could not check orphan ratio' });
  }
  return checks;
}

export const orphanRatioEntry: DoctorEntry = {
  name: 'orphan_ratio',
  emits: ['orphan_ratio'],
  run: runOrphanRatio,
};

async function runStaleMentions(ctx: DoctorContext): Promise<Check[]> {
  const { progress } = ctx;
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];

  // 9c. stale_mentions (#3674, lands PR #3711) — read-only drift surface for
  // by-mention links the current gazetteer no longer produces. Logic lives in
  // doctor/checks/stale-mentions.ts (module-dir rule); it never throws.
  progress.heartbeat('stale_mentions');
  const staleMentionsHb = startHeartbeat(progress, 're-deriving by-mention links…');
  try {
    const { staleMentionsCheck } = await import('./stale-mentions.ts');
    checks.push(await staleMentionsCheck(engine));
  } finally {
    staleMentionsHb();
  }
  progress.heartbeat('timeline_orphans');
  const { timelineOrphansCheck } = await import('./timeline-orphans.ts');
  checks.push(await timelineOrphansCheck(engine));
  progress.heartbeat('slug_collisions');
  const { slugCollisionsCheck } = await import('./slug-collisions.ts');
  checks.push(await slugCollisionsCheck(engine));
  return checks;
}

export const staleMentionsEntry: DoctorEntry = {
  name: 'stale_mentions',
  emits: ['stale_mentions', 'timeline_orphans', 'slug_collisions'],
  run: runStaleMentions,
};

async function runTimelineHistory(ctx: DoctorContext): Promise<Check[]> {
  const { orphanRatioSourceId, progress } = ctx;
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];

  // 9d. Wave 2 residual-state signals (#5567, #5525): database-only timeline
  // rows and derived pages without explicit visibility. Bounded, never throw.
  progress.heartbeat('timeline_history');
  {
    const { timelineHistoryCheck } = await import('./timeline-history.ts');
    const { derivedVisibilityCheck } = await import('./derived-visibility.ts');
    checks.push(await timelineHistoryCheck(engine, orphanRatioSourceId), await derivedVisibilityCheck(engine, orphanRatioSourceId));
    // Wave checks registered in doctor/wave-checks.ts rather than inline here.
    const { runWaveChecks } = await import('../wave-checks.ts');
    for (const finding of await runWaveChecks(engine, { only: 'wave', sourceIds: orphanRatioSourceId ? [orphanRatioSourceId] : undefined })) checks.push(finding.check);
  }
  return checks;
}

export const timelineHistoryEntry: DoctorEntry = {
  name: 'timeline_history',
  emits: [
    'timeline_history',
    'derived_visibility',
    'safe_index_pending',
    'credential_projection_pending',
    'connector_checkpoints',
    'persistence_request_indexes',
    'persistence_request_growth',
    'connector_held_items',
    'orphan_persistence_bindings',
    'unbound_source',
    'writer_version',
    'self_capture',
    'vector_plan',
    'stale_embedding_effects',
    'google_file_modes',
    'extractor_facts_expired',
  ],
  run: runTimelineHistory,
};
