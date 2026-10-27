/**
 * GBRA-215 L3: ingest a pasted document. One call reads the whole document in windows, plans every page and fact with
 * no writes, then commits through the source's own write door: the source page (create-only), the attempt's report page
 * (ingest/<attempt_id>), each new entity page (proposed unless the local owner trusts the extraction) and each fact on
 * the entities it names, through remember's explicit-entity fence writer (the Git fence on a repository-backed source,
 * the database page-body fence on a repo-less one). ingest_undo previews, then retracts only what the attempt created.
 * Docs: docs/guides/ingest.md.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Operation, OperationContext } from './contract.ts';
import { OperationError, opError } from './contract.ts';
import { readFix } from './op-fix.ts';
import { VERSION } from '../../version.ts';
import type { Page } from '../types.ts';
import { stringifyDataFrontmatter } from '../data-frontmatter.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { assertInlineBody } from '../page-body/page-shape.ts';
import { strikeFenceRow } from '../facts/forget.ts';
import { checkFactAgainstSaved } from '../facts/backstop.ts';
import { isUnverifiedExtraction, quarantineMarkers } from '../extraction-review.ts';
import { tryAcquireDbLock } from '../db-lock.ts';
import { withPublicationGuard } from '../persistence/publication-guard.ts';
import { resolveFactWriteTarget } from '../persistence/fact-write-target.ts';
import { resolveExcludePrivatePages } from '../search/private-visibility.ts';
import {
  INGEST_EXTRACTOR_VERSION, attemptIdentity, claimIdentity, findAttemptByIdentity, isAttemptId, newAttemptId, principalKey,
  readAttempt, saveAttempt, sha256, supportingAttempts, attemptsOfDocument, dropAttempt,
  type IngestAttemptState, type IngestOptions, type IngestTopology,
} from '../ingest/checkpoint.ts';
import {
  INGEST_ENTITY_CAP, INGEST_MAX_CHARS, IngestProviderFailure, extractWindow, extractionKillSwitchOn, ingestModel, keylessCandidates,
  mergeWindows, windowDocument, type ExtractedWindow,
} from '../ingest/extract.ts';
import { planIngest, type IngestPlan, type PlannedPage } from '../ingest/plan.ts';
import {
  INGEST_REPORT_PREFIX, INGEST_REPORT_TYPE, filterReportForCaller, reportActions, reportPageContent, reportSlugFor, resolveStatus, summarize,
  type IngestReport, type ReportEvidence, type ReportFact, type ReportPage,
} from '../ingest/report.ts';

const DOCS = 'docs/guides/ingest.md';
const DEFAULT_MAX_USD = 0.5;
const ENTITY_CREATE_WAIT_MS = 15_000;
export const INGEST_MAX_USD_KEY = 'ingest.max_usd';

type Params = Record<string, unknown>;
type DoorResponse = Record<string, unknown>;

function invalid(code: 'ingest_input_invalid' | 'ingest_option_invalid', reason: string, message: string, suggestion: string, fix?: ReturnType<typeof readFix>): OperationError {
  return opError(code, message, 'Nothing was written. ' + suggestion, { reason, docs: DOCS + '#errors', ...(fix ? { fix } : {}) });
}

/** Rule 1: every input and option is checked before any read of the brain that could lead to a write. */
async function validateRun(ctx: OperationContext, p: Params): Promise<{ text: string; options: IngestOptions; maxUsd: number; title: string | null; slug: string | null }> {
  if (typeof p.content !== 'string') throw invalid('ingest_input_invalid', 'missing', 'No document text was passed.', 'Pass the document as content (CLI: --file <path> or --stdin).');
  const text = p.content;
  if (text.includes('\u0000')) throw invalid('ingest_input_invalid', 'binary', 'The document contains NUL bytes, so it looks binary.', 'Ingest reads text only; store binary files with file_upload.');
  if (!text.trim()) throw invalid('ingest_input_invalid', 'empty', 'The document is empty.', 'Pass a document with text in it.');
  if (text.length > INGEST_MAX_CHARS) {
    throw invalid('ingest_input_invalid', 'too_large', 'The document has ' + text.length + ' characters; ingest reads at most ' + INGEST_MAX_CHARS + '.', 'Split it into parts of at most ' + INGEST_MAX_CHARS + ' characters and ingest each part.');
  }
  const type = typeof p.type === 'string' && p.type.trim() ? p.type.trim() : 'note';
  const { loadActivePackForWriteVocabulary, packDeclaresPageType } = await import('../schema-pack/write-vocabulary.ts');
  const pack = await loadActivePackForWriteVocabulary(ctx);
  if (pack && !packDeclaresPageType(pack, type)) {
    throw invalid('ingest_option_invalid', 'unknown_type', 'Page type "' + type + '" is not declared by the active schema pack.', 'Pass one of the pack\'s page types as --type (schema_types lists them).',
      readFix('Lists the page types the active schema pack declares, read-only.', { argv: ['gbrain', 'schema', 'types', '--json'] }));
  }
  let validFrom: string | null = null;
  if (p.valid_from !== undefined) {
    if (typeof p.valid_from !== 'string' || !/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(p.valid_from) || Number.isNaN(Date.parse(p.valid_from))) {
      throw invalid('ingest_option_invalid', 'valid_from', 'valid_from "' + String(p.valid_from).slice(0, 40) + '" is not an ISO 8601 date.', 'Pass a date like 2026-03-01 or 2026-03-01T09:00:00Z.');
    }
    validFrom = p.valid_from.slice(0, 10);
  }
  const visibility = p.visibility === undefined ? 'world' : p.visibility;
  if (visibility !== 'world' && visibility !== 'private') throw invalid('ingest_option_invalid', 'visibility', 'visibility "' + String(visibility).slice(0, 40) + '" is not world or private.', 'Pass visibility world or private.');
  if (visibility === 'private' && ctx.remote !== false) throw invalid('ingest_option_invalid', 'visibility', 'Only the local CLI can ingest with visibility private.', 'Omit visibility, or run gbrain ingest --visibility private on the brain host.');
  const configured = Number(await ctx.engine.getConfig(INGEST_MAX_USD_KEY) ?? DEFAULT_MAX_USD);
  const ceiling = Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_MAX_USD;
  let maxUsd = ceiling;
  if (p.max_usd !== undefined) {
    if (typeof p.max_usd !== 'number' || !Number.isFinite(p.max_usd) || p.max_usd < 0) throw invalid('ingest_option_invalid', 'max_usd', 'max_usd must be a number of dollars, 0 or more.', 'Pass max_usd like 0.25.');
    maxUsd = ctx.remote === false ? p.max_usd : Math.min(p.max_usd, ceiling);
  }
  if (p.trusted_extraction === true && ctx.remote !== false) {
    throw invalid('ingest_option_invalid', 'trusted_extraction', 'trusted_extraction is for the local brain owner only.', 'Omit it: remote ingests always propose new pages for the owner to approve.');
  }
  const slug = typeof p.slug === 'string' && p.slug.trim() ? p.slug.trim().toLowerCase() : null;
  if (slug?.startsWith('ingest/')) throw invalid('ingest_option_invalid', 'slug', 'Slugs under ingest/ are reserved for ingest reports.', 'Pass another slug, or omit it.');
  const { model, available } = await ingestModel(ctx.engine);
  const keyed = !!model && available && !(await extractionKillSwitchOn(ctx.engine));
  return {
    text, maxUsd, title: typeof p.title === 'string' && p.title.trim() ? p.title.trim() : null, slug,
    options: { type, visibility, valid_from: validFrom, no_facts: p.no_facts === true, trusted_extraction: p.trusted_extraction === true, keyed },
  };
}

/** Round-4 item 3: storage is the source's configured topology; a repository source whose Git target is unavailable refuses. */
async function verifiedTopology(ctx: OperationContext, sourceId: string): Promise<IngestTopology> {
  const [source] = await ctx.engine.executeRaw<{ incarnation: string; archived: boolean; local_path: string | null; kind: string | null }>(
    "SELECT incarnation, archived, local_path, config->>'kind' AS kind FROM sources WHERE id=$1", [sourceId]);
  if (!source || source.archived) {
    throw opError('source_changed', 'The write source is not active.', 'Source ' + sourceId + ' is archived or not registered, so nothing was written. Ingest into an active source (sources_list shows them).');
  }
  const root = source.local_path || (sourceId === 'default' ? await ctx.engine.getConfig('sync.repo_path') : null);
  if (!root) return { storage: 'database', root: null, source_incarnation: source.incarnation };
  const target = await resolveFactWriteTarget(ctx.engine, sourceId, source, { fileBacked: true, remote: ctx.remote !== false });
  if (target.kind === 'publish' && target.databaseOnlyReason) {
    throw opError('ingest_storage_unavailable', 'Source ' + sourceId + ' has a repository, but its Git write target is unavailable (' + target.databaseOnlyReason + ').',
      'Nothing was written. Ingest never writes a repository-backed source to the database before Git has it. The brain operator restores the Git target (sync.write_through, the worktree owner), then the same ingest runs again.',
      { reason: target.databaseOnlyReason, docs: DOCS + '#storage', fix: { argv: ['gbrain', 'doctor', '--json'], consent: [], actor: 'host_admin', why: 'Shows why the source writes database-only, read-only.', requires_exclusive: false } });
  }
  return { storage: 'git', root: ctx.remote === false ? root : null, source_incarnation: source.incarnation };
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {});
const requestIdOf = (r: DoorResponse): string | undefined => {
  const w = asRecord(r.write_request);
  return (typeof r.request_id === 'string' ? r.request_id : typeof w.request_id === 'string' ? w.request_id : typeof w.id === 'string' ? w.id : undefined);
};
const pendingOf = (r: DoorResponse) => r.status === 'pending' || asRecord(r.write_request).state === 'pending';

/** One page through the door; a pending receipt or a typed refusal comes back as data so its siblings carry on. */
async function publish(ctx: OperationContext, sourceId: string, params: Params, internalIngestReport = false):
  Promise<{ ok: true; response: DoorResponse; request_id: string; pending: boolean } | { ok: false; code: string; message: string; request_id: string }> {
  const request_id = typeof params.request_id === 'string' ? params.request_id : randomUUID();
  const { submitPageMutation } = await import('../persistence/page-mutations.ts');
  try {
    const response = await submitPageMutation(ctx, { operation: 'put_page', params: { ...params, source_id: sourceId, request_id }, ...(internalIngestReport ? { internalIngestReport: true as const } : {}) });
    return { ok: true, response, request_id: requestIdOf(response) ?? request_id, pending: pendingOf(response) };
  } catch (error) {
    if (error instanceof OperationError && error.code === 'write_pending') return { ok: true, response: { status: 'pending' }, request_id, pending: true };
    if (error instanceof OperationError) return { ok: false, code: error.code, message: error.message, request_id };
    throw error;
  }
}

async function snapshotRevision(ctx: OperationContext, sourceId: string, slug: string): Promise<string | null> {
  const snap = await ctx.engine.readPageSnapshot(slug, { sourceId });
  return snap && !snap.page.deleted_at ? snap.revision : null;
}

function emptyReport(state: IngestAttemptState, maxUsd: number): IngestReport {
  return {
    attempt_id: state.attempt_id, ingest_id: state.attempt_id,
    attempt: { extractor_version: state.extractor_version, model: state.model, created_at: state.created_at },
    status: 'incomplete', complete: false, summary: '', storage: state.topology.storage,
    source_page: { slug: state.source_slug, status: 'pending' }, report_page: state.report_slug, visibility: state.options.visibility,
    coverage: { chars_read: 0, chars_total: state.chars_total, windows_done: 0, windows_total: state.windows_total },
    spent_usd: state.spent_usd, max_usd: maxUsd, plan_basis: state.options.keyed ? 'model' : 'keyless_candidates',
    pages: [], facts: [], write_requests: [], undo_window_days: 30, actions: [],
  };
}

async function undoWindowDays(ctx: OperationContext): Promise<number> {
  const raw = Number(await ctx.engine.getConfig('persistence.receipt_retention_days'));
  return Number.isFinite(raw) && raw > 0 ? raw : 30;
}

function coverage(state: IngestAttemptState) {
  const done = Object.values(state.windows);
  return { chars_read: done.reduce((n, w) => n + w.chars, 0), chars_total: state.chars_total, windows_done: done.length, windows_total: state.windows_total };
}

function finish(ctx: OperationContext, state: IngestAttemptState, report: IngestReport): IngestReport {
  report.coverage = coverage(state);
  if (!state.options.keyed) report.coverage = { ...report.coverage, chars_read: state.chars_total };
  report.spent_usd = Math.round(state.spent_usd * 1e6) / 1e6;
  report.summary = summarize(report);
  report.actions = reportActions(ctx, state, report);
  return report;
}

async function visibleTo(ctx: OperationContext, sourceId: string, slugs: string[]): Promise<(slug: string) => boolean> {
  if (ctx.remote === false || !slugs.length) return () => true;
  const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);
  const rows = await ctx.engine.executeRaw<{ slug: string; private: boolean }>(
    "SELECT slug, COALESCE(frontmatter->>'visibility','') = 'private' AS private FROM pages WHERE source_id=$1 AND slug = ANY($2::text[]) AND deleted_at IS NULL",
    [sourceId, slugs]);
  const hidden = new Set(rows.filter(r => excludePrivate && r.private).map(r => r.slug));
  return slug => !hidden.has(slug);
}

/** The stored report as this caller may see it (status and repeats; read-only, provider-free). */
async function storedReport(ctx: OperationContext, state: IngestAttemptState, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const report = state.report ?? finish(ctx, state, emptyReport(state, DEFAULT_MAX_USD));
  const fresh = { ...report, actions: reportActions(ctx, state, report) };
  const visible = await visibleTo(ctx, state.source_id, [...report.pages.map(p => p.slug), ...report.facts.flatMap(f => f.copies.map(c => c.entity_slug))].filter(Boolean));
  return { ...filterReportForCaller(fresh, visible), ...extra };
}

async function principalOf(ctx: OperationContext) {
  const { initializeLocalPersistence, requestPrincipalForContext } = await import('../persistence/page-mutations.ts');
  await initializeLocalPersistence(ctx);
  return requestPrincipalForContext(ctx);
}

/**
 * Plan step 1: before any provider call or write, the caller's grant must cover what ingest commits: the source page,
 * the report page under ingest/ and, when facts are extracted, remember. The door's own authorization answers it.
 */
async function assertCallerCanCommit(ctx: OperationContext, sourceId: string, incarnation: string, sourceSlug: string, facts: boolean): Promise<void> {
  const { submissionAuthority } = await import('../persistence/authority.ts');
  const needs: Array<[string, string, string]> = [['put_page', sourceSlug, 'the source page ' + sourceSlug], ['put_page', reportSlugFor('a' + '0'.repeat(16)), 'the report page under ' + INGEST_REPORT_PREFIX],
    ...(facts ? [['remember', sourceSlug, 'facts (remember)'] as [string, string, string]] : [])];
  for (const [operation, slug, what] of needs) {
    try {
      await submissionAuthority(ctx, operation, sourceId, incarnation, slug);
    } catch (error) {
      if (!(error instanceof OperationError)) throw error;
      throw opError('permission_denied', 'This caller cannot write ' + what + ', which ingest commits: ' + error.message,
        'Nothing was extracted or written. The grant must cover the source page slug, ' + INGEST_REPORT_PREFIX + ', put_page and remember; ask the brain owner to widen it, or pass a slug inside it.',
        { docs: DOCS + '#remote-callers' });
    }
  }
}

/** Status, resume and undo by attempt id: the local owner reads every attempt, any other caller only its own. */
async function callerMayRead(ctx: OperationContext, state: IngestAttemptState): Promise<boolean> {
  return ctx.remote === false || principalKey(await principalOf(ctx)) === principalKey(state.principal);
}

function attemptNotFound(id: string): OperationError {
  return opError('ingest_attempt_not_found', 'No ingest attempt ' + id.slice(0, 40) + ' is visible to this caller.',
    'Check the attempt id in the report you were given (it starts with a and has 16 hex digits); attempts are visible to the caller that ran them and to the local owner.', { docs: DOCS + '#status-and-resume' });
}

/** Rule 2: windows extracted under the budget and kill switch, the checkpoint advanced after each paid window. */
async function extractRemaining(ctx: OperationContext, state: IngestAttemptState, text: string, maxUsd: number): Promise<{ stop?: IngestReport['stop']; failure?: IngestProviderFailure }> {
  if (!state.options.keyed || state.options.no_facts) return {};
  const windows = windowDocument(text);
  for (const w of windows) {
    if (state.windows[String(w.index)]) continue;
    if (await extractionKillSwitchOn(ctx.engine)) return { stop: 'kill_switch' };
    const remaining = maxUsd - state.spent_usd;
    if (remaining <= 0) return { stop: 'budget' };
    state.in_flight = w.index;
    await saveAttempt(ctx.engine, state);
    let out: ExtractedWindow;
    try {
      out = await extractWindow({ engine: ctx.engine, model: state.model!, window: w, windowsTotal: windows.length, remainingUsd: remaining });
    } catch (error) {
      state.in_flight = null;
      await saveAttempt(ctx.engine, state);
      if (error instanceof IngestProviderFailure) return { failure: error };
      if ((error as Error)?.name === 'BudgetExhausted') return { stop: 'budget' };
      throw error;
    }
    state.windows[String(w.index)] = out;
    state.spent_usd += out.spent_usd;
    state.in_flight = null;
    await saveAttempt(ctx.engine, state);
  }
  return {};
}

function sourcePageContent(state: IngestAttemptState, title: string | null, text: string): string {
  return stringifyDataFrontmatter(text.endsWith('\n') ? text : text + '\n', JSON.parse(JSON.stringify({
    type: state.options.type,
    title: title ?? 'Ingested document ' + state.document_hash.slice(0, 12),
    facts_backstop: false,
    ingest_document: state.document_hash,
    ...(state.options.visibility === 'private' ? { visibility: 'private' } : {}),
  })));
}

function entityPageContent(page: { name: string; type: string; context: string }, proposed: boolean, state: IngestAttemptState): string {
  const context = page.context.trim().replace(/\s+/g, ' ').slice(0, 600);
  const body = (context ? context + '\n\n' : '') + 'Mentioned in [[' + state.source_slug + ']].\n';
  return stringifyDataFrontmatter(body, {
    type: page.type, title: page.name,
    ...(proposed ? quarantineMarkers() : {}),
    ingest_attempt: state.attempt_id,
    ...(state.options.visibility === 'private' ? { visibility: 'private' } : {}),
  });
}

/** The source-scoped entity-create serialization: held only for revalidate-and-publish of one new page, never across receipt waits. */
async function withEntityCreateLock<T>(ctx: OperationContext, sourceId: string, work: () => Promise<T>): Promise<T> {
  const deadline = performance.now() + ENTITY_CREATE_WAIT_MS;
  for (;;) {
    const handle = await tryAcquireDbLock(ctx.engine, 'ingest-entity-create:' + sourceId, 2);
    if (handle) { try { return await work(); } finally { await handle.release().catch(() => {}); } }
    if (performance.now() >= deadline) throw opError('lock_busy', 'Another ingest held the entity-create lock on source ' + sourceId + ' for the whole wait.', 'Retry the same ingest with resume once the other finishes; nothing was lost.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/** Rule 4: one publisher per page; facts through remember's explicit-entity fence writer, rechecked at write time. */
async function commitPlan(ctx: OperationContext, state: IngestAttemptState, plan: IngestPlan, report: IngestReport, evidence: ReportEvidence, title: string | null, text: string): Promise<void> {
  const sourceId = state.source_id;
  const writeReport = async () => {
    evidence.status = report.status;
    const revision = await snapshotRevision(ctx, sourceId, state.report_slug);
    const r = await publish(ctx, sourceId, { slug: state.report_slug, content: reportPageContent(state.attempt_id, state.options.visibility, summarize(report), evidence),
      ...(revision ? { expected_revision: revision } : {}) }, true);
    if (!r.ok) throw opError('ingest_commit_failed', 'The ingest report page could not be written (' + r.code + ').', r.message);
  };
  // The source page: create-only, keyed by the document hash; an existing page with this document is reused.
  const existing = await ctx.engine.readPageSnapshot(state.source_slug, { sourceId, includeDeleted: true });
  if (existing && !existing.page.deleted_at) {
    const fm = asRecord(existing.page.frontmatter);
    if (fm.ingest_document !== state.document_hash) {
      report.source_page = { slug: state.source_slug, status: 'failed' };
      throw opError('ingest_commit_failed', 'Page ' + state.source_slug + ' already exists with other content.', 'Nothing else was written. Pass another slug, or omit it to file the document under its content hash.');
    }
    report.source_page = { slug: state.source_slug, status: 'existing' };
  } else {
    const r = await publish(ctx, sourceId, { slug: state.source_slug, content: sourcePageContent(state, title, text), ...(existing ? { expected_revision: existing.revision } : {}) });
    if (!r.ok) {
      report.source_page = { slug: state.source_slug, status: 'failed' };
      throw opError('ingest_commit_failed', 'The source page could not be written (' + r.code + ').', r.message);
    }
    report.source_page = { slug: state.source_slug, status: r.pending ? 'pending' : 'created', request_id: r.request_id };
    report.write_requests.push({ slug: state.source_slug, request_id: r.request_id, state: r.pending ? 'pending' : 'committed' });
    evidence.source_created = true;
  }
  await writeReport();
  // New entity pages, each revalidated under the entity-create lock.
  const written = new Map<string, ReportPage>();
  for (const page of plan.pages) {
    const base: ReportPage = { name: page.name, slug: page.slug, type: page.type, status: 'skipped', ...(page.near_names ? { near_names: page.near_names } : {}) };
    if (page.status === 'skipped') { report.pages.push({ ...base, reason: page.reason }); continue; }
    if (page.status === 'existing') { const row = { ...base, status: 'existing' as const }; report.pages.push(row); written.set(page.slug, row); continue; }
    const create = (target: PlannedPage) => withEntityCreateLock(ctx, sourceId, async (): Promise<ReportPage | null> => {
      const proposed = target.status === 'propose';
      const at = { ...base, slug: target.slug };
      const snap = await ctx.engine.readPageSnapshot(target.slug, { sourceId, includeDeleted: true });
      if (snap && !snap.page.deleted_at) return null;
      const r = await publish(ctx, sourceId, { slug: target.slug, content: entityPageContent(target, proposed, state), ...(snap ? { expected_revision: snap.revision } : {}) });
      if (!r.ok) return { ...at, status: 'failed', reason: r.code };
      report.write_requests.push({ slug: target.slug, request_id: r.request_id, state: r.pending ? 'pending' : 'committed' });
      if (r.pending) return { ...at, status: 'pending', request_id: r.request_id };
      evidence.created_pages.push({ slug: target.slug, request_id: r.request_id, revision: null, proposed });
      return { ...at, status: proposed ? 'proposed' : 'created', request_id: r.request_id };
    });
    const conflict: ReportPage = { ...base, status: 'skipped', reason: 'create_conflict' };
    let row = await create(page);
    if (!row) {
      // Another writer took the slug after planning: plan this one entity again against the brain as it is now, once.
      const [again] = (await planIngest({ ctx, sourceId, text, entities: [{ name: page.name, type: page.type, context: page.context, source: page.source }], facts: [],
        visibility: state.options.visibility, validFrom: null, trusted: state.options.trusted_extraction, factsSkipped: null })).pages;
      row = !again ? conflict
        : again.status === 'existing' ? { ...base, slug: again.slug, status: 'existing' }
        : again.status === 'skipped' ? { ...base, slug: again.slug || page.slug, status: 'skipped', reason: again.reason }
        : (await create(again)) ?? conflict;
      if (row.status === 'existing') { report.pages.push(row); written.set(page.slug, row); continue; }
    }
    report.pages.push(row);
    if (row.status === 'proposed' || row.status === 'created') written.set(page.slug, row);
  }
  await writeReport();
  // Facts: every copy rechecked against saved facts, then written onto its entity's fence through remember.
  const remember = (await import('../operations.ts')).operationsByName.remember!;
  const excludePrivate = await resolveExcludePrivatePages(ctx.engine, ctx.remote);
  for (const f of plan.facts) {
    const row: ReportFact = { fact: f.fact, kind: f.kind, status: f.status === 'skipped' ? 'skipped' : 'pending', ...(f.reason ? { reason: f.reason } : {}), copies: [] };
    for (const c of f.copies) {
      const target = written.get(c.entity_slug);
      if (c.status === 'skipped') { row.copies.push({ entity_slug: c.entity_slug, status: 'skipped', reason: c.reason }); continue; }
      if (!target) {
        const pageRow = report.pages.find(p => p.slug === c.entity_slug);
        row.copies.push({ entity_slug: c.entity_slug, status: pageRow?.status === 'pending' ? 'pending' : 'skipped', reason: pageRow?.status === 'pending' ? 'page_pending' : 'page_not_written' });
        continue;
      }
      const check = await checkFactAgainstSaved(ctx.engine, sourceId, { fact: f.fact, kind: f.kind, visibility: state.options.visibility, entity_slug: target.slug }, { excludePrivate });
      if (check.verdict === 'withdrawn') { row.copies.push({ entity_slug: target.slug, status: 'skipped', reason: 'withdrawn' }); continue; }
      if (check.verdict === 'duplicate') {
        row.copies.push({ entity_slug: target.slug, status: 'support', fact_id: check.id });
        if (!evidence.support_fact_ids.includes(check.id)) evidence.support_fact_ids.push(check.id);
        continue;
      }
      const request_id = randomUUID();
      try {
        const res = asRecord(await remember.handler(ctx, {
          fact: f.fact, entity: target.slug, provenance: 'ingest:' + state.source_slug, kind: f.kind, request_id,
          visibility: state.options.visibility, ...(f.valid_from ? { valid_from: f.valid_from } : {}), infer_entity: false,
        }));
        const id = Number(res.fact_id ?? res.id ?? asRecord((res.facts as unknown[] | undefined)?.[0]).id);
        const pending = pendingOf(res);
        row.copies.push({ entity_slug: target.slug, status: pending ? 'pending' : 'created', ...(Number.isFinite(id) ? { fact_id: id } : {}), request_id });
        report.write_requests.push({ slug: target.slug, request_id, state: pending ? 'pending' : 'committed' });
        if (!pending && Number.isFinite(id)) evidence.created_facts.push({ id, entity_slug: target.slug, request_id });
      } catch (error) {
        if (!(error instanceof OperationError)) throw error;
        row.copies.push({ entity_slug: target.slug, status: 'failed', reason: error.code, request_id });
      }
    }
    // D3 and round-4 item 11: the links effect derives no mentions edge from fence rows on either storage (checked in
    // test/ingest.serial.test.ts), so a claim saved on two entities gets one explicit edge, never a duplicate.
    const [first, second] = row.copies;
    if (first?.status === 'created' && second?.status === 'created') {
      const [edge] = await ctx.engine.executeRaw<{ n: number }>(
        'SELECT count(*)::int AS n FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE f.source_id=$1 AND f.slug=$2 AND t.slug=$3',
        [sourceId, second.entity_slug, first.entity_slug]);
      if (!Number(edge?.n)) {
        await (await import('../operations.ts')).operationsByName.add_link!.handler(ctx, { from: second.entity_slug, to: first.entity_slug, link_type: 'mentions', link_source: 'ingest', context: f.fact.slice(0, 300), source_id: sourceId })
          .catch(error => { if (!(error instanceof OperationError)) throw error; });
      }
    }
    if (row.copies.length) {
      const s = row.copies.map(c => c.status);
      row.status = s.includes('failed') ? 'failed' : s.includes('pending') ? 'pending' : s.includes('created') ? 'created' : s.includes('support') ? 'support' : 'skipped';
    }
    report.facts.push(row);
  }
  for (const p of evidence.created_pages) p.revision = await snapshotRevision(ctx, sourceId, p.slug);
}

async function runIngest(ctx: OperationContext, p: Params): Promise<Record<string, unknown>> {
  const sourceId = (await import('../persistence/page-mutations.ts')).pageMutationSource(ctx, p, 'put_page');
  // Status and resume by attempt id: status is read-only and provider-free.
  if (p.attempt_id !== undefined && p.resume !== true) {
    if (!isAttemptId(p.attempt_id)) throw attemptNotFound(String(p.attempt_id));
    const state = await readAttempt(ctx.engine, p.attempt_id);
    if (!state || !(await callerMayRead(ctx, state))) throw attemptNotFound(p.attempt_id);
    return storedReport(ctx, state);
  }
  const v = await validateRun(ctx, p);
  const documentHash = sha256(v.text);
  const topology = await verifiedTopology(ctx, sourceId);
  const { model } = await ingestModel(ctx.engine);
  const windowsTotal = v.options.keyed && !v.options.no_facts ? windowDocument(v.text).length : 0;
  if (p.dry_run === true || ctx.dryRun) {
    const candidates = keylessCandidates(v.text);
    const plan = await planIngest({ ctx, sourceId, text: v.text, entities: candidates, facts: [], visibility: v.options.visibility, validFrom: v.options.valid_from, trusted: false, factsSkipped: 'dry_run' });
    const { estimateChatCostUsd } = await import('../ai/chat-usage.ts');
    const perWindow = model ? estimateChatCostUsd(model, { input_tokens: Math.ceil(Math.min(v.text.length, 8000) / 4) + 800, output_tokens: 1500 }) : null;
    return {
      dry_run: true, plan_basis: 'keyless_candidates', storage: topology.storage, source_id: sourceId, chars_total: v.text.length,
      windows_total: windowDocument(v.text).length, est_usd: perWindow === null ? null : Math.round(perWindow * windowDocument(v.text).length * 1e4) / 1e4,
      max_usd: v.maxUsd, keyed: v.options.keyed, pages: plan.pages.map(pg => ({ name: pg.name, slug: pg.slug, type: pg.type, status: pg.status === 'create' || pg.status === 'propose' ? 'proposed' : pg.status, ...(pg.reason ? { reason: pg.reason } : {}), ...(pg.near_names ? { near_names: pg.near_names } : {}) })),
      summary: 'Dry run: ' + plan.pages.length + ' candidate names from the keyless candidate function; no provider call, nothing written.',
    };
  }
  const principal = await principalOf(ctx);
  const identity = attemptIdentity({ sourceId, documentHash, principal, options: v.options, ...(typeof p.request_id === 'string' ? { requestId: p.request_id } : {}) });
  let state = isAttemptId(p.attempt_id) ? await readAttempt(ctx.engine, p.attempt_id) : await findAttemptByIdentity(ctx.engine, identity);
  if (isAttemptId(p.attempt_id) && (!state || !(await callerMayRead(ctx, state)))) throw attemptNotFound(p.attempt_id);
  if (state && state.document_hash !== documentHash) {
    throw opError('ingest_document_mismatch', 'The document passed does not match the one attempt ' + state.attempt_id + ' read.', 'Nothing was written. Resume with the same document text (its sha256 must match), or start a new ingest without attempt_id.', { docs: DOCS + '#status-and-resume' });
  }
  if (state && state.phase === 'complete') return storedReport(ctx, state, { repeated: true });
  if (state && state.phase !== 'undone' && p.resume !== true) return storedReport(ctx, state, { repeated: true, resumable: true });
  await assertCallerCanCommit(ctx, sourceId, topology.source_incarnation, state?.source_slug ?? v.slug ?? 'inbox/ingest-' + documentHash.slice(0, 12), v.options.keyed && !v.options.no_facts);
  if (!state || state.phase === 'undone') {
    const now = new Date().toISOString();
    const attempt_id = newAttemptId();
    const fresh: IngestAttemptState = {
      v: 1, attempt_id, identity, source_id: sourceId, document_hash: documentHash, chars_total: v.text.length, principal, options: v.options,
      extractor_version: INGEST_EXTRACTOR_VERSION, model: v.options.keyed ? model : null, topology, phase: 'extracting', created_at: now, updated_at: now,
      windows_total: windowsTotal, windows: {}, in_flight: null, spent_usd: 0,
      source_slug: v.slug ?? 'inbox/ingest-' + documentHash.slice(0, 12), report_slug: reportSlugFor(attempt_id), support_fact_ids: [], report: null,
    };
    // Round-4 item 6: the checkpoint exists before the first provider call; of two identical ingests one wins the identity.
    await saveAttempt(ctx.engine, fresh);
    const winner = await claimIdentity(ctx.engine, identity, attempt_id);
    if (winner !== attempt_id) {
      await dropAttempt(ctx.engine, attempt_id);
      const other = await readAttempt(ctx.engine, winner);
      if (other) return storedReport(ctx, other, { repeated: true, ...(other.phase !== 'complete' ? { resumable: true } : {}) });
    }
    state = fresh;
  } else {
    if (state.topology.storage !== topology.storage || state.topology.source_incarnation !== topology.source_incarnation) {
      throw opError('ingest_storage_unavailable', 'Source ' + sourceId + ' changed storage since attempt ' + state.attempt_id + ' started.', 'Nothing more was written. Start a new ingest of the same document; fact dedup keeps it from duplicating claims.', { reason: 'topology_changed', docs: DOCS + '#storage' });
    }
  }
  const started = performance.now();
  const report = emptyReport(state, v.maxUsd);
  report.undo_window_days = await undoWindowDays(ctx);
  if (p.resume === true) report.attempt.resumed = true;
  const extracted = await extractRemaining(ctx, state, v.text, v.maxUsd);
  if (extracted.stop || extracted.failure) {
    const f = extracted.failure;
    report.stop = extracted.stop ?? 'provider';
    if (f) report.failure = { stage: 'extract', window: f.window, reason: f.reason, retryable: f.retryable, cause: f.message, model: f.model, gbrain_version: VERSION, max_usd: v.maxUsd };
    report.status = f && !f.retryable ? 'failed' : 'incomplete';
    state.phase = f && !f.retryable ? 'failed' : 'extracting';
    state.report = finish(ctx, state, report);
    await saveAttempt(ctx.engine, state);
    return { ...state.report, elapsed_ms: Math.round(performance.now() - started) };
  }
  const merged = mergeWindows(Object.values(state.windows));
  const entities = [...merged.entities, ...keylessCandidates(v.text)].slice(0, INGEST_ENTITY_CAP * 2);
  const factsSkipped = v.options.no_facts ? 'no_facts' : !v.options.keyed ? 'chat_unavailable' : null;
  if (!v.options.keyed) report.missing_capability = { capability: 'chat', why: 'No chat model is configured or fact extraction is switched off, so names come from the keyless candidate function and facts are skipped.', check: ['gbrain', 'models', '--json'] };
  const plan = await planIngest({ ctx, sourceId, text: v.text, entities, facts: merged.facts, visibility: v.options.visibility, validFrom: v.options.valid_from, trusted: v.options.trusted_extraction, factsSkipped });
  state.phase = 'committing';
  await saveAttempt(ctx.engine, state);
  // Round-4 item 3: the pinned topology is re-checked at publication.
  const now = await verifiedTopology(ctx, sourceId);
  if (now.storage !== state.topology.storage || now.source_incarnation !== state.topology.source_incarnation) {
    throw opError('ingest_storage_unavailable', 'Source ' + sourceId + ' changed storage while attempt ' + state.attempt_id + ' was extracting.', 'Nothing was written. Run the same ingest again; finished windows are kept.', { reason: 'topology_changed', docs: DOCS + '#storage' });
  }
  const evidence: ReportEvidence = { attempt_id: state.attempt_id, principal: principalKey(principal), source_id: sourceId, source_slug: state.source_slug, source_created: false,
    storage: state.topology.storage, created_pages: [], created_facts: [], support_fact_ids: [], status: 'incomplete' };
  try {
    await commitPlan(ctx, state, plan, report, evidence, v.title, v.text);
  } catch (error) {
    report.status = 'failed';
    report.failure = { stage: 'commit', reason: error instanceof OperationError ? error.code : 'internal_error', retryable: false, cause: error instanceof Error ? error.message.slice(0, 300) : String(error), gbrain_version: VERSION, max_usd: v.maxUsd };
    state.phase = 'failed';
    state.report = finish(ctx, state, report);
    await saveAttempt(ctx.engine, state);
    return { ...state.report, elapsed_ms: Math.round(performance.now() - started) };
  }
  const items = [...report.pages.map(x => x.status), ...report.facts.map(x => x.status), report.source_page.status];
  report.status = resolveStatus({ failed: items.includes('failed'), pending: items.includes('pending'), incomplete: false });
  report.complete = report.status === 'complete';
  state.support_fact_ids = evidence.support_fact_ids;
  state.phase = report.status === 'failed' ? 'failed' : 'complete';
  state.report = finish(ctx, state, report);
  evidence.status = report.status;
  const revision = await snapshotRevision(ctx, sourceId, state.report_slug);
  await publish(ctx, sourceId, { slug: state.report_slug, content: reportPageContent(state.attempt_id, state.options.visibility, state.report.summary, evidence), ...(revision ? { expected_revision: revision } : {}) }, true);
  await saveAttempt(ctx.engine, state);
  await ctx.engine.logIngest({ source_id: sourceId, source_type: 'ingest', source_ref: state.attempt_id, pages_updated: report.pages.filter(x => x.status === 'created' || x.status === 'proposed').map(x => x.slug), summary: state.report.summary });
  return { ...state.report, elapsed_ms: Math.round(performance.now() - started) };
}

// ---------------------------------------------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------------------------------------------

interface UndoPlan {
  retract: Array<{ fact_id: number; entity_slug: string; row_num: number }>;
  delete: Array<{ slug: string }>;
  skipped: Array<{ kind: 'fact' | 'page'; ref: string; reason: string }>;
}

function unverifiable(id: string, why: string): OperationError {
  return opError('ingest_undo_unverifiable', 'Undo cannot verify what attempt ' + id + ' created: ' + why + '.',
    'Nothing was retracted. Undo only retracts items whose ownership the report page and the brain still prove; review the attempt\'s pages with ingest-show and retract by hand (forget_fact, extraction-review reject) where needed.',
    { docs: DOCS + '#undo', fix: readFix('Shows the attempt\'s report, read-only.', { argv: ['gbrain', 'ingest-show', id], mcp: { tool: 'ingest', arguments: { attempt_id: id } } }) });
}

/** Ownership read from the report page (it outlives receipt retention), cross-checked against the attempt checkpoint. */
async function readEvidence(ctx: OperationContext, state: IngestAttemptState): Promise<ReportEvidence> {
  const snap = await ctx.engine.readPageSnapshot(state.report_slug, { sourceId: state.source_id });
  const fm = snap && !snap.page.deleted_at ? asRecord(snap.page.frontmatter) : null;
  if (!fm || snap!.page.type !== INGEST_REPORT_TYPE) throw unverifiable(state.attempt_id, 'its report page is missing');
  const ev = asRecord(fm.ingest) as unknown as ReportEvidence;
  if (ev.attempt_id !== state.attempt_id || ev.principal !== principalKey(state.principal) || ev.source_id !== state.source_id) throw unverifiable(state.attempt_id, 'its report page names another attempt or principal');
  return { ...ev, created_pages: Array.isArray(ev.created_pages) ? ev.created_pages : [], created_facts: Array.isArray(ev.created_facts) ? ev.created_facts : [], support_fact_ids: Array.isArray(ev.support_fact_ids) ? ev.support_fact_ids : [] };
}

async function planUndo(ctx: OperationContext, state: IngestAttemptState, ev: ReportEvidence): Promise<UndoPlan> {
  const sourceId = state.source_id;
  const out: UndoPlan = { retract: [], delete: [], skipped: [] };
  const ids = ev.created_facts.map(f => f.id);
  const supportedOn = new Set<string>();
  const rows = ids.length ? await ctx.engine.executeRaw<{ id: number; entity_slug: string | null; row_num: number | null; expired_at: unknown; valid_until: unknown; source: string | null }>(
    'SELECT id, entity_slug, row_num, expired_at, valid_until, source FROM facts WHERE source_id=$1 AND id = ANY($2::int[])', [sourceId, ids]) : [];
  const byId = new Map(rows.map(r => [Number(r.id), r]));
  if (ids.length && !rows.length) throw unverifiable(state.attempt_id, 'none of its fact rows exist any more (a rebuild renumbers them)');
  for (const f of ev.created_facts) {
    const row = byId.get(f.id);
    if (!row || row.entity_slug !== f.entity_slug || row.source !== 'ingest:' + ev.source_slug) { out.skipped.push({ kind: 'fact', ref: String(f.id), reason: 'not_found' }); continue; }
    if (row.expired_at || row.valid_until) { out.skipped.push({ kind: 'fact', ref: String(f.id), reason: 'already_retracted' }); continue; }
    if ((await supportingAttempts(ctx.engine, f.id, state.attempt_id)).length) { out.skipped.push({ kind: 'fact', ref: String(f.id), reason: 'supported' }); supportedOn.add(f.entity_slug); continue; }
    if (row.row_num == null) { out.skipped.push({ kind: 'fact', ref: String(f.id), reason: 'not_fenced' }); continue; }
    out.retract.push({ fact_id: f.id, entity_slug: f.entity_slug, row_num: Number(row.row_num) });
  }
  for (const id of ev.support_fact_ids) out.skipped.push({ kind: 'fact', ref: String(id), reason: 'support_for_existing_claim' });
  const created = new Set([...ev.created_pages.map(p => p.slug), ev.source_slug, state.report_slug]);
  const referencedFrom = async (slug: string) => (await ctx.engine.executeRaw<{ slug: string }>(
    'SELECT DISTINCT f.slug FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE t.source_id=$1 AND t.slug=$2 AND f.deleted_at IS NULL',
    [sourceId, slug])).map(r => r.slug).filter(s => !created.has(s));
  for (const pg of ev.created_pages) {
    const snap = await ctx.engine.readPageSnapshot(pg.slug, { sourceId });
    if (!snap || snap.page.deleted_at) { out.skipped.push({ kind: 'page', ref: pg.slug, reason: 'not_found' }); continue; }
    if (pg.proposed && !isUnverifiedExtraction(asRecord(snap.page.frontmatter))) { out.skipped.push({ kind: 'page', ref: pg.slug, reason: 'promoted' }); continue; }
    if (pg.revision && snap.revision !== pg.revision) { out.skipped.push({ kind: 'page', ref: pg.slug, reason: 'edited' }); continue; }
    // A claim another attempt relies on keeps its page, and the source page it cites.
    if (supportedOn.has(pg.slug) || (await referencedFrom(pg.slug)).length) { out.skipped.push({ kind: 'page', ref: pg.slug, reason: 'referenced' }); continue; }
    out.delete.push({ slug: pg.slug });
  }
  if (ev.source_created) {
    const others = await attemptsOfDocument(ctx.engine, sourceId, state.document_hash, state.attempt_id);
    if (others.length) out.skipped.push({ kind: 'page', ref: ev.source_slug, reason: 'used_by_other_attempt' });
    else if (supportedOn.size || (await referencedFrom(ev.source_slug)).length) out.skipped.push({ kind: 'page', ref: ev.source_slug, reason: 'referenced' });
    else out.delete.push({ slug: ev.source_slug });
  }
  return out;
}

const undoHash = (state: IngestAttemptState, plan: UndoPlan) => createHash('sha256').update(JSON.stringify({ a: state.attempt_id, r: plan.retract, d: plan.delete })).digest('hex').slice(0, 32);

/** Strike the attempt's fence rows on one page through the door (valid_until today, no withdrawal), so a later write never re-projects them. */
async function strikeRows(ctx: OperationContext, sourceId: string, slug: string, rowNums: number[], today: string): Promise<'struck' | 'changed' | 'segmented'> {
  const snap = await ctx.engine.readPageSnapshot(slug, { sourceId });
  if (!snap || snap.page.deleted_at) return 'changed';
  try { assertInlineBody(snap.page, 'ingest_undo'); } catch { return 'segmented'; }
  let body: string | null = snap.page.compiled_truth;
  for (const n of rowNums) {
    body = body === null ? null : strikeFenceRow(body, n, f => ({ ...f, active: false, validUntil: today, context: ['ingest undone', f.context?.trim()].filter(Boolean).join(' | ') }));
  }
  if (body === null) return 'changed';
  const content = serializePageToMarkdown({ ...snap.page, compiled_truth: body } as Page, snap.tags);
  const r = await publish(ctx, sourceId, { slug, content, expected_revision: snap.revision });
  return r.ok ? 'struck' : 'changed';
}

async function runUndo(ctx: OperationContext, p: Params): Promise<Record<string, unknown>> {
  if (!isAttemptId(p.attempt_id)) throw attemptNotFound(String(p.attempt_id ?? ''));
  const state = await readAttempt(ctx.engine, p.attempt_id);
  if (!state) throw unverifiable(String(p.attempt_id), 'its attempt record is missing (a rebuild does not keep it)');
  if (!(await callerMayRead(ctx, state))) throw attemptNotFound(p.attempt_id);
  if (state.phase === 'undone') return { attempt_id: state.attempt_id, status: 'already_undone', retracted: 0, deleted: 0, summary: 'Attempt ' + state.attempt_id + ' was already undone; nothing changed.' };
  const sourceId = state.source_id;
  const ev = await readEvidence(ctx, state);
  const plan = await planUndo(ctx, state, ev);
  const plan_hash = undoHash(state, plan);
  const preview = { attempt_id: state.attempt_id, plan_hash, storage: state.topology.storage, retract: plan.retract.map(r => ({ fact_id: r.fact_id, entity_slug: r.entity_slug })), delete: plan.delete, skipped: plan.skipped };
  if (p.yes !== true || typeof p.expect !== 'string') {
    return { ...preview, status: 'preview', consent: ['destructive'],
      summary: 'Undo would retract ' + plan.retract.length + ' facts and delete ' + plan.delete.length + ' pages; ' + plan.skipped.length + ' items are kept. Nothing was changed.',
      fix: { next: ctx.remote === false ? 'ask_user' : 'ask_user', argv: ['gbrain', 'ingest-undo', state.attempt_id, '--yes', '--expect', plan_hash],
        ...(ctx.remote !== false && ctx.isCallable?.('ingest_undo') !== false ? { mcp: { tool: 'ingest_undo', arguments: { attempt_id: state.attempt_id, yes: true, expect: plan_hash } } } : {}),
        consent: ['destructive'], why: 'Applies exactly this preview; it refuses if anything changed since.', user_message: 'Undo ingest ' + state.attempt_id + ': retract ' + plan.retract.length + ' facts and soft-delete ' + plan.delete.length + ' pages (restorable for 72 hours)?' } };
  }
  return withPublicationGuard(ctx.engine, sourceId, async () => {
    const current = await planUndo(ctx, state, await readEvidence(ctx, state));
    if (undoHash(state, current) !== p.expect) {
      throw opError('preview_changed', 'What undo would change for attempt ' + state.attempt_id + ' changed since the preview.', 'Nothing was retracted. Preview again (gbrain ingest-undo ' + state.attempt_id + ') and apply the new plan_hash.',
        { docs: DOCS + '#undo', fix: readFix('Previews the undo again, read-only.', { argv: ['gbrain', 'ingest-undo', state.attempt_id], mcp: { tool: 'ingest_undo', arguments: { attempt_id: state.attempt_id } } }) });
    }
    const today = new Date().toISOString().slice(0, 10);
    const byPage = new Map<string, number[]>();
    for (const r of current.retract) byPage.set(r.entity_slug, [...(byPage.get(r.entity_slug) ?? []), r.row_num]);
    let retracted = 0;
    const skipped = [...current.skipped];
    for (const [slug, rowNums] of byPage) {
      const outcome = await strikeRows(ctx, sourceId, slug, rowNums, today);
      if (outcome === 'struck') retracted += rowNums.length;
      else for (const n of rowNums) skipped.push({ kind: 'fact', ref: slug + '#' + n, reason: outcome });
    }
    const { submitPageMutation } = await import('../persistence/page-mutations.ts');
    let deleted = 0;
    for (const d of current.delete) {
      const revision = await snapshotRevision(ctx, sourceId, d.slug);
      if (!revision) continue;
      try {
        await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: d.slug, source_id: sourceId, expected_revision: revision, request_id: randomUUID() } });
        deleted++;
      } catch (error) {
        if (!(error instanceof OperationError)) throw error;
        skipped.push({ kind: 'page', ref: d.slug, reason: error.code });
      }
    }
    const at = new Date().toISOString();
    state.phase = 'undone';
    if (state.report) state.report = { ...state.report, undo: { state: 'undone', at, retracted, deleted, skipped: skipped.length } };
    const evidence: ReportEvidence = { ...ev, undone_at: at };
    const revision = await snapshotRevision(ctx, sourceId, state.report_slug);
    await publish(ctx, sourceId, { slug: state.report_slug, content: reportPageContent(state.attempt_id, state.options.visibility, 'Undone: ' + retracted + ' facts retracted, ' + deleted + ' pages deleted.', evidence), ...(revision ? { expected_revision: revision } : {}) }, true);
    await saveAttempt(ctx.engine, state);
    return { attempt_id: state.attempt_id, status: 'undone', plan_hash, retracted, deleted, skipped, summary: 'Undid attempt ' + state.attempt_id + ': ' + retracted + ' facts retracted, ' + deleted + ' pages soft-deleted, ' + skipped.length + ' items kept.' };
  });
}

const ingest: Operation = {
  name: 'ingest',
  description: 'Save a pasted document: the whole text read in windows, every page and fact planned and checked before any write, then the source page, proposed pages for new entities and each fact on the entities it names. Returns an ingest report with a status per item, coverage, spend, and approve or undo actions. attempt_id alone reads a report (read-only); with resume: true it continues an incomplete attempt.',
  params: {
    content: { type: 'string', description: 'The document text (at most 200,000 characters).' },
    attempt_id: { type: 'string', description: 'An attempt id from a report: alone, read that report; with resume, continue it.' },
    resume: { type: 'boolean', description: 'Continue an incomplete attempt from its stored windows (pass the same content).' },
    type: { type: 'string', description: 'Page type of the source page (default note).' },
    title: { type: 'string', description: 'Title of the source page.' },
    slug: { type: 'string', description: 'Slug of the source page (default inbox/ingest-<hash>).', fullSurfaceOnly: true },
    source_id: { type: 'string', description: 'Source to write (default: your source).', fullSurfaceOnly: true },
    valid_from: { type: 'string', description: 'When the document\'s facts became true (ISO date).', fullSurfaceOnly: true },
    visibility: { type: 'string', enum: ['world', 'private'], description: 'world (default) or private (local CLI).', fullSurfaceOnly: true },
    no_facts: { type: 'boolean', description: 'Save the document and its entity pages without facts.', fullSurfaceOnly: true },
    trusted_extraction: { type: 'boolean', description: 'Local owner only: create model-typed new entities as real pages instead of proposed.', fullSurfaceOnly: true },
    max_usd: { type: 'number', description: 'Spend cap for this ingest in USD (default ingest.max_usd, 0.50).', fullSurfaceOnly: true },
    request_id: { type: 'string', description: 'Idempotency key: a repeat with the same key returns the same attempt.', fullSurfaceOnly: true },
    dry_run: { type: 'boolean', description: 'Preview the keyless candidate plan, window count and estimated cost; no provider call, nothing written.' },
  },
  outputRedaction: 'retrieval',
  writeInference: 'explicit_llm',
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => runIngest(ctx, p),
  cliHints: { name: 'ingest', hidden: true },
};

const ingest_undo: Operation = {
  name: 'ingest_undo',
  description: 'Undo one ingest attempt: without yes it previews what would be retracted and returns plan_hash (writes nothing); with yes and expect: <plan_hash> it strikes the facts the attempt wrote and soft-deletes the pages it created, skipping anything edited, promoted, referenced or supported since.',
  params: {
    attempt_id: { type: 'string', required: true, description: 'The attempt id from the ingest report.' },
    yes: { type: 'boolean', description: 'Apply the undo (needs expect).' },
    expect: { type: 'string', description: 'The plan_hash from the preview you are applying.' },
  },
  outputRedaction: 'no_stored_text',
  writeInference: 'none',
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => runUndo(ctx, p),
  cliHints: { name: 'ingest-undo', hidden: true },
};

export const ingestOperations: Operation[] = [ingest, ingest_undo];
