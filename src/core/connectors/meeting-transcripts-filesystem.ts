import {
  lstatSync,
  readFileSync,
  realpathSync,
  readdirSync,
  statSync,
} from 'fs';
import { basename, extname, isAbsolute, relative, sep } from 'path';
import { pathToFileURL } from 'url';
import type { ConnectorSourceItem } from './connector-sync.ts';

export const MEETING_TRANSCRIPT_MAX_BYTES = 5 * 1024 * 1024;

export type MeetingTranscriptSourceScope = 'file' | 'directory';
export type MeetingTranscriptSkipReason =
  | 'hidden_path'
  | 'unsupported_extension'
  | 'file_too_large'
  | 'empty_file'
  | 'symlink_not_followed';

export interface MeetingTranscriptSkippedFile {
  relative_path: string;
  reason: MeetingTranscriptSkipReason;
}

export interface MeetingTranscriptFilesystemTarget {
  input_path: string;
  source_scope: MeetingTranscriptSourceScope;
  source_root: string;
  source_locator: string;
  account_locator: string;
  display_name: string;
  path_display: string;
}

export interface MeetingTranscriptFilesystemLoad extends MeetingTranscriptFilesystemTarget {
  items: ConnectorSourceItem[];
  skipped_files: MeetingTranscriptSkippedFile[];
}

const SUPPORTED_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);

export function resolveMeetingTranscriptFilesystemTarget(path: string): MeetingTranscriptFilesystemTarget {
  if (!path) {
    throw new Error('Usage: mbrain connectors sync meeting_transcripts --path <file-or-directory>');
  }
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    throw new Error('meeting transcript path does not exist');
  }
  if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
    throw new Error('meeting transcript path must be a file or directory');
  }
  const realpath = realpathSync(path);
  const sourceScope: MeetingTranscriptSourceScope = stats.isDirectory() ? 'directory' : 'file';
  const sourceLocator = pathToFileURL(realpath).href;
  const displayName = `Meeting Transcripts: ${basename(realpath)}`;

  return {
    input_path: path,
    source_scope: sourceScope,
    source_root: realpath,
    source_locator: sourceLocator,
    account_locator: sourceLocator,
    display_name: displayName,
    path_display: displayPath(realpath),
  };
}

export function loadMeetingTranscriptFilesystemItems(input: { path: string }): MeetingTranscriptFilesystemLoad {
  const target = resolveMeetingTranscriptFilesystemTarget(input.path);
  const skippedFiles: MeetingTranscriptSkippedFile[] = [];
  const filePaths = target.source_scope === 'file'
    ? [target.source_root]
    : collectDirectoryFiles(target.source_root, target.source_root, skippedFiles);
  const items: ConnectorSourceItem[] = [];

  for (const filePath of filePaths) {
    const relativePath = normalizeRelativePath(
      target.source_scope === 'file'
        ? basename(filePath)
        : relative(target.source_root, filePath),
    );
    const ext = extname(filePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      skippedFiles.push({ relative_path: relativePath, reason: 'unsupported_extension' });
      continue;
    }

    const stats = statSync(filePath);
    if (stats.size === 0) {
      skippedFiles.push({ relative_path: relativePath, reason: 'empty_file' });
      continue;
    }
    if (stats.size > MEETING_TRANSCRIPT_MAX_BYTES) {
      skippedFiles.push({ relative_path: relativePath, reason: 'file_too_large' });
      continue;
    }

    const body = readFileSync(filePath, 'utf-8');
    items.push({
      external_id: relativePath,
      locator: target.source_scope === 'directory' ? relativePath : null,
      title: titleForTranscript(body, filePath),
      body,
      created_at: null,
      updated_at: stats.mtime.toISOString(),
      metadata_json: {
        relative_path: relativePath,
        extension: ext,
        file_size_bytes: stats.size,
        mtime_ms: stats.mtimeMs,
        path_display: displayPath(relativePath),
      },
    });
  }

  items.sort((a, b) => a.external_id.localeCompare(b.external_id));
  skippedFiles.sort((a, b) => a.relative_path.localeCompare(b.relative_path));

  return {
    ...target,
    items,
    skipped_files: skippedFiles,
  };
}

function collectDirectoryFiles(
  root: string,
  dir: string,
  skippedFiles: MeetingTranscriptSkippedFile[],
): string[] {
  const entries = readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = `${dir}${sep}${entry.name}`;
    const relativePath = normalizeRelativePath(relative(root, fullPath));
    if (isHiddenRelativePath(relativePath)) {
      skippedFiles.push({ relative_path: relativePath, reason: 'hidden_path' });
      continue;
    }
    if (entry.isSymbolicLink()) {
      skippedFiles.push({ relative_path: relativePath, reason: 'symlink_not_followed' });
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...collectDirectoryFiles(root, fullPath, skippedFiles));
      continue;
    }
    if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

function titleForTranscript(body: string, filePath: string): string {
  const frontmatterTitle = extname(filePath).toLowerCase() === '.txt'
    ? null
    : extractScalarFrontmatterTitle(body);
  return frontmatterTitle ?? basename(filePath, extname(filePath));
}

function extractScalarFrontmatterTitle(body: string): string | null {
  const normalized = body.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return null;
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) return null;
  const frontmatter = normalized.slice(4, end).split('\n');
  for (const line of frontmatter) {
    const match = line.match(/^title:\s*(.+?)\s*$/);
    if (!match) continue;
    const value = match[1]?.trim();
    if (!value) return null;
    return value.replace(/^['"]|['"]$/g, '');
  }
  return null;
}

function isHiddenRelativePath(path: string): boolean {
  return path.split('/').some(part => part.startsWith('.'));
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join('/');
}

function displayPath(path: string): string {
  return `.../${isAbsolute(path) ? basename(path) : normalizeRelativePath(path)}`;
}
