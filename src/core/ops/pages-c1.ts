/**
 * C1 canonical page mutation operations.
 *
 * Kept separate from the legacy page CRUD cluster so the containment slice
 * has one reviewable boundary and pages.ts stays within the module-size gate.
 */

import { isDeepStrictEqual } from 'node:util';
import type { BrainEngine } from '../engine.ts';
import { loadConfig } from '../config.ts';
import { parseMarkdown } from '../markdown.ts';
import { loadActivePack } from '../schema-pack/load-active.ts';
import { withPageLock } from '../page-lock.ts';
import { deletePageThrough, resolvePageWriteTarget, writePageThrough } from '../write-through.ts';
import {
  applySparsePagePatch,
  CanonicalMutationError,
  commitCanonicalMutation,
  exactCanonicalRevision,
  type SparsePagePatch,
} from '../canonical-page-mutations.ts';
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
  const projected = await engine.getPage(slug, { sourceId });
  if (!projected) throw new Error('projection row missing after import');
  const parsed = parseMarkdown(content, `${slug}.md`);
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
  if (!isDeepStrictEqual(actualProjection, expectedProjection)) {
    throw new Error(`projection content mismatch for canonical revision ${exactCanonicalRevision(content)}`);
  }
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
