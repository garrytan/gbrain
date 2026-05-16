import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { createHash, createHmac, randomBytes } from 'crypto';
import type { BrainEngine } from './engine.ts';
import type { Page, PageType } from './types.ts';
import { gbrainPath } from './config.ts';
import { stripFactsFence } from './facts-fence.ts';
import { stripTakesFence } from './takes-fence.ts';

export const COMPANY_SHARE_ROLE_KEY = 'company_share.role';
export const COMPANY_SHARE_SECRET_KEY = 'company_share.manifest_secret';

export type CompanyShareRole = 'individual' | 'company';
export type CompanyShareMode = 'private' | 'summary' | 'full';

export const COMPANY_SHARE_MODES: readonly CompanyShareMode[] = ['private', 'summary', 'full'] as const;

export interface CompanyShareRecord {
  member_id: string;
  source_id: string;
  slug: string;
  title: string;
  type: PageType;
  mode: Exclude<CompanyShareMode, 'private'>;
  updated_at: string;
  content_hash: string;
  content: string;
}

export interface CompanyShareManifest {
  manifest_version: 1;
  member_id: string;
  exported_at: string;
  source_ids: string[];
  page_count: number;
  page_hashes: Array<{ source_id: string; slug: string; content_hash: string; mode: Exclude<CompanyShareMode, 'private'> }>;
  signature: string;
}

export interface CompanyShareExport {
  manifest: CompanyShareManifest;
  records: CompanyShareRecord[];
  next_cursor: string | null;
}

export interface CompanyShareMember {
  id: string;
  issuer_url: string;
  mcp_url: string;
  oauth_client_id: string;
  oauth_client_secret?: string;
  manifest_secret: string;
  created_at: string;
  updated_at: string;
}

export interface CompanyShareMembersFile {
  version: 1;
  members: CompanyShareMember[];
}

export class CompanyShareError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CompanyShareError';
  }
}

const MEMBER_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,23}[a-z0-9])?$/;
const SOURCE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const DEFAULT_EXPORT_LIMIT = 100;
const MAX_EXPORT_LIMIT = 500;

export function normalizeShareMode(raw: unknown): CompanyShareMode {
  return typeof raw === 'string' && (COMPANY_SHARE_MODES as readonly string[]).includes(raw)
    ? raw as CompanyShareMode
    : 'private';
}

export function validateCompanyShareRole(raw: string): CompanyShareRole {
  if (raw === 'individual' || raw === 'company') return raw;
  throw new CompanyShareError('invalid_role', 'Role must be individual or company.');
}

export function validateMemberId(id: string): void {
  if (!MEMBER_ID_RE.test(id)) {
    throw new CompanyShareError(
      'invalid_member_id',
      'Member id must be 1-25 lowercase alnum chars with optional interior hyphens.',
    );
  }
}

export function memberSourceId(memberId: string): string {
  validateMemberId(memberId);
  return `member-${memberId}`;
}

function validateSourceId(id: string): void {
  if (!SOURCE_ID_RE.test(id)) {
    throw new CompanyShareError('invalid_source_id', 'Source id must be 1-32 lowercase alnum chars with optional interior hyphens.');
  }
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

function sourceDefaultMode(config: unknown): CompanyShareMode {
  const cfg = parseJsonObject(config);
  const share = parseJsonObject(cfg.company_share);
  return normalizeShareMode(share.default);
}

export function pageShareOverride(frontmatter: Record<string, unknown> | undefined): CompanyShareMode | null {
  if (!frontmatter) return null;
  const raw = frontmatter.company_share;
  if (typeof raw === 'string') {
    const mode = normalizeShareMode(raw);
    return mode === 'private' && raw !== 'private' ? null : mode;
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const mode = normalizeShareMode((raw as Record<string, unknown>).mode);
    return mode === 'private' && (raw as Record<string, unknown>).mode !== 'private' ? null : mode;
  }
  return null;
}

export function resolvePageShareMode(page: Page, sourceConfig: unknown): CompanyShareMode {
  return pageShareOverride(page.frontmatter) ?? sourceDefaultMode(sourceConfig);
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function signPayload(payload: Omit<CompanyShareManifest, 'signature'>, secret: string): string {
  return createHmac('sha256', secret).update(stableStringify(payload), 'utf8').digest('hex');
}

function stripScriptHtml(text: string): string {
  return text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '');
}

function stripSharePrivateBits(content: string): string {
  return content
    .replace(/^---[\s\S]*?---\n*/, '')
    .replace(/\s*\[Source:[^\]]*\]/g, '')
    .replace(/\*\*Confirmation:\*\*\s*[A-Z0-9]{6,}/gi, '**Confirmation:** on file')
    .replace(/Confirmation[:#]?\s*[A-Z0-9]{6,}/gi, 'Confirmation: on file')
    .replace(/\bconf\s*#?\s*[A-Z0-9]{6,}/gi, 'Confirmation: on file')
    .replace(/\[([^\]]+)\]\(\.[^)]*\/[^)]+\)/g, '$1')
    .replace(/^-?\s*See also:.*$/gm, '')
    .replace(/\n---\n\n## Timeline[\s\S]*$/, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function sanitizeCompanyShareContent(content: string): string {
  return stripScriptHtml(
    stripSharePrivateBits(
      stripFactsFence(
        stripTakesFence(content),
        { keepVisibility: ['world'] },
      ),
    ),
  ).trim();
}

function summarizeContent(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= 1200) return normalized;
  return `${normalized.slice(0, 1197).trimEnd()}...`;
}

async function fetchSourceConfig(engine: BrainEngine, sourceId: string): Promise<Record<string, unknown>> {
  const rows = await engine.executeRaw<{ config: unknown }>(
    `SELECT config FROM sources WHERE id = $1 AND archived IS NOT TRUE`,
    [sourceId],
  );
  if (!rows[0]) {
    throw new CompanyShareError('source_not_found', `Source "${sourceId}" not found.`);
  }
  return parseJsonObject(rows[0].config);
}

async function listSourceConfigs(engine: BrainEngine): Promise<Map<string, Record<string, unknown>>> {
  const rows = await engine.executeRaw<{ id: string; config: unknown }>(
    `SELECT id, config FROM sources WHERE archived IS NOT TRUE`,
  );
  const map = new Map<string, Record<string, unknown>>();
  for (const row of rows) map.set(row.id, parseJsonObject(row.config));
  return map;
}

export async function setCompanyShareRole(engine: BrainEngine, role: CompanyShareRole): Promise<void> {
  await engine.setConfig(COMPANY_SHARE_ROLE_KEY, role);
}

export async function getCompanyShareRole(engine: BrainEngine): Promise<CompanyShareRole> {
  const role = await engine.getConfig(COMPANY_SHARE_ROLE_KEY);
  return role === 'company' ? 'company' : 'individual';
}

export async function setCompanyShareSecret(engine: BrainEngine, secret?: string): Promise<string> {
  const value = secret && secret.trim() ? secret.trim() : randomBytes(32).toString('base64url');
  await engine.setConfig(COMPANY_SHARE_SECRET_KEY, value);
  return value;
}

async function requireCompanyShareSecret(engine: BrainEngine): Promise<string> {
  const secret = await engine.getConfig(COMPANY_SHARE_SECRET_KEY);
  if (!secret) {
    throw new CompanyShareError(
      'missing_manifest_secret',
      'No company share manifest secret configured. Run `gbrain company-share secret set --secret <shared-secret>` on the individual brain.',
    );
  }
  return secret;
}

export async function setSourceShareDefault(
  engine: BrainEngine,
  sourceId: string,
  mode: CompanyShareMode,
): Promise<{ source_id: string; mode: CompanyShareMode }> {
  validateSourceId(sourceId);
  const config = await fetchSourceConfig(engine, sourceId);
  const share = parseJsonObject(config.company_share);
  share.default = mode;
  config.company_share = share;
  await engine.executeRaw(
    `UPDATE sources SET config = $1::jsonb WHERE id = $2`,
    [JSON.stringify(config), sourceId],
  );
  return { source_id: sourceId, mode };
}

export async function setPageShareMode(
  engine: BrainEngine,
  slug: string,
  mode: CompanyShareMode,
  sourceId = 'default',
): Promise<{ source_id: string; slug: string; mode: CompanyShareMode }> {
  validateSourceId(sourceId);
  const page = await engine.getPage(slug, { sourceId });
  if (!page) throw new CompanyShareError('page_not_found', `Page not found: ${slug}`);
  await engine.putPage(slug, {
    type: page.type,
    title: page.title,
    compiled_truth: page.compiled_truth,
    timeline: page.timeline,
    content_hash: page.content_hash,
    frontmatter: {
      ...page.frontmatter,
      company_share: mode,
    },
  }, { sourceId });
  return { source_id: sourceId, slug, mode };
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = Number.parseInt(cursor, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new CompanyShareError('invalid_cursor', 'Invalid company-share export cursor.');
  }
  return n;
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit) || limit <= 0) return DEFAULT_EXPORT_LIMIT;
  return Math.min(Math.floor(limit), MAX_EXPORT_LIMIT);
}

export async function buildCompanyShareExport(
  engine: BrainEngine,
  opts: {
    memberId?: string;
    limit?: number;
    cursor?: string;
    sourceId?: string;
    sourceIds?: string[];
  } = {},
): Promise<CompanyShareExport> {
  const secret = await requireCompanyShareSecret(engine);
  const memberId = opts.memberId && opts.memberId.trim() ? opts.memberId.trim() : 'individual';
  validateMemberId(memberId);

  const sourceConfigs = await listSourceConfigs(engine);
  const pages: Page[] = [];
  const pageBatch = 500;
  for (let offset = 0; ; offset += pageBatch) {
    const batch = await engine.listPages({
      limit: pageBatch,
      offset,
      sort: 'slug',
      includeDeleted: false,
      ...(opts.sourceIds && opts.sourceIds.length > 0 ? { sourceIds: opts.sourceIds } : opts.sourceId ? { sourceId: opts.sourceId } : {}),
    });
    pages.push(...batch);
    if (batch.length < pageBatch) break;
  }

  const approved: CompanyShareRecord[] = [];
  for (const page of pages) {
    const sourceConfig = sourceConfigs.get(page.source_id) ?? {};
    const mode = resolvePageShareMode(page, sourceConfig);
    if (mode === 'private') continue;
    const sanitized = sanitizeCompanyShareContent(page.compiled_truth);
    const content = mode === 'summary' ? summarizeContent(sanitized) : sanitized;
    const contentHash = sha256(stableStringify({
      member_id: memberId,
      source_id: page.source_id,
      slug: page.slug,
      mode,
      title: page.title,
      type: page.type,
      content,
    }));
    approved.push({
      member_id: memberId,
      source_id: page.source_id,
      slug: page.slug,
      title: page.title,
      type: page.type,
      mode,
      updated_at: page.updated_at.toISOString(),
      content_hash: contentHash,
      content,
    });
  }

  const start = decodeCursor(opts.cursor);
  const limit = clampLimit(opts.limit);
  const records = approved.slice(start, start + limit);
  const next = start + limit < approved.length ? String(start + limit) : null;
  const payload: Omit<CompanyShareManifest, 'signature'> = {
    manifest_version: 1,
    member_id: memberId,
    exported_at: new Date().toISOString(),
    source_ids: Array.from(new Set(records.map(r => r.source_id))).sort(),
    page_count: records.length,
    page_hashes: records.map(r => ({
      source_id: r.source_id,
      slug: r.slug,
      content_hash: r.content_hash,
      mode: r.mode,
    })),
  };
  return {
    manifest: {
      ...payload,
      signature: signPayload(payload, secret),
    },
    records,
    next_cursor: next,
  };
}

export function verifyCompanyShareExport(
  exported: CompanyShareExport,
  member: Pick<CompanyShareMember, 'id' | 'manifest_secret'>,
): void {
  if (exported.manifest.manifest_version !== 1) {
    throw new CompanyShareError('invalid_manifest', 'Unsupported company-share manifest version.');
  }
  if (exported.manifest.member_id !== member.id) {
    throw new CompanyShareError('member_mismatch', `Export member_id "${exported.manifest.member_id}" does not match registry member "${member.id}".`);
  }
  if (exported.manifest.page_count !== exported.records.length) {
    throw new CompanyShareError('manifest_count_mismatch', 'Export manifest page_count does not match records length.');
  }
  const { signature, ...payload } = exported.manifest;
  const expected = signPayload(payload, member.manifest_secret);
  if (signature !== expected) {
    throw new CompanyShareError('signature_mismatch', 'Company-share export manifest signature did not validate.');
  }
  const hashes = new Map(exported.manifest.page_hashes.map(h => [`${h.source_id}\n${h.slug}`, h]));
  for (const record of exported.records) {
    if (record.member_id !== member.id) {
      throw new CompanyShareError('record_member_mismatch', `Export record member_id "${record.member_id}" does not match registry member "${member.id}".`);
    }
    const hash = hashes.get(`${record.source_id}\n${record.slug}`);
    if (!hash || hash.content_hash !== record.content_hash || hash.mode !== record.mode) {
      throw new CompanyShareError('record_hash_mismatch', `Export record hash mismatch for ${record.source_id}:${record.slug}.`);
    }
  }
}

export function membersRegistryPath(): string {
  return gbrainPath('company-share-members.json');
}

export function loadCompanyShareMembers(): CompanyShareMembersFile {
  const path = membersRegistryPath();
  if (!existsSync(path)) return { version: 1, members: [] };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as CompanyShareMembersFile;
  if (parsed.version !== 1 || !Array.isArray(parsed.members)) {
    throw new CompanyShareError('invalid_members_registry', `Invalid company share member registry at ${path}.`);
  }
  return parsed;
}

function saveCompanyShareMembers(file: CompanyShareMembersFile): void {
  const path = membersRegistryPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
}

export function upsertCompanyShareMember(
  input: {
    id: string;
    issuerUrl: string;
    mcpUrl: string;
    oauthClientId: string;
    oauthClientSecret?: string;
    manifestSecret: string;
  },
): CompanyShareMember {
  validateMemberId(input.id);
  if (!input.issuerUrl || !input.mcpUrl || !input.oauthClientId || !input.manifestSecret) {
    throw new CompanyShareError('invalid_member', 'Member requires issuer URL, MCP URL, OAuth client id, and manifest secret.');
  }
  const file = loadCompanyShareMembers();
  const now = new Date().toISOString();
  const existing = file.members.find(m => m.id === input.id);
  const member: CompanyShareMember = {
    id: input.id,
    issuer_url: input.issuerUrl.replace(/\/+$/, ''),
    mcp_url: input.mcpUrl,
    oauth_client_id: input.oauthClientId,
    ...(input.oauthClientSecret ? { oauth_client_secret: input.oauthClientSecret } : {}),
    manifest_secret: input.manifestSecret,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  file.members = existing
    ? file.members.map(m => m.id === input.id ? member : m)
    : [...file.members, member];
  file.members.sort((a, b) => a.id.localeCompare(b.id));
  saveCompanyShareMembers(file);
  return member;
}

export function removeCompanyShareMember(id: string): boolean {
  validateMemberId(id);
  const file = loadCompanyShareMembers();
  const before = file.members.length;
  file.members = file.members.filter(m => m.id !== id);
  saveCompanyShareMembers(file);
  return file.members.length !== before;
}

export async function ensureCompanyMemberSource(engine: BrainEngine, memberId: string): Promise<string> {
  const sourceId = memberSourceId(memberId);
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (id) DO NOTHING`,
    [sourceId, `Company share: ${memberId}`, JSON.stringify({ federated: true, company_share: { member_id: memberId } })],
  );
  return sourceId;
}

export async function importCompanyShareRecords(
  engine: BrainEngine,
  memberId: string,
  exports: CompanyShareExport[],
): Promise<{ member_id: string; source_id: string; imported: number; soft_deleted: number }> {
  const sourceId = await ensureCompanyMemberSource(engine, memberId);
  const visibleSlugs = new Set<string>();
  let imported = 0;

  for (const exported of exports) {
    for (const record of exported.records) {
      visibleSlugs.add(record.slug);
      const existing = await engine.getPage(record.slug, { sourceId, includeDeleted: true });
      const frontmatter = {
        ...(existing?.frontmatter ?? {}),
        company_share: {
          member_id: memberId,
          source_id: record.source_id,
          original_slug: record.slug,
          mode: record.mode,
          content_hash: record.content_hash,
          imported_at: new Date().toISOString(),
        },
      };
      if (existing?.deleted_at) {
        await engine.restorePage(record.slug, { sourceId });
      }
      if (existing?.content_hash === record.content_hash && existing.deleted_at == null) {
        continue;
      }
      await engine.putPage(record.slug, {
        type: record.type,
        title: record.title,
        compiled_truth: record.content,
        timeline: '',
        frontmatter,
        content_hash: record.content_hash,
      }, { sourceId });
      imported++;
    }
  }

  const current: Page[] = [];
  for (let offset = 0; ; offset += 500) {
    const batch = await engine.listPages({ sourceId, includeDeleted: false, limit: 500, offset, sort: 'slug' });
    current.push(...batch);
    if (batch.length < 500) break;
  }
  let softDeleted = 0;
  for (const page of current) {
    if (!visibleSlugs.has(page.slug)) {
      const result = await engine.softDeletePage(page.slug, { sourceId });
      if (result) softDeleted++;
    }
  }

  return { member_id: memberId, source_id: sourceId, imported, soft_deleted: softDeleted };
}

export function appendCompanyShareAudit(event: Record<string, unknown>): void {
  const path = gbrainPath('audit', 'company-share.jsonl');
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n', { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
}
