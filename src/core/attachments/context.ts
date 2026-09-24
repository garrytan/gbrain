import { createHash } from 'node:crypto';
import type { OperationContext } from '../ops/contract.ts';
import { OperationError } from '../ops/contract.ts';
import { assertSourceInCallerScope, enforceClientSlugFence, enforceSubagentSlugFence, federatedSearchScope, parseSourceIdParam, readPolicyOpts, validatePageSlug } from '../ops/context.ts';
import { pageMutationSource } from '../persistence/page-mutations.ts';
import { createStorage, type StorageConfig } from '../storage.ts';

export const CHUNK_BYTES = 256 * 1024;
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
export function fail(code: string, message: string): never { throw new OperationError(code, message); }
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) fail('invalid_params', 'A UUID request/upload ID is required.');
  return value.toLowerCase();
}
export function integer(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) fail('invalid_params', `Expected an integer between 0 and ${max}.`);
  return value;
}
export function owner(ctx: OperationContext): string {
  if (ctx.auth?.grantProjectionDegraded) fail('permission_denied', 'Cannot evaluate the current grant.');
  if (ctx.auth?.principal) return `${ctx.auth.principal.kind}:${ctx.auth.principal.id}`;
  if (ctx.auth?.clientId) return `client:${ctx.auth.clientId}`;
  if (ctx.auth?.token) return `token:${sha256(ctx.auth.token)}`;
  if (ctx.remote === false || ctx.transport === 'stdio') return 'local';
  return fail('permission_denied', 'An authenticated attachment client is required.');
}
export function storageConfig(ctx: OperationContext): StorageConfig {
  const config = ctx.config.storage;
  if (!config) fail('storage_error', 'Configure a storage backend before uploading attachments.');
  return config as StorageConfig;
}
export function storageIdentity(ctx: OperationContext): string {
  const c = storageConfig(ctx);
  // Credential rotation is safe; changing the storage destination is not.
  return sha256(JSON.stringify([c.backend, c.bucket, c.localPath ?? '', c.endpoint ?? '', c.region ?? '', c.projectUrl ?? '']));
}
export async function backend(ctx: OperationContext) { return createStorage(storageConfig(ctx)); }

export async function page(ctx: OperationContext, p: Record<string, unknown>, write: boolean) {
  owner(ctx);
  const slug = p.page_slug;
  if (typeof slug !== 'string') fail('invalid_params', 'page_slug is required.');
  validatePageSlug(slug);
  const source = write ? pageMutationSource(ctx, p, 'attachment') : parseSourceIdParam(p.source_id, 'attachment');
  if (source) assertSourceInCallerScope(ctx, source);
  if (write) {
    enforceClientSlugFence(ctx, slug, 'attachment');
    enforceSubagentSlugFence(ctx, slug, 'attachment');
  }
  const scope = write ? { sourceId: source } : federatedSearchScope(ctx, source);
  const policy = await readPolicyOpts(ctx, scope);
  const snapshot = await ctx.engine.readPageSnapshot(slug, { ...policy, resolveAlias: false });
  if (!snapshot) fail('not_found', 'Attachment or page not found.');
  const active = await ctx.engine.executeRaw('SELECT id FROM sources WHERE id=$1 AND archived IS NOT TRUE', [snapshot.page.source_id]);
  if (!active.length) fail('not_found', 'Attachment or page not found.');
  return snapshot.page;
}

export interface Upload {
  id: string; owner_key: string; source_id: string; page_id: number; filename: string;
  mime_type: string; size_bytes: number; sha256: string; storage_backend: string;
  storage_identity: string; storage_key: string; state: 'pending' | 'complete' | 'aborted'; file_id: number | null;
  expired: boolean; slug: string;
}
/** Caller must hold a transaction; serializes writes/commit/abort for this upload. */
export async function upload(ctx: OperationContext, id: unknown): Promise<Upload> {
  const rows = await ctx.engine.executeRaw<Upload>(`SELECT u.*, p.slug, (u.expires_at <= now()) AS expired
    FROM attachment_uploads u JOIN pages p ON p.id=u.page_id
    WHERE u.id=$1 AND u.owner_key=$2 FOR UPDATE OF u`, [uuid(id), owner(ctx)]);
  const row = rows[0];
  if (!row) fail('not_found', 'Attachment or page not found.');
  if (ctx.remote !== false && row.source_id !== (ctx.auth?.sourceId ?? ctx.sourceId ?? 'default')) fail('not_found', 'Attachment or page not found.');
  const target = await page(ctx, { page_slug: row.slug, source_id: row.source_id }, true);
  if (target.id !== row.page_id) fail('not_found', 'Attachment or page not found.');
  if (row.state === 'pending' && row.expired) fail('upload_expired', 'The upload expired; begin a new request.');
  if (row.storage_identity !== storageIdentity(ctx)) fail('storage_error', 'The storage destination changed during this upload.');
  return row;
}
export function receipt(row: Upload) {
  return { upload_id: row.id, state: row.state, attachment_id: row.file_id,
    filename: row.filename, size_bytes: row.size_bytes, sha256: row.sha256, chunk_bytes: CHUNK_BYTES };
}
