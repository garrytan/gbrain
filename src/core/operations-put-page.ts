// Canonical page-write operations (put_page, admin_put_page) and the full
// governed write machinery: source attribution, markdown mirror targets,
// write sessions, conflict recording, and slug quality gates.
import { createHash, randomUUID } from 'crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { basename, dirname, join, relative, resolve } from 'path';
import type { OperationAuthPrincipal } from './auth-principal.ts';
import type { BrainEngine } from './engine.ts';
import { importFromContent, importFromFile, MAX_MARKDOWN_IMPORT_BYTES } from './import-file.ts';
import { parseMarkdown, serializeMarkdown } from './markdown.ts';
import { OperationError } from './operation-params.ts';
import type { Operation } from './operations.ts';
import { assertJsonSerializable } from './operations-shared.ts';
import { reviewDuplicateMemory } from './services/duplicate-memory-review-service.ts';
import { assertMemoryWriteAllowed, MemoryAccessPolicyError } from './services/memory-access-policy-service.ts';
import { recordMemoryMutationEvent } from './services/memory-mutation-ledger-service.ts';
import { findSlugQualityIssues } from './slug-quality.ts';
import { findSubbrainBySlugPrefix, loadSubbrainRegistry, type SubbrainConfig, stripSubbrainPrefix } from './subbrains.ts';
import { slugifyPath } from './sync.ts';
import type {
  MemoryMutationEvent,
  MemoryWriteSession,
  Page,
} from './types.ts';
import { importContentHash, validateSlug } from './utils.ts';

const SOURCE_ATTRIBUTION_RE = /\[Source:\s*([^\]\n]*)\]/g;

function hasUsableSourceAttribution(content: string): boolean {
  SOURCE_ATTRIBUTION_RE.lastIndex = 0;
  for (const match of content.matchAll(SOURCE_ATTRIBUTION_RE)) {
    if ((match[1] ?? '').trim()) return true;
  }
  return false;
}

function assertPutPageSourceAttribution(slug: string, content: string): void {
  const parsed = parseMarkdown(content, `${slug}.md`);
  const citedBody = [parsed.compiled_truth, parsed.timeline].join('\n');
  if (hasUsableSourceAttribution(citedBody)) return;
  throw new OperationError(
    'invalid_params',
    'put_page content must include at least one non-empty [Source: ...] attribution.',
    'Add a provenance citation such as [Source: User, direct message, 2026-04-26 09:00 AM KST] to the compiled truth or timeline before writing durable memory.',
    'docs/guides/source-attribution.md',
  );
}

function optionalPutPageString(field: string, value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OperationError('invalid_params', `${field} must be a non-empty string`);
  }
  return value.trim();
}

function putPageSlug(value: unknown): string {
  const raw = optionalPutPageString('slug', value);
  if (raw === undefined) {
    throw new OperationError('invalid_params', 'slug must be a non-empty string');
  }
  try {
    return validateSlug(raw);
  } catch (error) {
    throw new OperationError('invalid_params', error instanceof Error ? error.message : 'slug is invalid');
  }
}

function putPageContent(value: unknown): string {
  if (typeof value !== 'string') {
    throw new OperationError('invalid_params', 'content must be a string');
  }
  return value;
}

function putPageExpectedContentHash(value: unknown): string | null | undefined {
  if (value === null) return null;
  const expected = optionalPutPageString('expected_content_hash', value);
  if (expected === undefined) return undefined;
  if (!/^[a-fA-F0-9]{64}$/.test(expected)) {
    throw new OperationError('invalid_params', 'expected_content_hash must be null or a SHA-256 hex content hash');
  }
  return expected.toLowerCase();
}

async function resolvePutPageMarkdownTarget(engine: BrainEngine, slug: string, value: unknown): Promise<PutPageMarkdownTarget | null> {
  const explicit = optionalPutPageString('repo', value);
  if (explicit) {
    const subbrain = await findRegisteredSubbrainForRepo(engine, explicit);
    if (subbrain && slugStartsWithSubbrainPrefix(subbrain, slug)) {
      let relativeSlug: string;
      try {
        relativeSlug = stripSubbrainPrefix(subbrain, slug);
      } catch (error) {
        throw new OperationError('invalid_params', error instanceof Error ? error.message : String(error));
      }
      return putPageMarkdownTarget(subbrain.path, relativeSlug, subbrain.prefix);
    }
    return putPageMarkdownTarget(explicit, slug);
  }

  const registry = await loadSubbrainRegistry(engine);
  const registeredSubbrains = Object.values(registry.subbrains);
  if (registeredSubbrains.length > 0) {
    const subbrain = findSubbrainBySlugPrefix(registry, slug);
    if (!subbrain) {
      throw new OperationError('invalid_params', `Slug does not match any registered sub-brain prefix: ${slug}`);
    }
    let relativeSlug: string;
    try {
      relativeSlug = stripSubbrainPrefix(subbrain, slug);
    } catch (error) {
      throw new OperationError('invalid_params', error instanceof Error ? error.message : String(error));
    }
    return putPageMarkdownTarget(subbrain.path, relativeSlug, subbrain.prefix);
  }

  const repoPath = (await engine.getConfig('markdown.repo_path')) ?? (await engine.getConfig('sync.repo_path'));
  return repoPath ? putPageMarkdownTarget(repoPath, slug) : null;
}

async function findRegisteredSubbrainForRepo(engine: BrainEngine, rawRepoPath: string): Promise<SubbrainConfig | null> {
  const explicitRepoPath = maybeRealDirectoryPath(rawRepoPath);
  if (!explicitRepoPath) return null;

  const registry = await loadSubbrainRegistry(engine);
  for (const subbrain of Object.values(registry.subbrains)) {
    const registeredPath = maybeRealDirectoryPath(subbrain.path);
    if (registeredPath === explicitRepoPath) {
      return subbrain;
    }
  }
  return null;
}

function maybeRealDirectoryPath(rawPath: string): string | null {
  try {
    const requested = resolve(rawPath);
    if (!existsSync(requested) || !statSync(requested).isDirectory()) {
      return null;
    }
    return realpathSync(requested);
  } catch {
    return null;
  }
}

function slugStartsWithSubbrainPrefix(subbrain: SubbrainConfig, slug: string): boolean {
  return slug === subbrain.prefix || slug.startsWith(`${subbrain.prefix}/`);
}

interface PutPageMarkdownTarget {
  repoPath: string;
  relativePath: string;
  filePath: string;
  slugPrefix?: string;
}

interface PutPageMarkdownSnapshot {
  existed: boolean;
  content: string | null;
  isSymlink: boolean;
}

function putPageMarkdownTarget(repoPath: string, slug: string, slugPrefix?: string): PutPageMarkdownTarget {
  const requestedRepoRoot = resolve(repoPath);
  if (!existsSync(requestedRepoRoot) || !statSync(requestedRepoRoot).isDirectory()) {
    throw new OperationError('invalid_params', `put_page markdown repo does not exist or is not a directory: ${repoPath}`);
  }

  const repoRoot = realpathSync(requestedRepoRoot);
  const relativePath = `${validateSlug(slug)}.md`;
  const filePath = resolve(repoRoot, relativePath);
  const relativeToRoot = relative(repoRoot, filePath);
  if (relativeToRoot.startsWith('..') || relativeToRoot === '' || resolve(repoRoot, relativeToRoot) !== filePath) {
    throw new OperationError('invalid_params', `put_page markdown path escapes repo for slug: ${slug}`);
  }

  const target = { repoPath: repoRoot, relativePath, filePath, slugPrefix };
  assertPutPageMarkdownParentIsSafe(target);
  return target;
}

function hashMarkdownPageContent(slug: string, content: string, relativePath?: string): string {
  return importContentHash(parseMarkdown(content, relativePath ?? `${slug}.md`));
}

function assertPutPageMarkdownContentMatchesTarget(content: string, target: PutPageMarkdownTarget): void {
  if (!hasExplicitFrontmatterSlug(content)) return;

  const parsed = parseMarkdown(content, target.relativePath);
  let expectedSlug = slugifyPath(target.relativePath);
  if (target.slugPrefix) expectedSlug = `${target.slugPrefix}/${expectedSlug}`;
  let canonicalParsedSlug: string;
  try {
    canonicalParsedSlug = slugifyPath(validateSlug(parsed.slug));
  } catch {
    canonicalParsedSlug = parsed.slug;
  }

  if (canonicalParsedSlug !== expectedSlug) {
    throw new OperationError(
      'invalid_params',
      `Frontmatter slug "${parsed.slug}" does not match path-derived slug "${expectedSlug}" (from ${target.relativePath}). Remove the frontmatter "slug:" line or move the file.`,
    );
  }
}

function hasExplicitFrontmatterSlug(content: string): boolean {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return false;
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') return false;
    if (/^slug\s*:/.test(line.trim())) return true;
  }
  return false;
}

function assertPutPageMarkdownParentIsSafe(target: PutPageMarkdownTarget): void {
  const directory = dirname(target.relativePath);
  if (directory === '.' || directory === '') return;

  let currentPath = target.repoPath;
  for (const part of directory.split('/')) {
    if (!part) continue;
    currentPath = join(currentPath, part);
    if (!existsSync(currentPath)) continue;

    const stat = lstatSync(currentPath);
    if (stat.isSymbolicLink()) {
      throw new OperationError('invalid_params', `put_page markdown path escapes repo through a symlink: ${relative(target.repoPath, currentPath)}`);
    }
    if (!stat.isDirectory()) {
      throw new OperationError('invalid_params', `put_page markdown parent is not a directory: ${relative(target.repoPath, currentPath)}`);
    }

    const realParent = realpathSync(currentPath);
    const relativeToRoot = relative(target.repoPath, realParent);
    if (relativeToRoot.startsWith('..') || resolve(target.repoPath, relativeToRoot) !== realParent) {
      throw new OperationError('invalid_params', `put_page markdown path escapes repo: ${target.relativePath}`);
    }
  }
}

function readMarkdownTargetSnapshot(target: PutPageMarkdownTarget): PutPageMarkdownSnapshot {
  if (!existsSync(target.filePath)) {
    return { existed: false, content: null, isSymlink: false };
  }
  const stat = lstatSync(target.filePath);
  if (stat.isSymbolicLink()) {
    throw new OperationError('invalid_params', `put_page markdown target must not be a symlink: ${target.relativePath}`);
  }
  return {
    existed: true,
    content: readFileSync(target.filePath, 'utf-8'),
    isSymlink: false,
  };
}

function atomicWriteMarkdownTarget(target: PutPageMarkdownTarget, content: string): void {
  const directory = dirname(target.filePath);
  assertPutPageMarkdownParentIsSafe(target);
  mkdirSync(directory, { recursive: true });
  assertPutPageMarkdownParentIsSafe(target);
  const tempPath = join(directory, `.${basename(target.filePath)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, content, 'utf-8');
    renameSync(tempPath, target.filePath);
  } catch (error) {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // Best-effort cleanup; preserve the original write failure.
    }
    throw error;
  }
}

function restoreMarkdownTargetSnapshot(target: PutPageMarkdownTarget, snapshot: PutPageMarkdownSnapshot): void {
  if (snapshot.existed) {
    atomicWriteMarkdownTarget(target, snapshot.content ?? '');
    return;
  }
  rmSync(target.filePath, { force: true });
}

function hashMarkdownTargetSnapshot(target: PutPageMarkdownTarget, snapshot: PutPageMarkdownSnapshot): string | null {
  if (!snapshot.existed || snapshot.content === null) return null;
  const canonicalRelativePath = target.slugPrefix ? `${target.slugPrefix}/${target.relativePath}` : target.relativePath;
  return hashMarkdownPageContent(canonicalRelativePath.replace(/\.md$/i, ''), snapshot.content, canonicalRelativePath);
}

function shouldWriteMarkdownTarget(snapshot: PutPageMarkdownSnapshot, content: string): boolean {
  return !snapshot.existed || snapshot.isSymlink || snapshot.content !== content;
}

function putPageMarkdownPreflightError(content: string): string | null {
  const byteLength = Buffer.byteLength(content, 'utf-8');
  if (byteLength <= MAX_MARKDOWN_IMPORT_BYTES) return null;
  return `Content too large (${byteLength} bytes, max ${MAX_MARKDOWN_IMPORT_BYTES}).`;
}

function putPageMarkdownConflict(input: {
  slug: string;
  existingPageHash: string | null;
  expectedContentHash?: string | null;
  markdownContentHash: string | null;
}): {
  expectedContentHash: string | null;
  currentContentHash: string | null;
  conflictInfo: Record<string, unknown>;
  message: string;
} | null {
  if (input.markdownContentHash === null) return null;

  if (input.existingPageHash === null) {
    return {
      expectedContentHash: input.expectedContentHash ?? null,
      currentContentHash: input.markdownContentHash,
      conflictInfo: {
        reason: 'markdown_file_without_db_page',
        markdown_content_hash: input.markdownContentHash,
      },
      message: `markdown file already exists for ${input.slug}`,
    };
  }

  if (input.markdownContentHash !== input.existingPageHash) {
    return {
      expectedContentHash: input.expectedContentHash ?? input.existingPageHash,
      currentContentHash: input.markdownContentHash,
      conflictInfo: {
        reason: 'markdown_file_changed',
        db_content_hash: input.existingPageHash,
        markdown_content_hash: input.markdownContentHash,
      },
      message: `markdown file changed since the DB page was indexed: ${input.slug}`,
    };
  }

  return null;
}

function putPageSourceRefs(value: unknown): string[] {
  let parsed: string[] | undefined;
  if (value === undefined) {
    return ['Source: mbrain put_page operation'];
  } else if (Array.isArray(value)) {
    parsed = value.map((ref, index) => putPageSourceRef(ref, `source_refs[${index}]`));
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[')) {
      let rawRefs: unknown;
      try {
        rawRefs = JSON.parse(trimmed);
      } catch {
        rawRefs = undefined;
      }
      if (rawRefs !== undefined) {
        if (!Array.isArray(rawRefs)) {
          throw new OperationError('invalid_params', 'source_refs JSON value must be an array.');
        }
        parsed = rawRefs.map((ref, index) => putPageSourceRef(ref, `source_refs[${index}]`));
      } else {
        parsed = parsePutPageSourceRefString(value);
      }
    } else {
      parsed = parsePutPageSourceRefString(value);
    }
  } else {
    throw new OperationError('invalid_params', 'source_refs must be an array or string list.');
  }

  const refs = parsed?.map((ref) => ref.trim()).filter((ref) => ref.length > 0) ?? [];
  if (refs.length === 0) {
    throw new OperationError('invalid_params', 'source_refs must be a non-empty array of strings');
  }
  return refs;
}

function parsePutPageSourceRefString(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed === '') return [];
  return trimmed
    .split(/\r?\n/)
    .map((ref) => ref.trim())
    .filter((ref) => ref.length > 0);
}

export function putPageSourceRef(value: unknown, key: string): string {
  if (typeof value !== 'string') {
    throw new OperationError('invalid_params', `${key} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new OperationError('invalid_params', `${key} must be a non-empty string`);
  }
  return trimmed;
}

function putPageMetadata(value: unknown): Record<string, unknown> | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new OperationError('invalid_params', 'metadata must be an object');
  }
  assertJsonSerializable(value, 'metadata', new WeakSet<object>());
  return value as Record<string, unknown>;
}

function putPageRealmIdForScope(scopeId: string): string {
  return scopeId.startsWith('personal:') ? 'personal' : 'work';
}

function putPageAuditContext(
  p: Record<string, unknown>,
  preconditionSupplied: boolean,
  defaults?: {
    session_id?: string;
    realm_id?: string;
    actor?: string;
    scope_id?: string;
    source_refs?: string[];
    metadata?: Record<string, unknown>;
  },
) {
  const defaultMetadata: Record<string, unknown> = {};
  if (defaults?.session_id) defaultMetadata.session_id = defaults.session_id;
  if (defaults?.realm_id) defaultMetadata.realm_id = defaults.realm_id;
  if (defaults?.actor) defaultMetadata.actor = defaults.actor;
  if (defaults?.scope_id) defaultMetadata.scope_id = defaults.scope_id;
  if (defaults?.source_refs) defaultMetadata.source_refs = defaults.source_refs;
  return {
    session_id: defaults?.session_id ?? optionalPutPageString('session_id', p.session_id) ?? `put_page:direct:${randomUUID()}`,
    realm_id: defaults?.realm_id ?? optionalPutPageString('realm_id', p.realm_id) ?? 'work',
    actor: defaults?.actor ?? optionalPutPageString('actor', p.actor) ?? 'mbrain:put_page',
    scope_id: defaults?.scope_id ?? optionalPutPageString('scope_id', p.scope_id) ?? 'workspace:default',
    source_refs: defaults?.source_refs ?? (p.source_refs === undefined ? putPageSourceRefs(p.source_refs) : putPageSourceRefs(p.source_refs)),
    metadata: {
      ...putPageMetadata(p.metadata),
      ...(defaults?.metadata ?? {}),
      ...defaultMetadata,
      precondition_supplied: preconditionSupplied,
    },
    redaction_visibility: 'visible' as const,
  };
}

type PutPageAuditContext = ReturnType<typeof putPageAuditContext>;

interface ResolvedPutPageWriteSession {
  session: MemoryWriteSession;
  audit: PutPageAuditContext;
  expectedContentHash: string | null;
}

function sameStringArray(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function normalizeRoutedContentForMatch(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function normalizeCompiledTruthForRoutedContent(value: string): string {
  return normalizeRoutedContentForMatch(value.replace(/\s*\[Source:[^\]]+\]\s*/g, ' '));
}

function normalizeSourceRefForWriteSession(value: string): string {
  const trimmed = value.trim();
  const bracketed = /^\[Source:\s*([^\]\n]+)\]$/i.exec(trimmed);
  const unwrapped = bracketed?.[1] ?? trimmed;
  return unwrapped
    .replace(/^Source:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sourceAttributionsFromText(value: string): string[] {
  const refs: string[] = [];
  SOURCE_ATTRIBUTION_RE.lastIndex = 0;
  for (const match of value.matchAll(SOURCE_ATTRIBUTION_RE)) {
    const ref = normalizeSourceRefForWriteSession(match[1] ?? '');
    if (ref) refs.push(ref);
  }
  return [...new Set(refs)];
}

function writeSessionSourceRefsMatchPage(expectedSourceRefs: string[], pageContent: string): boolean {
  const expected = new Set(expectedSourceRefs.map((ref) => normalizeSourceRefForWriteSession(ref)).filter(Boolean));
  const pageRefs = sourceAttributionsFromText(pageContent);
  return pageRefs.length > 0 && pageRefs.length === expected.size && pageRefs.every((ref) => expected.has(ref));
}

function sortedUniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => stableJsonValue(entry));
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort((left, right) => left.localeCompare(right))
        .map((key) => [key, stableJsonValue(record[key])]),
    );
  }
  return value;
}

function stableJsonString(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

function sameFrontmatter(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return stableJsonString(left) === stableJsonString(right);
}

function writeSessionMetadataFailure(reason: string, message: string): PutPageWriteSessionValidationFailure {
  return {
    status: 'abandoned',
    reason,
    message,
  };
}

async function validatePutPageWriteSessionPageMetadata(
  engine: BrainEngine,
  input: {
    slug: string;
    content: string;
    existing: Page | null;
  },
): Promise<PutPageWriteSessionValidationFailure | null> {
  const parsedPage = parseMarkdown(input.content, `${input.slug}.md`);
  if (!input.existing) {
    const inferredPage = parseMarkdown(parsedPage.compiled_truth, `${input.slug}.md`);
    if (parsedPage.type !== inferredPage.type || parsedPage.title !== inferredPage.title) {
      return writeSessionMetadataFailure('page_metadata_mismatch', 'write session does not authorize page metadata type or title changes');
    }
    if (Object.keys(parsedPage.frontmatter).length > 0 || parsedPage.tags.length > 0) {
      return writeSessionMetadataFailure('page_metadata_mismatch', 'write session does not authorize page frontmatter or tags');
    }
    return null;
  }

  if (
    parsedPage.type !== input.existing.type ||
    parsedPage.title !== input.existing.title ||
    !sameFrontmatter(parsedPage.frontmatter, input.existing.frontmatter ?? {})
  ) {
    return writeSessionMetadataFailure('page_metadata_mismatch', 'write session does not authorize page metadata changes');
  }
  const existingTags = await engine.getTags(input.slug);
  if (JSON.stringify(sortedUniqueStrings(parsedPage.tags)) !== JSON.stringify(sortedUniqueStrings(existingTags))) {
    return writeSessionMetadataFailure('page_metadata_mismatch', 'write session does not authorize page tag changes');
  }
  return null;
}

function writeSessionAuthPrincipalMatches(value: unknown, principal: OperationAuthPrincipal | undefined): boolean {
  if (value == null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const expected = value as Record<string, unknown>;
  if (!principal) return false;
  return (
    expected.principal_type === principal.principal_type &&
    expected.principal_id === principal.principal_id &&
    expected.actor_type === principal.actor_type &&
    expected.actor_id === principal.actor_id &&
    expected.surface_locality === principal.surface_locality &&
    expected.surface_profile === principal.surface_profile
  );
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value.trim()).digest('hex');
}

async function abandonPutPageWriteSession(engine: BrainEngine, sessionId: string, reason: string): Promise<void> {
  await engine.consumeMemoryWriteSession(sessionId, {
    status: 'abandoned',
    status_reason: reason,
  });
}

interface PutPageWriteSessionValidationFailure {
  status?: 'expired' | 'abandoned';
  reason?: string;
  message: string;
}

function validatePutPageWriteSessionForParams(
  session: MemoryWriteSession,
  input: {
    slug: string;
    content: string;
    params: Record<string, unknown>;
    authPrincipal?: OperationAuthPrincipal;
  },
): PutPageWriteSessionValidationFailure | null {
  if (session.status !== 'open') {
    if (session.status === 'expired') {
      return {
        status: 'expired',
        reason: 'expired_before_put_page',
        message: `write session expired: ${session.id}`,
      };
    }
    return {
      message: `write session already consumed (${session.status}): ${session.id}`,
    };
  }
  if (session.target_slug !== input.slug) {
    return {
      status: 'abandoned',
      reason: `target_slug_mismatch:${input.slug}`,
      message: `write session target mismatch: ${session.target_slug} cannot write ${input.slug}`,
    };
  }

  const suppliedScopeId = optionalPutPageString('scope_id', input.params.scope_id);
  if (suppliedScopeId !== undefined && suppliedScopeId !== session.scope_id) {
    return {
      status: 'abandoned',
      reason: `scope_id_mismatch:${suppliedScopeId}`,
      message: `write session scope mismatch: ${session.scope_id} cannot write ${suppliedScopeId}`,
    };
  }
  const suppliedActor = optionalPutPageString('actor', input.params.actor);
  if (suppliedActor !== undefined && suppliedActor !== session.actor) {
    return {
      status: 'abandoned',
      reason: `actor_mismatch:${suppliedActor}`,
      message: `write session actor mismatch: ${session.actor} cannot be consumed by ${suppliedActor}`,
    };
  }
  if (input.params.source_refs !== undefined) {
    const suppliedSourceRefs = putPageSourceRefs(input.params.source_refs);
    if (!sameStringArray(suppliedSourceRefs, session.source_refs)) {
      return {
        status: 'abandoned',
        reason: 'source_refs_mismatch',
        message: 'write session source_refs mismatch',
      };
    }
  }
  if (Object.prototype.hasOwnProperty.call(input.params, 'expected_content_hash')) {
    const suppliedExpectedHash = putPageExpectedContentHash(input.params.expected_content_hash ?? null);
    if (suppliedExpectedHash !== session.expected_content_hash) {
      return {
        status: 'abandoned',
        reason: 'expected_content_hash_mismatch',
        message: 'write session expected_content_hash mismatch',
      };
    }
  }
  if (!writeSessionAuthPrincipalMatches(session.governance_metadata.auth_principal, input.authPrincipal)) {
    return {
      status: 'abandoned',
      reason: 'auth_principal_mismatch',
      message: 'write session auth principal mismatch',
    };
  }
  const routedContent = session.governance_metadata.routed_content;
  const routedContentHash = session.governance_metadata.routed_content_hash;
  if (typeof routedContent !== 'string' || typeof routedContentHash !== 'string') {
    return {
      status: 'abandoned',
      reason: 'routed_content_missing',
      message: 'write session routed content metadata is missing',
    };
  }
  if (sha256Hex(routedContent) !== routedContentHash) {
    return {
      status: 'abandoned',
      reason: 'routed_content_hash_mismatch',
      message: 'write session routed content hash mismatch',
    };
  }
  const parsedPage = parseMarkdown(input.content, `${input.slug}.md`);
  if (!writeSessionSourceRefsMatchPage(session.source_refs, `${parsedPage.compiled_truth}\n${parsedPage.timeline}`)) {
    return {
      status: 'abandoned',
      reason: 'source_refs_mismatch',
      message: 'write session source_refs mismatch',
    };
  }
  if (parsedPage.timeline.trim()) {
    return {
      status: 'abandoned',
      reason: 'routed_timeline_not_authorized',
      message: 'write session does not authorize timeline content',
    };
  }
  const normalizedPageContent = normalizeCompiledTruthForRoutedContent(parsedPage.compiled_truth);
  const normalizedRoutedContent = normalizeRoutedContentForMatch(routedContent);
  if (normalizedPageContent !== normalizedRoutedContent) {
    return {
      status: 'abandoned',
      reason: 'routed_content_mismatch',
      message: 'write session routed content does not match put_page compiled truth',
    };
  }

  return null;
}

async function consumePutPageWriteSessionValidationFailure(
  engine: BrainEngine,
  session: MemoryWriteSession,
  failure: PutPageWriteSessionValidationFailure,
): Promise<void> {
  if (failure.status === 'expired') {
    await engine.consumeMemoryWriteSession(session.id, {
      status: 'expired',
      status_reason: failure.reason ?? 'expired_before_put_page',
    });
  } else if (failure.status === 'abandoned') {
    await abandonPutPageWriteSession(engine, session.id, failure.reason ?? 'validation_failed');
  }
}

async function resolvePutPageWriteSession(
  engine: BrainEngine,
  input: {
    writeSessionId: string;
    slug: string;
    content: string;
    params: Record<string, unknown>;
    authPrincipal?: OperationAuthPrincipal;
    preconditionSupplied: boolean;
  },
): Promise<ResolvedPutPageWriteSession> {
  const session = await engine.getMemoryWriteSession(input.writeSessionId);
  if (!session) {
    throw new OperationError('invalid_params', `write session not found: ${input.writeSessionId}`);
  }
  const failure = validatePutPageWriteSessionForParams(session, input);
  if (failure) {
    await consumePutPageWriteSessionValidationFailure(engine, session, failure);
    throw new OperationError('invalid_params', failure.message);
  }
  const realmId = putPageRealmIdForScope(session.scope_id);

  return {
    session,
    audit: putPageAuditContext(input.params, input.preconditionSupplied, {
      session_id: session.id,
      realm_id: realmId,
      actor: session.actor,
      scope_id: session.scope_id,
      source_refs: session.source_refs,
      metadata: {
        route_decision_id: session.route_decision_id,
        write_session_id: session.id,
      },
    }),
    expectedContentHash: session.expected_content_hash,
  };
}

async function preflightPutPageWriteSession(
  engine: BrainEngine,
  input: {
    writeSessionId: string;
    slug: string;
    content: string;
    params: Record<string, unknown>;
    authPrincipal?: OperationAuthPrincipal;
  },
): Promise<void> {
  const session = await engine.getMemoryWriteSession(input.writeSessionId);
  if (!session) {
    throw new OperationError('invalid_params', `write session not found: ${input.writeSessionId}`);
  }
  const failure = validatePutPageWriteSessionForParams(session, input);
  if (failure) {
    await consumePutPageWriteSessionValidationFailure(engine, session, failure);
    throw new OperationError('invalid_params', failure.message);
  }
}

async function recordPutPageConflictEvent(
  engine: BrainEngine,
  audit: PutPageAuditContext,
  input: {
    slug: string;
    expectedContentHash: string | null;
    currentContentHash: string | null;
    conflictInfo: Record<string, unknown>;
  },
): Promise<MemoryMutationEvent> {
  return recordMemoryMutationEvent(engine, {
    ...audit,
    operation: 'put_page',
    target_kind: 'page',
    target_id: input.slug,
    expected_target_snapshot_hash: input.expectedContentHash,
    current_target_snapshot_hash: input.currentContentHash,
    result: 'conflict',
    conflict_info: input.conflictInfo,
    dry_run: false,
  });
}

async function recordPutPageConflict(
  engine: BrainEngine,
  audit: PutPageAuditContext,
  input: {
    slug: string;
    expectedContentHash: string | null;
    currentContentHash: string | null;
    conflictInfo: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await recordPutPageConflictEvent(engine, audit, input);
  } catch {
    // Conflict auditing is best effort so write_conflict remains the surfaced failure.
  }
}

async function assertPutPageMemoryWriteAllowed(
  engine: BrainEngine,
  input: {
    memory_session_id?: string | null;
    realm_id?: string | null;
    scope_id?: string | null;
  },
): Promise<void> {
  try {
    await assertMemoryWriteAllowed(engine, input);
  } catch (error) {
    if (error instanceof MemoryAccessPolicyError) {
      throw new OperationError('invalid_params', error.message);
    }
    throw error;
  }
}

function putPageOperationResult(result: { slug: string; status: string; chunks: number; error?: string; deferred_derived?: boolean }) {
  return {
    slug: result.slug,
    status: result.status === 'imported' ? 'created_or_updated' : result.status,
    chunks: result.chunks,
    ...(result.deferred_derived ? { derived_storage: 'scheduled' } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}

async function putPageDuplicateWarning(
  engine: BrainEngine,
  slug: string,
  content: string,
): Promise<Array<{ slug: string; score: number; reasons: string[] }>> {
  if (await engine.getPage(slug)) return [];
  const parsed = parseMarkdown(content, `${slug}.md`);
  const firstCompiledLine = parsed.compiled_truth
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? '';
  const review = await reviewDuplicateMemory(engine, {
    scope_id: 'workspace:default',
    subject_kind: 'page',
    subject_id: slug,
    content: `${parsed.title}\n${firstCompiledLine}`.trim(),
    source_refs: [],
    candidate_type: 'note_update',
    target_object_type: 'curated_note',
    target_object_id: slug,
    include_pages: true,
    include_candidates: false,
    limit: 5,
  });
  return review.matches
    .filter((match) => match.kind === 'page' && match.id !== slug && match.score >= review.thresholds.possible_duplicate)
    .map((match) => ({
      slug: match.id,
      score: match.score,
      reasons: match.reasons,
    }));
}

type PutPageImportResult = Awaited<ReturnType<typeof importFromContent>>;
type PutPageTransactionOutcome =
  | { kind: 'result'; result: PutPageImportResult }
  | { kind: 'invalid'; error: OperationError }
  | {
      kind: 'conflict';
      audit: PutPageAuditContext;
      conflict: {
        slug: string;
        expectedContentHash: string | null;
        currentContentHash: string | null;
        conflictInfo: Record<string, unknown>;
      };
      conflictEventRecorded?: boolean;
      error: OperationError;
    };

const ADMIN_PUT_PAGE_ROUTE_FIRST_BYPASS = Symbol('admin_put_page_route_first_bypass');

export function hasPutPageRouteFirstPrecondition(params: Record<string, unknown>): boolean {
  if (Object.prototype.hasOwnProperty.call(params, 'expected_content_hash') && params.expected_content_hash !== undefined) {
    return true;
  }
  return typeof params.write_session_id === 'string' && params.write_session_id.trim().length > 0;
}

export function assertPutPageRouteFirstPrecondition(params: Record<string, unknown>): void {
  if (hasPutPageRouteFirstPrecondition(params)) return;
  throw new OperationError(
    'invalid_params',
    'route_first: put_page must observe the target before writing — supply expected_content_hash (null asserts the page is absent, a content hash drives an update) or a route_memory_writeback write_session_id. memory_session_id alone is not a route-first write grant.',
    'Call route_memory_writeback and pass canonical_write_requirements.write_session_id, or call get_page for the current content_hash before retrying put_page. Offline repair can use admin_put_page.',
  );
}

const put_page: Operation = {
  name: 'put_page',
  description:
    'record new information as compiled truth + timeline in a governed Markdown page. Requires observed target hash or router-issued write_session_id.',
  params: {
    slug: { type: 'string', required: true, description: 'Page slug' },
    content: {
      type: 'string',
      required: true,
      description: 'Full markdown page content',
    },
    expected_content_hash: {
      type: 'string',
      nullable: true,
      description: 'Observed-target precondition: existing content_hash, or null for confirmed absence. Omit only with write_session_id.',
    },
    write_session_id: {
      type: 'string',
      description: 'Router-issued write session id; binds target slug, source refs, scope, expected hash, and routed content.',
    },
    repo: {
      type: 'string',
      description: 'Optional markdown repo root for markdown-first local/offline writes. Defaults to configured markdown.repo_path or sync.repo_path.',
    },
    memory_session_id: {
      type: 'string',
      description: 'Optional memory session id used for write authorization. Requires realm_id.',
    },
    session_id: {
      type: 'string',
      description: 'Optional audit session id. Defaults to put_page:direct.',
    },
    realm_id: {
      type: 'string',
      description: 'Optional audit realm id. Defaults to work.',
    },
    actor: {
      type: 'string',
      description: 'Optional audit actor. Defaults to mbrain:put_page.',
    },
    scope_id: {
      type: 'string',
      description: 'Optional audit scope id. Defaults to workspace:default.',
    },
    source_refs: {
      type: ['array', 'string'],
      items: { type: 'string' },
      description: 'Optional non-empty audit provenance references.',
    },
    metadata: {
      type: 'object',
      description: 'Optional audit metadata object.',
    },
    defer_derived: {
      type: 'boolean',
      description: 'Commit the canonical page immediately and refresh chunks, manifest, and section indexes after the MCP response.',
    },
  },
  mutating: true,
  handler: async (ctx, p) => {
    const slug = putPageSlug(p.slug);
    const content = putPageContent(p.content);
    const deferDerived = p.defer_derived === true;
    const adminPutPageBypass = (p as Record<symbol, unknown>)[ADMIN_PUT_PAGE_ROUTE_FIRST_BYPASS] === true;
    // Whether the caller observed the target before writing. Public put_page requires this field
    // at the operation layer; admin_put_page is the offline repair/import escape.
    const preconditionSupplied = hasPutPageRouteFirstPrecondition(p);
    assertWritableSlugQuality(slug);
    if (!adminPutPageBypass) assertPutPageRouteFirstPrecondition(p);
    if (ctx.dryRun) return { dry_run: true, action: 'put_page', slug };
    const possibleDuplicateOf = await putPageDuplicateWarning(ctx.engine, slug, content);
    const memorySessionId = optionalPutPageString('memory_session_id', p.memory_session_id) ?? null;
    const writeSessionId = optionalPutPageString('write_session_id', p.write_session_id) ?? null;
    if (writeSessionId) {
      await preflightPutPageWriteSession(ctx.engine, {
        writeSessionId,
        slug,
        content,
        params: p,
        authPrincipal: ctx.auth_principal,
      });
    }
    const markdownTarget = await resolvePutPageMarkdownTarget(ctx.engine, slug, p.repo);
    if (markdownTarget) {
      assertPutPageMarkdownContentMatchesTarget(content, markdownTarget);
    }
    let markdownWriteSnapshot: PutPageMarkdownSnapshot | null = null;
    let markdownFileWritten = false;
    const authorizationRealmId = memorySessionId ? (optionalPutPageString('realm_id', p.realm_id) ?? null) : null;
    const authorizationScopeId = memorySessionId ? (optionalPutPageString('scope_id', p.scope_id) ?? 'workspace:default') : null;
    const prevalidatedPutPage =
      memorySessionId || writeSessionId
        ? null
        : (() => {
            assertPutPageSourceAttribution(slug, content);
            return {
              audit: putPageAuditContext(p, preconditionSupplied),
              expectedContentHash: putPageExpectedContentHash(p.expected_content_hash ?? null),
            };
          })();
    let outcome: PutPageTransactionOutcome;
    try {
      outcome = await ctx.engine.transaction(async (tx) => {
        if (memorySessionId) {
          await assertPutPageMemoryWriteAllowed(tx, {
            memory_session_id: memorySessionId,
            realm_id: authorizationRealmId,
            scope_id: authorizationScopeId,
          });
          assertPutPageSourceAttribution(slug, content);
        }
        const resolvedWriteSession = writeSessionId
          ? await resolvePutPageWriteSession(tx, {
              writeSessionId,
              slug,
              content,
              params: p,
              authPrincipal: ctx.auth_principal,
              preconditionSupplied,
            })
          : null;
        if (writeSessionId && !memorySessionId) {
          assertPutPageSourceAttribution(slug, content);
        }
        const audit = resolvedWriteSession
          ? resolvedWriteSession.audit
          : prevalidatedPutPage
            ? prevalidatedPutPage.audit
            : putPageAuditContext(p, preconditionSupplied);
        const expectedContentHash = resolvedWriteSession
          ? resolvedWriteSession.expectedContentHash
          : prevalidatedPutPage
            ? prevalidatedPutPage.expectedContentHash
            : putPageExpectedContentHash(p.expected_content_hash ?? null);
        const existing = expectedContentHash !== undefined ? await tx.getPageForUpdate(slug) : await tx.getPage(slug);
        const previousHash = existing?.content_hash ?? null;
        const markdownSnapshot = markdownTarget ? readMarkdownTargetSnapshot(markdownTarget) : null;
        const markdownContentHash = markdownTarget && markdownSnapshot ? hashMarkdownTargetSnapshot(markdownTarget, markdownSnapshot) : null;
        const conflictOutcome = async (
          statusReason: string,
          conflict: {
            slug: string;
            expectedContentHash: string | null;
            currentContentHash: string | null;
            conflictInfo: Record<string, unknown>;
          },
          error: OperationError,
        ): Promise<PutPageTransactionOutcome> => {
          if (!resolvedWriteSession) {
            return {
              kind: 'conflict',
              audit,
              conflict,
              error,
            };
          }
          const event = await recordPutPageConflictEvent(tx, audit, conflict);
          const consumed = await tx.consumeMemoryWriteSession(resolvedWriteSession.session.id, {
            status: 'superseded',
            consumed_by_event_id: event.id,
            status_reason: statusReason,
          });
          if (!consumed) {
            throw new OperationError('storage_error', `write session could not be consumed after put_page conflict: ${resolvedWriteSession.session.id}`);
          }
          return {
            kind: 'conflict',
            audit,
            conflict,
            conflictEventRecorded: true,
            error,
          };
        };

        if (expectedContentHash === null && existing) {
          return await conflictOutcome(
            'page_exists',
            {
              slug,
              expectedContentHash,
              currentContentHash: previousHash,
              conflictInfo: {
                reason: 'page_exists',
                expected_content_hash: null,
                current_content_hash: previousHash,
              },
            },
            new OperationError('write_conflict', `Page already exists for null expected content hash: ${slug}`),
          );
        }

        if (expectedContentHash !== undefined && expectedContentHash !== null && !existing) {
          return await conflictOutcome(
            'missing_page',
            {
              slug,
              expectedContentHash,
              currentContentHash: null,
              conflictInfo: {
                reason: 'missing_page',
                expected_content_hash: expectedContentHash,
              },
            },
            new OperationError('write_conflict', `Page not found for expected content hash: ${slug}`),
          );
        }

        if (expectedContentHash !== undefined && expectedContentHash !== null && previousHash !== expectedContentHash) {
          return await conflictOutcome(
            'content_hash_mismatch',
            {
              slug,
              expectedContentHash,
              currentContentHash: previousHash,
              conflictInfo: {
                reason: 'content_hash_mismatch',
                expected_content_hash: expectedContentHash,
                current_content_hash: previousHash,
              },
            },
            new OperationError('write_conflict', `content hash mismatch for ${slug}`),
          );
        }

        if (markdownTarget) {
          const markdownConflict = putPageMarkdownConflict({
            slug,
            existingPageHash: previousHash,
            expectedContentHash,
            markdownContentHash,
          });
          if (markdownConflict) {
            const markdownConflictReason = String(markdownConflict.conflictInfo.reason ?? 'markdown_conflict');
            return await conflictOutcome(
              markdownConflictReason,
              {
                slug,
                expectedContentHash: markdownConflict.expectedContentHash,
                currentContentHash: markdownConflict.currentContentHash,
                conflictInfo: markdownConflict.conflictInfo,
              },
              new OperationError(
                'write_conflict',
                markdownConflict.message,
                'Run mbrain import for the markdown repo or merge the file changes before retrying put_page.',
              ),
            );
          }
        }

        if (resolvedWriteSession) {
          const metadataFailure = await validatePutPageWriteSessionPageMetadata(tx, {
            slug,
            content,
            existing,
          });
          if (metadataFailure) {
            await consumePutPageWriteSessionValidationFailure(tx, resolvedWriteSession.session, metadataFailure);
            return {
              kind: 'invalid' as const,
              error: new OperationError('invalid_params', metadataFailure.message),
            };
          }
        }
        const importContent =
          resolvedWriteSession && existing
            ? serializeMarkdown(existing.frontmatter ?? {}, parseMarkdown(content, `${slug}.md`).compiled_truth, existing.timeline ?? '', {
                type: existing.type,
                title: existing.title,
                tags: await tx.getTags(slug),
              })
            : content;

        const result = await (markdownTarget
          ? (() => {
              const preflightError = putPageMarkdownPreflightError(importContent);
              if (preflightError) {
                return {
                  slug,
                  status: 'skipped' as const,
                  chunks: 0,
                  error: preflightError,
                };
              }
              markdownWriteSnapshot = markdownSnapshot ?? readMarkdownTargetSnapshot(markdownTarget);
              if (shouldWriteMarkdownTarget(markdownWriteSnapshot, importContent)) {
                atomicWriteMarkdownTarget(markdownTarget, importContent);
                markdownFileWritten = true;
              }
              return importFromFile(tx, markdownTarget.filePath, markdownTarget.relativePath, {
                slugPrefix: markdownTarget.slugPrefix,
                deferDerived,
              });
            })()
          : importFromContent(tx, slug, importContent, { deferDerived }));
        if (result.status === 'imported') {
          const finalPage = await tx.getPage(slug);
          if (!finalPage?.content_hash) {
            throw new OperationError('storage_error', `put_page import did not produce a final content hash for ${slug}`);
          }
          const event = await recordMemoryMutationEvent(tx, {
            ...audit,
            operation: 'put_page',
            target_kind: 'page',
            target_id: slug,
            expected_target_snapshot_hash: expectedContentHash ?? previousHash,
            current_target_snapshot_hash: finalPage.content_hash,
            result: 'applied',
            conflict_info: null,
            dry_run: false,
          });
          if (resolvedWriteSession) {
            const consumed = await tx.consumeMemoryWriteSession(resolvedWriteSession.session.id, {
              status: 'applied',
              consumed_by_event_id: event.id,
              status_reason: 'put_page_applied',
            });
            if (!consumed) throw new OperationError('storage_error', `write session could not be consumed after put_page: ${resolvedWriteSession.session.id}`);
          }
        } else if (result.error) {
          const event = await recordMemoryMutationEvent(tx, {
            ...audit,
            operation: 'put_page',
            target_kind: 'page',
            target_id: slug,
            expected_target_snapshot_hash: expectedContentHash ?? previousHash,
            current_target_snapshot_hash: previousHash,
            result: 'failed',
            conflict_info: null,
            dry_run: false,
            metadata: {
              ...(audit.metadata ?? {}),
              import_status: result.status,
              error: result.error,
            },
          });
          if (resolvedWriteSession) {
            const consumed = await tx.consumeMemoryWriteSession(resolvedWriteSession.session.id, {
              status: 'abandoned',
              consumed_by_event_id: event.id,
              status_reason: 'put_page_import_failed',
            });
            if (!consumed)
              throw new OperationError('storage_error', `write session could not be consumed after put_page failure: ${resolvedWriteSession.session.id}`);
          }
        } else {
          const finalPage = await tx.getPage(slug);
          const currentHash = finalPage?.content_hash ?? previousHash;
          if (!currentHash) {
            throw new OperationError('storage_error', `put_page import skipped without a current content hash for ${slug}`);
          }
          const event = await recordMemoryMutationEvent(tx, {
            ...audit,
            operation: 'put_page',
            target_kind: 'page',
            target_id: slug,
            expected_target_snapshot_hash: expectedContentHash ?? previousHash,
            current_target_snapshot_hash: currentHash,
            result: 'applied',
            conflict_info: null,
            dry_run: false,
            metadata: {
              ...(audit.metadata ?? {}),
              import_status: result.status,
              skipped_reason: 'content_hash_unchanged',
            },
          });
          if (resolvedWriteSession) {
            const consumed = await tx.consumeMemoryWriteSession(resolvedWriteSession.session.id, {
              status: 'applied',
              consumed_by_event_id: event.id,
              status_reason: 'put_page_applied',
            });
            if (!consumed) throw new OperationError('storage_error', `write session could not be consumed after put_page: ${resolvedWriteSession.session.id}`);
          }
        }

        return { kind: 'result' as const, result };
      });
    } catch (error) {
      if (markdownTarget && markdownFileWritten && markdownWriteSnapshot) {
        restoreMarkdownTargetSnapshot(markdownTarget, markdownWriteSnapshot);
      }
      throw error;
    }

    if (outcome.kind === 'conflict') {
      if (outcome.conflictEventRecorded !== true) {
        await recordPutPageConflict(ctx.engine, outcome.audit, outcome.conflict);
      }
      throw outcome.error;
    }
    if (outcome.kind === 'invalid') {
      throw outcome.error;
    }
    return {
      ...putPageOperationResult(outcome.result),
      ...(possibleDuplicateOf.length > 0 ? { possible_duplicate_of: possibleDuplicateOf } : {}),
    };
  },
  cliHints: { name: 'put', positional: ['slug'], stdin: 'content' },
};

// CLI/admin repair-and-import variant of put_page. Identical write behavior, but it is NOT
// gated by the route_first precondition the MCP put_page surface enforces, so offline repair
// and bulk import can write without first observing every target. Tier admin (hidden from the
// default MCP catalog); use deliberately.
const admin_put_page: Operation = {
  name: 'admin_put_page',
  description:
    'CLI/admin repair-and-import variant of put_page that may omit the optimistic write precondition. Not subject to the route_first precondition enforced on the MCP put_page surface. Use only for offline repair and bulk import.',
  params: {
    ...put_page.params,
    expected_content_hash: {
      ...put_page.params.expected_content_hash,
      required: false,
      description:
        'Optional optimistic write precondition for admin repair/import writes. Existing page content_hash must match before writing; null requires that the page is absent.',
    },
  },
  mutating: true,
  tier: 'admin',
  handler: (ctx, p) => put_page.handler(ctx, { ...p, [ADMIN_PUT_PAGE_ROUTE_FIRST_BYPASS]: true }),
  cliHints: {
    name: 'admin-put',
    positional: ['slug'],
    stdin: 'content',
    hidden: true,
  },
};

function assertWritableSlugQuality(slug: string): void {
  const issues = findSlugQualityIssues(slug);
  if (issues.length === 0) return;

  const details = issues.map((issue) => `${issue.rule}: ${issue.message} ${issue.suggestion}`).join(' ');
  throw new OperationError('invalid_params', `put_page slug quality blocked for "${slug}". ${details}`);
}

export function createPutPageOperations(): Operation[] {
  return [put_page, admin_put_page];
}
