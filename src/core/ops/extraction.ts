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
import { OperationError } from './contract.ts';
import { sourceScopeOpts } from './context.ts';
import { unverifiedExtractionFragment, isUnverifiedExtraction, EXTRACTION_STATUS_KEY, STATUS_VERIFIED } from '../extraction-review.ts';
import { buildVisibilityClause } from '../search/sql-ranking.ts';

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
  description: 'Extract entity names (people, companies) from text and create/update their brain stub pages. Stubs from untrusted input land in the quarantine lane (frontmatter `provenance: auto-extracted` + `status: unverified`) — excluded from authoritative retrieval boosts until reviewed. Direct authoritative writes require the trusted local CLI AND --trusted-extraction.',
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
      throw new OperationError(
        'invalid_params',
        `extract_entities: text is ${text.length} chars (max ${MAX_EXTRACT_TEXT_CHARS}).`,
        'Split the input and call extract_entities per section.',
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
  description: 'List unverified auto-extracted entity stubs awaiting owner review (the quarantine lane from extract_entities). Promote or reject them with extraction_review.',
  params: {
    limit: { type: 'number', required: false, description: 'Max rows (default 100, cap 500).' },
    offset: { type: 'number', required: false, description: 'Pagination offset.' },
  },
  scope: 'read',
  handler: async (ctx, p) => {
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
    return { count: rows.length, pending: rows };
  },
  cliHints: { name: 'extraction-pending' },
};

const extraction_review: Operation = {
  name: 'extraction_review',
  description: 'Promote or reject unverified auto-extracted entity stubs (batch). Promote flips `status` to verified (provenance kept for audit); reject soft-deletes the stub. Owner-only: this op is refused for any non-local caller. (The markers are ordinary frontmatter — the boundary against rewriting them wholesale is put_page write authz, same as for any page.)',
  params: {
    action: { type: 'string', required: true, description: "'promote' or 'reject'." },
    slugs: { type: 'array', required: true, items: { type: 'string' }, description: 'Stub slugs to act on (batch).' },
  },
  mutating: true,
  scope: 'write',
  localOnly: true,
  handler: async (ctx, p) => {
    // The review decision IS the trust gate — if a remote caller could
    // promote, injected content could self-promote and the quarantine lane
    // would be decorative. Fail-closed: only strictly-local callers pass.
    if (ctx.remote !== false) {
      throw new OperationError(
        'permission_denied',
        'extraction_review is owner-only: promote/reject decisions must come from the trusted local CLI.',
        'Run `gbrain extraction-review <promote|reject> --slugs ...` on the host machine.',
      );
    }
    const action = p.action as string;
    if (action !== 'promote' && action !== 'reject') {
      throw new OperationError('invalid_params', `extraction_review: action must be 'promote' or 'reject'; got '${action}'.`);
    }
    // CLI passes `--slugs a,b,c` as one string; MCP passes a real array.
    const slugs = Array.isArray(p.slugs)
      ? (p.slugs as string[])
      : typeof p.slugs === 'string'
        ? p.slugs.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
    if (slugs.length === 0) {
      throw new OperationError('invalid_params', 'extraction_review: slugs must be a non-empty array (CLI: --slugs slug1,slug2).');
    }
    if (ctx.dryRun) return { dry_run: true, action: `extraction_review:${action}`, slugs };
    const results: Array<{ slug: string; status: string }> = [];
    for (const slug of slugs) {
      // First-match read is safe here: BOTH writes below key on the RETURNED
      // row's page.source_id, so read and write can never target different
      // rows. gbrain-allow-unscoped-getpage: write follows the returned row
      const page = await ctx.engine.getPage(slug, ctx.sourceId ? { sourceId: ctx.sourceId } : undefined);
      if (!page) {
        results.push({ slug, status: 'not_found' });
        continue;
      }
      if (!isUnverifiedExtraction(page.frontmatter)) {
        results.push({ slug, status: 'not_unverified' });
        continue;
      }
      if (action === 'promote') {
        // Frontmatter-only flip via a targeted JSONB merge — NOT putPage,
        // whose upsert would reset non-carried columns (page_kind →
        // 'markdown', content_hash, …) for a change that only touches one
        // frontmatter key. provenance stays 'auto-extracted' as the audit
        // trail of HOW the page came to exist; status → 'verified' records
        // the owner's call. jsonb_build_object binds as text (no
        // JSON.stringify-into-::jsonb hazard); identical on both engines.
        await ctx.engine.executeRaw(
          `UPDATE pages
           SET frontmatter = COALESCE(frontmatter, '{}'::jsonb) || jsonb_build_object($1::text, $2::text),
               updated_at = now()
           WHERE slug = $3 AND source_id = $4`,
          [EXTRACTION_STATUS_KEY, STATUS_VERIFIED, slug, page.source_id],
        );
        results.push({ slug, status: 'promoted' });
      } else {
        await ctx.engine.softDeletePage(slug, { sourceId: page.source_id });
        results.push({ slug, status: 'rejected' });
      }
    }
    return { status: 'ok', action, results };
  },
  cliHints: { name: 'extraction-review', positional: ['action'] },
};

export const extractionOperations: Operation[] = [
  extract_entities, extraction_pending, extraction_review,
];
