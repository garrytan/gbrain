import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { validateMountId } from '../brain-registry.ts';
import { OperationError } from '../ops/contract.ts';
import { isWriteRequestId } from '../persistence/types.ts';
import { digest } from '../persistence/digest.ts';
import { parseSourceConfig } from '../sources-load.ts';
import { LINK_EXTRACTOR_VERSION_TS } from '../link-extraction.ts';
import { safeRepositoryPath } from './revision.ts';
import { COMPANY_BRAIN_MAX_ENTRIES, COMPANY_BRAIN_MAX_FILE_BYTES, COMPANY_BRAIN_MAX_METADATA_BYTES, type RevisionIdentity } from './types.ts';
import type { SourceIngestionReceipt } from './receipts.ts';

export function isCompanyBrainId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 32 || /[\x00-\x1f\x7f]/.test(value)) return false;
  if (value === 'host') return true;
  try { return validateMountId(value) === value; } catch { return false; }
}

const uuid = z.string().length(36).refine(isWriteRequestId);
const hash = z.string().length(64).regex(/^[a-f0-9]{64}$/);
const path = z.string().min(1).max(8192).refine(value => isAbsolute(value) && resolve(value) === value && !/[\x00-\x1f\x7f]/.test(value));
const patterns = z.array(z.string().min(1).max(1024).refine(value => safeRepositoryPath(value) && !value.startsWith('!') && !value.endsWith('/')))
  .max(256).refine(values => values.every((value, index) => index === 0 || values[index - 1] < value));
const schema = z.object({ name: z.literal('company-brain'), version: z.string().max(32).regex(/^\d+\.\d+\.\d+$/).refine(value => !/[\x00-\x1f\x7f]/.test(value)),
  identity: z.string().max(192), resolved_digest: hash }).strict()
  .refine(value => value.identity.startsWith(`${value.name}@${value.version}+`) && value.identity.length === `${value.name}@${value.version}+`.length + 8 && /^[a-f0-9]{8}$/.test(value.identity.slice(-8)));
const repository = z.object({ root: path, git_root: path, git_dir: path,
  scope: z.string().max(8192).refine(value => value === '' || safeRepositoryPath(value)),
  root_device: z.string().regex(/^\d{1,24}$/), root_inode: z.string().regex(/^\d{1,24}$/),
  git_device: z.string().regex(/^\d{1,24}$/), git_inode: z.string().regex(/^\d{1,24}$/), object_format: z.enum(['sha1', 'sha256']) }).strict()
  .refine(value => relative(value.git_root, value.root).split(sep).join('/') === value.scope);
const profileSchema = z.object({
  version: z.literal(1), profile: z.literal('company-brain'), brainId: z.string().refine(isCompanyBrainId), databaseId: uuid,
  receiptId: uuid, planDigest: hash, repository,
  selection: z.object({ include: patterns, exclude: patterns, defaults_version: z.literal(1) }).strict(),
  limits: z.object({ maxEntries: z.number().int().min(1).max(COMPANY_BRAIN_MAX_ENTRIES),
    maxMetadataBytes: z.number().int().min(1).max(COMPANY_BRAIN_MAX_METADATA_BYTES), maxFileBytes: z.number().int().min(1).max(COMPANY_BRAIN_MAX_FILE_BYTES) }).strict(),
  schema, extractorVersion: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._+:-]{0,127}$/).refine(value => !/[\x00-\x1f\x7f]/.test(value)), approvedRevision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  committedOnly: z.literal(true), noPull: z.literal(true), noEmbed: z.literal(true), noBackfill: z.literal(true), noWriteback: z.literal(true),
}).strict().refine(value => value.approvedRevision.length === (value.repository.object_format === 'sha1' ? 40 : 64));

export type CompanyBrainProfile = z.infer<typeof profileSchema>;

export function companyBrainProfile(config: unknown): CompanyBrainProfile | null {
  const source = parseSourceConfig(config);
  if (source.company_brain === undefined) return null;
  const parsed = profileSchema.safeParse(source.company_brain);
  if (!parsed.success || typeof source.federated !== 'boolean' || source.strategy !== 'markdown' || source.slug_root_mode !== 'source-root' || source.kind != null || source.remote_url != null) {
    throw new OperationError('profile_incompatible', 'The persisted company profile is invalid. Reinspect and reconnect explicitly; missing policy values are never defaulted.');
  }
  return parsed.data;
}

export function companyBrainRepository(revision: RevisionIdentity): CompanyBrainProfile['repository'] {
  const { commit: _commit, tree: _tree, ...identity } = revision;
  return identity;
}

export function companyBrainPolicyFingerprint(profile: CompanyBrainProfile, sourceId: string): string {
  const { receiptId: _receiptId, planDigest: _planDigest, approvedRevision: _revision, ...policy } = profile;
  return digest({ ...policy, sourceId, federated: false, strategy: 'markdown', slugRootMode: 'source-root' });
}

export function assertCompanyBrainPolicy(profile: CompanyBrainProfile, receipt: SourceIngestionReceipt, databaseId: string, localPath: string): void {
  if (profile.databaseId !== databaseId || profile.repository.root !== localPath || profile.receiptId !== receipt.id ||
    companyBrainPolicyFingerprint(profile, receipt.sourceId) !== receipt.policyFingerprint || profile.approvedRevision !== receipt.approvedRevision ||
    profile.schema.resolved_digest !== receipt.schemaFingerprint || profile.extractorVersion !== receipt.extractorVersion || receipt.profile !== 'company-brain') {
    throw new OperationError('profile_incompatible', 'The source policy no longer matches its immutable ingestion approval. Reinspect and reconnect explicitly; v1 cannot reapprove an existing source in place.');
  }
}

export function assertCompanyBrainExtractor(extractorVersion: string, destination: { sourceId: string; brainId: string }): void {
  if (extractorVersion !== LINK_EXTRACTOR_VERSION_TS) throw new OperationError('extractor_identity_mismatch',
    'The approved extractor differs from the installed extractor; this receipt cannot resume or admit another revision.',
    `Review removal with gbrain sources remove ${destination.sourceId} --brain ${destination.brainId} --dry-run. Only after explicit destructive approval, remove that registration with --confirm-destructive before reinspecting and reconnecting this checkout, or use a separate authorized checkout/destination. V1 has no in-place reapproval transition.`);
}
