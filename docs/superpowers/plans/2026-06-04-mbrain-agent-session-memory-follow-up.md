# Agent Session Memory Follow-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the PR #134 agent-session memory foundation into a usable loop that can ingest real session payloads, activate session-derived memory in future requests, and feed review/maintenance without weakening mbrain's authority boundaries.

**Architecture:** Keep `preview_agent_session_memory` and `capture_agent_session_memory` as the capture/writeback boundary. Add deterministic adapter, activation, classifier, maintenance, and scenario-test layers that compose existing source registry, Memory Inbox, profile memory, personal episodes, task memory, retrieval traces, activation policy, duplicate review, and auto-promote surfaces. Do not add new storage schemas, search indexes, background daemons, or LLM requirements in this follow-up.

**Tech Stack:** Bun tests, TypeScript services in `src/core/services`, contract-first operations in `src/core/operations.ts`, existing `BrainEngine` APIs, existing CLI command loader in `src/cli.ts`, SQLite/PGLite/Postgres-compatible tests, GitHub CI.

---

## Current State

Implemented in PR #134:

- Source-backed agent-session capture plans.
- Redaction before compression.
- Deterministic zero-LLM event compression and bounded summaries.
- Conservative signal classification for profile memory, personal episodes, procedures, open questions, and no-write mechanics.
- Governed writeback through Memory Inbox candidates and preflighted direct personal writes.
- Activation artifact labeling for route results.
- Contract-first preview/capture operations.
- SQLite integration coverage for candidate-only, direct personal write, assistant-authored inferred preference, and secret-bearing paths.

Still missing from the full design:

- A normalized capture envelope that real Codex/Claude/session hooks can emit without hand-building operation parameters.
- A file/envelope capture command suitable for shell hooks and local smoke tests.
- Activation planning that selects profile memories, personal episodes, task memory, and candidates for a future session with authority labels and trace requirements.
- Classifier expansion for task continuation, project/system notes, contradiction/defer paths, and long-session summaries.
- Session-derived recurrence/review maintenance that uses existing candidate scoring, dedup, and auto-promote inputs without treating recurrence as truth.
- Replay/scenario coverage for the complete loop.
- PR/readiness documentation that matches the branch's actual verification state.

## File Structure

- Create `src/core/services/agent-session-capture-envelope-service.ts`
  - Normalize JSON/JSONL event envelopes into operation-ready `AgentSessionCaptureEnvelope` values.
- Create `test/agent-session-capture-envelope-service.test.ts`
  - Cover envelope parsing, JSONL parsing, default actor/source metadata, and secret-preserving input boundaries.
- Create `src/commands/agent-session.ts`
  - CLI-only command for `mbrain agent-session preview --file <json>` and `mbrain agent-session capture --file <json>`.
- Modify `src/cli.ts`
  - Register the `agent-session` direct engine command and CLI help spec.
- Create `test/agent-session-cli.test.ts`
  - Cover file-based preview/capture CLI behavior without relying on shell quoting large JSON event arrays.
- Create `src/core/services/agent-session-activation-planner-service.ts`
  - Select relevant profile memory, personal episodes, Memory Inbox candidates, and task memory for future session context.
- Create `test/agent-session-activation-planner-service.test.ts`
  - Cover authority labels, scope handling, candidate-only policy, and trace-required outputs.
- Create `src/core/operations-agent-session-activation.ts`
  - Expose `plan_agent_session_activation` through CLI/MCP.
- Modify `src/core/operations.ts`
  - Register activation operation and keep operation contract compact.
- Create `test/agent-session-activation-operations.test.ts`
  - Verify operation registration, parser behavior, and SQLite activation output.
- Modify `src/core/services/agent-session-classifier-service.ts`
  - Add deterministic task-memory, project-note, contradiction, and defer classifications.
- Modify `test/agent-session-classifier-service.test.ts`
  - Add coverage for the expanded classifications.
- Modify `src/core/services/agent-session-writeback-service.ts`
  - Ensure expanded signal kinds map to existing `route_memory_writeback` candidates or no-write/defer results.
- Modify `test/agent-session-writeback-service.test.ts`
  - Cover new route mappings and direct-write blocks.
- Create `src/core/services/agent-session-maintenance-service.ts`
  - Build a session-derived review backlog from existing Memory Inbox candidates and existing candidate scoring/dedup services.
- Create `test/agent-session-maintenance-service.test.ts`
  - Cover recurrence grouping, review priority, and non-authoritative recurrence semantics.
- Create `test/scenarios/s33-agent-session-memory-loop.test.ts`
  - Scenario coverage for capture -> route -> activate -> maintain boundaries.
- Modify `CLAUDE.md`
  - Add the new files and test files.
- Modify `docs/MBRAIN_AGENT_RULES.md`
  - Mention the envelope/file capture command only as a convenience wrapper around the governed operations.
- Modify `docs/superpowers/plans/2026-06-03-mbrain-agent-session-memory-runtime.md`
  - Correct the tools JSON verification command from `.tools[].name` to `.[].name`.
- Update PR #134 body with `gh pr edit 134 --body-file <file>` after final verification.

## Scope Boundaries

- Do not add a new BM25/vector/graph path.
- Do not add new database tables unless a task explicitly proves no existing table can represent the state.
- Do not make compressed observations canonical truth.
- Do not let direct personal writes happen for assistant-inferred, secret, work-scoped, contradictory, or target-uncertain signals.
- Do not require LLM credentials for default tests.
- Do not add always-on background capture. This follow-up adds a hook-friendly command and envelope contract; daemon scheduling remains a separate product decision.
- Do not auto-promote session-derived candidates directly. Maintenance may prepare eligible inputs for existing auto-promote, but promotion remains behind existing judge-only and deterministic gates.

## Task 1: Refresh Readiness Docs And PR Metadata

**Files:**
- Modify: `docs/superpowers/plans/2026-06-03-mbrain-agent-session-memory-runtime.md`
- Modify: `CLAUDE.md`
- Modify: `docs/MBRAIN_AGENT_RULES.md`
- External update: PR #134 body through `gh pr edit`

- [ ] **Step 1: Fix the stale tools JSON command in the previous plan**

In `docs/superpowers/plans/2026-06-03-mbrain-agent-session-memory-runtime.md`, replace:

```bash
bun run src/cli.ts --tools-json | jq -r '.tools[].name' | rg 'agent_session_memory|preview_agent_session_memory|capture_agent_session_memory'
```

with:

```bash
bun run src/cli.ts --tools-json | jq -r '.[].name' | rg 'preview_agent_session_memory|capture_agent_session_memory'
```

The current CLI emits a top-level array, not an object with a `tools` property.

- [ ] **Step 2: Run the corrected command**

Run:

```bash
bun run src/cli.ts --tools-json | jq -r '.[].name' | rg 'preview_agent_session_memory|capture_agent_session_memory'
```

Expected:

```text
preview_agent_session_memory
capture_agent_session_memory
```

- [ ] **Step 3: Add follow-up file references to `CLAUDE.md`**

Add these bullets under `## Key files` after the current agent-session bullets:

```md
- `src/core/services/agent-session-capture-envelope-service.ts` — Hook-friendly JSON/JSONL envelope normalization for session capture
- `src/core/services/agent-session-activation-planner-service.ts` — Authority-aware activation planning for future agent sessions
- `src/core/services/agent-session-maintenance-service.ts` — Session-derived candidate review and recurrence maintenance helpers
- `src/commands/agent-session.ts` — File-based preview/capture command for real session payloads
```

Add these test bullets under the unit test list sentence:

```md
Agent-session follow-up tests: `test/agent-session-capture-envelope-service.test.ts`, `test/agent-session-cli.test.ts`, `test/agent-session-activation-planner-service.test.ts`, `test/agent-session-activation-operations.test.ts`, `test/agent-session-maintenance-service.test.ts`, and `test/scenarios/s33-agent-session-memory-loop.test.ts`.
```

- [ ] **Step 4: Update agent rules with the file/envelope wrapper boundary**

In `docs/MBRAIN_AGENT_RULES.md`, extend the `Agent Session Memory` section to:

```md
Use `preview_agent_session_memory` before applying memory. Use
`capture_agent_session_memory` with `apply: true` only with source refs and an
acceptable route. Keep `write_mode: candidate_only` unless a
personal/profile statement should pass direct preflight. File/envelope capture
commands are convenience wrappers around the same governed operations; they do
not grant canonical write authority by themselves.
```

- [ ] **Step 5: Update PR #134 body after all implementation tasks pass**

Create `/tmp/mbrain-pr-134-body.md` with:

```md
## Summary

Adds the agent-session memory runtime foundation and follow-up loop pieces:

- source-backed session capture with redaction before compression
- deterministic zero-LLM compression and bounded session summaries
- conservative signal classification and governed writeback
- file/envelope capture path for real session payloads
- authority-aware activation planning for future sessions
- session-derived review/maintenance helpers
- SQLite and scenario coverage for capture, routing, activation, and maintenance boundaries

## Why

MBrain needs a personal-session memory path that can safely capture Codex/Claude/agent sessions without turning command noise, assistant inference, or secrets into durable truth. This branch composes source registry, Memory Inbox, profile memory, personal episodes, retrieval activation, and maintenance surfaces instead of creating a parallel memory system.

## Validation

- `bun test test/agent-session-*.test.ts test/scenarios/s33-agent-session-memory-loop.test.ts`
- `bun run typecheck`
- `bun test`
- disposable Postgres `bun run test:e2e`
- GitHub checks on PR #134

## Remaining Outside This PR

- Always-on daemon scheduling
- Broad personal-data connectors beyond agent/session payloads
- New BM25/vector/graph implementations
```

Then run:

```bash
gh pr edit 134 --body-file /tmp/mbrain-pr-134-body.md
```

- [ ] **Step 6: Commit documentation readiness changes**

Run:

```bash
git add CLAUDE.md docs/MBRAIN_AGENT_RULES.md docs/superpowers/plans/2026-06-03-mbrain-agent-session-memory-runtime.md
git commit -m "docs: refresh agent session memory follow-up readiness"
```

## Task 2: Add Capture Envelope Normalization

**Files:**
- Create: `src/core/services/agent-session-capture-envelope-service.ts`
- Modify: `src/core/types/agent-session-memory.ts`
- Test: `test/agent-session-capture-envelope-service.test.ts`

- [ ] **Step 1: Write the failing envelope tests**

Create `test/agent-session-capture-envelope-service.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import {
  normalizeAgentSessionCaptureEnvelope,
  parseAgentSessionEventJsonl,
} from '../src/core/services/agent-session-capture-envelope-service.ts';

describe('agent session capture envelope service', () => {
  test('normalizes a hook-friendly JSON envelope into operation params', () => {
    const result = normalizeAgentSessionCaptureEnvelope({
      source_kind: 'codex_session',
      session_id: 'session-followup-1',
      client_name: 'codex',
      repo_path: '/Users/meghendra/Work/mbrain',
      workspace_id: 'workspace:mbrain',
      captured_at: '2026-06-04T01:02:03.000Z',
      events: [{
        event_kind: 'explicit_memory_note',
        text: 'Remember that the user prefers concise implementation checkpoints.',
      }],
    });

    expect(result).toMatchObject({
      source_kind: 'codex_session',
      session_id: 'session-followup-1',
      client_name: 'codex',
      repo_path: '/Users/meghendra/Work/mbrain',
      workspace_id: 'workspace:mbrain',
      now: '2026-06-04T01:02:03.000Z',
    });
    expect(result.events).toEqual([expect.objectContaining({
      source_kind: 'codex_session',
      session_id: 'session-followup-1',
      client_name: 'codex',
      repo_path: '/Users/meghendra/Work/mbrain',
      workspace_id: 'workspace:mbrain',
      actor: 'user',
      event_kind: 'explicit_memory_note',
    })]);
  });

  test('parses JSONL event payloads with inherited session metadata', () => {
    const events = parseAgentSessionEventJsonl([
      JSON.stringify({ event_kind: 'user_prompt', text: 'Please continue the memory implementation.' }),
      JSON.stringify({ event_kind: 'command_run', text: 'bun test test/agent-session-memory-sqlite.test.ts' }),
    ].join('\n'), {
      source_kind: 'codex_session',
      session_id: 'session-jsonl-1',
      client_name: 'codex',
      repo_path: '/Users/meghendra/Work/mbrain',
      workspace_id: 'workspace:mbrain',
    });

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      event_kind: 'user_prompt',
      actor: 'user',
      source_kind: 'codex_session',
      session_id: 'session-jsonl-1',
    });
    expect(events[1]).toMatchObject({
      event_kind: 'command_run',
      actor: 'tool',
      source_kind: 'codex_session',
      session_id: 'session-jsonl-1',
    });
  });

  test('fails closed on invalid event kinds and non-object JSONL rows', () => {
    expect(() => normalizeAgentSessionCaptureEnvelope({
      source_kind: 'codex_session',
      session_id: 'bad-session',
      events: [{ event_kind: 'observer_note', text: 'bad' }],
    })).toThrow('event_kind');

    expect(() => parseAgentSessionEventJsonl('"not an object"', {
      source_kind: 'codex_session',
      session_id: 'bad-jsonl',
    })).toThrow('JSONL line 1 must be an object');
  });
});
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
bun test test/agent-session-capture-envelope-service.test.ts
```

Expected: FAIL because `agent-session-capture-envelope-service.ts` does not exist.

- [ ] **Step 3: Add envelope types**

Append these exports to `src/core/types/agent-session-memory.ts`:

```ts
export interface AgentSessionCaptureEnvelope {
  source_kind: AgentSessionSourceKind;
  session_id: string;
  client_name?: string;
  repo_path?: string | null;
  workspace_id?: string | null;
  captured_at?: string;
  events: AgentSessionEventInput[];
}

export interface AgentSessionCaptureOperationInput {
  source_kind: AgentSessionSourceKind;
  session_id: string;
  client_name?: string;
  repo_path?: string | null;
  workspace_id?: string | null;
  events: AgentSessionEventInput[];
  now?: string;
}
```

- [ ] **Step 4: Implement the envelope service**

Create `src/core/services/agent-session-capture-envelope-service.ts`:

```ts
import {
  AGENT_SESSION_EVENT_KINDS,
  AGENT_SESSION_SOURCE_KINDS,
  type AgentSessionActor,
  type AgentSessionCaptureEnvelope,
  type AgentSessionCaptureOperationInput,
  type AgentSessionEventInput,
  type AgentSessionEventKind,
  type AgentSessionSourceKind,
} from '../types.ts';

interface InheritedSessionMetadata {
  source_kind: AgentSessionSourceKind;
  session_id: string;
  client_name?: string;
  repo_path?: string | null;
  workspace_id?: string | null;
}

export function normalizeAgentSessionCaptureEnvelope(
  input: unknown,
): AgentSessionCaptureOperationInput {
  const envelope = requireRecord(input, 'capture envelope');
  const sourceKind = requireEnum(
    envelope.source_kind,
    'source_kind',
    AGENT_SESSION_SOURCE_KINDS,
  );
  const sessionId = requireNonEmptyString(envelope.session_id, 'session_id');
  const inherited: InheritedSessionMetadata = {
    source_kind: sourceKind,
    session_id: sessionId,
    client_name: optionalString(envelope.client_name, 'client_name'),
    repo_path: optionalNullableString(envelope.repo_path, 'repo_path'),
    workspace_id: optionalNullableString(envelope.workspace_id, 'workspace_id'),
  };
  const events = normalizeEvents(envelope.events, inherited);

  return {
    ...inherited,
    events,
    now: optionalString(envelope.captured_at, 'captured_at'),
  };
}

export function parseAgentSessionEventJsonl(
  text: string,
  inherited: InheritedSessionMetadata,
): AgentSessionEventInput[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`JSONL line ${index + 1} must be valid JSON`);
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`JSONL line ${index + 1} must be an object`);
      }
      return normalizeEvent(parsed as Record<string, unknown>, inherited, index);
    });
}

function normalizeEvents(
  value: unknown,
  inherited: InheritedSessionMetadata,
): AgentSessionEventInput[] {
  if (!Array.isArray(value)) {
    throw new Error('events must be an array');
  }
  return value.map((event, index) => {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      throw new Error(`events[${index}] must be an object`);
    }
    return normalizeEvent(event as Record<string, unknown>, inherited, index);
  });
}

function normalizeEvent(
  event: Record<string, unknown>,
  inherited: InheritedSessionMetadata,
  index: number,
): AgentSessionEventInput {
  const eventKind = requireEnum(
    event.event_kind,
    `events[${index}].event_kind`,
    AGENT_SESSION_EVENT_KINDS,
  );
  const text = requireNonEmptyString(event.text, `events[${index}].text`);
  const sourceKind = optionalEnum(
    event.source_kind,
    `events[${index}].source_kind`,
    AGENT_SESSION_SOURCE_KINDS,
  ) ?? inherited.source_kind;
  const sessionId = optionalString(event.session_id, `events[${index}].session_id`) ?? inherited.session_id;
  if (sourceKind !== inherited.source_kind) {
    throw new Error(`events[${index}].source_kind must match envelope source_kind`);
  }
  if (sessionId !== inherited.session_id) {
    throw new Error(`events[${index}].session_id must match envelope session_id`);
  }

  return {
    source_kind: sourceKind,
    session_id: sessionId,
    event_kind: eventKind,
    text,
    event_id: optionalString(event.event_id, `events[${index}].event_id`),
    actor: optionalActor(event.actor, `events[${index}].actor`) ?? defaultActor(eventKind),
    client_name: optionalString(event.client_name, `events[${index}].client_name`) ?? inherited.client_name,
    repo_path: optionalNullableString(event.repo_path, `events[${index}].repo_path`) ?? inherited.repo_path ?? null,
    workspace_id: optionalNullableString(event.workspace_id, `events[${index}].workspace_id`) ?? inherited.workspace_id ?? null,
    occurred_at: optionalString(event.occurred_at, `events[${index}].occurred_at`),
    metadata: optionalRecord(event.metadata, `events[${index}].metadata`),
  };
}

function defaultActor(kind: AgentSessionEventKind): AgentSessionActor {
  if (kind === 'user_prompt' || kind === 'explicit_memory_note') return 'user';
  if (kind === 'assistant_response' || kind === 'subagent_result') return 'assistant';
  if (
    kind === 'tool_call'
    || kind === 'tool_result'
    || kind === 'tool_failure'
    || kind === 'file_read'
    || kind === 'file_write'
    || kind === 'file_edit'
    || kind === 'command_run'
    || kind === 'search'
  ) return 'tool';
  return 'system';
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalNullableString(value: unknown, label: string): string | null | undefined {
  if (value === null) return null;
  return optionalString(value, label);
}

function optionalRecord(value: unknown, label: string): Record<string, unknown> {
  if (value == null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireEnum<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): T {
  const parsed = optionalEnum(value, label, allowed);
  if (!parsed) throw new Error(`${label} must be one of: ${allowed.join(', ')}`);
  return parsed;
}

function optionalEnum<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): T | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${label} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function optionalActor(value: unknown, label: string): AgentSessionActor | undefined {
  return optionalEnum(value, label, ['user', 'assistant', 'tool', 'subagent', 'system'] as const);
}
```

- [ ] **Step 5: Run the envelope tests**

Run:

```bash
bun test test/agent-session-capture-envelope-service.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/core/types/agent-session-memory.ts src/core/services/agent-session-capture-envelope-service.ts test/agent-session-capture-envelope-service.test.ts
git commit -m "feat: normalize agent session capture envelopes"
```

## Task 3: Add File-Based Agent Session CLI

**Files:**
- Create: `src/commands/agent-session.ts`
- Modify: `src/cli.ts`
- Test: `test/agent-session-cli.test.ts`

- [ ] **Step 1: Write the failing CLI tests**

Create `test/agent-session-cli.test.ts`:

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-agent-session-cli-'));
  tempDirs.push(dir);
  const envelopePath = join(dir, 'session.json');
  writeFileSync(envelopePath, JSON.stringify({
    source_kind: 'codex_session',
    session_id: 'session-cli-file',
    client_name: 'codex',
    captured_at: '2026-06-04T01:02:03.000Z',
    events: [{
      event_kind: 'explicit_memory_note',
      text: 'Remember that the user prefers concise implementation checkpoints.',
    }],
  }));
  return { dir, envelopePath };
}

describe('agent-session CLI command', () => {
  test('preview reads a JSON envelope file and prints non-mutating pipeline output', async () => {
    const { envelopePath } = tempFixture();
    const proc = Bun.spawn([
      'bun',
      'run',
      'src/cli.ts',
      'agent-session',
      'preview',
      '--file',
      envelopePath,
      '--json',
    ], { stdout: 'pipe', stderr: 'pipe' });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(stderr).toBe('');
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.applied).toBe(false);
    expect(result.signals[0].signal_kind).toBe('profile_memory');
  });

  test('capture requires --apply for mutating file capture', async () => {
    const { envelopePath } = tempFixture();
    const proc = Bun.spawn([
      'bun',
      'run',
      'src/cli.ts',
      'agent-session',
      'capture',
      '--file',
      envelopePath,
      '--json',
    ], { stdout: 'pipe', stderr: 'pipe' });
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    expect(exitCode).toBe(1);
    expect(stderr).toContain('agent-session capture requires --apply or --dry-run');
  });
});
```

- [ ] **Step 2: Run the failing CLI tests**

Run:

```bash
bun test test/agent-session-cli.test.ts
```

Expected: FAIL because `agent-session` is not registered.

- [ ] **Step 3: Implement the command**

Create `src/commands/agent-session.ts`:

```ts
import { readFileSync } from 'fs';
import type { BrainEngine } from '../core/engine.ts';
import {
  type OperationContext,
  operationsByName,
} from '../core/operations.ts';
import { normalizeAgentSessionCaptureEnvelope } from '../core/services/agent-session-capture-envelope-service.ts';

export async function runAgentSession(engine: BrainEngine, args: string[]) {
  const [mode, ...rest] = args;
  if (mode !== 'preview' && mode !== 'capture') {
    printUsageAndExit(1);
  }

  const parsed = parseArgs(rest);
  if (!parsed.file) {
    console.error('agent-session requires --file <path>');
    process.exit(1);
  }
  if (mode === 'capture' && parsed.apply !== true && parsed.dry_run !== true) {
    console.error('agent-session capture requires --apply or --dry-run');
    process.exit(1);
  }

  const envelope = JSON.parse(readFileSync(parsed.file, 'utf8'));
  const operationInput = normalizeAgentSessionCaptureEnvelope(envelope);
  const ctx: OperationContext = {
    engine,
    config: {} as OperationContext['config'],
    logger: console,
    dryRun: parsed.dry_run,
  };
  const op = mode === 'preview'
    ? operationsByName.preview_agent_session_memory
    : operationsByName.capture_agent_session_memory;
  const result = await op.handler(ctx, {
    ...operationInput,
    write_mode: parsed.write_mode ?? 'candidate_only',
    apply: parsed.apply,
  });

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${mode} complete\n`);
    process.stdout.write(`applied: ${(result as any).applied === true}\n`);
    process.stdout.write(`signals: ${Array.isArray((result as any).signals) ? (result as any).signals.length : 0}\n`);
  }
}

function parseArgs(args: string[]) {
  const parsed: {
    file?: string;
    json: boolean;
    apply: boolean;
    dry_run: boolean;
    write_mode?: string;
  } = {
    json: false,
    apply: false,
    dry_run: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--file') parsed.file = args[++index];
    else if (arg === '--json') parsed.json = true;
    else if (arg === '--apply') parsed.apply = true;
    else if (arg === '--dry-run') parsed.dry_run = true;
    else if (arg === '--write-mode') parsed.write_mode = args[++index];
    else {
      console.error(`Unknown agent-session flag: ${arg}`);
      process.exit(1);
    }
  }
  return parsed;
}

function printUsageAndExit(code: number): never {
  console.error([
    'Usage:',
    '  mbrain agent-session preview --file session.json [--json]',
    '  mbrain agent-session capture --file session.json (--apply|--dry-run) [--write-mode candidate_only|direct_personal_when_allowed] [--json]',
  ].join('\n'));
  process.exit(code);
}
```

- [ ] **Step 4: Register the command in `src/cli.ts`**

Add a CLI spec near the other CLI-only specs:

```ts
const AGENT_SESSION_CLI_SPEC: Operation = {
  name: 'agent_session',
  description: 'Preview or capture a JSON agent-session envelope file through governed memory operations.',
  params: {
    file: { type: 'string', description: 'Path to a JSON capture envelope' },
    json: { type: 'boolean', description: 'Emit JSON output' },
    apply: { type: 'boolean', description: 'Apply governed writeback for capture mode' },
    dry_run: { type: 'boolean', description: 'Preview capture mode without mutation' },
    write_mode: { type: 'string', description: 'candidate_only or direct_personal_when_allowed' },
  },
  handler: noopHandler,
  cliHints: { name: 'agent-session' },
};
```

Add to `CLI_ONLY_SPECS`:

```ts
'agent-session': AGENT_SESSION_CLI_SPEC,
```

Add to `DIRECT_ENGINE_COMMANDS`:

```ts
'agent-session': async () => (await import('./commands/agent-session.ts')).runAgentSession,
```

- [ ] **Step 5: Run CLI tests**

Run:

```bash
bun test test/agent-session-cli.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/commands/agent-session.ts src/cli.ts test/agent-session-cli.test.ts
git commit -m "feat: add file-based agent session capture command"
```

## Task 4: Add Agent Session Activation Planner

**Files:**
- Create: `src/core/services/agent-session-activation-planner-service.ts`
- Create: `src/core/operations-agent-session-activation.ts`
- Modify: `src/core/operations.ts`
- Test: `test/agent-session-activation-planner-service.test.ts`
- Test: `test/agent-session-activation-operations.test.ts`

- [ ] **Step 1: Write the failing service tests**

Create `test/agent-session-activation-planner-service.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { planAgentSessionActivation } from '../src/core/services/agent-session-activation-planner-service.ts';

async function withEngine<T>(run: (engine: SQLiteEngine) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-agent-session-activation-'));
  const engine = new SQLiteEngine();
  try {
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();
    return await run(engine);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('agent session activation planner', () => {
  test('selects profile memory and candidates with authority labels', async () => {
    await withEngine(async (engine) => {
      await engine.upsertProfileMemoryEntry({
        id: 'profile-memory:planning',
        scope_id: 'personal:default',
        profile_type: 'preference',
        subject: 'implementation planning',
        content: 'The user prefers concise implementation checkpoints.',
        sensitivity: 'personal',
        source_refs: ['source_item:profile', 'source_chunk:profile-1'],
        confidence: 0.9,
        last_confirmed_at: new Date('2026-06-04T01:00:00.000Z'),
        supersedes: [],
        export_status: 'private_only',
      });
      await engine.createMemoryCandidateEntry({
        id: 'candidate:planning-review',
        scope_id: 'personal:default',
        candidate_type: 'profile_update',
        target_object_type: 'profile_memory',
        target_object_id: null,
        proposed_content: 'The user may prefer short PR review summaries.',
        source_refs: ['source_item:candidate', 'source_chunk:candidate-1'],
        extraction_kind: 'inferred',
        sensitivity: 'personal',
        confidence_score: 0.7,
        importance_score: 0.6,
        recurrence_score: 0.2,
        generated_by: 'agent',
        status: 'candidate',
      });

      const plan = await planAgentSessionActivation(engine, {
        query: 'continue implementation planning work',
        requested_scope: 'personal',
        scenario: 'personal_recall',
        limit: 5,
      });

      expect(plan.artifacts).toEqual(expect.arrayContaining([
        expect.objectContaining({
          artifact_kind: 'profile_memory',
          id: 'profile-memory:planning',
          scope_policy: 'allow',
        }),
        expect.objectContaining({
          artifact_kind: 'memory_candidate',
          id: 'memory-candidate:candidate:planning-review',
          scope_policy: 'allow',
        }),
      ]));
      expect(plan.policy.decisions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          artifact_id: 'profile-memory:planning',
          decision: 'answer_ground',
          authority: 'profile_memory',
        }),
        expect.objectContaining({
          artifact_id: 'memory-candidate:candidate:planning-review',
          decision: 'candidate_only',
          authority: 'unreviewed_candidate',
        }),
      ]));
      expect(plan.policy.trace_required).toBe(true);
    });
  });
});
```

- [ ] **Step 2: Run the failing service test**

Run:

```bash
bun test test/agent-session-activation-planner-service.test.ts
```

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement the activation planner**

Create `src/core/services/agent-session-activation-planner-service.ts`:

```ts
import type { BrainEngine } from '../engine.ts';
import type {
  MemoryActivationArtifact,
  MemoryActivationPolicyResult,
  MemoryScenario,
  MemoryScenarioScopeDecision,
} from '../types.ts';
import { selectActivationPolicy } from './memory-activation-policy-service.ts';

type AgentSessionActivationRequestedScope = Exclude<MemoryScenarioScopeDecision, 'defer'>;

export interface AgentSessionActivationPlanInput {
  query: string;
  requested_scope?: AgentSessionActivationRequestedScope;
  scenario?: MemoryScenario;
  task_id?: string;
  limit?: number;
}

export interface AgentSessionActivationPlan {
  scenario: MemoryScenario;
  artifacts: MemoryActivationArtifact[];
  policy: MemoryActivationPolicyResult;
  warnings: string[];
}

export async function planAgentSessionActivation(
  engine: BrainEngine,
  input: AgentSessionActivationPlanInput,
): Promise<AgentSessionActivationPlan> {
  const limit = Math.max(1, Math.min(input.limit ?? 8, 20));
  const scenario = input.scenario ?? (input.requested_scope === 'personal' ? 'personal_recall' : 'coding_continuation');
  const artifacts = [
    ...await profileArtifacts(engine, input.query, limit),
    ...await episodeArtifacts(engine, input.query, limit),
    ...await candidateArtifacts(engine, input.query, input.requested_scope, limit),
    ...await taskArtifacts(engine, input.task_id),
  ].slice(0, limit);
  const policy = selectActivationPolicy({ scenario, artifacts });

  return {
    scenario,
    artifacts,
    policy,
    warnings: policy.stale_warnings,
  };
}

async function profileArtifacts(
  engine: BrainEngine,
  query: string,
  limit: number,
): Promise<MemoryActivationArtifact[]> {
  const entries = await engine.listProfileMemoryEntries({
    scope_id: 'personal:default',
    limit,
    offset: 0,
  });
  return entries
    .filter((entry) => entry.superseded_by == null)
    .filter((entry) => matchesQuery(query, [entry.subject, entry.content]))
    .map((entry) => ({
      id: normalizeId('profile-memory', entry.id),
      artifact_kind: 'profile_memory',
      source_ref: entry.source_refs[0],
      scope_policy: 'allow',
    }));
}

async function episodeArtifacts(
  engine: BrainEngine,
  query: string,
  limit: number,
): Promise<MemoryActivationArtifact[]> {
  const entries = await engine.listPersonalEpisodeEntries({
    scope_id: 'personal:default',
    limit,
    offset: 0,
  });
  return entries
    .filter((entry) => matchesQuery(query, [entry.title, entry.summary]))
    .map((entry) => ({
      id: normalizeId('personal-episode', entry.id),
      artifact_kind: 'personal_episode',
      source_ref: entry.source_refs[0],
      scope_policy: 'allow',
    }));
}

async function candidateArtifacts(
  engine: BrainEngine,
  query: string,
  requestedScope: AgentSessionActivationRequestedScope | undefined,
  limit: number,
): Promise<MemoryActivationArtifact[]> {
  const entries = await engine.listMemoryCandidateEntries({
    scope_id: requestedScope === 'personal' ? 'personal:default' : undefined,
    limit,
    offset: 0,
  });
  return entries
    .filter((entry) => entry.status === 'candidate' || entry.status === 'staged_for_review')
    .filter((entry) => matchesQuery(query, [entry.proposed_content, entry.target_object_type]))
    .map((entry) => ({
      id: normalizeId('memory-candidate', entry.id),
      artifact_kind: 'memory_candidate',
      source_ref: entry.source_refs[0],
      scope_policy: entry.scope_id.startsWith('personal:') ? 'allow' : undefined,
    }));
}

async function taskArtifacts(
  engine: BrainEngine,
  taskId: string | undefined,
): Promise<MemoryActivationArtifact[]> {
  if (!taskId) return [];
  const workingSet = await engine.getTaskWorkingSet(taskId);
  if (!workingSet) return [];
  return workingSet.decisions.slice(0, 5).map((decision) => ({
    id: `task-decision:${decision.id}`,
    artifact_kind: 'task_decision',
    source_ref: decision.source_refs[0],
  }));
}

function matchesQuery(query: string, values: readonly (string | null | undefined)[]): boolean {
  const normalizedQuery = tokenize(query);
  if (normalizedQuery.length === 0) return true;
  const haystack = values
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  return normalizedQuery.some((token) => haystack.includes(token));
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9가-힣_/-]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function normalizeId(prefix: string, id: string): string {
  return id.startsWith(`${prefix}:`) ? id : `${prefix}:${id}`;
}
```

- [ ] **Step 4: Add operation tests**

Create `test/agent-session-activation-operations.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { operationsByName } from '../src/core/operations.ts';

describe('agent session activation operation', () => {
  test('plan_agent_session_activation is registered as a read operation', () => {
    const op = operationsByName.plan_agent_session_activation;
    expect(op).toBeDefined();
    expect(op.mutating).toBe(false);
    expect(op.cliHints?.name).toBe('agent-session-activate');
  });
});
```

- [ ] **Step 5: Implement and register the operation**

Create `src/core/operations-agent-session-activation.ts`:

```ts
import type { Operation } from './operations.ts';
import { planAgentSessionActivation } from './services/agent-session-activation-planner-service.ts';

export function createAgentSessionActivationOperations(): Operation[] {
  return [{
    name: 'plan_agent_session_activation',
    description: 'Plan authority-aware activation for future agent sessions using profile, episode, task, and candidate memory.',
    params: {
      query: { type: 'string', required: true, description: 'Future-session request or continuation prompt' },
      requested_scope: { type: 'string', description: 'personal, work, or mixed', enum: ['personal', 'work', 'mixed'] },
      scenario: { type: 'string', description: 'Optional memory scenario', enum: ['coding_continuation', 'project_qa', 'knowledge_qa', 'auto_accumulation', 'personal_recall', 'mixed'] },
      task_id: { type: 'string', description: 'Optional active task id' },
      limit: { type: 'number', description: 'Maximum artifacts to return' },
    },
    mutating: false,
    handler: async (ctx, params) => planAgentSessionActivation(ctx.engine, {
      query: requireString(params.query, 'query'),
      requested_scope: optionalEnum(params.requested_scope, ['personal', 'work', 'mixed'] as const),
      scenario: optionalEnum(params.scenario, ['coding_continuation', 'project_qa', 'knowledge_qa', 'auto_accumulation', 'personal_recall', 'mixed'] as const),
      task_id: optionalString(params.task_id),
      limit: typeof params.limit === 'number' ? params.limit : undefined,
    }),
    cliHints: { name: 'agent-session-activate', positional: ['query'], aliases: { n: 'limit', scope: 'requested_scope' } },
  }];
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (value == null) return undefined;
  return allowed.includes(value as T) ? value as T : undefined;
}
```

Modify `src/core/operations.ts`:

```ts
import { createAgentSessionActivationOperations } from './operations-agent-session-activation.ts';
```

Add near the agent session memory operation factory:

```ts
const agentSessionActivationOperations = createAgentSessionActivationOperations();
```

Add to the exported operations list after `...agentSessionMemoryOperations`:

```ts
...agentSessionActivationOperations,
```

- [ ] **Step 6: Run activation tests**

Run:

```bash
bun test test/agent-session-activation-planner-service.test.ts test/agent-session-activation-operations.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

Run:

```bash
git add src/core/services/agent-session-activation-planner-service.ts src/core/operations-agent-session-activation.ts src/core/operations.ts test/agent-session-activation-planner-service.test.ts test/agent-session-activation-operations.test.ts
git commit -m "feat: plan agent session memory activation"
```

## Task 5: Expand Classification And Routing

**Files:**
- Modify: `src/core/services/agent-session-classifier-service.ts`
- Modify: `src/core/services/agent-session-writeback-service.ts`
- Test: `test/agent-session-classifier-service.test.ts`
- Test: `test/agent-session-writeback-service.test.ts`

- [ ] **Step 1: Add classifier tests for remaining signal families**

Append to `test/agent-session-classifier-service.test.ts`:

```ts
test('classifies follow-up session stop text as task memory', () => {
  const observation = buildObservation({
    event_kind: 'session_stop',
    observation_type: 'session_summary',
    actor: 'system',
    narrative: 'Follow-up: run the activation planner tests before merging.',
    facts: ['Follow-up: run the activation planner tests before merging.'],
  });

  const signals = classifyAgentSessionMemorySignals({
    observations: [observation],
    summary: buildSummary({
      outcome: 'Follow-up: run the activation planner tests before merging.',
      follow_ups: ['run the activation planner tests before merging'],
    }),
  });

  expect(signals).toEqual(expect.arrayContaining([
    expect.objectContaining({
      signal_kind: 'task_memory',
      candidate_type: 'rationale',
      target_object_type: 'other',
      evidence_kind: 'source_extracted',
    }),
  ]));
});

test('classifies repo-scoped decisions as project notes', () => {
  const observation = buildObservation({
    event_kind: 'assistant_response',
    actor: 'assistant',
    sensitivity: 'work',
    scope_id: 'workspace:default',
    narrative: 'Decision: keep agent session memory deterministic in src/core/services/agent-session-compression-service.ts.',
    facts: ['Decision: keep agent session memory deterministic in src/core/services/agent-session-compression-service.ts.'],
  });

  const signals = classifyAgentSessionMemorySignals({
    observations: [observation],
    summary: buildSummary(),
  });

  expect(signals).toEqual(expect.arrayContaining([
    expect.objectContaining({
      signal_kind: 'project_note',
      candidate_type: 'note_update',
      target_object_type: 'curated_note',
      evidence_kind: 'source_extracted',
      scope_id: 'workspace:default',
    }),
  ]));
});

test('classifies correction language as contradiction review candidate', () => {
  const observation = buildObservation({
    event_kind: 'user_prompt',
    actor: 'user',
    narrative: 'Correction: the prior memory about automatic capture being complete is wrong.',
    facts: ['Correction: the prior memory about automatic capture being complete is wrong.'],
  });

  const signals = classifyAgentSessionMemorySignals({
    observations: [observation],
    summary: buildSummary(),
  });

  expect(signals).toEqual(expect.arrayContaining([
    expect.objectContaining({
      signal_kind: 'project_note',
      evidence_kind: 'contradicts_existing',
      candidate_type: 'note_update',
      target_object_type: 'curated_note',
    }),
  ]));
});
```

- [ ] **Step 2: Run the failing classifier tests**

Run:

```bash
bun test test/agent-session-classifier-service.test.ts --test-name-pattern 'task memory|project notes|contradiction'
```

Expected: FAIL because these signal families are not emitted yet.

- [ ] **Step 3: Implement deterministic classification helpers**

In `src/core/services/agent-session-classifier-service.ts`, add checks after the procedure check and before open-question handling:

```ts
    if (isTaskMemorySignal(observation, text)) {
      signals.push(taskMemorySignal(observation, text));
      continue;
    }
    if (isProjectNoteSignal(text)) {
      signals.push(projectNoteSignal(observation, text));
      continue;
    }
    if (isContradictionSignal(text)) {
      signals.push(projectNoteSignal(observation, text, 'contradicts_existing'));
      continue;
    }
```

Add helper functions:

```ts
function taskMemorySignal(observation: AgentSessionCompressedObservation, text: string): AgentSessionMemorySignal {
  const content = firstSentence(text, 260);
  return {
    id: signalId('task_memory', observation.id, content),
    source_observation_id: observation.id,
    content,
    evidence_kind: 'source_extracted',
    signal_kind: 'task_memory',
    candidate_type: 'rationale',
    target_object_type: 'other',
    target_object_id: null,
    scope_id: observation.scope_id,
    sensitivity: observation.sensitivity,
    confidence_score: observation.confidence_score,
    importance_score: Math.max(observation.importance_score, 0.65),
    recurrence_score: 0,
    source_refs: observation.source_refs,
    scenario_source_kind: 'session_end',
  };
}

function projectNoteSignal(
  observation: AgentSessionCompressedObservation,
  text: string,
  evidenceKind: AgentSessionMemorySignal['evidence_kind'] = 'source_extracted',
): AgentSessionMemorySignal {
  const content = firstSentence(text, 280);
  return {
    id: signalId('project_note', observation.id, content),
    source_observation_id: observation.id,
    content,
    evidence_kind: evidenceKind,
    signal_kind: 'project_note',
    candidate_type: 'note_update',
    target_object_type: 'curated_note',
    target_object_id: null,
    scope_id: observation.scope_id.startsWith('personal:') ? 'workspace:default' : observation.scope_id,
    sensitivity: observation.sensitivity === 'personal' ? 'work' : observation.sensitivity,
    confidence_score: observation.confidence_score,
    importance_score: Math.max(observation.importance_score, 0.65),
    recurrence_score: 0,
    source_refs: observation.source_refs,
    scenario_source_kind: 'code_event',
  };
}

function isTaskMemorySignal(observation: AgentSessionCompressedObservation, text: string): boolean {
  return observation.event_kind === 'session_stop'
    && /follow[- ]?up|next step|blocked|unresolved|후속|다음|미해결|막힘/i.test(text);
}

function isProjectNoteSignal(text: string): boolean {
  return /decision|decided|architecture|src\/|test\/|docs\/|system|repo|결정|구조|시스템/i.test(text)
    && !isExplicitPreference(text);
}

function isContradictionSignal(text: string): boolean {
  return /correction|correcting|actually|contradict|wrong|수정|정정|아니라/i.test(text);
}
```

Put `isContradictionSignal` before `isProjectNoteSignal` in the main classifier so correction language is not swallowed by the project-note route.

- [ ] **Step 4: Add writeback mapping tests**

Append to `test/agent-session-writeback-service.test.ts`:

```ts
test('expanded task and project signals route to governed candidates only', async () => {
  await withSQLiteEngine(async (engine) => {
    const taskSignal = makeSignal({
      id: 'agent-session-signal:task-memory',
      signal_kind: 'task_memory',
      candidate_type: 'rationale',
      target_object_type: 'other',
      content: 'Follow-up: run activation tests.',
      evidence_kind: 'source_extracted',
      scope_id: 'workspace:default',
      sensitivity: 'work',
    });
    const projectSignal = makeSignal({
      id: 'agent-session-signal:project-note',
      signal_kind: 'project_note',
      candidate_type: 'note_update',
      target_object_type: 'curated_note',
      content: 'Decision: keep session compression deterministic.',
      evidence_kind: 'source_extracted',
      scope_id: 'workspace:default',
      sensitivity: 'work',
    });

    const results = await routeAgentSessionMemorySignals(engine, {
      signals: [taskSignal, projectSignal],
      apply: true,
      write_mode: 'direct_personal_when_allowed',
    });

    expect(results.every((result) => result.direct_write === null)).toBe(true);
    expect(results.map((result) => result.route?.decision)).toEqual(['create_candidate', 'create_candidate']);
    const candidates = await engine.listMemoryCandidateEntries({ scope_id: 'workspace:default', limit: 10 });
    expect(candidates).toHaveLength(2);
  });
});
```

- [ ] **Step 5: Run classifier and writeback tests**

Run:

```bash
bun test test/agent-session-classifier-service.test.ts test/agent-session-writeback-service.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add src/core/services/agent-session-classifier-service.ts src/core/services/agent-session-writeback-service.ts test/agent-session-classifier-service.test.ts test/agent-session-writeback-service.test.ts
git commit -m "feat: expand agent session signal routing"
```

## Task 6: Add Session-Derived Maintenance Review

**Files:**
- Create: `src/core/services/agent-session-maintenance-service.ts`
- Test: `test/agent-session-maintenance-service.test.ts`

- [ ] **Step 1: Write failing maintenance tests**

Create `test/agent-session-maintenance-service.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { MemoryCandidateEntry } from '../src/core/types.ts';
import { buildAgentSessionMaintenanceReview } from '../src/core/services/agent-session-maintenance-service.ts';

function candidate(input: Partial<MemoryCandidateEntry> & { id: string; proposed_content: string }): MemoryCandidateEntry {
  const now = new Date('2026-06-04T01:00:00.000Z');
  return {
    id: input.id,
    scope_id: input.scope_id ?? 'personal:default',
    candidate_type: input.candidate_type ?? 'profile_update',
    target_object_type: input.target_object_type ?? 'profile_memory',
    target_object_id: input.target_object_id ?? null,
    proposed_content: input.proposed_content,
    source_refs: input.source_refs ?? ['source_item:1', 'source_chunk:1'],
    extraction_kind: input.extraction_kind ?? 'inferred',
    sensitivity: input.sensitivity ?? 'personal',
    confidence_score: input.confidence_score ?? 0.7,
    importance_score: input.importance_score ?? 0.7,
    recurrence_score: input.recurrence_score ?? 0,
    generated_by: input.generated_by ?? 'agent',
    status: input.status ?? 'candidate',
    created_at: input.created_at ?? now,
    updated_at: input.updated_at ?? now,
    metadata_json: input.metadata_json ?? {},
  };
}

describe('agent session maintenance review', () => {
  test('groups repeated session candidates without turning recurrence into truth', () => {
    const review = buildAgentSessionMaintenanceReview([
      candidate({
        id: 'candidate:1',
        proposed_content: 'The user prefers concise implementation checkpoints.',
        recurrence_score: 0.2,
      }),
      candidate({
        id: 'candidate:2',
        proposed_content: 'The user prefers concise implementation checkpoints.',
        recurrence_score: 0.4,
      }),
    ]);

    expect(review.groups).toHaveLength(1);
    expect(review.groups[0]).toMatchObject({
      grouped_candidate_ids: ['candidate:1', 'candidate:2'],
      duplicate_count: 2,
      total_recurrence_score: 0.6,
    });
    expect(review.authority_warning).toBe('recurrence_increases_review_priority_not_truth');
    expect(review.auto_promote_handoff_candidates).toHaveLength(0);
  });

  test('marks low-risk source-backed extracted candidates as auto-promote handoff inputs', () => {
    const review = buildAgentSessionMaintenanceReview([
      candidate({
        id: 'candidate:eligible',
        proposed_content: 'Decision: keep agent session compression deterministic.',
        candidate_type: 'note_update',
        target_object_type: 'curated_note',
        scope_id: 'workspace:default',
        sensitivity: 'work',
        extraction_kind: 'extracted',
        confidence_score: 0.95,
        importance_score: 0.8,
        recurrence_score: 0.2,
      }),
    ]);

    expect(review.auto_promote_handoff_candidates).toEqual(['candidate:eligible']);
  });
});
```

- [ ] **Step 2: Run the failing maintenance test**

Run:

```bash
bun test test/agent-session-maintenance-service.test.ts
```

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement maintenance review service**

Create `src/core/services/agent-session-maintenance-service.ts`:

```ts
import type { MemoryCandidateEntry } from '../types.ts';
import {
  buildMemoryCandidateReviewBacklog,
  type MemoryCandidateReviewBacklogGroup,
} from './memory-candidate-dedup-service.ts';

export interface AgentSessionMaintenanceReview {
  groups: MemoryCandidateReviewBacklogGroup[];
  auto_promote_handoff_candidates: string[];
  authority_warning: 'recurrence_increases_review_priority_not_truth';
}

export function buildAgentSessionMaintenanceReview(
  candidates: readonly MemoryCandidateEntry[],
): AgentSessionMaintenanceReview {
  const active = candidates.filter((candidate) =>
    candidate.status === 'candidate' || candidate.status === 'staged_for_review');
  const groups = buildMemoryCandidateReviewBacklog(active);

  return {
    groups,
    auto_promote_handoff_candidates: active
      .filter(isLowRiskAutoPromoteInput)
      .map((candidate) => candidate.id),
    authority_warning: 'recurrence_increases_review_priority_not_truth',
  };
}

function isLowRiskAutoPromoteInput(candidate: MemoryCandidateEntry): boolean {
  return candidate.extraction_kind === 'extracted'
    && candidate.sensitivity !== 'secret'
    && candidate.sensitivity !== 'unknown'
    && candidate.confidence_score >= 0.9
    && candidate.source_refs.filter((ref) => ref.trim().length > 0).length >= 2
    && candidate.status === 'candidate';
}
```

- [ ] **Step 4: Run maintenance tests**

Run:

```bash
bun test test/agent-session-maintenance-service.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/core/services/agent-session-maintenance-service.ts test/agent-session-maintenance-service.test.ts
git commit -m "feat: review agent session memory maintenance"
```

## Task 7: Add End-To-End Scenario Coverage

**Files:**
- Create: `test/scenarios/s33-agent-session-memory-loop.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write scenario tests**

Create `test/scenarios/s33-agent-session-memory-loop.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { planAgentSessionActivation } from '../../src/core/services/agent-session-activation-planner-service.ts';
import { buildAgentSessionMaintenanceReview } from '../../src/core/services/agent-session-maintenance-service.ts';
import { allocateSqliteBrain } from './helpers.ts';

function opContext(engine: OperationContext['engine']): OperationContext {
  return {
    engine,
    config: {} as OperationContext['config'],
    logger: console,
    dryRun: false,
  };
}

describe('S33 - agent session memory loop', () => {
  test('captures explicit preference, activates profile memory, and keeps candidates non-authoritative', async () => {
    const handle = await allocateSqliteBrain('s33-preference');
    try {
      const ctx = opContext(handle.engine);

      const capture = await operationsByName.capture_agent_session_memory.handler(ctx, {
        source_kind: 'codex_session',
        session_id: 's33-session',
        client_name: 'codex',
        events: [{
          event_kind: 'explicit_memory_note',
          text: 'Remember that the user prefers concise implementation checkpoints.',
        }],
        write_mode: 'direct_personal_when_allowed',
        apply: true,
        now: '2026-06-04T01:00:00.000Z',
      }) as any;

      expect(capture.routes[0].direct_write?.kind).toBe('profile_memory');

      const activation = await planAgentSessionActivation(handle.engine, {
        query: 'implementation checkpoints',
        requested_scope: 'personal',
        scenario: 'personal_recall',
        limit: 5,
      });

      expect(activation.policy.decisions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          decision: 'answer_ground',
          authority: 'profile_memory',
        }),
      ]));
    } finally {
      await handle.teardown();
    }
  });

  test('session-derived inferred candidates enter maintenance without truth promotion', async () => {
    const handle = await allocateSqliteBrain('s33-inferred');
    try {
      const ctx = opContext(handle.engine);

      await operationsByName.capture_agent_session_memory.handler(ctx, {
        source_kind: 'codex_session',
        session_id: 's33-inferred-session',
        events: [{
          event_kind: 'assistant_response',
          actor: 'assistant',
          text: 'The user prefers concise implementation checkpoints.',
        }],
        write_mode: 'direct_personal_when_allowed',
        apply: true,
      });

      const candidates = await handle.engine.listMemoryCandidateEntries({
        scope_id: 'personal:default',
        limit: 10,
      });
      const review = buildAgentSessionMaintenanceReview(candidates);

      expect(candidates).toHaveLength(1);
      expect(review.authority_warning).toBe('recurrence_increases_review_priority_not_truth');
      expect(review.auto_promote_handoff_candidates).toHaveLength(0);
    } finally {
      await handle.teardown();
    }
  });
});
```

Use `allocateSqliteBrain` from `test/scenarios/helpers.ts`; it is the existing scenario helper that creates an isolated SQLite brain and returns a teardown handle.

- [ ] **Step 2: Run the scenario test**

Run:

```bash
bun test test/scenarios/s33-agent-session-memory-loop.test.ts
```

Expected: PASS.

- [ ] **Step 3: Add README scenario table row**

Find the scenario contract table in `README.md` and add:

```md
| S33 | Agent session memory loop | Session capture, governed writeback, activation policy, and maintenance review keep source-backed personal memory useful without making candidates truth. |
```

- [ ] **Step 4: Run scenario and README guard**

Run:

```bash
bun test test/scenarios/s33-agent-session-memory-loop.test.ts
rg -n "S33" README.md test/scenarios/s33-agent-session-memory-loop.test.ts
```

Expected: both files contain `S33`.

- [ ] **Step 5: Commit**

Run:

```bash
git add test/scenarios/s33-agent-session-memory-loop.test.ts README.md
git commit -m "test: cover agent session memory loop"
```

## Task 8: Final Verification And CI

**Files:**
- No source files unless verification finds a bug.

- [ ] **Step 1: Run focused follow-up tests**

Run:

```bash
bun test \
  test/agent-session-capture-envelope-service.test.ts \
  test/agent-session-cli.test.ts \
  test/agent-session-activation-planner-service.test.ts \
  test/agent-session-activation-operations.test.ts \
  test/agent-session-classifier-service.test.ts \
  test/agent-session-writeback-service.test.ts \
  test/agent-session-maintenance-service.test.ts \
  test/scenarios/s33-agent-session-memory-loop.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run existing agent-session tests**

Run:

```bash
bun test test/agent-session-*.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 4: Run full unit suite**

Run:

```bash
bun test
```

Expected: PASS.

- [ ] **Step 5: Run Postgres E2E lifecycle**

Use the repository's E2E DB lifecycle. If `.env.testing` is absent, use a free local port and this URL:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5435/mbrain_test
```

Run:

```bash
docker run -d --name mbrain-test-pg \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=mbrain_test \
  -p 5435:5432 pgvector/pgvector:pg16
docker exec mbrain-test-pg pg_isready -U postgres
source ~/.zshrc 2>/dev/null || true
DATABASE_URL=postgresql://postgres:postgres@localhost:5435/mbrain_test bun run test:e2e
docker stop mbrain-test-pg && docker rm mbrain-test-pg
```

Expected: PASS. If `OPENAI_API_KEY` is absent after sourcing `~/.zshrc`, Tier 2 may skip; record that explicitly in the final summary.

- [ ] **Step 6: Verify exposed operations and CLI command**

Run:

```bash
bun run src/cli.ts --tools-json | jq -r '.[].name' | rg 'preview_agent_session_memory|capture_agent_session_memory|plan_agent_session_activation'
bun run src/cli.ts agent-session --help
```

Expected:

```text
preview_agent_session_memory
capture_agent_session_memory
plan_agent_session_activation
```

and `agent-session` help text prints usage.

- [ ] **Step 7: Check diff health**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors and only intentional files if any remain unstaged.

- [ ] **Step 8: Commit verification fixes if needed**

If verification required fixes:

```bash
git add <fixed-files>
git commit -m "fix: harden agent session memory follow-up"
```

- [ ] **Step 9: Push and wait for PR CI**

Run:

```bash
git push origin feature/agent-session-memory-runtime
gh pr checks 134 --watch --interval 10
```

Expected: all required checks pass. `Tier 2 (LLM Skills)` may be skipped according to CI configuration.

## Self-Review Checklist

- Capture remains source-backed; no new ungoverned memory store is introduced.
- Redaction remains before compression and before any runner or activation surface.
- Candidates and derived artifacts remain non-authoritative.
- Direct personal writes still require explicit personal signals and preflight.
- Activation uses existing profile, episode, task, candidate, and activation policy surfaces.
- Recurrence and maintenance increase review priority only; they do not convert truth authority.
- Auto-promote handoff only supplies eligible candidate ids to existing gates.
- No task requires live LLM credentials for default verification.
- Every new operation is visible through `--tools-json`.
- Every new file is documented in `CLAUDE.md`.
