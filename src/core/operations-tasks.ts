import { randomUUID } from 'crypto';
import type { BrainEngine } from './engine.ts';
import type { ErrorCode, Operation, ParamDef } from './operations.ts';
import {
  DEFAULT_NOTE_MANIFEST_SCOPE_ID,
} from './services/note-manifest-service.ts';
import { buildTaskResumeCard } from './services/task-memory-service.ts';
import { runWatchedQuestionProbes } from './services/watched-question-service.ts';
import type {
  AttemptOutcome,
  RetrievalRouteIntent,
  RetrievalTraceWriteOutcome,
  ScopeGatePolicy,
  TaskScope,
  TaskStatus,
  TaskThreadPatch,
} from './types.ts';

type OperationErrorCtor = new (
  code: ErrorCode,
  message: string,
  suggestion?: string,
  docs?: string,
) => Error;

const RETRIEVAL_TRACE_WRITE_OUTCOMES = [
  'no_durable_write',
  'operational_write',
  'candidate_created',
  'promoted',
  'rejected',
  'superseded',
] as const satisfies readonly RetrievalTraceWriteOutcome[];

const RETRIEVAL_ROUTE_INTENTS = [
  'task_resume',
  'broad_synthesis',
  'precision_lookup',
  'mixed_scope_bridge',
  'personal_profile_lookup',
  'personal_episode_lookup',
] as const satisfies readonly RetrievalRouteIntent[];

const TASK_SCOPES = ['work', 'personal', 'mixed'] as const satisfies readonly TaskScope[];
const TASK_STATUSES = ['active', 'paused', 'blocked', 'completed', 'abandoned'] as const satisfies readonly TaskStatus[];
const ATTEMPT_OUTCOMES = ['failed', 'partial', 'succeeded', 'abandoned'] as const satisfies readonly AttemptOutcome[];
const REQUESTED_SCOPES = TASK_SCOPES;
const REQUESTED_SCOPE_ENUM_ERROR_HINT = 'requested_scope is the access scope; put retrieval details in query.';
const SCOPE_GATE_POLICIES = ['allow', 'defer', 'deny'] as const satisfies readonly ScopeGatePolicy[];

export function createTaskOperations({
  OperationError,
}: {
  OperationError: OperationErrorCtor;
}): Operation[] {
  function parseStringListParam(value: unknown, key: string): string[] | undefined {
    if (value === undefined) return undefined;
    if (Array.isArray(value)) {
      return value.map((item) => String(item));
    }
    if (typeof value !== 'string') {
      throw new OperationError('invalid_params', `${key} must be an array or string list.`);
    }

    const trimmed = value.trim();
    if (trimmed === '') return [];

    if (trimmed.startsWith('[')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        throw new OperationError('invalid_params', `${key} must be valid JSON when passed as an array string.`);
      }
      if (!Array.isArray(parsed)) {
        throw new OperationError('invalid_params', `${key} JSON value must be an array.`);
      }
      return parsed.map((item) => String(item));
    }

    return trimmed
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  function parsePositiveIntegerParam(value: unknown, key: string): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
      throw new OperationError('invalid_params', `${key} must be a positive integer.`);
    }
    return value;
  }

  function parseNonNegativeIntegerParam(value: unknown, key: string): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
      throw new OperationError('invalid_params', `${key} must be a non-negative integer.`);
    }
    return value;
  }

  function parseEnumParam<T extends string>(
    value: unknown,
    key: string,
    allowed: readonly T[],
    hint?: string,
  ): T | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') {
      throw new OperationError('invalid_params', `${key} must be a string.`);
    }
    if (!(allowed as readonly string[]).includes(value)) {
      const base = `${key} must be one of: ${allowed.join(', ')}.`;
      throw new OperationError('invalid_params', hint ? `${base} ${hint}` : base);
    }
    return value as T;
  }

  function parseOptionalDateParam(value: unknown, key: string): Date | undefined {
    if (value === undefined) return undefined;
    if (value instanceof Date) return value;
    if (typeof value !== 'string') {
      throw new OperationError('invalid_params', `${key} must be an ISO datetime string.`);
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new OperationError('invalid_params', `${key} must be a valid ISO datetime string.`);
    }
    return parsed;
  }

  function requestedScopeParam(description: string): ParamDef {
    return {
      type: 'string',
      description,
      compactDescription: true,
      enum: [...REQUESTED_SCOPES],
      enumErrorHint: REQUESTED_SCOPE_ENUM_ERROR_HINT,
    };
  }

  function parseRequestedScopeParam(value: unknown): (typeof REQUESTED_SCOPES)[number] | undefined {
    return parseEnumParam(value, 'requested_scope', REQUESTED_SCOPES, REQUESTED_SCOPE_ENUM_ERROR_HINT);
  }

  async function requireTaskThread(engine: BrainEngine, taskId: string) {
    const thread = await engine.getTaskThread(taskId);
    if (!thread) {
      throw new OperationError('task_not_found', `Task thread not found: ${taskId}`, 'Check the task id or create the task first.');
    }
    return thread;
  }

  const list_tasks: Operation = {
    name: 'list_tasks',
    description: 'List task threads from canonical operational memory.',
    params: {
      scope: {
        type: 'string',
        description: 'Filter by task scope',
        enum: ['work', 'personal', 'mixed'],
      },
      status: {
        type: 'string',
        description: 'Filter by task status',
        enum: ['active', 'paused', 'blocked', 'completed', 'abandoned'],
      },
      limit: { type: 'number', description: 'Max results (default 20)' },
    },
    handler: async (ctx, p) => {
      return ctx.engine.listTaskThreads({
        scope: parseEnumParam(p.scope, 'scope', TASK_SCOPES),
        status: parseEnumParam(p.status, 'status', TASK_STATUSES),
        limit: (p.limit as number) ?? 20,
      });
    },
    cliHints: { name: 'task-list', aliases: { n: 'limit' } },
  };

  const start_task: Operation = {
    name: 'start_task',
    description: 'Create a new operational-memory task thread.',
    params: {
      title: { type: 'string', required: true, description: 'Task title' },
      goal: { type: 'string', description: 'Task goal' },
      scope: {
        type: 'string',
        description: 'Task scope',
        default: 'work',
        enum: ['work', 'personal', 'mixed'],
      },
    },
    mutating: true,
    handler: async (ctx, p) => {
      const id = randomUUID();
      const scope = parseEnumParam(p.scope, 'scope', TASK_SCOPES) ?? 'work';
      if (ctx.dryRun) {
        return {
          dry_run: true,
          action: 'start_task',
          id,
          title: p.title,
          scope,
        };
      }

      return ctx.engine.transaction(async (tx) => {
        await tx.createTaskThread({
          id,
          scope,
          title: String(p.title),
          goal: String(p.goal ?? ''),
          status: 'active',
          repo_path: process.cwd(),
          branch_name: null,
          current_summary: '',
        });

        await tx.upsertTaskWorkingSet({
          task_id: id,
          active_paths: [],
          active_symbols: [],
          blockers: [],
          open_questions: [],
          next_steps: [],
          verification_notes: [],
          last_verified_at: null,
        });

        return tx.getTaskThread(id);
      });
    },
    cliHints: { name: 'task-start' },
  };

  const update_task: Operation = {
    name: 'update_task',
    description: 'Update canonical task-thread state for an existing task.',
    params: {
      task_id: { type: 'string', required: true, description: 'Task thread id' },
      title: { type: 'string', description: 'Updated task title' },
      goal: { type: 'string', description: 'Updated task goal' },
      status: {
        type: 'string',
        description: 'Updated task status',
        enum: ['active', 'paused', 'blocked', 'completed', 'abandoned'],
      },
      current_summary: { type: 'string', description: 'Updated task summary' },
    },
    mutating: true,
    handler: async (ctx, p) => {
      const taskId = String(p.task_id);
      const patch: TaskThreadPatch = {};
      if (typeof p.title === 'string') patch.title = p.title;
      if (typeof p.goal === 'string') patch.goal = p.goal;
      if (p.status !== undefined) patch.status = parseEnumParam(p.status, 'status', TASK_STATUSES);
      if (typeof p.current_summary === 'string') patch.current_summary = p.current_summary;

      if (Object.keys(patch).length === 0) {
        throw new OperationError('invalid_params', 'update_task requires at least one patch field.');
      }

      if (ctx.dryRun) {
        return { dry_run: true, action: 'update_task', task_id: taskId, patch };
      }

      await requireTaskThread(ctx.engine, taskId);
      const updated = await ctx.engine.updateTaskThread(taskId, patch);
      return {
        ...updated,
        working_set_stale: true,
        next_action: `Run refresh_task_working_set for ${taskId} if task scope, files, blockers, or next steps changed.`,
      };
    },
    cliHints: { name: 'task-update', positional: ['task_id'] },
  };

  const resume_task: Operation = {
    name: 'resume_task',
    description: 'Resume an operational-memory task thread from canonical task state.',
    params: {
      task_id: { type: 'string', required: true, description: 'Task thread id' },
    },
    handler: async (ctx, p) => {
      return buildTaskResumeCard(ctx.engine, p.task_id as string);
    },
    cliHints: { name: 'task-resume', positional: ['task_id'] },
  };

  const get_task_working_set: Operation = {
    name: 'get_task_working_set',
    description: 'Get the canonical task thread and working-set state for one task.',
    params: {
      task_id: { type: 'string', required: true, description: 'Task thread id' },
    },
    handler: async (ctx, p) => {
      const thread = await requireTaskThread(ctx.engine, String(p.task_id));
      const workingSet = await ctx.engine.getTaskWorkingSet(String(p.task_id));
      return {
        thread,
        working_set: workingSet,
      };
    },
    cliHints: { name: 'task-show', positional: ['task_id'] },
  };

  const record_retrieval_trace: Operation = {
    name: 'record_retrieval_trace',
    description: 'Record a retrieval trace for a task-scoped operational-memory flow.',
    params: {
      task_id: { type: 'string', required: true, description: 'Task thread id' },
      outcome: {
        type: 'string',
        required: true,
        description: 'Trace outcome summary',
      },
      route: {
        type: ['array', 'string'],
        items: { type: 'string' },
        description: 'Ordered retrieval route',
      },
      source_refs: {
        type: ['array', 'string'],
        items: { type: 'string' },
        description: 'Source references consulted',
      },
      derived_consulted: {
        type: ['array', 'string'],
        items: { type: 'string' },
        description: 'Derived artifacts consulted separately from canonical source refs',
      },
      verification: {
        type: ['array', 'string'],
        items: { type: 'string' },
        description: 'Verification steps performed',
      },
      write_outcome: {
        type: 'string',
        enum: [...RETRIEVAL_TRACE_WRITE_OUTCOMES],
        description: 'Structured write outcome for the trace',
      },
      selected_intent: {
        type: 'string',
        enum: [...RETRIEVAL_ROUTE_INTENTS],
        description: 'Structured retrieval intent selected for the trace',
      },
      scope_gate_policy: {
        type: 'string',
        enum: [...SCOPE_GATE_POLICIES],
        description: 'Structured scope gate policy, when evaluated',
      },
      scope_gate_reason: {
        type: 'string',
        description: 'Structured scope gate reason, when evaluated',
      },
    },
    mutating: true,
    handler: async (ctx, p) => {
      const taskId = String(p.task_id);
      const route = parseStringListParam(p.route, 'route') ?? [];
      const sourceRefs = parseStringListParam(p.source_refs, 'source_refs') ?? [];
      const derivedConsulted = parseStringListParam(p.derived_consulted, 'derived_consulted') ?? [];
      const verification = parseStringListParam(p.verification, 'verification') ?? [];
      const writeOutcome = parseEnumParam(p.write_outcome, 'write_outcome', RETRIEVAL_TRACE_WRITE_OUTCOMES);
      const selectedIntent = parseEnumParam(p.selected_intent, 'selected_intent', RETRIEVAL_ROUTE_INTENTS);
      const scopeGatePolicy = parseEnumParam(p.scope_gate_policy, 'scope_gate_policy', SCOPE_GATE_POLICIES);
      const scopeGateReason = typeof p.scope_gate_reason === 'string' ? p.scope_gate_reason : undefined;

      if (ctx.dryRun) {
        return {
          dry_run: true,
          action: 'record_retrieval_trace',
          task_id: taskId,
          outcome: String(p.outcome),
          route,
          source_refs: sourceRefs,
          derived_consulted: derivedConsulted,
          verification,
          write_outcome: writeOutcome,
          selected_intent: selectedIntent,
          scope_gate_policy: scopeGatePolicy,
          scope_gate_reason: scopeGateReason,
        };
      }

      const thread = await requireTaskThread(ctx.engine, taskId);
      return ctx.engine.putRetrievalTrace({
        id: randomUUID(),
        task_id: taskId,
        scope: thread.scope,
        route,
        source_refs: sourceRefs,
        derived_consulted: derivedConsulted,
        verification,
        write_outcome: writeOutcome,
        selected_intent: selectedIntent,
        scope_gate_policy: scopeGatePolicy,
        scope_gate_reason: scopeGateReason ?? null,
        outcome: String(p.outcome),
      });
    },
    cliHints: { name: 'task-trace', positional: ['task_id'] },
  };

  const list_task_traces: Operation = {
    name: 'list_task_traces',
    description: 'List retrieval traces for one task thread.',
    params: {
      task_id: { type: 'string', required: true, description: 'Task thread id' },
      limit: { type: 'number', description: 'Max results (default 10)' },
    },
    handler: async (ctx, p) => {
      const taskId = String(p.task_id);
      await requireTaskThread(ctx.engine, taskId);
      return ctx.engine.listRetrievalTraces(taskId, {
        limit: (p.limit as number) ?? 10,
      });
    },
    cliHints: {
      name: 'task-traces',
      positional: ['task_id'],
      aliases: { n: 'limit' },
    },
  };

  const watch_question: Operation = {
    name: 'watch_question',
    description: 'Pin a retrieval question so the nightly Dream report can diff required reads and content hashes.',
    params: {
      question: { type: 'string', required: true, description: 'Question to probe repeatedly' },
      id: { type: 'string', description: 'Optional stable watched question id' },
      scope_id: { type: 'string', description: 'Scope id (default: workspace:default)' },
      requested_scope: requestedScopeParam('Optional access scope for the watched retrieval probe.'),
      enabled: { type: 'boolean', description: 'Whether the watched question is active (default true)' },
    },
    mutating: true,
    handler: async (ctx, p) => {
      const question = String(p.question ?? '').trim();
      if (!question) throw new OperationError('invalid_params', 'question is required.');
      const input = {
        ...(typeof p.id === 'string' ? { id: p.id } : {}),
        scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
        question,
        requested_scope: parseRequestedScopeParam(p.requested_scope) ?? null,
        enabled: p.enabled === false ? false : true,
      };
      if (ctx.dryRun) return { dry_run: true, action: 'watch_question', ...input };
      return ctx.engine.upsertWatchedQuestion(input);
    },
    cliHints: { name: 'watch-question', positional: ['question'], aliases: { scope: 'requested_scope' } },
  };

  const list_watched_questions: Operation = {
    name: 'list_watched_questions',
    description: 'List pinned watched questions and their latest probe state.',
    params: {
      scope_id: { type: 'string', description: 'Scope id filter' },
      enabled: { type: 'boolean', description: 'Enabled-state filter' },
      limit: { type: 'number', description: 'Max results (default 100)' },
      offset: { type: 'number', description: 'Pagination offset' },
    },
    handler: async (ctx, p) => ctx.engine.listWatchedQuestions({
      scope_id: typeof p.scope_id === 'string' ? p.scope_id : undefined,
      enabled: typeof p.enabled === 'boolean' ? p.enabled : undefined,
      limit: parsePositiveIntegerParam(p.limit, 'limit'),
      offset: parseNonNegativeIntegerParam(p.offset, 'offset'),
    }),
    cliHints: { name: 'watched-questions', aliases: { n: 'limit' } },
  };

  const unwatch_question: Operation = {
    name: 'unwatch_question',
    description: 'Disable a watched question without deleting its probe history.',
    params: {
      id: { type: 'string', required: true, description: 'Watched question id' },
    },
    mutating: true,
    handler: async (ctx, p) => {
      const id = String(p.id ?? '').trim();
      if (!id) throw new OperationError('invalid_params', 'id is required.');
      if (ctx.dryRun) return { dry_run: true, action: 'unwatch_question', id, enabled: false };
      return ctx.engine.setWatchedQuestionEnabled(id, false);
    },
    cliHints: { name: 'unwatch-question', positional: ['id'] },
  };

  const run_watched_questions: Operation = {
    name: 'run_watched_questions',
    description: 'Run deterministic watched-question retrieval probes and record required-read diffs for the daily report.',
    params: {
      scope_id: { type: 'string', description: 'Scope id (default: workspace:default)' },
      now: { type: 'string', description: 'Optional ISO timestamp for deterministic runs' },
      limit: { type: 'number', description: 'Max watched questions to probe' },
    },
    mutating: true,
    handler: async (ctx, p) => runWatchedQuestionProbes(ctx.engine, {
      scope_id: String(p.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID),
      now: typeof p.now === 'string' ? p.now : undefined,
      limit: parsePositiveIntegerParam(p.limit, 'limit'),
    }),
    cliHints: { name: 'watched-questions-run', aliases: { n: 'limit' } },
  };

  const list_task_attempts: Operation = {
    name: 'list_task_attempts',
    description: 'List recorded attempts for one task thread.',
    params: {
      task_id: { type: 'string', required: true, description: 'Task thread id' },
      limit: { type: 'number', description: 'Max results (default 10)' },
    },
    handler: async (ctx, p) => {
      const taskId = String(p.task_id);
      await requireTaskThread(ctx.engine, taskId);
      return ctx.engine.listTaskAttempts(taskId, {
        limit: (p.limit as number) ?? 10,
      });
    },
    cliHints: {
      name: 'task-attempts',
      positional: ['task_id'],
      aliases: { n: 'limit' },
    },
  };

  const list_task_decisions: Operation = {
    name: 'list_task_decisions',
    description: 'List recorded decisions for one task thread.',
    params: {
      task_id: { type: 'string', required: true, description: 'Task thread id' },
      limit: { type: 'number', description: 'Max results (default 10)' },
    },
    handler: async (ctx, p) => {
      const taskId = String(p.task_id);
      await requireTaskThread(ctx.engine, taskId);
      return ctx.engine.listTaskDecisions(taskId, {
        limit: (p.limit as number) ?? 10,
      });
    },
    cliHints: {
      name: 'task-decisions',
      positional: ['task_id'],
      aliases: { n: 'limit' },
    },
  };

  const refresh_task_working_set: Operation = {
    name: 'refresh_task_working_set',
    description: 'Refresh a task working set snapshot and advance its verification timestamp.',
    params: {
      task_id: { type: 'string', required: true, description: 'Task thread id' },
      active_paths: {
        type: ['array', 'string'],
        items: { type: 'string' },
        description: 'Active file paths',
      },
      active_symbols: {
        type: ['array', 'string'],
        items: { type: 'string' },
        description: 'Active symbols',
      },
      blockers: {
        type: ['array', 'string'],
        items: { type: 'string' },
        description: 'Current blockers',
      },
      open_questions: {
        type: ['array', 'string'],
        items: { type: 'string' },
        description: 'Open questions',
      },
      next_steps: {
        type: ['array', 'string'],
        items: { type: 'string' },
        description: 'Next steps',
      },
      verification_notes: {
        type: ['array', 'string'],
        items: { type: 'string' },
        description: 'Verification notes',
      },
      last_verified_at: {
        type: 'string',
        description: 'Override verification timestamp (ISO datetime)',
      },
    },
    mutating: true,
    handler: async (ctx, p) => {
      const taskId = String(p.task_id);
      if (ctx.dryRun) {
        return {
          dry_run: true,
          action: 'refresh_task_working_set',
          task_id: taskId,
        };
      }

      await requireTaskThread(ctx.engine, taskId);
      const existing = await ctx.engine.getTaskWorkingSet(taskId);
      return ctx.engine.upsertTaskWorkingSet({
        task_id: taskId,
        active_paths: parseStringListParam(p.active_paths, 'active_paths') ?? existing?.active_paths ?? [],
        active_symbols: parseStringListParam(p.active_symbols, 'active_symbols') ?? existing?.active_symbols ?? [],
        blockers: parseStringListParam(p.blockers, 'blockers') ?? existing?.blockers ?? [],
        open_questions: parseStringListParam(p.open_questions, 'open_questions') ?? existing?.open_questions ?? [],
        next_steps: parseStringListParam(p.next_steps, 'next_steps') ?? existing?.next_steps ?? [],
        verification_notes: parseStringListParam(p.verification_notes, 'verification_notes') ?? existing?.verification_notes ?? [],
        last_verified_at: parseOptionalDateParam(p.last_verified_at, 'last_verified_at') ?? new Date(),
      });
    },
    cliHints: { name: 'task-working-set', positional: ['task_id'] },
  };

  const record_attempt: Operation = {
    name: 'record_attempt',
    description: 'Record a task attempt outcome for repeated-work prevention.',
    params: {
      task_id: { type: 'string', required: true, description: 'Task thread id' },
      summary: { type: 'string', required: true, description: 'Attempt summary' },
      outcome: {
        type: 'string',
        required: true,
        description: 'Attempt outcome',
        enum: ['failed', 'partial', 'succeeded', 'abandoned'],
      },
    },
    mutating: true,
    handler: async (ctx, p) => {
      const outcome = parseEnumParam(p.outcome, 'outcome', ATTEMPT_OUTCOMES);
      if (!outcome) {
        throw new OperationError('invalid_params', 'outcome is required.');
      }
      if (ctx.dryRun) {
        return {
          dry_run: true,
          action: 'record_attempt',
          task_id: p.task_id,
          summary: p.summary,
        };
      }

      await requireTaskThread(ctx.engine, String(p.task_id));
      return ctx.engine.recordTaskAttempt({
        id: randomUUID(),
        task_id: String(p.task_id),
        summary: String(p.summary),
        outcome,
        applicability_context: {},
        evidence: [],
      });
    },
    cliHints: { name: 'task-attempt' },
  };

  const record_decision: Operation = {
    name: 'record_decision',
    description: 'Record a task decision and rationale.',
    params: {
      task_id: { type: 'string', required: true, description: 'Task thread id' },
      summary: {
        type: 'string',
        required: true,
        description: 'Decision summary',
      },
      rationale: {
        type: 'string',
        required: true,
        description: 'Decision rationale',
      },
    },
    mutating: true,
    handler: async (ctx, p) => {
      if (ctx.dryRun) {
        return {
          dry_run: true,
          action: 'record_decision',
          task_id: p.task_id,
          summary: p.summary,
        };
      }

      await requireTaskThread(ctx.engine, String(p.task_id));
      return ctx.engine.recordTaskDecision({
        id: randomUUID(),
        task_id: String(p.task_id),
        summary: String(p.summary),
        rationale: String(p.rationale),
        consequences: [],
        validity_context: {},
      });
    },
    cliHints: { name: 'task-decision' },
  };

  return [
    list_tasks,
    start_task,
    update_task,
    resume_task,
    get_task_working_set,
    record_retrieval_trace,
    list_task_traces,
    watch_question,
    list_watched_questions,
    unwatch_question,
    run_watched_questions,
    list_task_attempts,
    list_task_decisions,
    refresh_task_working_set,
    record_attempt,
    record_decision,
  ];
}
