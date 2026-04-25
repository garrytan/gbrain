import { expect, test } from 'bun:test';
import { formatResult, OperationError, operations } from '../src/core/operations.ts';

test('task operations are registered with CLI hints', () => {
  const start = operations.find((operation) => operation.name === 'start_task');
  const list = operations.find((operation) => operation.name === 'list_tasks');
  const update = operations.find((operation) => operation.name === 'update_task');
  const resume = operations.find((operation) => operation.name === 'resume_task');
  const show = operations.find((operation) => operation.name === 'get_task_working_set');
  const refresh = operations.find((operation) => operation.name === 'refresh_task_working_set');
  const trace = operations.find((operation) => operation.name === 'record_retrieval_trace');
  const traces = operations.find((operation) => operation.name === 'list_task_traces');
  const attempts = operations.find((operation) => operation.name === 'list_task_attempts');
  const decisions = operations.find((operation) => operation.name === 'list_task_decisions');
  const attempt = operations.find((operation) => operation.name === 'record_attempt');
  const decision = operations.find((operation) => operation.name === 'record_decision');

  expect(start?.cliHints?.name).toBe('task-start');
  expect(list?.cliHints?.name).toBe('task-list');
  expect(update?.cliHints?.name).toBe('task-update');
  expect(resume?.cliHints?.name).toBe('task-resume');
  expect(show?.cliHints?.name).toBe('task-show');
  expect(refresh?.cliHints?.name).toBe('task-working-set');
  expect(trace?.cliHints?.name).toBe('task-trace');
  expect(traces?.cliHints?.name).toBe('task-traces');
  expect(attempts?.cliHints?.name).toBe('task-attempts');
  expect(decisions?.cliHints?.name).toBe('task-decisions');
  expect(attempt?.cliHints?.name).toBe('task-attempt');
  expect(decision?.cliHints?.name).toBe('task-decision');
});

test('list_tasks forwards filters and formatResult renders task rows', async () => {
  const list = operations.find((operation) => operation.name === 'list_tasks');
  if (!list) throw new Error('list_tasks operation is missing');

  const calls: Array<Record<string, unknown> | undefined> = [];
  const tasks = await list.handler({
    engine: {
      listTaskThreads: async (filters?: Record<string, unknown>) => {
        calls.push(filters);
        return [
          {
            id: 'task-1',
            scope: 'work',
            title: 'Phase 1 MVP',
            goal: 'Ship operational memory',
            status: 'blocked',
            repo_path: '/repo',
            branch_name: 'docs/mbrain-redesign-doc-set',
            current_summary: 'Need read surface',
            created_at: new Date('2026-04-19T00:00:00.000Z'),
            updated_at: new Date('2026-04-19T00:05:00.000Z'),
          },
        ];
      },
    } as any,
    config: {} as any,
    logger: console,
    dryRun: false,
  }, {
    status: 'blocked',
    limit: 5,
  });

  expect(calls).toEqual([{ scope: undefined, status: 'blocked', limit: 5 }]);
  const output = formatResult('list_tasks', tasks, { limit: 5 });
  expect(output).toContain('task-1');
  expect(output).toContain('blocked');
  expect(output).toContain('Phase 1 MVP');
});

test('get_task_working_set returns canonical task state', async () => {
  const show = operations.find((operation) => operation.name === 'get_task_working_set');
  if (!show) throw new Error('get_task_working_set operation is missing');

  const result = await show.handler({
    engine: {
      getTaskThread: async () => ({
        id: 'task-1',
        scope: 'work',
        title: 'Phase 1 MVP',
        goal: 'Ship operational memory',
        status: 'blocked',
        repo_path: '/repo',
        branch_name: 'docs/mbrain-redesign-doc-set',
        current_summary: 'Need task list and task show',
        created_at: new Date('2026-04-19T00:00:00.000Z'),
        updated_at: new Date('2026-04-19T00:05:00.000Z'),
      }),
      getTaskWorkingSet: async () => ({
        task_id: 'task-1',
        active_paths: ['src/core/operations.ts'],
        active_symbols: ['list_tasks', 'get_task_working_set'],
        blockers: ['task read surface missing'],
        open_questions: ['should task show include attempts later'],
        next_steps: ['add read operations'],
        verification_notes: ['resume still canonical'],
        last_verified_at: new Date('2026-04-19T00:04:00.000Z'),
        updated_at: new Date('2026-04-19T00:05:00.000Z'),
      }),
    } as any,
    config: {} as any,
    logger: console,
    dryRun: false,
  }, {
    task_id: 'task-1',
  });

  const output = formatResult('get_task_working_set', result);
  expect(output).toContain('Phase 1 MVP');
  expect(output).toContain('list_tasks');
  expect(output).toContain('should task show include attempts later');
  expect(output).toContain('2026-04-19T00:04:00.000Z');
});

test('get_task_working_set rejects unknown task ids with a stable error', async () => {
  const show = operations.find((operation) => operation.name === 'get_task_working_set');
  if (!show) throw new Error('get_task_working_set operation is missing');

  await expect(show.handler({
    engine: {
      getTaskThread: async () => null,
    } as any,
    config: {} as any,
    logger: console,
    dryRun: false,
  }, {
    task_id: 'missing-task',
  })).rejects.toMatchObject({ code: 'task_not_found' });
});

test('update_task forwards the allowed patch fields to canonical task state', async () => {
  const update = operations.find((operation) => operation.name === 'update_task');
  if (!update) throw new Error('update_task operation is missing');

  const calls: Array<Record<string, unknown>> = [];
  const result = await update.handler({
    engine: {
      getTaskThread: async () => ({
        id: 'task-1',
        scope: 'work',
        title: 'Phase 1 MVP',
        goal: 'Ship operational memory',
        status: 'active',
        repo_path: '/repo',
        branch_name: 'docs/mbrain-redesign-doc-set',
        current_summary: 'Need mutation surface',
        created_at: new Date('2026-04-19T00:00:00.000Z'),
        updated_at: new Date('2026-04-19T00:05:00.000Z'),
      }),
      updateTaskThread: async (id: string, patch: Record<string, unknown>) => {
        calls.push({ id, ...patch });
        return {
          id,
          scope: 'work',
          title: String(patch.title),
          goal: String(patch.goal),
          status: String(patch.status),
          repo_path: '/repo',
          branch_name: 'docs/mbrain-redesign-doc-set',
          current_summary: String(patch.current_summary),
          created_at: new Date('2026-04-19T00:00:00.000Z'),
          updated_at: new Date('2026-04-19T00:06:00.000Z'),
        };
      },
    } as any,
    config: {} as any,
    logger: console,
    dryRun: false,
  }, {
    task_id: 'task-1',
    title: 'Phase 1 polish',
    goal: 'Ship operational memory cleanly',
    status: 'blocked',
    current_summary: 'Waiting on review feedback',
  });

  expect(calls).toEqual([{
    id: 'task-1',
    title: 'Phase 1 polish',
    goal: 'Ship operational memory cleanly',
    status: 'blocked',
    current_summary: 'Waiting on review feedback',
  }]);
  expect((result as any).status).toBe('blocked');
  expect((result as any).current_summary).toBe('Waiting on review feedback');
});

test('update_task rejects unknown task ids with a stable error', async () => {
  const update = operations.find((operation) => operation.name === 'update_task');
  if (!update) throw new Error('update_task operation is missing');

  await expect(update.handler({
    engine: {
      getTaskThread: async () => null,
    } as any,
    config: {} as any,
    logger: console,
    dryRun: false,
  }, {
    task_id: 'missing-task',
    status: 'blocked',
  })).rejects.toMatchObject({ code: 'task_not_found' });
});

test('update_task supports dry-run without a live task lookup', async () => {
  const update = operations.find((operation) => operation.name === 'update_task');
  if (!update) throw new Error('update_task operation is missing');

  const result = await update.handler({
    engine: {} as any,
    config: {} as any,
    logger: console,
    dryRun: true,
  }, {
    task_id: 'task-1',
    status: 'blocked',
  });

  expect(result).toEqual({
    dry_run: true,
    action: 'update_task',
    task_id: 'task-1',
    patch: {
      status: 'blocked',
    },
  });
});

test('record_retrieval_trace derives scope from the task thread and persists the trace', async () => {
  const trace = operations.find((operation) => operation.name === 'record_retrieval_trace');
  if (!trace) throw new Error('record_retrieval_trace operation is missing');

  const calls: Array<Record<string, unknown>> = [];
  const result = await trace.handler({
    engine: {
      getTaskThread: async () => ({
        id: 'task-1',
        scope: 'work',
        title: 'Phase 1 MVP',
        goal: 'Ship operational memory',
        status: 'blocked',
        repo_path: '/repo',
        branch_name: 'docs/mbrain-redesign-doc-set',
        current_summary: 'Need trace surface',
        created_at: new Date('2026-04-19T00:00:00.000Z'),
        updated_at: new Date('2026-04-19T00:05:00.000Z'),
      }),
      putRetrievalTrace: async (payload: Record<string, unknown>) => {
        calls.push(payload);
        return {
          ...payload,
          created_at: new Date('2026-04-19T00:06:00.000Z'),
        };
      },
    } as any,
    config: {} as any,
    logger: console,
    dryRun: false,
  }, {
    task_id: 'task-1',
    outcome: 'resume path assembled',
    route: ['task_thread', 'working_set', 'attempts'],
    source_refs: ['task-thread:task-1'],
    derived_consulted: ['context-map:workspace'],
    verification: ['current branch verified'],
    write_outcome: 'operational_write',
    selected_intent: 'task_resume',
    scope_gate_policy: 'allow',
    scope_gate_reason: 'explicit_work_scope',
  });

  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({
    task_id: 'task-1',
    scope: 'work',
    outcome: 'resume path assembled',
    route: ['task_thread', 'working_set', 'attempts'],
    source_refs: ['task-thread:task-1'],
    derived_consulted: ['context-map:workspace'],
    verification: ['current branch verified'],
    write_outcome: 'operational_write',
    selected_intent: 'task_resume',
    scope_gate_policy: 'allow',
    scope_gate_reason: 'explicit_work_scope',
  });
  expect((result as any).created_at).toBeInstanceOf(Date);
});

test('list_task_traces forwards task and limit filters and formats rows', async () => {
  const traces = operations.find((operation) => operation.name === 'list_task_traces');
  if (!traces) throw new Error('list_task_traces operation is missing');

  const calls: Array<Record<string, unknown>> = [];
  const result = await traces.handler({
    engine: {
      getTaskThread: async () => ({
        id: 'task-1',
        scope: 'work',
        title: 'Phase 1 MVP',
        goal: 'Ship operational memory',
        status: 'blocked',
        repo_path: '/repo',
        branch_name: 'docs/mbrain-redesign-doc-set',
        current_summary: 'Need trace read surface',
        created_at: new Date('2026-04-19T00:00:00.000Z'),
        updated_at: new Date('2026-04-19T00:05:00.000Z'),
      }),
      listRetrievalTraces: async (taskId: string, filters?: Record<string, unknown>) => {
        calls.push({ taskId, ...filters });
        return [
          {
            id: 'trace-1',
            task_id: 'task-1',
            scope: 'work',
            route: ['task_thread', 'working_set', 'attempts'],
            source_refs: ['task-thread:task-1'],
            verification: ['current branch verified'],
            outcome: 'resume path assembled',
            created_at: new Date('2026-04-19T00:06:00.000Z'),
          },
        ];
      },
    } as any,
    config: {} as any,
    logger: console,
    dryRun: false,
  }, {
    task_id: 'task-1',
    limit: 5,
  });

  expect(calls).toEqual([{ taskId: 'task-1', limit: 5 }]);
  const output = formatResult('list_task_traces', result, { limit: 5 });
  expect(output).toContain('trace-1');
  expect(output).toContain('resume path assembled');
  expect(output).toContain('task_thread -> working_set -> attempts');
});

test('list_task_attempts forwards task and limit filters and formats rows', async () => {
  const attempts = operations.find((operation) => operation.name === 'list_task_attempts');
  if (!attempts) throw new Error('list_task_attempts operation is missing');

  const calls: Array<Record<string, unknown>> = [];
  const result = await attempts.handler({
    engine: {
      getTaskThread: async () => ({
        id: 'task-1',
        scope: 'work',
        title: 'Phase 1 MVP',
        goal: 'Ship operational memory',
        status: 'blocked',
        repo_path: '/repo',
        branch_name: 'docs/mbrain-redesign-doc-set',
        current_summary: 'Need attempt history surface',
        created_at: new Date('2026-04-19T00:00:00.000Z'),
        updated_at: new Date('2026-04-19T00:05:00.000Z'),
      }),
      listTaskAttempts: async (taskId: string, filters?: Record<string, unknown>) => {
        calls.push({ taskId, ...filters });
        return [
          {
            id: 'attempt-1',
            task_id: 'task-1',
            summary: 'Tried raw-source-only reconstruction',
            outcome: 'failed',
            applicability_context: { branch: 'docs/mbrain-redesign-doc-set' },
            evidence: ['resume drifted'],
            created_at: new Date('2026-04-19T00:06:00.000Z'),
          },
        ];
      },
    } as any,
    config: {} as any,
    logger: console,
    dryRun: false,
  }, {
    task_id: 'task-1',
    limit: 5,
  });

  expect(calls).toEqual([{ taskId: 'task-1', limit: 5 }]);
  const output = formatResult('list_task_attempts', result, { limit: 5 });
  expect(output).toContain('attempt-1');
  expect(output).toContain('failed');
  expect(output).toContain('Tried raw-source-only reconstruction');
});

test('list_task_decisions forwards task and limit filters and formats rows', async () => {
  const decisions = operations.find((operation) => operation.name === 'list_task_decisions');
  if (!decisions) throw new Error('list_task_decisions operation is missing');

  const calls: Array<Record<string, unknown>> = [];
  const result = await decisions.handler({
    engine: {
      getTaskThread: async () => ({
        id: 'task-1',
        scope: 'work',
        title: 'Phase 1 MVP',
        goal: 'Ship operational memory',
        status: 'blocked',
        repo_path: '/repo',
        branch_name: 'docs/mbrain-redesign-doc-set',
        current_summary: 'Need decision history surface',
        created_at: new Date('2026-04-19T00:00:00.000Z'),
        updated_at: new Date('2026-04-19T00:05:00.000Z'),
      }),
      listTaskDecisions: async (taskId: string, filters?: Record<string, unknown>) => {
        calls.push({ taskId, ...filters });
        return [
          {
            id: 'decision-1',
            task_id: 'task-1',
            summary: 'Keep task memory canonical in DB',
            rationale: 'Resume should not reconstruct from raw notes',
            consequences: ['resume stays cheap'],
            validity_context: { branch: 'docs/mbrain-redesign-doc-set' },
            created_at: new Date('2026-04-19T00:06:00.000Z'),
          },
        ];
      },
    } as any,
    config: {} as any,
    logger: console,
    dryRun: false,
  }, {
    task_id: 'task-1',
    limit: 5,
  });

  expect(calls).toEqual([{ taskId: 'task-1', limit: 5 }]);
  const output = formatResult('list_task_decisions', result, { limit: 5 });
  expect(output).toContain('decision-1');
  expect(output).toContain('Keep task memory canonical in DB');
  expect(output).toContain('Resume should not reconstruct from raw notes');
});

test('start_task seeds an empty working set', async () => {
  const calls: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const start = operations.find((operation) => operation.name === 'start_task');
  if (!start) throw new Error('start_task operation is missing');

  const transactionEngine = {
    createTaskThread: async (payload: Record<string, unknown>) => {
      calls.push({ type: 'thread', payload });
      return {
        ...payload,
        goal: payload.goal ?? '',
        current_summary: payload.current_summary ?? '',
        created_at: new Date(),
        updated_at: new Date(),
      };
    },
    upsertTaskWorkingSet: async (payload: Record<string, unknown>) => {
      calls.push({ type: 'working_set', payload });
      return {
        ...payload,
        last_verified_at: null,
        updated_at: new Date(),
      };
    },
    getTaskThread: async (id: string) => ({
      id,
      scope: 'work',
      title: 'Phase 1 MVP',
      goal: 'Ship operational memory',
      status: 'active',
      repo_path: process.cwd(),
      branch_name: null,
      current_summary: '',
      created_at: new Date(),
      updated_at: new Date(),
    }),
  };

  const result = await start.handler({
    engine: {
      transaction: async (fn: (engine: typeof transactionEngine) => Promise<unknown>) => {
        calls.push({ type: 'transaction', payload: {} });
        return fn(transactionEngine);
      },
    } as any,
    config: {} as any,
    logger: console,
    dryRun: false,
  }, {
    title: 'Phase 1 MVP',
    goal: 'Ship operational memory',
    scope: 'work',
  });

  expect(calls[0]?.type).toBe('transaction');
  expect(calls[1]?.type).toBe('thread');
  expect(calls[2]?.type).toBe('working_set');
  expect(calls[2]?.payload).toMatchObject({
    active_paths: [],
    active_symbols: [],
    blockers: [],
    open_questions: [],
    next_steps: [],
    verification_notes: [],
  });
  expect((result as any).title).toBe('Phase 1 MVP');
});

test('formatResult renders a resume card', () => {
  const output = formatResult('resume_task', {
    task_id: 'task-1',
    title: 'Phase 1 MVP',
    status: 'blocked',
    goal: 'Ship operational memory',
    current_summary: 'Schema and engine layers are done',
    active_paths: ['src/core/operations.ts'],
    active_symbols: ['operations'],
    blockers: ['task commands missing'],
    open_questions: ['should resume emit trace ids'],
    next_steps: ['add shared operations'],
    failed_attempts: ['CLI-only task path'],
    active_decisions: ['keep working set canonical in DB'],
    latest_trace_route: ['task_thread', 'working_set', 'attempts', 'decisions'],
    code_claim_verification: [
      {
        claim: { path: 'src/core/operations.ts', symbol: 'operations', source_trace_id: 'trace-1' },
        status: 'stale',
        reason: 'symbol_missing',
        checked_at: '2026-04-25T00:00:00.000Z',
      },
    ],
    stale: true,
  });

  expect(output).toContain('Phase 1 MVP');
  expect(output).toContain('operations');
  expect(output).toContain('should resume emit trace ids');
  expect(output).toContain('CLI-only task path');
  expect(output).toContain('Code claims: stale:src/core/operations.ts:operations:symbol_missing:trace-1');
  expect(output).toContain('stale');
});

test('refresh_task_working_set updates freshness and preserves missing arrays', async () => {
  const refresh = operations.find((operation) => operation.name === 'refresh_task_working_set');
  if (!refresh) throw new Error('refresh_task_working_set operation is missing');

  let upsertPayload: Record<string, unknown> | undefined;
  const workingSet = await refresh.handler({
    engine: {
      getTaskThread: async () => ({
        id: 'task-1',
        scope: 'work',
        title: 'Phase 1 MVP',
        goal: 'Ship operational memory',
        status: 'active',
        repo_path: process.cwd(),
        branch_name: null,
        current_summary: 'Resume exists',
        created_at: new Date('2026-04-19T00:00:00.000Z'),
        updated_at: new Date('2026-04-19T00:00:00.000Z'),
      }),
      getTaskWorkingSet: async () => ({
        task_id: 'task-1',
        active_paths: ['src/core/operations.ts'],
        active_symbols: ['operations'],
        blockers: ['task commands missing'],
        open_questions: ['should resume emit trace ids'],
        next_steps: ['add shared operations'],
        verification_notes: ['schema verified'],
        last_verified_at: null,
        updated_at: new Date('2026-04-19T00:00:00.000Z'),
      }),
      upsertTaskWorkingSet: async (payload: Record<string, unknown>) => {
        upsertPayload = payload;
        return {
          ...payload,
          updated_at: new Date('2026-04-19T00:05:00.000Z'),
        };
      },
    } as any,
    config: {} as any,
    logger: console,
    dryRun: false,
  }, {
    task_id: 'task-1',
    verification_notes: ['resume verified against current branch'],
  });

  expect(upsertPayload).toMatchObject({
    task_id: 'task-1',
    active_paths: ['src/core/operations.ts'],
    active_symbols: ['operations'],
    blockers: ['task commands missing'],
    open_questions: ['should resume emit trace ids'],
    next_steps: ['add shared operations'],
    verification_notes: ['resume verified against current branch'],
  });
  expect(upsertPayload?.last_verified_at).toBeInstanceOf(Date);
  expect((workingSet as any).last_verified_at).toBeInstanceOf(Date);
});

test('task mutation operations reject unknown task ids with a stable error', async () => {
  const refresh = operations.find((operation) => operation.name === 'refresh_task_working_set');
  const attempt = operations.find((operation) => operation.name === 'record_attempt');
  const decision = operations.find((operation) => operation.name === 'record_decision');
  if (!refresh || !attempt || !decision) throw new Error('task mutation operations are missing');

  const ctx = {
    engine: {
      getTaskThread: async () => null,
    } as any,
    config: {} as any,
    logger: console,
    dryRun: false,
  };

  await expect(refresh.handler(ctx, { task_id: 'missing-task' })).rejects.toBeInstanceOf(OperationError);
  await expect(attempt.handler(ctx, {
    task_id: 'missing-task',
    summary: 'Tried an unknown task',
    outcome: 'failed',
  })).rejects.toMatchObject({ code: 'task_not_found' });
  await expect(decision.handler(ctx, {
    task_id: 'missing-task',
    summary: 'Decided on an unknown task',
    rationale: 'Should be rejected before persistence',
  })).rejects.toMatchObject({ code: 'task_not_found' });
});
