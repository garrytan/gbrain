/**
 * Life Chronicle + ontology operation cluster — pure move from operations.ts
 * (v0.46.x tranche 3): the v0.42.x (#2390) timeline reads, the ontology
 * read/write ops, volunteer_chronicle, and the chronicle_backfill sweep. Op
 * consts stay module-private; `chronicleOperations` below lists them in
 * EXACTLY the order they appear in the canonical `operations` array in
 * ../operations.ts. Never import from '../operations.ts' here (cycle).
 */

import type { Operation, OperationContext } from './contract.ts';
import { readPolicyOpts, sourceScopeOpts } from './context.ts';
import { invalidParam } from './op-fix.ts';

// ── Remote diary redaction (fail-closed) ─────────────────────────────────
// The exact mechanism the ontology siblings use (`ctx.remote !== false` →
// life/diary provenance is redacted; only strictly-local `remote: false`
// sees it). A timeline row is diary-sourced when its depth page OR its
// event page lives under life/diary/, or its `source` provenance
// references a life/diary page.
const DIARY_PREFIX = 'life/diary/';
function redactDiaryTimeline<
  T extends { page_slug?: string | null; event_slug?: string | null; source?: string | null },
>(ctx: OperationContext, rows: T[]): T[] {
  if (ctx.remote === false) return rows;
  return rows.filter((r) =>
    !(r.page_slug ?? '').startsWith(DIARY_PREFIX) &&
    !(r.event_slug ?? '').startsWith(DIARY_PREFIX) &&
    !(r.source ?? '').includes(DIARY_PREFIX));
}

// ── v0.42.x — Life Chronicle (#2390) timeline read ops ───────────────────
// CLI names avoid the existing `timeline` (get_timeline, a page's own timeline):
// `gbrain day <date>` / `gbrain since <date>` / `gbrain last-seen <entity>`.
// All route through sourceScopeOpts(ctx) so reads honor source isolation.
const chronicle_day: Operation = {
  name: 'chronicle_day',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description:
    'Life Chronicle: events + timeline entries on a given day (or its ISO week when week=true), ' +
    "ordered chronologically; each row backlinks to its depth page. Distinct from `get_timeline`/" +
    "`gbrain timeline <slug>`, which shows ONE page's timeline. CLI: `gbrain day <date>`.",
  scope: 'read',
  params: {
    date: { type: 'string', required: true, description: 'Day as YYYY-MM-DD.' },
    week: { type: 'boolean', description: 'Expand to the ISO week (Mon–Sun) containing the date.' },
    limit: { type: 'number', description: 'Max rows (default 200).' },
    narrative: { type: 'boolean', description: 'Also return a prose day-by-day narrative.' },
  },
  handler: async (ctx, p) => {
    const rows = redactDiaryTimeline(ctx, await ctx.engine.getTimelineForDate(String(p.date), {
      week: p.week === true,
      limit: typeof p.limit === 'number' ? p.limit : undefined,
      ...await readPolicyOpts(ctx),
    }));
    if (p.narrative === true) {
      const { renderTimelineNarrative } = await import('../chronicle/narrative.ts');
      return { date: String(p.date), narrative: renderTimelineNarrative(rows), events: rows };
    }
    return rows;
  },
  cliHints: { name: 'day', positional: ['date'] },
};

const chronicle_on_this_day: Operation = {
  name: 'chronicle_on_this_day',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description:
    'Life Chronicle: events from the same calendar day in PRIOR years ("on this day"). ' +
    'CLI: `gbrain on-this-day [--date YYYY-MM-DD]`.',
  scope: 'read',
  params: {
    date: { type: 'string', description: 'Anchor day YYYY-MM-DD (default today); matches its month-day in prior years.' },
    limit: { type: 'number', description: 'Max rows (default 50).' },
  },
  handler: async (ctx, p) => redactDiaryTimeline(ctx, await ctx.engine.getOnThisDay({
    date: typeof p.date === 'string' ? p.date : undefined,
    limit: typeof p.limit === 'number' ? p.limit : undefined,
    ...await readPolicyOpts(ctx),
  })),
  cliHints: { name: 'on-this-day' },
};

const chronicle_since: Operation = {
  name: 'chronicle_since',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description:
    'Life Chronicle: events + timeline entries on or after a date, optionally filtered by event kind. ' +
    'CLI: `gbrain since <date> [--kind commitment]`.',
  scope: 'read',
  params: {
    date: { type: 'string', required: true, description: 'Lower-bound day as YYYY-MM-DD (inclusive).' },
    kind: { type: 'string', description: "Filter event projections by event.kind (e.g. 'commitment')." },
    limit: { type: 'number', description: 'Max rows (default 200).' },
  },
  handler: async (ctx, p) => {
    return redactDiaryTimeline(ctx, await ctx.engine.getSince(String(p.date), {
      kind: typeof p.kind === 'string' ? p.kind : undefined,
      limit: typeof p.limit === 'number' ? p.limit : undefined,
      ...await readPolicyOpts(ctx),
    }));
  },
  cliHints: { name: 'since', positional: ['date'] },
};

const chronicle_last_seen: Operation = {
  name: 'chronicle_last_seen',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description:
    "Life Chronicle: when an entity was last seen — its own timeline rows OR an event's `who`. " +
    'Returns last_date, the event slug, and days_ago. CLI: `gbrain last-seen <entity-slug>`.',
  scope: 'read',
  params: {
    entity: { type: 'string', required: true, description: 'Entity page slug (e.g. people/sarah-chen).' },
    asof: { type: 'string', description: 'Reference day YYYY-MM-DD for days_ago (default today).' },
  },
  handler: async (ctx, p) => {
    const res = await ctx.engine.getLastSeen(String(p.entity), {
      asof: typeof p.asof === 'string' ? p.asof : undefined,
      ...await readPolicyOpts(ctx),
    });
    // Fail-closed diary redaction: when the evidence is a life/diary event
    // (or a life/diary page is queried AS the entity), remote callers get
    // the never-seen shape rather than a diary-derived sighting.
    if (ctx.remote !== false &&
        ((res.last_event_slug ?? '').startsWith(DIARY_PREFIX) || String(p.entity).startsWith(DIARY_PREFIX))) {
      return { ...res, last_date: null, last_event_slug: null, days_ago: null };
    }
    return res;
  },
  cliHints: { name: 'last-seen', positional: ['entity'] },
};

const ontology_get: Operation = {
  name: 'ontology_get',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description:
    "Life Chronicle: the current resolved per-entity ontology (dimension → value) at `asof` " +
    "(default now), with provenance + confidence + validity. CLI: `gbrain ontology <entity> [--asof YYYY-MM-DD]`.",
  scope: 'read',
  params: {
    entity: { type: 'string', required: true, description: 'Entity page slug (e.g. people/sarah-chen).' },
    asof: { type: 'string', description: 'Valid-time as-of day YYYY-MM-DD (time-travel; default now).' },
    min_confidence: { type: 'number', description: 'Only return observations at/above this confidence (0..1).' },
    include_quarantined: { type: 'boolean', description: 'Include quarantined novel dimensions (default false).' },
  },
  handler: async (ctx, p) => {
    const rows = await ctx.engine.getOntology(String(p.entity), {
      asof: typeof p.asof === 'string' ? p.asof : undefined,
      minConfidence: typeof p.min_confidence === 'number' ? p.min_confidence : undefined,
      includeQuarantined: p.include_quarantined === true,
      visibility: ctx.remote === false ? undefined : ['world'],
      ...await readPolicyOpts(ctx),
    });
    // Remote redaction: world-visibility rows only (as recall), resolved before
    // DISTINCT ON; never surface diary-sourced ontology to untrusted callers.
    return ctx.remote !== false ? rows.filter((r) => !(r.source ?? '').startsWith('life/diary/')) : rows;
  },
  cliHints: { name: 'ontology', positional: ['entity'] },
};

const ontology_propose: Operation = {
  name: 'ontology_propose',
  idempotent: false,
  outputRedaction: 'retrieval',
  description:
    'Life Chronicle: record one ontology observation (entity has dimension=value), sourced + ' +
    'confidence-weighted + bi-temporal. Idempotent on (entity,dimension,value,source). A new value ' +
    'supersedes the prior; a backdated conflict is flagged not rewritten. CLI: `gbrain ontology-add <entity> <dimension> <value>`.',
  scope: 'write',
  mutating: true,
  params: {
    entity: { type: 'string', required: true, description: 'Entity page slug.' },
    dimension: { type: 'string', required: true, description: 'Dimension (e.g. role, risk_tolerance). Normalized at write.' },
    value: { type: 'string', required: true, description: 'The resolved value (e.g. advisor).' },
    confidence: { type: 'number', description: '0..1; default 0.7.' },
    source: { type: 'string', description: 'Provenance (page slug / uri); default "manual".' },
    valid_from: { type: 'string', description: 'ISO date the value became true (default: now).' },
    valid_to: { type: 'string', description: 'ISO date the value stopped being true (default: open).' },
    visibility: { type: 'string', enum: ['private', 'world'], description: 'Default private.' },
  },
  handler: async (ctx, p) => {
    // [ENG-8] Same unset-vs-explicit ladder as extract_facts: explicit
    // caller visibility wins; unset resolves facts.default_visibility.
    const { resolveVisibilityParam } = await import('../facts/visibility.ts');
    const { coordinatedDatabaseWrite } = await import('../persistence/database-write.ts');
    const entitySlug = String(p.entity);
    const visibility = await resolveVisibilityParam(ctx.engine, p.visibility);
    const merge = (engine: typeof ctx.engine, sourceId: string | undefined) => engine.mergeOntologyFact({
      entitySlug,
      dimension: String(p.dimension),
      value: String(p.value),
      confidence: typeof p.confidence === 'number' ? p.confidence : undefined,
      source: typeof p.source === 'string' && p.source ? p.source : 'manual',
      validFrom: typeof p.valid_from === 'string' ? p.valid_from : undefined,
      validTo: typeof p.valid_to === 'string' ? p.valid_to : undefined,
      visibility,
      sourceId,
    });
    // A managed brain commits the observation as a coordinated database-only
    // write serialized on the entity's page key; unmanaged brains write directly.
    // #5575: an agent observation never closes a more trusted stint; it is stored contested for the owner (A5).
    const { ontologyWriteTrust, contestOntologySupersession } = await import('../trust/supersede-handlers.ts');
    const { maintenanceTransaction } = await import('../persistence/attribution.ts');
    const trust = ontologyWriteTrust(ctx);
    const guarded = async (engine: typeof ctx.engine, sourceId: string | undefined) => {
      const result = await merge(engine, sourceId);
      return { ...result, ...await contestOntologySupersession(engine, sourceId ?? 'default', entitySlug, String(p.dimension), result) };
    };
    const managed = await coordinatedDatabaseWrite(ctx, 'ontology_propose', entitySlug, [entitySlug], guarded, trust);
    return managed ? managed.value : maintenanceTransaction(ctx.engine, tx => guarded(tx, ctx.sourceId), trust);
  },
  cliHints: { name: 'ontology-add', positional: ['entity', 'dimension', 'value'] },
};

const ontology_dimensions: Operation = {
  name: 'ontology_dimensions',
  mutating: false,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description:
    'Life Chronicle meta-ontology: which dimensions the brain tracks across entities, with ' +
    'entity + observation counts. CLI: `gbrain ontology-dimensions`.',
  scope: 'read',
  params: {},
  handler: async (ctx) => ctx.engine.discoverOntologyDimensions(sourceScopeOpts(ctx)),
  cliHints: { name: 'ontology-dimensions' },
};

const ontology_conflicts: Operation = {
  name: 'ontology_conflicts',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description:
    'Life Chronicle: dimensions with ≥2 distinct current values from ≥2 provenances (genuine ' +
    'disagreement, not temporal supersession). CLI: `gbrain ontology-contradictions`.',
  scope: 'read',
  params: {
    min_confidence: { type: 'number', description: 'Only consider observations at/above this confidence (0..1).' },
  },
  handler: async (ctx, p) => {
    const conflicts = await ctx.engine.findOntologyConflicts({
      minConfidence: typeof p.min_confidence === 'number' ? p.min_confidence : undefined,
      visibility: ctx.remote === false ? undefined : ['world'],
      ...await readPolicyOpts(ctx),
    });
    if (ctx.remote === false) return conflicts;
    // Remote: redact diary-sourced values; drop conflicts that no longer have
    // ≥2 distinct values once diary provenance is removed (no leak via conflicts).
    return conflicts
      .map((c) => ({ ...c, values: c.values.filter((v) => !(v.source ?? '').startsWith('life/diary/')) }))
      .filter((c) => new Set(c.values.map((v) => v.value)).size >= 2);
  },
  cliHints: { name: 'ontology-contradictions' },
};

const volunteer_chronicle: Operation = {
  name: 'volunteer_chronicle',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description:
    'Life Chronicle agent-orientation: the recent timeline (last N days) + the current ' +
    'validity-resolved ontology for the named entities, in one zero-LLM payload, so an agent ' +
    'orients before acting. Diary-sourced ontology is redacted for remote callers. ' +
    'CLI: `gbrain orient [--days 7] [--entities people/a,people/b]`.',
  scope: 'read',
  params: {
    days: { type: 'number', description: 'Recent-timeline lookback in days (default 7).' },
    entities: { type: 'string', description: 'Comma-separated entity slugs to resolve ontology for.' },
    limit: { type: 'number', description: 'Max timeline rows (default 50).' },
  },
  handler: async (ctx, p) => {
    const { loadChronicleContext } = await import('../context/chronicle-context.ts');
    const entities = typeof p.entities === 'string'
      ? p.entities.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    const result = await loadChronicleContext(ctx.engine, {
      days: typeof p.days === 'number' ? p.days : undefined,
      entities,
      limit: typeof p.limit === 'number' ? p.limit : undefined,
      remote: ctx.remote !== false,
      ...await readPolicyOpts(ctx),
    });
    // Same fail-closed diary redaction as the timeline reads: the loader
    // redacts diary-sourced ONTOLOGY; the recent timeline is redacted here.
    return { ...result, recent_timeline: redactDiaryTimeline(ctx, result.recent_timeline) };
  },
  cliHints: { name: 'orient' },
};

const chronicle_backfill: Operation = {
  name: 'chronicle_backfill',
  idempotent: false,
  outputRedaction: 'no_stored_text',
  description:
    'Life Chronicle: queue existing meeting/conversation/calendar pages (by type or under meetings/, conversations/, ' +
    'cal/, calendar/) for timeline-event extraction. One paid chat call per page, so it needs --yes; --dry-run ' +
    'reports the candidates, an estimated cost and skip reasons. The chronicle_page_state ledger skips content ' +
    'already extracted or queued, so repeats never pay twice. Queued pages run in the `chronicle` cycle phase ' +
    '(`gbrain dream --phase chronicle`), exempt from the daily limit. --max-usd is a hard bound counting retries: ' +
    'pages queue only while their worst case fits, and an unpriced chat model then refuses with no_pricing. Local-only bulk op. ' +
    'CLI: `gbrain chronicle-backfill [--since YYYY-MM-DD] [--dated-since YYYY-MM-DD] [--recent] [--limit N] [--max-usd USD] [--dry-run | --yes]`.',
  scope: 'admin',
  mutating: true,
  localOnly: true,
  params: {
    since: { type: 'string', description: 'Only pages UPDATED on/after this date (YYYY-MM-DD). Use --dated-since for the page\'s own date.' },
    dated_since: { type: 'string', description: "Only pages whose own date (authored effective date, else frontmatter date/start) is on/after this date (YYYY-MM-DD)." },
    recent: { type: 'boolean', description: 'Only pages within chronicle.auto_recent_days (the automatic path\'s window).' },
    limit: { type: 'number', description: 'Max pages queued in this run, across all types and sources (default 1000).' },
    dry_run: { type: 'boolean', description: 'Count candidates, estimate cost and report skip reasons without queuing.' },
    yes: { type: 'boolean', description: 'Consent to queue paid extraction (one chat call per page). Ask the user first.' },
    max_usd: { type: 'number', description: 'Hard spend bound in USD for everything this run queues, retries included; pages beyond it are not queued (cap_reached).' },
  },
  handler: async (ctx, p) => {
    const { runChronicleBackfill } = await import('../chronicle/backfill.ts');
    const { getChatModel } = await import('../ai/gateway.ts');
    let model: string | undefined;
    try { model = getChatModel(); } catch { model = undefined; }
    const scope = sourceScopeOpts(ctx);
    if (p.max_usd !== undefined && !(typeof p.max_usd === 'number' && Number.isFinite(p.max_usd) && p.max_usd > 0)) {
      throw invalidParam(ctx, 'chronicle_backfill', 'max_usd', 'chronicle_backfill: max_usd must be a positive number of US dollars.', { example: 5 });
    }
    return runChronicleBackfill(ctx.engine, {
      since: typeof p.since === 'string' ? p.since : undefined,
      datedSince: typeof p.dated_since === 'string' ? p.dated_since : undefined,
      recent: p.recent === true,
      limit: typeof p.limit === 'number' ? p.limit : undefined,
      dryRun: p.dry_run === true,
      yes: p.yes === true,
      sourceId: scope.sourceId,
      sourceIds: scope.sourceIds,
      model,
      maxUsd: typeof p.max_usd === 'number' ? p.max_usd : undefined,
    });
  },
  cliHints: { name: 'chronicle-backfill' },
};

export const chronicleOperations: Operation[] = [
  chronicle_day, chronicle_on_this_day, chronicle_since, chronicle_last_seen,
  ontology_get, ontology_propose, ontology_dimensions, ontology_conflicts,
  volunteer_chronicle, chronicle_backfill,
];
