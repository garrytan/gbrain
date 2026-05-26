import { describe, expect, test } from 'bun:test';
import { SCHEMA_SQL } from '../src/core/schema-embedded.ts';
import { buildRunnerArtifactRecord, buildRunnerMessageRecord } from '../src/core/runners/runner-jobs.ts';
import { createRestrictedRunnerService } from '../src/core/services/restricted-runner-service.ts';
import type { SourceChunkRecord } from '../src/core/source-registry/raw-ingest.ts';

describe('restricted runner service', () => {
  test('detects local Claude Code availability without running shell payloads', async () => {
    const probeCalls: string[] = [];
    const service = createRestrictedRunnerService({
      probe: {
        commandExists: async (command) => {
          probeCalls.push(command);
          return command === 'claude';
        },
        env: {},
      },
      now: () => '2026-05-21T09:00:00.000Z',
    });

    const availability = await service.detectAvailability();

    expect(availability.selected).toMatchObject({
      kind: 'claude_code',
      command: 'claude',
      available: true,
      can_execute_shell: false,
      can_access_connector_credentials: false,
    });
    expect(probeCalls).toContain('claude');
    expect(probeCalls.every((command) => /^[a-z0-9_-]+$/i.test(command))).toBe(true);
  });

  test('detects local Codex availability without repository write access', async () => {
    const service = createRestrictedRunnerService({
      probe: {
        commandExists: async (command) => command === 'codex',
        env: {},
      },
      now: () => '2026-05-21T09:00:00.000Z',
    });

    const availability = await service.detectAvailability();

    expect(availability.selected).toMatchObject({
      kind: 'codex',
      command: 'codex',
      available: true,
      workspace_access: 'read_only',
      can_execute_shell: false,
    });
  });

  test('falls back through local model, remote provider, then deterministic report-only runner', async () => {
    const localModel = createRestrictedRunnerService({
      probe: {
        commandExists: async (command) => command === 'ollama',
        env: {},
      },
      now: () => '2026-05-21T09:00:00.000Z',
    });
    const remoteProvider = createRestrictedRunnerService({
      probe: {
        commandExists: async () => false,
        env: { OPENAI_API_KEY: 'sk-test' },
      },
      now: () => '2026-05-21T09:00:00.000Z',
    });
    const fallback = createRestrictedRunnerService({
      probe: {
        commandExists: async () => false,
        env: {},
      },
      now: () => '2026-05-21T09:00:00.000Z',
    });

    expect((await localModel.detectAvailability()).selected?.kind).toBe('local_model');
    expect((await remoteProvider.detectAvailability()).selected?.kind).toBe('remote_model');
    expect((await fallback.detectAvailability()).selected).toMatchObject({
      kind: 'deterministic_fallback',
      available: true,
      llm_or_runner_used: false,
    });
  });

  test('plans runner jobs with hashes, source scope, usage fields, and no execution authority', async () => {
    const service = createRestrictedRunnerService({
      probe: {
        commandExists: async (command) => command === 'codex',
        env: {},
      },
      now: () => '2026-05-21T09:00:00.000Z',
    });

    const plan = await service.planTask({
      task_type: 'source_summary',
      source_scope: {
        source_id: 'source:codex',
        source_item_ids: ['source-item:1'],
        chunk_ids: ['source-chunk:1'],
      },
      prompt: 'Summarize this scoped source.',
      input: 'Only source-chunk:1 may be read.',
    });

    expect(plan.job).toMatchObject({
      runner_kind: 'codex',
      runner_version: null,
      model: null,
      provider: null,
      task_type: 'source_summary',
      status: 'queued',
      failure_class: null,
      output_hash: null,
      source_scope_json: {
        source_id: 'source:codex',
        source_item_ids: ['source-item:1'],
        chunk_ids: ['source-chunk:1'],
      },
      token_usage_json: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
      },
      cost_estimate_usd: null,
      can_execute_shell: false,
      can_access_connector_credentials: false,
    });
    expect(plan.job.id).toMatch(/^runner-job:/);
    expect(plan.job.prompt_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.job.input_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test('executes scoped runner tasks through an injected executor without shell or credential authority', async () => {
    const executorCalls: unknown[] = [];
    const recordedLedgerEntries: unknown[] = [];
    const service = createRestrictedRunnerService({
      probe: {
        commandExists: async (command) => command === 'codex',
        env: {},
      },
      recordRawAccessLedgerEntries: async (entries) => {
        recordedLedgerEntries.push(...entries);
      },
      executor: async (request) => {
        executorCalls.push(request);
        expect(request.runner.kind).toBe('codex');
        expect(request.prompt).not.toContain('sk-secretvalue123456789');
        expect(request.prompt).toContain('scoped, redacted source chunks');
        expect(request.tool_policy.canonical_mutation_allowed).toBe(false);
        expect(request.tool_policy.connector_credentials_available).toBe(false);
        expect(request.runner.can_execute_shell).toBe(false);
        expect(request.runner.can_access_connector_credentials).toBe(false);
        expect(request.input).toContain('[REDACTED:openai_api_key]');
        expect(request.input).not.toContain('sk-secretvalue123456789');
        return {
          status: 'succeeded',
          output: 'Draft source summary proposal.',
          token_usage_json: {
            input_tokens: 12,
            output_tokens: 5,
            total_tokens: 17,
          },
          cost_estimate_usd: 0.001,
        };
      },
      now: () => '2026-05-21T09:00:00.000Z',
    });
    const chunk = sourceChunk({
      chunk_text: 'source secret sk-secretvalue123456789',
      redacted_text: 'source secret [REDACTED:openai_api_key]',
      secret_risk: 'redacted',
    });

    const executed = await service.executeTask({
      task_type: 'source_summary',
      source_scope: {
        source_id: 'source:codex',
        chunk_ids: ['source-chunk:1'],
      },
      prompt: 'Summarize only the scoped source sk-secretvalue123456789.',
      input: 'caller-provided text is not forwarded for raw source tasks sk-secretvalue123456789',
      raw_access: {
        source_id: 'source:codex',
        source_policy: {
          consent_state: 'granted',
          enabled: true,
          runner_access: 'local_redacted',
        },
        chunks: [chunk],
      },
    });

    expect(executorCalls).toHaveLength(1);
    expect(recordedLedgerEntries).toHaveLength(1);
    expect(executed.job).toMatchObject({
      runner_kind: 'codex',
      task_type: 'source_summary',
      status: 'succeeded',
      failure_class: null,
      token_usage_json: {
        input_tokens: 12,
        output_tokens: 5,
        total_tokens: 17,
      },
      cost_estimate_usd: 0.001,
      can_execute_shell: false,
      can_access_connector_credentials: false,
    });
    expect(executed.job.output_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(executed.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(executed.messages.every((message) => message.redacted_preview.startsWith('sha256:'))).toBe(true);
    expect(executed.tool_calls).toHaveLength(1);
    expect(executed.tool_calls[0]).toMatchObject({
      tool_name: 'read_scoped_source_excerpt',
      status: 'allowed',
      policy_reason: 'scoped_access_allowed',
    });
    expect(executed.raw_access_ledger_entries).toHaveLength(1);
    expect(executed.raw_access_ledger_entries[0]).toMatchObject({
      actor_type: 'runner',
      source_id: 'source:codex',
      source_item_id: 'source-item:1',
      chunk_ids: ['source-chunk:1'],
      policy_decision: 'allow',
      policy_reason: 'scoped_access_allowed',
    });
  });

  test('fails closed before runner execution when scoped raw access cannot be recorded', async () => {
    let executorCalls = 0;
    const service = createRestrictedRunnerService({
      probe: {
        commandExists: async (command) => command === 'codex',
        env: {},
      },
      executor: async () => {
        executorCalls += 1;
        return { status: 'succeeded', output: 'should not run' };
      },
      now: () => '2026-05-21T09:00:00.000Z',
    });

    const executed = await service.executeTask({
      task_type: 'source_summary',
      source_scope: {
        source_id: 'source:codex',
        chunk_ids: ['source-chunk:1'],
      },
      prompt: 'Summarize only the scoped source.',
      raw_access: {
        source_id: 'source:codex',
        source_policy: {
          consent_state: 'granted',
          enabled: true,
          runner_access: 'local_redacted',
        },
        chunks: [sourceChunk()],
      },
    });

    expect(executorCalls).toBe(0);
    expect(executed.job).toMatchObject({
      runner_kind: 'codex',
      status: 'failed',
      failure_class: 'database',
    });
    expect(executed.raw_access_ledger_entries).toHaveLength(1);
    expect(executed.tool_calls).toHaveLength(1);
  });

  test('requires scoped raw access before source excerpt tasks reach an executor', async () => {
    let executorCalls = 0;
    const service = createRestrictedRunnerService({
      probe: {
        commandExists: async (command) => command === 'codex',
        env: {},
      },
      executor: async () => {
        executorCalls += 1;
        return { status: 'succeeded', output: 'should not run' };
      },
      now: () => '2026-05-21T09:00:00.000Z',
    });

    const executed = await service.executeTask({
      task_type: 'source_summary',
      source_scope: {
        source_id: 'source:codex',
        chunk_ids: ['source-chunk:1'],
      },
      prompt: 'Summarize only the scoped source.',
      input: 'raw source text should not be forwarded without raw_access',
    });

    expect(executorCalls).toBe(0);
    expect(executed.job).toMatchObject({
      runner_kind: 'codex',
      status: 'failed',
      failure_class: 'source_unavailable',
    });
    expect(executed.job.output_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(executed.raw_access_ledger_entries).toEqual([]);
    expect(executed.tool_calls).toEqual([]);
  });

  test('does not forward caller input text to executors for non-raw tasks', async () => {
    const executorRequests: unknown[] = [];
    const service = createRestrictedRunnerService({
      probe: {
        commandExists: async (command) => command === 'codex',
        env: {},
      },
      executor: async (request) => {
        executorRequests.push(request);
        expect(request.prompt).not.toContain('sk-secretvalue123456789');
        expect(request.input).not.toContain('sk-secretvalue123456789');
        expect(request.input).toContain('task_type: daily_report');
        expect(request.input).not.toContain('source:daily sk-secretvalue123456789');
        expect(request.input).toContain('"source_item_ids":["source-item:1"]');
        expect(request.input).not.toContain('source-item:sk-secretvalue123456789');
        expect(request.input).toMatch(/caller_input_hash: sha256:[a-f0-9]{64}/);
        expect(request.source_scope).toEqual({
          source_item_ids: ['source-item:1'],
          chunk_ids: ['source-chunk:1'],
        });
        return { status: 'succeeded', output: 'Draft report section.' };
      },
      now: () => '2026-05-21T09:00:00.000Z',
    });

    const executed = await service.executeTask({
      task_type: 'daily_report',
      source_scope: {
        source_id: 'source:daily sk-secretvalue123456789',
        source_item_ids: ['source-item:1', 'source-item:sk-secretvalue123456789'],
        chunk_ids: ['source-chunk:1'],
      },
      prompt: 'Draft report section sk-secretvalue123456789.',
      input: 'operator pasted a secret sk-secretvalue123456789 by mistake',
    });

    expect(executorRequests).toHaveLength(1);
    expect(executed.job).toMatchObject({
      runner_kind: 'codex',
      task_type: 'daily_report',
      status: 'succeeded',
      failure_class: null,
      source_scope_json: {
        source_item_ids: ['source-item:1'],
        chunk_ids: ['source-chunk:1'],
      },
    });
    expect(executed.job.output_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(executed.messages)).not.toContain('sk-secretvalue123456789');
    expect(JSON.stringify(executed.job.source_scope_json)).not.toContain('sk-secretvalue123456789');
  });

  test('does not run injected executors for deterministic report-only fallback', async () => {
    let executorCalls = 0;
    const service = createRestrictedRunnerService({
      probe: {
        commandExists: async () => false,
        env: {},
      },
      executor: async () => {
        executorCalls += 1;
        return { status: 'succeeded', output: 'should not run' };
      },
      now: () => '2026-05-21T09:00:00.000Z',
    });

    const executed = await service.executeTask({
      task_type: 'daily_report',
      prompt: 'Draft report section.',
      input: 'job ids only',
    });

    expect(executorCalls).toBe(0);
    expect(executed.job).toMatchObject({
      runner_kind: 'deterministic_fallback',
      status: 'degraded',
      failure_class: 'runner_unavailable',
    });
    expect(executed.job.output_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test('runner job source scope persists only scoped ids, not raw excerpts or credentials', async () => {
    const service = createRestrictedRunnerService({
      probe: {
        commandExists: async (command) => command === 'codex',
        env: {},
      },
      now: () => '2026-05-21T09:00:00.000Z',
    });

    const plan = await service.planTask({
      task_type: 'assertion_extraction',
      source_scope: {
        source_id: 'source:codex',
        source_item_ids: ['source-item:1', 42],
        chunk_ids: ['source-chunk:1', null],
        raw_excerpt: 'secret text sk-secretvalue123456789',
        connector_metadata: { token: 'xoxb-secretvalue123456789' },
      } as any,
      prompt: 'Extract claims.',
      input: 'Use only ids.',
    });

    expect(plan.job.source_scope_json).toEqual({
      source_id: 'source:codex',
      source_item_ids: ['source-item:1'],
      chunk_ids: ['source-chunk:1'],
    });
    expect(JSON.stringify(plan.job.source_scope_json)).not.toContain('sk-secretvalue123456789');
    expect(JSON.stringify(plan.job.source_scope_json)).not.toContain('xoxb-secretvalue123456789');
  });

  test('runner job source scope drops unsafe string identifiers before persistence', async () => {
    const service = createRestrictedRunnerService({
      probe: {
        commandExists: async (command) => command === 'codex',
        env: {},
      },
      now: () => '2026-05-21T09:00:00.000Z',
    });

    const plan = await service.planTask({
      task_type: 'daily_report',
      source_scope: {
        source_id: 'source:daily sk-secretvalue123456789',
        source_item_ids: ['source-item:1', 'source-item:sk-secretvalue123456789'],
        chunk_ids: ['source-chunk:1', 'source-chunk:sk-secretvalue123456789'],
      },
      prompt: 'Draft report.',
      input: 'Use safe ids only.',
    });

    expect(plan.job.source_scope_json).toEqual({
      source_item_ids: ['source-item:1'],
      chunk_ids: ['source-chunk:1'],
    });
    expect(JSON.stringify(plan.job.source_scope_json)).not.toContain('sk-secretvalue123456789');
  });

  test('schema declares durable runner job, message, tool-call, and artifact records', () => {
    expect(SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS runner_jobs');
    expect(SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS runner_tool_calls');
    expect(SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS runner_messages');
    expect(SCHEMA_SQL).toContain('CREATE TABLE IF NOT EXISTS runner_artifacts');
    expect(SCHEMA_SQL).toContain('runner_kind');
    expect(SCHEMA_SQL).toContain('prompt_hash');
    expect(SCHEMA_SQL).toContain('input_hash');
    expect(SCHEMA_SQL).toContain('output_hash');
    expect(SCHEMA_SQL).toContain('cost_estimate_usd');
    expect(SCHEMA_SQL).toContain('memory_job_id                    TEXT REFERENCES memory_jobs(id) ON DELETE RESTRICT');
    expect(SCHEMA_SQL).toContain('policy_id            TEXT REFERENCES forgetting_policies(id) ON DELETE RESTRICT');
    expect(SCHEMA_SQL).toContain('purge_event_id TEXT REFERENCES forgetting_events(id) ON DELETE RESTRICT');
    expect(SCHEMA_SQL).toContain('purge_plan_id  TEXT REFERENCES purge_plans(id) ON DELETE RESTRICT');
  });

  test('runner message records store hashes and redacted previews instead of raw secrets', () => {
    const record = buildRunnerMessageRecord({
      runner_job_id: 'runner-job:1',
      role: 'assistant',
      content: [
        'Observed OpenAI token sk-secretvalue123456789 in the source text.',
        'AWS key AKIAIOSFODNN7EXAMPLE was nearby.',
        'Database URL postgres://user:supersecret@example.com/db was nearby.',
        'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig',
      ].join(' '),
      now: '2026-05-21T09:00:00.000Z',
    });

    expect(record.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(record.redacted_preview).toMatch(/^sha256:[a-f0-9]{16}$/);
    expect(record.redacted_preview).not.toContain('sk-secretvalue123456789');
    expect(record.redacted_preview).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(record.redacted_preview).not.toContain('postgres://');
    expect(record.redacted_preview).not.toContain('Bearer');
  });

  test('runner artifact records persist only safe internal refs and bounded metadata', () => {
    const record = buildRunnerArtifactRecord({
      runner_job_id: 'runner-job:1',
      artifact_kind: 'source_summary',
      artifact_ref: 'https://storage.example.com/private/raw.txt?token=xoxb-secretvalue123456789',
      content: 'summary body',
      metadata_json: {
        source_id: 'source:manual',
        token_count: 42,
        format: 'markdown',
        raw_excerpt: 'secret raw text sk-secretvalue123456789',
        signed_url: 'https://storage.example.com/private/raw.txt?token=xoxb-secretvalue123456789',
        nested: { token: 'xoxb-secretvalue123456789' },
      },
      now: '2026-05-21T09:00:00.000Z',
    });

    expect(record.artifact_ref).toMatch(/^artifact-ref:[a-f0-9]{24}$/);
    expect(record.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(record.metadata_json).toEqual({
      source_id: 'source:manual',
      token_count: 42,
      format: 'markdown',
    });
    expect(JSON.stringify(record)).not.toContain('sk-secretvalue123456789');
    expect(JSON.stringify(record)).not.toContain('xoxb-secretvalue123456789');
    expect(JSON.stringify(record)).not.toContain('storage.example.com/private');
  });

  test('runner artifact refs with safe prefixes still redact secret-like payloads', () => {
    const record = buildRunnerArtifactRecord({
      runner_job_id: 'runner-job:1',
      artifact_kind: 'source_summary',
      artifact_ref: 'artifact-ref:sk-secretvalue123456789',
      content: 'summary body',
      now: '2026-05-21T09:00:00.000Z',
    });

    expect(record.artifact_ref).toMatch(/^artifact-ref:[a-f0-9]{24}$/);
    expect(record.artifact_ref).not.toContain('sk-secretvalue123456789');
    expect(JSON.stringify(record)).not.toContain('sk-secretvalue123456789');
  });

  test('runner artifact refs must use explicit internal schemes', () => {
    const record = buildRunnerArtifactRecord({
      runner_job_id: 'runner-job:1',
      artifact_kind: 'source_summary',
      artifact_ref: 'storage.example.com:private.raw.txt',
      content: 'summary body',
      now: '2026-05-21T09:00:00.000Z',
    });

    expect(record.artifact_ref).toMatch(/^artifact-ref:[a-f0-9]{24}$/);
    expect(record.artifact_ref).not.toContain('storage.example.com');
    expect(JSON.stringify(record)).not.toContain('storage.example.com');
  });

  test('runner artifact sanitizer preserves benign ids while rejecting secret-like artifact fields', () => {
    const record = buildRunnerArtifactRecord({
      runner_job_id: 'runner-job:1',
      artifact_kind: 'source_summary:sk-secretvalue123456789',
      artifact_ref: 'source-summary:postgres-runtime-spec',
      content: 'summary body',
      metadata_json: {
        source_id: 'source:postgres-runtime-spec',
        source_item_id: 'source-item:http-import',
        chunk_ids: [
          'source-chunk:postgres-runtime-spec',
          'source-chunk:sk-secretvalue123456789',
        ],
        policy_reason: 'remote_runner_access_denied',
      },
      now: '2026-05-21T09:00:00.000Z',
    });

    expect(record.artifact_kind).toMatch(/^artifact-kind:[a-f0-9]{24}$/);
    expect(record.artifact_ref).toBe('source-summary:postgres-runtime-spec');
    expect(record.metadata_json).toEqual({
      source_id: 'source:postgres-runtime-spec',
      source_item_id: 'source-item:http-import',
      chunk_ids: ['source-chunk:postgres-runtime-spec'],
      policy_reason: 'remote_runner_access_denied',
    });
    expect(JSON.stringify(record)).not.toContain('sk-secretvalue123456789');
  });
});

function sourceChunk(overrides: Partial<SourceChunkRecord> = {}): SourceChunkRecord {
  return {
    id: 'source-chunk:1',
    source_item_id: 'source-item:1',
    chunk_index: 0,
    chunk_hash: 'chunk-hash',
    chunk_text: 'source text',
    redacted_text: 'source text',
    token_count: 3,
    parser_version: 'test-parser',
    extractor_version: 'test-extractor',
    sensitivity_flags: [],
    prompt_injection_risk: 'none',
    secret_risk: 'none',
    created_at: '2026-05-21T09:00:00.000Z',
    expires_at: null,
    ...overrides,
  };
}
