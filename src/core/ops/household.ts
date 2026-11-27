/**
 * household ops (agent platform plan, lane 2, H1): household state any connected agent can read and update.
 *
 *   household_due  (read)  — what's at risk at home: ranked records with a reason, a cited slug and a proposed action
 *                            that always needs the user's yes. Reads at the caller's scope (the list_pages path).
 *   household_add  (write) — one validated record from typed params, placed by the placement table.
 *   household_mark (write) — an event (paid, bought, booked, ...): its timeline line and the new state publish against
 *                            one conditional revision, so a replay or a lost race never leaves one without the other.
 *   household_replace (CLI only) — recompute every record's audience and readers from the placement table.
 *
 * GBrain never acts: no op here buys, pays, books, calls or sends. Every write goes through put_page's admission.
 */
import { opError, type Operation, type OperationContext } from './contract.ts';
import type { Action, Notice } from '../agent-output.ts';
import { invalidParam, readFix } from './op-fix.ts';
import { parseSourceIdParam } from './context.ts';
import { requestSourceScope } from './search-source-scope.ts';
import { callerIdentities, callerIsOwner, currentCallerAccess, resolveExcludePrivatePages } from '../search/private-visibility.ts';
import { assertRemoteReadersValid, pageNotVisibleError, remoteTargetHidden } from '../persistence/page-visibility.ts';
import { initializeLocalPersistence, pageMutationSource, requestPrincipalForContext, submitPageMutation } from '../persistence/page-mutations.ts';
import { admitChangeReason } from '../persistence/change-reason.ts';
import { screenWriteSecrets } from '../persistence/write-secrets.ts';
import { assertReplayIntent, getWriteRequest, intentDigest } from '../persistence/journal.ts';
import { parseWriteRequestId } from '../persistence/preconditions.ts';
import { serializeMarkdown } from '../markdown.ts';
import { assertInlineBody } from '../page-body/page-shape.ts';
import { slugifySegment } from '../sync.ts';
import { isAgentVerb } from '../agent-verbs.ts';
import {
  accountNumberFields, cadenceDays, capText, GIFT_STATES, HOUSEHOLD_KINDS, HOUSEHOLD_ROLES, HOUSEHOLD_SCHEMA, HOUSEHOLD_TYPE,
  RECURS, readHouseholdRecord, strictDate, strictMonthDay, type HouseholdIssue, type HouseholdKind, type HouseholdRecord,
} from '../household/record.ts';
import { assessHouseholdRecord, calendarDay, rankAssessments, type HouseholdAssessment, type HouseholdState } from '../household/assess.ts';
import { aboutOf, classifySubjects, householdWriteAdmission, nonOwnerRoleRefusal, placedReaders, placeHouseholdFrontmatter, placeRecord, readersWiderThanTable, refuseAccountNumbers, roleClass, type SubjectClass } from '../household/placement.ts';

/** Records one household_due call reads at most; past it the answer is partial with no counts. */
export const HOUSEHOLD_SCAN_CAP = 2_000;
const INCLUDE = ['at_risk', 'due', 'all'] as const;
const INCLUDED: Record<(typeof INCLUDE)[number], readonly HouseholdState[]> = {
  at_risk: ['overdue', 'at_risk'], due: ['overdue', 'at_risk', 'upcoming'], all: ['overdue', 'at_risk', 'upcoming', 'ok', 'unknown'],
};
export const HOUSEHOLD_EVENTS = ['done', 'bought', 'paid', 'booked', 'submitted', 'returned', 'used', 'gift_ideas', 'gift_bought', 'given', 'skip', 'pause', 'resume', 'archive'] as const;
type HouseholdEvent = (typeof HOUSEHOLD_EVENTS)[number];
const KIND_EVENTS: Record<HouseholdKind, readonly HouseholdEvent[]> = {
  supply: ['bought', 'done', 'skip'], appointment: ['booked', 'done', 'skip'], bill: ['paid', 'done', 'skip'],
  deadline: ['submitted', 'done', 'skip'], return: ['returned', 'done'], credit: ['used', 'done'], birthday: ['gift_ideas', 'gift_bought', 'given'],
};

function dueFix(why: string, args: Record<string, unknown> = {}): Action {
  return readFix(why, { argv: ['gbrain', 'household', 'due', '--json'], mcp: { tool: 'household_due', arguments: args } });
}

/** The brain's calendar day for `asOf` (or now), and the zone it was computed in. An unset or unknown zone is UTC with a notice. */
async function brainDay(ctx: OperationContext, asOf: unknown, tool: string): Promise<{ day: string; timezone: string; unset: boolean }> {
  const configured = (await ctx.engine.getConfig('brain.timezone'))?.trim() || null;
  let timezone = 'UTC';
  if (configured) { try { calendarDay(0, configured); timezone = configured; } catch { /* unknown zone: UTC */ } }
  const unset = timezone === 'UTC' && configured?.toUpperCase() !== 'UTC';
  if (unset) ctx.emitNotice?.(timezoneNotice(configured));
  if (asOf === undefined || asOf === null) return { day: calendarDay(Date.now(), timezone), timezone, unset };
  const strict = strictDate(asOf);
  if (strict) return { day: strict, timezone, unset };
  const ms = typeof asOf === 'string' ? Date.parse(asOf) : NaN;
  if (!Number.isFinite(ms)) throw invalidParam(ctx, tool, 'as_of', `${tool}: as_of must be a date (YYYY-MM-DD) or an ISO 8601 time.`, { example: '2026-12-01' });
  return { day: calendarDay(ms, timezone), timezone, unset };
}

function timezoneNotice(configured: string | null): Notice {
  return {
    code: 'timezone_unset', kind: 'info',
    why: configured ? 'brain.timezone names a zone this runtime does not know, so household dates were computed in UTC.'
      : 'brain.timezone is not set, so household dates were computed in UTC; a bill due today may read as due tomorrow.',
    fix: { argv: ['gbrain', 'config', 'set', 'brain.timezone', '<tz>'], inputs: [{ name: 'tz', how: 'The household\'s IANA zone, e.g. America/Los_Angeles' }],
      consent: [], actor: 'user', requires_exclusive: false, why: 'Sets the zone household dates are computed in.' },
  };
}

/** Remote callers read only inside their grant, and only with a resolved scope (the open_loops fences). */
function assertRemoteScope(ctx: OperationContext, requested: string | undefined, scope: { sourceId?: string; sourceIds?: string[] }): void {
  if (ctx.remote === false) return;
  const allowed = ctx.auth?.allowedSources;
  const granted = allowed && allowed.length > 0 ? [...allowed] : ctx.sourceId ? [ctx.sourceId] : [];
  const sourcesFix = readFix('Lists the sources this connection can read.', { argv: ['gbrain', 'sources', 'list', '--json'], mcp: { tool: 'sources_list', arguments: {} } });
  if (requested !== undefined && requested !== '__all__' && !granted.includes(requested)) {
    throw opError('permission_denied', `household_due: source '${requested}' is outside your granted sources`,
      `Pass source_id as one of your granted sources (${granted.join(', ') || 'none'}), or omit it.`, { fix: sourcesFix });
  }
  if (!scope.sourceId && !scope.sourceIds) {
    throw opError('permission_denied', 'household_due: remote callers need a resolved source scope', 'Pass source_id naming one of your granted sources.', { fix: sourcesFix });
  }
}

function listParam(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  const list = typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : [];
  return list.filter((v): v is string => typeof v === 'string').map(v => v.trim().toLowerCase()).filter(Boolean);
}

interface HouseholdPage { slug: string; source_id: string; title: string; frontmatter: Record<string, unknown>; tags?: string[] }

function renderDigest(items: HouseholdAssessment[], counts: Record<string, number>, asOf: string, partial: boolean): string {
  if (partial) return 'Household state is partial: too many records to rank in one call. Narrow with kinds, about or handled_by.';
  const open = items.filter(i => i.state === 'overdue' || i.state === 'at_risk' || i.state === 'upcoming');
  if (!open.length) return `Nothing at home is overdue, at risk or coming up as of ${asOf}.`;
  const lines = [`At home as of ${asOf}: ${counts.overdue} overdue, ${counts.at_risk} at risk, ${counts.upcoming} coming up.`];
  for (const i of items) {
    lines.push(`- [${i.state}] ${JSON.stringify(i.reason)} (${i.slug})`);
    if (i.proposed_action) lines.push(`  proposed: ${i.proposed_action.verb} — ${JSON.stringify(i.proposed_action.summary)} — needs the user's yes`);
  }
  return lines.join('\n');
}

const household_due: Operation = {
  name: 'household_due',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description: "Household items overdue, at risk or coming up (bills, supplies, birthdays, school dates, returns, credits), ranked, each with a reason, its slug and a proposed action. Every action needs the user's yes: never buy, pay, book, call or send without it.",
  params: {
    window_days: { type: 'number', description: 'Days ahead (default 7).' },
    kinds: { type: 'array', items: { type: 'string', enum: [...HOUSEHOLD_KINDS] }, description: 'Only these kinds.' },
    include: { type: 'string', enum: [...INCLUDE], description: 'Default due.' },
    about: { type: 'string', description: 'Only records about this page slug.', fullSurfaceOnly: true },
    handled_by: { type: 'string', description: 'Only records handled by this person.', fullSurfaceOnly: true },
    as_of: { type: 'string', description: 'YYYY-MM-DD (default today).' },
    limit: { type: 'number', description: 'Max items (default 20, max 100).', fullSurfaceOnly: true },
    source_id: { type: 'string', description: 'One source.', fullSurfaceOnly: true },
  },
  scope: 'read',
  annotations: { readOnlyHint: true },
  handler: async (ctx, p) => {
    const include = (p.include ?? 'due') as (typeof INCLUDE)[number];
    if (!INCLUDE.includes(include)) throw invalidParam(ctx, 'household_due', 'include', 'household_due: include must be at_risk, due or all.', { choices: INCLUDE });
    const windowDays = Math.min(Math.max(Math.floor(Number(p.window_days ?? 7)) || 7, 1), 366);
    const limit = Math.min(Math.max(Math.floor(Number(p.limit ?? 20)) || 20, 1), 100);
    const kinds = listParam(p.kinds);
    const badKind = kinds?.find(k => !(HOUSEHOLD_KINDS as readonly string[]).includes(k));
    if (badKind) throw invalidParam(ctx, 'household_due', 'kinds', `household_due: unknown kind ${JSON.stringify(badKind)}.`, { choices: HOUSEHOLD_KINDS });
    const { day, timezone } = await brainDay(ctx, p.as_of, 'household_due');
    const requested = parseSourceIdParam(p.source_id, 'household_due', { allowAll: true });
    const scope = await requestSourceScope(ctx, requested, undefined);
    assertRemoteScope(ctx, requested, scope);
    const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);
    const about = typeof p.about === 'string' ? p.about.trim().toLowerCase() : undefined;
    const handledBy = typeof p.handled_by === 'string' ? p.handled_by.trim().toLowerCase() : undefined;
    const rows = scope.sourceIds?.length === 0 ? [] : await scanRecords(ctx, { excludePrivate, kinds, about, handledBy, scope });
    if (rows.length > HOUSEHOLD_SCAN_CAP) {
      return { state: 'partial', code: 'household_scale', items: [], counts: null, invalid: [], truncated: true, as_of: day, timezone,
        narrow_with: ['kinds', 'about', 'handled_by', 'source_id'],
        fix: dueFix('Narrows the read to one kind; about, handled_by and source_id narrow it further.', { kinds: ['bill'] }),
        text: renderDigest([], {}, day, true) };
    }
    const invalid: HouseholdIssue[] = [];
    const assessed: HouseholdAssessment[] = [];
    const records: HouseholdRecord[] = [];
    for (const row of rows) {
      const read = readHouseholdRecord({ slug: row.slug, source_id: row.source_id, title: row.title, frontmatter: row.frontmatter, tags: row.tags });
      if (!read.record) { invalid.push(...read.issues); continue; }
      if (read.record.status === 'archived') continue;
      if (kinds && !kinds.includes(read.record.kind)) continue;
      if (about && !read.record.about.includes(about)) continue;
      if (handledBy && read.record.handled_by?.toLowerCase() !== handledBy) continue;
      records.push(read.record);
    }
    const stale = ctx.remote === false ? [] : await stalePlacements(ctx, records, rows);
    for (const r of records) {
      if (stale.includes(`${r.source_id}:${r.slug}`)) continue;
      assessed.push(assessHouseholdRecord(r, day, { windowDays }));
    }
    if (stale.length) ctx.emitNotice?.({ code: 'household_placement_stale', kind: 'degraded',
      why: `${stale.length} household record(s) were left out: their stored readers are wider than the placement table now allows (a subject was reclassified, or they were written before the brain served several people). Ask the brain's owner to run the fix.`,
      fix: { argv: ['gbrain', 'household', 'replace'], consent: [], actor: 'host_admin', requires_exclusive: false, why: 'Recomputes every household record\'s readers from the placement table.' } });
    const counts: Record<HouseholdState | 'invalid', number> = { overdue: 0, at_risk: 0, upcoming: 0, ok: 0, unknown: 0, invalid: invalid.length };
    for (const a of assessed) counts[a.state]++;
    const ranked = rankAssessments(assessed.filter(a => INCLUDED[include].includes(a.state)));
    const items = ranked.slice(0, limit);
    return { state: 'complete', items, counts, invalid, truncated: ranked.length > limit, as_of: day, timezone, text: renderDigest(items, counts, day, false) };
  },
};

const SCAN_BATCH = 500;

/**
 * The live household records in scope that the filters keep, read a batch at a time as frontmatter only (never page
 * bodies). Archived records and records the filters leave out never count toward HOUSEHOLD_SCAN_CAP; the scan stops at
 * the first record past it.
 */
async function scanRecords(ctx: OperationContext, opts: { excludePrivate: boolean; kinds: string[] | null | undefined; about?: string; handledBy?: string;
  scope: Awaited<ReturnType<typeof requestSourceScope>> }): Promise<HouseholdPage[]> {
  const kept: HouseholdPage[] = [];
  if (opts.kinds && !opts.kinds.length) return kept;
  for (let offset = 0; ; offset += SCAN_BATCH) {
    const batch = await ctx.engine.listPages({ type: HOUSEHOLD_TYPE as never, limit: SCAN_BATCH, offset, excludePrivate: opts.excludePrivate, sort: 'slug', omitBodies: true,
      ...(opts.kinds ? { where: { kind: opts.kinds } } : {}), ...opts.scope }) as unknown as HouseholdPage[];
    for (const row of batch) {
      const fm = row.frontmatter ?? {};
      if (String(fm.status ?? '').trim().toLowerCase() === 'archived') continue;
      if (opts.about && !aboutOf(fm.about).includes(opts.about)) continue;
      if (opts.handledBy && String(fm.handled_by ?? '').trim().toLowerCase() !== opts.handledBy) continue;
      kept.push(row);
      if (kept.length > HOUSEHOLD_SCAN_CAP) return kept;
    }
    if (batch.length < SCAN_BATCH) return kept;
  }
}

/**
 * Records whose stored audience or readers are wider than the placement table now says (a subject became a child, or
 * lost its classification, after the record's last write; or the record was written with no reader list while the brain
 * served one person, and it now serves several). A remote read leaves them out until `gbrain household replace`
 * rewrites them, so a reclassification never leaks through a stale readers list.
 */
async function stalePlacements(ctx: OperationContext, records: HouseholdRecord[], rows: HouseholdPage[]): Promise<string[]> {
  const stored = new Map(rows.map(r => [`${r.source_id}:${r.slug}`, r.frontmatter]));
  const out: string[] = [];
  const bySource = new Map<string, HouseholdRecord[]>();
  const wider = await readersWiderThanTable(ctx.engine);
  for (const r of records) bySource.set(r.source_id, [...(bySource.get(r.source_id) ?? []), r]);
  for (const [sourceId, list] of bySource) {
    const classes = await classifySubjects(ctx.engine, sourceId, [...new Set(list.flatMap(r => r.about))]);
    for (const r of list) {
      const fm = stored.get(`${r.source_id}:${r.slug}`) ?? {};
      const decision = placeRecord({ kind: r.kind, school: r.tags.includes('school'), subjects: r.about.map(s => classes.get(s) ?? 'unclassified'), requested: fm.audience });
      if ((decision.audience === 'adults' && fm.household_audience !== 'adults') || await wider(fm, decision.audience)) out.push(`${r.source_id}:${r.slug}`);
    }
  }
  return out;
}

function serializeRecord(fm: Record<string, unknown>, title: string, body: string, timeline: string, tags: string[]): string {
  const { type: _t, title: _ti, tags: _tg, ...rest } = fm;
  return serializeMarkdown(rest, body, timeline, { type: HOUSEHOLD_TYPE as never, title, tags });
}

function timelineLine(day: string, event: string, note: string | null): string {
  return `- **${day}** | household — ${event}${note ? `: ${note}` : ''}`;
}

/**
 * Writes `household_role` on each subject page (creating a minimal page when none exists). A subject that goes from another
 * role to child first has the records about it narrowed to adults (`audience: adults`), so none is shared for a moment.
 */
async function classifySubjectPages(ctx: OperationContext, sourceId: string, about: string[], role: string): Promise<{ classified: string[]; pinned: string[] }> {
  const changed: string[] = [];
  const pinned: string[] = [];
  for (const slug of about) {
    const snapshot = await ctx.engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
    const live = snapshot && !snapshot.page.deleted_at ? snapshot : null;
    if (snapshot && await remoteTargetHidden(ctx.engine, ctx.remote, sourceId, slug)) throw opError('page_not_found', `Page not found: ${slug}`, 'Name a subject page this connection can read.');
    if (live && String(live.page.frontmatter?.household_role ?? '') === role) continue;
    if (live) assertInlineBody(live.page, 'household_add about_role');
    if (ctx.remote !== false && !callerIsOwner() && await placedReaders(ctx.engine, 'adults')) throw nonOwnerRoleRefusal(slug, role);
    if (role === 'child' && roleClass(live?.page.frontmatter?.household_role) !== 'child') {
      pinned.push(...(await replaceHouseholdRecords(ctx, sourceId, [slug], { pin: true })).replaced);
    }
    const title = live?.page.title ?? slug.split('/').pop()!.replace(/-/g, ' ');
    const fm = { ...(live?.page.frontmatter ?? {}), household_role: role };
    const content = serializeMarkdown(Object.fromEntries(Object.entries(fm).filter(([k]) => !['type', 'title', 'tags'].includes(k))),
      live?.page.compiled_truth ?? `# ${title}`, live?.page.timeline ?? '', { type: (live?.page.type ?? (slug.startsWith('people/') ? 'person' : 'note')) as never, title, tags: live?.tags ?? [] });
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content, source_id: sourceId, ...(snapshot ? { expected_revision: snapshot.revision } : {}) },
      ...(live ? { serverComposed: true as const } : {}) });
    changed.push(slug);
  }
  return { classified: changed, pinned };
}

/**
 * Rewrites every record (optionally only those about `about`), archived ones included, whose stored placement differs
 * from the table, reading frontmatter in slug order 500 at a time (a keyset, so a record deleted during the walk shifts
 * nothing) so no source is too large; `pin` first narrows each to adults.
 */
export async function replaceHouseholdRecords(ctx: OperationContext, sourceId: string, about?: readonly string[], opts: { pin?: boolean } = {}): Promise<{ checked: number; replaced: string[] }> {
  const wanted = about?.length ? new Set(aboutOf(about)) : null;
  const replaced: string[] = [];
  let checked = 0;
  for (let after: string | undefined; ;) {
    const rows = await ctx.engine.listPages({ type: HOUSEHOLD_TYPE as never, sourceId, sort: 'slug', limit: 500, slugAfter: after, omitBodies: true }) as unknown as HouseholdPage[];
    after = rows.at(-1)?.slug;
    for (const row of rows) {
      if (wanted && !aboutOf(row.frontmatter?.about).some(s => wanted.has(s))) continue;
      checked++;
      const snap = await ctx.engine.readPageSnapshot(row.slug, { sourceId });
      if (!snap) continue;
      const fm = { ...(snap.page.frontmatter ?? {}) };
      const before = JSON.stringify([fm.household_audience ?? null, fm.readable_by ?? null]);
      if (opts.pin && fm.household_audience !== 'adults') fm.audience = 'adults';
      await placeHouseholdFrontmatter(ctx.engine, sourceId, fm, snap.tags);
      if (JSON.stringify([fm.household_audience ?? null, fm.readable_by ?? null]) === before) continue;
      assertInlineBody(snap.page, 'household_replace');
      await submitPageMutation(ctx, { operation: 'put_page', params: { slug: row.slug, source_id: sourceId, expected_revision: snap.revision,
        content: serializeRecord(fm, snap.page.title, snap.page.compiled_truth, snap.page.timeline ?? '', snap.tags) }, serverComposed: true });
      replaced.push(row.slug);
    }
    if (rows.length < 500) break;
  }
  return { checked, replaced };
}

const ROLE_ENUM = [...HOUSEHOLD_ROLES];

const household_add: Operation = {
  name: 'household_add',
  mutating: true,
  idempotent: false,
  writeInference: 'none',
  outputRedaction: 'no_stored_text',
  description: 'Add one household record (supply, birthday, bill, deadline, appointment, return or credit). The placement table picks its folder and who may read it; a record about a child is adults only. Refuses full account or card numbers.',
  params: {
    kind: { type: 'string', required: true, enum: [...HOUSEHOLD_KINDS], description: 'Record kind.' },
    title: { type: 'string', required: true, description: 'Short title, e.g. "Water bill".' },
    slug: { type: 'string', description: 'Name within its folder (default: from the title).' },
    about: { type: 'array', items: { type: 'string' }, description: 'Subject page slugs, e.g. people/alice-example.' },
    about_role: { type: 'string', enum: ROLE_ENUM, description: "Marks every about subject's household_role (child keeps the record adults only)." },
    child: { type: 'boolean', description: 'Same as about_role child.' },
    handled_by: { type: 'string', description: 'Who usually handles it.' },
    due: { type: 'string', description: 'Due date YYYY-MM-DD (bill, deadline, return, credit; a booked appointment).' },
    recurs: { type: 'string', enum: [...RECURS], description: 'How the due date repeats.' },
    cadence: { type: 'string', description: 'Supply or appointment cadence, e.g. 30d, 6m.' },
    last_done: { type: 'string', description: 'When it was last bought or done (YYYY-MM-DD).' },
    on: { type: 'string', description: 'Birthday MM-DD.' },
    lead_days: { type: 'number', description: 'Days before the date it turns at risk.' },
    amount: { type: 'number', description: 'Amount (with currency).' },
    currency: { type: 'string', description: 'Three-letter currency, e.g. USD.' },
    gift: { type: 'string', enum: [...GIFT_STATES], description: 'Birthday gift state.' },
    proposed_verb: { type: 'string', description: 'The action to propose when due (send, spend, book, ...).' },
    proposed_note: { type: 'string', description: 'One line describing that action.' },
    audience: { type: 'string', enum: ['adults'], description: 'Keep this record to adults even when its kind is shared.' },
    school: { type: 'boolean', description: 'A school deadline (goes under household/school/).' },
    note: { type: 'string', description: 'Body text.' },
    source_id: { type: 'string', description: 'Write source.' },
    request_id: { type: 'string', description: 'Idempotency key for a retry.' },
  },
  scope: 'write',
  handler: async (ctx, p) => {
    const kind = p.kind as HouseholdKind;
    if (!HOUSEHOLD_KINDS.includes(kind)) throw invalidParam(ctx, 'household_add', 'kind', 'household_add: unknown kind.', { choices: HOUSEHOLD_KINDS });
    const title = capText(p.title);
    if (!title) throw invalidParam(ctx, 'household_add', 'title', 'household_add: title is required.', { example: 'Water bill' });
    refuseAccountNumbers(accountNumberFields(Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'request_id'))));
    const role = p.child === true ? 'child' : p.about_role as string | undefined;
    if (role !== undefined && !(HOUSEHOLD_ROLES as readonly string[]).includes(role)) throw invalidParam(ctx, 'household_add', 'about_role', 'household_add: unknown role.', { choices: ROLE_ENUM });
    const about = aboutOf((listParam(p.about) ?? []).map(s => s.trim().replace(/\.md$/i, '')));
    if (role && !about.length) throw invalidParam(ctx, 'household_add', 'about', 'household_add: about_role and child need about to name the subject page.', { example: ['people/alice-example'] });
    const fm: Record<string, unknown> = { kind, household_schema: HOUSEHOLD_SCHEMA, status: 'active' };
    if (about.length) fm.about = about;
    for (const key of ['handled_by', 'recurs', 'gift', 'audience'] as const) if (typeof p[key] === 'string') fm[key] = p[key];
    for (const key of ['due', 'last_done'] as const) {
      if (p[key] === undefined) continue;
      const d = strictDate(p[key]);
      if (!d) throw invalidParam(ctx, 'household_add', key, `household_add: ${key} must be a calendar date YYYY-MM-DD.`, { example: '2026-12-03' });
      fm[key] = d;
    }
    if (p.on !== undefined) { const on = strictMonthDay(p.on); if (!on) throw invalidParam(ctx, 'household_add', 'on', 'household_add: on must be MM-DD.', { example: '03-14' }); fm.on = on; }
    if (p.cadence !== undefined) { if (cadenceDays(p.cadence) === null) throw invalidParam(ctx, 'household_add', 'cadence', 'household_add: cadence must look like 30d, 2w, 6m or 1y.', { example: '30d' }); fm.cadence = String(p.cadence); }
    if (p.lead_days !== undefined) fm.lead_days = Number(p.lead_days);
    if (p.amount !== undefined) { fm.amount = Number(p.amount); fm.currency = typeof p.currency === 'string' ? p.currency.toUpperCase() : p.currency; }
    if (p.proposed_verb !== undefined) {
      if (!isAgentVerb(p.proposed_verb)) throw invalidParam(ctx, 'household_add', 'proposed_verb', 'household_add: unknown verb.', { example: 'spend' });
      fm.proposed_action = { verb: p.proposed_verb, ...(capText(p.proposed_note) ? { note: capText(p.proposed_note) } : {}) };
    }
    const tags = p.school === true ? ['school'] : [];
    const check = readHouseholdRecord({ slug: 'household/new', source_id: 'new', title, frontmatter: fm, tags });
    if (!check.record) {
      const first = check.issues[0]!;
      throw invalidParam(ctx, 'household_add', first.field, `household_add: ${first.field} ${first.reason}. ${first.fix}`, {});
    }
    if (kind === 'birthday' && fm.gift !== undefined && fm.gift !== 'none') {
      const { day } = await brainDay(ctx, undefined, 'household_add');
      fm.gift_for = Number((assessHouseholdRecord(check.record, day, { windowDays: 366 }).next_due ?? day).slice(0, 4));
    }
    const sourceId = pageMutationSource(ctx, p, 'household_add');
    const stored = [...(await classifySubjects(ctx.engine, sourceId, about)).values()];
    const subjectClasses: SubjectClass[] = role ? about.map(() => (role === 'child' ? 'child' : 'not_child')) : stored;
    if (role === 'child' && stored.includes('not_child')) fm.audience = 'adults';
    const decision = placeRecord({ kind, school: p.school === true, subjects: subjectClasses, requested: fm.audience });
    const tail = slugifySegment(String(p.slug ?? title)).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'record';
    const slug = `${decision.folder}${tail}`;
    const existing = await ctx.engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
    const requestId = parseWriteRequestId(p.request_id);
    if (requestId) await initializeLocalPersistence(ctx);
    const prior = requestId ? await getWriteRequest(ctx.engine, await requestPrincipalForContext(ctx), requestId) : null;
    const replay = !!prior && prior.operation === 'put_page' && prior.slug === slug && prior.source_id === sourceId;
    if (prior && !replay) throw opError('idempotency_conflict', 'The request_id already belongs to a different write, so nothing was written.', 'Use a new request_id for a new household_add.');
    if (existing && !replay && await remoteTargetHidden(ctx.engine, ctx.remote, sourceId, slug)) throw pageNotVisibleError();
    if (existing && !existing.page.deleted_at && !replay) {
      throw opError('household_exists', `A page already exists at ${slug}, so nothing was written.`,
        'Record an event on the existing record with household_mark, or pass slug to name this one differently.',
        { fix: readFix('Shows the existing household records.', { argv: ['gbrain', 'household', 'list', '--json'], mcp: { tool: 'household_due', arguments: { include: 'all' } } }) });
    }
    const body = capText(p.note, 2_000) ?? `# ${title}`;
    const recordParams: Record<string, unknown> = { slug, source_id: sourceId, content: serializeRecord(fm, title, body, '', tags),
      ...(existing?.page.deleted_at ? { expected_revision: existing.revision } : {}), ...(role ? { reason: admitChangeReason(`household_add about_role ${role}`) } : {}) };
    if (prior) assertReplayIntent(prior, intentDigest({ operation: 'put_page', sourceId, slug: prior.slug, callerIntent: recordParams }));
    const remote = ctx.remote !== false;
    const placed = remote ? await placedReaders(ctx.engine, decision.audience) : null;
    if (placed) assertRemoteReadersValid({ readable_by: placed }, callerIdentities(), currentCallerAccess().audience);
    if (role) for (const subject of about) {
      const snap = await ctx.engine.readPageSnapshot(subject, { sourceId, includeDeleted: true });
      if (snap && await remoteTargetHidden(ctx.engine, ctx.remote, sourceId, subject)) throw opError('page_not_found', `Page not found: ${subject}`, 'Name a subject page this connection can read.');
      const live = snap && !snap.page.deleted_at ? snap.page : null;
      if (live && String(live.frontmatter?.household_role ?? '') === role) continue;
      if (placed && !callerIsOwner()) throw nonOwnerRoleRefusal(subject, role);
      if (live) assertInlineBody(live, 'household_add about_role');
      if (role === 'child') {
        if (remote) for (const row of await ctx.engine.listPages({ type: HOUSEHOLD_TYPE as never, sourceId, sort: 'slug', limit: 100_000, omitBodies: true }) as unknown as HouseholdPage[]) {
          if (!aboutOf(row.frontmatter?.about).includes(subject) || !await remoteTargetHidden(ctx.engine, ctx.remote, sourceId, row.slug)) continue;
          throw opError('household_reclassify', `A household record about ${subject} is not readable by this connection, so it cannot be narrowed here, and nothing was written.`,
            `Run gbrain household replace --about ${subject} --role child on the brain host.`);
        }
        continue;
      }
      await householdWriteAdmission(ctx.engine, sourceId, subject, { type: live?.type ?? (subject.startsWith('people/') ? 'person' : 'note'),
        frontmatter: { ...(live?.frontmatter ?? {}), household_role: role }, tags: [] }, snap?.page ?? null, remote);
    }
    // GST-4024: under block, a secret in the new record is refused before any subject or record is rewritten for it.
    if (role && !prior) screenWriteSecrets(ctx, 'household_add', { ...recordParams, ...(typeof p.request_id === 'string' ? { request_id: p.request_id } : {}) });
    const subjects = role && !prior ? await classifySubjectPages(ctx, sourceId, about, role) : { classified: [], pinned: [] };
    const result = await submitPageMutation(ctx, { operation: 'put_page', params: { ...recordParams, ...(typeof p.request_id === 'string' ? { request_id: p.request_id } : {}) } });
    const { classified, pinned } = subjects;
    const replaced = [...new Set([...pinned, ...(classified.length ? (await replaceHouseholdRecords(ctx, sourceId, classified)).replaced : [])])].filter(s => s !== slug).sort();
    return { ...result, slug, kind, audience: decision.audience, placement_basis: decision.basis, subjects_classified: classified, records_replaced: replaced };
  },
};

/** The new frontmatter and status after `event`, or a refusal naming what the record accepts. */
function applyEvent(ctx: OperationContext, record: HouseholdRecord, fm: Record<string, unknown>, event: HouseholdEvent, day: string, due: string | null): void {
  const refuse = (why: string): never => { throw invalidParam(ctx, 'household_mark', 'event', `household_mark: ${why}`, { choices: [...KIND_EVENTS[record.kind], 'pause', 'resume', 'archive'] }); };
  if (record.status === 'archived') refuse('this record is archived; nothing more can be marked on it.');
  if (event === 'archive') { fm.status = 'archived'; return; }
  if (event === 'pause') { if (record.status !== 'active') refuse(`only an active record can be paused (this one is ${record.status}).`); fm.status = 'paused'; return; }
  if (event === 'resume') { if (record.status !== 'paused') refuse(`only a paused record can be resumed (this one is ${record.status}).`); fm.status = 'active'; return; }
  if (record.status !== 'active') refuse(`this record is ${record.status}; resume it first.`);
  if (!KIND_EVENTS[record.kind].includes(event)) refuse(`a ${record.kind} accepts ${KIND_EVENTS[record.kind].join(', ')}.`);
  const now = assessHouseholdRecord(record, day, { windowDays: 366 });
  if (record.kind === 'birthday') {
    fm.gift = event === 'gift_ideas' ? 'ideas' : event === 'gift_bought' ? 'bought' : 'given';
    fm.gift_for = Number((now.next_due ?? day).slice(0, 4));
    return;
  }
  if (record.kind === 'supply' || record.kind === 'appointment') {
    if (event === 'booked') { if (!due) refuse('booked needs due, the booked date (YYYY-MM-DD).'); fm.due = due; return; }
    const oneOff = record.kind === 'appointment' && record.cadence_days === null;
    if (oneOff && event === 'skip') refuse('skip applies only to an appointment with a cadence.');
    fm.last_done = event === 'skip' ? (now.next_due ?? day) : day;
    if (typeof fm.due === 'string' && fm.due <= String(fm.last_done) && !oneOff) delete fm.due;
    if (oneOff) fm.status = 'done';
    return;
  }
  if (record.recurs === 'none') { if (event === 'skip') refuse('skip applies only to a recurring record.'); fm.done_through = record.due; fm.status = 'done'; return; }
  fm.done_through = now.next_due ?? record.due;
  if (event !== 'skip' && record.kind === 'bill') fm.last_paid = day;
}

const household_mark: Operation = {
  name: 'household_mark',
  mutating: true,
  idempotent: false,
  writeInference: 'none',
  outputRedaction: 'no_stored_text',
  description: "Record what happened to a household record: done, bought, paid, booked, submitted, returned, used, gift_ideas, gift_bought, given, skip, pause, resume or archive. Adds a timeline line and updates the state in one write; never deletes. Use it for what the user says was done, never for what you plan to do.",
  params: {
    slug: { type: 'string', required: true, description: 'The record (from household_due).' },
    event: { type: 'string', required: true, enum: [...HOUSEHOLD_EVENTS], description: 'What happened.' },
    on: { type: 'string', description: 'Day it happened (YYYY-MM-DD); default today.' },
    due: { type: 'string', description: 'For booked: the booked date.' },
    note: { type: 'string', description: 'One line for the timeline.' },
    source_id: { type: 'string', description: 'Write source.' },
    request_id: { type: 'string', description: 'Idempotency key for a retry.' },
  },
  scope: 'write',
  handler: async (ctx, p) => {
    const event = p.event as HouseholdEvent;
    if (!HOUSEHOLD_EVENTS.includes(event)) throw invalidParam(ctx, 'household_mark', 'event', 'household_mark: unknown event.', { choices: HOUSEHOLD_EVENTS });
    const slug = typeof p.slug === 'string' ? p.slug.trim().toLowerCase().replace(/\.md$/, '') : '';
    if (!slug) throw invalidParam(ctx, 'household_mark', 'slug', 'household_mark: slug is required.', { example: 'household/money/bill/water' });
    refuseAccountNumbers(accountNumberFields({ note: p.note, due: p.due }));
    // GST-4024: the write below carries the stored record too, so secrets.on_write screens only the caller's note here.
    const screened = screenWriteSecrets(ctx, 'household_mark', { note: capText(p.note), ...(typeof p.request_id === 'string' ? { request_id: p.request_id } : {}) });
    const note = screened.params.note as string | null;
    const due = p.due === undefined ? null : strictDate(p.due);
    if (p.due !== undefined && !due) throw invalidParam(ctx, 'household_mark', 'due', 'household_mark: due must be YYYY-MM-DD.', { example: '2026-12-10' });
    const sourceId = pageMutationSource(ctx, p, 'household_mark');
    const { day } = await brainDay(ctx, p.on, 'household_mark');
    const snap = await ctx.engine.readPageSnapshot(slug, { sourceId });
    if (!snap || snap.page.deleted_at || await remoteTargetHidden(ctx.engine, ctx.remote, sourceId, slug)) {
      throw opError('page_not_found', `No household record at ${slug}.`, 'Pick a slug from household_due.', { fix: dueFix('Lists the household records this connection can read.', { include: 'all' }) });
    }
    const read = readHouseholdRecord({ slug, source_id: sourceId, title: snap.page.title, frontmatter: snap.page.type === HOUSEHOLD_TYPE ? snap.page.frontmatter : { kind: null }, tags: snap.tags });
    if (!read.record) {
      const first = read.issues[0]!;
      throw opError('invalid_params', `${slug} is not a valid household record (${first.field}: ${first.reason}), so nothing was marked.`, first.fix);
    }
    const requestId = typeof p.request_id === 'string' ? parseWriteRequestId(p.request_id) : null;
    const prior = requestId ? await getWriteRequest(ctx.engine, await requestPrincipalForContext(ctx), requestId) : null;
    if (prior && prior.state === 'committed' && prior.operation === 'put_page' && prior.slug === slug && prior.source_id === sourceId && (snap.page.timeline ?? '').includes(timelineLine(day, event, note))) {
      return { replayed: true, request_id: p.request_id, slug, event, on: day, status: snap.page.frontmatter?.status ?? 'active' };
    }
    assertInlineBody(snap.page, 'household_mark');
    const fm = { ...(snap.page.frontmatter ?? {}) };
    applyEvent(ctx, read.record, fm, event, day, due);
    const timeline = [snap.page.timeline?.trim(), timelineLine(day, event, note)].filter(Boolean).join('\n');
    const result = await submitPageMutation(ctx, { operation: 'put_page', params: { slug, source_id: sourceId, expected_revision: snap.revision,
      content: serializeRecord(fm, snap.page.title, snap.page.compiled_truth, timeline, snap.tags), ...(typeof screened.params.request_id === 'string' ? { request_id: screened.params.request_id } : {}) }, serverComposed: true });
    return { ...result, slug, event, on: day, status: fm.status ?? 'active', ...(screened.redacted ? { secrets_redacted: screened.redacted } : {}) };
  },
};

const household_replace: Operation = {
  name: 'household_replace',
  mutating: true,
  idempotent: true,
  writeInference: 'none',
  outputRedaction: 'no_stored_text',
  description: "Recompute every household record's audience and readers from the placement table (when the brain starts serving several people). With about: narrow the records about those subjects to adults, set their household_role when role is given, then re-place them. Trusted local CLI only.",
  params: {
    source_id: { type: 'string', description: 'Source (default: the current one).' },
    about: { type: 'array', items: { type: 'string' }, description: 'Subject page slugs to reclassify; only the records about them are re-placed.' },
    role: { type: 'string', enum: ROLE_ENUM, description: 'The household_role to give each about subject (needs about).' },
  },
  scope: 'write',
  localOnly: true,
  cliOnly: { argv: ['gbrain', 'household', 'replace'] },
  handler: async (ctx, p) => {
    if (ctx.remote !== false) throw opError('permission_denied', 'household_replace runs only on the brain host.', 'Ask the brain\'s owner to run gbrain household replace.');
    const sourceId = pageMutationSource(ctx, p, 'household_replace');
    const about = (listParam(p.about) ?? []).map(s => s.trim().toLowerCase().replace(/\.md$/, ''));
    const role = p.role as string | undefined;
    if (role !== undefined && !(HOUSEHOLD_ROLES as readonly string[]).includes(role)) throw invalidParam(ctx, 'household_replace', 'role', 'household_replace: unknown role.', { choices: ROLE_ENUM });
    if (role !== undefined && !about.length) throw invalidParam(ctx, 'household_replace', 'about', 'household_replace: role needs about to name the subject page.', { example: ['people/alice-example'] });
    if (!about.length) return { source_id: sourceId, ...await replaceHouseholdRecords(ctx, sourceId) };
    const { classified, pinned } = role ? await classifySubjectPages(ctx, sourceId, about, role) : { classified: [], pinned: (await replaceHouseholdRecords(ctx, sourceId, about, { pin: true })).replaced };
    const result = await replaceHouseholdRecords(ctx, sourceId, about);
    return { source_id: sourceId, subjects_classified: classified, checked: result.checked, replaced: [...new Set([...pinned, ...result.replaced])].sort() };
  },
};

export const householdOperations: Operation[] = [household_due, household_add, household_mark, household_replace];
