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

export const LOCAL_FILE_CONNECTOR_MAX_BYTES = 5 * 1024 * 1024;

export type LocalFileConnectorId = 'chat_exports' | 'browser_bookmarks';
export type LocalFileSourceScope = 'file' | 'directory';
export type LocalFileSkipReason =
  | 'hidden_path'
  | 'unsupported_extension'
  | 'file_too_large'
  | 'empty_file'
  | 'symlink_not_followed'
  | 'parse_error';

export interface LocalFileSkippedFile {
  relative_path: string;
  reason: LocalFileSkipReason;
}

export interface LocalFileConnectorTarget {
  connector_id: LocalFileConnectorId;
  input_path: string;
  source_scope: LocalFileSourceScope;
  source_root: string;
  source_locator: string;
  account_locator: string;
  display_name: string;
  path_display: string;
}

export interface LocalFileConnectorLoad extends LocalFileConnectorTarget {
  items: ConnectorSourceItem[];
  skipped_files: LocalFileSkippedFile[];
}

type BrowserBookmarkNode = {
  type?: unknown;
  name?: unknown;
  url?: unknown;
  date_added?: unknown;
  children?: unknown;
};

const SUPPORTED_EXTENSIONS: Record<LocalFileConnectorId, Set<string>> = {
  chat_exports: new Set(['.json', '.md', '.markdown', '.txt']),
  browser_bookmarks: new Set(['.json']),
};

export function resolveLocalFileConnectorTarget(
  connectorId: LocalFileConnectorId,
  path: string,
): LocalFileConnectorTarget {
  if (!path) {
    throw new Error(`Usage: mbrain connectors sync ${connectorId} --path <file-or-directory>`);
  }
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    throw new Error(`${connectorId} path does not exist`);
  }
  if (stats.isSymbolicLink() || (!stats.isFile() && !stats.isDirectory())) {
    throw new Error(`${connectorId} path must be a file or directory`);
  }
  const realpath = realpathSync(path);
  const sourceScope: LocalFileSourceScope = stats.isDirectory() ? 'directory' : 'file';
  const sourceLocator = pathToFileURL(realpath).href;
  const label = connectorId === 'chat_exports' ? 'Chat Exports' : 'Browser Bookmarks';
  return {
    connector_id: connectorId,
    input_path: path,
    source_scope: sourceScope,
    source_root: realpath,
    source_locator: sourceLocator,
    account_locator: sourceLocator,
    display_name: `${label}: ${basename(realpath)}`,
    path_display: displayPath(realpath),
  };
}

export function loadLocalFileConnectorItems(input: {
  connector_id: LocalFileConnectorId;
  path: string;
}): LocalFileConnectorLoad {
  const target = resolveLocalFileConnectorTarget(input.connector_id, input.path);
  const skippedFiles: LocalFileSkippedFile[] = [];
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
    if (!SUPPORTED_EXTENSIONS[input.connector_id].has(ext)) {
      skippedFiles.push({ relative_path: relativePath, reason: 'unsupported_extension' });
      continue;
    }
    const stats = statSync(filePath);
    if (stats.size === 0) {
      skippedFiles.push({ relative_path: relativePath, reason: 'empty_file' });
      continue;
    }
    if (stats.size > LOCAL_FILE_CONNECTOR_MAX_BYTES) {
      skippedFiles.push({ relative_path: relativePath, reason: 'file_too_large' });
      continue;
    }
    const raw = readFileSync(filePath, 'utf-8');
    try {
      items.push(...parseConnectorFile(input.connector_id, {
        raw,
        file_path: filePath,
        relative_path: relativePath,
        extension: ext,
        size: stats.size,
        mtime: stats.mtime.toISOString(),
        mtime_ms: stats.mtimeMs,
      }));
    } catch {
      skippedFiles.push({ relative_path: relativePath, reason: 'parse_error' });
    }
  }

  items.sort((a, b) => a.external_id.localeCompare(b.external_id));
  skippedFiles.sort((a, b) => a.relative_path.localeCompare(b.relative_path));

  return {
    ...target,
    items,
    skipped_files: skippedFiles,
  };
}

function parseConnectorFile(
  connectorId: LocalFileConnectorId,
  input: {
    raw: string;
    file_path: string;
    relative_path: string;
    extension: string;
    size: number;
    mtime: string;
    mtime_ms: number;
  },
): ConnectorSourceItem[] {
  if (connectorId === 'chat_exports') return parseChatExportFile(input);
  return parseBrowserBookmarksFile(input);
}

function parseChatExportFile(input: {
  raw: string;
  file_path: string;
  relative_path: string;
  extension: string;
  size: number;
  mtime: string;
  mtime_ms: number;
}): ConnectorSourceItem[] {
  if (input.extension !== '.json') {
    const body = input.raw.trim();
    if (!body) return [];
    return [baseFileItem(input, {
      external_id: input.relative_path,
      locator: input.relative_path,
      title: titleFromTextFile(body, input.file_path),
      body,
      metadata_json: { message_count: null },
    })];
  }

  const parsed = JSON.parse(input.raw);
  const messages = Array.isArray(parsed?.messages)
    ? parsed.messages
    : Array.isArray(parsed)
      ? parsed
      : [];
  const lines: string[] = [];
  for (const message of messages) {
    const role = typeof message?.role === 'string' ? message.role : 'message';
    const content = stringifyMessageContent(message?.content ?? message?.text ?? message?.message);
    if (content.trim()) lines.push(`${role}: ${content.trim()}`);
  }
  const body = lines.length > 0 ? lines.join('\n\n') : input.raw.trim();
  if (!body) return [];
  const title = typeof parsed?.title === 'string' && parsed.title.trim()
    ? parsed.title.trim()
    : titleFromTextFile(body, input.file_path);
  return [baseFileItem(input, {
    external_id: input.relative_path,
    locator: input.relative_path,
    title,
    body,
    metadata_json: {
      message_count: messages.length,
    },
  })];
}

function parseBrowserBookmarksFile(input: {
  raw: string;
  file_path: string;
  relative_path: string;
  extension: string;
  size: number;
  mtime: string;
  mtime_ms: number;
}): ConnectorSourceItem[] {
  const parsed = JSON.parse(input.raw);
  const nodes = flattenBookmarkNodes(parsed?.roots ?? parsed);
  const items: ConnectorSourceItem[] = [];
  for (const node of nodes) {
    if (node.type !== 'url' || typeof node.url !== 'string' || !node.url.trim()) continue;
    const title = typeof node.name === 'string' && node.name.trim() ? node.name.trim() : node.url.trim();
    const url = node.url.trim();
    const body = [`Title: ${title}`, `URL: ${url}`].join('\n');
    items.push(baseFileItem(input, {
      external_id: `${input.relative_path}#${url}`,
      locator: url,
      title,
      body,
      created_at: chromeBookmarkTimestampToIso(node.date_added),
      metadata_json: {
        relative_path: input.relative_path,
        bookmark_url: url,
      },
    }));
  }
  return items;
}

function baseFileItem(
  input: {
    relative_path: string;
    extension: string;
    size: number;
    mtime: string;
    mtime_ms: number;
  },
  item: {
    external_id: string;
    locator?: string | null;
    title: string;
    body: string;
    created_at?: string | null;
    metadata_json?: Record<string, unknown>;
  },
): ConnectorSourceItem {
  return {
    external_id: item.external_id,
    locator: item.locator ?? null,
    title: item.title,
    body: item.body,
    created_at: item.created_at ?? null,
    updated_at: input.mtime,
    metadata_json: {
      relative_path: input.relative_path,
      extension: input.extension,
      file_size_bytes: input.size,
      mtime_ms: input.mtime_ms,
      path_display: displayPath(input.relative_path),
      ...item.metadata_json,
    },
  };
}

function flattenBookmarkNodes(value: unknown): BrowserBookmarkNode[] {
  const nodes: BrowserBookmarkNode[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const record = node as BrowserBookmarkNode & Record<string, unknown>;
    nodes.push(record);
    if (Array.isArray(record.children)) visit(record.children);
    for (const child of Object.values(record)) {
      if (child && typeof child === 'object' && child !== record.children) {
        if (Array.isArray(child) || 'children' in child || 'url' in child) visit(child);
      }
    }
  };
  visit(value);
  return nodes;
}

function collectDirectoryFiles(
  root: string,
  dir: string,
  skippedFiles: LocalFileSkippedFile[],
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
    if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

function stringifyMessageContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(stringifyMessageContent).filter(Boolean).join('\n');
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
  }
  return '';
}

function titleFromTextFile(body: string, filePath: string): string {
  const firstHeading = body.split(/\r?\n/).find(line => line.trim().startsWith('# '));
  if (firstHeading) return firstHeading.replace(/^#\s+/, '').trim();
  return basename(filePath, extname(filePath));
}

function chromeBookmarkTimestampToIso(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const microsSince1601 = Number(value);
  if (!Number.isFinite(microsSince1601)) return null;
  const epochOffsetMicros = 11644473600000000;
  const ms = Math.floor((microsSince1601 - epochOffsetMicros) / 1000);
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
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
