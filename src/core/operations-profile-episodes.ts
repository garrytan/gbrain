// Canonical personal memory operations: profile-memory entries and personal
// episodes (get/list/upsert/record/delete plus preflighted write variants).
import type { BrainEngine } from './engine.ts';
import { OperationError } from './operation-params.ts';
import type { Operation } from './operations.ts';
import { parseRequestedScopeParam, requestedScopeParam } from './operations-shared.ts';
import { recordMemoryMutationEvent } from './services/memory-mutation-ledger-service.ts';
import { DEFAULT_PROFILE_MEMORY_SCOPE_ID } from './services/personal-profile-lookup-route-service.ts';
import { selectPersonalWriteTarget } from './services/personal-write-target-service.ts';
import type {
  MemoryMutationEvent,
  PersonalWriteTargetResult,
} from './types.ts';

// --- Profile Memory ---

const get_profile_memory_entry: Operation = {
  name: 'get_profile_memory_entry',
  description: 'Get one canonical profile-memory entry by id.',
  params: {
    id: {
      type: 'string',
      required: true,
      description: 'Profile-memory entry id',
    },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getProfileMemoryEntry(String(p.id));
  },
  cliHints: { name: 'profile-memory-get' },
};

const list_profile_memory_entries: Operation = {
  name: 'list_profile_memory_entries',
  description: 'List canonical profile-memory entries.',
  params: {
    scope_id: {
      type: 'string',
      description: 'Profile-memory scope id (default: personal:default)',
    },
    subject: {
      type: 'string',
      description: 'Exact profile-memory subject filter',
    },
    profile_type: {
      type: 'string',
      description: 'Optional exact profile-memory type filter',
      enum: ['preference', 'routine', 'personal_project', 'stable_fact', 'relationship_boundary', 'other'],
    },
    limit: { type: 'number', description: 'Max results (default 20)' },
    offset: {
      type: 'number',
      description: 'Offset for pagination (default 0)',
    },
  },
  handler: async (ctx, p) => {
    return ctx.engine.listProfileMemoryEntries({
      scope_id: String(p.scope_id ?? DEFAULT_PROFILE_MEMORY_SCOPE_ID),
      subject: typeof p.subject === 'string' ? p.subject : undefined,
      profile_type: typeof p.profile_type === 'string' ? (p.profile_type as any) : undefined,
      limit: typeof p.limit === 'number' ? p.limit : 20,
      offset: typeof p.offset === 'number' ? p.offset : 0,
    });
  },
  cliHints: { name: 'profile-memory-list', aliases: { n: 'limit' } },
};

function requirePersonalSourceRef(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OperationError('invalid_params', 'source_ref is required for personal memory writes');
  }
  return value.trim();
}

// Personal memory writes must stay inside personal scope (Invariant 6 — work/personal
// isolation). Reject any work:* (or otherwise non-personal) scope on the personal write path.
function assertPersonalScopeId(scopeId: string): void {
  if (!scopeId.startsWith('personal:')) {
    throw new OperationError('invalid_params', `personal memory writes require a personal: scope, got "${scopeId}"`);
  }
}

function personalWriteScopeGateFields(preflight: PersonalWriteTargetResult) {
  return {
    scope_gate: preflight.scope_gate,
    scope_gate_policy: preflight.scope_gate.policy,
    scope_gate_reason: preflight.scope_gate.decision_reason,
  };
}

function resolvePersonalWriteScopeId(input: { requestedScopeId: unknown; preflight: PersonalWriteTargetResult }): string {
  if (!input.preflight.route) {
    throw new OperationError('invalid_params', `personal write blocked: ${input.preflight.selection_reason}`);
  }
  if (input.requestedScopeId !== undefined && typeof input.requestedScopeId !== 'string') {
    throw new OperationError('invalid_params', 'scope_id must be a string when provided');
  }
  const scopeId = input.requestedScopeId ?? input.preflight.route.scope_id;
  assertPersonalScopeId(scopeId);
  return scopeId;
}

function resolvePersonalMemoryWriteId(value: unknown): string {
  if (typeof value !== 'string') return crypto.randomUUID();
  const id = value.trim();
  return id.length > 0 ? id : crypto.randomUUID();
}

type PersonalMemoryWriteOperation = 'upsert_profile_memory_entry' | 'write_profile_memory_entry' | 'record_personal_episode' | 'write_personal_episode_entry';

async function recordPersonalMemoryWriteAudit(
  engine: BrainEngine,
  input: {
    operation: PersonalMemoryWriteOperation;
    targetKind: 'profile_memory' | 'personal_episode';
    targetId: string;
    scopeId: string;
    sourceRefs: string[];
    preflight: PersonalWriteTargetResult;
  },
): Promise<MemoryMutationEvent> {
  return recordMemoryMutationEvent(engine, {
    session_id: `${input.operation}:direct:${crypto.randomUUID()}`,
    realm_id: 'personal',
    actor: `mbrain:${input.operation}`,
    operation: input.operation,
    target_kind: input.targetKind,
    target_id: input.targetId,
    scope_id: input.scopeId,
    source_refs: input.sourceRefs,
    result: 'applied',
    dry_run: false,
    metadata: {
      scope_gate: input.preflight.scope_gate,
      scope_gate_policy: input.preflight.scope_gate.policy,
      scope_gate_reason: input.preflight.scope_gate.decision_reason,
      personal_write_target_selection_reason: input.preflight.selection_reason,
    },
  });
}

function personalMemoryDeleteAudit(operation: 'delete_profile_memory_entry' | 'delete_personal_episode_entry', scopeId: string, sourceRefs: string[]) {
  return {
    session_id: `${operation}:direct:${crypto.randomUUID()}`,
    realm_id: 'personal',
    actor: `mbrain:${operation}`,
    scope_id: scopeId,
    source_refs: sourceRefs,
  };
}

const upsert_profile_memory_entry: Operation = {
  name: 'upsert_profile_memory_entry',
  description: 'Create or update one canonical personal profile-memory entry.',
  params: {
    id: {
      type: 'string',
      description: 'Optional profile-memory entry id (generated when omitted)',
    },
    scope_id: {
      type: 'string',
      description: 'Profile-memory scope id (default: personal:default)',
    },
    profile_type: {
      type: 'string',
      required: true,
      description: 'Canonical profile-memory type',
      enum: ['preference', 'routine', 'personal_project', 'stable_fact', 'relationship_boundary', 'other'],
    },
    subject: {
      type: 'string',
      required: true,
      description: 'Exact profile-memory subject',
    },
    content: {
      type: 'string',
      required: true,
      description: 'Canonical profile-memory content',
    },
    source_ref: {
      type: 'string',
      required: true,
      description: 'Required single provenance string',
    },
    sensitivity: {
      type: 'string',
      description: 'Sensitivity classification',
      enum: ['public', 'personal', 'secret'],
    },
    export_status: {
      type: 'string',
      description: 'Export visibility status',
      enum: ['private_only', 'exportable'],
    },
    last_confirmed_at: {
      type: 'string',
      description: 'Optional ISO timestamp for last confirmation',
    },
    superseded_by: {
      type: 'string',
      description: 'Optional id of a newer superseding entry',
    },
  },
  mutating: true,
  handler: async (ctx, p) => {
    const sourceRef = requirePersonalSourceRef(p.source_ref);
    const preflight = await selectPersonalWriteTarget(ctx.engine, {
      target_kind: 'profile_memory',
      requested_scope: 'personal',
      subject: typeof p.subject === 'string' ? p.subject : undefined,
    });
    if (!preflight.route) {
      throw new OperationError('invalid_params', `profile_memory write blocked: ${preflight.selection_reason}`);
    }
    const id = resolvePersonalMemoryWriteId(p.id);
    const scopeId = resolvePersonalWriteScopeId({
      requestedScopeId: p.scope_id,
      preflight,
    });
    const scopeGate = personalWriteScopeGateFields(preflight);
    if (ctx.dryRun) {
      return {
        dry_run: true,
        action: 'upsert_profile_memory_entry',
        id,
        scope_id: scopeId,
        profile_type: p.profile_type,
        subject: p.subject,
        ...scopeGate,
      };
    }

    const applied = await ctx.engine.transaction(async (tx) => {
      const entry = await tx.upsertProfileMemoryEntry({
        id,
        scope_id: scopeId,
        profile_type: String(p.profile_type) as any,
        subject: String(p.subject),
        content: String(p.content),
        source_refs: [sourceRef],
        sensitivity: String(p.sensitivity ?? 'personal') as any,
        export_status: String(p.export_status ?? 'private_only') as any,
        last_confirmed_at: typeof p.last_confirmed_at === 'string' ? p.last_confirmed_at : null,
        superseded_by: typeof p.superseded_by === 'string' ? p.superseded_by : null,
      });
      const mutationEvent = await recordPersonalMemoryWriteAudit(tx, {
        operation: 'upsert_profile_memory_entry',
        targetKind: 'profile_memory',
        targetId: id,
        scopeId,
        sourceRefs: [sourceRef],
        preflight,
      });
      return { entry, mutationEvent };
    });
    return {
      ...applied.entry,
      ...scopeGate,
      mutation_event: applied.mutationEvent,
    };
  },
  cliHints: { name: 'profile-memory-upsert' },
};

const delete_profile_memory_entry: Operation = {
  name: 'delete_profile_memory_entry',
  description: 'Delete one canonical profile-memory entry by id.',
  params: {
    id: {
      type: 'string',
      required: true,
      description: 'Profile-memory entry id',
    },
  },
  mutating: true,
  handler: async (ctx, p) => {
    const id = String(p.id).trim();
    if (id.length === 0) {
      throw new OperationError('invalid_params', 'id must be a non-empty string');
    }
    const entry = await ctx.engine.getProfileMemoryEntry(id);
    if (!entry) {
      throw new OperationError('invalid_params', `profile-memory entry not found: ${id}`);
    }
    assertPersonalScopeId(entry.scope_id);
    if (ctx.dryRun)
      return {
        dry_run: true,
        action: 'delete_profile_memory_entry',
        id,
        scope_id: entry.scope_id,
      };
    await ctx.engine.transaction(async (tx) => {
      const transactionalEntry = await tx.getProfileMemoryEntry(id);
      if (!transactionalEntry) {
        throw new OperationError('invalid_params', `profile-memory entry not found: ${id}`);
      }
      assertPersonalScopeId(transactionalEntry.scope_id);
      await tx.deleteProfileMemoryEntry(id);
      await recordMemoryMutationEvent(tx, {
        ...personalMemoryDeleteAudit('delete_profile_memory_entry', transactionalEntry.scope_id, transactionalEntry.source_refs ?? []),
        operation: 'delete_profile_memory_entry',
        target_kind: 'profile_memory',
        target_id: id,
        result: 'applied',
        dry_run: false,
      });
    });
    return { status: 'deleted', id };
  },
  cliHints: { name: 'profile-memory-delete', positional: ['id'] },
};

const get_personal_episode_entry: Operation = {
  name: 'get_personal_episode_entry',
  description: 'Get one canonical personal-episode entry by id.',
  params: {
    id: {
      type: 'string',
      required: true,
      description: 'Personal-episode entry id',
    },
  },
  handler: async (ctx, p) => {
    return ctx.engine.getPersonalEpisodeEntry(String(p.id));
  },
  cliHints: { name: 'personal-episode-get' },
};

const list_personal_episode_entries: Operation = {
  name: 'list_personal_episode_entries',
  description: 'List canonical personal-episode entries.',
  params: {
    scope_id: {
      type: 'string',
      description: 'Personal-episode scope id (default: personal:default)',
    },
    title: {
      type: 'string',
      description: 'Exact personal-episode title filter',
    },
    source_kind: {
      type: 'string',
      description: 'Optional personal-episode source kind filter',
      enum: ['chat', 'note', 'import', 'meeting', 'reminder', 'other'],
    },
    limit: { type: 'number', description: 'Max results (default 20)' },
    offset: {
      type: 'number',
      description: 'Offset for pagination (default 0)',
    },
  },
  handler: async (ctx, p) => {
    return ctx.engine.listPersonalEpisodeEntries({
      scope_id: String(p.scope_id ?? DEFAULT_PROFILE_MEMORY_SCOPE_ID),
      title: typeof p.title === 'string' ? p.title : undefined,
      source_kind: typeof p.source_kind === 'string' ? (p.source_kind as any) : undefined,
      limit: typeof p.limit === 'number' ? p.limit : 20,
      offset: typeof p.offset === 'number' ? p.offset : 0,
    });
  },
  cliHints: { name: 'personal-episode-list', aliases: { n: 'limit' } },
};

const record_personal_episode: Operation = {
  name: 'record_personal_episode',
  description: 'Record one append-only canonical personal-episode entry.',
  params: {
    id: {
      type: 'string',
      description: 'Optional personal-episode id (generated when omitted)',
    },
    scope_id: {
      type: 'string',
      description: 'Personal-episode scope id (default: personal:default)',
    },
    title: {
      type: 'string',
      required: true,
      description: 'Compact personal-episode title',
    },
    start_time: {
      type: 'string',
      required: true,
      description: 'ISO timestamp for episode start',
    },
    end_time: {
      type: 'string',
      description: 'Optional ISO timestamp for episode end',
    },
    source_kind: {
      type: 'string',
      required: true,
      description: 'Personal-episode source kind',
      enum: ['chat', 'note', 'import', 'meeting', 'reminder', 'other'],
    },
    summary: { type: 'string', required: true, description: 'Episode summary' },
    source_ref: {
      type: 'string',
      required: true,
      description: 'Required single provenance string',
    },
    candidate_id: {
      type: 'string',
      description: 'Optional linked candidate or profile id',
    },
  },
  mutating: true,
  handler: async (ctx, p) => {
    const sourceRef = requirePersonalSourceRef(p.source_ref);
    const preflight = await selectPersonalWriteTarget(ctx.engine, {
      target_kind: 'personal_episode',
      requested_scope: 'personal',
      title: typeof p.title === 'string' ? p.title : undefined,
    });
    if (!preflight.route) {
      throw new OperationError('invalid_params', `personal_episode write blocked: ${preflight.selection_reason}`);
    }
    const id = resolvePersonalMemoryWriteId(p.id);
    const scopeId = resolvePersonalWriteScopeId({
      requestedScopeId: p.scope_id,
      preflight,
    });
    const scopeGate = personalWriteScopeGateFields(preflight);
    if (ctx.dryRun) {
      return {
        dry_run: true,
        action: 'record_personal_episode',
        id,
        scope_id: scopeId,
        title: p.title,
        source_kind: p.source_kind,
        ...scopeGate,
      };
    }

    const applied = await ctx.engine.transaction(async (tx) => {
      const entry = await tx.createPersonalEpisodeEntry({
        id,
        scope_id: scopeId,
        title: String(p.title),
        start_time: String(p.start_time),
        end_time: typeof p.end_time === 'string' ? p.end_time : null,
        source_kind: String(p.source_kind) as any,
        summary: String(p.summary),
        source_refs: [sourceRef],
        candidate_ids: typeof p.candidate_id === 'string' ? [p.candidate_id] : [],
      });
      const mutationEvent = await recordPersonalMemoryWriteAudit(tx, {
        operation: 'record_personal_episode',
        targetKind: 'personal_episode',
        targetId: id,
        scopeId,
        sourceRefs: [sourceRef],
        preflight,
      });
      return { entry, mutationEvent };
    });
    return {
      ...applied.entry,
      ...scopeGate,
      mutation_event: applied.mutationEvent,
    };
  },
  cliHints: { name: 'personal-episode-record' },
};

const delete_personal_episode_entry: Operation = {
  name: 'delete_personal_episode_entry',
  description: 'Delete one canonical personal-episode entry by id.',
  params: {
    id: {
      type: 'string',
      required: true,
      description: 'Personal-episode entry id',
    },
  },
  mutating: true,
  handler: async (ctx, p) => {
    const id = String(p.id).trim();
    if (id.length === 0) {
      throw new OperationError('invalid_params', 'id must be a non-empty string');
    }
    const entry = await ctx.engine.getPersonalEpisodeEntry(id);
    if (!entry) {
      throw new OperationError('invalid_params', `personal-episode entry not found: ${id}`);
    }
    assertPersonalScopeId(entry.scope_id);
    if (ctx.dryRun)
      return {
        dry_run: true,
        action: 'delete_personal_episode_entry',
        id,
        scope_id: entry.scope_id,
      };
    await ctx.engine.transaction(async (tx) => {
      const transactionalEntry = await tx.getPersonalEpisodeEntry(id);
      if (!transactionalEntry) {
        throw new OperationError('invalid_params', `personal-episode entry not found: ${id}`);
      }
      assertPersonalScopeId(transactionalEntry.scope_id);
      await tx.deletePersonalEpisodeEntry(id);
      await recordMemoryMutationEvent(tx, {
        ...personalMemoryDeleteAudit('delete_personal_episode_entry', transactionalEntry.scope_id, transactionalEntry.source_refs ?? []),
        operation: 'delete_personal_episode_entry',
        target_kind: 'personal_episode',
        target_id: id,
        result: 'applied',
        dry_run: false,
      });
    });
    return { status: 'deleted', id };
  },
  cliHints: { name: 'personal-episode-delete', positional: ['id'] },
};

const write_profile_memory_entry: Operation = {
  name: 'write_profile_memory_entry',
  description: 'Write one canonical profile-memory entry only after personal write-target preflight allows it.',
  params: {
    id: {
      type: 'string',
      description: 'Optional profile-memory entry id (generated when omitted)',
    },
    scope_id: {
      type: 'string',
      description: 'Profile-memory scope id (default: personal:default)',
    },
    profile_type: {
      type: 'string',
      required: true,
      description: 'Canonical profile-memory type',
      enum: ['preference', 'routine', 'personal_project', 'stable_fact', 'relationship_boundary', 'other'],
    },
    subject: {
      type: 'string',
      required: true,
      description: 'Exact profile-memory subject',
    },
    content: {
      type: 'string',
      required: true,
      description: 'Canonical profile-memory content',
    },
    query: {
      type: 'string',
      description: 'Plain-text request used for personal write-target preflight',
    },
    requested_scope: requestedScopeParam('Optional access scope override for personal write preflight. Use query for topical retrieval details.'),
    source_ref: {
      type: 'string',
      required: true,
      description: 'Required single provenance string',
    },
    sensitivity: {
      type: 'string',
      description: 'Sensitivity classification',
      enum: ['public', 'personal', 'secret'],
    },
    export_status: {
      type: 'string',
      description: 'Export visibility status',
      enum: ['private_only', 'exportable'],
    },
    last_confirmed_at: {
      type: 'string',
      description: 'Optional ISO timestamp for last confirmation',
    },
    superseded_by: {
      type: 'string',
      description: 'Optional id of a newer superseding entry',
    },
  },
  mutating: true,
  handler: async (ctx, p) => {
    const sourceRef = requirePersonalSourceRef(p.source_ref);
    const preflight = await selectPersonalWriteTarget(ctx.engine, {
      target_kind: 'profile_memory',
      requested_scope: parseRequestedScopeParam(p.requested_scope),
      query: typeof p.query === 'string' ? p.query : undefined,
      subject: typeof p.subject === 'string' ? p.subject : undefined,
    });

    if (!preflight.route) {
      throw new OperationError('invalid_params', `profile_memory write blocked: ${preflight.selection_reason}`);
    }

    const id = resolvePersonalMemoryWriteId(p.id);
    const scopeId = resolvePersonalWriteScopeId({
      requestedScopeId: p.scope_id,
      preflight,
    });
    const scopeGate = personalWriteScopeGateFields(preflight);
    if (ctx.dryRun) {
      return {
        dry_run: true,
        action: 'write_profile_memory_entry',
        id,
        scope_id: scopeId,
        profile_type: p.profile_type,
        subject: p.subject,
        preflight: preflight.selection_reason,
        ...scopeGate,
      };
    }

    const applied = await ctx.engine.transaction(async (tx) => {
      const entry = await tx.upsertProfileMemoryEntry({
        id,
        scope_id: scopeId,
        profile_type: String(p.profile_type) as any,
        subject: String(p.subject),
        content: String(p.content),
        source_refs: [sourceRef],
        sensitivity: String(p.sensitivity ?? 'personal') as any,
        export_status: String(p.export_status ?? 'private_only') as any,
        last_confirmed_at: typeof p.last_confirmed_at === 'string' ? p.last_confirmed_at : null,
        superseded_by: typeof p.superseded_by === 'string' ? p.superseded_by : null,
      });
      const mutationEvent = await recordPersonalMemoryWriteAudit(tx, {
        operation: 'write_profile_memory_entry',
        targetKind: 'profile_memory',
        targetId: id,
        scopeId,
        sourceRefs: [sourceRef],
        preflight,
      });
      return { entry, mutationEvent };
    });
    return {
      ...applied.entry,
      ...scopeGate,
      mutation_event: applied.mutationEvent,
    };
  },
  cliHints: { name: 'profile-memory-write' },
};

const write_personal_episode_entry: Operation = {
  name: 'write_personal_episode_entry',
  description: 'Write one canonical personal-episode entry only after personal write-target preflight allows it.',
  params: {
    id: {
      type: 'string',
      description: 'Optional personal-episode id (generated when omitted)',
    },
    scope_id: {
      type: 'string',
      description: 'Personal-episode scope id (default: personal:default)',
    },
    title: {
      type: 'string',
      required: true,
      description: 'Compact personal-episode title',
    },
    start_time: {
      type: 'string',
      required: true,
      description: 'ISO timestamp for episode start',
    },
    end_time: {
      type: 'string',
      description: 'Optional ISO timestamp for episode end',
    },
    source_kind: {
      type: 'string',
      required: true,
      description: 'Personal-episode source kind',
      enum: ['chat', 'note', 'import', 'meeting', 'reminder', 'other'],
    },
    summary: { type: 'string', required: true, description: 'Episode summary' },
    query: {
      type: 'string',
      description: 'Plain-text request used for personal write-target preflight',
    },
    requested_scope: requestedScopeParam('Optional access scope override for personal write preflight. Use query for topical retrieval details.'),
    source_ref: {
      type: 'string',
      required: true,
      description: 'Required single provenance string',
    },
    candidate_id: {
      type: 'string',
      description: 'Optional linked candidate or profile id',
    },
  },
  mutating: true,
  handler: async (ctx, p) => {
    const sourceRef = requirePersonalSourceRef(p.source_ref);
    const preflight = await selectPersonalWriteTarget(ctx.engine, {
      target_kind: 'personal_episode',
      requested_scope: parseRequestedScopeParam(p.requested_scope),
      query: typeof p.query === 'string' ? p.query : undefined,
      title: typeof p.title === 'string' ? p.title : undefined,
    });

    if (!preflight.route) {
      throw new OperationError('invalid_params', `personal_episode write blocked: ${preflight.selection_reason}`);
    }

    const id = resolvePersonalMemoryWriteId(p.id);
    const scopeId = resolvePersonalWriteScopeId({
      requestedScopeId: p.scope_id,
      preflight,
    });
    const scopeGate = personalWriteScopeGateFields(preflight);
    if (ctx.dryRun) {
      return {
        dry_run: true,
        action: 'write_personal_episode_entry',
        id,
        scope_id: scopeId,
        title: p.title,
        source_kind: p.source_kind,
        preflight: preflight.selection_reason,
        ...scopeGate,
      };
    }

    const applied = await ctx.engine.transaction(async (tx) => {
      const entry = await tx.createPersonalEpisodeEntry({
        id,
        scope_id: scopeId,
        title: String(p.title),
        start_time: String(p.start_time),
        end_time: typeof p.end_time === 'string' ? p.end_time : null,
        source_kind: String(p.source_kind) as any,
        summary: String(p.summary),
        source_refs: [sourceRef],
        candidate_ids: typeof p.candidate_id === 'string' ? [p.candidate_id] : [],
      });
      const mutationEvent = await recordPersonalMemoryWriteAudit(tx, {
        operation: 'write_personal_episode_entry',
        targetKind: 'personal_episode',
        targetId: id,
        scopeId,
        sourceRefs: [sourceRef],
        preflight,
      });
      return { entry, mutationEvent };
    });
    return {
      ...applied.entry,
      ...scopeGate,
      mutation_event: applied.mutationEvent,
    };
  },
  cliHints: { name: 'personal-episode-write' },
};

export function createProfileEpisodeOperations(): Operation[] {
  return [
    get_profile_memory_entry,
    list_profile_memory_entries,
    upsert_profile_memory_entry,
    delete_profile_memory_entry,
    write_profile_memory_entry,
    get_personal_episode_entry,
    list_personal_episode_entries,
    record_personal_episode,
    delete_personal_episode_entry,
    write_personal_episode_entry,
  ];
}
