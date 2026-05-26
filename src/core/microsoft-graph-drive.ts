import { createHash } from 'crypto';
import { posix as pathPosix } from 'path';
import type { BrainEngine } from './engine.ts';
import { importFromContent } from './import-file.ts';
import { serializeMarkdown } from './markdown.ts';
import { executeRawJsonb } from './sql-query.ts';
import { slugifyPath } from './sync.ts';

export type GraphDriveProvider = 'onedrive' | 'sharepoint';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const SOURCE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const MAX_TEXT_BYTES = 5_000_000;

const DELTA_SELECT_FIELDS = [
  'id',
  'name',
  'webUrl',
  'eTag',
  'cTag',
  'size',
  'file',
  'folder',
  'deleted',
  'parentReference',
  'lastModifiedDateTime',
  'createdDateTime',
  'createdBy',
  'lastModifiedBy',
  '@microsoft.graph.downloadUrl',
];

const TEXT_EXTENSIONS = new Set([
  '.md', '.mdx', '.txt', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml',
  '.toml', '.xml', '.html', '.htm', '.css', '.sql', '.log',
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.cs', '.cpp', '.cc', '.cxx',
  '.hpp', '.hxx', '.hh', '.c', '.h', '.php', '.swift', '.kt', '.kts',
  '.scala', '.sc', '.lua', '.ex', '.exs', '.elm', '.ml', '.mli',
  '.dart', '.zig', '.sol', '.sh', '.bash', '.ps1',
]);

const CODE_FENCE_LANGUAGE: Record<string, string> = {
  '.ts': 'ts', '.tsx': 'tsx', '.mts': 'ts', '.cts': 'ts',
  '.js': 'js', '.jsx': 'jsx', '.mjs': 'js', '.cjs': 'js',
  '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust',
  '.java': 'java', '.cs': 'csharp', '.cpp': 'cpp', '.cc': 'cpp',
  '.cxx': 'cpp', '.hpp': 'cpp', '.hxx': 'cpp', '.hh': 'cpp',
  '.c': 'c', '.h': 'c', '.php': 'php', '.swift': 'swift',
  '.kt': 'kotlin', '.kts': 'kotlin', '.scala': 'scala', '.sc': 'scala',
  '.lua': 'lua', '.ex': 'elixir', '.exs': 'elixir', '.elm': 'elm',
  '.ml': 'ocaml', '.mli': 'ocaml', '.dart': 'dart', '.zig': 'zig',
  '.sol': 'solidity', '.sh': 'bash', '.bash': 'bash', '.ps1': 'powershell',
  '.css': 'css', '.html': 'html', '.htm': 'html', '.json': 'json',
  '.jsonl': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
  '.xml': 'xml', '.sql': 'sql', '.csv': 'csv', '.tsv': 'tsv',
};

export interface GraphIdentitySet {
  user?: { displayName?: string; email?: string; id?: string };
  application?: { displayName?: string; id?: string };
  device?: { displayName?: string; id?: string };
}

export interface GraphDriveItem {
  id: string;
  name?: string;
  webUrl?: string;
  eTag?: string;
  cTag?: string;
  size?: number;
  file?: { mimeType?: string; hashes?: Record<string, string> };
  folder?: Record<string, unknown>;
  deleted?: Record<string, unknown>;
  parentReference?: { id?: string; path?: string; driveId?: string; siteId?: string };
  lastModifiedDateTime?: string;
  createdDateTime?: string;
  createdBy?: GraphIdentitySet;
  lastModifiedBy?: GraphIdentitySet;
  '@microsoft.graph.downloadUrl'?: string;
}

export interface GraphDrive {
  id: string;
  name?: string;
  driveType?: string;
  webUrl?: string;
}

export interface GraphSite {
  id: string;
  name?: string;
  displayName?: string;
  webUrl?: string;
}

export interface GraphDriveSourceConfig {
  connector: 'microsoft-graph-drive';
  provider: GraphDriveProvider;
  drive_id: string;
  drive_name?: string;
  drive_type?: string;
  drive_web_url?: string;
  site_id?: string;
  site_name?: string;
  site_web_url?: string;
  delta_link?: string;
  delta_next_link?: string;
  federated?: boolean;
  last_sync_at?: string;
}

export interface RegisterGraphDriveSourceOpts {
  sourceId: string;
  name?: string;
  provider: GraphDriveProvider;
  drive: GraphDrive;
  site?: GraphSite;
  federated?: boolean;
}

export interface GraphDriveSyncOpts {
  sourceId: string;
  token: string;
  noEmbed?: boolean;
  dryRun?: boolean;
  limit?: number;
  resetDelta?: boolean;
  fetchImpl?: typeof fetch;
}

export interface GraphDriveSyncResult {
  source_id: string;
  provider: GraphDriveProvider;
  drive_id: string;
  status: 'synced' | 'dry_run';
  imported: number;
  metadata_only: number;
  deleted: number;
  skipped_folders: number;
  skipped_unsupported: number;
  errors: number;
  pages_affected: string[];
  delta_complete: boolean;
  next_link_saved: boolean;
  resyncs: number;
}

export class GraphDriveError extends Error {
  constructor(message: string, public code: string, public status?: number) {
    super(message);
    this.name = 'GraphDriveError';
  }
}

class GraphDriveResyncError extends GraphDriveError {
  constructor(public location: string | null) {
    super('Microsoft Graph delta token expired; a full delta resync is required.', 'delta_resync_required', 410);
    this.name = 'GraphDriveResyncError';
  }
}

interface DeltaResponse {
  value?: GraphDriveItem[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

interface ExistingGraphPage {
  slug: string;
  source_path: string | null;
}

function validateSourceId(id: string): void {
  if (!SOURCE_ID_RE.test(id)) {
    throw new GraphDriveError(
      `Invalid source id "${id}". Must be 1-32 lowercase alnum chars with optional interior hyphens.`,
      'invalid_source_id',
    );
  }
}

export function resolveGraphToken(env: Record<string, string | undefined> = process.env): string {
  const token = env.MICROSOFT_GRAPH_TOKEN ?? env.MS_GRAPH_TOKEN ?? env.GRAPH_ACCESS_TOKEN;
  if (!token) {
    throw new GraphDriveError(
      'Microsoft Graph token missing. Set MICROSOFT_GRAPH_TOKEN, MS_GRAPH_TOKEN, or GRAPH_ACCESS_TOKEN.',
      'missing_token',
    );
  }
  return token;
}

function graphUrl(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return GRAPH_BASE + (pathOrUrl.startsWith('/') ? pathOrUrl : '/' + pathOrUrl);
}

async function graphFetch(
  pathOrUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const url = graphUrl(pathOrUrl);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (new URL(url).hostname === 'graph.microsoft.com') {
    headers.Authorization = `Bearer ${token}`;
  }
  return fetchImpl(url, { headers });
}

export async function graphGetJson<T>(
  pathOrUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const res = await graphFetch(pathOrUrl, token, fetchImpl);
  if (res.status === 410) {
    throw new GraphDriveResyncError(res.headers.get('Location'));
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new GraphDriveError(
      `Microsoft Graph request failed: ${res.status} ${res.statusText}${body ? ` ${body.slice(0, 500)}` : ''}`,
      'graph_request_failed',
      res.status,
    );
  }
  return res.json() as Promise<T>;
}

async function graphGetBuffer(
  pathOrUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Buffer> {
  const url = graphUrl(pathOrUrl);
  const headers: Record<string, string> = {};
  if (new URL(url).hostname === 'graph.microsoft.com') {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetchImpl(url, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new GraphDriveError(
      `Microsoft Graph download failed: ${res.status} ${res.statusText}${body ? ` ${body.slice(0, 500)}` : ''}`,
      'graph_download_failed',
      res.status,
    );
  }
  return Buffer.from(await res.arrayBuffer());
}

function parseConfig(config: unknown): Record<string, unknown> {
  if (typeof config === 'string') {
    try { return JSON.parse(config) as Record<string, unknown>; } catch { return {}; }
  }
  if (typeof config === 'object' && config !== null) return config as Record<string, unknown>;
  return {};
}

function withoutUndefined<T extends Record<string, unknown>>(obj: T): T {
  for (const key of Object.keys(obj)) {
    if (obj[key] === undefined) delete obj[key];
  }
  return obj;
}

function sourceConfigFromRow(config: unknown): GraphDriveSourceConfig {
  const parsed = parseConfig(config);
  if (parsed.connector !== 'microsoft-graph-drive') {
    throw new GraphDriveError('Source is not a Microsoft Graph drive source.', 'not_graph_drive_source');
  }
  if (parsed.provider !== 'onedrive' && parsed.provider !== 'sharepoint') {
    throw new GraphDriveError('Microsoft Graph drive source has invalid provider.', 'invalid_provider');
  }
  if (typeof parsed.drive_id !== 'string' || parsed.drive_id.length === 0) {
    throw new GraphDriveError('Microsoft Graph drive source is missing drive_id.', 'missing_drive_id');
  }
  return parsed as unknown as GraphDriveSourceConfig;
}

export async function registerGraphDriveSource(
  engine: BrainEngine,
  opts: RegisterGraphDriveSourceOpts,
): Promise<GraphDriveSourceConfig> {
  validateSourceId(opts.sourceId);
  if (!opts.drive.id) {
    throw new GraphDriveError('Drive id is required.', 'missing_drive_id');
  }

  const existing = await engine.executeRaw<{ id: string; config: unknown }>(
    `SELECT id, config FROM sources WHERE id = $1`,
    [opts.sourceId],
  );
  if (existing.length > 0) {
    const cfg = parseConfig(existing[0].config);
    if (cfg.connector !== 'microsoft-graph-drive') {
      throw new GraphDriveError(
        `Source "${opts.sourceId}" already exists and is not a Microsoft Graph drive source.`,
        'source_id_taken',
      );
    }
  }

  const federated = opts.federated ?? true;
  const config: GraphDriveSourceConfig = withoutUndefined({
    connector: 'microsoft-graph-drive',
    provider: opts.provider,
    drive_id: opts.drive.id,
    drive_name: opts.drive.name,
    drive_type: opts.drive.driveType,
    drive_web_url: opts.drive.webUrl,
    federated,
    ...(opts.site ? {
      site_id: opts.site.id,
      site_name: opts.site.displayName ?? opts.site.name,
      site_web_url: opts.site.webUrl,
    } : {}),
  }) as GraphDriveSourceConfig;

  const displayName = opts.name ?? opts.drive.name ?? opts.sourceId;
  await executeRawJsonb(
    engine,
    `INSERT INTO sources (id, name, local_path, config, archived, archived_at, archive_expires_at)
       VALUES ($1, $2, NULL, $3::jsonb, false, NULL, NULL)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         local_path = NULL,
         config = EXCLUDED.config,
         archived = false,
         archived_at = NULL,
         archive_expires_at = NULL`,
    [opts.sourceId, displayName],
    [config],
  );
  return config;
}

export async function getOneDrive(
  token: string,
  driveId?: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GraphDrive> {
  return graphGetJson<GraphDrive>(
    driveId ? `/drives/${encodeURIComponent(driveId)}` : '/me/drive',
    token,
    fetchImpl,
  );
}

export function sitePathFromUrl(siteUrl: string): { hostname: string; relativePath: string } {
  const url = new URL(siteUrl);
  const relativePath = decodeURIComponent(url.pathname.replace(/\/+$/, ''));
  return {
    hostname: url.hostname,
    relativePath: relativePath === '' ? '/' : relativePath,
  };
}

export async function getSharePointSite(
  token: string,
  opts: { siteId?: string; siteUrl?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<GraphSite> {
  if (opts.siteId) {
    return graphGetJson<GraphSite>(`/sites/${encodeURIComponent(opts.siteId)}`, token, fetchImpl);
  }
  if (!opts.siteUrl) {
    throw new GraphDriveError('Pass --site-id or --site-url.', 'missing_site');
  }
  const { hostname, relativePath } = sitePathFromUrl(opts.siteUrl);
  if (relativePath === '/') {
    return graphGetJson<GraphSite>(`/sites/${hostname}:/`, token, fetchImpl);
  }
  return graphGetJson<GraphSite>(`/sites/${hostname}:${relativePath}`, token, fetchImpl);
}

export async function listSharePointDrives(
  token: string,
  siteId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GraphDrive[]> {
  const res = await graphGetJson<{ value?: GraphDrive[] }>(
    `/sites/${encodeURIComponent(siteId)}/drives`,
    token,
    fetchImpl,
  );
  return res.value ?? [];
}

export function chooseSharePointDrive(
  drives: GraphDrive[],
  opts: { driveId?: string; driveName?: string } = {},
): GraphDrive {
  if (opts.driveId) {
    const drive = drives.find(d => d.id === opts.driveId);
    if (!drive) throw new GraphDriveError(`Drive id "${opts.driveId}" not found on site.`, 'drive_not_found');
    return drive;
  }
  if (opts.driveName) {
    const wanted = opts.driveName.toLowerCase();
    const drive = drives.find(d => (d.name ?? '').toLowerCase() === wanted);
    if (!drive) throw new GraphDriveError(`Drive name "${opts.driveName}" not found on site.`, 'drive_not_found');
    return drive;
  }
  if (drives.length === 1) return drives[0];
  const documents = drives.find(d => (d.name ?? '').toLowerCase() === 'documents');
  if (documents) return documents;
  throw new GraphDriveError(
    `Site has ${drives.length} drives. Pass --drive-id or --drive-name.`,
    'ambiguous_drive',
  );
}

export function buildInitialDeltaUrl(driveId: string, top?: number): string {
  const params = new URLSearchParams();
  params.set('$select', DELTA_SELECT_FIELDS.join(','));
  if (top && top > 0) params.set('$top', String(top));
  return `/drives/${encodeURIComponent(driveId)}/root/delta?${params.toString()}`;
}

function identityLabel(identity?: GraphIdentitySet): string | undefined {
  return (
    identity?.user?.displayName ??
    identity?.user?.email ??
    identity?.application?.displayName ??
    identity?.device?.displayName
  );
}

export function driveItemRelativePath(item: GraphDriveItem, existingPath?: string | null): string {
  const name = item.name || item.id;
  const graphPath = item.parentReference?.path;
  if (graphPath) {
    const marker = ':/';
    const idx = graphPath.indexOf(marker);
    if (idx >= 0) {
      const parent = graphPath.slice(idx + marker.length).replace(/^\/+|\/+$/g, '');
      return parent ? `${parent}/${name}` : name;
    }
  }
  if (existingPath && existingPath.includes('/')) {
    return `${pathPosix.dirname(existingPath)}/${name}`;
  }
  return name;
}

function shortItemHash(itemId: string): string {
  return createHash('sha1').update(itemId).digest('hex').slice(0, 8);
}

export function slugForDriveItem(relPath: string, itemId: string): string {
  const base = slugifyPath(relPath);
  const suffix = shortItemHash(itemId);
  return base ? `${base}-${suffix}` : `microsoft-graph/${suffix}`;
}

export function isTextLikeDriveItem(item: GraphDriveItem): boolean {
  const ext = pathPosix.extname(item.name ?? '').toLowerCase();
  const mime = item.file?.mimeType?.toLowerCase() ?? '';
  return TEXT_EXTENSIONS.has(ext) || mime.startsWith('text/');
}

function fencedContentForPath(relPath: string, text: string): string {
  const ext = pathPosix.extname(relPath).toLowerCase();
  if (ext === '.md' || ext === '.mdx' || ext === '.txt' || ext === '') return text;
  const lang = CODE_FENCE_LANGUAGE[ext] ?? '';
  return `\`\`\`${lang}\n${text.replace(/```/g, '`\\`\\`')}\n\`\`\``;
}

export function buildGraphDriveMarkdown(
  item: GraphDriveItem,
  relPath: string,
  opts: {
    provider: GraphDriveProvider;
    driveId: string;
    driveName?: string;
    siteId?: string;
    siteName?: string;
    contentText?: string;
    metadataOnlyReason?: string;
  },
): string {
  const title = item.name ?? relPath;
  const tags = ['microsoft-graph', opts.provider];
  const frontmatter: Record<string, unknown> = {
    source: 'microsoft-graph',
    graph_provider: opts.provider,
    graph_drive_id: opts.driveId,
    graph_drive_name: opts.driveName,
    graph_site_id: opts.siteId,
    graph_site_name: opts.siteName,
    graph_item_id: item.id,
    graph_item_path: relPath,
    graph_item_web_url: item.webUrl,
    graph_parent_id: item.parentReference?.id,
    graph_etag: item.eTag,
    graph_ctag: item.cTag,
    graph_mime_type: item.file?.mimeType,
    graph_size: item.size,
    graph_created_at: item.createdDateTime,
    graph_modified_at: item.lastModifiedDateTime,
    graph_created_by: identityLabel(item.createdBy),
    graph_modified_by: identityLabel(item.lastModifiedBy),
  };
  for (const key of Object.keys(frontmatter)) {
    if (frontmatter[key] === undefined) delete frontmatter[key];
  }

  const facts = [
    `Microsoft Graph source: ${opts.provider}`,
    `Drive: ${opts.driveName ?? opts.driveId}`,
    opts.siteName ? `Site: ${opts.siteName}` : null,
    `Path: ${relPath}`,
    item.webUrl ? `Open in Microsoft 365: ${item.webUrl}` : null,
    item.lastModifiedDateTime ? `Modified: ${item.lastModifiedDateTime}` : null,
    identityLabel(item.lastModifiedBy) ? `Modified by: ${identityLabel(item.lastModifiedBy)}` : null,
    item.file?.mimeType ? `MIME type: ${item.file.mimeType}` : null,
    typeof item.size === 'number' ? `Size: ${item.size} bytes` : null,
  ].filter((line): line is string => Boolean(line));

  const bodyParts = [
    `# ${title}`,
    facts.join('\n'),
  ];

  if (opts.contentText !== undefined) {
    bodyParts.push('## Content', fencedContentForPath(relPath, opts.contentText));
  } else {
    bodyParts.push(
      '## Content',
      `Metadata indexed only. ${opts.metadataOnlyReason ?? 'Text extraction is not available for this file type yet.'}`,
    );
  }

  return serializeMarkdown(frontmatter, bodyParts.join('\n\n'), '', {
    type: 'note',
    title,
    tags,
  });
}

async function findExistingGraphPage(
  engine: BrainEngine,
  sourceId: string,
  itemId: string,
): Promise<ExistingGraphPage | null> {
  const rows = await engine.executeRaw<ExistingGraphPage>(
    `SELECT slug, source_path
       FROM pages
      WHERE source_id = $1
        AND frontmatter->>'graph_item_id' = $2
        AND deleted_at IS NULL
      LIMIT 1`,
    [sourceId, itemId],
  );
  return rows[0] ?? null;
}

async function deleteGraphItemPage(
  engine: BrainEngine,
  sourceId: string,
  itemId: string,
): Promise<string | null> {
  const existing = await findExistingGraphPage(engine, sourceId, itemId);
  if (!existing) return null;
  await engine.deletePage(existing.slug, { sourceId });
  return existing.slug;
}

async function downloadTextForItem(
  item: GraphDriveItem,
  driveId: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const size = item.size ?? 0;
  if (size > MAX_TEXT_BYTES) {
    throw new GraphDriveError(`File too large for text import (${size} bytes).`, 'file_too_large');
  }
  const downloadUrl =
    item['@microsoft.graph.downloadUrl'] ??
    `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(item.id)}/content`;
  const buf = await graphGetBuffer(downloadUrl, token, fetchImpl);
  if (buf.byteLength > MAX_TEXT_BYTES) {
    throw new GraphDriveError(`File too large for text import (${buf.byteLength} bytes).`, 'file_too_large');
  }
  return buf.toString('utf8').replace(/\u0000/g, '');
}

async function importGraphDriveItem(
  engine: BrainEngine,
  sourceId: string,
  cfg: GraphDriveSourceConfig,
  item: GraphDriveItem,
  opts: GraphDriveSyncOpts,
): Promise<{ slug: string; status: 'imported' | 'metadata_only' | 'skipped' }> {
  const existing = await findExistingGraphPage(engine, sourceId, item.id);
  const relPath = driveItemRelativePath(item, existing?.source_path);
  const slug = slugForDriveItem(relPath, item.id);
  let contentText: string | undefined;
  let metadataOnlyReason: string | undefined;

  if (isTextLikeDriveItem(item)) {
    try {
      contentText = await downloadTextForItem(item, cfg.drive_id, opts.token, opts.fetchImpl ?? fetch);
    } catch (err) {
      if (err instanceof GraphDriveError && err.code === 'file_too_large') {
        metadataOnlyReason = err.message;
      } else {
        throw err;
      }
    }
  } else {
    metadataOnlyReason = `Unsupported content type for text extraction: ${(item.file?.mimeType ?? pathPosix.extname(relPath)) || 'unknown'}.`;
  }

  const markdown = buildGraphDriveMarkdown(item, relPath, {
    provider: cfg.provider,
    driveId: cfg.drive_id,
    driveName: cfg.drive_name,
    siteId: cfg.site_id,
    siteName: cfg.site_name,
    contentText,
    metadataOnlyReason,
  });

  if (opts.dryRun) {
    return { slug, status: contentText === undefined ? 'metadata_only' : 'imported' };
  }

  if (existing && existing.slug !== slug) {
    await engine.deletePage(existing.slug, { sourceId });
  }

  const result = await importFromContent(engine, slug, markdown, {
    sourceId,
    noEmbed: opts.noEmbed,
    filename: pathPosix.basename(relPath, pathPosix.extname(relPath)),
    sourcePath: relPath,
  });
  if (result.status === 'skipped') return { slug, status: 'skipped' };
  return { slug, status: contentText === undefined ? 'metadata_only' : 'imported' };
}

async function readGraphDriveSource(
  engine: BrainEngine,
  sourceId: string,
): Promise<{ name: string; config: GraphDriveSourceConfig }> {
  const rows = await engine.executeRaw<{ name: string; config: unknown }>(
    `SELECT name, config FROM sources WHERE id = $1 AND archived IS NOT TRUE`,
    [sourceId],
  );
  if (rows.length === 0) {
    throw new GraphDriveError(`Source "${sourceId}" not found.`, 'source_not_found');
  }
  return { name: rows[0].name, config: sourceConfigFromRow(rows[0].config) };
}

async function writeGraphDriveSourceConfig(
  engine: BrainEngine,
  sourceId: string,
  config: GraphDriveSourceConfig,
): Promise<void> {
  await executeRawJsonb(
    engine,
    `UPDATE sources
        SET config = $2::jsonb,
            last_sync_at = now()
      WHERE id = $1`,
    [sourceId],
    [config],
  );
}

export async function syncGraphDriveSource(
  engine: BrainEngine,
  opts: GraphDriveSyncOpts,
): Promise<GraphDriveSyncResult> {
  validateSourceId(opts.sourceId);
  const { config } = await readGraphDriveSource(engine, opts.sourceId);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const result: GraphDriveSyncResult = {
    source_id: opts.sourceId,
    provider: config.provider,
    drive_id: config.drive_id,
    status: opts.dryRun ? 'dry_run' : 'synced',
    imported: 0,
    metadata_only: 0,
    deleted: 0,
    skipped_folders: 0,
    skipped_unsupported: 0,
    errors: 0,
    pages_affected: [],
    delta_complete: false,
    next_link_saved: false,
    resyncs: 0,
  };

  let url = opts.resetDelta
    ? buildInitialDeltaUrl(config.drive_id, opts.limit)
    : config.delta_next_link ?? config.delta_link ?? buildInitialDeltaUrl(config.drive_id, opts.limit);
  let nextLinkToSave: string | undefined;
  let deltaLinkToSave: string | undefined;
  let processed = 0;

  while (url) {
    let page: DeltaResponse;
    try {
      page = await graphGetJson<DeltaResponse>(url, opts.token, fetchImpl);
    } catch (err) {
      if (err instanceof GraphDriveResyncError) {
        result.resyncs++;
        url = err.location || buildInitialDeltaUrl(config.drive_id, opts.limit);
        continue;
      }
      throw err;
    }

    for (const item of page.value ?? []) {
      if (!item.id) continue;
      if (item.folder) {
        result.skipped_folders++;
        continue;
      }
      if (item.deleted) {
        if (!opts.dryRun) {
          const slug = await deleteGraphItemPage(engine, opts.sourceId, item.id);
          if (slug) result.pages_affected.push(slug);
        }
        result.deleted++;
        processed++;
        continue;
      }
      if (!item.file) {
        result.skipped_unsupported++;
        continue;
      }
      try {
        const imported = await importGraphDriveItem(engine, opts.sourceId, config, item, { ...opts, fetchImpl });
        if (imported.status === 'imported') result.imported++;
        if (imported.status === 'metadata_only') result.metadata_only++;
        if (imported.status !== 'skipped') result.pages_affected.push(imported.slug);
      } catch (err) {
        result.errors++;
        console.error(`[microsoft-drives] skipped ${item.name ?? item.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
      processed++;
    }

    if (page['@odata.nextLink']) {
      if (opts.limit && processed >= opts.limit) {
        nextLinkToSave = page['@odata.nextLink'];
        break;
      }
      url = page['@odata.nextLink'];
    } else {
      deltaLinkToSave = page['@odata.deltaLink'];
      url = '';
    }
  }

  result.delta_complete = Boolean(deltaLinkToSave);
  result.next_link_saved = Boolean(nextLinkToSave);
  if (!opts.dryRun) {
    const nextConfig: GraphDriveSourceConfig = {
      ...config,
      last_sync_at: new Date().toISOString(),
    };
    if (deltaLinkToSave) {
      nextConfig.delta_link = deltaLinkToSave;
      delete nextConfig.delta_next_link;
    } else if (nextLinkToSave) {
      nextConfig.delta_next_link = nextLinkToSave;
    }
    await writeGraphDriveSourceConfig(engine, opts.sourceId, nextConfig);
  }

  return result;
}
