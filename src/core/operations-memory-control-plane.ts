import { randomUUID } from 'crypto';
import type { Operation } from './operations.ts';
import { recordMemoryMutationEvent } from './services/memory-mutation-ledger-service.ts';
import {
  hashCanonicalJson,
  memorySessionAttachmentTargetId,
  memorySessionSnapshotPayload,
} from './services/target-snapshot-hash-service.ts';
import type {
  MemoryAccessMode,
  MemoryRealmFilters,
  MemoryRealmInput,
  MemoryRealm,
  MemoryRealmScope,
  MemorySession,
  MemorySessionFilters,
  MemorySessionStatus,
  MemorySessionAttachment,
  MemorySessionAttachmentFilters,
  MemorySessionAttachmentInput,
  MemorySessionInput,
} from './types.ts';
import { applyMemoryRealmUpsertDefaults, applyMemorySessionCreateDefaults, parseValidIsoTimestamp } from './utils.ts';

type OperationErrorCtor = new (
  code: 'invalid_params',
  message: string,
  suggestion?: string,
  docs?: string,
) => Error;

const MEMORY_REALM_SCOPES = ['work', 'personal', 'mixed'] as const satisfies readonly MemoryRealmScope[];
const MEMORY_ACCESS_MODES = ['read_only', 'read_write'] as const satisfies readonly MemoryAccessMode[];
const MEMORY_SESSION_STATUSES = ['active', 'expired', 'closed'] as const satisfies readonly MemorySessionStatus[];
const DEFAULT_REALM_UPSERT_SOURCE_REFS = ['Source: mbrain upsert_memory_realm operation'];
const DEFAULT_SESSION_CREATE_SOURCE_REFS = ['Source: mbrain create_memory_session operation'];
const DEFAULT_SESSION_CLOSE_SOURCE_REFS = ['Source: mbrain close_memory_session operation'];
const DEFAULT_SESSION_ATTACH_SOURCE_REFS = ['Source: mbrain attach_memory_realm_to_session operation'];
const DEFAULT_REALM_UPSERT_ACTOR = 'mbrain:memory_control_plane';

function invalidParams(
  deps: { OperationError: OperationErrorCtor },
  message: string,
): Error {
  return new deps.OperationError('invalid_params', message);
}

function requiredString(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidParams(deps, `${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): string | undefined {
  if (value == null) return undefined;
  return requiredString(deps, field, value);
}

function optionalNullableString(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): string | null | undefined {
  if (value === null) return null;
  return optionalString(deps, field, value);
}

function optionalText(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string') {
    throw invalidParams(deps, `${field} must be a string`);
  }
  return value;
}

function enumValue<T extends string>(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
  allowed: readonly T[],
  required = false,
): T | undefined {
  if (value == null) {
    if (required) {
      throw invalidParams(deps, `${field} must be one of: ${allowed.join(', ')}`);
    }
    return undefined;
  }
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw invalidParams(deps, `${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function optionalBoolean(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): boolean | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'boolean') {
    throw invalidParams(deps, `${field} must be a boolean`);
  }
  return value;
}

function integerParam(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
  options: { defaultValue: number; min: number; max?: number },
): number {
  if (value == null) return options.defaultValue;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < options.min) {
    throw invalidParams(deps, `${field} must be an integer greater than or equal to ${options.min}`);
  }
  if (options.max !== undefined && value > options.max) {
    throw invalidParams(deps, `${field} must be less than or equal to ${options.max}`);
  }
  return value;
}

function optionalIsoDate(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): Date | null | undefined {
  if (value === null) return null;
  if (value == null) return undefined;
  if (value instanceof Date) {
    if (!Number.isNaN(value.getTime())) return value;
    throw invalidParams(deps, `${field} must be a valid ISO timestamp`);
  }
  if (typeof value !== 'string') {
    throw invalidParams(deps, `${field} must be an ISO timestamp`);
  }
  const parsed = parseValidIsoTimestamp(value);
  if (!parsed) {
    throw invalidParams(deps, `${field} must be a valid ISO timestamp`);
  }
  return parsed;
}

function optionalSourceRefs(
  deps: { OperationError: OperationErrorCtor },
  value: unknown,
): string[] | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return [requiredString(deps, 'source_refs', value)];
  if (Array.isArray(value)) {
    if (value.length === 0) {
      throw invalidParams(deps, 'source_refs must contain at least one provenance reference');
    }
    return value.map((ref, index) => requiredString(deps, `source_refs[${index}]`, ref));
  }
  throw invalidParams(deps, 'source_refs must be a string or an array of strings');
}

function realmInput(
  deps: { OperationError: OperationErrorCtor },
  p: Record<string, unknown>,
): MemoryRealmInput {
  const input: MemoryRealmInput = {
    id: requiredString(deps, 'id', p.id),
    name: requiredString(deps, 'name', p.name),
    scope: enumValue(deps, 'scope', p.scope, MEMORY_REALM_SCOPES, true)!,
  };

  const description = optionalText(deps, 'description', p.description);
  if (description !== undefined) input.description = description;
  const defaultAccess = enumValue(deps, 'default_access', p.default_access, MEMORY_ACCESS_MODES);
  if (defaultAccess !== undefined) input.default_access = defaultAccess;
  const retentionPolicy = optionalText(deps, 'retention_policy', p.retention_policy);
  if (retentionPolicy !== undefined) input.retention_policy = retentionPolicy;
  const exportPolicy = optionalText(deps, 'export_policy', p.export_policy);
  if (exportPolicy !== undefined) input.export_policy = exportPolicy;
  const agentInstructions = optionalText(deps, 'agent_instructions', p.agent_instructions);
  if (agentInstructions !== undefined) input.agent_instructions = agentInstructions;
  const archivedAt = optionalIsoDate(deps, 'archived_at', p.archived_at);
  if (archivedAt !== undefined || p.archived_at === null) input.archived_at = archivedAt;

  return input;
}

function realmPreview(
  input: MemoryRealmInput,
  existing: MemoryRealm | null,
): Required<MemoryRealmInput> {
  return applyMemoryRealmUpsertDefaults(input, existing);
}

function realmFilters(
  deps: { OperationError: OperationErrorCtor },
  p: Record<string, unknown>,
): MemoryRealmFilters {
  return {
    scope: enumValue(deps, 'scope', p.scope, MEMORY_REALM_SCOPES),
    include_archived: optionalBoolean(deps, 'include_archived', p.include_archived),
    limit: integerParam(deps, 'limit', p.limit, { defaultValue: 100, min: 0, max: 500 }),
    offset: integerParam(deps, 'offset', p.offset, { defaultValue: 0, min: 0 }),
  };
}

function memorySessionInput(
  deps: { OperationError: OperationErrorCtor },
  p: Record<string, unknown>,
): MemorySessionInput {
  const input: MemorySessionInput = {
    id: requiredString(deps, 'id', p.id),
  };
  const taskId = optionalNullableString(deps, 'task_id', p.task_id);
  if (taskId !== undefined || p.task_id === null) input.task_id = taskId ?? null;
  const actorRef = optionalNullableString(deps, 'actor_ref', p.actor_ref);
  if (actorRef !== undefined || p.actor_ref === null) input.actor_ref = actorRef ?? null;
  const expiresAt = optionalIsoDate(deps, 'expires_at', p.expires_at);
  if (expiresAt !== undefined || p.expires_at === null) input.expires_at = expiresAt;
  return input;
}

function memorySessionPreview(input: MemorySessionInput): Omit<MemorySession, 'created_at' | 'closed_at'> & {
  created_at: Date;
  closed_at: null;
} {
  return {
    ...applyMemorySessionCreateDefaults(input),
    created_at: new Date(),
    closed_at: null,
  };
}

function memorySessionFilters(
  deps: { OperationError: OperationErrorCtor },
  p: Record<string, unknown>,
): MemorySessionFilters {
  const taskId = optionalString(deps, 'task_id', p.task_id);
  const actorRef = optionalString(deps, 'actor_ref', p.actor_ref);
  const realmId = optionalString(deps, 'realm_id', p.realm_id);
  const createdSince = optionalIsoDate(deps, 'created_since', p.created_since);
  const createdUntil = optionalIsoDate(deps, 'created_until', p.created_until);
  return {
    status: enumValue(deps, 'status', p.status, MEMORY_SESSION_STATUSES),
    ...(taskId !== undefined ? { task_id: taskId } : {}),
    ...(actorRef !== undefined ? { actor_ref: actorRef } : {}),
    ...(realmId !== undefined ? { realm_id: realmId } : {}),
    ...(createdSince instanceof Date ? { created_since: createdSince } : {}),
    ...(createdUntil instanceof Date ? { created_until: createdUntil } : {}),
    limit: integerParam(deps, 'limit', p.limit, { defaultValue: 100, min: 0, max: 500 }),
    offset: integerParam(deps, 'offset', p.offset, { defaultValue: 0, min: 0 }),
  };
}

function memorySessionAttachmentInput(
  deps: { OperationError: OperationErrorCtor },
  p: Record<string, unknown>,
): MemorySessionAttachmentInput {
  const access = enumValue(deps, 'access', p.access, MEMORY_ACCESS_MODES, true)!;
  const instructions = optionalText(deps, 'instructions', p.instructions);
  const input: MemorySessionAttachmentInput = {
    session_id: requiredString(deps, 'session_id', p.session_id),
    realm_id: requiredString(deps, 'realm_id', p.realm_id),
    access,
  };
  if (instructions !== undefined) input.instructions = instructions;
  return input;
}

function memorySessionAttachmentPreview(input: MemorySessionAttachmentInput): MemorySessionAttachment {
  return {
    session_id: input.session_id,
    realm_id: input.realm_id,
    access: input.access,
    instructions: input.instructions ?? '',
    attached_at: new Date(),
  };
}

function memoryRealmSnapshotHash(realm: MemoryRealm | null): string | null {
  if (!realm) return null;
  return hashCanonicalJson({
    id: realm.id,
    name: realm.name,
    description: realm.description,
    scope: realm.scope,
    default_access: realm.default_access,
    retention_policy: realm.retention_policy,
    export_policy: realm.export_policy,
    agent_instructions: realm.agent_instructions,
    archived_at: realm.archived_at,
  });
}

function memorySessionSnapshotHash(session: MemorySession | null): string | null {
  if (!session) return null;
  return hashCanonicalJson(memorySessionSnapshotPayload(session));
}

function memorySessionAttachmentSnapshotHash(attachment: MemorySessionAttachment | null): string | null {
  if (!attachment) return null;
  return hashCanonicalJson({
    session_id: attachment.session_id,
    realm_id: attachment.realm_id,
    access: attachment.access,
    instructions: attachment.instructions,
  });
}

async function ensureMemorySessionDoesNotExist(
  deps: { OperationError: OperationErrorCtor },
  engine: { getMemorySession(id: string): Promise<MemorySession | null> },
  id: string,
): Promise<void> {
  const existing = await engine.getMemorySession(id);
  if (existing) {
    throw invalidParams(deps, `memory session already exists: ${id}`);
  }
}

async function requireMemorySessionAttachmentTargets(
  deps: { OperationError: OperationErrorCtor },
  engine: {
    getMemorySession(id: string): Promise<MemorySession | null>;
    getMemoryRealm(id: string): Promise<MemoryRealm | null>;
  },
  input: MemorySessionAttachmentInput,
): Promise<{ session: MemorySession; realm: MemoryRealm }> {
  const [session, realm] = await Promise.all([
    engine.getMemorySession(input.session_id),
    engine.getMemoryRealm(input.realm_id),
  ]);
  if (!session) {
    throw invalidParams(deps, `memory session not found: ${input.session_id}`);
  }
  if (session.status === 'expired') {
    throw invalidParams(deps, `memory session is expired: ${input.session_id}`);
  }
  if (session.status !== 'active') {
    throw invalidParams(deps, `memory session is closed: ${input.session_id}`);
  }
  if (!realm) {
    throw invalidParams(deps, `memory realm not found: ${input.realm_id}`);
  }
  return { session, realm };
}

function memorySessionAttachmentFilters(
  deps: { OperationError: OperationErrorCtor },
  p: Record<string, unknown>,
): MemorySessionAttachmentFilters {
  const sessionId = optionalString(deps, 'session_id', p.session_id);
  const realmId = optionalString(deps, 'realm_id', p.realm_id);
  return {
    ...(sessionId !== undefined ? { session_id: sessionId } : {}),
    ...(realmId !== undefined ? { realm_id: realmId } : {}),
    limit: integerParam(deps, 'limit', p.limit, { defaultValue: 100, min: 0, max: 500 }),
    offset: integerParam(deps, 'offset', p.offset, { defaultValue: 0, min: 0 }),
  };
}

export function createMemoryControlPlaneOperations(
  deps: { OperationError: OperationErrorCtor },
): Operation[] {
  const upsert_memory_realm: Operation = {
    name: 'upsert_memory_realm',
    description: 'Create or update a memory realm for scoped memory access control.',
    params: {
      id: { type: 'string', required: true },
      name: { type: 'string', required: true },
      description: { type: 'string', default: '' },
      scope: { type: 'string', required: true, enum: [...MEMORY_REALM_SCOPES] },
      default_access: { type: 'string', default: 'read_only', enum: [...MEMORY_ACCESS_MODES] },
      retention_policy: { type: 'string', default: 'retain' },
      export_policy: { type: 'string', default: 'private' },
      agent_instructions: { type: 'string', default: '' },
      archived_at: {
        type: 'string',
        nullable: true,
        description: 'Optional ISO timestamp. Null reactivates an archived realm.',
      },
      session_id: { type: 'string', description: 'Optional mutation ledger session id. Generated when omitted.' },
      actor: { type: 'string', default: DEFAULT_REALM_UPSERT_ACTOR },
      source_refs: { type: 'array', items: { type: 'string' }, description: 'Optional provenance reference string or string array for the ledger event.' },
    },
    mutating: true,
    handler: async (ctx, p) => {
      const input = realmInput(deps, p);
      const sourceRefs = optionalSourceRefs(deps, p.source_refs) ?? DEFAULT_REALM_UPSERT_SOURCE_REFS;
      if (ctx.dryRun) {
        const existing = await ctx.engine.getMemoryRealm(input.id);
        return {
          action: 'upsert_memory_realm',
          dry_run: true,
          realm: realmPreview(input, existing),
        };
      }
      const sessionId = optionalString(deps, 'session_id', p.session_id) ?? `upsert_memory_realm:${randomUUID()}`;
      const actor = optionalString(deps, 'actor', p.actor) ?? DEFAULT_REALM_UPSERT_ACTOR;

      return ctx.engine.transaction(async (engine) => {
        const existing = await engine.getMemoryRealm(input.id);
        const realm = await engine.upsertMemoryRealm(input);
        await recordMemoryMutationEvent(engine, {
          session_id: sessionId,
          realm_id: realm.id,
          actor,
          operation: 'upsert_memory_realm',
          target_kind: 'memory_realm',
          target_id: realm.id,
          scope_id: realm.scope,
          source_refs: sourceRefs,
          expected_target_snapshot_hash: memoryRealmSnapshotHash(existing),
          current_target_snapshot_hash: memoryRealmSnapshotHash(realm),
          result: 'applied',
          metadata: {
            action: 'upsert',
            realm_scope: realm.scope,
            realm_default_access: realm.default_access,
          },
        });
        return realm;
      });
    },
    cliHints: { name: 'memory-realm-upsert' },
  };

  const get_memory_realm: Operation = {
    name: 'get_memory_realm',
    description: 'Get one memory realm by id.',
    params: {
      id: { type: 'string', required: true },
    },
    mutating: false,
    handler: async (ctx, p) => ctx.engine.getMemoryRealm(requiredString(deps, 'id', p.id)),
    cliHints: { name: 'memory-realm-get', positional: ['id'] },
  };

  const list_memory_realms: Operation = {
    name: 'list_memory_realms',
    description: 'List memory realms. Archived realms are excluded unless include_archived is true.',
    params: {
      scope: { type: 'string', enum: [...MEMORY_REALM_SCOPES] },
      include_archived: { type: 'boolean', default: false },
      limit: { type: 'number', default: 100 },
      offset: { type: 'number', default: 0 },
    },
    mutating: false,
    handler: async (ctx, p) => ctx.engine.listMemoryRealms(realmFilters(deps, p)),
    cliHints: { name: 'memory-realm-list', aliases: { n: 'limit' } },
  };

  const create_memory_session: Operation = {
    name: 'create_memory_session',
    description: 'Create an active memory session for attaching scoped memory realms.',
    params: {
      id: { type: 'string', required: true },
      task_id: { type: 'string', nullable: true },
      actor_ref: { type: 'string', nullable: true },
      expires_at: {
        type: 'string',
        nullable: true,
        description: 'Optional ISO timestamp after which the session is effectively expired.',
      },
      source_refs: { type: 'array', items: { type: 'string' }, description: 'Optional provenance reference string or string array for the ledger event.' },
    },
    mutating: true,
    handler: async (ctx, p) => {
      const input = memorySessionInput(deps, p);
      const sourceRefs = optionalSourceRefs(deps, p.source_refs) ?? DEFAULT_SESSION_CREATE_SOURCE_REFS;
      if (ctx.dryRun) {
        await ensureMemorySessionDoesNotExist(deps, ctx.engine, input.id);
        return {
          action: 'create_memory_session',
          dry_run: true,
          session: memorySessionPreview(input),
        };
      }
      return ctx.engine.transaction(async (engine) => {
        await ensureMemorySessionDoesNotExist(deps, engine, input.id);
        const session = await engine.createMemorySession(input);
        await recordMemoryMutationEvent(engine, {
          session_id: session.id,
          realm_id: `session:${session.id}`,
          actor: session.actor_ref ?? DEFAULT_REALM_UPSERT_ACTOR,
          operation: 'create_memory_session',
          target_kind: 'memory_session',
          target_id: session.id,
          scope_id: null,
          source_refs: sourceRefs,
          expected_target_snapshot_hash: null,
          current_target_snapshot_hash: memorySessionSnapshotHash(session),
          result: 'applied',
          metadata: {
            task_id: session.task_id,
            status: session.status,
          },
        });
        return session;
      });
    },
    cliHints: { name: 'memory-session-create' },
  };

  const get_memory_session: Operation = {
    name: 'get_memory_session',
    description: 'Get one memory session by id, returning effective expired status when expires_at has elapsed.',
    params: {
      id: { type: 'string', required: true },
    },
    mutating: false,
    handler: async (ctx, p) => ctx.engine.getMemorySession(requiredString(deps, 'id', p.id)),
    cliHints: { name: 'memory-session-get', positional: ['id'] },
  };

  const list_memory_sessions: Operation = {
    name: 'list_memory_sessions',
    description: 'List memory sessions by effective status, task, actor, attached realm, or creation time window.',
    params: {
      status: { type: 'string', enum: [...MEMORY_SESSION_STATUSES] },
      task_id: { type: 'string' },
      actor_ref: { type: 'string' },
      realm_id: { type: 'string' },
      created_since: { type: 'string', description: 'Inclusive ISO timestamp lower bound.' },
      created_until: { type: 'string', description: 'Exclusive ISO timestamp upper bound.' },
      limit: { type: 'number', default: 100 },
      offset: { type: 'number', default: 0 },
    },
    mutating: false,
    handler: async (ctx, p) => ctx.engine.listMemorySessions(memorySessionFilters(deps, p)),
    cliHints: { name: 'memory-session-list', aliases: { n: 'limit' } },
  };

  const close_memory_session: Operation = {
    name: 'close_memory_session',
    description: 'Close an active memory session if it exists.',
    params: {
      id: { type: 'string', required: true },
      source_refs: { type: 'array', items: { type: 'string' }, description: 'Optional provenance reference string or string array for the ledger event.' },
    },
    mutating: true,
    handler: async (ctx, p) => {
      const id = requiredString(deps, 'id', p.id);
      const sourceRefs = optionalSourceRefs(deps, p.source_refs) ?? DEFAULT_SESSION_CLOSE_SOURCE_REFS;
      const existing = await ctx.engine.getMemorySession(id);
      if (!existing) return null;
      if (ctx.dryRun) {
        return {
          action: 'close_memory_session',
          dry_run: true,
          session: existing.status === 'active' ? {
            ...existing,
            status: 'closed',
            closed_at: existing.closed_at ?? new Date(),
          } : existing,
        };
      }
      return ctx.engine.transaction(async (engine) => {
        const current = await engine.getMemorySession(id);
        if (!current) return null;
        if (current.status !== 'active') return current;
        const session = await engine.closeMemorySession(id);
        if (!session) return engine.getMemorySession(id);
        await recordMemoryMutationEvent(engine, {
          session_id: session.id,
          realm_id: `session:${session.id}`,
          actor: session.actor_ref ?? DEFAULT_REALM_UPSERT_ACTOR,
          operation: 'close_memory_session',
          target_kind: 'memory_session',
          target_id: session.id,
          scope_id: null,
          source_refs: sourceRefs,
          expected_target_snapshot_hash: memorySessionSnapshotHash(current),
          current_target_snapshot_hash: memorySessionSnapshotHash(session),
          result: 'applied',
          metadata: {
            task_id: session.task_id,
            status: session.status,
          },
        });
        return session;
      });
    },
    cliHints: { name: 'memory-session-close', positional: ['id'] },
  };

  const attach_memory_realm_to_session: Operation = {
    name: 'attach_memory_realm_to_session',
    description: 'Attach a memory realm to a memory session with read-only or read-write access.',
    params: {
      session_id: { type: 'string', required: true },
      realm_id: { type: 'string', required: true },
      access: { type: 'string', required: true, enum: [...MEMORY_ACCESS_MODES] },
      instructions: { type: 'string', default: '' },
      source_refs: { type: 'array', items: { type: 'string' }, description: 'Optional provenance reference string or string array for the ledger event.' },
    },
    mutating: true,
    handler: async (ctx, p) => {
      const input = memorySessionAttachmentInput(deps, p);
      const sourceRefs = optionalSourceRefs(deps, p.source_refs) ?? DEFAULT_SESSION_ATTACH_SOURCE_REFS;
      if (ctx.dryRun) {
        await requireMemorySessionAttachmentTargets(deps, ctx.engine, input);
        return {
          action: 'attach_memory_realm_to_session',
          dry_run: true,
          attachment: memorySessionAttachmentPreview(input),
        };
      }
      return ctx.engine.transaction(async (engine) => {
        const { session, realm } = await requireMemorySessionAttachmentTargets(deps, engine, input);
        const existingAttachment = (await engine.listMemorySessionAttachments({
          session_id: input.session_id,
          realm_id: input.realm_id,
          limit: 1,
        }))[0] ?? null;
        const attachment = await engine.attachMemoryRealmToSession(input);
        await recordMemoryMutationEvent(engine, {
          session_id: attachment.session_id,
          realm_id: attachment.realm_id,
          actor: session.actor_ref ?? DEFAULT_REALM_UPSERT_ACTOR,
          operation: 'attach_memory_realm_to_session',
          target_kind: 'memory_session_attachment',
          target_id: memorySessionAttachmentTargetId(attachment),
          scope_id: realm.scope,
          source_refs: sourceRefs,
          expected_target_snapshot_hash: memorySessionAttachmentSnapshotHash(existingAttachment),
          current_target_snapshot_hash: memorySessionAttachmentSnapshotHash(attachment),
          result: 'applied',
          metadata: {
            access: attachment.access,
          },
        });
        return attachment;
      });
    },
    cliHints: { name: 'memory-session-attach-realm' },
  };

  const list_memory_session_attachments: Operation = {
    name: 'list_memory_session_attachments',
    description: 'List memory realm attachments for sessions or realms.',
    params: {
      session_id: { type: 'string' },
      realm_id: { type: 'string' },
      limit: { type: 'number', default: 100 },
      offset: { type: 'number', default: 0 },
    },
    mutating: false,
    handler: async (ctx, p) => ctx.engine.listMemorySessionAttachments(
      memorySessionAttachmentFilters(deps, p),
    ),
    cliHints: { name: 'memory-session-attachment-list', aliases: { n: 'limit' } },
  };

  return [
    upsert_memory_realm,
    get_memory_realm,
    list_memory_realms,
    create_memory_session,
    get_memory_session,
    list_memory_sessions,
    close_memory_session,
    attach_memory_realm_to_session,
    list_memory_session_attachments,
  ];
}
