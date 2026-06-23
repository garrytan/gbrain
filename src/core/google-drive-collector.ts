import matter from 'gray-matter';
import { computeContentHash } from './ingestion/types.ts';
import { loadConfig } from './config.ts';
import type { BrainEngine } from './engine.ts';
import { operations, type OperationContext } from './operations.ts';
import { resolveSourceWithTier } from './source-resolver.ts';

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';
const DOC_MIME = 'application/vnd.google-apps.document';
const SHEET_MIME = 'application/vnd.google-apps.spreadsheet';
const SLIDE_MIME = 'application/vnd.google-apps.presentation';

const TEXT_MIMES = new Set([
  'text/plain',
  'text/markdown',
  'application/json',
]);

const METADATA_ONLY_MIMES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

const HIGH_SIGNAL_RE = /\b(owner|agreement|contract|signed|meeting|minutes|kickoff|prep|notes?|receipt|readback|capture|loop|packet|fill[- ]?out|property|redesign|listing|airbnb|guide|manual|sop|operations?|inspection|insurance|permit|license|hoa|pricing|rates?|calendar|task|follow[- ]?up|vendor|access|wifi)\b/i;
const LOW_SIGNAL_RE = /\b(photo|photos|image|images|screenshot|contact sheet|video|media|logo|brand assets?|archive|backup|raw|zip)\b/i;

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  webViewLink?: string;
  createdTime?: string;
  modifiedTime?: string;
  size?: string;
  shortcutDetails?: {
    targetId?: string;
    targetMimeType?: string;
  };
}

export interface DriveCollectedFile extends DriveFile {
  path: string;
  depth: number;
}

export interface DriveKeep {
  file: DriveCollectedFile;
  slug: string;
  reasons: string[];
  mode: 'text' | 'metadata_only';
}

export interface DriveSkip {
  file: DriveCollectedFile;
  reason: string;
}

export interface DriveIngestSummary {
  scanned: number;
  folders_scanned: number;
  kept: DriveKeep[];
  skipped: DriveSkip[];
  skipped_by_reason: Record<string, number>;
}

export interface DriveListClient {
  listFolder(folderId: string): Promise<DriveFile[]>;
  fetchText(file: DriveCollectedFile): Promise<string>;
}

export interface DriveWriteResult {
  written: number;
  slugs: string[];
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function extractDriveId(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Drive folder id or URL is required');
  const folderMatch = trimmed.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  if (folderMatch?.[1]) return folderMatch[1];
  const fileMatch = trimmed.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (fileMatch?.[1]) return fileMatch[1];
  const idParam = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idParam?.[1]) return idParam[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(trimmed)) return trimmed;
  throw new Error('Could not parse a Drive folder id from the provided value');
}

export function createGoogleDriveClient(opts: {
  accessToken: string;
  fetchImpl?: FetchLike;
}): DriveListClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers = { Authorization: `Bearer ${opts.accessToken}` };

  async function requestJson<T>(url: string): Promise<T> {
    const res = await fetchImpl(url, { headers });
    if (!res.ok) throw new Error(`Google Drive request failed (${res.status}): ${await res.text()}`);
    return await res.json() as T;
  }

  async function requestText(url: string): Promise<string> {
    const res = await fetchImpl(url, { headers });
    if (!res.ok) throw new Error(`Google Drive download failed (${res.status}): ${await res.text()}`);
    return await res.text();
  }

  return {
    async listFolder(folderId: string): Promise<DriveFile[]> {
      const files: DriveFile[] = [];
      let pageToken: string | undefined;
      do {
        const params = new URLSearchParams({
          q: `'${folderId}' in parents and trashed = false`,
          fields: 'nextPageToken,files(id,name,mimeType,webViewLink,createdTime,modifiedTime,size,shortcutDetails)',
          pageSize: '100',
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
        });
        if (pageToken) params.set('pageToken', pageToken);
        const body = await requestJson<{ files?: DriveFile[]; nextPageToken?: string }>(`${DRIVE_BASE}/files?${params}`);
        files.push(...(body.files ?? []));
        pageToken = body.nextPageToken;
      } while (pageToken);
      return files;
    },
    async fetchText(file: DriveCollectedFile): Promise<string> {
      if (file.mimeType === DOC_MIME) {
        return requestText(`${DRIVE_BASE}/files/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent('text/markdown')}`);
      }
      if (file.mimeType === SHEET_MIME) {
        return requestText(`${DRIVE_BASE}/files/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent('text/csv')}`);
      }
      if (file.mimeType === SLIDE_MIME) {
        return requestText(`${DRIVE_BASE}/files/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent('text/plain')}`);
      }
      return requestText(`${DRIVE_BASE}/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`);
    },
  };
}

export function resolveGoogleDriveAccessToken(env: Record<string, string | undefined> = process.env): string {
  const token = env.GBRAIN_GOOGLE_DRIVE_ACCESS_TOKEN || env.GOOGLE_DRIVE_ACCESS_TOKEN;
  if (!token) {
    throw new Error('Missing Google Drive access token. Set GBRAIN_GOOGLE_DRIVE_ACCESS_TOKEN for the narrow Drive ingest path.');
  }
  return token;
}

export async function collectDriveFolder(client: DriveListClient, rootFolderId: string, opts: {
  maxDepth?: number;
  maxFiles?: number;
} = {}): Promise<{ files: DriveCollectedFile[]; foldersScanned: number }> {
  const maxDepth = opts.maxDepth ?? 4;
  const maxFiles = opts.maxFiles ?? 500;
  const files: DriveCollectedFile[] = [];
  let foldersScanned = 0;

  async function visit(folderId: string, pathPrefix: string, depth: number): Promise<void> {
    if (depth > maxDepth || files.length >= maxFiles) return;
    foldersScanned++;
    const children = await client.listFolder(folderId);
    for (const child of children) {
      if (files.length >= maxFiles) break;
      const path = pathPrefix ? `${pathPrefix}/${child.name}` : child.name;
      const collected: DriveCollectedFile = { ...child, path, depth };
      files.push(collected);
      if (child.mimeType === FOLDER_MIME && !LOW_SIGNAL_RE.test(path)) {
        await visit(child.id, path, depth + 1);
      }
    }
  }

  await visit(rootFolderId, '', 0);
  return { files, foldersScanned };
}

export function classifyDriveFiles(files: DriveCollectedFile[]): DriveIngestSummary {
  const kept: DriveKeep[] = [];
  const skipped: DriveSkip[] = [];
  for (const file of files) {
    const verdict = classifyDriveFile(file);
    if (verdict.keep) kept.push(verdict.keep);
    else skipped.push({ file, reason: verdict.reason });
  }
  const skipped_by_reason: Record<string, number> = {};
  for (const skip of skipped) {
    skipped_by_reason[skip.reason] = (skipped_by_reason[skip.reason] ?? 0) + 1;
  }
  return {
    scanned: files.length,
    folders_scanned: 0,
    kept,
    skipped,
    skipped_by_reason,
  };
}

export async function scanDriveFolder(client: DriveListClient, rootFolderId: string, opts: {
  maxDepth?: number;
  maxFiles?: number;
} = {}): Promise<DriveIngestSummary> {
  const collected = await collectDriveFolder(client, rootFolderId, opts);
  const summary = classifyDriveFiles(collected.files);
  summary.folders_scanned = collected.foldersScanned;
  return summary;
}

function classifyDriveFile(file: DriveCollectedFile): { keep?: DriveKeep; reason: string } {
  const haystack = normalizeSignalText(file.path);
  if (file.mimeType === FOLDER_MIME) return { reason: 'folder' };
  if (file.mimeType === SHORTCUT_MIME) return { reason: 'shortcut' };
  if (LOW_SIGNAL_RE.test(haystack) || isMediaArchiveMime(file.mimeType)) return { reason: 'low-signal media/archive' };
  if (!isDocumentLike(file.mimeType)) return { reason: 'unsupported mime' };
  if (!HIGH_SIGNAL_RE.test(haystack)) return { reason: 'no high-signal keyword' };

  const reasons = highSignalReasons(file.path);
  const mode = isTextFetchable(file.mimeType) ? 'text' : 'metadata_only';
  return {
    reason: 'kept',
    keep: {
      file,
      slug: `drive/${slugPart(file.path)}-${computeContentHash(file.id).slice(0, 8)}`,
      reasons,
      mode,
    },
  };
}

function isDocumentLike(mimeType: string): boolean {
  return isTextFetchable(mimeType) || METADATA_ONLY_MIMES.has(mimeType);
}

function isMediaArchiveMime(mimeType: string): boolean {
  return mimeType.startsWith('image/')
    || mimeType.startsWith('video/')
    || mimeType.startsWith('audio/')
    || mimeType === 'application/zip'
    || mimeType === 'application/x-zip-compressed';
}

function isTextFetchable(mimeType: string): boolean {
  return mimeType === DOC_MIME || mimeType === SHEET_MIME || mimeType === SLIDE_MIME || TEXT_MIMES.has(mimeType);
}

function highSignalReasons(path: string): string[] {
  const lower = normalizeSignalText(path);
  const reasons = [
    /\b(owner|lead)\b/.test(lower) ? 'owner context' : null,
    /\b(meeting|minutes|kickoff|prep|notes?)\b/.test(lower) ? 'meeting context' : null,
    /\b(agreement|contract|signed|packet|fill[- ]?out)\b/.test(lower) ? 'document/contract context' : null,
    /\b(receipt|readback|capture|loop)\b/.test(lower) ? 'operator receipt/readback' : null,
    /\b(property|redesign|listing|airbnb)\b/.test(lower) ? 'property operations context' : null,
  ].filter(Boolean) as string[];
  return reasons.length > 0 ? reasons : ['high-signal title'];
}

export async function writeDriveScan(engine: BrainEngine, client: DriveListClient, summary: DriveIngestSummary, opts: {
  sourceId?: string;
} = {}): Promise<DriveWriteResult> {
  const putPageOp = operations.find((o) => o.name === 'put_page');
  if (!putPageOp) throw new Error('put_page operation missing');
  const cfg = loadConfig() ?? { engine: 'pglite' as const };
  const sourceId = opts.sourceId
    ?? (await resolveSourceWithTier(engine, undefined, process.cwd())).source_id;
  const ctx: OperationContext = {
    engine,
    config: cfg,
    logger: {
      info: (msg: string) => process.stderr.write(`[drive] ${msg}\n`),
      warn: (msg: string) => process.stderr.write(`[drive] WARN: ${msg}\n`),
      error: (msg: string) => process.stderr.write(`[drive] ERROR: ${msg}\n`),
    },
    dryRun: false,
    remote: false,
    sourceId,
  };

  const slugs: string[] = [];
  for (const keep of summary.kept) {
    const page = await drivePage(client, keep);
    await putPageOp.handler(ctx, {
      slug: page.slug,
      content: page.content,
      source_kind: 'google-drive',
      source_uri: page.sourceUri,
      ingested_via: 'google-drive',
      untrusted_payload: true,
    });
    slugs.push(page.slug);
  }
  return { written: slugs.length, slugs };
}

async function drivePage(client: DriveListClient, keep: DriveKeep): Promise<{ slug: string; content: string; sourceUri: string }> {
  const file = keep.file;
  let body: string;
  if (keep.mode === 'text') {
    const text = await client.fetchText(file);
    body = [
      `# ${file.name}`,
      '',
      `Drive path: ${file.path}`,
      `Drive URL: ${file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view`}`,
      '',
      '## Why saved',
      ...keep.reasons.map(r => `- ${r}`),
      '',
      '## Content',
      text.trim(),
    ].join('\n');
  } else {
    body = [
      `# ${file.name}`,
      '',
      `Drive path: ${file.path}`,
      `Drive URL: ${file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view`}`,
      file.size ? `Size: ${file.size} bytes` : '',
      '',
      '## Why saved',
      ...keep.reasons.map(r => `- ${r}`),
      '',
      '## Content status',
      'Metadata-only import. Binary/Office extraction is intentionally not part of this narrow Drive path yet.',
    ].filter(Boolean).join('\n');
  }
  const content = matter.stringify(body.trim() + '\n', {
    type: keep.reasons.includes('meeting context') ? 'meeting' : 'document',
    title: file.name,
    drive_file_id: file.id,
    drive_path: file.path,
    drive_mime_type: file.mimeType,
    drive_modified_at: file.modifiedTime,
    captured_via: 'google-drive',
  });
  return {
    slug: keep.slug,
    content,
    sourceUri: file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view`,
  };
}

export function printDriveSummary(summary: DriveIngestSummary, json = false): void {
  if (json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(`scanned: ${summary.scanned}`);
  console.log(`folders scanned: ${summary.folders_scanned}`);
  console.log(`kept useful docs: ${summary.kept.length}`);
  console.log(`skipped: ${summary.skipped.length}`);
  for (const [reason, count] of Object.entries(summary.skipped_by_reason).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason}: ${count}`);
  }
  if (summary.kept.length > 0) {
    console.log('kept:');
    for (const keep of summary.kept.slice(0, 25)) {
      console.log(`  ${keep.mode === 'metadata_only' ? '[metadata] ' : ''}${keep.file.path}`);
      console.log(`    ${keep.reasons.join(', ')}`);
    }
    if (summary.kept.length > 25) console.log(`  ... ${summary.kept.length - 25} more`);
  }
}

function slugPart(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90) || 'drive-file';
}

function normalizeSignalText(value: string): string {
  return value.toLowerCase().replace(/[_/.-]+/g, ' ');
}

export const __testing = {
  classifyDriveFile,
  slugPart,
  highSignalReasons,
  normalizeSignalText,
};
