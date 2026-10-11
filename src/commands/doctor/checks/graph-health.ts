/**
 * Graph health: link / timeline coverage and brain score, orphan ratio, stale mentions, timeline orphans, slug collisions and the managed-persistence wave checks.
 *
 * Doctor registry entry module (refactor wave 1, W4 doctor). Each run*(ctx)
 * function holds one block of the former `buildChecks` body, moved
 * verbatim; the check order and the check-name categories are owned by
 * src/commands/doctor/registry.ts and src/core/doctor-categories.ts.
 */

import { renderFragment, sqlFragment, trustedSql } from '../../../core/engine-sql/fragment.ts';
import { startHeartbeat } from '../../../core/progress.ts';
import { quarantineFilterFragment } from '../../../core/quarantine.ts';
import { entityTypePredicateSql, resolveEntityTypes } from '../../../core/schema-pack/entity-types.ts';
import { MIN_ENTITY_PAGES_FOR_COVERAGE } from '../../../core/types.ts';
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { brainScorePlanFix, checkError } from '../check-fix.ts';

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
    // #4772: the entity types come from the active schema pack(s), per source,
    // through the same policy getHealth binds. A pack that does not load is a
    // warn below, never a legacy-list reading.
    const entityTypes = await resolveEntityTypes(engine, null);
    const isEntity = entityTypePredicateSql('pages', entityTypes.filter);
    const quarantine = trustedSql(quarantineFilterFragment('pages'));
    // deleted_at IS NULL: a brain whose only entity pages are soft-deleted has
    // zero LIVE entities, and must take the short-circuit below rather than
    // warn about coverage on pages the rest of the system treats as gone.
    // buildGazetteer (src/core/by-mention.ts) already filters this way, so
    // without it the two disagree about whether entity pages exist at all.
    // #4280: quarantined shells are excluded too — parity with onboard's
    // VISIBLE_ENTITY_PREDICATE, which never counted them.
    const countSql = renderFragment(sqlFragment`SELECT COUNT(*)::int AS count FROM pages WHERE pages.deleted_at IS NULL AND ${isEntity} AND ${quarantine}`);
    const entityCount = (await engine.executeRaw<{ count: number }>(countSql.text, countSql.params))[0]?.count ?? 0;

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
    const eligibleSql = renderFragment(sqlFragment`WITH eligible AS (
        SELECT pages.id FROM pages
        WHERE pages.deleted_at IS NULL
          AND ${isEntity}
          AND ${quarantine}
          AND pages.slug NOT LIKE 'tools/gbrain/test/%'
          AND pages.slug <> 'templates/new-person'
      )
      SELECT
        (SELECT count(*)::int FROM eligible) AS entities,
        (SELECT count(*)::int FROM eligible e
           WHERE EXISTS (SELECT 1 FROM links l WHERE l.from_page_id = e.id)
              OR EXISTS (SELECT 1 FROM links l WHERE l.to_page_id = e.id)) AS connected,
        (SELECT count(DISTINCT page_id)::int FROM timeline_entries WHERE page_id IN (SELECT id FROM eligible)) AS timeline`);
    const eligibleStats = (await engine.executeRaw<{ entities: number; connected: number; timeline: number }>(eligibleSql.text, eligibleSql.params))[0]
      ?? { entities: entityCount, connected: 0, timeline: 0 };

    const eligibleEntityCount = Number(eligibleStats.entities ?? entityCount);
    const linkCoverage = eligibleEntityCount > 0 ? Number(eligibleStats.connected ?? 0) / eligibleEntityCount : 0;
    const timelineCoverage = eligibleEntityCount > 0 ? Number(eligibleStats.timeline ?? 0) / eligibleEntityCount : 0;
    const linkPct = (linkCoverage * 100).toFixed(0);
    const timelinePct = (timelineCoverage * 100).toFixed(0);
    if (entityTypes.status === 'pack_unavailable') {
      const where = entityTypes.unresolved.filter(Boolean);
      checks.push({
        name: 'graph_coverage',
        status: 'warn',
        message: `Entity types unknown: the active schema pack${where.length ? ` for source${where.length > 1 ? 's' : ''} ${where.map((id) => `'${id}'`).join(', ')}` : ''} did not load, so entity coverage cannot be graded. Run \`gbrain schema active${where.length ? ' --source <id>' : ''}\` to debug.`,
        details: { unresolved_sources: where },
      });
    } else if (entityCount === 0) {
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
    } else if (eligibleEntityCount < MIN_ENTITY_PAGES_FOR_COVERAGE) {
      // Same small-N floor BrainHealth grades from: a 1-4 page ratio is noise,
      // and warning on it leaves a WARN that `extract all` cannot clear.
      const pages = eligibleEntityCount === 1 ? 'page' : 'pages';
      checks.push({
        name: 'graph_coverage',
        status: 'ok',
        message: `Only ${eligibleEntityCount} eligible entity ${pages} (< ${MIN_ENTITY_PAGES_FOR_COVERAGE}) — coverage ratio not meaningful at this scale`,
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
        `timeline density (entity and event pages) ${health.timeline_coverage_score}/15`,
        `orphans ${health.no_orphans_score}/15`,
        `dead-links ${health.no_dead_links_score}/10`,
      ];
      checks.push({
        name: 'brain_score',
        status: health.brain_score >= 70 ? 'ok' : 'warn',
        message: `Brain score ${health.brain_score}/100 (${parts.join(', ')})`,
        ...(health.brain_score >= 70 ? {} : { fix: brainScorePlanFix() }),
      });
    } else {
      checks.push({ name: 'brain_score', status: 'ok', message: `Brain score 100/100` });
    }
  } catch {
    checks.push(checkError('graph_coverage', 'check graph coverage'));
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
  // Surfaces the fraction of linkable pages with no links in either direction.
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
    // #4772: entity types per the pack of the asked source (brain-wide: every source's pack).
    const entityTypes = await resolveEntityTypes(engine, srcId ? [srcId] : null);
    const countSql = renderFragment(sqlFragment`SELECT COUNT(*)::int AS count FROM pages
      WHERE ${entityTypePredicateSql('pages', entityTypes.filter)} AND pages.deleted_at IS NULL
        ${srcId ? sqlFragment`AND pages.source_id = ${srcId}::text` : sqlFragment``}`);
    const entityCount = (await engine.executeRaw<{ count: number }>(countSql.text, countSql.params))[0]?.count ?? 0;
    // Brain-wide (no --source): <100 entities is vacuous — small brains
    // naturally show a high orphan ratio; not actionable signal. Skip.
    // #4772: with the pack unavailable the count is unknown, not small, so
    // the ratio is answered with a caveat instead of a vacuous ok.
    if (entityTypes.status === 'resolved' && entityCount < 100 && !srcId) {
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
        entityTypes.status === 'pack_unavailable'
          ? ' — entity count unknown (the active schema pack did not load; run gbrain schema active)'
          : entityCount < 100
            ? ` — low scale (${entityCount} entity pages <100), interpret with caution`
            : '';
      // #5877: --by-mention only runs against the database (`--source db`);
      // the bare command exits 2 on the default fs source.
      const hint =
        `Run: gbrain extract links --by-mention --source db${srcId ? ` --source-id ${srcId}` : ''}   (auto-links entity mentions in body text). ` +
        `Run gbrain orphans${srcId ? ` --source ${srcId}` : ''} for the list.`;
      const rendersExcluded = data.connector_renders_excluded ?? 0;
      const renders = rendersExcluded > 0
        ? ` ${rendersExcluded} connector email/meeting renders are reported apart and left out of the ratio.`
        : '';
      const details = { connector_renders_excluded: rendersExcluded };
      const counts = `${data.total_orphans}/${data.total_linkable} linkable pages have no links in either direction`;
      if (ratio > 0.5) {
        checks.push({
          name: 'orphan_ratio',
          status: ratio > 0.8 ? 'fail' : 'warn',
          message: `Orphan ratio ${pct}%${inSource} (${counts})${caveat}.${renders} ${hint}`,
          details,
        });
      } else {
        checks.push({
          name: 'orphan_ratio',
          status: 'ok',
          message: `Orphan ratio ${pct}%${inSource} (${data.total_orphans}/${data.total_linkable} linkable pages)${caveat}${renders ? `.${renders}` : ''}`,
          details,
        });
      }
    }
  } catch {
    checks.push(checkError('orphan_ratio', 'check orphan ratio'));
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
    'persistence_write_stall',
    'lost_caller_writes',
    'persistence_session_timeouts',
    'connector_held_items',
    'git_held_files',
    'frontmatter_hook',
    'orphan_persistence_bindings',
    'foreign_ownership_marker',
    'unbound_source',
    'writer_version',
    'self_capture',
    'vector_plan',
    'stale_embedding_effects',
    'google_file_modes',
    'extractor_facts_expired',
    'conversation_label_facts',
    'conversation_outcomes_stale',
    'captured_facts_active',
    'loop_facts_drift',
    'ontology_facts_fenced',
  ],
  run: runTimelineHistory,
};
