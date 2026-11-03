/**
 * Entity-extraction quarantine-lane operation cluster — pure move from
 * operations.ts (v0.46.x tranche 3): the issue-#160 extract_entities /
 * extraction_pending / extraction_review lane plus its cluster-local
 * resource-guard caps. Op consts stay module-private; `extractionOperations`
 * below lists them in EXACTLY the order they appear in the canonical
 * `operations` array in ../operations.ts. Never import from
 * '../operations.ts' here (cycle).
 */

import type { Operation } from './contract.ts';
import { opError, OperationError, type OperationContext } from './contract.ts';
import type { Action } from '../agent-output.ts';
import { hostOnlyError, paramUse, readFix } from './op-fix.ts';
import { sourceScopeOpts } from './context.ts';
import { randomUUID } from 'node:crypto';
import { unverifiedExtractionFragment, isUnverifiedExtraction, EXTRACTION_STATUS_KEY, STATUS_VERIFIED } from '../extraction-review.ts';
import { buildVisibilityClause } from '../search/sql-ranking.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { withoutBody } from '../page-body/page-shape.ts';
import type { Page } from '../types.ts';
import { submitPageMutation } from '../persistence/page-mutations.ts';
import { withPublicationGuard } from '../persistence/publication-guard.ts';

// ---------------------------------------------------------------------------
// Extraction quarantine lane (issue #160)
//
// `extractAndEnrich` regex-extracts entity names from arbitrary text and
// creates people/ + companies/ stub pages. These three ops are its ONLY
// sanctioned surface:
//   - extract_entities    — run extraction. Direct authoritative writes need
//                           BOTH the trusted local CLI (ctx.remote === false)
//                           AND the explicit --trusted-extraction flag;
//                           everything else lands in the quarantine lane
//                           (frontmatter provenance/status markers).
//   - extraction_pending  — list unverified stubs awaiting review.
//   - extraction_review   — promote (status → verified) or reject
//                           (soft-delete) in batch. Owner-only (fail-closed
//                           on ctx.remote): THIS surface never lets a remote
//                           caller flip the status markers. Scope note: the
//                           markers are ordinary frontmatter, so a caller who
//                           already holds generic remote put_page write scope
//                           can rewrite the page (markers included) — that
//                           caller could equally author an unmarked people/
//                           page directly, so the lane adds no privilege
//                           there; put_page authz is its own boundary.
// ---------------------------------------------------------------------------

// Resource guards for extract_entities (#160 hardening): bound the work a
// single remote write-scope call can trigger. ponytail: flat caps; make them
// config knobs only if a real workload hits them.
const MAX_EXTRACT_TEXT_CHARS = 200_000;
const MAX_EXTRACT_ENTITIES = 200;

const extract_entities: Operation = {
  name: 'extract_entities',
  idempotent: false,
  outputRedaction: 'retrieval',
  description: 'Extract entity names (people, companies) from text and create/update their brain stub pages. Stubs from untrusted input land in the quarantine lane (frontmatter `provenance: auto-extracted` + `status: unverified`) — excluded from authoritative retrieval boosts until reviewed. Direct authoritative writes require the trusted local CLI with trusted_extraction set.',
  params: {
    text: { type: 'string', required: true, description: 'The text to extract entities from (email, transcript, pasted content, …). Max 200k characters — split larger inputs.' },
    source_slug: { type: 'string', required: true, description: 'Slug of the source page the text came from (used for backlinks + timeline attribution).' },
    trusted_extraction: { type: 'boolean', required: false, description: 'Local CLI only: write stubs directly as authoritative pages, skipping the quarantine lane. Ignored (always quarantined) for remote callers.' },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    // Trust rule (#160, fail-closed like the CV6 provenance gate above):
    // `ctx.remote === false` is the ONLY truthy condition that can admit a
    // direct authoritative write, and even then the caller must opt in
    // explicitly. Remote/unset trust → quarantine lane, flag ignored.
    const trusted = ctx.remote === false && p.trusted_extraction === true;
    const text = p.text as string;
    // Resource guards: the greedy name regex on a huge paste can yield tens
    // of thousands of "entities", each costing several DB round-trips. Cap
    // input size loudly and entity count softly (surfaced as `truncated`).
    if (text.length > MAX_EXTRACT_TEXT_CHARS) {
      throw opError(
        'invalid_params',
        `extract_entities: text is ${text.length} chars (max ${MAX_EXTRACT_TEXT_CHARS}).`,
        `Nothing was written. Split the input into pieces of at most ${MAX_EXTRACT_TEXT_CHARS} characters and call extract_entities once per piece.`,
      );
    }
    if (ctx.dryRun) return { dry_run: true, action: 'extract_entities', trusted };
    const { extractEntities, enrichEntities } = await import('../enrichment-service.ts');
    const found = extractEntities(text);
    const capped = found.slice(0, MAX_EXTRACT_ENTITIES);
    const results = await enrichEntities(
      ctx.engine,
      capped.map((e) => ({ entityName: e.name, entityType: e.type, context: e.context, sourceSlug: p.source_slug as string })),
      {
        trusted,
        ...(ctx.sourceId ? { sourceId: ctx.sourceId } : {}),
        ctx,
        // Pure local DB writes — no external API call to pace, so the
        // system-load capacity gate would only stall the caller.
        throttle: false,
      },
    );
    return {
      status: 'ok',
      trusted,
      quarantined: results.filter((r) => r.quarantined === true).length,
      count: results.length,
      entities_found: found.length,
      truncated: found.length > capped.length,
      entities: results,
    };
  },
  cliHints: { name: 'extract-entities' },
};

const extraction_pending: Operation = {
  name: 'extraction_pending',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description: 'List what waits for review: unverified auto-extracted entity stubs (pending; promote or reject them with extraction_review), facts saved without an entity (unattributed; relink each with remember entity + replaces, never forget first), and, when include names it, recently created entity pages whose name is one edit or one acronym letter from another entity (possible_duplicates; flag only, never merged).',
  params: {
    limit: { type: 'number', required: false, description: 'Max rows per list (default 100 for pending, 50 for the others; cap 500).' },
    offset: { type: 'number', required: false, description: 'Pagination offset for pending.' },
    include: { type: 'array', items: { type: 'string' }, required: false, description: 'Lists to return: pending, unattributed, possible_duplicates. Default pending and unattributed.' },
    unattributed_offset: { type: 'number', required: false, description: 'Pagination offset for unattributed (its next_offset).' },
    possible_duplicates_cursor: { type: 'string', required: false, description: 'Continuation for possible_duplicates (its next_cursor).' },
    since_days: { type: 'number', required: false, description: 'possible_duplicates: entity pages created in the last N days (default 30).' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
    const include = parseInclude(p.include);
    const limit = Math.min(Math.max(Number(p.limit ?? 100) || 100, 1), 500);
    const offset = Math.max(Number(p.offset ?? 0) || 0, 0);
    // Read-side source isolation: route through sourceScopeOpts (federated
    // array > scalar > nothing), applied in SQL below.
    const scope = sourceScopeOpts(ctx);
    const params: unknown[] = [];
    let srcClause = '';
    if (scope.sourceIds && scope.sourceIds.length > 0) {
      params.push(scope.sourceIds);
      srcClause = `AND p.source_id = ANY($${params.length}::text[])`;
    } else if (scope.sourceId) {
      params.push(scope.sourceId);
      srcClause = `AND p.source_id = $${params.length}`;
    }
    params.push(limit, offset);
    const rows = await ctx.engine.executeRaw<{
      slug: string; title: string; type: string; source_id: string;
      extracted_from: string | null; created_at: string;
    }>(
      `SELECT p.slug, p.title, p.type, p.source_id,
              p.frontmatter ->> 'source' AS extracted_from,
              p.created_at::text AS created_at
       FROM pages p
       JOIN sources s ON s.id = p.source_id
       WHERE ${unverifiedExtractionFragment('p')}
         ${buildVisibilityClause('p', 's')}
         ${srcClause}
       ORDER BY p.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    const out: Record<string, unknown> = { count: rows.length, pending: include.has('pending') ? rows : [], include: [...include] };
    const lists = await import('../review-lists.ts');
    const listLimit = Math.min(Math.max(Number(p.limit ?? lists.UNATTRIBUTED_DEFAULT_LIMIT) || lists.UNATTRIBUTED_DEFAULT_LIMIT, 1), lists.REVIEW_LIST_MAX_LIMIT);
    const sourceIds = scope.sourceIds?.length ? scope.sourceIds : [scope.sourceId ?? ctx.sourceId ?? 'default'];
    if (include.has('unattributed')) {
      out.unattributed = await lists.listUnattributedFacts(ctx.engine, ctx, sourceIds,
        { limit: listLimit, offset: Math.max(Number(p.unattributed_offset ?? 0) || 0, 0) });
    }
    if (include.has('possible_duplicates')) {
      const { resolveExcludePrivatePages } = await import('../search/private-visibility.ts');
      out.possible_duplicates = await lists.listPossibleDuplicates(ctx.engine, ctx, sourceIds[0]!, {
        limit: listLimit, cursor: p.possible_duplicates_cursor,
        sinceDays: Math.max(Number(p.since_days ?? lists.POSSIBLE_DUPLICATES_DEFAULT_DAYS) || lists.POSSIBLE_DUPLICATES_DEFAULT_DAYS, 1),
        excludePrivate: await resolveExcludePrivatePages(ctx.engine, ctx.remote),
      });
    }
    return out;
  },
  cliHints: { name: 'extraction-pending' },
};

const PENDING_LISTS = ['pending', 'unattributed', 'possible_duplicates'] as const;

function parseInclude(raw: unknown): Set<string> {
  const given = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : null;
  if (!given) return new Set(['pending', 'unattributed']);
  const wanted = new Set(given.map(v => String(v).trim()).filter(Boolean));
  const unknown = [...wanted].filter(v => !(PENDING_LISTS as readonly string[]).includes(v));
  if (unknown.length) {
    throw opError('invalid_params', `extraction_pending: unknown include ${unknown.map(v => JSON.stringify(v)).join(', ')}.`,
      `Nothing was read. Pass include as any of ${PENDING_LISTS.join(', ')}.`);
  }
  return wanted;
}

const REVIEW_SLUG = /^[a-z0-9][a-z0-9/_.-]{0,254}$/i;

function pendingFix(): Action {
  return readFix('Lists the unverified auto-extracted stubs awaiting review, with their slugs.',
    { argv: ['gbrain', 'extraction-pending'], mcp: { tool: 'extraction_pending', arguments: {} } });
}

const REVIEW_ACTIONS = ['promote', 'reject', 'distinct'] as const;
type ReviewDecision = typeof REVIEW_ACTIONS[number];
const isReviewAction = (v: unknown): v is ReviewDecision => typeof v === 'string' && (REVIEW_ACTIONS as readonly string[]).includes(v);

function reviewOwnerOnly(ctx: OperationContext, p: Record<string, unknown>) {
  const message = 'extraction_review is owner-only: promote, reject and distinct decisions must come from the trusted local CLI.';
  const action = isReviewAction(p.action) ? p.action : undefined;
  const slugs = Array.isArray(p.slugs) ? p.slugs : [];
  const of = typeof p.of === 'string' && REVIEW_SLUG.test(p.of) ? p.of : undefined;
  const exact = action && slugs.length > 0 && slugs.every(s => typeof s === 'string' && REVIEW_SLUG.test(s)) && (action !== 'distinct' || of);
  return exact
    ? hostOnlyError(ctx, 'permission_denied', message, ['gbrain', 'extraction-review', action, '--slugs', slugs.join(','), ...(action === 'distinct' ? ['--of', of!] : [])],
      'The review decision is the quarantine trust gate, so only the brain owner\'s CLI may make it.',
      { consent: action === 'reject' ? ['destructive'] : [] })
    : hostOnlyError(ctx, 'permission_denied', message, ['gbrain', 'extraction-pending'],
      'The review decision is the quarantine trust gate; the owner reviews the pending stubs and decides on the host.');
}

const extraction_review: Operation = {
  name: 'extraction_review',
  idempotent: false,
  outputRedaction: 'no_stored_text',
  description: 'Decide on review rows (batch). promote flips an unverified auto-extracted stub\'s `status` to verified (provenance kept for audit); reject soft-deletes the stub; distinct records that each of slugs is a different entity from of (`distinct_from` frontmatter), so possible_duplicates stops pairing them. Every decision writes through the page door: Git first on a source with a repository, the database on a repo-less source. Owner-only: this op is refused for any non-local caller. (The markers are ordinary frontmatter — the boundary against rewriting them wholesale is put_page write authz, same as for any page.)',
  params: {
    action: { type: 'string', required: true, description: "'promote', 'reject' or 'distinct'." },
    slugs: { type: 'array', required: true, items: { type: 'string' }, description: 'Slugs to act on (batch).' },
    of: { type: 'string', required: false, description: "distinct only: the existing entity page each of slugs is not the same as." },
  },
  mutating: true,
  scope: 'write',
  localOnly: true, cliOnly: { argv: ['gbrain', 'extraction-review', '<action>', '--slugs', '<slugs>'] },
  handler: async (ctx, p) => {
    // The review decision IS the trust gate — if a remote caller could
    // promote, injected content could self-promote and the quarantine lane
    // would be decorative. Fail-closed: only strictly-local callers pass.
    if (ctx.remote !== false) {
      throw reviewOwnerOnly(ctx, p);
    }
    const action = p.action;
    if (!isReviewAction(action)) {
      throw opError('invalid_params', `extraction_review: action must be 'promote', 'reject' or 'distinct'; got '${String(action)}'.`,
        "Nothing changed. Pass 'promote', 'reject' or 'distinct' as the action; fix lists the rows awaiting review.", { fix: pendingFix() });
    }
    // CLI passes `--slugs a,b,c` as one string; MCP passes a real array.
    const slugs = Array.isArray(p.slugs)
      ? (p.slugs as string[])
      : typeof p.slugs === 'string'
        ? p.slugs.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
    if (slugs.length === 0) {
      throw opError('invalid_params', 'extraction_review: slugs must be a non-empty array.',
        `Nothing changed. Pass the stub slugs to act on, for example ${paramUse(ctx, 'slugs', ctx.remote === false ? 'slug1,slug2' : ['slug1', 'slug2'])}; fix lists the stubs awaiting review.`,
        { fix: pendingFix() });
    }
    const of = typeof p.of === 'string' ? p.of.trim() : '';
    if (action === 'distinct' && !REVIEW_SLUG.test(of)) {
      throw opError('invalid_params', 'extraction_review distinct needs of: the existing entity page the slugs are not the same as.',
        'Nothing changed. Pass of: the existing entity page the slugs are not the same as; the possible_duplicates rows of extraction_pending carry the exact command.',
        { fix: readFix('Lists recently created entity pages flagged as near names, each with its distinct command.',
          { argv: ['gbrain', 'extraction-pending', '--include', 'possible_duplicates'], mcp: { tool: 'extraction_pending', arguments: { include: ['possible_duplicates'] } } }) });
    }
    if (ctx.dryRun) return { dry_run: true, action: `extraction_review:${action}`, slugs, ...(action === 'distinct' ? { of } : {}) };
    const results: Array<{ slug: string; status: string }> = [];
    const writeRequests: Array<{ slug: string; request_id: unknown; state: unknown }> = [];
    for (const slug of slugs) {
      // First-match read is safe here: every write below keys on the RETURNED
      // row's page.source_id, so read and write can never target different
      // rows. gbrain-allow-unscoped-getpage: write follows the returned row
      const page = await ctx.engine.getPage(slug, ctx.sourceId ? { sourceId: ctx.sourceId } : undefined);
      if (!page) {
        results.push({ slug, status: 'not_found' });
        continue;
      }
      const decided = await reviewDecision(ctx, action, slug, page.source_id, of);
      results.push({ slug, status: decided.status });
      if (decided.response) writeRequests.push({ slug, request_id: decided.response.request_id, state: decided.response.state });
    }
    return { status: 'ok', action, results, ...(writeRequests.length ? { write_requests: writeRequests } : {}) };
  },
  cliHints: { name: 'extraction-review', positional: ['action'] },
};

/**
 * One review decision under the source's publication guard: re-read the page, re-check that the decision
 * still applies, and publish it through the page door with the revision it read (a page that moved in
 * between reports `changed`; run the command again).
 */
async function reviewDecision(ctx: OperationContext, action: ReviewDecision, slug: string, sourceId: string, of: string):
  Promise<{ status: string; response?: Record<string, unknown> }> {
  return withPublicationGuard(ctx.engine, sourceId, async () => {
    const snapshot = await ctx.engine.readPageSnapshot(slug, { sourceId });
    if (!snapshot || snapshot.page.deleted_at) return { status: 'not_found' };
    const fm = (snapshot.page.frontmatter ?? {}) as Record<string, unknown>;
    // Frontmatter-only decisions edit the page's head (serialized with an empty body, as edit_page lays it out), so
    // the body is never read or rewritten and a segmented page keeps its segments.
    const head = (frontmatter: Record<string, unknown>) =>
      serializePageToMarkdown({ ...withoutBody(snapshot.page), frontmatter, compiled_truth: '', timeline: '' } as Page, snapshot.tags).slice(0, -1);
    const editHead = (frontmatter: Record<string, unknown>) =>
      ({ operation: 'edit_page' as const, params: { slug, source_id: sourceId, edits: [{ old_text: head(fm), new_text: head(frontmatter) }] } });
    let mutation: { operation: 'edit_page' | 'delete_page'; params: Record<string, unknown> };
    let status: string;
    if (action === 'distinct') {
      if (of === slug) return { status: 'same_page' };
      const other = await ctx.engine.getPage(of, { sourceId });
      if (!other) return { status: 'of_not_found' };
      const prior = Array.isArray(fm.distinct_from) ? fm.distinct_from.filter((x): x is string => typeof x === 'string') : typeof fm.distinct_from === 'string' ? [fm.distinct_from] : [];
      if (prior.includes(of)) return { status: 'already_distinct' };
      mutation = editHead({ ...fm, distinct_from: [...prior, of] });
      status = 'distinct';
    } else if (!isUnverifiedExtraction(fm)) {
      return { status: 'not_unverified' };
    } else if (action === 'promote') {
      // provenance stays 'auto-extracted' as the audit trail of HOW the page came to exist; status → 'verified'
      // records the owner's call.
      mutation = editHead({ ...fm, [EXTRACTION_STATUS_KEY]: STATUS_VERIFIED });
      status = 'promoted';
    } else {
      mutation = { operation: 'delete_page', params: { slug, source_id: sourceId } };
      status = 'rejected';
    }
    try {
      const response = await submitPageMutation(ctx, { operation: mutation.operation,
        params: { ...mutation.params, expected_revision: snapshot.revision, request_id: randomUUID() } });
      return { status, response };
    } catch (error) {
      if (error instanceof OperationError && ['revision_conflict', 'changed_since_preview'].includes(error.code)) return { status: 'changed' };
      throw error;
    }
  });
}

export const extractionOperations: Operation[] = [
  extract_entities, extraction_pending, extraction_review,
];
