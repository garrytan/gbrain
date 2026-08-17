/**
 * Insight-read operation cluster — pure move from operations.ts (v0.46.x
 * tranche 3): the v0.43 push-based-context op (volunteer_context) plus the
 * find_* insight reads (find_experts, find_contradictions, find_trajectory).
 * Unlike the other tranche-3 clusters these four occupy NON-adjacent slots of
 * the canonical `operations` array in ../operations.ts, so the ops are
 * exported individually and spliced as bare entries at their original
 * positions (order is contractual — docs/TOOL_CATALOG.md is generated from
 * it). Never import from '../operations.ts' here (cycle).
 */

import type { Operation } from './contract.ts';
import { OperationError } from './contract.ts';
import { sourceScopeOpts } from './context.ts';
import {
  FIND_EXPERTS_DESCRIPTION,
  FIND_CONTRADICTIONS_DESCRIPTION,
  FIND_TRAJECTORY_DESCRIPTION,
} from '../operations-descriptions.ts';

// --- v0.43 (#2095): push-based context — the brain volunteers pages ---

const volunteer_context: Operation = {
  name: 'volunteer_context',
  description:
    'Push-based context: volunteer brain pages relevant to a rolling conversation window ' +
    'WITHOUT being asked. Zero-LLM, confidence-gated (alias 0.9 / exact-title 0.8 / ' +
    'slug-suffix 0.6, +0.05 for multi-turn or newest-turn mentions; default gate 0.7), ' +
    'capped at 3 pages (max 5). Returns pointers with one-line rationales + synopses — ' +
    'open the page (get_page) before relying on details. Pass stats: true for the ' +
    'approximate volunteered-vs-used precision summary (the feedback loop).',
  scope: 'read',
  params: {
    window: {
      type: 'string',
      description:
        "Recent conversation turns, oldest → newest, as 'user:' / 'assistant:' prefixed " +
        'lines (unprefixed text = one user turn). Required unless stats: true. ' +
        'CLI: piped stdin fills this.',
    },
    prior_context: {
      type: 'string',
      description:
        'Already-surfaced context (pointer blocks / opened page bodies). Pages whose slug ' +
        'appears here are not re-volunteered.',
    },
    max_pages: { type: 'number', description: 'Max pages to volunteer (default 3, hard cap 5).' },
    min_confidence: {
      type: 'number',
      description:
        'Confidence gate 0..1 (default 0.7 — slug-suffix matches need an explicit lower gate).',
    },
    session_id: { type: 'string', description: 'Optional caller session id, logged for attribution.' },
    turn: { type: 'number', description: 'Optional caller turn number, logged for attribution.' },
    stats: {
      type: 'boolean',
      description:
        'Return the volunteered-vs-used precision summary instead of volunteering. ' +
        'APPROXIMATE: "used" = pages.last_retrieved_at > volunteered_at.',
    },
    days: { type: 'number', description: 'Stats window in days (default 30; stats mode only).' },
  },
  handler: async (ctx, p) => {
    const { parseWindow, volunteerContext, volunteerUsageStats } = await import('../context/volunteer.ts');
    const scope = sourceScopeOpts(ctx);
    const sourceIds = scope.sourceIds ?? (scope.sourceId ? [scope.sourceId] : ['default']);

    if (p.stats === true) {
      return volunteerUsageStats(ctx.engine, sourceIds, typeof p.days === 'number' ? p.days : undefined);
    }

    if (typeof p.window !== 'string' || !p.window.trim()) {
      throw new OperationError(
        'invalid_params',
        'window is required unless stats: true',
        'Pass the recent turns as a string (CLI: pipe them on stdin), or use --stats.',
      );
    }
    const turns = parseWindow(p.window);
    const { loadConfig: loadCfgForArms } = await import('../config.ts');
    const { lexicalArmsEnabled } = await import('../context/reflex.ts');
    const pages = await volunteerContext(ctx.engine, turns, {
      sourceIds,
      priorContext: typeof p.prior_context === 'string' ? p.prior_context : undefined,
      maxPages: typeof p.max_pages === 'number' ? p.max_pages : undefined,
      minConfidence: typeof p.min_confidence === 'number' ? p.min_confidence : undefined,
      // v0.46.15+ kill switch for the lexical recall arms (weak-alias +
      // surname) — file-plane gate, threaded per ResolvePointersOpts.
      lexicalArms: lexicalArmsEnabled(loadCfgForArms()),
    });

    // Feedback-loop logging: fire-and-forget batched INSERT through the
    // volunteer-events sink (drained at exit). Never fails the op.
    if (pages.length) {
      try {
        const { logVolunteerEventsFireAndForget, volunteerEventRowsFrom, SESSION_ID_MAX_LEN } = await import('../context/volunteer-events.ts');
        // Trust-boundary clamps (remote MCP callers): cap session_id length so
        // a read-scoped token can't bank unbounded TEXT per request, and only
        // log integer turns — a non-integer would throw inside the single
        // multi-row INSERT and silently drop the whole batch.
        const sessionId = typeof p.session_id === 'string' ? p.session_id.slice(0, SESSION_ID_MAX_LEN) : null;
        const turn =
          typeof p.turn === 'number' && Number.isInteger(p.turn) && Math.abs(p.turn) <= 2_147_483_647
            ? p.turn
            : null;
        logVolunteerEventsFireAndForget(
          ctx.engine,
          volunteerEventRowsFrom(pages, { channel: 'op', session_id: sessionId, turn }),
        );
      } catch {
        /* telemetry only */
      }
    }
    return { pages, count: pages.length, window_turns: turns.length };
  },
  cliHints: { name: 'volunteer-context', stdin: 'window' },
};

// v0.33: expertise + relationship-proximity routing. CLI: gbrain whoknows.
const find_experts: Operation = {
  name: 'find_experts',
  description: FIND_EXPERTS_DESCRIPTION,
  scope: 'read',
  params: {
    topic: {
      type: 'string',
      description: 'The topic to route. Free-form natural language.',
    },
    limit: {
      type: 'number',
      description: 'Max results (default 5).',
    },
    explain: {
      type: 'boolean',
      description: 'Include factor breakdown per result (expertise, recency, salience).',
    },
  },
  handler: async (ctx, p) => {
    const { findExperts } = await import('../../commands/whoknows.ts');
    const topic = typeof p.topic === 'string' ? p.topic : '';
    if (!topic.trim()) {
      throw new OperationError('invalid_params', '`topic` is required and must be a non-empty string.');
    }
    // v0.34.1 (#861, D3 — 5th leak surface): find_experts (whoknows) was
    // authored against v0.33 after PR #861 was drafted, so the source-scope
    // thread was missing entirely. The op calls findExperts → hybridSearch
    // internally; without the thread an auth'd src-A whoknows query would
    // surface src-B people in the rankings.
    // v0.40.6.0 T1.5 wiring (D4): consult the active pack for expert
    // types; pack-load failure → empty filter (NOT hardcoded defaults
    // per the silent-violation bug class Finding 1.3 closed).
    const { loadActivePackBestEffort, expertTypesFromPack } = await import('../schema-pack/index.ts');
    const pack = await loadActivePackBestEffort(ctx);
    const types = pack ? expertTypesFromPack(pack.manifest) : [];
    return findExperts(ctx.engine, {
      topic,
      limit: typeof p.limit === 'number' ? p.limit : undefined,
      explain: p.explain === true,
      types: types as never,
      ...sourceScopeOpts(ctx),
    });
  },
  // hidden: 'whoknows' is in CLI_ONLY (src/cli.ts) — runWhoknows owns the CLI
  // surface (ranked table + per-factor explain + thin-client routing) and was
  // unreachable while this non-hidden hint dispatched the generic op formatter
  // (the #2035 calibration bug class, resolved the #3502 way: wire the richer
  // handler, hide the hint).
  cliHints: { name: 'whoknows', positional: ['topic'], hidden: true },
};

// v0.32.6: contradiction probe MCP surface (M3)
const find_contradictions: Operation = {
  name: 'find_contradictions',
  description: FIND_CONTRADICTIONS_DESCRIPTION,
  scope: 'read',
  // Reads eval_contradictions_runs.report_json for the latest run, then
  // filters in-memory by slug and severity. No new probe is triggered;
  // the agent surfaces what's already on disk.
  params: {
    slug: {
      type: 'string',
      description: 'Optional slug filter; matches either side of a pair (substring match on slug).',
    },
    severity: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      description: 'Optional severity filter.',
    },
    limit: {
      type: 'number',
      description: 'Max findings to return. Default 20.',
    },
  },
  handler: async (ctx, p) => {
    const limit = typeof p.limit === 'number' && p.limit > 0 ? Math.min(p.limit, 100) : 20;
    const slugFilter = typeof p.slug === 'string' ? p.slug.toLowerCase() : null;
    const sevFilter = (p.severity === 'low' || p.severity === 'medium' || p.severity === 'high')
      ? p.severity
      : null;
    const rows = await ctx.engine.loadContradictionsTrend(30);
    if (rows.length === 0) {
      return { contradictions: [], note: 'No probe runs in the last 30 days; run `gbrain eval suspected-contradictions` first.' };
    }
    const latest = rows[0];
    const report = latest.report_json as Record<string, unknown> | null;
    const perQuery = (report?.per_query as Array<{
      contradictions: Array<{
        kind: string;
        severity: 'low' | 'medium' | 'high';
        axis: string;
        confidence: number;
        a: { slug: string; chunk_id: number | null; take_id: number | null };
        b: { slug: string; chunk_id: number | null; take_id: number | null };
        resolution_kind: string;
        resolution_command: string;
      }>;
    }> | undefined) ?? [];
    const findings = perQuery.flatMap((q) => q.contradictions);
    const filtered = findings.filter((f) => {
      if (sevFilter && f.severity !== sevFilter) return false;
      if (slugFilter) {
        const sA = f.a.slug.toLowerCase();
        const sB = f.b.slug.toLowerCase();
        if (!sA.includes(slugFilter) && !sB.includes(slugFilter)) return false;
      }
      return true;
    });
    return {
      run_id: latest.run_id,
      ran_at: latest.ran_at,
      contradictions: filtered.slice(0, limit),
      total_in_run: findings.length,
    };
  },
  cliHints: { name: 'find-contradictions' },
};

const find_trajectory: Operation = {
  name: 'find_trajectory',
  description: FIND_TRAJECTORY_DESCRIPTION,
  scope: 'read',
  // localOnly intentionally NOT set — federated OAuth clients should be
  // able to query trajectories for entities in their scope. Visibility
  // filtering (D-CDX-1) inside the engine restricts remote callers to
  // visibility='world' facts.
  params: {
    entity_slug: {
      type: 'string',
      description: 'Required. Entity slug to chart (e.g. "companies/acme-example", "people/alice-example").',
    },
    metric: {
      type: 'string',
      description: 'Optional. Filter to a single canonical metric (e.g. "mrr", "arr", "team_size"). When omitted, all metrics return.',
    },
    kind: {
      type: 'string',
      enum: ['metric', 'event', 'all'],
      description: 'Optional. Filter by row shape: "metric" (typed-claim rows only), "event" (event_type rows only), or "all" (default). v0.40.2.0+.',
    },
    since: {
      type: 'string',
      description: 'Optional lower bound on valid_from (YYYY-MM-DD or ISO).',
    },
    until: {
      type: 'string',
      description: 'Optional upper bound on valid_from (YYYY-MM-DD or ISO).',
    },
    limit: {
      type: 'number',
      description: 'Max points returned. Default 100, max 500.',
    },
  },
  handler: async (ctx, p) => {
    if (typeof p.entity_slug !== 'string' || !p.entity_slug.trim()) {
      throw new Error('find_trajectory requires entity_slug (string)');
    }
    const metric = typeof p.metric === 'string' ? p.metric : undefined;
    const kind = (p.kind === 'metric' || p.kind === 'event' || p.kind === 'all')
      ? (p.kind as 'metric' | 'event' | 'all')
      : undefined;
    const since  = typeof p.since  === 'string' ? p.since  : undefined;
    const until  = typeof p.until  === 'string' ? p.until  : undefined;
    const limit  = typeof p.limit  === 'number' ? p.limit  : undefined;
    const scope = sourceScopeOpts(ctx);

    // D-CDX-1: thread ctx.remote into the engine so visibility filtering
    // happens at SQL level. Mirrors recall's posture for untrusted callers.
    const points = await ctx.engine.findTrajectory({
      entitySlug: p.entity_slug,
      ...scope,
      remote: ctx.remote !== false, // fail-closed: anything not strictly false is untrusted (CLAUDE.md invariant)
      metric,
      kind,
      since,
      until,
      limit,
    });

    const { computeTrajectoryStats, TRAJECTORY_SCHEMA_VERSION } = await import('../trajectory.ts');
    const { regressions, drift_score } = computeTrajectoryStats(points);

    // Engine result includes raw embeddings (Float32Array); strip those
    // before sending over MCP — they're bulky binary noise that consumers
    // never need at this layer.
    // v0.40.2.0: event_type surfaces on the wire so remote callers (thin-
    // client think, founder-scorecard) see the event-shaped rows.
    const wirePoints = points.map(pt => ({
      fact_id: pt.fact_id,
      valid_from: pt.valid_from.toISOString().slice(0, 10),
      metric: pt.metric,
      value: pt.value,
      unit: pt.unit,
      period: pt.period,
      event_type: pt.event_type,
      text: pt.text,
      source_session: pt.source_session,
      source_markdown_slug: pt.source_markdown_slug,
    }));

    return {
      points: wirePoints,
      regressions,
      drift_score,
      schema_version: TRAJECTORY_SCHEMA_VERSION,
    };
  },
  cliHints: { name: 'find-trajectory' },
};

export { volunteer_context, find_experts, find_contradictions, find_trajectory };
