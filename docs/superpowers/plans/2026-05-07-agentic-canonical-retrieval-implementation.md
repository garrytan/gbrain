# Agentic Canonical Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an agent-facing `retrieve_context -> read_context` retrieval loop so agents discover candidates cheaply, then read bounded canonical evidence before answering.

**Architecture:** This is an additive service layer above the existing scenario planner, precision lookup, search, note-section, scope-gate, and context-map services. `retrieve_context` returns route, scope, grouped candidates, answerability, and required canonical selectors; `read_context` consumes selectors and returns bounded canonical evidence with answer-ready state and continuation handles. Existing `search`, `query`, `get_page`, and context-map operations stay available as lower-level tools.

**Tech Stack:** Bun, TypeScript, existing `Operation` registry, SQLite test engine, existing note-manifest/note-section indexes, existing scope-gate and retrieval-route services, `bun test`.

---

## Scope Boundaries

- Implement two new non-mutating operations: `retrieve_context` and `read_context`.
- Keep existing `search` and `query` behavior compatible, while changing descriptions and skills to classify them as candidate-discovery tools.
- Do not add database tables in this phase.
- Do not replace `get_page`; keep it as the explicit full-page read escape hatch.
- Do not make context maps authoritative. They only populate orientation, derived consultations, and recommended canonical reads.
- Do not bypass existing personal/mixed-scope gates.
- Do not implement final answer generation inside MBrain.
- Do not make managed Postgres the only supported engine. All tests in this plan run on SQLite.

## File Structure

### Production Files

- Modify: `src/core/types.ts`
  - Add selector, candidate, answerability, `retrieve_context`, and `read_context` result types near existing retrieval/scenario types.
- Create: `src/core/services/retrieval-selector-service.ts`
  - Normalize selectors, create stable selector ids, parse page-path fragments, and convert route/read records into selectors.
- Create: `src/core/services/read-context-service.ts`
  - Read bounded canonical evidence from pages, compiled truth, sections, line spans, timeline entries, task memory, profile memory, and personal episodes.
- Create: `src/core/services/retrieve-context-service.ts`
  - Run scope/scenario planning, exact selector handling, candidate discovery, grouping, derived orientation, and required-read planning.
- Modify: `src/core/operations.ts`
  - Import the new services.
  - Add enum constants and parsers for selectors/read modes.
  - Register `retrieve_context` and `read_context`.
  - Add compact CLI formatters for the two results.
- Modify: `skills/query/SKILL.md`
  - Make `retrieve_context -> read_context -> answer` the normal agent flow.
  - State that chunks are candidate pointers, not answer evidence.
- Modify: `docs/MCP_INSTRUCTIONS.md`
  - Update documentation-only layering notes without increasing runtime `MCP_INSTRUCTIONS`.
- Modify: `test/scenarios/README.md`
  - Add the new transcript scenarios to the scenario catalog.

### Test Files

- Create: `test/retrieval-selector-service.test.ts`
- Create: `test/read-context-service.test.ts`
- Create: `test/retrieve-context-service.test.ts`
- Create: `test/retrieve-context-operations.test.ts`
- Create: `test/read-context-operations.test.ts`
- Create: `test/scenarios/s22-agentic-canonical-retrieval.test.ts`
- Modify: `test/mcp-instructions.test.ts`

### Verification Commands

- `bun test test/retrieval-selector-service.test.ts`
- `bun test test/read-context-service.test.ts`
- `bun test test/retrieve-context-service.test.ts`
- `bun test test/retrieve-context-operations.test.ts`
- `bun test test/read-context-operations.test.ts`
- `bun test test/scenarios/s22-agentic-canonical-retrieval.test.ts`
- `bun test test/mcp-instructions.test.ts test/e2e/skills.test.ts`
- `bun test test/retrieval-request-planner-service.test.ts test/retrieval-route-selector-service.test.ts test/broad-synthesis-route-service.test.ts test/precision-lookup-route-service.test.ts test/scenarios/s09-curated-over-map.test.ts test/scenarios/s14-retrieval-trace-fidelity.test.ts test/scenarios/s22-agentic-canonical-retrieval.test.ts`
- `bun run test:scenarios`

---

## Task 1: Add Retrieval Selector Types And Helpers

**Files:**
- Modify: `src/core/types.ts`
- Create: `src/core/services/retrieval-selector-service.ts`
- Test: `test/retrieval-selector-service.test.ts`

- [ ] **Step 1: Write selector service tests**

Create `test/retrieval-selector-service.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import {
  normalizeRetrievalSelector,
  parseAnchoredRetrievalPath,
  retrievalSelectorId,
  selectorFromRouteRead,
  selectorFromSearchResult,
} from '../src/core/services/retrieval-selector-service.ts';
import type { SearchResult } from '../src/core/types.ts';

describe('retrieval selector service', () => {
  test('normalizes page selectors with default scope and stable id', () => {
    const selector = normalizeRetrievalSelector({
      kind: 'page',
      slug: 'systems/mbrain',
    });

    expect(selector.scope_id).toBe('workspace:default');
    expect(selector.selector_id).toBe('page:workspace:default:systems/mbrain');
    expect(selector.slug).toBe('systems/mbrain');
  });

  test('normalizes section selectors and preserves line metadata', () => {
    const selector = normalizeRetrievalSelector({
      kind: 'section',
      scope_id: 'workspace:default',
      slug: 'systems/mbrain',
      section_id: 'systems/mbrain#overview/runtime',
      path: 'systems/mbrain.md#overview/runtime',
      line_start: 8,
      line_end: 12,
      source_refs: ['User, direct message, 2026-05-07 09:00 KST'],
    });

    expect(selector.selector_id).toBe('section:workspace:default:systems/mbrain#overview/runtime');
    expect(selector.line_start).toBe(8);
    expect(selector.line_end).toBe(12);
    expect(selector.source_refs).toEqual(['User, direct message, 2026-05-07 09:00 KST']);
  });

  test('rejects selectors that do not identify a target', () => {
    expect(() => normalizeRetrievalSelector({
      kind: 'section',
      slug: 'systems/mbrain',
    })).toThrow('section selector requires section_id');

    expect(() => normalizeRetrievalSelector({
      kind: 'page',
    })).toThrow('page selector requires slug');
  });

  test('parses anchored page paths into page path and heading path', () => {
    expect(parseAnchoredRetrievalPath('systems/mbrain.md#overview/runtime')).toEqual({
      page_path: 'systems/mbrain.md',
      fragment: 'overview/runtime',
    });

    expect(parseAnchoredRetrievalPath('systems/mbrain.md')).toBeNull();
  });

  test('converts route reads to canonical selectors', () => {
    const selector = selectorFromRouteRead({
      node_id: 'section:systems/mbrain#overview/runtime',
      node_kind: 'section',
      label: 'Runtime',
      page_slug: 'systems/mbrain',
      path: 'systems/mbrain.md',
      section_id: 'systems/mbrain#overview/runtime',
    });

    expect(selector.kind).toBe('section');
    expect(selector.slug).toBe('systems/mbrain');
    expect(selector.section_id).toBe('systems/mbrain#overview/runtime');
  });

  test('converts search results into compiled-truth or timeline selectors', () => {
    const result: SearchResult = {
      slug: 'concepts/retrieval',
      page_id: 10,
      title: 'Retrieval',
      type: 'concept',
      chunk_text: 'Retrieval chunks are candidates.',
      chunk_source: 'compiled_truth',
      score: 2.5,
      stale: false,
    };

    const selector = selectorFromSearchResult(result);

    expect(selector.kind).toBe('compiled_truth');
    expect(selector.slug).toBe('concepts/retrieval');
    expect(selectorSelectorId(selector)).toBe('compiled_truth:workspace:default:concepts/retrieval');
  });
});

function selectorSelectorId(selector: Parameters<typeof retrievalSelectorId>[0]): string {
  return retrievalSelectorId(selector);
}
```

- [ ] **Step 2: Run selector tests to verify failure**

Run:

```bash
bun test test/retrieval-selector-service.test.ts
```

Expected: FAIL because `retrieval-selector-service.ts` and selector types do not exist.

- [ ] **Step 3: Add selector and retrieval contract types**

In `src/core/types.ts`, insert this block after `ScenarioMemoryRequestPlan` and before `RetrievalRouteSelectorResult`:

```ts
export type RetrievalSelectorKind =
  | 'page'
  | 'compiled_truth'
  | 'section'
  | 'line_span'
  | 'timeline_entry'
  | 'timeline_range'
  | 'source_ref'
  | 'task_working_set'
  | 'task_attempt'
  | 'task_decision'
  | 'profile_memory'
  | 'personal_episode';

export type RetrievalFreshness = 'current' | 'stale' | 'unknown';
export type ProbeAnswerKind = 'mention_existence' | 'slug_disambiguation' | 'none';
export type ContextReadMode = 'explicit' | 'auto';
export type ContextTimelineMode = 'auto' | 'include' | 'exclude';

export interface RetrievalSelector {
  selector_id?: string;
  kind: RetrievalSelectorKind;
  scope_id?: string;
  slug?: string;
  path?: string;
  section_id?: string;
  line_start?: number;
  line_end?: number;
  source_ref?: string;
  object_id?: string;
  source_refs?: string[];
  content_hash?: string;
  freshness?: RetrievalFreshness;
}

export interface RetrievalCanonicalTarget {
  kind: RetrievalSelectorKind;
  slug?: string;
  title?: string;
  type?: PageType;
  path?: string;
  section_id?: string;
  scope_id?: string;
}

export interface RetrievalMatchedChunk {
  slug: string;
  page_id: number;
  title: string;
  type: PageType;
  chunk_text: string;
  chunk_source: ChunkSource;
  score: number;
  stale: boolean;
}

export interface RetrieveContextCandidate {
  candidate_id: string;
  canonical_target: RetrievalCanonicalTarget;
  matched_chunks: RetrievalMatchedChunk[];
  why_matched: string[];
  activation: MemoryActivationDecision;
  read_priority: number;
  read_selector: RetrievalSelector;
}

export interface RetrieveContextAnswerability {
  answerable_from_probe: boolean;
  allowed_probe_answer_kind: ProbeAnswerKind;
  must_read_context: boolean;
  reason_codes: string[];
}

export interface RetrieveContextOrientation {
  derived_consulted: string[];
  recommended_reads: RetrievalSelector[];
  summary_lines: string[];
}

export interface RetrieveContextInput extends MemoryScenarioClassifierInput {
  selectors?: RetrievalSelector[];
  limit?: number;
  token_budget?: number;
  include_orientation?: boolean;
  persist_trace?: boolean;
}

export interface RetrieveContextResult {
  request_id: string;
  scenario: MemoryScenario;
  scope_gate?: ScopeGateDecisionResult;
  route: RetrievalRouteSelectorResult | null;
  answerability: RetrieveContextAnswerability;
  candidates: RetrieveContextCandidate[];
  required_reads: RetrievalSelector[];
  orientation: RetrieveContextOrientation;
  warnings: string[];
  trace?: RetrievalTrace | null;
}

export interface ContextAnswerReady {
  ready: boolean;
  answer_ground: RetrievalSelector[];
  unsupported_reasons: string[];
  citation_policy: string;
}

export interface CanonicalContextRead {
  selector: RetrievalSelector;
  authority: MemoryArtifactAuthority;
  title: string;
  text: string;
  source_refs: string[];
  token_estimate: number;
  has_more: boolean;
  continuation_selector?: RetrievalSelector;
}

export interface ContextEvidenceClaim {
  selector_id: string;
  claim_kind: 'compiled_truth' | 'timeline_evidence' | 'task_state' | 'profile_memory' | 'personal_episode';
  source_refs: string[];
}

export interface ContextConflict {
  selector_id: string;
  summary: string;
  source_refs: string[];
}

export interface ReadContextInput {
  query?: string;
  selectors?: RetrievalSelector[];
  reads?: ContextReadMode;
  token_budget?: number;
  max_selectors?: number;
  include_timeline?: ContextTimelineMode;
  include_source_refs?: boolean;
  persist_trace?: boolean;
  task_id?: string | null;
}

export interface ReadContextResult {
  answer_ready: ContextAnswerReady;
  canonical_reads: CanonicalContextRead[];
  evidence_claims: ContextEvidenceClaim[];
  conflicts: ContextConflict[];
  warnings: string[];
  unread_required: RetrievalSelector[];
  continuations: RetrievalSelector[];
  trace?: RetrievalTrace | null;
}
```

- [ ] **Step 4: Create selector helper service**

Create `src/core/services/retrieval-selector-service.ts`:

```ts
import type {
  BroadSynthesisRouteRead,
  RetrievalSelector,
  RetrievalSelectorKind,
  SearchResult,
} from '../types.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from './note-manifest-service.ts';

export function normalizeRetrievalSelector(
  selector: RetrievalSelector,
  defaults: { scope_id?: string } = {},
): RetrievalSelector {
  const scopeId = selector.scope_id ?? defaults.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID;
  const normalized: RetrievalSelector = {
    ...selector,
    scope_id: scopeId,
    source_refs: selector.source_refs ?? [],
    freshness: selector.freshness ?? 'unknown',
  };

  assertSelectorTarget(normalized);
  normalized.selector_id = selector.selector_id ?? retrievalSelectorId(normalized);
  return normalized;
}

export function retrievalSelectorId(selector: RetrievalSelector): string {
  const scopeId = selector.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID;
  switch (selector.kind) {
    case 'page':
    case 'compiled_truth':
      return `${selector.kind}:${scopeId}:${requireValue(selector.slug, `${selector.kind} selector requires slug`)}`;
    case 'section':
      return `section:${scopeId}:${requireValue(selector.section_id, 'section selector requires section_id')}`;
    case 'line_span':
      return [
        'line_span',
        scopeId,
        requireValue(selector.slug, 'line_span selector requires slug'),
        String(requireNumber(selector.line_start, 'line_span selector requires line_start')),
        String(requireNumber(selector.line_end, 'line_span selector requires line_end')),
      ].join(':');
    case 'timeline_entry':
    case 'task_attempt':
    case 'task_decision':
    case 'profile_memory':
    case 'personal_episode':
      return `${selector.kind}:${scopeId}:${requireValue(selector.object_id, `${selector.kind} selector requires object_id`)}`;
    case 'timeline_range':
      return `${selector.kind}:${scopeId}:${requireValue(selector.slug, 'timeline_range selector requires slug')}`;
    case 'source_ref':
      return `${selector.kind}:${scopeId}:${requireValue(selector.source_ref, 'source_ref selector requires source_ref')}`;
  }
}

export function selectorFromRouteRead(read: BroadSynthesisRouteRead): RetrievalSelector {
  return normalizeRetrievalSelector({
    kind: read.node_kind === 'section' ? 'section' : 'page',
    scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
    slug: read.page_slug,
    path: read.path,
    section_id: read.section_id,
    freshness: 'unknown',
  });
}

export function selectorFromSearchResult(result: SearchResult): RetrievalSelector {
  const kind: RetrievalSelectorKind = result.chunk_source === 'timeline'
    ? 'timeline_range'
    : result.chunk_source === 'compiled_truth'
      ? 'compiled_truth'
      : 'page';
  return normalizeRetrievalSelector({
    kind,
    slug: result.slug,
    freshness: result.stale ? 'stale' : 'current',
  });
}

export function parseAnchoredRetrievalPath(path: string): { page_path: string; fragment: string } | null {
  const separatorIndex = path.indexOf('#');
  if (separatorIndex === -1) return null;
  const pagePath = path.slice(0, separatorIndex).trim();
  const fragment = path.slice(separatorIndex + 1).replace(/^\/+|\/+$/g, '');
  if (!pagePath || !fragment) return null;
  return { page_path: pagePath, fragment };
}

function assertSelectorTarget(selector: RetrievalSelector): void {
  switch (selector.kind) {
    case 'page':
    case 'compiled_truth':
      requireValue(selector.slug, `${selector.kind} selector requires slug`);
      return;
    case 'section':
      requireValue(selector.section_id, 'section selector requires section_id');
      return;
    case 'line_span':
      requireValue(selector.slug, 'line_span selector requires slug');
      requireNumber(selector.line_start, 'line_span selector requires line_start');
      requireNumber(selector.line_end, 'line_span selector requires line_end');
      return;
    case 'timeline_range':
      requireValue(selector.slug, 'timeline_range selector requires slug');
      return;
    case 'source_ref':
      requireValue(selector.source_ref, 'source_ref selector requires source_ref');
      return;
    case 'timeline_entry':
    case 'task_attempt':
    case 'task_decision':
    case 'profile_memory':
    case 'personal_episode':
      requireValue(selector.object_id, `${selector.kind} selector requires object_id`);
      return;
  }
}

function requireValue(value: string | undefined, message: string): string {
  if (!value || value.trim().length === 0) {
    throw new Error(message);
  }
  return value;
}

function requireNumber(value: number | undefined, message: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(message);
  }
  return value;
}
```

- [ ] **Step 5: Run selector tests and commit**

Run:

```bash
bun test test/retrieval-selector-service.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/core/types.ts src/core/services/retrieval-selector-service.ts test/retrieval-selector-service.test.ts
git commit -m "feat: add retrieval selector contract"
```

---

## Task 2: Implement Bounded Canonical Reads

**Files:**
- Create: `src/core/services/read-context-service.ts`
- Test: `test/read-context-service.test.ts`

- [ ] **Step 1: Write `read_context` service tests**

Create `test/read-context-service.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { readContext } from '../src/core/services/read-context-service.ts';

async function withEngine<T>(label: string, fn: (engine: SQLiteEngine) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), `mbrain-read-context-${label}-`));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    return await fn(engine);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('read context service', () => {
  test('reads compiled truth as answer-grounding canonical evidence', async () => {
    await withEngine('compiled', async (engine) => {
      await importFromContent(engine, 'concepts/retrieval', [
        '---',
        'type: concept',
        'title: Retrieval',
        '---',
        '# Compiled Truth',
        'Retrieval chunks are candidate pointers, not answer evidence.',
        '[Source: User, direct message, 2026-05-07 09:00 KST]',
        '',
        '---',
        '',
        '- **2026-05-07** | The user clarified that token budget must stay bounded.',
      ].join('\n'), { path: 'concepts/retrieval.md' });

      const result = await readContext(engine, {
        selectors: [{ kind: 'compiled_truth', slug: 'concepts/retrieval' }],
        token_budget: 400,
      });

      expect(result.answer_ready.ready).toBe(true);
      expect(result.canonical_reads).toHaveLength(1);
      expect(result.canonical_reads[0]!.authority).toBe('canonical_compiled_truth');
      expect(result.canonical_reads[0]!.text).toContain('candidate pointers');
      expect(result.canonical_reads[0]!.source_refs).toContain('User, direct message, 2026-05-07 09:00 KST');
      expect(result.unread_required).toEqual([]);
    });
  });

  test('reads a canonical section instead of the whole page for narrow selectors', async () => {
    await withEngine('section', async (engine) => {
      await importFromContent(engine, 'systems/mbrain', [
        '---',
        'type: system',
        'title: MBrain',
        '---',
        '# Overview',
        'Top-level overview.',
        '',
        '## Runtime',
        'Runtime owns exact retrieval routing.',
        '[Source: User, direct message, 2026-05-07 09:01 KST]',
        '',
        '## Storage',
        'Storage owns canonical persistence.',
      ].join('\n'), { path: 'systems/mbrain.md' });

      const [, runtime] = await engine.listNoteSectionEntries({
        scope_id: 'workspace:default',
        page_slug: 'systems/mbrain',
        limit: 10,
      });
      if (!runtime) throw new Error('runtime section fixture missing');

      const result = await readContext(engine, {
        selectors: [{ kind: 'section', section_id: runtime.section_id }],
        token_budget: 200,
      });

      expect(result.answer_ready.ready).toBe(true);
      expect(result.canonical_reads[0]!.title).toBe('Runtime');
      expect(result.canonical_reads[0]!.text).toContain('Runtime owns exact retrieval routing.');
      expect(result.canonical_reads[0]!.text).not.toContain('Storage owns canonical persistence.');
    });
  });

  test('returns continuation selectors when a canonical read exceeds budget', async () => {
    await withEngine('budget', async (engine) => {
      await importFromContent(engine, 'concepts/large-context', [
        '---',
        'type: concept',
        'title: Large Context',
        '---',
        '# Compiled Truth',
        'Alpha '.repeat(200),
        '[Source: User, direct message, 2026-05-07 09:02 KST]',
      ].join('\n'), { path: 'concepts/large-context.md' });

      const result = await readContext(engine, {
        selectors: [{ kind: 'compiled_truth', slug: 'concepts/large-context' }],
        token_budget: 40,
      });

      expect(result.canonical_reads[0]!.has_more).toBe(true);
      expect(result.continuations).toHaveLength(1);
      expect(result.continuations[0]!.kind).toBe('line_span');
      expect(result.answer_ready.ready).toBe(true);
    });
  });

  test('reads task working set before raw project context for continuation', async () => {
    await withEngine('task', async (engine) => {
      await engine.createTaskThread({
        id: 'task-read-context',
        scope: 'work',
        title: 'Task Read Context',
        status: 'active',
        repo_path: '/repo/mbrain',
        branch_name: 'feature/context',
        current_summary: 'Continue retrieval implementation.',
      });
      await engine.upsertTaskWorkingSet({
        task_id: 'task-read-context',
        active_paths: ['src/core/operations.ts'],
        active_symbols: ['readContext'],
        blockers: [],
        open_questions: ['How should continuation selectors work?'],
        next_steps: ['Read task state first.'],
        verification_notes: ['Run focused tests.'],
      });

      const result = await readContext(engine, {
        selectors: [{ kind: 'task_working_set', object_id: 'task-read-context' }],
      });

      expect(result.answer_ready.ready).toBe(true);
      expect(result.canonical_reads[0]!.authority).toBe('operational_memory');
      expect(result.canonical_reads[0]!.text).toContain('src/core/operations.ts');
      expect(result.canonical_reads[0]!.text).toContain('Read task state first.');
    });
  });

  test('reports unread selectors when canonical targets are missing', async () => {
    await withEngine('missing', async (engine) => {
      const result = await readContext(engine, {
        selectors: [{ kind: 'compiled_truth', slug: 'concepts/missing' }],
      });

      expect(result.answer_ready.ready).toBe(false);
      expect(result.unread_required).toHaveLength(1);
      expect(result.warnings).toContain('Selector could not be read: compiled_truth:workspace:default:concepts/missing');
    });
  });
});
```

- [ ] **Step 2: Run read-context tests to verify failure**

Run:

```bash
bun test test/read-context-service.test.ts
```

Expected: FAIL because `read-context-service.ts` does not exist.

- [ ] **Step 3: Implement read-context service**

Create `src/core/services/read-context-service.ts`:

```ts
import type { BrainEngine } from '../engine.ts';
import type {
  CanonicalContextRead,
  ContextAnswerReady,
  ContextEvidenceClaim,
  MemoryArtifactAuthority,
  ReadContextInput,
  ReadContextResult,
  RetrievalSelector,
} from '../types.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from './note-manifest-service.ts';
import { listAllNoteSectionEntries } from './structural-entry-pagination.ts';
import { normalizeRetrievalSelector, retrievalSelectorId } from './retrieval-selector-service.ts';

const DEFAULT_TOKEN_BUDGET = 900;
const DEFAULT_MAX_SELECTORS = 3;
const CHARS_PER_TOKEN_ESTIMATE = 4;

export async function readContext(
  engine: BrainEngine,
  input: ReadContextInput,
): Promise<ReadContextResult> {
  const selectors = (input.selectors ?? [])
    .slice(0, input.max_selectors ?? DEFAULT_MAX_SELECTORS)
    .map((selector) => normalizeRetrievalSelector(selector));
  const tokenBudget = input.token_budget ?? DEFAULT_TOKEN_BUDGET;
  const reads: CanonicalContextRead[] = [];
  const unreadRequired: RetrievalSelector[] = [];
  const warnings: string[] = [];
  const continuations: RetrievalSelector[] = [];
  let remainingBudget = tokenBudget;

  for (const selector of selectors) {
    if (remainingBudget <= 0) {
      unreadRequired.push(selector);
      warnings.push(`Token budget exhausted before reading: ${retrievalSelectorId(selector)}`);
      continue;
    }

    const read = await readSelector(engine, selector, {
      token_budget: remainingBudget,
      include_timeline: input.include_timeline ?? 'auto',
      include_source_refs: input.include_source_refs !== false,
    });

    if (!read) {
      unreadRequired.push(selector);
      warnings.push(`Selector could not be read: ${retrievalSelectorId(selector)}`);
      continue;
    }

    remainingBudget -= read.token_estimate;
    reads.push(read);
    if (read.continuation_selector) {
      continuations.push(read.continuation_selector);
    }
  }

  return {
    answer_ready: buildAnswerReady(reads, unreadRequired, warnings),
    canonical_reads: reads,
    evidence_claims: reads.map(buildEvidenceClaim),
    conflicts: [],
    warnings,
    unread_required: unreadRequired,
    continuations,
  };
}

async function readSelector(
  engine: BrainEngine,
  selector: RetrievalSelector,
  options: { token_budget: number; include_timeline: 'auto' | 'include' | 'exclude'; include_source_refs: boolean },
): Promise<CanonicalContextRead | null> {
  switch (selector.kind) {
    case 'page':
      return readPage(engine, selector, options, true);
    case 'compiled_truth':
      return readPage(engine, selector, options, false);
    case 'section':
      return readSection(engine, selector, options);
    case 'line_span':
      return readLineSpan(engine, selector, options);
    case 'timeline_range':
      return readTimelineRange(engine, selector, options);
    case 'source_ref':
      return readSourceRef(engine, selector, options);
    case 'task_working_set':
      return readTaskWorkingSet(engine, selector, options);
    case 'task_attempt':
      return readTaskAttempt(engine, selector, options);
    case 'task_decision':
      return readTaskDecision(engine, selector, options);
    case 'profile_memory':
      return readProfileMemory(engine, selector, options);
    case 'personal_episode':
      return readPersonalEpisode(engine, selector, options);
    case 'timeline_entry':
      return null;
  }
}

async function readPage(
  engine: BrainEngine,
  selector: RetrievalSelector,
  options: { token_budget: number; include_timeline: 'auto' | 'include' | 'exclude'; include_source_refs: boolean },
  includePageTimeline: boolean,
): Promise<CanonicalContextRead | null> {
  if (!selector.slug) return null;
  const page = await engine.getPage(selector.slug);
  if (!page) return null;
  const shouldIncludeTimeline = includePageTimeline && options.include_timeline === 'include';
  const fullText = shouldIncludeTimeline && page.timeline.trim().length > 0
    ? `${page.compiled_truth.trim()}\n\n---\n\n${page.timeline.trim()}`
    : page.compiled_truth.trim();

  return buildRead({
    selector,
    title: page.title,
    text: fullText,
    authority: 'canonical_compiled_truth',
    source_refs: options.include_source_refs ? extractSourceRefs(fullText) : [],
    token_budget: options.token_budget,
  });
}

async function readSection(
  engine: BrainEngine,
  selector: RetrievalSelector,
  options: { token_budget: number; include_source_refs: boolean },
): Promise<CanonicalContextRead | null> {
  if (!selector.section_id) return null;
  const scopeId = selector.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID;
  const section = await engine.getNoteSectionEntry(scopeId, selector.section_id);
  if (!section) return null;

  return buildRead({
    selector: normalizeRetrievalSelector({
      ...selector,
      slug: section.page_slug,
      path: section.page_path,
      line_start: section.line_start,
      line_end: section.line_end,
      source_refs: section.source_refs,
      content_hash: section.content_hash,
    }),
    title: section.heading_text,
    text: section.section_text,
    authority: 'canonical_compiled_truth',
    source_refs: options.include_source_refs ? section.source_refs : [],
    token_budget: options.token_budget,
  });
}

async function readLineSpan(
  engine: BrainEngine,
  selector: RetrievalSelector,
  options: { token_budget: number; include_source_refs: boolean },
): Promise<CanonicalContextRead | null> {
  if (!selector.slug || selector.line_start === undefined || selector.line_end === undefined) return null;
  const page = await engine.getPage(selector.slug);
  if (!page) return null;
  const body = page.timeline.trim().length > 0
    ? `${page.compiled_truth}\n\n---\n\n${page.timeline}`
    : page.compiled_truth;
  const lines = body.split('\n');
  const text = lines.slice(selector.line_start - 1, selector.line_end).join('\n').trim();
  if (!text) return null;

  return buildRead({
    selector,
    title: page.title,
    text,
    authority: 'source_or_timeline_evidence',
    source_refs: options.include_source_refs ? extractSourceRefs(text) : [],
    token_budget: options.token_budget,
  });
}

async function readTimelineRange(
  engine: BrainEngine,
  selector: RetrievalSelector,
  options: { token_budget: number; include_source_refs: boolean },
): Promise<CanonicalContextRead | null> {
  if (!selector.slug) return null;
  const entries = await engine.getTimeline(selector.slug, { limit: 5 });
  if (entries.length === 0) return null;
  const text = entries
    .map((entry) => `- **${entry.date}** | ${entry.summary}${entry.detail ? `\n  ${entry.detail}` : ''}`)
    .join('\n');
  return buildRead({
    selector,
    title: `Timeline: ${selector.slug}`,
    text,
    authority: 'source_or_timeline_evidence',
    source_refs: options.include_source_refs ? entries.map((entry) => entry.source).filter((source) => source.length > 0) : [],
    token_budget: options.token_budget,
  });
}

async function readSourceRef(
  engine: BrainEngine,
  selector: RetrievalSelector,
  options: { token_budget: number; include_source_refs: boolean },
): Promise<CanonicalContextRead | null> {
  if (!selector.source_ref) return null;
  const sections = await listAllNoteSectionEntries(engine, selector.scope_id ?? DEFAULT_NOTE_MANIFEST_SCOPE_ID);
  const match = sections.find((section) => section.source_refs.includes(selector.source_ref!));
  if (!match) return null;
  return readSection(engine, {
    kind: 'section',
    scope_id: match.scope_id,
    slug: match.page_slug,
    section_id: match.section_id,
    path: `${match.page_path}#${match.heading_path.join('/')}`,
  }, options);
}

async function readTaskWorkingSet(
  engine: BrainEngine,
  selector: RetrievalSelector,
  options: { token_budget: number },
): Promise<CanonicalContextRead | null> {
  if (!selector.object_id) return null;
  const [thread, workingSet, attempts, decisions] = await Promise.all([
    engine.getTaskThread(selector.object_id),
    engine.getTaskWorkingSet(selector.object_id),
    engine.listTaskAttempts(selector.object_id, { limit: 3 }),
    engine.listTaskDecisions(selector.object_id, { limit: 3 }),
  ]);
  if (!thread && !workingSet) return null;
  const text = [
    thread ? `Task: ${thread.title}\nStatus: ${thread.status}\nSummary: ${thread.current_summary}` : '',
    workingSet ? `Active paths: ${workingSet.active_paths.join(', ')}` : '',
    workingSet ? `Active symbols: ${workingSet.active_symbols.join(', ')}` : '',
    workingSet ? `Blockers: ${workingSet.blockers.join(', ') || 'none'}` : '',
    workingSet ? `Open questions: ${workingSet.open_questions.join(', ') || 'none'}` : '',
    workingSet ? `Next steps: ${workingSet.next_steps.join(', ') || 'none'}` : '',
    workingSet ? `Verification notes: ${workingSet.verification_notes.join(', ') || 'none'}` : '',
    attempts.length > 0 ? `Recent attempts: ${attempts.map((attempt) => `${attempt.outcome}: ${attempt.summary}`).join(' | ')}` : '',
    decisions.length > 0 ? `Recent decisions: ${decisions.map((decision) => decision.summary).join(' | ')}` : '',
  ].filter((line) => line.trim().length > 0).join('\n');

  return buildRead({
    selector,
    title: `Task working set: ${selector.object_id}`,
    text,
    authority: 'operational_memory',
    source_refs: [`task:${selector.object_id}`],
    token_budget: options.token_budget,
  });
}

async function readTaskAttempt(
  engine: BrainEngine,
  selector: RetrievalSelector,
  options: { token_budget: number },
): Promise<CanonicalContextRead | null> {
  if (!selector.object_id) return null;
  const [taskId] = selector.object_id.split(':');
  const attempts = await engine.listTaskAttempts(taskId, { limit: 20 });
  const attempt = attempts.find((entry) => entry.id === selector.object_id || `${entry.task_id}:${entry.id}` === selector.object_id);
  if (!attempt) return null;
  return buildRead({
    selector,
    title: `Task attempt: ${attempt.id}`,
    text: `${attempt.outcome}: ${attempt.summary}\nEvidence: ${attempt.evidence.join(', ')}`,
    authority: 'operational_memory',
    source_refs: attempt.evidence,
    token_budget: options.token_budget,
  });
}

async function readTaskDecision(
  engine: BrainEngine,
  selector: RetrievalSelector,
  options: { token_budget: number },
): Promise<CanonicalContextRead | null> {
  if (!selector.object_id) return null;
  const [taskId] = selector.object_id.split(':');
  const decisions = await engine.listTaskDecisions(taskId, { limit: 20 });
  const decision = decisions.find((entry) => entry.id === selector.object_id || `${entry.task_id}:${entry.id}` === selector.object_id);
  if (!decision) return null;
  return buildRead({
    selector,
    title: `Task decision: ${decision.id}`,
    text: `${decision.summary}\nRationale: ${decision.rationale}\nConsequences: ${decision.consequences.join(', ')}`,
    authority: 'operational_memory',
    source_refs: [`task_decision:${decision.id}`],
    token_budget: options.token_budget,
  });
}

async function readProfileMemory(
  engine: BrainEngine,
  selector: RetrievalSelector,
  options: { token_budget: number },
): Promise<CanonicalContextRead | null> {
  if (!selector.object_id) return null;
  const entry = await engine.getProfileMemoryEntry(selector.object_id);
  if (!entry) return null;
  return buildRead({
    selector,
    title: `Profile memory: ${entry.subject}`,
    text: `${entry.subject} [${entry.profile_type}]\n${entry.content}`,
    authority: 'canonical_compiled_truth',
    source_refs: entry.source_refs,
    token_budget: options.token_budget,
  });
}

async function readPersonalEpisode(
  engine: BrainEngine,
  selector: RetrievalSelector,
  options: { token_budget: number },
): Promise<CanonicalContextRead | null> {
  if (!selector.object_id) return null;
  const entry = await engine.getPersonalEpisodeEntry(selector.object_id);
  if (!entry) return null;
  return buildRead({
    selector,
    title: `Personal episode: ${entry.title}`,
    text: `${entry.title}\nSource kind: ${entry.source_kind}\nStarted: ${entry.start_time.toISOString()}\nEnded: ${entry.end_time?.toISOString() ?? 'open'}\n${entry.summary}`,
    authority: 'canonical_compiled_truth',
    source_refs: entry.source_refs,
    token_budget: options.token_budget,
  });
}

function buildRead(input: {
  selector: RetrievalSelector;
  title: string;
  text: string;
  authority: MemoryArtifactAuthority;
  source_refs: string[];
  token_budget: number;
}): CanonicalContextRead {
  const normalizedText = input.text.trim();
  const tokenEstimate = estimateTokens(normalizedText);
  const clipped = clipToBudget(normalizedText, input.token_budget);
  const hasMore = clipped.length < normalizedText.length;
  const selector = normalizeRetrievalSelector(input.selector);
  const continuation = hasMore && selector.slug
    ? normalizeRetrievalSelector({
      kind: 'line_span',
      scope_id: selector.scope_id,
      slug: selector.slug,
      line_start: (selector.line_end ?? selector.line_start ?? 1) + 1,
      line_end: (selector.line_end ?? selector.line_start ?? 1) + 80,
      freshness: selector.freshness,
    })
    : undefined;

  return {
    selector,
    authority: input.authority,
    title: input.title,
    text: clipped,
    source_refs: [...new Set(input.source_refs)],
    token_estimate: Math.min(tokenEstimate, input.token_budget),
    has_more: hasMore,
    continuation_selector: continuation,
  };
}

function buildAnswerReady(
  reads: CanonicalContextRead[],
  unreadRequired: RetrievalSelector[],
  warnings: string[],
): ContextAnswerReady {
  if (reads.length === 0) {
    return {
      ready: false,
      answer_ground: [],
      unsupported_reasons: unreadRequired.length > 0 ? ['no_canonical_selector_read'] : ['no_selectors_requested'],
      citation_policy: 'Do not answer from chunks or derived orientation alone.',
    };
  }
  if (unreadRequired.length > 0) {
    return {
      ready: false,
      answer_ground: reads.map((read) => read.selector),
      unsupported_reasons: ['required_selectors_unread', ...warnings],
      citation_policy: 'Answer only claims supported by canonical_reads; disclose unread selectors.',
    };
  }
  return {
    ready: true,
    answer_ground: reads.map((read) => read.selector),
    unsupported_reasons: [],
    citation_policy: 'Cite canonical_reads by selector_id and propagate source_refs when present.',
  };
}

function buildEvidenceClaim(read: CanonicalContextRead): ContextEvidenceClaim {
  const selectorId = retrievalSelectorId(read.selector);
  if (read.selector.kind === 'task_working_set') {
    return { selector_id: selectorId, claim_kind: 'task_state', source_refs: read.source_refs };
  }
  if (read.selector.kind === 'profile_memory') {
    return { selector_id: selectorId, claim_kind: 'profile_memory', source_refs: read.source_refs };
  }
  if (read.selector.kind === 'personal_episode') {
    return { selector_id: selectorId, claim_kind: 'personal_episode', source_refs: read.source_refs };
  }
  if (read.selector.kind === 'timeline_range' || read.selector.kind === 'line_span') {
    return { selector_id: selectorId, claim_kind: 'timeline_evidence', source_refs: read.source_refs };
  }
  return { selector_id: selectorId, claim_kind: 'compiled_truth', source_refs: read.source_refs };
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE));
}

function clipToBudget(text: string, tokenBudget: number): string {
  const maxChars = Math.max(1, tokenBudget * CHARS_PER_TOKEN_ESTIMATE);
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars).replace(/\s+\S*$/, '').trimEnd();
}

function extractSourceRefs(text: string): string[] {
  const refs: string[] = [];
  const pattern = /\[Source:\s*([^\]\n]+)\]/g;
  for (const match of text.matchAll(pattern)) {
    const source = match[1]?.trim();
    if (source) refs.push(source);
  }
  return [...new Set(refs)];
}
```

- [ ] **Step 4: Run read-context tests and commit**

Run:

```bash
bun test test/read-context-service.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/core/services/read-context-service.ts test/read-context-service.test.ts
git commit -m "feat: add bounded canonical context reads"
```

---

## Task 3: Implement Candidate Probe And Required Reads

**Files:**
- Create: `src/core/services/retrieve-context-service.ts`
- Test: `test/retrieve-context-service.test.ts`

- [ ] **Step 1: Write retrieve-context service tests**

Create `test/retrieve-context-service.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { retrieveContext } from '../src/core/services/retrieve-context-service.ts';
import { buildStructuralContextMapEntry } from '../src/core/services/context-map-service.ts';

async function withEngine<T>(label: string, fn: (engine: SQLiteEngine) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), `mbrain-retrieve-context-${label}-`));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    return await fn(engine);
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('retrieve context service', () => {
  test('turns exact selectors into required reads without candidate search', async () => {
    await withEngine('exact', async (engine) => {
      const result = await retrieveContext(engine, {
        selectors: [{ kind: 'compiled_truth', slug: 'systems/mbrain' }],
        query: 'systems/mbrain',
      }, {
        candidateSearch: async () => {
          throw new Error('exact selector retrieval must not search');
        },
      });

      expect(result.answerability.answerable_from_probe).toBe(false);
      expect(result.answerability.must_read_context).toBe(true);
      expect(result.required_reads).toHaveLength(1);
      expect(result.required_reads[0]!.kind).toBe('compiled_truth');
      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]!.activation).toBe('candidate_only');
    });
  });

  test('groups chunk search results by canonical page and marks probe as not answer-ready', async () => {
    await withEngine('search', async (engine) => {
      await importFromContent(engine, 'concepts/retrieval', [
        '---',
        'type: concept',
        'title: Retrieval',
        '---',
        '# Compiled Truth',
        'Retrieval chunks are candidate pointers, not answer evidence.',
        '[Source: User, direct message, 2026-05-07 09:00 KST]',
      ].join('\n'), { path: 'concepts/retrieval.md' });

      const result = await retrieveContext(engine, {
        query: 'candidate pointers',
        limit: 5,
      });

      expect(result.answerability.answerable_from_probe).toBe(false);
      expect(result.answerability.must_read_context).toBe(true);
      expect(result.answerability.reason_codes).toContain('probe_candidates_are_not_answer_ground');
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(result.required_reads[0]!.slug).toBe('concepts/retrieval');
      expect(result.warnings).toContain('Search/query chunks are candidate pointers; call read_context before answering factual questions.');
    });
  });

  test('uses context maps as orientation and keeps required reads canonical', async () => {
    await withEngine('orientation', async (engine) => {
      await importFromContent(engine, 'systems/mbrain', [
        '---',
        'type: system',
        'title: MBrain',
        '---',
        '# Overview',
        'See [[concepts/retrieval]].',
      ].join('\n'), { path: 'systems/mbrain.md' });
      await importFromContent(engine, 'concepts/retrieval', [
        '---',
        'type: concept',
        'title: Retrieval',
        '---',
        '# Compiled Truth',
        'Retrieval is grounded by canonical reads.',
        '[Source: User, direct message, 2026-05-07 09:05 KST]',
      ].join('\n'), { path: 'concepts/retrieval.md' });
      await buildStructuralContextMapEntry(engine);

      const result = await retrieveContext(engine, {
        query: 'retrieval',
        include_orientation: true,
      });

      expect(result.orientation.derived_consulted.some((ref) => ref.startsWith('context_map:'))).toBe(true);
      expect(result.orientation.recommended_reads.length).toBeGreaterThan(0);
      expect(result.required_reads.every((selector) => selector.kind !== 'source_ref')).toBe(true);
      expect(result.answerability.must_read_context).toBe(true);
    });
  });

  test('scope denial returns no candidates or snippets', async () => {
    await withEngine('scope', async (engine) => {
      const result = await retrieveContext(engine, {
        query: 'Remember my personal routine',
        requested_scope: 'work',
      });

      expect(result.scope_gate?.policy).toBe('defer');
      expect(result.candidates).toEqual([]);
      expect(result.required_reads).toEqual([]);
      expect(result.answerability.reason_codes).toContain('scope_gate_deferred');
    });
  });
});
```

- [ ] **Step 2: Run retrieve-context service tests to verify failure**

Run:

```bash
bun test test/retrieve-context-service.test.ts
```

Expected: FAIL because `retrieve-context-service.ts` does not exist.

- [ ] **Step 3: Implement retrieve-context service**

Create `src/core/services/retrieve-context-service.ts`:

```ts
import { randomUUID } from 'crypto';
import type { BrainEngine } from '../engine.ts';
import type {
  RetrieveContextCandidate,
  RetrieveContextInput,
  RetrieveContextOrientation,
  RetrieveContextResult,
  RetrievalMatchedChunk,
  RetrievalSelector,
  SearchResult,
} from '../types.ts';
import { getBroadSynthesisRoute } from './broad-synthesis-route-service.ts';
import { classifyMemoryScenario } from './memory-scenario-classifier-service.ts';
import { DEFAULT_NOTE_MANIFEST_SCOPE_ID } from './note-manifest-service.ts';
import { evaluateScopeGate } from './scope-gate-service.ts';
import {
  normalizeRetrievalSelector,
  retrievalSelectorId,
  selectorFromRouteRead,
  selectorFromSearchResult,
} from './retrieval-selector-service.ts';

export type RetrieveContextCandidateSearch = (
  query: string,
  options: { limit: number },
) => Promise<SearchResult[]>;

export interface RetrieveContextDependencies {
  candidateSearch?: RetrieveContextCandidateSearch;
}

const DEFAULT_CANDIDATE_LIMIT = 5;

export async function retrieveContext(
  engine: BrainEngine,
  input: RetrieveContextInput,
  dependencies: RetrieveContextDependencies = {},
): Promise<RetrieveContextResult> {
  const requestId = randomUUID();
  const classification = classifyMemoryScenario(input);
  const scopeGate = await maybeEvaluateScopeGate(engine, input, classification.scenario);
  if (scopeGate && scopeGate.policy !== 'allow') {
    return {
      request_id: requestId,
      scenario: classification.scenario,
      scope_gate: scopeGate,
      route: null,
      answerability: {
        answerable_from_probe: false,
        allowed_probe_answer_kind: 'none',
        must_read_context: false,
        reason_codes: [`scope_gate_${scopeGate.policy}`],
      },
      candidates: [],
      required_reads: [],
      orientation: emptyOrientation(),
      warnings: scopeGate.summary_lines,
    };
  }

  const exactSelectors = (input.selectors ?? []).map((selector) => normalizeRetrievalSelector(selector));
  if (exactSelectors.length > 0) {
    return {
      request_id: requestId,
      scenario: classification.scenario,
      scope_gate: scopeGate,
      route: null,
      answerability: {
        answerable_from_probe: false,
        allowed_probe_answer_kind: 'none',
        must_read_context: true,
        reason_codes: ['exact_selectors_require_canonical_read'],
      },
      candidates: exactSelectors.map((selector, index) => candidateFromSelector(selector, index + 1)),
      required_reads: exactSelectors,
      orientation: emptyOrientation(),
      warnings: ['Exact selector supplied; call read_context for canonical evidence.'],
    };
  }

  if (input.task_id) {
    const selector = normalizeRetrievalSelector({
      kind: 'task_working_set',
      object_id: input.task_id,
      scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
      freshness: 'current',
    });
    return {
      request_id: requestId,
      scenario: classification.scenario,
      scope_gate: scopeGate,
      route: null,
      answerability: {
        answerable_from_probe: false,
        allowed_probe_answer_kind: 'none',
        must_read_context: true,
        reason_codes: ['task_continuation_requires_task_state'],
      },
      candidates: [candidateFromSelector(selector, 1)],
      required_reads: [selector],
      orientation: emptyOrientation(),
      warnings: ['Task continuation must read task state before raw files or graph orientation.'],
    };
  }

  const limit = input.limit ?? DEFAULT_CANDIDATE_LIMIT;
  const candidateSearch = dependencies.candidateSearch ?? ((query, options) =>
    engine.searchKeyword(query, { limit: options.limit }));
  const query = input.query?.trim() ?? '';
  const searchResults = query.length > 0 ? await candidateSearch(query, { limit }) : [];
  const candidates = await groupCandidates(engine, searchResults, limit);
  const orientation = input.include_orientation === false || query.length === 0
    ? emptyOrientation()
    : await buildOrientation(engine, query, limit);
  const requiredReads = dedupeSelectors([
    ...candidates.map((candidate) => candidate.read_selector),
    ...orientation.recommended_reads,
  ]).slice(0, limit);

  return {
    request_id: requestId,
    scenario: classification.scenario,
    scope_gate: scopeGate,
    route: null,
    answerability: {
      answerable_from_probe: false,
      allowed_probe_answer_kind: 'none',
      must_read_context: requiredReads.length > 0,
      reason_codes: requiredReads.length > 0
        ? ['probe_candidates_are_not_answer_ground']
        : ['no_candidate'],
    },
    candidates,
    required_reads: requiredReads,
    orientation,
    warnings: [
      'Search/query chunks are candidate pointers; call read_context before answering factual questions.',
      ...(requiredReads.length === 0 ? ['No canonical read candidate was found.'] : []),
    ],
  };
}

async function maybeEvaluateScopeGate(
  engine: BrainEngine,
  input: RetrieveContextInput,
  scenario: string,
) {
  const shouldGate = input.requested_scope !== undefined
    || scenario === 'personal_recall'
    || scenario === 'mixed';
  if (!shouldGate) return undefined;

  return evaluateScopeGate(engine, {
    intent: scenario === 'personal_recall' ? 'personal_profile_lookup' : 'broad_synthesis',
    requested_scope: input.requested_scope,
    task_id: input.task_id,
    query: input.query,
    repo_path: input.repo_path ?? undefined,
  });
}

async function groupCandidates(
  engine: BrainEngine,
  searchResults: SearchResult[],
  limit: number,
): Promise<RetrieveContextCandidate[]> {
  const bySlug = new Map<string, SearchResult[]>();
  for (const result of searchResults) {
    const existing = bySlug.get(result.slug) ?? [];
    existing.push(result);
    bySlug.set(result.slug, existing);
  }

  const candidates: RetrieveContextCandidate[] = [];
  for (const [slug, pageResults] of bySlug) {
    const top = pageResults.sort((a, b) => b.score - a.score)[0];
    if (!top) continue;
    const selector = await bestReadSelectorForSearchResult(engine, top);
    candidates.push({
      candidate_id: `candidate:${slug}`,
      canonical_target: {
        kind: selector.kind,
        slug,
        title: top.title,
        type: top.type,
        section_id: selector.section_id,
        scope_id: selector.scope_id,
      },
      matched_chunks: pageResults.map(toMatchedChunk),
      why_matched: [`matched ${pageResults.length} search chunk${pageResults.length === 1 ? '' : 's'}`],
      activation: top.stale ? 'verify_first' : 'candidate_only',
      read_priority: candidates.length + 1,
      read_selector: selector,
    });
    if (candidates.length >= limit) break;
  }
  return candidates;
}

async function bestReadSelectorForSearchResult(
  engine: BrainEngine,
  result: SearchResult,
): Promise<RetrievalSelector> {
  const sections = await engine.listNoteSectionEntries({
    scope_id: DEFAULT_NOTE_MANIFEST_SCOPE_ID,
    page_slug: result.slug,
    limit: 50,
  });
  const normalizedChunk = normalizeText(result.chunk_text).slice(0, 80);
  const matchingSection = sections.find((section) =>
    normalizeText(section.section_text).includes(normalizedChunk));
  if (matchingSection) {
    return normalizeRetrievalSelector({
      kind: 'section',
      scope_id: matchingSection.scope_id,
      slug: matchingSection.page_slug,
      path: `${matchingSection.page_path}#${matchingSection.heading_path.join('/')}`,
      section_id: matchingSection.section_id,
      line_start: matchingSection.line_start,
      line_end: matchingSection.line_end,
      source_refs: matchingSection.source_refs,
      content_hash: matchingSection.content_hash,
      freshness: result.stale ? 'stale' : 'current',
    });
  }
  return selectorFromSearchResult(result);
}

async function buildOrientation(
  engine: BrainEngine,
  query: string,
  limit: number,
): Promise<RetrieveContextOrientation> {
  const route = await getBroadSynthesisRoute(engine, { query, limit });
  if (!route.route) return emptyOrientation();
  const derivedConsulted = route.route.map_id ? [`context_map:${route.route.map_id}`] : [];
  const recommendedReads = route.route.recommended_reads.map(selectorFromRouteRead);
  return {
    derived_consulted: derivedConsulted,
    recommended_reads: recommendedReads,
    summary_lines: route.route.summary_lines,
  };
}

function candidateFromSelector(selector: RetrievalSelector, priority: number): RetrieveContextCandidate {
  return {
    candidate_id: `candidate:${retrievalSelectorId(selector)}`,
    canonical_target: {
      kind: selector.kind,
      slug: selector.slug,
      path: selector.path,
      section_id: selector.section_id,
      scope_id: selector.scope_id,
    },
    matched_chunks: [],
    why_matched: ['explicit selector'],
    activation: 'candidate_only',
    read_priority: priority,
    read_selector: selector,
  };
}

function emptyOrientation(): RetrieveContextOrientation {
  return {
    derived_consulted: [],
    recommended_reads: [],
    summary_lines: [],
  };
}

function toMatchedChunk(result: SearchResult): RetrievalMatchedChunk {
  return {
    slug: result.slug,
    page_id: result.page_id,
    title: result.title,
    type: result.type,
    chunk_text: result.chunk_text,
    chunk_source: result.chunk_source,
    score: result.score,
    stale: result.stale,
  };
}

function dedupeSelectors(selectors: RetrievalSelector[]): RetrievalSelector[] {
  const seen = new Set<string>();
  const output: RetrievalSelector[] = [];
  for (const selector of selectors) {
    const normalized = normalizeRetrievalSelector(selector);
    const id = retrievalSelectorId(normalized);
    if (seen.has(id)) continue;
    seen.add(id);
    output.push(normalized);
  }
  return output;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}
```

- [ ] **Step 4: Run retrieve-context service tests and commit**

Run:

```bash
bun test test/retrieve-context-service.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/core/services/retrieve-context-service.ts test/retrieve-context-service.test.ts
git commit -m "feat: add agentic context retrieval probe"
```

---

## Task 4: Register `read_context` Operation

**Files:**
- Modify: `src/core/operations.ts`
- Test: `test/read-context-operations.test.ts`

- [ ] **Step 1: Write operation tests for `read_context`**

Create `test/read-context-operations.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { formatResult, operationsByName } from '../src/core/operations.ts';

async function withContext<T>(fn: (ctx: any) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-read-context-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    return await fn({
      engine,
      config: {},
      logger: console,
      dryRun: false,
    });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('read_context operation', () => {
  test('is registered as a non-mutating operation', () => {
    const op = operationsByName.read_context;
    expect(op).toBeDefined();
    expect(op?.mutating).toBe(false);
    expect(op?.cliHints?.name).toBe('read-context');
  });

  test('reads canonical evidence from JSON selector input', async () => {
    await withContext(async (ctx) => {
      await importFromContent(ctx.engine, 'concepts/retrieval', [
        '---',
        'type: concept',
        'title: Retrieval',
        '---',
        '# Compiled Truth',
        'Canonical reads ground answers.',
        '[Source: User, direct message, 2026-05-07 09:10 KST]',
      ].join('\n'), { path: 'concepts/retrieval.md' });

      const result = await operationsByName.read_context!.handler(ctx, {
        selectors: JSON.stringify([{ kind: 'compiled_truth', slug: 'concepts/retrieval' }]),
      }) as any;

      expect(result.answer_ready.ready).toBe(true);
      expect(result.canonical_reads[0].text).toContain('Canonical reads ground answers.');
    });
  });

  test('rejects invalid selector JSON', async () => {
    await withContext(async (ctx) => {
      await expect(operationsByName.read_context!.handler(ctx, {
        selectors: '{"not":"an array"}',
      })).rejects.toThrow('selectors JSON value must be an array');
    });
  });

  test('formats canonical reads compactly for CLI output', () => {
    const output = formatResult('read_context', {
      answer_ready: {
        ready: true,
        answer_ground: [{ selector_id: 'compiled_truth:workspace:default:concepts/retrieval' }],
        unsupported_reasons: [],
        citation_policy: 'Cite canonical reads.',
      },
      canonical_reads: [{
        selector: { selector_id: 'compiled_truth:workspace:default:concepts/retrieval' },
        authority: 'canonical_compiled_truth',
        title: 'Retrieval',
        text: 'Canonical reads ground answers.',
        source_refs: ['User, direct message, 2026-05-07 09:10 KST'],
        token_estimate: 8,
        has_more: false,
      }],
      evidence_claims: [],
      conflicts: [],
      warnings: [],
      unread_required: [],
      continuations: [],
    });

    expect(output).toContain('Answer ready: yes');
    expect(output).toContain('Retrieval [canonical_compiled_truth]');
    expect(output).toContain('Canonical reads ground answers.');
  });
});
```

- [ ] **Step 2: Run operation tests to verify failure**

Run:

```bash
bun test test/read-context-operations.test.ts
```

Expected: FAIL because `read_context` is not registered.

- [ ] **Step 3: Wire `read_context` into operations**

In `src/core/operations.ts`, add this import near the retrieval service imports:

```ts
import { readContext } from './services/read-context-service.ts';
```

Extend the type import list with:

```ts
  ContextReadMode,
  ContextTimelineMode,
  RetrievalSelector,
  RetrievalSelectorKind,
```

Add constants near the other enum constants:

```ts
const RETRIEVAL_SELECTOR_KINDS = [
  'page',
  'compiled_truth',
  'section',
  'line_span',
  'timeline_entry',
  'timeline_range',
  'source_ref',
  'task_working_set',
  'task_attempt',
  'task_decision',
  'profile_memory',
  'personal_episode',
] as const satisfies readonly RetrievalSelectorKind[];

const CONTEXT_READ_MODES = [
  'explicit',
  'auto',
] as const satisfies readonly ContextReadMode[];

const CONTEXT_TIMELINE_MODES = [
  'auto',
  'include',
  'exclude',
] as const satisfies readonly ContextTimelineMode[];
```

Add this parser after `parseActivationArtifacts`:

```ts
function parseRetrievalSelectors(value: unknown, key: string): RetrievalSelector[] | undefined {
  if (value === undefined || value === null) return undefined;
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new OperationError('invalid_params', `${key} must be valid JSON when passed as a string.`);
    }
  }
  if (!Array.isArray(parsed)) {
    throw new OperationError('invalid_params', `${key} JSON value must be an array.`);
  }

  return parsed.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new OperationError('invalid_params', `${key}[${index}] must be an object.`);
    }
    const selector = item as Record<string, unknown>;
    const kind = parseEnumParam(selector.kind, `${key}[${index}].kind`, RETRIEVAL_SELECTOR_KINDS);
    if (!kind) {
      throw new OperationError('invalid_params', `${key}[${index}].kind must be one of: ${RETRIEVAL_SELECTOR_KINDS.join(', ')}.`);
    }
    const output: RetrievalSelector = { kind };
    for (const field of ['selector_id', 'scope_id', 'slug', 'path', 'section_id', 'source_ref', 'object_id', 'content_hash'] as const) {
      if (selector[field] !== undefined) {
        if (typeof selector[field] !== 'string') {
          throw new OperationError('invalid_params', `${key}[${index}].${field} must be a string.`);
        }
        output[field] = selector[field] as string;
      }
    }
    for (const field of ['line_start', 'line_end'] as const) {
      if (selector[field] !== undefined) {
        if (typeof selector[field] !== 'number') {
          throw new OperationError('invalid_params', `${key}[${index}].${field} must be a number.`);
        }
        output[field] = selector[field] as number;
      }
    }
    if (selector.source_refs !== undefined) {
      if (!Array.isArray(selector.source_refs) || !selector.source_refs.every((entry) => typeof entry === 'string')) {
        throw new OperationError('invalid_params', `${key}[${index}].source_refs must be an array of strings.`);
      }
      output.source_refs = selector.source_refs as string[];
    }
    if (selector.freshness !== undefined) {
      output.freshness = parseEnumParam(selector.freshness, `${key}[${index}].freshness`, ['current', 'stale', 'unknown'] as const);
    }
    return output;
  });
}
```

Add the operation before `retrieve_context` is added in the next task:

```ts
const read_context: Operation = {
  name: 'read_context',
  description: 'Read bounded canonical evidence from selectors returned by retrieve_context. Use this before answering factual questions from MBrain search/query candidates.',
  params: {
    query: { type: 'string', description: 'Optional natural-language request for auto read selection' },
    selectors: {
      type: ['array', 'string'],
      items: { type: 'object' },
      description: 'Retrieval selectors as objects or a JSON array string',
    },
    reads: { type: 'string', description: 'Read mode', enum: [...CONTEXT_READ_MODES] },
    token_budget: { type: 'number', description: 'Approximate token budget for canonical reads' },
    max_selectors: { type: 'number', description: 'Maximum selectors to read, default 3' },
    include_timeline: { type: 'string', description: 'Timeline inclusion mode', enum: [...CONTEXT_TIMELINE_MODES] },
    include_source_refs: { type: 'boolean', description: 'Include source refs in canonical reads, default true' },
    persist_trace: { type: 'boolean', description: 'Persist a Retrieval Trace for this read' },
    task_id: { type: 'string', description: 'Optional task id for trace association' },
  },
  mutating: false,
  handler: async (ctx, p) => readContext(ctx.engine, {
    query: parseOptionalStringParam(p.query, 'query'),
    selectors: parseRetrievalSelectors(p.selectors, 'selectors'),
    reads: parseEnumParam(p.reads, 'reads', CONTEXT_READ_MODES),
    token_budget: typeof p.token_budget === 'number' ? p.token_budget : undefined,
    max_selectors: typeof p.max_selectors === 'number' ? p.max_selectors : undefined,
    include_timeline: parseEnumParam(p.include_timeline, 'include_timeline', CONTEXT_TIMELINE_MODES),
    include_source_refs: typeof p.include_source_refs === 'boolean' ? p.include_source_refs : undefined,
    persist_trace: p.persist_trace === true,
    task_id: parseOptionalStringParam(p.task_id, 'task_id'),
  }),
  cliHints: { name: 'read-context' },
};
```

Add `read_context` to the `operations` list in a new `// Agentic retrieval` group immediately after `search, query`:

```ts
  // Search
  search, query,
  // Agentic retrieval
  read_context,
```

Add this `formatResult` case before `search/query`:

```ts
    case 'read_context': {
      const resultValue = result as any;
      const ready = resultValue.answer_ready?.ready === true ? 'yes' : 'no';
      const lines = [
        `Answer ready: ${ready}`,
        `Citation policy: ${resultValue.answer_ready?.citation_policy ?? 'none'}`,
        ...(resultValue.warnings || []).map((warning: string) => `Warning: ${warning}`),
        'Canonical reads:',
        ...(resultValue.canonical_reads || []).map((read: any) => [
          `- ${read.title} [${read.authority}]`,
          `  Selector: ${read.selector?.selector_id ?? 'unknown'}`,
          `  Tokens: ${read.token_estimate}${read.has_more ? ' (has more)' : ''}`,
          `  ${String(read.text ?? '').replace(/\s+/g, ' ').slice(0, 240)}`,
        ].join('\n')),
        ...(resultValue.continuations?.length ? [
          'Continuations:',
          ...resultValue.continuations.map((selector: any) => `- ${selector.selector_id ?? selector.kind}`),
        ] : []),
      ];
      return lines.join('\n') + '\n';
    }
```

- [ ] **Step 4: Run read-context operation tests and commit**

Run:

```bash
bun test test/read-context-operations.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/core/operations.ts test/read-context-operations.test.ts
git commit -m "feat: expose read context operation"
```

---

## Task 5: Register `retrieve_context` Operation

**Files:**
- Modify: `src/core/operations.ts`
- Test: `test/retrieve-context-operations.test.ts`

- [ ] **Step 1: Write operation tests for `retrieve_context`**

Create `test/retrieve-context-operations.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { formatResult, operationsByName } from '../src/core/operations.ts';

async function withContext<T>(fn: (ctx: any) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-retrieve-context-op-'));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();

  try {
    await engine.connect({ engine: 'sqlite', database_path: databasePath });
    await engine.initSchema();
    return await fn({
      engine,
      config: {},
      logger: console,
      dryRun: false,
    });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('retrieve_context operation', () => {
  test('is registered as a non-mutating operation', () => {
    const op = operationsByName.retrieve_context;
    expect(op).toBeDefined();
    expect(op?.mutating).toBe(false);
    expect(op?.cliHints?.name).toBe('retrieve-context');
  });

  test('returns required reads and answerability for a query', async () => {
    await withContext(async (ctx) => {
      await importFromContent(ctx.engine, 'concepts/retrieval', [
        '---',
        'type: concept',
        'title: Retrieval',
        '---',
        '# Compiled Truth',
        'Canonical reads ground answers.',
        '[Source: User, direct message, 2026-05-07 09:20 KST]',
      ].join('\n'), { path: 'concepts/retrieval.md' });

      const result = await operationsByName.retrieve_context!.handler(ctx, {
        query: 'canonical reads',
        limit: 5,
      }) as any;

      expect(result.answerability.answerable_from_probe).toBe(false);
      expect(result.answerability.must_read_context).toBe(true);
      expect(result.required_reads.length).toBeGreaterThan(0);
      expect(result.candidates[0].matched_chunks.length).toBeGreaterThan(0);
    });
  });

  test('uses exact selectors without search-like answerability', async () => {
    await withContext(async (ctx) => {
      const result = await operationsByName.retrieve_context!.handler(ctx, {
        query: 'systems/mbrain',
        selectors: JSON.stringify([{ kind: 'compiled_truth', slug: 'systems/mbrain' }]),
      }) as any;

      expect(result.answerability.reason_codes).toContain('exact_selectors_require_canonical_read');
      expect(result.required_reads[0].slug).toBe('systems/mbrain');
    });
  });

  test('formats probe output as next-read guidance', () => {
    const output = formatResult('retrieve_context', {
      scenario: 'knowledge_qa',
      answerability: {
        answerable_from_probe: false,
        must_read_context: true,
        reason_codes: ['probe_candidates_are_not_answer_ground'],
      },
      candidates: [{
        candidate_id: 'candidate:concepts/retrieval',
        canonical_target: { slug: 'concepts/retrieval', kind: 'compiled_truth' },
        matched_chunks: [{ score: 1.2345, chunk_text: 'Canonical reads ground answers.' }],
        why_matched: ['matched 1 search chunk'],
        activation: 'candidate_only',
        read_priority: 1,
        read_selector: { selector_id: 'compiled_truth:workspace:default:concepts/retrieval' },
      }],
      required_reads: [{ selector_id: 'compiled_truth:workspace:default:concepts/retrieval' }],
      orientation: { derived_consulted: [], recommended_reads: [], summary_lines: [] },
      warnings: ['Search/query chunks are candidate pointers; call read_context before answering factual questions.'],
    });

    expect(output).toContain('Answerable from probe: no');
    expect(output).toContain('Required reads:');
    expect(output).toContain('compiled_truth:workspace:default:concepts/retrieval');
  });
});
```

- [ ] **Step 2: Run retrieve-context operation tests to verify failure**

Run:

```bash
bun test test/retrieve-context-operations.test.ts
```

Expected: FAIL because `retrieve_context` is not registered.

- [ ] **Step 3: Wire `retrieve_context` into operations**

In `src/core/operations.ts`, add this import near `readContext`:

```ts
import { retrieveContext } from './services/retrieve-context-service.ts';
```

Add the operation after `read_context`:

```ts
const retrieve_context: Operation = {
  name: 'retrieve_context',
  description: 'Plan agentic MBrain retrieval: classify scope/scenario, discover compact candidates, and return required canonical reads. Use read_context on required_reads before factual answers.',
  params: {
    query: { type: 'string', description: 'Raw user request or memory query' },
    task_id: { type: 'string', description: 'Optional active task id' },
    repo_path: { type: 'string', description: 'Optional active repository path' },
    requested_scope: { type: 'string', description: 'Optional explicit scope override', enum: [...REQUESTED_SCOPES] },
    source_kind: { type: 'string', description: 'Optional source kind for classification', enum: [...MEMORY_SCENARIO_SOURCE_KINDS] },
    known_subjects: {
      type: ['array', 'string'],
      items: { type: ['string', 'object'] },
      description: 'Optional detected subject refs as strings or objects with ref and kind, or a JSON array string',
    },
    selectors: {
      type: ['array', 'string'],
      items: { type: 'object' },
      description: 'Optional exact retrieval selectors as objects or a JSON array string',
    },
    limit: { type: 'number', description: 'Candidate and required-read limit, default 5' },
    token_budget: { type: 'number', description: 'Approximate probe output token budget' },
    include_orientation: { type: 'boolean', description: 'Include context-map orientation when useful, default true' },
    persist_trace: { type: 'boolean', description: 'Persist a Retrieval Trace for this probe' },
  },
  mutating: false,
  handler: async (ctx, p) => retrieveContext(ctx.engine, {
    query: parseOptionalStringParam(p.query, 'query'),
    task_id: parseOptionalStringParam(p.task_id, 'task_id'),
    repo_path: parseOptionalStringParam(p.repo_path, 'repo_path'),
    requested_scope: parseEnumParam(p.requested_scope, 'requested_scope', REQUESTED_SCOPES),
    source_kind: parseEnumParam(p.source_kind, 'source_kind', MEMORY_SCENARIO_SOURCE_KINDS),
    known_subjects: parseKnownSubjectsParam(p.known_subjects, 'known_subjects'),
    selectors: parseRetrievalSelectors(p.selectors, 'selectors'),
    limit: typeof p.limit === 'number' ? p.limit : undefined,
    token_budget: typeof p.token_budget === 'number' ? p.token_budget : undefined,
    include_orientation: typeof p.include_orientation === 'boolean' ? p.include_orientation : undefined,
    persist_trace: p.persist_trace === true,
  }),
  cliHints: { name: 'retrieve-context', aliases: { n: 'limit', scope: 'requested_scope' } },
};
```

Update the `operations` list:

```ts
  // Search
  search, query,
  // Agentic retrieval
  retrieve_context, read_context,
```

Add this `formatResult` case before `read_context`:

```ts
    case 'retrieve_context': {
      const resultValue = result as any;
      const lines = [
        `Scenario: ${resultValue.scenario ?? 'unknown'}`,
        `Answerable from probe: ${resultValue.answerability?.answerable_from_probe ? 'yes' : 'no'}`,
        `Must read context: ${resultValue.answerability?.must_read_context ? 'yes' : 'no'}`,
        `Reason codes: ${(resultValue.answerability?.reason_codes || []).join(', ') || 'none'}`,
        ...(resultValue.scope_gate ? [`Scope gate: ${resultValue.scope_gate.policy} (${resultValue.scope_gate.decision_reason})`] : []),
        ...(resultValue.warnings || []).map((warning: string) => `Warning: ${warning}`),
        'Candidates:',
        ...(resultValue.candidates || []).map((candidate: any) => {
          const topChunk = candidate.matched_chunks?.[0];
          const score = typeof topChunk?.score === 'number' ? topChunk.score.toFixed(4) : '?';
          const excerpt = topChunk?.chunk_text ? String(topChunk.chunk_text).replace(/\s+/g, ' ').slice(0, 140) : 'explicit selector';
          return `- ${candidate.candidate_id} -> ${candidate.read_selector?.selector_id ?? candidate.read_selector?.kind ?? 'unknown'} [${candidate.activation}, score=${score}] ${excerpt}`;
        }),
        'Required reads:',
        ...(resultValue.required_reads || []).map((selector: any) => `- ${selector.selector_id ?? selector.kind}`),
        ...(resultValue.orientation?.derived_consulted?.length ? [
          'Derived consulted:',
          ...resultValue.orientation.derived_consulted.map((item: string) => `- ${item}`),
        ] : []),
      ];
      return lines.join('\n') + '\n';
    }
```

- [ ] **Step 4: Run retrieve-context operation tests and commit**

Run:

```bash
bun test test/retrieve-context-operations.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/core/operations.ts test/retrieve-context-operations.test.ts
git commit -m "feat: expose retrieve context operation"
```

---

## Task 6: Update Agent-Facing Search Contract

**Files:**
- Modify: `src/core/operations.ts`
- Modify: `skills/query/SKILL.md`
- Modify: `docs/MCP_INSTRUCTIONS.md`
- Modify: `test/mcp-instructions.test.ts`
- Test: `test/mcp-instructions.test.ts`
- Test: `test/e2e/skills.test.ts`

- [ ] **Step 1: Write contract assertions**

Modify `test/mcp-instructions.test.ts` by adding these tests inside `describe('core tool descriptions include trigger context', () => { ... })`:

```ts
  test('retrieve_context description makes it the preferred agent probe', () => {
    const retrieveContext = operations.find(op => op.name === 'retrieve_context');
    expect(retrieveContext).toBeDefined();
    expect(retrieveContext!.description).toContain('required canonical reads');
    expect(retrieveContext!.description).toContain('read_context');
  });

  test('read_context description marks it as the evidence boundary', () => {
    const readContext = operations.find(op => op.name === 'read_context');
    expect(readContext).toBeDefined();
    expect(readContext!.description).toContain('bounded canonical evidence');
    expect(readContext!.description).toContain('before answering factual questions');
  });

  test('search and query descriptions do not imply chunks are answer evidence', () => {
    const search = operations.find(op => op.name === 'search');
    const query = operations.find(op => op.name === 'query');
    expect(search).toBeDefined();
    expect(query).toBeDefined();
    expect(search!.description).toContain('candidate discovery');
    expect(query!.description).toContain('candidate discovery');
    expect(search!.description).toContain('call retrieve_context or read_context');
    expect(query!.description).toContain('call retrieve_context or read_context');
  });
```

- [ ] **Step 2: Run contract tests to verify failure**

Run:

```bash
bun test test/mcp-instructions.test.ts
```

Expected: FAIL until descriptions and docs are updated.

- [ ] **Step 3: Update `search` and `query` descriptions**

In `src/core/operations.ts`, change the `search` description to:

```ts
description: 'Keyword candidate discovery across MBrain. Use for exact names, slugs, dates, and terms; chunks are not answer evidence. For factual answers, call retrieve_context or read_context to load canonical evidence.',
```

Change the `query` description to:

```ts
description: 'Semantic candidate discovery across MBrain. Use when the question is conceptual, cross-cutting, or keyword search missed likely pages; chunks are not answer evidence. For factual answers, call retrieve_context or read_context to load canonical evidence.',
```

Keep `get_page` unchanged as an explicit full-page canonical read.

- [ ] **Step 4: Update query skill workflow**

In `skills/query/SKILL.md`, replace the current `## Workflow` section with:

```md
## Workflow

1. **Probe context first** with `mbrain retrieve-context "<question>"` when the
   request needs a factual answer, broad synthesis, project/system context,
   personal recall, or historical evidence.
2. **Read canonical evidence** with `mbrain read-context --selectors '<json>'`
   using the `required_reads` returned by the probe.
3. **Answer only from canonical reads** unless the user asked only whether a
   term was mentioned. Search/query chunks are candidate pointers, not answer
   evidence.
4. **Use low-level search tools when debugging retrieval**:
   - Keyword search for specific names, dates, terms.
   - Semantic query for conceptual questions.
   - Structured queries, backlinks, and context maps for relational
     orientation.
5. **Synthesize answer** with citations. Every factual claim should trace to a
   canonical selector, page slug, section id, timeline entry, or source ref.
6. **Flag gaps.** If canonical reads do not support an answer, say what MBrain
   could not confirm instead of filling the gap.
```

In the `## Token-Budget Awareness` section, replace the first paragraph and bullets with:

```md
Search returns **chunks**, not full pages. Chunks are useful for recall, but
they can cut through meaning. Treat them as pointers to canonical reads.

- `mbrain search` / `mbrain query` return ranked candidate chunks.
- `mbrain retrieve-context` groups candidates and returns `required_reads`.
- `mbrain read-context` loads bounded canonical evidence for those selectors.
- **"Tell me about X"** -- read compiled truth and a small evidence sample.
- **"Did anyone mention Y?"** -- probe/search results can answer existence
  only when labeled as mention evidence.
```

- [ ] **Step 5: Update MCP documentation-only notes**

In `docs/MCP_INSTRUCTIONS.md`, add this bullet under `## Layered Enforcement` after the table:

```md
- Normal factual Q&A should prefer `retrieve_context -> read_context` because
  raw `search` and `query` chunks are candidate pointers. The runtime
  `MCP_INSTRUCTIONS` stays short; the detailed tool choice lives in operation
  descriptions and skills.
```

Do not change the runtime `MCP_INSTRUCTIONS` constant in this task.

- [ ] **Step 6: Run docs/contract tests and commit**

Run:

```bash
bun test test/mcp-instructions.test.ts test/e2e/skills.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/core/operations.ts skills/query/SKILL.md docs/MCP_INSTRUCTIONS.md test/mcp-instructions.test.ts
git commit -m "docs: clarify canonical retrieval contract"
```

---

## Task 7: Add Transcript-Level Scenario Coverage

**Files:**
- Create: `test/scenarios/s22-agentic-canonical-retrieval.test.ts`
- Modify: `test/scenarios/README.md`
- Test: `test/scenarios/s22-agentic-canonical-retrieval.test.ts`

- [ ] **Step 1: Write scenario transcript tests**

Create `test/scenarios/s22-agentic-canonical-retrieval.test.ts`:

```ts
/**
 * Scenario S22 — Agentic canonical retrieval.
 *
 * Falsifies the chunk-answer failure mode: an agent must not treat search/query
 * snippets or graph orientation as answer-grounding evidence. The accepted
 * transcript is probe -> read -> answer-ready.
 */

import { describe, expect, test } from 'bun:test';
import { allocateSqliteBrain, seedWorkTaskThread } from './helpers.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { buildStructuralContextMapEntry } from '../../src/core/services/context-map-service.ts';
import { operationsByName } from '../../src/core/operations.ts';

function opContext(engine: any) {
  return {
    engine,
    config: {},
    logger: console,
    dryRun: false,
  };
}

describe('S22 — agentic canonical retrieval', () => {
  test('chunk candidate transcript requires canonical read before factual answer', async () => {
    const handle = await allocateSqliteBrain('s22-chunk-read');

    try {
      await importFromContent(handle.engine, 'concepts/retrieval', [
        '---',
        'type: concept',
        'title: Retrieval',
        '---',
        '# Compiled Truth',
        'Retrieval chunks are candidate pointers, not answer evidence.',
        '[Source: User, direct message, 2026-05-07 09:30 KST]',
      ].join('\n'), { path: 'concepts/retrieval.md' });

      const probe = await operationsByName.retrieve_context!.handler(opContext(handle.engine), {
        query: 'candidate pointers answer evidence',
      }) as any;

      expect(probe.answerability.answerable_from_probe).toBe(false);
      expect(probe.answerability.must_read_context).toBe(true);
      expect(probe.required_reads.length).toBeGreaterThan(0);

      const read = await operationsByName.read_context!.handler(opContext(handle.engine), {
        selectors: JSON.stringify(probe.required_reads.slice(0, 1)),
      }) as any;

      expect(read.answer_ready.ready).toBe(true);
      expect(read.canonical_reads[0].text).toContain('candidate pointers');
      expect(read.canonical_reads[0].source_refs).toContain('User, direct message, 2026-05-07 09:30 KST');
    } finally {
      await handle.teardown();
    }
  });

  test('graph orientation transcript still requires canonical follow-through', async () => {
    const handle = await allocateSqliteBrain('s22-graph-read');

    try {
      await importFromContent(handle.engine, 'systems/mbrain', [
        '---',
        'type: system',
        'title: MBrain',
        '---',
        '# Overview',
        'See [[concepts/retrieval]].',
      ].join('\n'), { path: 'systems/mbrain.md' });
      await importFromContent(handle.engine, 'concepts/retrieval', [
        '---',
        'type: concept',
        'title: Retrieval',
        '---',
        '# Compiled Truth',
        'Retrieval is grounded by canonical reads.',
        '[Source: User, direct message, 2026-05-07 09:31 KST]',
      ].join('\n'), { path: 'concepts/retrieval.md' });
      await buildStructuralContextMapEntry(handle.engine);

      const probe = await operationsByName.retrieve_context!.handler(opContext(handle.engine), {
        query: 'retrieval',
        include_orientation: true,
      }) as any;

      expect(probe.orientation.derived_consulted.some((ref: string) => ref.startsWith('context_map:'))).toBe(true);
      expect(probe.answerability.must_read_context).toBe(true);
      expect(probe.required_reads.length).toBeGreaterThan(0);

      const read = await operationsByName.read_context!.handler(opContext(handle.engine), {
        selectors: JSON.stringify(probe.required_reads.slice(0, 2)),
      }) as any;

      expect(read.answer_ready.ready).toBe(true);
      expect(read.canonical_reads.some((entry: any) => entry.text.includes('canonical reads'))).toBe(true);
    } finally {
      await handle.teardown();
    }
  });

  test('task continuation transcript reads task state first', async () => {
    const handle = await allocateSqliteBrain('s22-task-state');

    try {
      await seedWorkTaskThread(handle.engine, 'task-agentic-retrieval', {
        workingSet: {
          active_paths: ['src/core/services/retrieve-context-service.ts'],
          active_symbols: ['retrieveContext'],
          blockers: [],
          open_questions: ['How should agents avoid answering from chunks?'],
          next_steps: ['Read task state before project files.'],
          verification_notes: ['Run S22 transcript scenario.'],
        },
      });

      const probe = await operationsByName.retrieve_context!.handler(opContext(handle.engine), {
        query: 'continue retrieval task',
        task_id: 'task-agentic-retrieval',
      }) as any;

      expect(probe.required_reads[0].kind).toBe('task_working_set');

      const read = await operationsByName.read_context!.handler(opContext(handle.engine), {
        selectors: JSON.stringify(probe.required_reads),
      }) as any;

      expect(read.answer_ready.ready).toBe(true);
      expect(read.canonical_reads[0].text).toContain('src/core/services/retrieve-context-service.ts');
      expect(read.canonical_reads[0].text).toContain('Read task state before project files.');
    } finally {
      await handle.teardown();
    }
  });

  test('personal scope defer transcript discloses no candidate snippets', async () => {
    const handle = await allocateSqliteBrain('s22-scope-defer');

    try {
      const probe = await operationsByName.retrieve_context!.handler(opContext(handle.engine), {
        query: 'Remember my morning routine',
        requested_scope: 'work',
      }) as any;

      expect(probe.scope_gate.policy).toBe('defer');
      expect(probe.candidates).toEqual([]);
      expect(probe.required_reads).toEqual([]);
    } finally {
      await handle.teardown();
    }
  });
});
```

- [ ] **Step 2: Run S22 scenario to verify failure or focused gaps**

Run:

```bash
bun test test/scenarios/s22-agentic-canonical-retrieval.test.ts
```

Expected: PASS if Tasks 1-6 were implemented correctly. If it fails, fix the specific service or operation gap that the assertion identifies, then rerun this command.

- [ ] **Step 3: Update scenario README**

In `test/scenarios/README.md`, add this row after S21:

```md
| S22 | `s22-agentic-canonical-retrieval.test.ts` | L2, L3, L6, I5 | ✅ green |
```

Add this sentence below the table:

```md
S22 pins the agent-facing retrieval transcript: candidate probe, bounded
canonical read, then answer-ready evidence. It prevents regressions where
chunks or context-map orientation become answer evidence.
```

- [ ] **Step 4: Run scenario tests and commit**

Run:

```bash
bun test test/scenarios/s22-agentic-canonical-retrieval.test.ts
bun run test:scenarios
```

Expected: PASS.

Commit:

```bash
git add test/scenarios/s22-agentic-canonical-retrieval.test.ts test/scenarios/README.md
git commit -m "test: add agentic canonical retrieval scenario"
```

---

## Task 8: Final Regression And Acceptance

**Files:**
- No production files unless a preceding test identifies a concrete defect.

- [ ] **Step 1: Run focused retrieval regression pack**

Run:

```bash
bun test test/retrieval-selector-service.test.ts test/read-context-service.test.ts test/retrieve-context-service.test.ts test/read-context-operations.test.ts test/retrieve-context-operations.test.ts test/mcp-instructions.test.ts test/broad-synthesis-route-service.test.ts test/precision-lookup-route-service.test.ts test/retrieval-request-planner-service.test.ts test/retrieval-route-selector-service.test.ts test/scenarios/s09-curated-over-map.test.ts test/scenarios/s14-retrieval-trace-fidelity.test.ts test/scenarios/s22-agentic-canonical-retrieval.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full scenario suite**

Run:

```bash
bun run test:scenarios
```

Expected: PASS with S1-S22 green.

- [ ] **Step 3: Run type/lint baseline if available**

Run:

```bash
bun test test/lint.test.ts test/parity.test.ts
```

Expected: PASS. If one of these tests is intentionally environment-sensitive, record the exact failure and continue only after confirming it is unrelated to this feature.

- [ ] **Step 4: Verify no scenario markers remain incomplete**

Run:

```bash
if rg -n "test\\.todo|todo\\(" test/scenarios; then
  echo "Scenario incomplete markers remain"
  exit 1
fi
```

Expected: no matches and exit 0.

- [ ] **Step 5: Commit any acceptance-only updates**

If Tasks 1-7 already committed every change and Step 1-4 only verified, do not create an empty commit. If a targeted fix was necessary, commit only those files:

```bash
git add src/core/types.ts src/core/services/retrieval-selector-service.ts src/core/services/read-context-service.ts src/core/services/retrieve-context-service.ts src/core/operations.ts skills/query/SKILL.md docs/MCP_INSTRUCTIONS.md test/retrieval-selector-service.test.ts test/read-context-service.test.ts test/retrieve-context-service.test.ts test/read-context-operations.test.ts test/retrieve-context-operations.test.ts test/mcp-instructions.test.ts test/scenarios/s22-agentic-canonical-retrieval.test.ts test/scenarios/README.md
git commit -m "fix: harden agentic canonical retrieval"
```

---

## Spec Coverage Matrix

| Spec Requirement | Implemented By |
|---|---|
| Progressive candidate discovery before canonical read | Task 3, Task 5, Task 7 |
| Bounded canonical page/section/timeline/task/profile reads | Task 2, Task 4 |
| Exact selectors skip fuzzy query/search hops | Task 1, Task 3, Task 7 |
| Chunks are candidate pointers, not answer evidence | Task 3, Task 5, Task 6, Task 7 |
| Context maps used as orientation, not authority | Task 3, Task 7 |
| Scope gate before personal/mixed disclosure | Task 3, Task 7 |
| Token budget and continuation selectors | Task 2 |
| Existing low-level tools remain available | Task 4, Task 5, Task 6 |
| Transcript-level agent behavior tests | Task 7 |
| Scenario and retrieval route compatibility | Task 8 |

## Rollback Plan

The implementation is additive. If a regression appears after deployment:

1. Remove `retrieve_context` and `read_context` from the exported `operations` list.
2. Revert the query skill changes that tell agents to prefer the new loop.
3. Keep selector/read service code in the branch for debugging if tests still pass.
4. Existing `search`, `query`, `get_page`, scenario routing, and context-map tools continue to work because their behavior is not replaced.
