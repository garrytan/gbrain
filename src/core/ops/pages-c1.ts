/**
 * C1 canonical page mutation operations.
 *
 * Kept separate from the legacy page CRUD cluster so the containment slice
 * has one reviewable boundary and pages.ts stays within the module-size gate.
 */

import { isDeepStrictEqual } from 'node:util';
import type { BrainEngine } from '../engine.ts';
import { loadConfig } from '../config.ts';
import { importFromContent } from '../import-file.ts';
import { parseMarkdown } from '../markdown.ts';
import { loadActivePack } from '../schema-pack/load-active.ts';
import { withPageLock } from '../page-lock.ts';
import { deletePageThrough, resolvePageWriteTarget, writePageThrough } from '../write-through.ts';
import {
  applySparsePagePatch,
  canonicalMutationReceiptId,
  CanonicalMutationError,
  commitCanonicalMutation,
  commitCanonicalMutationV2,
  exactCanonicalRevision,
  type SparsePagePatch,
} from '../canonical-page-mutations.ts';
import { applyCanonicalInteractionEvent, validateCanonicalInteractionEvent } from '../canonical-page-events.ts';
import { OperationError } from './contract.ts';
import type { Operation, OperationContext } from './contract.ts';
import {
  enforceClientSlugFence,
  enforceSubagentSlugFence,
  parseSourceIdParam,
  validatePageSlug,
} from './context.ts';

type ActivePack = { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string> }> };

const C1_UNSUPPORTED_CREATE_TYPES = new Set([
  'concept', 'media', 'tweet', 'social-digest', 'analysis', 'atom',
  'source', 'deal', 'email', 'slack', 'writing', 'event',
]);

function enabledConfigValue(value: string | null): boolean {
  if (value == null) return false;
  return ['1', 'true', 'on', 'yes'].includes(value.trim().toLowerCase());
}

function assertPlainObjectParam(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (value === undefined) return;
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new OperationError('invalid_params', `${name} must be a JSON object.`);
  }
}

function assertStringArrayParam(value: unknown, name: string): asserts value is string[] {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new OperationError('invalid_params', `${name} must be a JSON array of strings.`);
  }
}

export async function isC1ContainmentEnabled(engine: BrainEngine): Promise<boolean> {
  try {
    return enabledConfigValue(await engine.getConfig('writer.c1_containment'));
  } catch {
    // A failed config read must not silently turn an unactivated breaking
    // policy on. Activation is explicit and separately reviewed.
    return false;
  }
}

export async function isC1RevisionGuardEnabled(engine: BrainEngine): Promise<boolean> {
  try {
    return enabledConfigValue(await engine.getConfig('writer.c1_revision_guard'));
  } catch {
    return false;
  }
}

async function isAppendPageEventEnabled(engine: BrainEngine): Promise<boolean> {
  try {
    return enabledConfigValue(await engine.getConfig('writer.append_page_event'));
  } catch {
    return false;
  }
}

function canonicalMutationPrincipal(ctx: OperationContext): string {
  if (ctx.viaSubagent === true) {
    if (Number.isInteger(ctx.subagentId) && (ctx.subagentId ?? 0) > 0) return `subagent:${ctx.subagentId}`;
    throw new OperationError(
      'authority_required',
      'append_page_event requires a server-issued subagent identity.',
      'Retry through a correctly attributed subagent job.',
    );
  }
  if (ctx.auth?.clientId) return `oauth:${ctx.auth.clientId}`;
  if (ctx.remote === false) return 'local-owner';
  if (ctx.transport === 'stdio') return 'stdio-local';
  throw new OperationError(
    'unknown_transport',
    'append_page_event requires an authenticated or server-attributed caller identity.',
    'Use OAuth, the local owner CLI, or local stdio MCP.',
  );
}

function assertSourceInWriteGrant(ctx: OperationContext, sourceId: string): void {
  if (ctx.remote === false) return;
  const writeAuthority = ctx.auth?.sourceId ?? ctx.sourceId;
  if (sourceId === writeAuthority) return;
  throw new OperationError(
    'permission_denied',
    `source '${sourceId}' is outside your write authority`,
    'Federated read grants do not confer write authority.',
  );
}

/** Serialize DB deletion and canonical unlink with every other page writer. */
export async function deletePageOperationHandler(ctx: OperationContext, p: Record<string, unknown>): Promise<unknown> {
  const slug = p.slug as string;
  enforceClientSlugFence(ctx, slug, 'delete_page');
  const requestedSource = parseSourceIdParam(p.source_id, 'delete_page');
  if (requestedSource !== undefined) assertSourceInWriteGrant(ctx, requestedSource);
  if (ctx.dryRun) return { dry_run: true, action: 'soft_delete_page', slug };
  const sourceId = requestedSource ?? ctx.sourceId ?? 'default';
  const sourceOpts = { sourceId };
  const sandbox = ctx.viaSubagent === true
    && !(Array.isArray(ctx.allowedSlugPrefixes) && ctx.allowedSlugPrefixes.length > 0);
  try {
    return await withPageLock(slug, async () => {
      const target = sandbox ? undefined : await resolvePageWriteTarget(ctx.engine, slug, sourceId);
      const result = await ctx.engine.softDeletePage(slug, sourceOpts);
      if (result === null) {
        const existing = await ctx.engine.getPage(slug, { includeDeleted: true, ...sourceOpts });
        if (!existing) throw new OperationError('page_not_found', `Page not found: ${slug}`, 'Check the slug and source_id.');
        return { status: 'already_soft_deleted', slug, source_id: sourceId, deleted_at: existing.deleted_at };
      }
      const writeThrough = sandbox
        ? { removed: false, skipped: 'subagent_sandbox' as const }
        : await deletePageThrough(ctx.engine, slug, { sourceId, logger: ctx.logger, target, lockAlreadyHeld: true });
      return { status: 'soft_deleted', slug, source_id: sourceId, recoverable_until: 'now + 72h via restore_page', write_through: writeThrough };
    }, { sourceId });
  } catch (error) {
    if (error instanceof OperationError) throw error;
    throw new OperationError('unavailable', `Could not acquire the canonical page lock for '${slug}'.`, 'Retry after the current writer completes.');
  }
}

/** Serialize DB restore and canonical re-materialization with page patches. */
export async function restorePageOperationHandler(ctx: OperationContext, p: Record<string, unknown>): Promise<unknown> {
  const slug = p.slug as string;
  enforceClientSlugFence(ctx, slug, 'restore_page');
  const requestedSource = parseSourceIdParam(p.source_id, 'restore_page');
  if (requestedSource !== undefined) assertSourceInWriteGrant(ctx, requestedSource);
  if (ctx.dryRun) return { dry_run: true, action: 'restore_page', slug };
  const sourceId = requestedSource ?? ctx.sourceId ?? 'default';
  const sandbox = ctx.viaSubagent === true
    && !(Array.isArray(ctx.allowedSlugPrefixes) && ctx.allowedSlugPrefixes.length > 0);
  try {
    return await withPageLock(slug, async () => {
      const ok = await ctx.engine.restorePage(slug, { sourceId });
      if (!ok) {
        const existing = await ctx.engine.getPage(slug, { includeDeleted: true, sourceId });
        if (!existing) throw new OperationError('page_not_found', `Page not found: ${slug}`, 'Check the slug and source_id.');
        return { status: 'already_active', slug, source_id: sourceId };
      }
      const writeThrough = sandbox
        ? { written: false, skipped: 'subagent_sandbox' as const }
        : await writePageThrough(ctx.engine, slug, { sourceId, logger: ctx.logger, lockAlreadyHeld: true });
      return { status: 'restored', slug, source_id: sourceId, write_through: writeThrough };
    }, { sourceId });
  } catch (error) {
    if (error instanceof OperationError) throw error;
    throw new OperationError('unavailable', `Could not acquire the canonical page lock for '${slug}'.`, 'Retry after the current writer completes.');
  }
}

async function assertProjectedPageMatchesCanonical(
  engine: BrainEngine,
  sourceId: string,
  slug: string,
  content: string,
): Promise<void> {
  if (!await projectedPageMatchesCanonical(engine, sourceId, slug, content)) {
    throw new Error(`projection content mismatch for canonical revision ${exactCanonicalRevision(content)}`);
  }
}

async function projectedPageMatchesCanonical(
  engine: BrainEngine,
  sourceId: string,
  slug: string,
  content: string,
  requiredChunkFragment?: string,
): Promise<boolean> {
  const projected = await engine.getPage(slug, { sourceId });
  if (!projected) return false;
  const parsed = parseMarkdown(content, `${slug}.md`);
  const projectedTags = new Set(await engine.getTags(slug, { sourceId }));
  const normalize = (value: unknown) => JSON.parse(JSON.stringify(value));
  const expectedProjection = normalize({
    type: parsed.type,
    title: parsed.title,
    compiled_truth: parsed.compiled_truth,
    timeline: parsed.timeline,
    frontmatter: parsed.frontmatter,
  });
  const actualProjection = normalize({
    type: projected.type,
    title: projected.title,
    compiled_truth: projected.compiled_truth,
    timeline: projected.timeline,
    frontmatter: projected.frontmatter,
  });
  const chunksContainRequiredEvent = requiredChunkFragment === undefined
    || (await engine.getChunks(slug, { sourceId })).some((chunk) => chunk.chunk_text.includes(requiredChunkFragment));
  return isDeepStrictEqual(actualProjection, expectedProjection)
    && parsed.tags.every((tag) => projectedTags.has(tag))
    && chunksContainRequiredEvent;
}

export function assertC1CreateAdmissible(
  content: string,
  slug: string,
  activePack?: ActivePack,
): void {
  const candidate = parseMarkdown(content, `${slug}.md`, {
    validate: true,
    expectedSlug: slug,
    ...(activePack ? { activePack } : {}),
  });
  if ((candidate.errors ?? []).length > 0) {
    throw new OperationError(
      'invalid_params',
      `C1 containment rejected invalid canonical Markdown: ${(candidate.errors ?? []).map((e) => e.code).join(', ')}.`,
      'Fix the Markdown/frontmatter before retrying. No canonical page was written.',
    );
  }
  const normalizedType = String(candidate.type).trim().toLowerCase();
  if (C1_UNSUPPORTED_CREATE_TYPES.has(normalizedType)) {
    throw new OperationError(
      'unsupported_type',
      `C1 containment keeps type '${candidate.type}' read-compatible but does not authorize new canonical creates.`,
      'Route this item to report-only review; do not infer or auto-remap a replacement type.',
    );
  }

  // D4 assigns tenant, authenticated writer, policy-version, canonical-hash,
  // and receipt construction to a trusted server-side authority boundary.
  // OperationContext does not carry that authority envelope yet. Frontmatter
  // is caller-owned input, so accepting tenant_id/privacy/lineage keys merely
  // because they are present would let the caller self-attest the very fields
  // the boundary is supposed to guarantee. Until that ingress exists, C1's
  // only honest fail-closed behaviour is to reject every new authoritative
  // page. Existing pages remain revision-patchable through patch_page.
  throw new OperationError(
    'authority_required',
    `C1 containment cannot admit new authoritative page '${slug}' without a trusted server-issued authority envelope.`,
    'Keep the input in its source/raw lane or submit it for review. Do not copy authority metadata into frontmatter to bypass this gate.',
  );
}

/** Safely patch an existing canonical page using exact-byte CAS semantics. */
export const patchPageOperation: Operation = {
  name: 'patch_page',
  description: 'Safely patch an existing canonical page. Requires base_revision from get_page. Omitted fields are preserved; frontmatter_unset is the only deletion mechanism. Arrays and objects are atomic values. Canonical Markdown is written first; a derived-index failure returns projection_state=pending and is resumable.',
  params: {
    slug: { type: 'string', required: true, description: 'Existing page slug.' },
    source_id: { type: 'string', required: false, description: 'Source that supplied the canonical_revision. Remote callers may target only their write source.' },
    base_revision: { type: 'string', required: true, description: 'Exact canonical_revision returned by get_page.' },
    frontmatter_set: { type: 'object', required: false, description: 'Top-level frontmatter keys to set. Nested objects and arrays replace atomically.' },
    frontmatter_unset: { type: 'array', required: false, items: { type: 'string' }, description: 'Top-level frontmatter keys to remove explicitly.' },
    frontmatter_set_if_empty: { type: 'object', required: false, description: 'Set a key only when absent, null, or a blank string.' },
  },
  mutating: true,
  scope: 'write',
  handler: async (ctx, p) => {
    const slug = p.slug as string;
    validatePageSlug(slug);
    enforceSubagentSlugFence(ctx, slug, 'patch_page');
    enforceClientSlugFence(ctx, slug, 'patch_page');
    const baseRevision = typeof p.base_revision === 'string' ? p.base_revision : '';
    if (!/^sha256:[0-9a-f]{64}$/.test(baseRevision)) {
      throw new OperationError('invalid_params', 'patch_page requires a valid sha256 canonical base_revision.', 'Read the page with get_page and pass its canonical_revision unchanged.');
    }
    if (ctx.dryRun) return { dry_run: true, action: 'patch_page', slug, base_revision: baseRevision };

    const requestedSource = parseSourceIdParam(p.source_id, 'patch_page');
    const sourceId = requestedSource ?? ctx.sourceId ?? 'default';
    if (ctx.remote !== false) {
      const writeAuthority = ctx.auth?.sourceId ?? ctx.sourceId;
      if (sourceId !== writeAuthority) {
        throw new OperationError(
          'permission_denied',
          `source '${sourceId}' is outside your write authority`,
          'Pass the source_id returned by get_page only when it is also your write source. Federated read grants do not confer write authority.',
        );
      }
    }
    assertPlainObjectParam(p.frontmatter_set, 'frontmatter_set');
    assertStringArrayParam(p.frontmatter_unset, 'frontmatter_unset');
    assertPlainObjectParam(p.frontmatter_set_if_empty, 'frontmatter_set_if_empty');
    const existing = await ctx.engine.getPage(slug, { sourceId });
    if (!existing) throw new OperationError('page_not_found', `Page not found: ${slug}`, 'patch_page updates existing pages only.');
    let packDerivedFields: Set<string>;
    try {
      const sourcePack = await ctx.engine.getConfig(`schema_pack.source.${sourceId}`);
      const brainPack = await ctx.engine.getConfig('schema_pack');
      const activePack = await loadActivePack({
        cfg: loadConfig(),
        remote: ctx.remote !== false,
        sourceId,
        ...(sourcePack ? { perSourceDb: new Map([[sourceId, sourcePack]]) } : {}),
        ...(brainPack ? { dbConfig: brainPack } : {}),
      });
      packDerivedFields = new Set(
        activePack.manifest.frontmatter_links
          .filter((rule) => rule.page_type === existing.type)
          .flatMap((rule) => rule.fields),
      );
    } catch {
      throw new OperationError(
        'unavailable',
        'patch_page could not load the active schema pack needed to protect derived graph fields.',
        'Restore schema-pack availability, then retry the same revision-bound patch.',
      );
    }

    const patch: SparsePagePatch = {
      ...(p.frontmatter_set !== undefined ? { frontmatter_set: p.frontmatter_set as Record<string, unknown> } : {}),
      ...(p.frontmatter_unset !== undefined ? { frontmatter_unset: p.frontmatter_unset as string[] } : {}),
      ...(p.frontmatter_set_if_empty !== undefined ? { frontmatter_set_if_empty: p.frontmatter_set_if_empty as Record<string, unknown> } : {}),
    };

    try {
      const mutation = await commitCanonicalMutation({
        engine: ctx.engine,
        slug,
        sourceId,
        operation: 'patch_page',
        baseRevision,
        buildContent: (current) => {
          if (!current.exists || current.content === null) {
            throw new CanonicalMutationError('canonical_unavailable', `Canonical Markdown is missing for ${sourceId}/${slug}.`);
          }
          return applySparsePagePatch(current.content, slug, patch, packDerivedFields);
        },
        project: async (content) => {
          const parsed = parseMarkdown(content, `${slug}.md`, {
            validate: true,
            expectedSlug: slug,
          });
          if ((parsed.errors ?? []).length > 0) throw new Error('accepted canonical page no longer validates');
          const projected = await ctx.engine.transaction(async (tx) => {
            await tx.createVersion(slug, { sourceId });
            return tx.putPage(slug, {
              type: parsed.type,
              title: parsed.title,
              compiled_truth: parsed.compiled_truth,
              timeline: parsed.timeline,
              frontmatter: parsed.frontmatter,
              tags: parsed.tags,
            }, { sourceId });
          });
          await assertProjectedPageMatchesCanonical(ctx.engine, sourceId, slug, content);
          return projected;
        },
      });

      if (mutation.projection_state === 'pending') {
        return {
          slug,
          status: 'canonical_written',
          canonical_revision: mutation.canonical_revision,
          projected_revision: null,
          projection_state: 'pending',
          projection_error: mutation.projection_error,
          retryable: true,
        };
      }
      return {
        slug,
        status: 'patched',
        canonical_revision: mutation.canonical_revision,
        projected_revision: mutation.projected_revision,
        projection_state: 'current',
        resumed: mutation.resumed,
      };
    } catch (error) {
      if (error instanceof CanonicalMutationError) {
        const code = error.code === 'revision_conflict' ? 'revision_conflict'
          : error.code === 'revision_required' ? 'revision_required'
          : error.code === 'canonical_unavailable' ? 'unavailable'
          : 'invalid_params';
        throw new OperationError(code, error.message, code === 'revision_conflict' ? 'Read the current page and retry against its new canonical_revision.' : undefined);
      }
      throw error;
    }
  },
  cliHints: { name: 'patch-page', positional: ['slug'] },
};

/** Append one typed interaction to an existing canonical page exactly once. */
export const appendPageEventOperation: Operation = {
  name: 'append_page_event',
  description: 'Append one typed interaction to an existing canonical page. The server derives caller identity and event marker, binds a caller-stable idempotency key to the full request, writes Markdown first, and returns an immutable receipt. Historical events are placed by date and never regress last-contact metadata.',
  params: {
    slug: { type: 'string', required: true, description: 'Existing canonical page slug.' },
    source_id: { type: 'string', required: false, description: 'Write-authorized source containing the page.' },
    idempotency_key: { type: 'string', required: true, description: 'Stable upstream event identity, namespaced by provider and target slug.' },
    date: { type: 'string', required: true, description: 'Interaction date as YYYY-MM-DD.' },
    channel: { type: 'string', required: true, description: 'Short interaction channel label.' },
    note: { type: 'string', required: true, description: 'Single-line plain-text interaction summary.' },
  },
  mutating: true,
  scope: 'write',
  publishGateKey: 'writer.append_page_event',
  handler: async (ctx, p) => {
    const slug = p.slug as string;
    validatePageSlug(slug);
    enforceSubagentSlugFence(ctx, slug, 'append_page_event');
    enforceClientSlugFence(ctx, slug, 'append_page_event');
    const requestedSource = parseSourceIdParam(p.source_id, 'append_page_event');
    const sourceId = requestedSource ?? ctx.sourceId ?? 'default';
    assertSourceInWriteGrant(ctx, sourceId);
    const principalId = canonicalMutationPrincipal(ctx);
    const rawIdempotencyKey = p.idempotency_key;
    if (typeof rawIdempotencyKey !== 'string'
      || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(rawIdempotencyKey)) {
      throw new OperationError('invalid_params', 'append_page_event requires a single-line idempotency_key of 1 to 512 characters.');
    }
    const idempotencyKey = rawIdempotencyKey.trim();
    if (idempotencyKey.length < 1 || idempotencyKey.length > 512) {
      throw new OperationError('invalid_params', 'append_page_event requires a single-line idempotency_key of 1 to 512 characters.');
    }
    const semanticRequest = { date: p.date, channel: p.channel, note: p.note };
    const eventToken = canonicalMutationReceiptId(principalId, sourceId, idempotencyKey);
    try {
      validateCanonicalInteractionEvent({
        date: p.date as string,
        channel: p.channel as string,
        note: p.note as string,
        eventToken,
      });
    } catch (error) {
      if (error instanceof CanonicalMutationError) throw new OperationError('invalid_params', error.message);
      throw error;
    }
    if (!await isAppendPageEventEnabled(ctx.engine)) {
      throw new OperationError(
        'unavailable',
        'append_page_event is installed but not activated for this brain.',
        'Keep the writer on its reviewed source-only adapter until the append-event conformance gate is approved.',
      );
    }
    if (ctx.dryRun) {
      return { dry_run: true, action: 'append_page_event', slug, source_id: sourceId };
    }
    try {
      const mutation = await commitCanonicalMutationV2({
        engine: ctx.engine,
        principalId,
        slug,
        sourceId,
        operation: 'append_page_event',
        idempotencyKey,
        semanticRequest,
        baseRevision: 'latest',
        assertNewRequest: async () => {
          const existing = await ctx.engine.getPage(slug, { sourceId });
          if (!existing) {
            throw new OperationError('page_not_found', `Page not found: ${slug}`, 'append_page_event updates existing pages only.');
          }
        },
        buildContent: (current) => {
          if (!current.exists || current.content === null) {
            throw new CanonicalMutationError('canonical_unavailable', `Canonical Markdown is missing for ${sourceId}/${slug}.`);
          }
          return applyCanonicalInteractionEvent(current.content, slug, {
            date: p.date as string,
            channel: p.channel as string,
            note: p.note as string,
            eventToken,
          });
        },
        project: async (content) => {
          const parsed = parseMarkdown(content, `${slug}.md`, { validate: true, expectedSlug: slug });
          if ((parsed.errors ?? []).length > 0) throw new Error('accepted canonical interaction no longer validates');
          // Reuse the canonical importer so the page row, version, add-only
          // tags, and content chunks advance atomically. noEmbed avoids an
          // external call inside the receipt path; the normal stale-embedding
          // machinery can fill null embeddings later.
          await importFromContent(ctx.engine, slug, content, {
            sourceId,
            noEmbed: true,
            forceRechunk: true,
          });
        },
        verifyProjection: async (content) => projectedPageMatchesCanonical(ctx.engine, sourceId, slug, content, eventToken),
      });
      if (mutation.outcome === 'pending') {
        return {
          slug,
          status: 'canonical_written',
          canonical_revision: mutation.canonical_revision,
          projected_revision: null,
          projection_state: 'pending',
          projection_error: mutation.projection_error,
          retryable: mutation.retryable,
        };
      }
      return {
        slug,
        status: mutation.outcome === 'replayed' ? 'replayed' : 'appended',
        projection_state: 'current',
        receipt: mutation.receipt,
      };
    } catch (error) {
      if (error instanceof CanonicalMutationError) {
        const code = error.code === 'idempotency_conflict' ? 'idempotency_conflict'
          : error.code === 'revision_conflict' ? 'revision_conflict'
          : error.code === 'canonical_unavailable' ? 'unavailable'
          : 'invalid_params';
        throw new OperationError(code, error.message);
      }
      throw error;
    }
  },
  cliHints: { name: 'append-page-event', positional: ['slug', 'date', 'channel', 'note'] },
};
