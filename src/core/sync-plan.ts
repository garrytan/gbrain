/**
 * Immutable sync-plan value objects.
 *
 * Planning callers may read Git and the configured engine to discover inputs,
 * but this module is deliberately pure: it sorts, normalizes, counts, and
 * hashes already-classified operations without touching either system.
 */
import { createHash } from 'node:crypto';

export type SyncPlanMode = 'first' | 'full' | 'incremental' | 'resumed';
export type SyncPlanOperationKind = 'add' | 'modify' | 'delete' | 'rename' | 'preserve';
export type SyncPlanStrategy = 'markdown' | 'code' | 'auto';

export interface SyncPlanOperation {
  kind: SyncPlanOperationKind;
  path: string;
  slug: string;
  fromPath?: string;
  reason?: string;
  /**
   * Hash of the exact target bytes after deterministic parsing/inference.
   * Present on add/modify/rename operations when planning can prove it.
   * This is excluded from the human affected sample but included in the
   * full plan commitment so schema-pack or parser-decision drift is visible.
   */
  contentHash?: string | null;
}

export interface SyncAffectedItem {
  operation: SyncPlanOperationKind;
  path: string;
  slug: string;
  from_path?: string;
}

export interface SyncAffectedSummary {
  total: number;
  sample_limit: number;
  sample: SyncAffectedItem[];
  truncated: boolean;
}

export interface SyncPlanCorpus {
  markdownOperations: number;
  codePagesBefore: number;
  codePagesAfter: number;
  codeDeletions: number;
  imagePagesBefore: number;
  imagePagesAfter: number;
  imageOperations: number;
}

export interface SyncPlan {
  mode: SyncPlanMode;
  sourceId: string;
  repoPath: string;
  fromCommit: string | null;
  targetCommit: string;
  strategy: SyncPlanStrategy;
  lastSuccessfulStrategy: SyncPlanStrategy | null;
  strategyChanged: boolean;
  checkpointReset: boolean;
  operations: readonly SyncPlanOperation[];
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
  preserved: number;
  affected: SyncAffectedSummary;
  affectedDigest: string;
  /** Full immutable decision commitment consumed by paired apply. */
  planDigest: string;
  schemaPackIdentity: string | null;
  corpus: SyncPlanCorpus;
}

export interface CreateSyncPlanInput {
  mode: SyncPlanMode;
  sourceId: string;
  repoPath: string;
  fromCommit: string | null;
  targetCommit: string;
  strategy: SyncPlanStrategy;
  lastSuccessfulStrategy?: SyncPlanStrategy | null;
  strategyChanged?: boolean;
  checkpointReset?: boolean;
  schemaPackIdentity?: string | null;
  operations: readonly SyncPlanOperation[];
  sampleLimit?: number;
  corpus?: SyncPlanCorpus;
}

export const SYNC_PLAN_SAMPLE_LIMIT = 100;

export function normalizeSyncPlanPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
}

function assertDigestFieldSafe(field: string, value: string): void {
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(
      `Sync plan ${field} contains a control character and cannot be represented ` +
        `unambiguously in the schema-1 affected digest.`,
    );
  }
}

function normalizeOperation(operation: SyncPlanOperation): SyncPlanOperation {
  if (operation.kind === 'rename' && !operation.fromPath) {
    throw new Error(
      'Sync plan rename operations require a non-empty from_path.',
    );
  }
  if (operation.kind !== 'rename' && operation.fromPath !== undefined) {
    throw new Error(
      `Sync plan ${operation.kind} operations must not carry from_path.`,
    );
  }
  const normalized = {
    ...operation,
    path: normalizeSyncPlanPath(operation.path),
    slug: operation.slug.replace(/\\/g, '/'),
    ...(operation.fromPath
      ? { fromPath: normalizeSyncPlanPath(operation.fromPath) }
      : {}),
  };
  assertDigestFieldSafe('path', normalized.path);
  assertDigestFieldSafe('slug', normalized.slug);
  if (normalized.fromPath) {
    assertDigestFieldSafe('from_path', normalized.fromPath);
  }
  if (
    normalized.contentHash !== undefined &&
    normalized.contentHash !== null &&
    !/^[0-9a-f]{64}$/.test(normalized.contentHash)
  ) {
    throw new Error(
      'Sync plan content_hash must be a lowercase 64-character SHA-256 digest.',
    );
  }
  return normalized;
}

function operationSortKey(operation: SyncPlanOperation): string {
  return [
    operation.kind,
    operation.path,
    operation.slug,
    operation.fromPath ?? '',
  ].join('\t');
}

function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function canonicalDigestLine(operation: SyncPlanOperation): string {
  return [
    operation.kind,
    operation.path,
    operation.slug,
    operation.fromPath ?? '',
  ].join('\t') + '\n';
}

export function createSyncPlan(input: CreateSyncPlanInput): SyncPlan {
  const byKey = new Map<string, SyncPlanOperation>();
  for (const rawOperation of input.operations) {
    const operation = normalizeOperation(rawOperation);
    byKey.set(operationSortKey(operation), operation);
  }
  const operations = [...byKey.values()].sort((a, b) =>
    compareUtf8(operationSortKey(a), operationSortKey(b)),
  );
  const sampleLimit = input.sampleLimit ?? SYNC_PLAN_SAMPLE_LIMIT;
  const mutationOperations = operations.filter(
    (operation) => operation.kind !== 'preserve',
  );
  const affectedItems = mutationOperations.map<SyncAffectedItem>(
    (operation) => ({
      operation: operation.kind,
      path: operation.path,
      slug: operation.slug,
      ...(operation.fromPath ? { from_path: operation.fromPath } : {}),
    }),
  );
  const digestBytes = mutationOperations
    .map(canonicalDigestLine)
    .sort(compareUtf8)
    .join('');
  const corpus = input.corpus ?? {
    markdownOperations: 0,
    codePagesBefore: 0,
    codePagesAfter: 0,
    codeDeletions: 0,
    imagePagesBefore: 0,
    imagePagesAfter: 0,
    imageOperations: 0,
  };
  const schemaPackIdentity = input.schemaPackIdentity ?? null;
  const planDigestPayload = {
    schema_version: 1,
    mode: input.mode,
    source_id: input.sourceId,
    repo_path: input.repoPath,
    from_commit: input.fromCommit,
    target_commit: input.targetCommit,
    strategy: input.strategy,
    last_successful_strategy: input.lastSuccessfulStrategy ?? null,
    strategy_changed: input.strategyChanged === true,
    checkpoint_reset: input.checkpointReset === true,
    schema_pack_identity: schemaPackIdentity,
    operations: operations.map((operation) => ({
      kind: operation.kind,
      path: operation.path,
      slug: operation.slug,
      from_path: operation.fromPath ?? null,
      reason: operation.reason ?? null,
      content_hash: operation.contentHash ?? null,
    })),
    corpus: {
      markdown_operations: corpus.markdownOperations,
      code_pages_before: corpus.codePagesBefore,
      code_pages_after: corpus.codePagesAfter,
      code_deletions: corpus.codeDeletions,
      image_pages_before: corpus.imagePagesBefore,
      image_pages_after: corpus.imagePagesAfter,
      image_operations: corpus.imageOperations,
    },
  };

  return {
    mode: input.mode,
    sourceId: input.sourceId,
    repoPath: input.repoPath,
    fromCommit: input.fromCommit,
    targetCommit: input.targetCommit,
    strategy: input.strategy,
    lastSuccessfulStrategy: input.lastSuccessfulStrategy ?? null,
    strategyChanged: input.strategyChanged === true,
    checkpointReset: input.checkpointReset === true,
    operations,
    added: operations.filter((operation) => operation.kind === 'add').length,
    modified: operations.filter((operation) => operation.kind === 'modify').length,
    deleted: operations.filter((operation) => operation.kind === 'delete').length,
    renamed: operations.filter((operation) => operation.kind === 'rename').length,
    preserved: operations.filter((operation) => operation.kind === 'preserve').length,
    affected: {
      total: affectedItems.length,
      sample_limit: sampleLimit,
      sample: affectedItems.slice(0, sampleLimit),
      truncated: affectedItems.length > sampleLimit,
    },
    affectedDigest: createHash('sha256').update(digestBytes, 'utf8').digest('hex'),
    planDigest: createHash('sha256')
      .update(JSON.stringify(planDigestPayload), 'utf8')
      .digest('hex'),
    schemaPackIdentity,
    corpus,
  };
}
