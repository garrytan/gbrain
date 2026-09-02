/**
 * Canonical-first page mutation primitives.
 *
 * Markdown is the authority. A mutation is serialized by (source_id, slug),
 * compare-and-swaps exact canonical bytes, fsyncs a durable intent, atomically
 * installs the new Markdown, and only then projects that exact byte string into
 * the database/search plane. Projection failure never rolls canonical bytes
 * back; the retained journal entry is the deterministic recovery input.
 *
 * The journal is host-filesystem durable. This first C1 slice deliberately
 * makes no distributed/multi-host CAS claim.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BrainEngine } from './engine.ts';
import { atomicWriteFileSync } from './atomic-write.ts';
import { gbrainPath } from './config.ts';
import { frontmatterBodyOffset, parseMarkdown, serializeMarkdown } from './markdown.ts';
import { withPageLock } from './page-lock.ts';
import { resolvePageWriteTarget, type PageWriteTarget } from './write-through.ts';

export type ProjectionState = 'current' | 'pending';

export interface CanonicalPageSnapshot {
  sourceId: string;
  slug: string;
  target: Extract<PageWriteTarget, { ok: true }>;
  exists: boolean;
  content: string | null;
  revision: string | null;
}

export interface SparsePagePatch {
  title?: string;
  type?: string;
  compiled_truth?: string;
  timeline?: string;
  tags?: string[];
  frontmatter_set?: Record<string, unknown>;
  frontmatter_unset?: string[];
  frontmatter_set_if_empty?: Record<string, unknown>;
}

export interface CanonicalMutationIntent {
  version: 1;
  source_id: string;
  slug: string;
  operation: 'patch_page' | 'put_page';
  idempotency_key: string;
  base_revision: string | null;
  intended_revision: string;
  operation_hash: string;
  state: 'prepared' | 'canonical_written' | 'index_pending' | 'projected';
  created_at: string;
  updated_at: string;
  projection_error?: string;
}

export interface CanonicalMutationResult<T> {
  value?: T;
  canonical_revision: string;
  projected_revision: string | null;
  projection_state: ProjectionState;
  journal_path: string;
  resumed: boolean;
  projection_error?: string;
}

export class CanonicalMutationError extends Error {
  constructor(
    public code: 'canonical_unavailable' | 'revision_required' | 'revision_conflict' | 'invalid_patch' | 'invalid_canonical',
    message: string,
  ) {
    super(message);
    this.name = 'CanonicalMutationError';
  }
}

const RESERVED_FRONTMATTER_KEYS = new Set([
  'type', 'title', 'tags', 'slug', 'canonical_revision',
  // Server/gate-owned metadata must use its dedicated authority path. A
  // caller-supplied sparse patch cannot mint, clear, or rewrite these.
  'quarantine', 'content_flag', 'embed_skip',
  'ingested_at', 'ingested_via', 'source_kind', 'source_uri',
  // These fields drive separate date or graph projections. The first C1
  // slice is metadata-only; dedicated operations must update them together
  // with their derived state.
  'date', 'event_date', 'published',
  'company', 'companies', 'founded', 'key_people', 'partner', 'investors',
  'lead', 'attendees', 'sources', 'source', 'related', 'see_also',
]);
const PROTOTYPE_POLLUTION_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const IMMUTABLE_IDENTITY_KEYS = new Set([
  'id', 'tenant_id', 'source_id', 'source_native_id', 'provider_namespace', 'immutable_identity',
]);

export function exactCanonicalRevision(content: string): string {
  return `sha256:${createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function nonEmpty(value: unknown): boolean {
  return value !== undefined && value !== null && !(typeof value === 'string' && value.trim() === '');
}

function assertPatchKeys(
  patch: SparsePagePatch,
  currentFrontmatter: Record<string, unknown>,
  additionalReservedKeys: ReadonlySet<string> = new Set(),
): void {
  const sets = Object.keys(patch.frontmatter_set ?? {});
  const setIfEmpty = Object.keys(patch.frontmatter_set_if_empty ?? {});
  const unsets = patch.frontmatter_unset ?? [];
  const all = [...sets, ...setIfEmpty, ...unsets];
  if (all.some((key) => !key || key.includes('\0'))) {
    throw new CanonicalMutationError('invalid_patch', 'Frontmatter patch keys must be non-empty and contain no NUL bytes.');
  }
  const reserved = all.find((key) => RESERVED_FRONTMATTER_KEYS.has(key) || additionalReservedKeys.has(key));
  if (reserved) {
    throw new CanonicalMutationError('invalid_patch', `Frontmatter key '${reserved}' has a dedicated patch field and cannot be patched through frontmatter.`);
  }
  const dangerous = all.find((key) => PROTOTYPE_POLLUTION_KEYS.has(key));
  if (dangerous) {
    throw new CanonicalMutationError('invalid_patch', `Unsafe frontmatter key '${dangerous}' is not allowed.`);
  }
  const setKeys = new Set(sets);
  const ifEmptyKeys = new Set(setIfEmpty);
  const overlap = unsets.find((key) => setKeys.has(key) || ifEmptyKeys.has(key))
    ?? sets.find((key) => ifEmptyKeys.has(key));
  if (overlap) {
    throw new CanonicalMutationError('invalid_patch', `Frontmatter key '${overlap}' appears in more than one patch operation.`);
  }
  const immutableUnset = unsets.find((key) => IMMUTABLE_IDENTITY_KEYS.has(key));
  if (immutableUnset) {
    throw new CanonicalMutationError('invalid_patch', `Immutable identity key '${immutableUnset}' cannot be removed.`);
  }
  for (const key of [...sets, ...setIfEmpty]) {
    if (!IMMUTABLE_IDENTITY_KEYS.has(key) || !nonEmpty(currentFrontmatter[key])) continue;
    const next = (patch.frontmatter_set ?? {})[key] ?? (patch.frontmatter_set_if_empty ?? {})[key];
    if (stableJson(next) !== stableJson(currentFrontmatter[key])) {
      throw new CanonicalMutationError('invalid_patch', `Immutable identity key '${key}' cannot be changed.`);
    }
  }
}

/**
 * Apply deterministic sparse semantics to one exact canonical document.
 * Omission preserves. Unset alone deletes. Objects and arrays are atomic
 * values. set_if_empty writes only when a key is absent, null, or ''.
 */
export function applySparsePagePatch(
  content: string,
  slug: string,
  patch: SparsePagePatch,
  additionalReservedKeys: ReadonlySet<string> = new Set(),
): string {
  const parsed = parseMarkdown(content, `${slug}.md`, { validate: true, expectedSlug: slug });
  if ((parsed.errors ?? []).length > 0) {
    throw new CanonicalMutationError(
      'invalid_canonical',
      `Canonical page cannot be patched until its Markdown validates: ${(parsed.errors ?? []).map((e) => e.code).join(', ')}.`,
    );
  }
  assertPatchKeys(patch, parsed.frontmatter, additionalReservedKeys);

  const hasMutation = patch.title !== undefined
    || patch.type !== undefined
    || patch.compiled_truth !== undefined
    || patch.timeline !== undefined
    || patch.tags !== undefined
    || Object.keys(patch.frontmatter_set ?? {}).length > 0
    || Object.keys(patch.frontmatter_set_if_empty ?? {}).length > 0
    || (patch.frontmatter_unset ?? []).length > 0;
  if (!hasMutation) throw new CanonicalMutationError('invalid_patch', 'patch_page requires at least one explicit change.');

  const frontmatter = { ...parsed.frontmatter };
  for (const key of patch.frontmatter_unset ?? []) delete frontmatter[key];
  for (const [key, value] of Object.entries(patch.frontmatter_set_if_empty ?? {})) {
    if (!nonEmpty(frontmatter[key])) frontmatter[key] = value;
  }
  for (const [key, value] of Object.entries(patch.frontmatter_set ?? {})) frontmatter[key] = value;

  const serialized = serializeMarkdown(
    frontmatter,
    patch.compiled_truth ?? parsed.compiled_truth,
    patch.timeline ?? parsed.timeline,
    {
      type: patch.type ?? parsed.type,
      title: patch.title ?? parsed.title,
      tags: patch.tags ?? parsed.tags,
    },
  );

  // A metadata-only patch must not normalize or trim the canonical body.
  // Replace only the leading frontmatter bytes and append the original body
  // suffix byte-for-byte. Explicit body/timeline mutations intentionally use
  // the canonical serializer above.
  if (patch.compiled_truth === undefined && patch.timeline === undefined) {
    const originalBodyAt = frontmatterBodyOffset(content);
    const newBodyAt = frontmatterBodyOffset(serialized);
    if (originalBodyAt > 0 && newBodyAt > 0) {
      return serialized.slice(0, newBodyAt) + content.slice(originalBodyAt);
    }
  }
  return serialized;
}

export async function readCanonicalPage(
  engine: BrainEngine,
  slug: string,
  sourceId = 'default',
): Promise<CanonicalPageSnapshot> {
  const writeThrough = await engine.getConfig('sync.write_through');
  if (writeThrough != null && ['0', 'false', 'off', 'no'].includes(writeThrough.trim().toLowerCase())) {
    throw new CanonicalMutationError(
      'canonical_unavailable',
      `Canonical mutations are disabled for ${sourceId}/${slug}: sync.write_through=false.`,
    );
  }
  const target = await resolvePageWriteTarget(engine, slug, sourceId);
  if (!target.ok) {
    throw new CanonicalMutationError('canonical_unavailable', `Canonical target is unavailable for ${sourceId}/${slug}: ${target.skipped}.`);
  }
  if (!existsSync(target.filePath)) {
    return { sourceId, slug, target, exists: false, content: null, revision: null };
  }
  const content = readFileSync(target.filePath, 'utf8');
  return { sourceId, slug, target, exists: true, content, revision: exactCanonicalRevision(content) };
}

function journalPath(root: string, sourceId: string, slug: string, idempotencyKey: string): string {
  const name = createHash('sha256')
    .update(sourceId).update('\0').update(slug).update('\0').update(idempotencyKey)
    .digest('hex');
  return join(root, `${name}.json`);
}

function writeIntent(path: string, intent: CanonicalMutationIntent): void {
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, `${JSON.stringify(intent, null, 2)}\n`);
}

function readIntent(path: string): CanonicalMutationIntent | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as CanonicalMutationIntent;
}

export async function commitCanonicalMutation<T>(opts: {
  engine: BrainEngine;
  slug: string;
  sourceId?: string;
  operation: 'patch_page' | 'put_page';
  baseRevision: string | null | undefined;
  buildContent: (current: CanonicalPageSnapshot) => string;
  project: (content: string, intendedRevision: string) => Promise<T>;
  idempotencyKey?: string;
  journalRoot?: string;
  lockRoot?: string;
}): Promise<CanonicalMutationResult<T>> {
  const sourceId = opts.sourceId ?? 'default';
  return withPageLock(opts.slug, async () => {
    const current = await readCanonicalPage(opts.engine, opts.slug, sourceId);
    const candidate = opts.buildContent(current);
    const intendedRevision = exactCanonicalRevision(candidate);
    const operationHash = exactCanonicalRevision(stableJson({
      operation: opts.operation,
      sourceId,
      slug: opts.slug,
      baseRevision: opts.baseRevision ?? null,
      intendedRevision,
    }));
    const idempotencyKey = opts.idempotencyKey ?? operationHash;
    const root = opts.journalRoot ?? gbrainPath('canonical-mutation-journal');
    const path = journalPath(root, sourceId, opts.slug, idempotencyKey);
    const prior = readIntent(path);
    if (prior && (
      prior.version !== 1
      || prior.source_id !== sourceId
      || prior.slug !== opts.slug
      || prior.operation !== opts.operation
      || prior.idempotency_key !== idempotencyKey
      || !['prepared', 'canonical_written', 'index_pending', 'projected'].includes(prior.state)
    )) {
      throw new CanonicalMutationError('invalid_canonical', `Canonical mutation journal is invalid for ${sourceId}/${opts.slug}.`);
    }

    const resumable = prior
      && prior.operation_hash === operationHash
      && prior.intended_revision === intendedRevision
      && current.revision === intendedRevision
      && (prior.state === 'prepared' || prior.state === 'canonical_written' || prior.state === 'index_pending' || prior.state === 'projected');

    // A create retry is allowed only when its durable intent identifies the
    // exact bytes already on disk. This covers both projection retry and the
    // crash window after atomic rename but before the journal advanced from
    // prepared. Any unrelated existing page still requires revision-bound
    // patch semantics.
    if (!resumable && current.exists && !opts.baseRevision) {
      throw new CanonicalMutationError('revision_required', `Existing page ${sourceId}/${opts.slug} requires base_revision.`);
    }

    if (!resumable && current.revision !== (opts.baseRevision ?? null)) {
      throw new CanonicalMutationError(
        'revision_conflict',
        `Stale base_revision for ${sourceId}/${opts.slug}: expected ${current.revision ?? 'null'}, received ${opts.baseRevision ?? 'null'}.`,
      );
    }

    const now = new Date().toISOString();
    let intent: CanonicalMutationIntent = prior && resumable
      ? prior
      : {
          version: 1,
          source_id: sourceId,
          slug: opts.slug,
          operation: opts.operation,
          idempotency_key: idempotencyKey,
          base_revision: opts.baseRevision ?? null,
          intended_revision: intendedRevision,
          operation_hash: operationHash,
          state: 'prepared',
          created_at: now,
          updated_at: now,
        };

    if (!resumable) {
      writeIntent(path, intent);
      mkdirSync(dirname(current.target.filePath), { recursive: true });
      atomicWriteFileSync(current.target.filePath, candidate, {
        verify: (onDisk) => {
          if (exactCanonicalRevision(onDisk) !== intendedRevision) {
            throw new CanonicalMutationError('invalid_canonical', 'Canonical byte verification failed before rename.');
          }
          const parsed = parseMarkdown(onDisk, `${opts.slug}.md`, { validate: true, expectedSlug: opts.slug });
          if ((parsed.errors ?? []).length > 0) {
            throw new CanonicalMutationError('invalid_canonical', `Candidate Markdown failed validation: ${(parsed.errors ?? []).map((e) => e.code).join(', ')}.`);
          }
        },
      });
      intent = { ...intent, state: 'canonical_written', updated_at: new Date().toISOString() };
      writeIntent(path, intent);
    }

    // A completed intent is an immutable receipt. Replaying the exact same
    // operation must not project again (patch_page projection creates a page
    // version and is therefore not idempotent by itself).
    if (resumable && intent.state === 'projected') {
      return {
        canonical_revision: intendedRevision,
        projected_revision: intendedRevision,
        projection_state: 'current',
        journal_path: path,
        resumed: true,
      };
    }

    try {
      const value = await opts.project(candidate, intendedRevision);
      intent = { ...intent, state: 'projected', updated_at: new Date().toISOString() };
      delete intent.projection_error;
      writeIntent(path, intent);
      return {
        value,
        canonical_revision: intendedRevision,
        projected_revision: intendedRevision,
        projection_state: 'current',
        journal_path: path,
        resumed: Boolean(resumable),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      intent = { ...intent, state: 'index_pending', projection_error: message, updated_at: new Date().toISOString() };
      writeIntent(path, intent);
      return {
        canonical_revision: intendedRevision,
        projected_revision: null,
        projection_state: 'pending',
        projection_error: message,
        journal_path: path,
        resumed: Boolean(resumable),
      };
    }
  }, { timeoutMs: 30_000, sourceId, ...(opts.lockRoot ? { lockRoot: opts.lockRoot } : {}) });
}
