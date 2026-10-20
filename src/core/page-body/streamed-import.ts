/**
 * Streamed import of a Markdown file above the single-string ceiling (Wave B,
 * spec 3.1, integrator decision 1): with `pages.segmented_storage` on, a file
 * over `PAGE_MAX_BYTES` and at most `readPageBodyPolicy().maxBytes` is read
 * twice through one descriptor and never held as one string. Pass 1
 * (`BodyScanner`) parses the bounded head and decides the timeline split and
 * fence trust, and records the sha256 of each READ_BYTES block of the file;
 * pass 2 streams the stored regions through the segmenter, the hash and the
 * staging (`prepareSegmentedBody`), reading whole blocks and checking each
 * against its pass-1 digest, so a rewrite that keeps the size and mtime is
 * held rather than stored as a mix of both versions. The publication runs in one
 * maintenance transaction, as `importFromContent` does on an unmanaged brain.
 *
 * Every `importFromFile` / `importFromContent` step either runs here on the
 * head or per segment, or holds the file as `file_too_large` (today's refusal
 * of the same file), so nothing is stored that the string path would not store:
 *
 * - runs: symlink and malformed-path refusals; BOM strip; frontmatter
 *   inference (head: the first 20 lines must be in it); the frontmatter holds
 *   and the path-authoritative slug; gate-owned marker strip (a quarantine
 *   override binds the whole body, so it is dropped: fail closed); content
 *   sanity (junk patterns read a 2 KB head and the prose pass the head, middle
 *   and tail windows; size from the stored byte count, against
 *   `content_sanity.bytes_block` or, unset, the page ceiling `pages.max_bytes`);
 *   type preservation and subtype; provenance,
 *   effective date, tags, frontmatter aliases; the content hash (resumed per
 *   segment); the no-op skip; identity dedup by hash (an external `id` holds);
 *   code-reference edges (per line, skipped when the body has protected
 *   regions); the read-back check and the gate receipt.
 * - holds: a registered guardrail (it reads the whole payload); a write gate
 *   that applies to the source's tier; facts or takes
 *   fences (fence normalization, withdrawal and purge preservation parse the
 *   whole body); derived entity aliases (a linkable page type); NUL bytes (the
 *   size check needs the stored byte count before the hash); invalid UTF-8
 *   (the string path decodes it lossily); a deleted existing page (a restore
 *   rewrites it through the inline writer); a file that changes between passes.
 */
import { createHash, type Hash } from 'node:crypto';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { ImportResult } from '../import-file.ts';
import type { PreparedContentImport } from '../persistence/prepared-import.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { opError } from '../ops/contract.ts';
import { BodyScanner, type BodyPiece, type BodyScan } from './body-scan.ts';
import { FRONTMATTER_HEAD_MAX_BYTES, SEGMENT_MAX_BYTES, type PageBodyPolicy } from './limits.ts';
import { PAGE_MAX_BYTES } from '../page-size-policy.ts';
import { classifyImportHold, resolveParsedSubtype, type ParsedMarkdown } from '../markdown.ts';
import { loadImportSanityConfig, settleContentDisposition, stripGateOwnedMarkers } from '../import-screen.ts';
import { JUNK_SAMPLE_CHARS } from '../content-sanity.ts';
import { QUARANTINE_OVERRIDE_KEY } from '../quarantine-override.ts';
import { hasGuardrails } from '../guardrails.ts';
import { DEFAULT_WRITE_GATE_CONFIG, writeGateApplies } from '../write-gate.ts';
import { assertSourceFilePath, assertSourceFilesystemActive } from '../minions/source-filesystem.ts';
import { assertUnmanagedCanonicalWriter } from '../persistence/maintenance.ts';
import { maintenanceAttribution, maintenanceTransaction, ownerSourceGateInput, trustMarkerChanged, writeTrustOfGate } from '../persistence/attribution.ts';
import { assertImportBase } from '../page-state/import-guard.ts';
import { stabilizeSafetyAssessments } from '../persistence/reconcile-safety.ts';
import { collidingSlugOwner, decideImportIdentity, fileOriginUri } from '../import-identity.ts';
import { classifyStoredType } from '../schema-pack/type-usage.ts';
import { addPageTags } from '../page-state/tags.ts';
import { computeEffectiveDate, fallbackCreatedAt } from '../effective-date.ts';
import { writePageAliases } from '../mentions/pass.ts';
import { linkableTypesFor, readMentionPolicy, type PackTypes } from '../mentions/policy.ts';
import { resolveImportContextualMode } from '../import-contextual-mode.ts';
import { suffixedFrontmatterSlugHold } from '../persistence/suffixed-slug.ts';
import { logSlugFallback } from '../audit-slug-fallback.ts';
import { extractCodeRefs } from '../link-extraction.ts';
import { hasMalformedPathSegment, slugifyCodePath, slugifyPath } from '../sync.ts';
import { addCodeReferenceLinks } from '../engine-sql/links.ts';
import { isEmbedSkipped } from '../embed-skip.ts';
import { sanitizeText } from '../batch-rows.ts';
import { applySegmentedBody, sealSegmentedPage, segmentedLivePage } from '../persistence/segmented-apply.ts';
import { buildSegmentedProjection } from './projection.ts';
import { prepareSegmentedBody, segmentWriteScope, utf8Prefix, type SegmentedStagingOwner } from './ingest.ts';
import { readGarbageCollector } from './segment-blocks.ts';
import type { JsonObject } from './types.ts';

const READ_BYTES = 1024 * 1024;
const FENCE_MARKER = /gbrain:(facts|takes):begin/;

/**
 * @internal Work the checked reads after pass 1 do, for the drift test: file blocks read and hashed against their
 * pass-1 digests (`blocks`) and their bytes (`bytes`); and, for the scan memory test, the most file bytes pass 1
 * read between two full collections (`scanUncollected`). Counts, not time.
 */
export const streamedImportWork = { blocks: 0, bytes: 0, scanUncollected: 0 };

type StreamedImportOptions = {
  noEmbed?: boolean;
  inferFrontmatter?: boolean;
  sourceId?: string;
  forceRechunk?: boolean;
  activePack?: { page_types: ReadonlyArray<{ name: string; path_prefixes: ReadonlyArray<string>; aliases?: ReadonlyArray<string> }> };
  firstCommitAt?: Date;
  /**
   * A page write of the file's content (`gbrain put|capture --file` on the trusted local CLI), not a file import: the
   * file records no origin (no source_path or file source_uri), no other file's slug claim applies, the staging is a
   * `put`, and `head` replaces the file's first `skip` bytes after its BOM (capture's merged frontmatter). The
   * caller passes `<slug>.md` as the relative path.
   */
  content?: { head?: { skip: number; bytes: Uint8Array }; provenance?: { source_kind: string | null; source_uri: string | null; ingested_via: string | null };
    /**
     * A remote writer's page (commit_page_upload, upload-streamed.ts): `gate` names the tier the write gate assesses
     * from the page's frontmatter (put_page's, not the source owner's), gate-owned markers are stripped as put_page
     * strips them, and `stamp` writes the server's trust marker into the frontmatter.
     */
    writer?: { gate(frontmatter: Record<string, unknown>): Promise<StreamedGateInput>; stamp(frontmatter: Record<string, unknown>): void } };
  /**
   * A managed import's preparation (import-prepare.ts): the file must hash to
   * `sha256` (the admitted bytes), the page base is the caller's snapshot, and
   * instead of publishing, the prepared write goes to `prepare`, whose apply
   * runs in the coordinator's publication transaction.
   */
  coordinated?: { snapshot: PageSnapshot | null; owner: SegmentedStagingOwner; sha256: string;
    /** The admitted page (a managed sync's `row.slug`): the page that records the file as its origin, which may differ from the path's slug. */
    slug?: string;
    /** A managed sync rename: `snapshot` is the page at its old slug, which the publication moves here first; an implicit type follows the new path. */
    moved?: boolean;
    prepare(prepared: StreamedPreparedImport): Promise<ImportResult> };
};

/** The write gate's input for a streamed page: the tier it assesses and the write's origin. */
export type StreamedGateInput = Awaited<ReturnType<typeof ownerSourceGateInput>>;

/** A coordinated streamed import ready to publish: no parsed body strings exist, only the page's frontmatter. */
export type StreamedPreparedImport = Omit<PreparedContentImport, 'parsedPage'> & { frontmatter: Record<string, unknown> };

/** Today's refusal of a file over the single-string ceiling, naming the step that needs the whole body. */
function hold(slug: string, size: number, reason: string): ImportResult {
  const message = `File too large (${size} bytes, max ${PAGE_MAX_BYTES}): ${reason}, which needs the whole body as one string.`;
  return { slug, status: 'skipped', chunks: 0, error: message, refusal: { code: 'file_too_large', message }, skip_reason: 'file_too_large' };
}

/** Bytes `[start, end)` of the virtual stream: `prefix` (inferred frontmatter), then the file after its BOM. */
async function* readVirtual(file: FileHandle, bom: number, prefix: Uint8Array, start: number, end: number): AsyncIterable<Uint8Array> {
  if (start < prefix.length) yield prefix.subarray(start, Math.min(end, prefix.length));
  for (let at = Math.max(start, prefix.length); at < end;) {
    const buffer = Buffer.allocUnsafe(Math.min(READ_BYTES, end - at));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, at - prefix.length + bom);
    if (bytesRead === 0) throw new Error('The file shrank while it was imported.');
    yield buffer.subarray(0, bytesRead);
    at += bytesRead;
  }
}

/** sha256 of each READ_BYTES block of the file after its BOM, from pass 1's reads whatever their sizes. */
class BlockDigests {
  readonly digests: string[] = [];
  private hash = createHash('sha256');
  private filled = 0;

  push(bytes: Uint8Array): void {
    for (let at = 0; at < bytes.length;) {
      const take = Math.min(READ_BYTES - this.filled, bytes.length - at);
      this.hash.update(bytes.subarray(at, at + take));
      this.filled += take;
      at += take;
      if (this.filled === READ_BYTES) this.flush();
    }
  }

  end(): readonly string[] {
    if (this.filled) this.flush();
    return this.digests;
  }

  private flush(): void {
    this.digests.push(this.hash.digest('hex'));
    this.hash = createHash('sha256');
    this.filled = 0;
  }
}

/**
 * Bytes `[start, end)` of the virtual stream after pass 1, read in whole READ_BYTES blocks of the file; a block whose
 * sha256 differs from its pass-1 digest sets `drift.changed`, and the caller holds the import.
 */
async function* readChecked(file: FileHandle, bom: number, prefix: Uint8Array, size: number, digests: readonly string[], drift: { changed: boolean },
  start: number, end: number): AsyncIterable<Uint8Array> {
  if (start < prefix.length) yield prefix.subarray(start, Math.min(end, prefix.length));
  const from = Math.max(start, prefix.length) - prefix.length, to = end - prefix.length;
  for (let block = Math.floor(from / READ_BYTES); from < to && block * READ_BYTES < to; block++) {
    const offset = block * READ_BYTES;
    const buffer = Buffer.allocUnsafe(Math.min(READ_BYTES, size - bom - offset));
    for (let filled = 0; filled < buffer.length;) {
      const { bytesRead } = await file.read(buffer, filled, buffer.length - filled, bom + offset + filled);
      if (bytesRead === 0) throw new Error('The file shrank while it was imported.');
      filled += bytesRead;
    }
    streamedImportWork.blocks++;
    streamedImportWork.bytes += buffer.length;
    if (createHash('sha256').update(buffer).digest('hex') !== digests[block]) drift.changed = true;
    yield buffer.subarray(Math.max(from - offset, 0), Math.min(to - offset, buffer.length));
  }
}

/** One stored region: its pieces in order, NUL bytes stripped (`sanitizeText` on a valid UTF-8 stream), every chunk passed to `inspect`. */
async function* regionStream(pieces: readonly BodyPiece[], read: (start: number, end: number) => AsyncIterable<Uint8Array>,
  inspect: (bytes: Uint8Array) => void): AsyncIterable<Uint8Array> {
  for (const piece of pieces) {
    const parts = 'text' in piece ? [Buffer.from(sanitizeText(piece.text), 'utf8')] : read(piece.start, piece.end);
    for await (const part of parts) {
      const bytes = part.includes(0) ? part.filter(byte => byte !== 0) : part;
      inspect(bytes);
      yield bytes;
    }
  }
}

/**
 * Bytes `[from, from + max)` of a stored body as text, one window of the content-sanity sample (`sampleWindows`
 * cuts the same head, middle and tail of a string body); a code point cut at either end decodes as U+FFFD.
 */
async function bodyWindow(pieces: readonly BodyPiece[], read: (start: number, end: number) => AsyncIterable<Uint8Array>, from: number, max: number): Promise<string> {
  const parts: Buffer[] = [];
  let at = 0;
  for (const piece of pieces) {
    if (at >= from + max) break;
    const text = 'text' in piece ? Buffer.from(sanitizeText(piece.text), 'utf8') : null;
    const length = 'text' in piece ? text!.length : piece.end - piece.start;
    const start = Math.max(from, at), end = Math.min(from + max, at + length);
    if (start < end) {
      if ('text' in piece) parts.push(text!.subarray(start - at, end - at));
      else for await (const part of read(piece.start + start - at, piece.start + end - at)) parts.push(Buffer.from(part));
    }
    at += length;
  }
  return Buffer.concat(parts).toString('utf8');
}

/**
 * Code references by line (as `extractCodeRefs` over the whole body finds
 * them): complete lines are scanned as they arrive; a line longer than one
 * segment is skipped.
 */
class CodeRefLines {
  readonly refs = new Map<string, { path: string; line?: number }>();
  private carry = '';
  private readonly decoder = new TextDecoder('utf-8', { ignoreBOM: true });

  push(bytes: Uint8Array): void {
    const text = this.carry + this.decoder.decode(bytes, { stream: true });
    const cut = text.lastIndexOf('\n');
    if (cut < 0) { this.carry = text.length > SEGMENT_MAX_BYTES ? '' : text; return; }
    this.scan(text.slice(0, cut));
    this.carry = text.slice(cut + 1);
  }

  end(): void {
    this.scan(this.carry + this.decoder.decode());
    this.carry = '';
  }

  private scan(text: string): void {
    for (const ref of extractCodeRefs(text)) this.refs.set(`${ref.path}:${ref.line ?? ''}`, ref);
  }
}

/**
 * Pass 1 over the virtual stream; `prefix` is inferred frontmatter (empty when none). `hash` and `blocks` receive the
 * file's bytes after its BOM. A full collection every few MiB read (readGarbageCollector), as the staging batches
 * after it collect: each read leaves its buffer and the scanner's decoded text behind, and JSC's own collector rarely
 * runs during the pass, so a 32 MiB file's pass 1 left ~170 MiB of garbage under the first staging batch, the import's
 * peak; the peak grew with the file (segmented-ingest-memory: ~310 MiB above a 1 MiB import at 32 MiB, ~400 at 48 MiB;
 * ~230 at both with the collection).
 */
async function scanFile(file: FileHandle, bom: number, prefix: Uint8Array, size: number, relativePath: string, opts: StreamedImportOptions, hash: Hash | null,
  blocks: BlockDigests) {
  const scanner = new BodyScanner(relativePath, { validate: true, ...(opts.activePack ? { activePack: opts.activePack } : {}) });
  if (prefix.length) scanner.push(prefix);
  const collect = readGarbageCollector();
  let uncollected = 0;
  for await (const part of readVirtual(file, bom, new Uint8Array(0), 0, size - bom)) {
    hash?.update(part);
    blocks.push(part);
    scanner.push(part);
    uncollected += part.length;
    streamedImportWork.scanUncollected = Math.max(streamedImportWork.scanUncollected, uncollected);
    if (collect(part.length)) uncollected = 0;
  }
  return scanner.finish();
}

/** Frontmatter inference on the head, exactly as on the whole file when the head holds its first 20 lines; else null (undecidable). */
async function inferredPrefix(file: FileHandle, bom: number, size: number, relativePath: string): Promise<Uint8Array | null> {
  const buffer = Buffer.alloc(Math.min(FRONTMATTER_HEAD_MAX_BYTES, size - bom));
  await file.read(buffer, 0, buffer.length, bom);
  return inferredHeadPrefix(buffer, relativePath);
}

/**
 * The frontmatter inference would prepend to a file, from its head (at most FRONTMATTER_HEAD_MAX_BYTES after the BOM):
 * empty when no rule applies, null when the head does not hold the first 20 lines inference reads (undecidable).
 */
export async function inferredHeadPrefix(buffer: Uint8Array, relativePath: string): Promise<Uint8Array | null> {
  const raw = utf8Prefix(buffer, buffer.length);
  const head = raw.slice(0, raw.lastIndexOf('\n') + 1);
  if (head.split('\n').length <= 20 || !head.trim()) return null;
  const { applyInference } = await import('../frontmatter-inference.ts');
  const { content, inferred } = applyInference(relativePath, head);
  return Buffer.from(inferred.skipped ? '' : content.slice(0, content.length - head.length), 'utf8');
}

export async function importStreamedMarkdownFile(engine: BrainEngine, filePath: string, relativePath: string, opts: StreamedImportOptions,
  stat: { size: number; mtimeMs: number; birthtime: Date; mtime: Date }, policy: PageBodyPolicy): Promise<ImportResult> {
  if (hasMalformedPathSegment(relativePath)) {
    return { slug: '', status: 'skipped', skip_reason: 'malformed_path', chunks: 0,
      error: `Path "${relativePath}" contains bracket or control characters and cannot be imported. Rename the file to import it.` };
  }
  if (!opts.coordinated) await assertUnmanagedCanonicalWriter(engine, 'direct content import');
  const expectedSlug = slugifyPath(relativePath);
  const file = await open(assertSourceFilePath(filePath), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.size !== stat.size || opened.mtimeMs !== stat.mtimeMs) return hold(expectedSlug, stat.size, 'the file changed while it was opened');
    const size = opened.size;
    const bomBytes = Buffer.alloc(3);
    await file.read(bomBytes, 0, 3, 0);
    const bom = (bomBytes[0] === 0xef && bomBytes[1] === 0xbb && bomBytes[2] === 0xbf ? 3 : 0) + (opts.content?.head?.skip ?? 0);
    const prefix = opts.content?.head ? opts.content.head.bytes : opts.inferFrontmatter !== false ? await inferredPrefix(file, bom, size, relativePath) : new Uint8Array(0);
    if (!prefix) return hold(expectedSlug, size, 'frontmatter inference reads the first 20 lines, and they are not within the file head');
    const hash = opts.coordinated ? createHash('sha256').update(bomBytes.subarray(0, bom)) : null;
    const blocks = new BlockDigests();
    const scan = await scanFile(file, bom, prefix, size, relativePath, opts, hash, blocks);
    if (hash && hash.digest('hex') !== opts.coordinated!.sha256) throw opError('source_changed', 'The input file changed after import admission.',
      `${relativePath} no longer has the bytes its import request admitted, so the request published nothing. Import it again to publish the current bytes.`);
    if (scan.kind === 'frontmatter_head_unbounded') {
      return { slug: expectedSlug, status: 'skipped', chunks: 0, error: scan.message, refusal: { code: 'invalid_frontmatter', message: scan.message }, skip_reason: 'invalid_frontmatter' };
    }
    if (scan.kind === 'invalid_utf8') return hold(expectedSlug, size, `the file is not valid UTF-8 at byte ${scan.offset} (the text path decodes it lossily)`);
    return await importScanned(engine, { file, bom, prefix, size, digests: blocks.end(), scan, relativePath, filePath, expectedSlug, stat, policy, opts });
  } finally {
    await file.close();
  }
}

async function importScanned(engine: BrainEngine, input: { file: FileHandle; bom: number; prefix: Uint8Array; size: number; digests: readonly string[]; scan: BodyScan;
  relativePath: string; filePath: string; expectedSlug: string; stat: { mtimeMs: number; birthtime: Date; mtime: Date }; policy: PageBodyPolicy; opts: StreamedImportOptions }): Promise<ImportResult> {
  const { file, bom, prefix, size, digests, scan, relativePath, expectedSlug, opts } = input;
  const sourceId = opts.sourceId ?? 'default';
  const parsed = { ...scan.parsed, compiled_truth: '', timeline: '' } as ParsedMarkdown;
  const frontmatterHold = classifyImportHold(parsed);
  if (frontmatterHold) return { slug: expectedSlug, status: 'skipped', chunks: 0, error: frontmatterHold.message, refusal: frontmatterHold, skip_reason: 'invalid_frontmatter' };
  let slug = expectedSlug;
  if (!expectedSlug || parsed.slug !== expectedSlug) {
    if (!expectedSlug ? !parsed.slug : slugifyPath(parsed.slug) !== expectedSlug) {
      const { slugConflictHoldMessage } = await import('../import-file.ts');
      return !expectedSlug
        ? { slug: '', status: 'skipped', chunks: 0, error: `Filename "${relativePath}" produces no usable slug. Add a "slug:" to the frontmatter, or rename the file to include at least one letter or number (any script).` }
        : { slug: expectedSlug, status: 'skipped', chunks: 0, error: `Frontmatter slug "${parsed.slug}" does not match path-derived slug "${expectedSlug}" (from ${relativePath}). Remove the frontmatter "slug:" line or move the file.`,
          refusal: { code: 'frontmatter_slug_conflict', key: 'slug', message: slugConflictHoldMessage(relativePath, expectedSlug) }, skip_reason: 'frontmatter_slug_conflict' };
    }
    const suffixHold = await suffixedFrontmatterSlugHold(engine, sourceId, relativePath, parsed.slug);
    if (suffixHold) return { slug: expectedSlug, status: 'skipped', chunks: 0, error: suffixHold.message, refusal: suffixHold, skip_reason: suffixHold.code };
    slug = parsed.slug;
    logSlugFallback(slug, relativePath, expectedSlug ? 'normalization-equivalent identity restore' : 'path slugified empty');
  }
  slug = opts.coordinated?.slug ?? slug;
  if (hasGuardrails()) return hold(slug, size, 'a registered guardrail reads the whole payload');
  if (scan.bodyFlags.has_nul) return hold(slug, size, 'NUL bytes change the stored size the content gate measures');
  const drift = { changed: false };
  const read = (start: number, end: number) => readChecked(file, bom, prefix, size, digests, drift, start, end);
  parsed.title = sanitizeText(parsed.title);
  delete parsed.frontmatter[QUARANTINE_OVERRIDE_KEY];
  const writer = opts.content?.writer;
  const writeGate = writer ? await writer.gate(parsed.frontmatter) : await ownerSourceGateInput(engine, sourceId, parsed.frontmatter);
  stripGateOwnedMarkers(parsed, { preserveGateMarkers: !writer, writeGate });
  writer?.stamp(parsed.frontmatter);
  const sanity = await loadImportSanityConfig(engine);
  if (writeGateApplies(writeGate.tier, sanity.writeGate ?? DEFAULT_WRITE_GATE_CONFIG)) return hold(slug, size, `the write gate scans the whole body of a ${writeGate.tier} page`);
  const bodyBytes = scan.truthBytes + (scan.timelineBytes ? 1 + scan.timelineBytes : 0);
  const body: BodyPiece[] = [...scan.truth, ...(scan.timelineBytes ? [{ text: '\n' }, ...scan.timeline] : [])];
  const sample = [0, Math.floor((bodyBytes - JUNK_SAMPLE_CHARS) / 2), bodyBytes - JUNK_SAMPLE_CHARS];
  const windows = await Promise.all(sample.map(from => bodyWindow(body, read, from, JUNK_SAMPLE_CHARS)));
  const disposition = await settleContentDisposition(engine, { ...parsed, compiled_truth: windows.join(''), timeline: '' },
    { slug, sourceId, stripped: false, writeGate, bodyBytes, defaultBytesBlock: input.policy.maxBytes });
  const existing = opts.coordinated ? opts.coordinated.snapshot?.page ?? null : await engine.getPage(slug, { sourceId, includeDeleted: true });
  if (existing?.deleted_at) return hold(slug, size, 'restoring a deleted page rewrites its body through the inline writer');
  if (existing) stabilizeSafetyAssessments(parsed.frontmatter, existing.frontmatter);
  const sourceRoot = resolve(input.filePath, ...relativePath.split(/[\\/]/).map(() => '..'));
  const collisionOwner = opts.content ? null : collidingSlugOwner(existing, slug, sourceRoot, relativePath);
  if (collisionOwner) {
    process.stderr.write(`[import] slug collision: ${relativePath} and ${collisionOwner} both map to ${slug} in source ${sourceId}; keeping ${collisionOwner}. Rename one file to import both.\n`);
    return { slug, status: 'skipped', chunks: 0, skip_reason: 'slug_collision' };
  }
  if (parsed.typeExplicit !== true && existing && !opts.coordinated?.moved) parsed.type = existing.type;
  resolveParsedSubtype(parsed, existing);
  const typeClass = parsed.typeExplicit === true && opts.activePack ? classifyStoredType(parsed.type, opts.activePack) : null;
  const typeWarning = typeClass?.kind === 'alias_of' ? { kind: 'alias_of' as const, type: parsed.type, canonical: typeClass.canonical, directory: typeClass.directory }
    : typeClass?.kind === 'undeclared' ? { kind: 'undeclared' as const, type: parsed.type } : undefined;
  const mentionPolicy = await readMentionPolicy(engine).catch(() => null);
  if (mentionPolicy?.enabled && linkableTypesFor((opts.activePack as PackTypes | undefined) ?? null, mentionPolicy).includes(parsed.type)) {
    return hold(slug, size, `derived entity aliases of a ${parsed.type} page read the whole body`);
  }
  const fmId = (parsed.frontmatter as Record<string, unknown>).id;
  if (typeof fmId === 'string' && fmId.length > 0) return hold(slug, size, 'identity dedup by frontmatter id compares whole bodies');
  parsed.tags.sort();
  const { mode, corpusGeneration } = await resolveImportContextualMode(engine, sourceId, parsed.frontmatter, false);
  let owner: SegmentedStagingOwner;
  if (opts.coordinated) owner = opts.coordinated.owner;
  else {
    const { principal } = await maintenanceAttribution(engine);
    owner = { kind: opts.content ? 'put' : 'import', principalKind: principal.kind, principalId: principal.id, baseRevision: existing?.knowledge_revision ?? null };
  }
  const live = existing ? await segmentedLivePage(engine, Number(existing.id)) : null;
  let fenced = false;
  const codeRefs = new CodeRefLines();
  let carry = '';
  const inspect = (bytes: Uint8Array) => {
    const text = carry + Buffer.from(bytes).toString('latin1');
    if (FENCE_MARKER.test(text)) fenced = true;
    carry = text.slice(-24);
    codeRefs.push(bytes);
  };
  assertSourceFilesystemActive();
  const prepared = await prepareSegmentedBody(engine, { sourceId, slug, live, title: parsed.title, type: parsed.type, frontmatter: parsed.frontmatter as JsonObject,
    tags: parsed.tags, truth: regionStream(scan.truth, read, inspect),
    timeline: (async function* () { codeRefs.end(); carry = ''; yield* regionStream(scan.timeline, read, inspect); })(),
    hasTimeline: scan.timelineBytes > 0, flags: { fence_trust: scan.bodyFlags.fence_trust, timeline_fence_trust: scan.bodyFlags.timeline_fence_trust, timeline_split: scan.bodyFlags.timeline_split },
    declaredBytes: scan.truthBytes + scan.timelineBytes,
    owner,
    chunking: { quarantined: disposition.quarantined, corpusGeneration, tier: mode === 'title' ? 'title' : 'none' } });
  codeRefs.end();
  const abort = async () => { await engine.setBodyStagingState(prepared.stagingId, 'aborted').catch(() => undefined); };
  const after = await file.stat();
  if (drift.changed || after.size !== size || after.mtimeMs !== input.stat.mtimeMs) { await abort(); return hold(slug, size, 'the file changed while it was imported (import it again)'); }
  if (fenced) { await abort(); return hold(slug, size, 'facts and takes fences are normalized and checked against withdrawals over the whole body'); }
  const hash = prepared.body.content_hash;
  if (existing && !existing.deleted_at && !opts.forceRechunk && existing.content_hash === hash && existing.text_projection_revision === existing.knowledge_revision
    && isEmbedSkipped(existing.frontmatter) === isEmbedSkipped(parsed.frontmatter) && !trustMarkerChanged(existing.frontmatter, parsed.frontmatter)) {
    await abort();
    const skipped: ImportResult = { slug, status: 'skipped', chunks: 0, ...(typeWarning ? { type_warning: typeWarning } : {}) };
    return opts.coordinated ? opts.coordinated.prepare({ slug, observedRevision: opts.coordinated.snapshot?.revision ?? null, noop: true, result: skipped, frontmatter: parsed.frontmatter,
      validate: async () => {}, apply: async () => {} }) : skipped;
  }
  const identity = opts.coordinated?.moved || opts.content ? { kind: 'none' as const }
    : await decideImportIdentity(engine, { sourceId, slug, hash, frontmatterId: null, sourcePath: relativePath, sourceRoot, body: { title: parsed.title, compiled_truth: '', timeline: '' } });
  if (identity.kind === 'shared_hash') process.stderr.write(`[import] WARNING: ${relativePath} shares content_hash with ${identity.dupSlug} in source ${sourceId}. Indexing both.\n`);
  const nowDate = new Date();
  const { loadBrainTimeZone } = await import('../import-file.ts');
  const filename = opts.content ? slug.split('/').pop() ?? slug : basename(relativePath, '.md');
  const { date: effectiveDate, source: effectiveDateSource } = computeEffectiveDate({ slug, frontmatter: parsed.frontmatter, filename, timeZone: await loadBrainTimeZone(engine),
    updatedAt: existing?.updated_at ?? nowDate,
    createdAt: fallbackCreatedAt({ existing, fileTimes: { birthtime: input.stat.birthtime, mtime: input.stat.mtime, firstCommit: opts.firstCommitAt }, now: nowDate }) });
  const meta = { type: parsed.type, title: parsed.title, frontmatter: parsed.frontmatter as JsonObject, page_kind: 'markdown' as const,
    effective_date: effectiveDate, effective_date_source: effectiveDateSource, import_filename: filename,
    ...(opts.content ? { source_path: null, source_kind: null, source_uri: null, ingested_via: null, ...opts.content.provenance }
      : { source_path: relativePath, source_kind: null, source_uri: fileOriginUri(existing?.source_uri, sourceRoot, relativePath), ingested_via: null }) };
  const refs = prepared.body.body_flags.has_protected ? [] : [...codeRefs.refs.values()];
  const apply = async (tx: BrainEngine, preimage?: PageSnapshot | null) => {
    if (existing) await tx.createVersion(slug, preimage ? { sourceId, preimage } : { sourceId });
    const result = await applySegmentedBody(tx, { slug, sourceId, pageId: live?.id ?? null, prepared, meta, promotion: live?.storage === 'inline', retireMaxRows: input.policy.flipRetireMaxRows });
    await tx.updatePageContextualRetrievalState(slug, sourceId, mode, corpusGeneration);
    await tx.executeRaw(`DELETE FROM tags t USING pages p WHERE p.id = t.page_id AND p.source_id = $1 AND p.slug = $2
      AND t.tag_source = 'frontmatter' AND NOT (t.tag = ANY($3::text[]))`, [sourceId, slug, parsed.tags]);
    await addPageTags(tx, result.pageId, parsed.tags, 'frontmatter');
    await writePageAliases(tx, slug, sourceId, { ...parsed, compiled_truth: '', timeline: '' }, opts.activePack, mentionPolicy);
    if (result.complete) await sealSegmentedPage(tx, result.pageId);
    if (refs.length) {
      await tx.transaction(savepoint => addCodeReferenceLinks(savepoint, slug, sourceId,
        refs.map(ref => ({ codeSlug: slugifyCodePath(ref.path), path: ref.path, line: ref.line })))).catch(() => undefined);
    }
    const { verifyPageReadable } = await import('../import-file.ts');
    await verifyPageReadable(tx, slug, hash, sourceId, 'importStreamedMarkdownFile');
    await disposition.persistReceipt(tx, { existed: !!existing });
    return result;
  };
  const afterCommit = async (target: BrainEngine, applied: { pageId: number; complete: boolean }) => {
    if (!applied.complete) await buildSegmentedProjection(target, { sourceId, slug }).catch(() => undefined);
    await segmentWriteScope(target, sourceId).then(writes => writes(exec => exec.sweepSegments({ pageId: applied.pageId }))).catch(() => undefined);
  };
  const imported: ImportResult = { slug, status: 'imported', chunks: prepared.rows.chunks,
    ...(disposition.quarantined ? { quarantined: true } : {}), ...(disposition.flagged ? { flagged: true, flag_reason: disposition.flagReason } : {}),
    ...(disposition.gate ? { gate: disposition.gate } : {}), ...(typeWarning ? { type_warning: typeWarning } : {}) };
  if (opts.coordinated) {
    let applied: { pageId: number; complete: boolean } | null = null;
    return opts.coordinated.prepare({ slug, observedRevision: opts.coordinated.snapshot?.revision ?? null, noop: false, contentHash: hash, result: imported, frontmatter: parsed.frontmatter,
      validate: async () => {
        const now = await lstat(input.filePath);
        if (now.size !== size || now.mtimeMs !== input.stat.mtimeMs) throw opError('source_changed', 'The input file changed after import preparation.',
          `${relativePath} changed after its import request was prepared, so the request published nothing. Import it again to publish the current bytes.`);
      },
      apply: async (tx, preimage) => {
        applied = await apply(tx, preimage);
        return { pageId: applied.pageId, sealed: applied.complete, segmented: { complete: applied.complete } };
      },
      afterCommit: async target => { if (applied) await afterCommit(target, applied); } });
  }
  const applied = await maintenanceTransaction(engine, async tx => {
    await assertImportBase(tx, slug, sourceId, existing);
    return apply(tx);
  }, writeTrustOfGate(writeGate)).catch(async error => { await abort(); throw error; });
  await afterCommit(engine, applied);
  const { segmentedPageSearchable } = await import('../persistence/searchable.ts');
  return { ...imported, searchable: disposition.quarantined ? false : await segmentedPageSearchable(engine, sourceId, slug) };
}
