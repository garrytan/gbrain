import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import {
  createReadStream,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  type Stats,
} from 'fs';
import { basename, extname, join, relative, resolve } from 'path';
import { generateRawCanonicalDocumentDrafts, type RawCanonicalDocumentGenerationResult } from './raw-canonical-document-generator-service.ts';
import { buildRawIngestPlan } from '../source-registry/raw-ingest.ts';
import type { SourceKind } from '../source-registry/source-policy.ts';
import { getDefaultSourcePolicy } from '../source-registry/source-policy.ts';
import { slugifyPath } from '../sync.ts';
import type { PageType } from '../types.ts';

export const CANONICALIZE_PATH_SOURCE_KINDS = [
  'markdown_file',
  'document',
  'pdf',
  'code_repo',
] as const satisfies readonly SourceKind[];

export type CanonicalizePathSourceKind = typeof CANONICALIZE_PATH_SOURCE_KINDS[number];

export interface CanonicalizePathPreviewInput {
  path: string;
  target_slug?: string;
  title?: string;
  type?: PageType;
  source_kind?: CanonicalizePathSourceKind;
  now?: string;
}

export interface CanonicalizePathPreviewResult extends RawCanonicalDocumentGenerationResult {
  status: 'preview';
  preview_only: true;
  path: string;
  resolved_path: string;
  source_kind: CanonicalizePathSourceKind;
  source_id: string;
  source_item_id: string;
  source_item_title: string;
  source_content_hash: string;
  source_locator: string;
  source_updated_at: string;
  target_slug: string;
  safety_flags: string[];
  next_steps: string[];
}

interface SourceSnapshot {
  requestedPath: string;
  resolvedPath: string;
  relativeSourcePath: string;
  sourceKind: CanonicalizePathSourceKind;
  title: string;
  sourceLocator: string;
  sourceUpdatedAt: string;
  sourceContentHash: string;
  sourceVersion: string;
  sourcePaths: string[];
  dirtyFingerprint?: string;
  sourceRef: string;
  sourceId: string;
  externalId: string;
  rawChunks: string[];
  facts: string[];
  timelineEvents: string[];
  frontmatter: Record<string, unknown>;
  parserVersion: string;
  extractorVersion: string;
  warnings: string[];
}

interface RepoSummary {
  files: string[];
  fileCount: number;
  truncated: boolean;
  languages: string[];
  packageName?: string;
  testCommands: string[];
  contentFingerprint: string;
  dirtyFingerprint?: string;
  gitCommit?: string;
  gitBranch?: string;
  gitDirty?: boolean;
}

const MAX_TEXT_BYTES = 256_000;
const MAX_PACKAGE_JSON_BYTES = 1_000_000;
const MAX_REPO_FILES = 500;
const MAX_REPO_HASH_FILE_BYTES = 2_000_000;
const SUPPORTED_DOCUMENT_EXTENSIONS = new Set(['.txt', '.text']);
const SUPPORTED_MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown']);
const SKIPPED_REPO_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.cache',
  '.next',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
  'vendor',
]);

export async function previewCanonicalizePath(
  input: CanonicalizePathPreviewInput,
): Promise<CanonicalizePathPreviewResult> {
  const snapshot = await buildSourceSnapshot(input);
  const now = input.now ?? new Date().toISOString();
  const ingestPlan = buildRawIngestPlan({
    source_id: snapshot.sourceId,
    external_id: snapshot.externalId,
    origin_event: 'manual_entry',
    locator: snapshot.sourceLocator,
    title: snapshot.title,
    chunk_texts: snapshot.rawChunks.length > 0 ? snapshot.rawChunks : [snapshot.sourceRef],
    parser_version: snapshot.parserVersion,
    extractor_version: snapshot.extractorVersion,
    now,
    raw_text: snapshot.rawChunks.join('\n\n'),
  }, {
    ...getDefaultSourcePolicy(snapshot.sourceKind),
    consent_state: 'granted',
    enabled: true,
  });

  const safetyFlags = uniqueStrings(ingestPlan.chunks.flatMap((chunk) => chunk.sensitivity_flags));
  const sourceChunkIds = ingestPlan.chunks.map((chunk) => chunk.id);
  const safeFacts = safetyFlags.length > 0 ? [] : snapshot.facts;
  const safeTimelineEvents = safetyFlags.length > 0 ? [] : snapshot.timelineEvents;
  const targetSlug = input.target_slug?.trim() || (
    safetyFlags.length > 0 ? safeFallbackTargetSlug(snapshot) : defaultTargetSlug(snapshot)
  );
  const type = input.type ?? defaultPageType(snapshot.sourceKind);
  const generation = generateRawCanonicalDocumentDrafts({
    source_kind: snapshot.sourceKind,
    source_id: snapshot.sourceId,
    source_item_id: ingestPlan.item.id,
    source_item_title: snapshot.title,
    source_content_hash: snapshot.sourceContentHash,
    source_locator: snapshot.sourceLocator,
    source_updated_at: snapshot.sourceUpdatedAt,
    parser_version: snapshot.parserVersion,
    extractor_version: snapshot.extractorVersion,
    generator_version: 'canonicalize-path-preview:v1',
    now,
    documents: [{
      target_slug: targetSlug,
      type,
      title: snapshot.title,
      tags: tagsForSourceKind(snapshot.sourceKind),
      source_refs: [snapshot.sourceRef],
      source_chunk_ids: sourceChunkIds,
      facts: safeFacts,
      timeline_events: safeTimelineEvents,
      frontmatter: snapshot.frontmatter,
      safety_flags: safetyFlags,
    }],
  });

  return {
    status: 'preview',
    preview_only: true,
    path: safetyFlags.length > 0 ? '[redacted unsafe source path]' : snapshot.requestedPath,
    resolved_path: safetyFlags.length > 0 ? '[redacted unsafe source path]' : snapshot.resolvedPath,
    source_kind: snapshot.sourceKind,
    source_id: snapshot.sourceId,
    source_item_id: ingestPlan.item.id,
    source_item_title: safetyFlags.length > 0 ? 'Blocked unsafe source metadata' : snapshot.title,
    source_content_hash: snapshot.sourceContentHash,
    source_locator: snapshot.sourceLocator,
    source_updated_at: snapshot.sourceUpdatedAt,
    target_slug: targetSlug,
    safety_flags: safetyFlags,
    drafts: generation.drafts,
    warnings: uniqueStrings([...snapshot.warnings, ...generation.warnings]),
    next_steps: [
      'Review the draft markdown; no canonical memory was written.',
      'To save it, enrich the Markdown if needed and submit it through memory writeback or patch review.',
    ],
  };
}

async function buildSourceSnapshot(input: CanonicalizePathPreviewInput): Promise<SourceSnapshot> {
  const rawPath = input.path?.trim();
  if (!rawPath) throw new Error('path is required');
  const requestedPath = resolve(rawPath);
  if (!existsSync(requestedPath)) throw new Error(`path does not exist: ${rawPath}`);
  const initialStat = lstatSync(requestedPath);
  if (initialStat.isSymbolicLink()) throw new Error(`path must not be a symlink: ${rawPath}`);
  const resolvedPath = realpathSync(requestedPath);
  const stat = statSync(resolvedPath);
  const sourceKind = input.source_kind ?? detectSourceKind(resolvedPath, stat.isDirectory());
  if (!CANONICALIZE_PATH_SOURCE_KINDS.includes(sourceKind)) {
    throw new Error(`source_kind must be one of: ${CANONICALIZE_PATH_SOURCE_KINDS.join(', ')}`);
  }
  if (sourceKind === 'code_repo' && !stat.isDirectory()) {
    throw new Error('source_kind code_repo requires a directory path');
  }
  if (sourceKind !== 'code_repo' && stat.isDirectory()) {
    throw new Error(`source_kind ${sourceKind} requires a file path`);
  }

  if (sourceKind === 'code_repo') {
    return buildRepoSnapshot({ ...input, path: rawPath }, requestedPath, resolvedPath, stat.mtime.toISOString());
  }
  return buildFileSnapshot({ ...input, path: rawPath, source_kind: sourceKind }, requestedPath, resolvedPath, stat);
}

async function buildFileSnapshot(
  input: CanonicalizePathPreviewInput & { source_kind: CanonicalizePathSourceKind },
  requestedPath: string,
  resolvedPath: string,
  stat: Stats,
): Promise<SourceSnapshot> {
  const sourceKind = input.source_kind;
  const sourceContentHash = `sha256:${await sha256File(resolvedPath)}`;
  const safeTitle = input.title?.trim() || titleFromPath(resolvedPath);
  const sourceLocator = safeLocalLocator('file', resolvedPath);
  const sourceUpdatedAt = stat.mtime.toISOString();
  const relativeSourcePath = basename(resolvedPath);
  const sourceId = stableId('source', sourceKind, sourceLocator);
  const externalId = stableId('path', sourceLocator, sourceContentHash);
  const sourceRef = `${kindLabel(sourceKind)} "${safeTitle}", ${relativeSourcePath}, ${sourceContentHash}`;
  const baseFrontmatter = {
    source_kind: sourceKind,
    source_locator: sourceLocator,
    source_paths: [relativeSourcePath],
    source_version: sourceContentHash,
    file_size_bytes: stat.size,
  };

  if (sourceKind === 'pdf') {
    return {
      requestedPath: input.path,
      resolvedPath,
      relativeSourcePath,
      sourceKind,
      title: safeTitle,
      sourceLocator,
      sourceUpdatedAt,
      sourceContentHash,
      sourceVersion: sourceContentHash,
      sourcePaths: [relativeSourcePath],
      sourceRef,
      sourceId,
      externalId,
      rawChunks: [`PDF metadata: ${safeTitle} ${relativeSourcePath} ${sourceContentHash}`],
      facts: [
        `PDF document "${safeTitle}" was staged from a local file for canonical review.`,
        'PDF text extraction is not performed by this preview command.',
      ],
      timelineEvents: [`PDF document "${safeTitle}" was staged for canonical review.`],
      frontmatter: baseFrontmatter,
      parserVersion: 'canonicalize-path:file-metadata:v1',
      extractorVersion: 'canonicalize-path:pdf-metadata-only:v1',
      warnings: ['PDF text extraction is not performed; review and enrich the draft before writeback.'],
    };
  }

  const text = readUtf8FilePrefix(resolvedPath, MAX_TEXT_BYTES);
  const observations = observationsFromText(text.content);
  const warnings = text.truncated
    ? [`Text content was truncated to ${MAX_TEXT_BYTES} bytes for preview.`]
    : [];
  return {
    requestedPath: input.path,
    resolvedPath,
    relativeSourcePath,
    sourceKind,
    title: safeTitle,
    sourceLocator,
    sourceUpdatedAt,
    sourceContentHash,
    sourceVersion: sourceContentHash,
    sourcePaths: [relativeSourcePath],
    sourceRef,
    sourceId,
    externalId,
    rawChunks: [`File metadata: ${safeTitle} ${relativeSourcePath} ${sourceContentHash}`, text.content],
    facts: observations.facts.length > 0
      ? observations.facts
      : [`Document "${safeTitle}" was staged from a local file for canonical review.`],
    timelineEvents: [`Document "${safeTitle}" was staged for canonical review.`],
    frontmatter: baseFrontmatter,
    parserVersion: 'canonicalize-path:text-prefix:v1',
    extractorVersion: 'canonicalize-path:heuristic-observations:v1',
    warnings,
  };
}

function buildRepoSnapshot(
  input: CanonicalizePathPreviewInput,
  requestedPath: string,
  resolvedPath: string,
  sourceUpdatedAt: string,
): SourceSnapshot {
  const summary = summarizeRepo(resolvedPath);
  const title = input.title?.trim() || summary.packageName || basename(resolvedPath);
  const sourceLocator = safeLocalLocator('repo', resolvedPath);
  const manifestHash = `sha256:${sha256(JSON.stringify({
    files: summary.files,
    gitCommit: summary.gitCommit ?? null,
    gitDirty: summary.gitDirty ?? null,
    contentFingerprint: summary.contentFingerprint,
    dirtyFingerprint: summary.dirtyFingerprint ?? null,
    packageName: summary.packageName ?? null,
  }))}`;
  const sourceVersion = summary.gitCommit
    ? `${summary.gitCommit}${summary.gitDirty ? `+dirty.${summary.dirtyFingerprint ?? summary.contentFingerprint.slice(0, 12)}` : ''}`
    : `manifest:${manifestHash}`;
  const sourceId = stableId('source', 'code_repo', sourceLocator);
  const externalId = stableId('path', sourceLocator, sourceVersion);
  const sourceRef = summary.gitCommit
    ? `Code repository "${title}", commit ${summary.gitCommit}${summary.gitDirty ? ' (dirty)' : ''}`
    : `Code repository "${title}", ${basename(resolvedPath)}, ${manifestHash}`;
  const facts = [
    `Code repository "${title}" was staged from a local project path for canonical review.`,
    `The repository contains ${summary.fileCount} indexed files${summary.truncated ? `; the preview stopped at ${MAX_REPO_FILES} files` : ''}.`,
    ...(summary.languages.length > 0 ? [`The repository includes ${summary.languages.join(', ')} files.`] : []),
    ...(summary.packageName ? [`The repository declares package name "${summary.packageName}".`] : []),
    ...summary.testCommands.map((command) => `The repository declares test command "${command}".`),
    ...(summary.gitCommit ? [`The repository source version is commit ${summary.gitCommit}.`] : []),
  ];

  return {
    requestedPath: input.path,
    resolvedPath,
    relativeSourcePath: basename(resolvedPath),
    sourceKind: 'code_repo',
    title,
    sourceLocator,
    sourceUpdatedAt,
    sourceContentHash: manifestHash,
    sourceVersion,
    sourcePaths: summary.files,
    dirtyFingerprint: summary.dirtyFingerprint,
    sourceRef,
    sourceId,
    externalId,
    rawChunks: [
      `Repository ${title}`,
      `Files:\n${summary.files.slice(0, 100).join('\n')}`,
      summary.packageName ? `package.json name ${summary.packageName}` : '',
      summary.testCommands.length > 0 ? `test commands ${summary.testCommands.join(', ')}` : '',
    ].filter(Boolean),
    facts,
    timelineEvents: [`Code repository "${title}" was staged for canonical review.`],
    frontmatter: {
      source_kind: 'code_repo',
      source_locator: sourceLocator,
      source_paths: summary.files,
      source_version: sourceVersion,
      repo_path: basename(resolvedPath),
      source_commit: summary.gitCommit ?? null,
      source_branch: summary.gitBranch ?? null,
      source_dirty: summary.gitDirty ?? null,
      source_dirty_fingerprint: summary.dirtyFingerprint ?? null,
      source_content_fingerprint: summary.contentFingerprint,
      languages: summary.languages,
      package_name: summary.packageName ?? null,
      test_commands: summary.testCommands,
      file_count: summary.fileCount,
      file_list_truncated: summary.truncated,
    },
    parserVersion: 'canonicalize-path:repo-manifest:v1',
    extractorVersion: 'canonicalize-path:repo-heuristics:v1',
    warnings: summary.truncated
      ? [`Repository file listing was truncated at ${MAX_REPO_FILES} files.`]
      : [],
  };
}

function detectSourceKind(path: string, isDirectory: boolean): CanonicalizePathSourceKind {
  if (isDirectory) return 'code_repo';
  const ext = extname(path).toLowerCase();
  if (SUPPORTED_MARKDOWN_EXTENSIONS.has(ext)) return 'markdown_file';
  if (ext === '.pdf') return 'pdf';
  if (SUPPORTED_DOCUMENT_EXTENSIONS.has(ext)) return 'document';
  throw new Error(`unsupported extension for canonicalize preview: ${ext || '(none)'}`);
}

function defaultTargetSlug(snapshot: SourceSnapshot): string {
  const slug = slugifyPath(snapshot.title) || slugifyPath(snapshot.relativeSourcePath) || 'source';
  if (snapshot.sourceKind === 'code_repo') return `systems/${slug}`;
  if (snapshot.sourceKind === 'pdf') return `concepts/${slug}`;
  if (snapshot.sourceKind === 'markdown_file' || snapshot.sourceKind === 'document') return `concepts/${slug}`;
  return `concepts/${slug}`;
}

function safeFallbackTargetSlug(snapshot: SourceSnapshot): string {
  const digest = snapshot.sourceContentHash.replace(/^sha256:/, '').slice(0, 16);
  if (snapshot.sourceKind === 'code_repo') return `systems/source-${digest}`;
  return `sources/source-${digest}`;
}

function defaultPageType(kind: CanonicalizePathSourceKind): PageType {
  if (kind === 'code_repo') return 'system';
  if (kind === 'pdf') return 'source';
  return 'concept';
}

function tagsForSourceKind(kind: CanonicalizePathSourceKind): string[] {
  return ['raw-canonical-draft', kind.replace(/_/g, '-')];
}

function observationsFromText(text: string): { facts: string[] } {
  const headings = uniqueStrings(
    text
      .split(/\r?\n/)
      .map((line) => line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)?.[1]?.trim())
      .filter((value): value is string => Boolean(value))
      .slice(0, 5),
  );
  const firstSentence = firstPlainSentence(text);
  return {
    facts: [
      ...headings.map((heading) => `The document includes section "${sanitizeObservation(heading)}".`),
      ...(firstSentence ? [`The document states: "${sanitizeObservation(firstSentence)}".`] : []),
    ],
  };
}

function firstPlainSentence(text: string): string | null {
  const normalized = text
    .split(/\r?\n/)
    .filter((line) => !/^\s{0,3}#{1,6}\s+/.test(line))
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('```') && !line.startsWith('---'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  const match = normalized.match(/^(.{1,240}?[.!?])(?:\s|$)/);
  return (match?.[1] ?? normalized.slice(0, 180)).trim() || null;
}

function sanitizeObservation(value: string): string {
  return value.replace(/[`*_#[\]<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function summarizeRepo(root: string): RepoSummary {
  const files: string[] = [];
  collectRepoFiles(root, root, files);
  const packageJson = readPackageJson(root);
  const gitCommit = gitOutput(root, ['rev-parse', 'HEAD']);
  const gitBranch = gitOutput(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const dirty = gitCommit ? gitOutput(root, ['status', '--porcelain']) : null;
  const dirtyFingerprint = dirty && dirty.length > 0
    ? sha256(`${dirty}\n${gitOutput(root, ['diff', '--binary']) ?? ''}`)
    : undefined;
  const contentFingerprint = fingerprintRepoFiles(root, files);
  return {
    files,
    fileCount: files.length,
    truncated: files.length >= MAX_REPO_FILES,
    languages: languagesForFiles(files),
    packageName: packageJson.name,
    testCommands: packageJson.testCommands,
    contentFingerprint,
    dirtyFingerprint,
    gitCommit: gitCommit ?? undefined,
    gitBranch: gitBranch ?? undefined,
    gitDirty: dirty === null ? undefined : dirty.length > 0,
  };
}

function collectRepoFiles(root: string, dir: string, files: string[]): void {
  if (files.length >= MAX_REPO_FILES) return;
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (files.length >= MAX_REPO_FILES) return;
    if (SKIPPED_REPO_DIRS.has(entry.name)) continue;
    const fullPath = join(dir, entry.name);
    const relativePath = relative(root, fullPath).replace(/\\/g, '/');
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      collectRepoFiles(root, fullPath, files);
      continue;
    }
    if (!entry.isFile()) continue;
    files.push(relativePath);
  }
  files.sort();
}

function readPackageJson(root: string): { name?: string; testCommands: string[] } {
  const packageJsonPath = join(root, 'package.json');
  if (!existsSync(packageJsonPath)) return { testCommands: [] };
  const stat = statSync(packageJsonPath);
  if (stat.size > MAX_PACKAGE_JSON_BYTES) return { testCommands: [] };
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      name?: unknown;
      scripts?: Record<string, unknown>;
    };
    const testCommands = Object.entries(parsed.scripts ?? {})
      .filter(([name, value]) => name === 'test' && typeof value === 'string')
      .map(([, value]) => value as string);
    return {
      name: typeof parsed.name === 'string' ? parsed.name : undefined,
      testCommands,
    };
  } catch {
    return { testCommands: [] };
  }
}

function languagesForFiles(files: string[]): string[] {
  const names = new Set<string>();
  for (const file of files) {
    const ext = extname(file).toLowerCase();
    const name = ({
      '.js': 'JavaScript',
      '.jsx': 'JavaScript',
      '.ts': 'TypeScript',
      '.tsx': 'TypeScript',
      '.py': 'Python',
      '.go': 'Go',
      '.rs': 'Rust',
      '.java': 'Java',
      '.kt': 'Kotlin',
      '.swift': 'Swift',
      '.rb': 'Ruby',
      '.php': 'PHP',
      '.cs': 'C#',
      '.cpp': 'C++',
      '.c': 'C',
      '.h': 'C/C++',
      '.md': 'Markdown',
    } as Record<string, string>)[ext];
    if (name) names.add(name);
  }
  return [...names].sort();
}

function titleFromPath(path: string): string {
  const ext = extname(path);
  const raw = basename(path, ext);
  return raw
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (match) => match.toUpperCase())
    || basename(path);
}

function kindLabel(kind: CanonicalizePathSourceKind): string {
  if (kind === 'markdown_file') return 'Markdown file';
  if (kind === 'code_repo') return 'Code repository';
  if (kind === 'pdf') return 'PDF document';
  return 'Document';
}

function readUtf8FilePrefix(path: string, maxBytes: number): { content: string; truncated: boolean } {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    const bytesRead = readSync(fd, buffer, 0, maxBytes + 1, 0);
    const truncated = bytesRead > maxBytes;
    return {
      content: buffer.subarray(0, Math.min(bytesRead, maxBytes)).toString('utf8'),
      truncated,
    };
  } finally {
    closeSync(fd);
  }
}

function gitOutput(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    }).trim() || null;
  } catch {
    return null;
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', rejectPromise);
    stream.on('end', resolvePromise);
  });
  return hash.digest('hex');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}:${sha256(parts.join('\0')).slice(0, 24)}`;
}

function safeLocalLocator(kind: 'file' | 'repo', resolvedPath: string): string {
  return `local-${kind}:${sha256(resolvedPath).slice(0, 24)}`;
}

function fingerprintRepoFiles(root: string, files: string[]): string {
  const entries = files.map((file) => {
    const filePath = join(root, file);
    const stat = statSync(filePath);
    if (stat.size > MAX_REPO_HASH_FILE_BYTES) {
      return { path: file, size: stat.size, hash: `oversize:${stat.size}` };
    }
    return { path: file, size: stat.size, hash: sha256FileSync(filePath) };
  });
  return sha256(JSON.stringify(entries));
}

function sha256FileSync(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ''))];
}
