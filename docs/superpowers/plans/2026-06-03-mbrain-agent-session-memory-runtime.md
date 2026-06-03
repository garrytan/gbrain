# Agent Session Memory Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a mbrain-native agent session memory runtime that captures Codex/Claude/agent sessions as redacted source-backed inputs, compresses and summarizes them without mandatory LLM calls, classifies durable memory signals, and routes them through existing governed memory surfaces.

**Architecture:** Add focused domain types and pure services first, then wrap them in contract-first operations. Source registry/raw ingest remains the provenance layer, Memory Inbox remains the default authority boundary for inferred or compressed signals, and direct profile/episode writes are allowed only for explicit user/session signals that pass personal write-target preflight.

**Tech Stack:** Bun tests, TypeScript services under `src/core/services`, existing source registry raw ingest, existing Memory Writeback Router, SQLite engine integration tests, contract-first operations in `src/core/operations.ts`.

---

## File Structure

- Create `src/core/types/agent-session-memory.ts`
  - Agent session event, compressed observation, summary, signal, route result, and capture result types.
- Modify `src/core/types.ts`
  - Re-export the new type module.
- Create `src/core/source-registry/raw-ingest-store.ts`
  - Shared SQL-backed persistence helper for `RawIngestPlan`.
  - This removes the need for each agent/session ingestion path to duplicate source item/chunk insert SQL.
- Modify `src/core/operations-source-registry.ts`
  - Import `persistRawIngestPlan`, `readSourceItemByExternalId`, and `readSourceItemChunks` from the new helper.
  - Keep connector ingest behavior identical.
- Create `src/core/services/agent-session-memory-service.ts`
  - Normalize events, build raw ingest plans, derive source refs, redact before compression, and persist capture records when requested.
- Create `src/core/services/agent-session-compression-service.ts`
  - Deterministic zero-LLM compression and bounded session summary.
- Create `src/core/services/agent-session-classifier-service.ts`
  - Deterministic profile/episode/procedure/task/open-question/no-write classification.
- Create `src/core/services/agent-session-writeback-service.ts`
  - Convert signals to `route_memory_writeback` input, create candidates when requested, and direct-write explicit profile/episode signals after preflight.
- Create `src/core/services/agent-session-activation-service.ts`
  - Convert route results into existing activation artifacts with authority labels.
- Create `src/core/operations-agent-session-memory.ts`
  - Register preview and capture operations.
- Modify `src/core/operations.ts`
  - Import and register agent session memory operations.
- Create tests:
  - `test/agent-session-memory-service.test.ts`
  - `test/agent-session-compression-service.test.ts`
  - `test/agent-session-classifier-service.test.ts`
  - `test/agent-session-writeback-service.test.ts`
  - `test/agent-session-memory-operations.test.ts`
  - `test/agent-session-memory-sqlite.test.ts`
- Modify docs:
  - `AGENTS.md`
  - `docs/MBRAIN_AGENT_RULES.md`
  - `docs/MCP_INSTRUCTIONS.md`

## Scope Boundaries

- Do not add a new vector index, BM25 implementation, graph implementation, slot store, background daemon, UI, or connector family.
- Do not use LLM calls in the default implementation or tests.
- Do not make compressed observations canonical truth.
- Do not make recurrence bypass provenance, scope gate, redaction, duplicate review, or contradiction review.
- Do not change existing profile memory, personal episode, Memory Inbox, or source registry schemas.
- Direct profile/episode writes are only for explicit, source-backed user/session signals and only when `write_mode` is `direct_personal_when_allowed`.

## Task 1: Add Agent Session Memory Types

**Files:**
- Create: `src/core/types/agent-session-memory.ts`
- Modify: `src/core/types.ts`
- Test: `test/agent-session-memory-service.test.ts`

- [ ] **Step 1: Write the failing type smoke test**

```ts
import { expect, test } from 'bun:test';
import type {
  AgentSessionCompressedObservation,
  AgentSessionEventInput,
  AgentSessionMemorySignal,
} from '../src/core/types.ts';

test('agent session memory types are exported through the core type barrel', () => {
  const event: AgentSessionEventInput = {
    source_kind: 'codex_session',
    session_id: 'session-1',
    event_kind: 'user_prompt',
    actor: 'user',
    text: '기억해 주세요. 저는 구현 전에 짧은 플랜을 선호합니다.',
  };
  const observation: AgentSessionCompressedObservation = {
    id: 'agent-session-observation:1',
    source_item_id: 'source-item:1',
    source_chunk_ids: ['source-chunk:1'],
    session_id: 'session-1',
    event_ids: ['event-1'],
    observed_at: '2026-06-03T01:00:00.000Z',
    observation_type: 'conversation',
    title: 'User stated planning preference',
    narrative: 'The user asked mbrain to remember a planning preference.',
    facts: ['The user prefers a short plan before implementation.'],
    concepts: ['planning preference'],
    files: [],
    importance_score: 0.8,
    confidence_score: 0.85,
    sensitivity: 'personal',
    scope_id: 'personal:default',
    source_refs: ['source_item:source-item:1', 'source_chunk:source-chunk:1'],
    generated_by: 'agent_session_capture',
  };
  const signal: AgentSessionMemorySignal = {
    id: 'agent-session-signal:1',
    source_observation_id: observation.id,
    content: 'The user prefers a short plan before implementation.',
    evidence_kind: 'direct_user_statement',
    signal_kind: 'profile_memory',
    candidate_type: 'profile_update',
    target_object_type: 'profile_memory',
    target_object_id: null,
    scope_id: 'personal:default',
    sensitivity: 'personal',
    confidence_score: 0.85,
    importance_score: 0.8,
    recurrence_score: 0,
    source_refs: observation.source_refs,
    profile_type: 'preference',
    profile_subject: 'implementation planning',
  };

  expect(event.source_kind).toBe('codex_session');
  expect(observation.generated_by).toBe('agent_session_capture');
  expect(signal.signal_kind).toBe('profile_memory');
});
```

- [ ] **Step 2: Run the failing test**

Run: `bun test test/agent-session-memory-service.test.ts`

Expected: FAIL with a missing export error for `AgentSessionEventInput`.

- [ ] **Step 3: Add the new type module**

```ts
import type {
  MemoryCandidateSensitivity,
  MemoryCandidateTargetObjectType,
  MemoryCandidateType,
} from './memory-governance.ts';
import type {
  MemoryScenarioSourceKind,
  MemoryWritebackEvidenceKind,
  RouteMemoryWritebackResult,
} from './retrieval-routing.ts';
import type { PersonalEpisodeSourceKind, ProfileMemoryType } from './profile-episode.ts';

export const AGENT_SESSION_SOURCE_KINDS = [
  'codex_session',
  'claude_session',
  'agent_session',
] as const;

export type AgentSessionSourceKind = typeof AGENT_SESSION_SOURCE_KINDS[number];

export const AGENT_SESSION_EVENT_KINDS = [
  'session_start',
  'user_prompt',
  'assistant_response',
  'tool_call',
  'tool_result',
  'tool_failure',
  'file_read',
  'file_write',
  'file_edit',
  'command_run',
  'search',
  'subagent_result',
  'session_stop',
  'explicit_memory_note',
] as const;

export type AgentSessionEventKind = typeof AGENT_SESSION_EVENT_KINDS[number];

export type AgentSessionActor = 'user' | 'assistant' | 'tool' | 'subagent' | 'system';

export type AgentSessionObservationType =
  | 'conversation'
  | 'tool_use'
  | 'tool_failure'
  | 'file_read'
  | 'file_write'
  | 'file_edit'
  | 'command_run'
  | 'search'
  | 'subagent'
  | 'session_summary'
  | 'other';

export type AgentSessionSignalKind =
  | 'profile_memory'
  | 'personal_episode'
  | 'procedure'
  | 'task_memory'
  | 'project_note'
  | 'open_question'
  | 'no_write';

export type AgentSessionGeneratedBy = 'agent_session_capture';

export type AgentSessionWriteMode =
  | 'candidate_only'
  | 'direct_personal_when_allowed';

export interface AgentSessionEventInput {
  source_kind?: AgentSessionSourceKind;
  session_id?: string;
  event_kind: AgentSessionEventKind;
  text: string;
  event_id?: string;
  actor?: AgentSessionActor;
  client_name?: string;
  repo_path?: string | null;
  workspace_id?: string | null;
  occurred_at?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentSessionNormalizedEvent extends Required<Pick<
  AgentSessionEventInput,
  'source_kind' | 'session_id' | 'event_kind' | 'text'
>> {
  event_id: string;
  actor: AgentSessionActor;
  client_name: string;
  repo_path: string | null;
  workspace_id: string | null;
  occurred_at: string;
  metadata: Record<string, unknown>;
}

export interface AgentSessionCompressedObservation {
  id: string;
  source_item_id: string;
  source_chunk_ids: string[];
  session_id: string;
  event_ids: string[];
  observed_at: string;
  observation_type: AgentSessionObservationType;
  title: string;
  narrative: string;
  facts: string[];
  concepts: string[];
  files: string[];
  importance_score: number;
  confidence_score: number;
  sensitivity: MemoryCandidateSensitivity;
  scope_id: string;
  source_refs: string[];
  generated_by: AgentSessionGeneratedBy;
}

export interface AgentSessionSummary {
  id: string;
  session_id: string;
  source_item_ids: string[];
  source_chunk_ids: string[];
  started_at: string | null;
  ended_at: string | null;
  title: string;
  outcome: string;
  user_goals: string[];
  decisions: string[];
  preferences: string[];
  files_touched: string[];
  errors_and_fixes: string[];
  unresolved_questions: string[];
  follow_ups: string[];
  candidate_memory_signals: string[];
  source_refs: string[];
  sensitivity: MemoryCandidateSensitivity;
  generated_by: AgentSessionGeneratedBy;
}

export interface AgentSessionMemorySignal {
  id: string;
  source_observation_id: string;
  content: string;
  evidence_kind: MemoryWritebackEvidenceKind;
  signal_kind: AgentSessionSignalKind;
  candidate_type: MemoryCandidateType | null;
  target_object_type: MemoryCandidateTargetObjectType | null;
  target_object_id: string | null;
  scope_id: string;
  sensitivity: MemoryCandidateSensitivity;
  confidence_score: number;
  importance_score: number;
  recurrence_score: number;
  source_refs: string[];
  profile_type?: ProfileMemoryType;
  profile_subject?: string;
  personal_episode_title?: string;
  personal_episode_source_kind?: PersonalEpisodeSourceKind;
  scenario_source_kind?: MemoryScenarioSourceKind;
}

export interface AgentSessionMemoryRouteResult {
  signal: AgentSessionMemorySignal;
  route: RouteMemoryWritebackResult | null;
  direct_write:
    | { kind: 'profile_memory'; id: string; status: 'written' | 'dry_run' }
    | { kind: 'personal_episode'; id: string; status: 'written' | 'dry_run' }
    | null;
  blocked_reason: string | null;
}
```

- [ ] **Step 4: Export the type module**

Add this line to `src/core/types.ts`:

```ts
export * from './types/agent-session-memory.ts';
```

- [ ] **Step 5: Run the test**

Run: `bun test test/agent-session-memory-service.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/types/agent-session-memory.ts test/agent-session-memory-service.test.ts
git commit -m "feat: add agent session memory types"
```

## Task 2: Extract Raw Ingest Persistence For Session Sources

**Files:**
- Create: `src/core/source-registry/raw-ingest-store.ts`
- Modify: `src/core/operations-source-registry.ts`
- Test: `test/source-registry-operations.test.ts`

- [ ] **Step 1: Add a regression test for connector ingest behavior**

Append this test to `test/source-registry-operations.test.ts` inside the existing `describe('source registry operations', () => { ... })` block:

```ts
test('connector item ingest still persists redacted chunks after raw ingest store extraction', async () => {
  const harness = await createSqliteHarness('raw-store-extraction');
  try {
    const registered = await getOperation('register_source').handler(harness.ctx(), {
      source_kind: 'codex_session',
      display_name: 'Codex Sessions',
      locator: 'codex://sessions',
      consent_state: 'granted',
      now: '2026-06-03T01:00:00.000Z',
    }) as any;

    const preview = await getOperation('preview_raw_ingest').handler(harness.ctx(), {
      source_id: registered.source.id,
      external_id: 'session-1/event-1',
      origin_event: 'session_capture',
      title: 'Agent session event',
      chunk_texts: ['The user pasted sk-testsecret1234567890 and asked to remember a preference.'],
      parser_version: 'agent-session:v1',
      policy: {
        consent_state: 'granted',
        enabled: true,
        raw_copy_mode: 'metadata_chunks',
        automatic_canonical_write_authority: 'candidate',
      },
      now: '2026-06-03T01:01:00.000Z',
    }) as any;

    expect(preview.chunks[0].redacted_text).toContain('[REDACTED:openai_api_key]');
    expect(preview.secret_detections).toHaveLength(1);
  } finally {
    await harness.cleanup();
  }
});
```

- [ ] **Step 2: Run the regression test**

Run: `bun test test/source-registry-operations.test.ts`

Expected: PASS before the helper extraction. This locks behavior before moving code.

- [ ] **Step 3: Create the shared raw ingest store helper**

Move these private functions from `src/core/operations-source-registry.ts` into `src/core/source-registry/raw-ingest-store.ts` and export them:

```ts
export async function persistRawIngestPlan(engine: BrainEngine, plan: RawIngestPlan): Promise<void>
export async function readSourceItemByExternalId(engine: BrainEngine, sourceId: string, externalId: string): Promise<SourceItemRecord | null>
export async function readSourceItemChunks(engine: BrainEngine, sourceItemId: string): Promise<SourceChunkRecord[]>
```

The new file must import the existing raw ingest types:

```ts
import type { BrainEngine } from '../engine.ts';
import type {
  PromptInjectionFlagRecord,
  RawIngestPlan,
  SecretDetectionRecord,
  SourceChunkRecord,
  SourceItemEventRecord,
  SourceItemRecord,
} from './raw-ingest.ts';
```

The helper keeps the current SQL behavior:

```ts
export async function persistRawIngestPlan(engine: BrainEngine, plan: RawIngestPlan): Promise<void> {
  await insertSourceItem(engine, plan.item);
  await deleteRawIngestChildRecords(engine, plan.item.id);
  for (const chunk of plan.chunks) await insertSourceChunk(engine, chunk);
  for (const event of plan.events) await insertSourceItemEvent(engine, event);
  for (const detection of plan.secret_detections) await insertSecretDetection(engine, detection);
  for (const flag of plan.prompt_injection_flags) await insertPromptInjectionFlag(engine, flag);
}
```

- [ ] **Step 4: Import the helper in `operations-source-registry.ts`**

Add:

```ts
import {
  persistRawIngestPlan,
  readSourceItemByExternalId,
} from './source-registry/raw-ingest-store.ts';
```

Delete the now-duplicated private definitions from `operations-source-registry.ts`:

```ts
persistRawIngestPlan
insertSourceItem
deleteRawIngestChildRecords
insertSourceChunk
insertSourceItemEvent
insertSecretDetection
insertPromptInjectionFlag
readSourceItemByExternalId
mapSourceItem
mapSourceChunk
parseJsonArray
```

Keep `readFullSourceRecord` and other source registration helpers in `operations-source-registry.ts`.

- [ ] **Step 5: Run source registry tests**

Run: `bun test test/source-registry-operations.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/source-registry/raw-ingest-store.ts src/core/operations-source-registry.ts test/source-registry-operations.test.ts
git commit -m "refactor: share raw ingest persistence"
```

## Task 3: Build Session Capture And Safety Service

**Files:**
- Create: `src/core/services/agent-session-memory-service.ts`
- Test: `test/agent-session-memory-service.test.ts`

- [ ] **Step 1: Add failing capture tests**

Append these tests to `test/agent-session-memory-service.test.ts`:

```ts
import {
  buildAgentSessionCapturePlan,
  normalizeAgentSessionEvent,
} from '../src/core/services/agent-session-memory-service.ts';

test('normalizes session events with stable ids and actor defaults', () => {
  const event = normalizeAgentSessionEvent({
    source_kind: 'codex_session',
    session_id: 'session-1',
    event_kind: 'tool_result',
    text: 'Ran bun test test/agent-session-memory-service.test.ts',
  }, '2026-06-03T01:00:00.000Z');

  expect(event.event_id).toMatch(/^agent-session-event:/);
  expect(event.actor).toBe('tool');
  expect(event.client_name).toBe('codex');
  expect(event.occurred_at).toBe('2026-06-03T01:00:00.000Z');
});

test('builds redacted raw ingest plan before compression', () => {
  const plan = buildAgentSessionCapturePlan({
    source_kind: 'codex_session',
    session_id: 'session-1',
    client_name: 'codex',
    source_id: 'source:codex-session',
    events: [{
      source_kind: 'codex_session',
      session_id: 'session-1',
      event_kind: 'user_prompt',
      actor: 'user',
      text: '기억해 주세요. sk-testsecret1234567890 값은 비밀입니다.',
      occurred_at: '2026-06-03T01:00:00.000Z',
    }],
    now: '2026-06-03T01:01:00.000Z',
  });

  expect(plan.ingest_plan.item.origin_event).toBe('session_capture');
  expect(plan.ingest_plan.chunks[0].redacted_text).toContain('[REDACTED:openai_api_key]');
  expect(plan.safety.secret_risk).toBe('flagged');
  expect(plan.source_refs).toEqual(expect.arrayContaining([
    `source_item:${plan.ingest_plan.item.id}`,
    `source_chunk:${plan.ingest_plan.chunks[0].id}`,
  ]));
});
```

- [ ] **Step 2: Run the failing tests**

Run: `bun test test/agent-session-memory-service.test.ts`

Expected: FAIL with missing service exports.

- [ ] **Step 3: Implement normalization and capture planning**

```ts
import { createHash } from 'crypto';
import { buildRawIngestPlan, type RawIngestPlan, type SecretRisk } from '../source-registry/raw-ingest.ts';
import { getDefaultSourcePolicy } from '../source-registry/source-policy.ts';
import type {
  AgentSessionEventInput,
  AgentSessionNormalizedEvent,
  AgentSessionSourceKind,
} from '../types.ts';

export interface AgentSessionCapturePlanInput {
  source_kind: AgentSessionSourceKind;
  session_id: string;
  client_name?: string;
  source_id?: string;
  repo_path?: string | null;
  workspace_id?: string | null;
  events: AgentSessionEventInput[];
  now?: string;
}

export interface AgentSessionCapturePlan {
  source_id: string;
  events: AgentSessionNormalizedEvent[];
  ingest_plan: RawIngestPlan;
  source_refs: string[];
  safety: {
    secret_risk: SecretRisk;
    prompt_injection_flagged: boolean;
    redacted: boolean;
  };
}

export function normalizeAgentSessionEvent(
  input: AgentSessionEventInput,
  now = new Date().toISOString(),
): AgentSessionNormalizedEvent {
  const occurredAt = input.occurred_at ?? now;
  const clientName = input.client_name ?? defaultClientName(input.source_kind);
  const actor = input.actor ?? defaultActor(input.event_kind);
  const eventId = input.event_id ?? stableId(
    'agent-session-event',
    input.source_kind ?? '',
    input.session_id ?? '',
    input.event_kind,
    occurredAt,
    input.text,
  );

  return {
    source_kind: input.source_kind ?? 'agent_session',
    session_id: requireNonEmpty('session_id', input.session_id ?? ''),
    event_kind: input.event_kind,
    text: input.text,
    event_id: eventId,
    actor,
    client_name: clientName,
    repo_path: input.repo_path ?? null,
    workspace_id: input.workspace_id ?? null,
    occurred_at: occurredAt,
    metadata: input.metadata ?? {},
  };
}

export function buildAgentSessionCapturePlan(input: AgentSessionCapturePlanInput): AgentSessionCapturePlan {
  const now = input.now ?? new Date().toISOString();
  const events = input.events.map((event) => normalizeAgentSessionEvent({
    ...event,
    source_kind: event.source_kind ?? input.source_kind,
    session_id: event.session_id ?? input.session_id,
    client_name: event.client_name ?? input.client_name,
    repo_path: event.repo_path ?? input.repo_path ?? null,
    workspace_id: event.workspace_id ?? input.workspace_id ?? null,
  }, now));
  const sourceId = input.source_id ?? stableId('source', input.source_kind, input.client_name ?? defaultClientName(input.source_kind));
  const policy = getDefaultSourcePolicy(input.source_kind);
  const rawText = events.map(formatEventForChunk).join('\n\n');
  const ingestPlan = buildRawIngestPlan({
    source_id: sourceId,
    external_id: `${input.session_id}:${stableId('agent-session-batch', ...events.map((event) => event.event_id))}`,
    origin_event: 'session_capture',
    locator: `${input.source_kind}://${input.session_id}`,
    title: `Agent session ${input.session_id}`,
    chunk_texts: events.map(formatEventForChunk),
    raw_text: rawText,
    parser_version: 'agent-session:v1',
    extractor_version: 'agent-session-memory:v1',
    now,
  }, {
    consent_state: 'granted',
    enabled: true,
    raw_copy_mode: policy.raw_copy_mode,
    automatic_canonical_write_authority: policy.automatic_canonical_write_authority,
  });
  ingestPlan.item.metadata_json = {
    source_kind: input.source_kind,
    session_id: input.session_id,
    client_name: input.client_name ?? defaultClientName(input.source_kind),
    repo_path: input.repo_path ?? null,
    workspace_id: input.workspace_id ?? null,
    event_ids: events.map((event) => event.event_id),
  };

  const chunks = ingestPlan.chunks;
  return {
    source_id: sourceId,
    events,
    ingest_plan: ingestPlan,
    source_refs: [
      `source_item:${ingestPlan.item.id}`,
      ...chunks.map((chunk) => `source_chunk:${chunk.id}`),
    ],
    safety: {
      secret_risk: chunks.some((chunk) => chunk.secret_risk !== 'none') ? 'flagged' : 'none',
      prompt_injection_flagged: chunks.some((chunk) => chunk.prompt_injection_risk !== 'none'),
      redacted: chunks.some((chunk) => chunk.redacted_text !== chunk.chunk_text),
    },
  };
}

function formatEventForChunk(event: AgentSessionNormalizedEvent): string {
  return [
    `[${event.occurred_at}] ${event.actor} ${event.event_kind}`,
    event.text,
  ].join('\n');
}

function defaultClientName(sourceKind: AgentSessionSourceKind): string {
  if (sourceKind === 'codex_session') return 'codex';
  if (sourceKind === 'claude_session') return 'claude';
  return 'agent';
}

function defaultActor(eventKind: AgentSessionEventInput['event_kind']) {
  if (eventKind === 'user_prompt' || eventKind === 'explicit_memory_note') return 'user';
  if (eventKind.startsWith('tool_') || eventKind === 'command_run') return 'tool';
  if (eventKind === 'subagent_result') return 'subagent';
  return 'assistant';
}

function requireNonEmpty(field: string, value: string): string {
  if (value.trim().length === 0) throw new Error(`${field} must be a non-empty string`);
  return value;
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}:${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24)}`;
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test test/agent-session-memory-service.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/services/agent-session-memory-service.ts test/agent-session-memory-service.test.ts
git commit -m "feat: capture agent session source plans"
```

## Task 4: Add Zero-LLM Compression And Session Summary

**Files:**
- Create: `src/core/services/agent-session-compression-service.ts`
- Test: `test/agent-session-compression-service.test.ts`

- [ ] **Step 1: Write failing compression tests**

```ts
import { describe, expect, test } from 'bun:test';
import {
  compressAgentSessionCapturePlan,
  summarizeAgentSessionObservations,
} from '../src/core/services/agent-session-compression-service.ts';
import { buildAgentSessionCapturePlan } from '../src/core/services/agent-session-memory-service.ts';

describe('agent session zero-LLM compression', () => {
  test('compresses a redacted user preference into a non-authoritative observation', () => {
    const plan = buildAgentSessionCapturePlan({
      source_kind: 'codex_session',
      session_id: 'session-1',
      events: [{
        source_kind: 'codex_session',
        session_id: 'session-1',
        event_kind: 'explicit_memory_note',
        actor: 'user',
        text: '기억해 주세요. 저는 구현 전에 짧은 플랜을 선호합니다.',
        occurred_at: '2026-06-03T01:00:00.000Z',
      }],
      now: '2026-06-03T01:01:00.000Z',
    });

    const observations = compressAgentSessionCapturePlan(plan);

    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      observation_type: 'conversation',
      session_id: 'session-1',
      sensitivity: 'personal',
      scope_id: 'personal:default',
      generated_by: 'agent_session_capture',
    });
    expect(observations[0].title).toContain('memory note');
    expect(observations[0].facts[0]).toContain('짧은 플랜');
  });

  test('summarizes decisions, files, errors, and follow-ups from observations', () => {
    const plan = buildAgentSessionCapturePlan({
      source_kind: 'codex_session',
      session_id: 'session-2',
      events: [
        {
          source_kind: 'codex_session',
          session_id: 'session-2',
          event_kind: 'user_prompt',
          actor: 'user',
          text: '목표: agent session memory 구현 계획을 정하세요.',
          occurred_at: '2026-06-03T01:00:00.000Z',
        },
        {
          source_kind: 'codex_session',
          session_id: 'session-2',
          event_kind: 'file_edit',
          actor: 'assistant',
          text: 'Edited src/core/services/agent-session-memory-service.ts and fixed a failing test.',
          occurred_at: '2026-06-03T01:10:00.000Z',
        },
      ],
      now: '2026-06-03T01:11:00.000Z',
    });

    const summary = summarizeAgentSessionObservations(compressAgentSessionCapturePlan(plan));

    expect(summary.session_id).toBe('session-2');
    expect(summary.user_goals[0]).toContain('agent session memory');
    expect(summary.files_touched).toContain('src/core/services/agent-session-memory-service.ts');
    expect(summary.errors_and_fixes[0]).toContain('fixed a failing test');
    expect(summary.source_refs).toEqual(expect.arrayContaining(plan.source_refs));
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run: `bun test test/agent-session-compression-service.test.ts`

Expected: FAIL with missing service exports.

- [ ] **Step 3: Implement deterministic compression**

```ts
import { createHash } from 'crypto';
import type {
  AgentSessionCapturePlan,
} from './agent-session-memory-service.ts';
import type {
  AgentSessionCompressedObservation,
  AgentSessionNormalizedEvent,
  AgentSessionObservationType,
  AgentSessionSummary,
} from '../types.ts';

export function compressAgentSessionCapturePlan(plan: AgentSessionCapturePlan): AgentSessionCompressedObservation[] {
  return plan.events.map((event, index) => {
    const chunk = plan.ingest_plan.chunks[index];
    const text = chunk.redacted_text;
    const files = extractFilePaths(text);
    const concepts = extractConcepts(text);
    return {
      id: stableId('agent-session-observation', plan.ingest_plan.item.id, event.event_id),
      source_item_id: plan.ingest_plan.item.id,
      source_chunk_ids: [chunk.id],
      session_id: event.session_id,
      event_ids: [event.event_id],
      observed_at: event.occurred_at,
      observation_type: observationTypeFor(event),
      title: titleFor(event, text),
      narrative: firstSentence(text, 240),
      facts: factLinesFor(event, text),
      concepts,
      files,
      importance_score: importanceFor(event, text),
      confidence_score: confidenceFor(event, text, chunk.redacted_text !== chunk.chunk_text),
      sensitivity: sensitivityFor(text, chunk.sensitivity_flags),
      scope_id: scopeFor(text, chunk.sensitivity_flags),
      source_refs: [`source_item:${plan.ingest_plan.item.id}`, `source_chunk:${chunk.id}`],
      generated_by: 'agent_session_capture',
    };
  });
}

export function summarizeAgentSessionObservations(
  observations: AgentSessionCompressedObservation[],
): AgentSessionSummary {
  const sessionId = observations[0]?.session_id ?? 'unknown-session';
  const sourceItemIds = dedupe(observations.map((observation) => observation.source_item_id));
  const sourceChunkIds = dedupe(observations.flatMap((observation) => observation.source_chunk_ids));
  const sourceRefs = dedupe(observations.flatMap((observation) => observation.source_refs));
  const facts = observations.flatMap((observation) => observation.facts);
  return {
    id: stableId('agent-session-summary', sessionId, ...sourceChunkIds),
    session_id: sessionId,
    source_item_ids: sourceItemIds,
    source_chunk_ids: sourceChunkIds,
    started_at: observations[0]?.observed_at ?? null,
    ended_at: observations.at(-1)?.observed_at ?? null,
    title: observations[0]?.title ?? 'Agent session summary',
    outcome: firstMatching(facts, [/completed/i, /fixed/i, /resolved/i]) ?? firstSentence(facts.join(' '), 220),
    user_goals: facts.filter((fact) => /목표|goal|want|request/i.test(fact)).slice(0, 5),
    decisions: facts.filter((fact) => /decid|decision|선택|결정/i.test(fact)).slice(0, 5),
    preferences: facts.filter((fact) => /prefer|preference|선호|좋아|싫어|기억/i.test(fact)).slice(0, 5),
    files_touched: dedupe(observations.flatMap((observation) => observation.files)).slice(0, 20),
    errors_and_fixes: facts.filter((fact) => /error|fail|fixed|실패|수정/i.test(fact)).slice(0, 8),
    unresolved_questions: facts.filter((fact) => /\?|question|unclear|blocked|질문|불명확/i.test(fact)).slice(0, 8),
    follow_ups: facts.filter((fact) => /follow[- ]?up|next|다음|추가/i.test(fact)).slice(0, 8),
    candidate_memory_signals: facts.filter((fact) => /remember|기억|prefer|선호|decision|결정/i.test(fact)).slice(0, 10),
    source_refs: sourceRefs,
    sensitivity: observations.some((observation) => observation.sensitivity === 'secret')
      ? 'secret'
      : observations.some((observation) => observation.sensitivity === 'personal')
        ? 'personal'
        : 'work',
    generated_by: 'agent_session_capture',
  };
}
```

Add these helpers in the same file:

```ts
function extractFilePaths(text: string): string[] {
  const matches = text.match(/\b(?:src|test|docs|scripts|skills|reference)\/[A-Za-z0-9._/-]+\b/g) ?? [];
  return dedupe(matches);
}

function extractConcepts(text: string): string[] {
  const concepts: string[] = [];
  if (/memory|메모리/i.test(text)) concepts.push('memory');
  if (/profile|preference|선호/i.test(text)) concepts.push('profile memory');
  if (/episode|session|세션/i.test(text)) concepts.push('personal episode');
  if (/plan|플랜|spec/i.test(text)) concepts.push('planning');
  if (/test|fail|pass|검증/i.test(text)) concepts.push('verification');
  return dedupe(concepts);
}

function observationTypeFor(event: AgentSessionNormalizedEvent): AgentSessionObservationType {
  if (event.event_kind === 'tool_failure') return 'tool_failure';
  if (event.event_kind === 'tool_call' || event.event_kind === 'tool_result') return 'tool_use';
  if (event.event_kind === 'file_read') return 'file_read';
  if (event.event_kind === 'file_write') return 'file_write';
  if (event.event_kind === 'file_edit') return 'file_edit';
  if (event.event_kind === 'command_run') return 'command_run';
  if (event.event_kind === 'search') return 'search';
  if (event.event_kind === 'subagent_result') return 'subagent';
  if (event.event_kind === 'session_stop') return 'session_summary';
  if (event.event_kind === 'user_prompt' || event.event_kind === 'assistant_response' || event.event_kind === 'explicit_memory_note') {
    return 'conversation';
  }
  return 'other';
}

function titleFor(event: AgentSessionNormalizedEvent, text: string): string {
  if (event.event_kind === 'explicit_memory_note') return 'explicit memory note';
  if (event.event_kind === 'session_stop') return 'session outcome';
  if (event.event_kind === 'command_run') return firstSentence(text.replace(/^.*command_run\s*/m, ''), 80);
  return firstSentence(text, 80);
}

function factLinesFor(event: AgentSessionNormalizedEvent, text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^\[.+\]\s+\w+\s+\w+/.test(line));
  return lines.length > 0 ? lines.slice(0, 5) : [event.text.trim()].filter(Boolean);
}

function importanceFor(event: AgentSessionNormalizedEvent, text: string): number {
  if (event.event_kind === 'explicit_memory_note') return 0.85;
  if (/기억|remember|decision|결정|preference|선호/i.test(text)) return 0.8;
  if (event.event_kind === 'session_stop') return 0.7;
  if (/fail|error|fixed|실패|수정/i.test(text)) return 0.65;
  return 0.45;
}

function confidenceFor(event: AgentSessionNormalizedEvent, text: string, redacted: boolean): number {
  if (redacted) return 0.45;
  if (event.actor === 'user') return 0.85;
  if (event.event_kind === 'tool_result' || event.event_kind === 'command_run') return 0.75;
  if (/inferred|추론/i.test(text)) return 0.5;
  return 0.65;
}

function sensitivityFor(text: string, flags: string[]): AgentSessionCompressedObservation['sensitivity'] {
  if (flags.includes('secret')) return 'secret';
  if (/personal|개인|선호|routine|습관|health|family/i.test(text)) return 'personal';
  if (/public/i.test(text)) return 'public';
  return 'work';
}

function scopeFor(text: string, flags: string[]): string {
  return sensitivityFor(text, flags) === 'personal' ? 'personal:default' : 'workspace:default';
}

function firstSentence(text: string, maxLength: number): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  const sentence = trimmed.match(/^(.+?[.!?。！？])\s/)?.[1] ?? trimmed;
  return sentence.length <= maxLength ? sentence : `${sentence.slice(0, maxLength - 1).trim()}...`;
}

function firstMatching(values: string[], patterns: RegExp[]): string | null {
  return values.find((value) => patterns.some((pattern) => pattern.test(value))) ?? null;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}:${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 24)}`;
}
```

- [ ] **Step 4: Run compression tests**

Run: `bun test test/agent-session-compression-service.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/services/agent-session-compression-service.ts test/agent-session-compression-service.test.ts
git commit -m "feat: compress agent session observations"
```

## Task 5: Add MBrain-Native Signal Classifier

**Files:**
- Create: `src/core/services/agent-session-classifier-service.ts`
- Test: `test/agent-session-classifier-service.test.ts`

- [ ] **Step 1: Write failing classifier tests**

```ts
import { describe, expect, test } from 'bun:test';
import { classifyAgentSessionMemorySignals } from '../src/core/services/agent-session-classifier-service.ts';
import { compressAgentSessionCapturePlan, summarizeAgentSessionObservations } from '../src/core/services/agent-session-compression-service.ts';
import { buildAgentSessionCapturePlan } from '../src/core/services/agent-session-memory-service.ts';

describe('agent session memory signal classifier', () => {
  test('classifies explicit user preferences as profile memory signals', () => {
    const plan = buildAgentSessionCapturePlan({
      source_kind: 'codex_session',
      session_id: 'session-1',
      events: [{
        source_kind: 'codex_session',
        session_id: 'session-1',
        event_kind: 'explicit_memory_note',
        actor: 'user',
        text: '기억해 주세요. 저는 구현 전에 짧은 플랜을 선호합니다.',
      }],
      now: '2026-06-03T01:00:00.000Z',
    });
    const observations = compressAgentSessionCapturePlan(plan);

    const signals = classifyAgentSessionMemorySignals({
      observations,
      summary: summarizeAgentSessionObservations(observations),
    });

    expect(signals[0]).toMatchObject({
      signal_kind: 'profile_memory',
      evidence_kind: 'direct_user_statement',
      candidate_type: 'profile_update',
      target_object_type: 'profile_memory',
      scope_id: 'personal:default',
      sensitivity: 'personal',
      profile_type: 'preference',
    });
  });

  test('classifies session outcomes as personal episode signals', () => {
    const plan = buildAgentSessionCapturePlan({
      source_kind: 'codex_session',
      session_id: 'session-2',
      events: [{
        source_kind: 'codex_session',
        session_id: 'session-2',
        event_kind: 'session_stop',
        actor: 'assistant',
        text: 'Completed the plan for agent session memory. Next step is implementation.',
      }],
      now: '2026-06-03T01:00:00.000Z',
    });
    const observations = compressAgentSessionCapturePlan(plan);

    const signals = classifyAgentSessionMemorySignals({
      observations,
      summary: summarizeAgentSessionObservations(observations),
    });

    expect(signals.some((signal) => signal.signal_kind === 'personal_episode')).toBe(true);
    expect(signals.find((signal) => signal.signal_kind === 'personal_episode')).toMatchObject({
      evidence_kind: 'source_extracted',
      target_object_type: 'personal_episode',
      personal_episode_source_kind: 'chat',
    });
  });

  test('classifies pure task mechanics as no-write', () => {
    const plan = buildAgentSessionCapturePlan({
      source_kind: 'codex_session',
      session_id: 'session-3',
      events: [{
        source_kind: 'codex_session',
        session_id: 'session-3',
        event_kind: 'command_run',
        actor: 'tool',
        text: 'Ran git status --short.',
      }],
      now: '2026-06-03T01:00:00.000Z',
    });
    const observations = compressAgentSessionCapturePlan(plan);

    const signals = classifyAgentSessionMemorySignals({
      observations,
      summary: summarizeAgentSessionObservations(observations),
    });

    expect(signals[0]).toMatchObject({
      signal_kind: 'no_write',
      evidence_kind: 'task_mechanics',
      candidate_type: null,
      target_object_type: null,
    });
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run: `bun test test/agent-session-classifier-service.test.ts`

Expected: FAIL with missing classifier export.

- [ ] **Step 3: Implement deterministic classification**

```ts
import { createHash } from 'crypto';
import type {
  AgentSessionCompressedObservation,
  AgentSessionMemorySignal,
  AgentSessionSummary,
} from '../types.ts';

export interface AgentSessionSignalClassifierInput {
  observations: AgentSessionCompressedObservation[];
  summary: AgentSessionSummary;
}

export function classifyAgentSessionMemorySignals(
  input: AgentSessionSignalClassifierInput,
): AgentSessionMemorySignal[] {
  const signals: AgentSessionMemorySignal[] = [];

  for (const observation of input.observations) {
    const text = [observation.title, observation.narrative, ...observation.facts].join('\n');
    if (isPureTaskMechanics(observation, text)) {
      signals.push(noWriteSignal(observation, text));
      continue;
    }
    if (isExplicitPreference(text)) {
      signals.push(profileSignal(observation, text));
      continue;
    }
    if (isProcedureSignal(text)) {
      signals.push(procedureSignal(observation, text));
      continue;
    }
    if (isOpenQuestion(text)) {
      signals.push(openQuestionSignal(observation, text));
    }
  }

  if (input.summary.outcome.trim().length > 0) {
    signals.push(personalEpisodeSignal(input.summary));
  }

  return dedupeSignals(signals);
}
```

Use these exact routing defaults in helper functions:

```ts
function profileSignal(observation: AgentSessionCompressedObservation, text: string): AgentSessionMemorySignal {
  return {
    id: signalId('profile', observation.id, text),
    source_observation_id: observation.id,
    content: firstSentence(text, 280),
    evidence_kind: 'direct_user_statement',
    signal_kind: 'profile_memory',
    candidate_type: 'profile_update',
    target_object_type: 'profile_memory',
    target_object_id: null,
    scope_id: 'personal:default',
    sensitivity: observation.sensitivity === 'secret' ? 'secret' : 'personal',
    confidence_score: Math.max(observation.confidence_score, 0.8),
    importance_score: Math.max(observation.importance_score, 0.75),
    recurrence_score: 0,
    source_refs: observation.source_refs,
    profile_type: /routine|habit|루틴|습관/i.test(text) ? 'routine' : 'preference',
    profile_subject: /plan|플랜|planning/i.test(text) ? 'implementation planning' : 'user preference',
    scenario_source_kind: 'chat',
  };
}

function personalEpisodeSignal(summary: AgentSessionSummary): AgentSessionMemorySignal {
  return {
    id: signalId('episode', summary.id, summary.outcome),
    source_observation_id: summary.id,
    content: summary.outcome,
    evidence_kind: 'source_extracted',
    signal_kind: 'personal_episode',
    candidate_type: 'fact',
    target_object_type: 'personal_episode',
    target_object_id: null,
    scope_id: 'personal:default',
    sensitivity: summary.sensitivity === 'secret' ? 'secret' : 'personal',
    confidence_score: 0.7,
    importance_score: summary.decisions.length > 0 || summary.follow_ups.length > 0 ? 0.75 : 0.55,
    recurrence_score: 0,
    source_refs: summary.source_refs,
    personal_episode_title: summary.title,
    personal_episode_source_kind: 'chat',
    scenario_source_kind: 'session_end',
  };
}
```

Add the remaining classifier helpers in the same file:

```ts
function isPureTaskMechanics(
  observation: AgentSessionCompressedObservation,
  text: string,
): boolean {
  return observation.observation_type === 'command_run'
    && /^Ran\s+(git status|pwd|ls|rg|bun test|git diff|git add|git commit)/i.test(text.replace(/\s+/g, ' ').trim());
}

function isExplicitPreference(text: string): boolean {
  return /기억해|remember|prefer|preference|선호|좋아|싫어|routine|habit|습관/i.test(text);
}

function isProcedureSignal(text: string): boolean {
  return /항상|always|workflow|procedure|runbook|검증 단계|release step/i.test(text)
    && !isExplicitPreference(text);
}

function isOpenQuestion(text: string): boolean {
  return /\?|question|unclear|blocked|질문|불명확|막힘/i.test(text);
}

function noWriteSignal(observation: AgentSessionCompressedObservation, text: string): AgentSessionMemorySignal {
  return baseSignal('no-write', observation, text, {
    evidence_kind: 'task_mechanics',
    signal_kind: 'no_write',
    candidate_type: null,
    target_object_type: null,
    target_object_id: null,
  });
}

function procedureSignal(observation: AgentSessionCompressedObservation, text: string): AgentSessionMemorySignal {
  return baseSignal('procedure', observation, text, {
    evidence_kind: observation.confidence_score >= 0.8 ? 'source_extracted' : 'agent_inferred',
    signal_kind: 'procedure',
    candidate_type: 'procedure',
    target_object_type: 'procedure',
    target_object_id: null,
  });
}

function openQuestionSignal(observation: AgentSessionCompressedObservation, text: string): AgentSessionMemorySignal {
  return baseSignal('open-question', observation, text, {
    evidence_kind: 'ambiguous',
    signal_kind: 'open_question',
    candidate_type: 'open_question',
    target_object_type: 'other',
    target_object_id: null,
  });
}

function baseSignal(
  kind: string,
  observation: AgentSessionCompressedObservation,
  text: string,
  route: Pick<AgentSessionMemorySignal, 'evidence_kind' | 'signal_kind' | 'candidate_type' | 'target_object_type' | 'target_object_id'>,
): AgentSessionMemorySignal {
  return {
    id: signalId(kind, observation.id, text),
    source_observation_id: observation.id,
    content: firstSentence(text, 280),
    ...route,
    scope_id: observation.scope_id,
    sensitivity: observation.sensitivity,
    confidence_score: observation.confidence_score,
    importance_score: observation.importance_score,
    recurrence_score: 0,
    source_refs: observation.source_refs,
    scenario_source_kind: scenarioSourceKindForObservation(observation),
  };
}

function scenarioSourceKindForObservation(observation: AgentSessionCompressedObservation): AgentSessionMemorySignal['scenario_source_kind'] {
  if (observation.observation_type === 'session_summary') return 'session_end';
  if (observation.observation_type === 'command_run' || observation.observation_type.startsWith('file_')) return 'code_event';
  return 'chat';
}

function firstSentence(text: string, maxLength: number): string {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  const sentence = trimmed.match(/^(.+?[.!?。！？])\s/)?.[1] ?? trimmed;
  return sentence.length <= maxLength ? sentence : `${sentence.slice(0, maxLength - 1).trim()}...`;
}

function signalId(prefix: string, ...parts: string[]): string {
  return `agent-session-signal:${prefix}:${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16)}`;
}

function dedupeSignals(signals: AgentSessionMemorySignal[]): AgentSessionMemorySignal[] {
  const seen = new Set<string>();
  return signals.filter((signal) => {
    const key = `${signal.signal_kind}\0${signal.content}\0${signal.target_object_type ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
```

- [ ] **Step 4: Run classifier tests**

Run: `bun test test/agent-session-classifier-service.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/services/agent-session-classifier-service.ts test/agent-session-classifier-service.test.ts
git commit -m "feat: classify agent session memory signals"
```

## Task 6: Add Writeback Integrator With Governed Direct Personal Writes

**Files:**
- Create: `src/core/services/agent-session-writeback-service.ts`
- Test: `test/agent-session-writeback-service.test.ts`

- [ ] **Step 1: Write failing writeback tests**

```ts
import { describe, expect, test } from 'bun:test';
import type { AgentSessionMemorySignal } from '../src/core/types.ts';
import { routeAgentSessionMemorySignals } from '../src/core/services/agent-session-writeback-service.ts';

const engine = new Proxy({}, {
  get() {
    throw new Error('candidate-only writeback preview must not read the engine');
  },
}) as any;

function signal(overrides: Partial<AgentSessionMemorySignal> = {}): AgentSessionMemorySignal {
  return {
    id: 'signal-1',
    source_observation_id: 'observation-1',
    content: 'The user prefers a short implementation plan.',
    evidence_kind: 'direct_user_statement',
    signal_kind: 'profile_memory',
    candidate_type: 'profile_update',
    target_object_type: 'profile_memory',
    target_object_id: null,
    scope_id: 'personal:default',
    sensitivity: 'personal',
    confidence_score: 0.9,
    importance_score: 0.8,
    recurrence_score: 0,
    source_refs: ['source_item:1', 'source_chunk:1'],
    profile_type: 'preference',
    profile_subject: 'implementation planning',
    scenario_source_kind: 'chat',
    ...overrides,
  };
}

describe('agent session writeback service', () => {
  test('routes inferred or candidate-only profile signals to Memory Inbox candidates', async () => {
    const result = await routeAgentSessionMemorySignals(engine, {
      signals: [signal({ evidence_kind: 'agent_inferred' })],
      apply: false,
      write_mode: 'candidate_only',
    });

    expect(result[0].direct_write).toBeNull();
    expect(result[0].route?.decision).toBe('create_candidate');
    expect(result[0].route?.candidate_input?.target_object_type).toBe('profile_memory');
  });

  test('routes no-write task mechanics without creating a candidate', async () => {
    const result = await routeAgentSessionMemorySignals(engine, {
      signals: [signal({
        signal_kind: 'no_write',
        evidence_kind: 'task_mechanics',
        candidate_type: null,
        target_object_type: null,
      })],
      apply: false,
      write_mode: 'candidate_only',
    });

    expect(result[0].route?.decision).toBe('no_write');
    expect(result[0].blocked_reason).toBeNull();
  });
});
```

- [ ] **Step 2: Run the failing tests**

Run: `bun test test/agent-session-writeback-service.test.ts`

Expected: FAIL with missing writeback service export.

- [ ] **Step 3: Implement candidate routing and no-write routing**

```ts
import { randomUUID } from 'crypto';
import type { BrainEngine } from '../engine.ts';
import { reviewDuplicateMemory } from './duplicate-memory-review-service.ts';
import { createMemoryCandidateEntryWithStatusEvent } from './memory-inbox-service.ts';
import { routeMemoryWriteback } from './memory-writeback-router-service.ts';
import { selectPersonalWriteTarget } from './personal-write-target-service.ts';
import type {
  AgentSessionMemoryRouteResult,
  AgentSessionMemorySignal,
  AgentSessionWriteMode,
  RouteMemoryWritebackInput,
} from '../types.ts';

export interface AgentSessionWritebackInput {
  signals: AgentSessionMemorySignal[];
  apply: boolean;
  write_mode: AgentSessionWriteMode;
}

export async function routeAgentSessionMemorySignals(
  engine: BrainEngine,
  input: AgentSessionWritebackInput,
): Promise<AgentSessionMemoryRouteResult[]> {
  const results: AgentSessionMemoryRouteResult[] = [];
  for (const signal of input.signals) {
    const direct = await maybeDirectPersonalWrite(engine, signal, input);
    if (direct) {
      results.push({ signal, route: null, direct_write: direct, blocked_reason: null });
      continue;
    }

    const routeInput = routeInputForSignal(signal);
    const routed = routeMemoryWriteback(routeInput);
    if (!input.apply || routed.decision !== 'create_candidate' || !routed.candidate_input) {
      results.push({ signal, route: routed, direct_write: null, blocked_reason: null });
      continue;
    }

    const candidateInput = {
      ...routed.candidate_input,
      id: routed.candidate_input.id ?? randomUUID(),
    };
    const duplicateReview = await reviewDuplicateMemory(engine, {
      scope_id: candidateInput.scope_id,
      subject_kind: 'memory_candidate',
      subject_id: candidateInput.id,
      content: candidateInput.proposed_content,
      source_refs: candidateInput.source_refs,
      candidate_type: candidateInput.candidate_type,
      target_object_type: candidateInput.target_object_type ?? undefined,
      target_object_id: candidateInput.target_object_id ?? undefined,
      include_pages: true,
      include_candidates: true,
      limit: 5,
    });
    const created = await createMemoryCandidateEntryWithStatusEvent(engine, candidateInput);
    results.push({
      signal,
      route: {
        ...routed,
        applied: true,
        candidate_input: candidateInput,
        created_candidate: created,
        duplicate_review: duplicateReview,
      } as typeof routed,
      direct_write: null,
      blocked_reason: null,
    });
  }
  return results;
}

export function routeInputForSignal(signal: AgentSessionMemorySignal): RouteMemoryWritebackInput {
  return {
    content: signal.content,
    source_refs: signal.source_refs,
    source_kind: signal.scenario_source_kind ?? scenarioSourceKindFor(signal),
    evidence_kind: signal.evidence_kind,
    candidate_type: signal.candidate_type ?? undefined,
    target_object_type: signal.target_object_type ?? undefined,
    target_object_id: signal.target_object_id ?? undefined,
    scope_id: signal.scope_id,
    sensitivity: signal.sensitivity,
    confidence_score: signal.confidence_score,
    importance_score: signal.importance_score,
    recurrence_score: signal.recurrence_score,
    allow_canonical_write: false,
  };
}
```

Add the scenario source-kind helper:

```ts
function scenarioSourceKindFor(signal: AgentSessionMemorySignal): RouteMemoryWritebackInput['source_kind'] {
  if (signal.signal_kind === 'personal_episode') return 'session_end';
  if (signal.signal_kind === 'task_memory' || signal.evidence_kind === 'code_sensitive') return 'code_event';
  if (signal.evidence_kind === 'task_mechanics') return 'code_event';
  if (signal.evidence_kind === 'direct_user_statement') return 'chat';
  return 'trace_review';
}
```

Direct personal write helper:

```ts
async function maybeDirectPersonalWrite(
  engine: BrainEngine,
  signal: AgentSessionMemorySignal,
  input: AgentSessionWritebackInput,
): Promise<AgentSessionMemoryRouteResult['direct_write']> {
  if (!input.apply || input.write_mode !== 'direct_personal_when_allowed') return null;
  if (signal.evidence_kind !== 'direct_user_statement' && signal.evidence_kind !== 'source_extracted') return null;
  if (signal.sensitivity === 'secret' || signal.sensitivity === 'unknown') return null;
  if (signal.signal_kind === 'profile_memory') {
    const preflight = await selectPersonalWriteTarget(engine, {
      target_kind: 'profile_memory',
      requested_scope: 'personal',
      query: signal.content,
      subject: signal.profile_subject,
    });
    if (!preflight.route || !signal.profile_type || !signal.profile_subject) return null;
    const id = randomUUID();
    await engine.upsertProfileMemoryEntry({
      id,
      scope_id: preflight.route.scope_id,
      profile_type: signal.profile_type,
      subject: signal.profile_subject,
      content: signal.content,
      source_refs: signal.source_refs,
      sensitivity: 'personal',
      export_status: 'private_only',
      last_confirmed_at: new Date().toISOString(),
      superseded_by: null,
    });
    return { kind: 'profile_memory', id, status: 'written' };
  }
  if (signal.signal_kind === 'personal_episode') {
    const preflight = await selectPersonalWriteTarget(engine, {
      target_kind: 'personal_episode',
      requested_scope: 'personal',
      query: signal.content,
      title: signal.personal_episode_title,
    });
    if (!preflight.route) return null;
    const id = randomUUID();
    await engine.createPersonalEpisodeEntry({
      id,
      scope_id: preflight.route.scope_id,
      title: signal.personal_episode_title ?? 'Agent session episode',
      start_time: new Date().toISOString(),
      end_time: null,
      source_kind: signal.personal_episode_source_kind ?? 'chat',
      summary: signal.content,
      source_refs: signal.source_refs,
      candidate_ids: [],
    });
    return { kind: 'personal_episode', id, status: 'written' };
  }
  return null;
}
```

- [ ] **Step 4: Run writeback service tests**

Run: `bun test test/agent-session-writeback-service.test.ts`

Expected: PASS.

- [ ] **Step 5: Add SQLite direct-write tests**

Append this SQLite test to `test/agent-session-writeback-service.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

test('direct personal write mode stores explicit profile memory after preflight', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-agent-session-writeback-'));
  const databasePath = join(dir, 'brain.db');
  const sqlite = new SQLiteEngine();
  try {
    await sqlite.connect({ engine: 'sqlite', database_path: databasePath });
    await sqlite.initSchema();

    const result = await routeAgentSessionMemorySignals(sqlite, {
      signals: [signal()],
      apply: true,
      write_mode: 'direct_personal_when_allowed',
    });

    expect(result[0].direct_write).toMatchObject({
      kind: 'profile_memory',
      status: 'written',
    });
    const entries = await sqlite.listProfileMemoryEntries({
      scope_id: 'personal:default',
      subject: 'implementation planning',
      limit: 10,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toContain('short implementation plan');
  } finally {
    await sqlite.disconnect().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 6: Run writeback service tests again**

Run: `bun test test/agent-session-writeback-service.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/services/agent-session-writeback-service.ts test/agent-session-writeback-service.test.ts
git commit -m "feat: route agent session memory writeback"
```

## Task 7: Add Activation Artifact Builder

**Files:**
- Create: `src/core/services/agent-session-activation-service.ts`
- Test: `test/agent-session-writeback-service.test.ts`

- [ ] **Step 1: Write failing activation artifact test**

Append this test to `test/agent-session-writeback-service.test.ts`:

```ts
import { buildAgentSessionActivationArtifacts } from '../src/core/services/agent-session-activation-service.ts';
import { selectActivationPolicy } from '../src/core/services/memory-activation-policy-service.ts';

test('agent session route results preserve candidate authority during activation', () => {
  const routeResults = [{
    signal: signal({ id: 'signal-candidate' }),
    route: {
      decision: 'create_candidate',
      intended_operation: 'create_memory_candidate_entry',
      applied: false,
      reasons: ['inferred_signal_requires_review'],
      missing_requirements: [],
      source_kind: 'chat',
      scope_id: 'personal:default',
      sensitivity: 'personal',
      candidate_type: 'profile_update',
      extraction_kind: 'inferred',
      target_object_type: 'profile_memory',
      target_object_id: null,
      candidate_input: {
        scope_id: 'personal:default',
        candidate_type: 'profile_update',
        proposed_content: 'The user prefers short plans.',
        source_refs: ['source_item:1'],
        generated_by: 'agent',
        extraction_kind: 'inferred',
        confidence_score: 0.7,
        importance_score: 0.7,
        recurrence_score: 0,
        sensitivity: 'personal',
        status: 'candidate',
        target_object_type: 'profile_memory',
        target_object_id: null,
        reviewed_at: null,
        review_reason: null,
      },
    },
    direct_write: null,
    blocked_reason: null,
  }];

  const artifacts = buildAgentSessionActivationArtifacts(routeResults as any);
  const policy = selectActivationPolicy({ scenario: 'personal_recall', artifacts });

  expect(artifacts[0]).toMatchObject({
    artifact_kind: 'memory_candidate',
    scope_policy: 'allow',
  });
  expect(policy.decisions[0]).toMatchObject({
    decision: 'candidate_only',
    authority: 'unreviewed_candidate',
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `bun test test/agent-session-writeback-service.test.ts`

Expected: FAIL with missing activation service export.

- [ ] **Step 3: Implement activation artifact builder**

```ts
import type {
  AgentSessionMemoryRouteResult,
  MemoryActivationArtifact,
} from '../types.ts';

export function buildAgentSessionActivationArtifacts(
  routeResults: AgentSessionMemoryRouteResult[],
): MemoryActivationArtifact[] {
  return routeResults.flatMap((result) => {
    if (result.direct_write?.kind === 'profile_memory') {
      return [{
        id: `profile-memory:${result.direct_write.id}`,
        artifact_kind: 'profile_memory',
        source_ref: `profile-memory:${result.direct_write.id}`,
        scope_policy: 'allow',
      } satisfies MemoryActivationArtifact];
    }
    if (result.direct_write?.kind === 'personal_episode') {
      return [{
        id: `personal-episode:${result.direct_write.id}`,
        artifact_kind: 'personal_episode',
        source_ref: `personal-episode:${result.direct_write.id}`,
        scope_policy: 'allow',
      } satisfies MemoryActivationArtifact];
    }
    if (result.route?.candidate_input) {
      return [{
        id: result.route.candidate_input.id
          ? `memory-candidate:${result.route.candidate_input.id}`
          : `memory-candidate-preview:${result.signal.id}`,
        artifact_kind: 'memory_candidate',
        source_ref: result.route.candidate_input.source_refs[0] ?? result.signal.source_refs[0],
        scope_policy: result.signal.scope_id.startsWith('personal:') ? 'allow' : undefined,
      } satisfies MemoryActivationArtifact];
    }
    return [];
  });
}
```

- [ ] **Step 4: Run activation/writeback tests**

Run: `bun test test/agent-session-writeback-service.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/services/agent-session-activation-service.ts test/agent-session-writeback-service.test.ts
git commit -m "feat: label agent session activation artifacts"
```

## Task 8: Add Contract-First Operations

**Files:**
- Create: `src/core/operations-agent-session-memory.ts`
- Modify: `src/core/operations.ts`
- Test: `test/agent-session-memory-operations.test.ts`

- [ ] **Step 1: Write failing operation tests**

```ts
import { describe, expect, test } from 'bun:test';
import { operationsByName, parseOpArgs, type OperationContext } from '../src/core/operations.ts';

const previewCtx: OperationContext = {
  engine: new Proxy({}, {
    get() {
      throw new Error('preview_agent_session_memory must not read the engine');
    },
  }) as unknown as OperationContext['engine'],
  config: {} as OperationContext['config'],
  logger: console,
  dryRun: false,
};

describe('agent session memory operations', () => {
  test('registers preview and capture operations with CLI hints', () => {
    expect(operationsByName.preview_agent_session_memory).toBeDefined();
    expect(operationsByName.preview_agent_session_memory.mutating).toBe(false);
    expect(operationsByName.preview_agent_session_memory.cliHints?.name).toBe('agent-session-preview');
    expect(operationsByName.capture_agent_session_memory).toBeDefined();
    expect(operationsByName.capture_agent_session_memory.mutating).toBe(true);
    expect(operationsByName.capture_agent_session_memory.cliHints?.name).toBe('agent-session-capture');
  });

  test('preview operation returns observations, summary, signals, routes, and activation artifacts', async () => {
    const result = await operationsByName.preview_agent_session_memory.handler(previewCtx, {
      source_kind: 'codex_session',
      session_id: 'session-1',
      events: [{
        event_kind: 'explicit_memory_note',
        actor: 'user',
        text: '기억해 주세요. 저는 구현 전에 짧은 플랜을 선호합니다.',
      }],
      now: '2026-06-03T01:00:00.000Z',
    }) as any;

    expect(result.capture.ingest_plan.chunks[0].redacted_text).toContain('짧은 플랜');
    expect(result.observations).toHaveLength(1);
    expect(result.signals[0].signal_kind).toBe('profile_memory');
    expect(result.routes[0].route.decision).toBe('create_candidate');
    expect(result.activation_artifacts[0].artifact_kind).toBe('memory_candidate');
  });

  test('CLI parser accepts events as JSON array string', () => {
    const warnings: string[] = [];
    const params = parseOpArgs(operationsByName.preview_agent_session_memory, [
      '--source-kind', 'codex_session',
      '--session-id', 'session-1',
      '--events', JSON.stringify([{ event_kind: 'command_run', text: 'Ran git status --short.' }]),
    ], { warn: (msg) => warnings.push(msg) });

    expect(warnings).toEqual([]);
    expect(params.source_kind).toBe('codex_session');
    expect(params.session_id).toBe('session-1');
    expect(params.events).toBe(JSON.stringify([{ event_kind: 'command_run', text: 'Ran git status --short.' }]));
  });
});
```

- [ ] **Step 2: Run failing operation tests**

Run: `bun test test/agent-session-memory-operations.test.ts`

Expected: FAIL because operations are not registered.

- [ ] **Step 3: Implement operation module**

```ts
import type { Operation } from './operations.ts';
import {
  AGENT_SESSION_SOURCE_KINDS,
  type AgentSessionEventInput,
  type AgentSessionSourceKind,
  type AgentSessionWriteMode,
} from './types.ts';
import { buildAgentSessionCapturePlan } from './services/agent-session-memory-service.ts';
import {
  compressAgentSessionCapturePlan,
  summarizeAgentSessionObservations,
} from './services/agent-session-compression-service.ts';
import { classifyAgentSessionMemorySignals } from './services/agent-session-classifier-service.ts';
import { routeAgentSessionMemorySignals } from './services/agent-session-writeback-service.ts';
import { buildAgentSessionActivationArtifacts } from './services/agent-session-activation-service.ts';

type OperationErrorCtor = new (
  code: 'invalid_params',
  message: string,
  suggestion?: string,
  docs?: string,
) => Error;

export function createAgentSessionMemoryOperations(
  deps: { OperationError: OperationErrorCtor },
): Operation[] {
  const preview_agent_session_memory: Operation = {
    name: 'preview_agent_session_memory',
    description: 'Preview redacted capture, zero-LLM compression, memory signal classification, and governed routes for agent session events.',
    params: agentSessionParams(false),
    mutating: false,
    handler: async (ctx, params) => runAgentSessionMemoryOperation(deps, ctx, params, false),
    cliHints: { name: 'agent-session-preview' },
  };

  const capture_agent_session_memory: Operation = {
    name: 'capture_agent_session_memory',
    description: 'Capture agent session events and optionally apply governed memory writeback.',
    params: agentSessionParams(true),
    mutating: true,
    handler: async (ctx, params) => runAgentSessionMemoryOperation(deps, ctx, params, params.apply === true && !ctx.dryRun),
    cliHints: { name: 'agent-session-capture' },
  };

  return [preview_agent_session_memory, capture_agent_session_memory];
}
```

Add helper body in the same file:

```ts
async function runAgentSessionMemoryOperation(
  deps: { OperationError: OperationErrorCtor },
  ctx: Parameters<Operation['handler']>[0],
  params: Record<string, unknown>,
  apply: boolean,
) {
  const sourceKind = enumValue(deps, 'source_kind', params.source_kind, AGENT_SESSION_SOURCE_KINDS);
  const sessionId = stringValue(deps, 'session_id', params.session_id);
  const events = parseEvents(deps, params.events).map((event) => ({
    ...event,
    source_kind: event.source_kind ?? sourceKind,
    session_id: event.session_id ?? sessionId,
  }));
  const capture = buildAgentSessionCapturePlan({
    source_kind: sourceKind,
    session_id: sessionId,
    client_name: optionalString(params.client_name),
    source_id: optionalString(params.source_id),
    repo_path: nullableString(params.repo_path),
    workspace_id: nullableString(params.workspace_id),
    events,
    now: optionalString(params.now),
  });
  const observations = compressAgentSessionCapturePlan(capture);
  const summary = summarizeAgentSessionObservations(observations);
  const signals = classifyAgentSessionMemorySignals({ observations, summary });
  const routes = await routeAgentSessionMemorySignals(ctx.engine, {
    signals,
    apply,
    write_mode: writeMode(params.write_mode),
  });
  const activationArtifacts = buildAgentSessionActivationArtifacts(routes);

  return {
    applied: apply,
    dry_run: ctx.dryRun,
    capture,
    observations,
    summary,
    signals,
    routes,
    activation_artifacts: activationArtifacts,
  };
}
```

Add parser and validation helpers in the same file:

```ts
function agentSessionParams(mutating: boolean): Operation['params'] {
  return {
    source_kind: { type: 'string', required: true, enum: [...AGENT_SESSION_SOURCE_KINDS], description: 'Agent session source kind' },
    session_id: { type: 'string', required: true, description: 'Stable agent session id' },
    events: { type: ['array', 'string'], required: true, description: 'Agent session events as an array or JSON array string' },
    client_name: { type: 'string', description: 'Client name such as codex or claude' },
    source_id: { type: 'string', description: 'Optional pre-registered source id' },
    repo_path: { type: 'string', nullable: true, description: 'Optional repository path' },
    workspace_id: { type: 'string', nullable: true, description: 'Optional workspace identifier' },
    write_mode: {
      type: 'string',
      description: 'Whether explicit personal signals may write directly after preflight',
      enum: ['candidate_only', 'direct_personal_when_allowed'],
      default: 'candidate_only',
    },
    apply: { type: 'boolean', description: mutating ? 'Apply governed writeback when true' : 'Ignored by preview operation' },
    now: { type: 'string', description: 'Optional ISO timestamp for deterministic tests' },
  };
}

function parseEvents(
  deps: { OperationError: OperationErrorCtor },
  value: unknown,
): AgentSessionEventInput[] {
  const parsed = typeof value === 'string' ? parseJson(deps, 'events', value) : value;
  if (!Array.isArray(parsed)) throw new deps.OperationError('invalid_params', 'events must be an array');
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new deps.OperationError('invalid_params', `events[${index}] must be an object`);
    }
    const event = entry as Record<string, unknown>;
    return {
      source_kind: typeof event.source_kind === 'string' ? event.source_kind as AgentSessionSourceKind : undefined,
      session_id: typeof event.session_id === 'string' ? event.session_id : undefined,
      event_kind: enumValue(deps, `events[${index}].event_kind`, event.event_kind, [
        'session_start',
        'user_prompt',
        'assistant_response',
        'tool_call',
        'tool_result',
        'tool_failure',
        'file_read',
        'file_write',
        'file_edit',
        'command_run',
        'search',
        'subagent_result',
        'session_stop',
        'explicit_memory_note',
      ] as const),
      text: stringValue(deps, `events[${index}].text`, event.text),
      event_id: optionalString(event.event_id),
      actor: optionalString(event.actor) as AgentSessionEventInput['actor'],
      client_name: optionalString(event.client_name),
      repo_path: nullableString(event.repo_path),
      workspace_id: nullableString(event.workspace_id),
      occurred_at: optionalString(event.occurred_at),
      metadata: objectValue(event.metadata),
    };
  });
}

function parseJson(deps: { OperationError: OperationErrorCtor }, field: string, value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new deps.OperationError('invalid_params', `${field} must be valid JSON`);
  }
}

function enumValue<T extends string>(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
  allowed: readonly T[],
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new deps.OperationError('invalid_params', `${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function stringValue(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new deps.OperationError('invalid_params', `${field} must be a non-empty string`);
  }
  return value.trim();
}

function writeMode(value: unknown): AgentSessionWriteMode {
  return value === 'direct_personal_when_allowed' ? 'direct_personal_when_allowed' : 'candidate_only';
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function nullableString(value: unknown): string | null {
  if (value == null) return null;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
```

- [ ] **Step 4: Register the operation module in `operations.ts`**

Add the import near the existing modular operation imports:

```ts
import { createAgentSessionMemoryOperations } from './operations-agent-session-memory.ts';
```

Add the factory near the other operation factories:

```ts
const agentSessionMemoryOperations = createAgentSessionMemoryOperations({
  OperationError,
});
```

Add the operations to the exported list after source registry operations:

```ts
// Agent session memory capture and writeback
...agentSessionMemoryOperations,
```

- [ ] **Step 5: Run operation tests**

Run: `bun test test/agent-session-memory-operations.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/operations-agent-session-memory.ts src/core/operations.ts test/agent-session-memory-operations.test.ts
git commit -m "feat: expose agent session memory operations"
```

## Task 9: Add SQLite End-To-End Capture Test

**Files:**
- Create: `test/agent-session-memory-sqlite.test.ts`

- [ ] **Step 1: Write failing SQLite integration tests**

```ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

async function withEngine<T>(run: (ctx: OperationContext, engine: SQLiteEngine) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-agent-session-memory-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    const ctx: OperationContext = {
      engine,
      config: { engine: 'sqlite', database_path: databasePath } as any,
      logger: console,
      dryRun: false,
    };
    return await run(ctx, engine);
  } finally {
    await engine.disconnect().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('agent session memory SQLite integration', () => {
  test('candidate-only capture creates a Memory Inbox candidate', async () => {
    await withEngine(async (ctx, engine) => {
      const result = await operationsByName.capture_agent_session_memory.handler(ctx, {
        source_kind: 'codex_session',
        session_id: 'session-candidate',
        events: [{
          event_kind: 'explicit_memory_note',
          actor: 'user',
          text: '기억해 주세요. 저는 구현 전에 짧은 플랜을 선호합니다.',
        }],
        write_mode: 'candidate_only',
        apply: true,
        now: '2026-06-03T01:00:00.000Z',
      }) as any;

      expect(result.applied).toBe(true);
      expect(result.routes[0].route.created_candidate).toBeDefined();
      const candidates = await engine.listMemoryCandidateEntries({
        scope_id: 'personal:default',
        target_object_type: 'profile_memory',
        limit: 10,
      });
      expect(candidates).toHaveLength(1);
      expect(candidates[0].proposed_content).toContain('짧은 플랜');
    });
  });

  test('direct personal write mode writes explicit profile memory after preflight', async () => {
    await withEngine(async (ctx, engine) => {
      const result = await operationsByName.capture_agent_session_memory.handler(ctx, {
        source_kind: 'codex_session',
        session_id: 'session-profile-direct',
        events: [{
          event_kind: 'explicit_memory_note',
          actor: 'user',
          text: '기억해 주세요. 저는 구현 전에 짧은 플랜을 선호합니다.',
        }],
        write_mode: 'direct_personal_when_allowed',
        apply: true,
        now: '2026-06-03T01:00:00.000Z',
      }) as any;

      expect(result.routes[0].direct_write.kind).toBe('profile_memory');
      const entries = await engine.listProfileMemoryEntries({
        scope_id: 'personal:default',
        subject: 'implementation planning',
        limit: 10,
      });
      expect(entries).toHaveLength(1);
      expect(entries[0].content).toContain('짧은 플랜');
    });
  });

  test('secret-bearing signals do not direct-write personal memory', async () => {
    await withEngine(async (ctx, engine) => {
      const result = await operationsByName.capture_agent_session_memory.handler(ctx, {
        source_kind: 'codex_session',
        session_id: 'session-secret',
        events: [{
          event_kind: 'explicit_memory_note',
          actor: 'user',
          text: '기억해 주세요. sk-testsecret1234567890 값은 비밀입니다.',
        }],
        write_mode: 'direct_personal_when_allowed',
        apply: true,
        now: '2026-06-03T01:00:00.000Z',
      }) as any;

      expect(result.capture.safety.secret_risk).toBe('flagged');
      expect(result.routes.some((route: any) => route.direct_write)).toBe(false);
      const entries = await engine.listProfileMemoryEntries({ scope_id: 'personal:default', limit: 10 });
      expect(entries).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run the failing SQLite tests**

Run: `bun test test/agent-session-memory-sqlite.test.ts`

Expected: FAIL until operation registration and direct-write integration are complete.

- [ ] **Step 3: Make the integration tests pass**

Run the focused tests from Tasks 3 through 8 and adjust only the agent session files when failures identify mismatched IDs, parser behavior, or personal-scope routing:

```bash
bun test \
  test/agent-session-memory-service.test.ts \
  test/agent-session-compression-service.test.ts \
  test/agent-session-classifier-service.test.ts \
  test/agent-session-writeback-service.test.ts \
  test/agent-session-memory-operations.test.ts \
  test/agent-session-memory-sqlite.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/agent-session-memory-sqlite.test.ts src/core
git commit -m "test: cover agent session memory capture on sqlite"
```

## Task 10: Documentation And Agent Instructions

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/MBRAIN_AGENT_RULES.md`
- Modify: `docs/MCP_INSTRUCTIONS.md`

- [ ] **Step 1: Update `AGENTS.md` key files**

Add these bullets under `## Key files`:

```md
- `src/core/operations-agent-session-memory.ts` — Agent/session memory preview and capture operations
- `src/core/services/agent-session-memory-service.ts` — Agent session normalization, source refs, and redacted capture planning
- `src/core/services/agent-session-compression-service.ts` — Zero-LLM agent session compression and bounded summaries
- `src/core/services/agent-session-classifier-service.ts` — MBrain-native profile/episode/procedure/task/no-write signal classification
- `src/core/services/agent-session-writeback-service.ts` — Governed Memory Inbox routing and preflighted direct personal writes for session signals
- `src/core/services/agent-session-activation-service.ts` — Authority-labelled activation artifacts for session-derived memory
- `src/core/source-registry/raw-ingest-store.ts` — SQL-backed raw ingest persistence helper for source items, chunks, redaction, and flags
```

- [ ] **Step 2: Update agent rules with the new operations**

In `docs/MBRAIN_AGENT_RULES.md`, add this compact rule after the writeback routing section:

```md
## Agent Session Memory

Use `preview_agent_session_memory` to inspect redaction, compression, classification, and route decisions before applying session-derived memory. Use `capture_agent_session_memory` with `apply: true` only when source refs are present and the route is acceptable. Keep `write_mode` as `candidate_only` unless the user made an explicit personal/profile statement and direct personal write preflight is expected to pass.
```

- [ ] **Step 3: Update MCP instructions if operation list is mentioned**

If `docs/MCP_INSTRUCTIONS.md` lists durable writeback tools, add:

```md
- `preview_agent_session_memory` / `capture_agent_session_memory` turn redacted Codex, Claude, or generic agent-session events into governed memory candidates or preflighted personal memory writes.
```

If the file contains only high-level behavior instructions and no operation list, add no new line.

- [ ] **Step 4: Run doc drift checks**

Run:

```bash
bun test test/agent-session-memory-operations.test.ts
git diff --check
```

Expected: PASS and no whitespace errors.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md docs/MBRAIN_AGENT_RULES.md docs/MCP_INSTRUCTIONS.md
git commit -m "docs: document agent session memory runtime"
```

## Task 11: Final Verification

**Files:**
- No new files.

- [ ] **Step 1: Run focused feature tests**

```bash
bun test \
  test/agent-session-memory-service.test.ts \
  test/agent-session-compression-service.test.ts \
  test/agent-session-classifier-service.test.ts \
  test/agent-session-writeback-service.test.ts \
  test/agent-session-memory-operations.test.ts \
  test/agent-session-memory-sqlite.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run adjacent memory tests**

```bash
bun test \
  test/source-registry-operations.test.ts \
  test/memory-writeback-router-service.test.ts \
  test/memory-writeback-router-operations.test.ts \
  test/profile-memory-operations.test.ts \
  test/personal-episode-operations.test.ts \
  test/memory-activation-policy-service.test.ts \
  test/scenario-memory-orchestration-operations.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run the unit suite**

```bash
bun test
```

Expected: PASS.

- [ ] **Step 4: Verify operations are exposed**

```bash
bun run src/cli.ts --tools-json | jq -r '.[].name' | rg 'preview_agent_session_memory|capture_agent_session_memory'
```

Expected output contains:

```text
preview_agent_session_memory
capture_agent_session_memory
```

- [ ] **Step 5: Check diff health**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors. `git status --short` should show only intentional files before the final commit.

- [ ] **Step 6: Commit verification-driven fixes**

If Steps 1-5 required small corrections, commit them:

```bash
git add src/core test AGENTS.md docs/MBRAIN_AGENT_RULES.md docs/MCP_INSTRUCTIONS.md
git commit -m "fix: stabilize agent session memory runtime"
```

If no corrections were required, do not create an empty commit.

## Acceptance Checklist

- [ ] Session events are normalized with source kind, session id, event id, actor, client, repo/workspace metadata, and timestamps.
- [ ] Redaction happens before compression and summary.
- [ ] Secret-bearing session text blocks direct personal writes.
- [ ] Zero-LLM compression produces bounded, source-backed observations.
- [ ] Session summaries include goals, outcomes, decisions, preferences, files, fixes, open questions, and follow-ups.
- [ ] Explicit user preferences can become direct profile memory only through personal write-target preflight.
- [ ] Session outcomes can become personal episodes only through personal write-target preflight.
- [ ] Inferred, ambiguous, compressed-only, contradictory, code-sensitive, and target-uncertain signals route to Memory Inbox candidates or defer/no-write.
- [ ] Pure task mechanics route to no-write.
- [ ] Activation artifacts preserve authority labels: profile memory, personal episode, Memory Inbox candidate, or derived orientation.
- [ ] Existing Memory Inbox, profile memory, personal episode, source registry, and activation tests still pass.
- [ ] No new schema is required.
- [ ] No live LLM call is required for tests.
