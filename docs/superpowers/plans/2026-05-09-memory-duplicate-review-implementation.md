# Memory Duplicate Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic duplicate review for canonical pages and memory candidates before promotion, with an opt-in review result during candidate creation.

**Architecture:** Add one read-only duplicate review service in `src/core/services/` that compares a proposed memory payload against canonical pages and working-zone candidates using local text, title, tag, source-ref, and target-object signals. Expose the service through the operation registry, attach the review summary to promotion preflight, and keep candidate creation output unchanged unless callers explicitly request duplicate review. This phase avoids schema changes and uses existing engine list/get methods.

**Tech Stack:** TypeScript, Bun test runner, existing `BrainEngine` contract, SQLite-backed test fixtures, existing memory inbox operation registry.

---

## Naming Guard

Do not use the local reference project names in code, comments, commit messages, branch names, PR titles, or PR descriptions. Use direct capability names such as "duplicate review", "memory review", "near match", or "same target update".

## Assumptions

- Phase 1 is limited to duplicate review for pages and memory candidates.
- This phase does not add a database migration or persistent duplicate-review records.
- This phase does not automatically merge, supersede, or rewrite canonical memory.
- Deterministic scoring is enough for the first release. Vector or embedding-backed similarity can be layered behind the same service contract later.
- Promotion preflight should defer on unresolved likely duplicates, while a same-target update remains promotable if other governance checks pass.

## File Structure

- Create `src/core/services/duplicate-memory-review-service.ts`
  - Owns duplicate-review input/output types, candidate collection, page collection, scoring, thresholds, and preflight summary conversion.
- Modify `src/core/types.ts`
  - Adds one preflight reason and one compact duplicate-review summary shape to the public preflight result.
- Modify `src/core/services/memory-inbox-service.ts`
  - Calls duplicate review from `preflightPromoteMemoryCandidate` and defers likely duplicates.
- Modify `src/core/operations-memory-inbox.ts`
  - Registers a read-only `review_duplicate_memory` operation and adds opt-in `include_duplicate_review` support to `create_memory_candidate_entry`.
- Create `test/duplicate-memory-review-service.test.ts`
  - Covers service scoring, same-target behavior, candidate matching, no-match behavior, and read-only guarantees.
- Create `test/duplicate-memory-review-operations.test.ts`
  - Covers operation registration, parameter validation, page matching, and opt-in creation output.
- Create `test/duplicate-memory-review-preflight.test.ts`
  - Covers promotion preflight deferral for likely duplicates and allowance for same-target updates.
- Create `test/phase1-duplicate-review.test.ts`
  - Covers the end-to-end Phase 1 acceptance path through operations.

## Task 1: Add The Duplicate Review Service

**Files:**
- Create: `src/core/services/duplicate-memory-review-service.ts`
- Test: `test/duplicate-memory-review-service.test.ts`

- [ ] **Step 1: Write the failing service tests**

Create `test/duplicate-memory-review-service.test.ts` with these tests:

```ts
import { expect, test } from 'bun:test';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import {
  reviewDuplicateMemory,
  summarizeDuplicateReviewForPreflight,
} from '../src/core/services/duplicate-memory-review-service.ts';
import type { MemoryCandidateEntry } from '../src/core/types.ts';

function makeCandidate(
  id: string,
  overrides: Partial<MemoryCandidateEntry> = {},
): MemoryCandidateEntry {
  return {
    id,
    scope_id: 'workspace:default',
    candidate_type: 'note_update',
    proposed_content: 'Acme migration plan uses staged cutover with rollback notes.',
    source_refs: ['User, direct message, 2026-05-09 09:00 KST'],
    generated_by: 'manual',
    extraction_kind: 'manual',
    confidence_score: 0.8,
    importance_score: 0.7,
    recurrence_score: 0.1,
    sensitivity: 'work',
    status: 'staged_for_review',
    target_object_type: 'curated_note',
    target_object_id: 'projects/acme-migration',
    reviewed_at: null,
    review_reason: null,
    created_at: new Date('2026-05-09T00:00:00.000Z'),
    updated_at: new Date('2026-05-09T00:00:00.000Z'),
    ...overrides,
  };
}

test('duplicate review returns a likely duplicate for a near matching canonical page', async () => {
  const engine = new SQLiteEngine(':memory:');
  await engine.init();
  await engine.putPage({
    slug: 'projects/acme-migration',
    type: 'project',
    title: 'Acme Migration',
    content: 'The Acme migration plan uses staged cutover with rollback notes and operator checkpoints.',
    tags: ['migration', 'acme'],
  });
  await engine.addTag('projects/acme-migration', 'migration');
  await engine.addTag('projects/acme-migration', 'acme');

  const result = await reviewDuplicateMemory(engine, {
    scope_id: 'workspace:default',
    subject_kind: 'proposed_memory',
    title: 'Acme migration plan',
    content: 'Acme migration plan uses staged cutover with rollback notes.',
    tags: ['migration', 'acme'],
    source_refs: ['User, direct message, 2026-05-09 09:00 KST'],
    include_pages: true,
    include_candidates: false,
    limit: 5,
  });

  expect(result.decision).toBe('likely_duplicate');
  expect(result.matches[0]?.kind).toBe('page');
  expect(result.matches[0]?.id).toBe('projects/acme-migration');
  expect(result.matches[0]?.score).toBeGreaterThanOrEqual(result.thresholds.likely_duplicate);
  expect(result.summary_lines[0]).toContain('likely_duplicate');
});

test('duplicate review reports same target update for a candidate with the same target object', async () => {
  const engine = new SQLiteEngine(':memory:');
  await engine.init();
  await engine.createMemoryCandidateEntry(makeCandidate('existing-candidate', {
    proposed_content: 'Acme migration has a staged cutover and a rollback owner.',
    target_object_id: 'projects/acme-migration',
  }));

  const result = await reviewDuplicateMemory(engine, {
    scope_id: 'workspace:default',
    subject_kind: 'memory_candidate',
    subject_id: 'incoming-candidate',
    content: 'Acme migration should update the staged cutover notes.',
    candidate_type: 'note_update',
    target_object_type: 'curated_note',
    target_object_id: 'projects/acme-migration',
    include_pages: false,
    include_candidates: true,
    limit: 5,
  });

  expect(result.decision).toBe('same_target_update');
  expect(result.matches[0]?.id).toBe('existing-candidate');
  expect(result.matches[0]?.reasons).toContain('same target object');
});

test('duplicate review excludes the subject candidate id', async () => {
  const engine = new SQLiteEngine(':memory:');
  await engine.init();
  await engine.createMemoryCandidateEntry(makeCandidate('self-candidate'));

  const result = await reviewDuplicateMemory(engine, {
    scope_id: 'workspace:default',
    subject_kind: 'memory_candidate',
    subject_id: 'self-candidate',
    content: 'Acme migration plan uses staged cutover with rollback notes.',
    candidate_type: 'note_update',
    target_object_type: 'curated_note',
    target_object_id: 'projects/acme-migration',
    include_pages: false,
    include_candidates: true,
    limit: 5,
  });

  expect(result.decision).toBe('no_match');
  expect(result.matches).toEqual([]);
});

test('duplicate review returns no match for unrelated memory', async () => {
  const engine = new SQLiteEngine(':memory:');
  await engine.init();
  await engine.putPage({
    slug: 'concepts/coffee',
    type: 'concept',
    title: 'Coffee',
    content: 'Coffee notes cover brew temperature and grinder calibration.',
    tags: ['coffee'],
  });

  const result = await reviewDuplicateMemory(engine, {
    scope_id: 'workspace:default',
    subject_kind: 'proposed_memory',
    content: 'Deployment checklist requires release owner approval and rollback verification.',
    include_pages: true,
    include_candidates: true,
    limit: 5,
  });

  expect(result.decision).toBe('no_match');
  expect(result.matches).toEqual([]);
});

test('duplicate review does not mutate candidate inputs', async () => {
  const engine = new SQLiteEngine(':memory:');
  await engine.init();
  const candidate = makeCandidate('immutable-candidate');
  await engine.createMemoryCandidateEntry(candidate);

  const before = await engine.getMemoryCandidateEntry('immutable-candidate');
  await reviewDuplicateMemory(engine, {
    scope_id: 'workspace:default',
    subject_kind: 'proposed_memory',
    content: 'Acme migration plan uses staged cutover with rollback notes.',
    include_pages: false,
    include_candidates: true,
    limit: 5,
  });
  const after = await engine.getMemoryCandidateEntry('immutable-candidate');

  expect(after).toEqual(before);
});

test('preflight summary keeps only compact duplicate fields', async () => {
  const summary = summarizeDuplicateReviewForPreflight({
    decision: 'likely_duplicate',
    summary_lines: ['Duplicate review decision: likely_duplicate.'],
    thresholds: { possible_duplicate: 0.45, likely_duplicate: 0.72, same_target_update: 0.35 },
    matches: [
      {
        kind: 'page',
        id: 'projects/acme-migration',
        title: 'Acme Migration',
        score: 0.9,
        reasons: ['content overlap'],
      },
    ],
  });

  expect(summary).toEqual({
    decision: 'likely_duplicate',
    top_match: {
      kind: 'page',
      id: 'projects/acme-migration',
      score: 0.9,
      reasons: ['content overlap'],
    },
  });
});
```

- [ ] **Step 2: Run the service tests to verify they fail**

Run:

```bash
bun test test/duplicate-memory-review-service.test.ts
```

Expected: fails because `src/core/services/duplicate-memory-review-service.ts` does not exist.

- [ ] **Step 3: Add the service implementation**

Create `src/core/services/duplicate-memory-review-service.ts`:

```ts
import type { BrainEngine } from '../engine.ts';
import type {
  MemoryCandidateEntry,
  MemoryCandidateTargetObjectType,
  Page,
  PageType,
} from '../types.ts';

export type DuplicateMemorySubjectKind = 'page' | 'memory_candidate' | 'proposed_memory';
export type DuplicateMemoryMatchKind = 'page' | 'memory_candidate';
export type DuplicateMemoryDecision =
  | 'no_match'
  | 'possible_duplicate'
  | 'likely_duplicate'
  | 'same_target_update';

export interface DuplicateMemoryReviewInput {
  scope_id?: string;
  subject_kind: DuplicateMemorySubjectKind;
  subject_id?: string;
  title?: string | null;
  content: string;
  page_type?: PageType | null;
  tags?: string[];
  source_refs?: string[];
  candidate_type?: MemoryCandidateEntry['candidate_type'] | null;
  target_object_type?: MemoryCandidateTargetObjectType | null;
  target_object_id?: string | null;
  include_pages?: boolean;
  include_candidates?: boolean;
  limit?: number;
  exclude_ids?: string[];
}

export interface DuplicateMemoryReviewMatch {
  kind: DuplicateMemoryMatchKind;
  id: string;
  title?: string;
  score: number;
  reasons: string[];
  target_object_type?: MemoryCandidateTargetObjectType | null;
  target_object_id?: string | null;
  source_refs?: string[];
}

export interface DuplicateMemoryReviewResult {
  decision: DuplicateMemoryDecision;
  matches: DuplicateMemoryReviewMatch[];
  thresholds: {
    possible_duplicate: number;
    likely_duplicate: number;
    same_target_update: number;
  };
  summary_lines: string[];
}

export interface DuplicateMemoryReviewPreflightSummary {
  decision: DuplicateMemoryDecision;
  top_match?: {
    kind: DuplicateMemoryMatchKind;
    id: string;
    score: number;
    reasons: string[];
  };
}

const DEFAULT_SCOPE_ID = 'workspace:default';
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 25;
const PAGE_BATCH_SIZE = 100;
const CANDIDATE_BATCH_SIZE = 100;
const THRESHOLDS = {
  possible_duplicate: 0.45,
  likely_duplicate: 0.72,
  same_target_update: 0.35,
} as const;

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'has',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'to',
  'with',
]);

interface ComparisonPayload {
  id: string;
  kind: DuplicateMemoryMatchKind;
  title?: string;
  content: string;
  tags: string[];
  source_refs: string[];
  target_object_type?: MemoryCandidateTargetObjectType | null;
  target_object_id?: string | null;
}

export async function reviewDuplicateMemory(
  engine: BrainEngine,
  input: DuplicateMemoryReviewInput,
): Promise<DuplicateMemoryReviewResult> {
  const limit = normalizeLimit(input.limit);
  const excludeIds = new Set([...(input.exclude_ids ?? []), input.subject_id].filter(Boolean) as string[]);
  const subject = normalizeSubject(input);
  const candidates: ComparisonPayload[] = [];

  if (input.include_pages !== false) {
    candidates.push(...await collectPagePayloads(engine, excludeIds));
  }
  if (input.include_candidates !== false) {
    candidates.push(...await collectMemoryCandidatePayloads(
      engine,
      input.scope_id ?? DEFAULT_SCOPE_ID,
      excludeIds,
    ));
  }

  const matches = candidates
    .map((candidate) => scorePayload(subject, candidate))
    .filter((match) => match.score >= THRESHOLDS.possible_duplicate)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
  const decision = chooseDecision(subject, matches);

  return {
    decision,
    matches,
    thresholds: { ...THRESHOLDS },
    summary_lines: buildSummaryLines(decision, matches),
  };
}

export function summarizeDuplicateReviewForPreflight(
  review: DuplicateMemoryReviewResult,
): DuplicateMemoryReviewPreflightSummary {
  const top = review.matches[0];
  if (!top) {
    return { decision: review.decision };
  }
  return {
    decision: review.decision,
    top_match: {
      kind: top.kind,
      id: top.id,
      score: top.score,
      reasons: [...top.reasons],
    },
  };
}

function normalizeSubject(input: DuplicateMemoryReviewInput): ComparisonPayload {
  return {
    id: input.subject_id ?? '__proposed_memory__',
    kind: input.subject_kind === 'page' ? 'page' : 'memory_candidate',
    title: normalizeOptionalString(input.title),
    content: input.content,
    tags: normalizeStringArray(input.tags),
    source_refs: normalizeStringArray(input.source_refs),
    target_object_type: input.target_object_type ?? null,
    target_object_id: normalizeOptionalString(input.target_object_id),
  };
}

async function collectPagePayloads(
  engine: BrainEngine,
  excludeIds: Set<string>,
): Promise<ComparisonPayload[]> {
  const payloads: ComparisonPayload[] = [];
  for (let offset = 0; ; offset += PAGE_BATCH_SIZE) {
    const pages = await engine.listPages({ limit: PAGE_BATCH_SIZE, offset });
    for (const page of pages) {
      if (excludeIds.has(page.slug)) {
        continue;
      }
      payloads.push(await pageToPayload(engine, page));
    }
    if (pages.length < PAGE_BATCH_SIZE) {
      break;
    }
  }
  return payloads;
}

async function pageToPayload(engine: BrainEngine, page: Page): Promise<ComparisonPayload> {
  const tags = await engine.getTags(page.slug);
  return {
    id: page.slug,
    kind: 'page',
    title: page.title,
    content: page.content,
    tags,
    source_refs: [],
  };
}

async function collectMemoryCandidatePayloads(
  engine: BrainEngine,
  scopeId: string,
  excludeIds: Set<string>,
): Promise<ComparisonPayload[]> {
  const payloads: ComparisonPayload[] = [];
  for (let offset = 0; ; offset += CANDIDATE_BATCH_SIZE) {
    const entries = await engine.listMemoryCandidateEntries({
      scope_id: scopeId,
      limit: CANDIDATE_BATCH_SIZE,
      offset,
    });
    for (const entry of entries) {
      if (excludeIds.has(entry.id)) {
        continue;
      }
      payloads.push({
        id: entry.id,
        kind: 'memory_candidate',
        title: entry.target_object_id ?? entry.candidate_type,
        content: entry.proposed_content,
        tags: [],
        source_refs: [...entry.source_refs],
        target_object_type: entry.target_object_type,
        target_object_id: entry.target_object_id,
      });
    }
    if (entries.length < CANDIDATE_BATCH_SIZE) {
      break;
    }
  }
  return payloads;
}

function scorePayload(
  subject: ComparisonPayload,
  candidate: ComparisonPayload,
): DuplicateMemoryReviewMatch {
  const subjectTokens = tokenize(`${subject.title ?? ''} ${subject.content}`);
  const candidateTokens = tokenize(`${candidate.title ?? ''} ${candidate.content}`);
  const contentScore = jaccard(subjectTokens, candidateTokens);
  const titleScore = jaccard(tokenize(subject.title ?? ''), tokenize(candidate.title ?? ''));
  const tagScore = jaccard(new Set(subject.tags.map(normalizeKey)), new Set(candidate.tags.map(normalizeKey)));
  const sourceScore = jaccard(new Set(subject.source_refs.map(normalizeKey)), new Set(candidate.source_refs.map(normalizeKey)));
  const sameTarget = Boolean(
    subject.target_object_type
      && subject.target_object_id
      && subject.target_object_type === candidate.target_object_type
      && subject.target_object_id === candidate.target_object_id,
  );
  const weighted = (
    contentScore * 0.58
    + titleScore * 0.16
    + tagScore * 0.1
    + sourceScore * 0.08
    + (sameTarget ? 0.18 : 0)
  );
  const score = Math.min(1, Number(weighted.toFixed(6)));
  const reasons = buildReasons({ contentScore, titleScore, tagScore, sourceScore, sameTarget });

  return {
    kind: candidate.kind,
    id: candidate.id,
    title: candidate.title,
    score,
    reasons,
    target_object_type: candidate.target_object_type,
    target_object_id: candidate.target_object_id,
    source_refs: candidate.source_refs,
  };
}

function chooseDecision(
  subject: ComparisonPayload,
  matches: DuplicateMemoryReviewMatch[],
): DuplicateMemoryDecision {
  const top = matches[0];
  if (!top) {
    return 'no_match';
  }
  const sameTarget = Boolean(
    subject.target_object_type
      && subject.target_object_id
      && subject.target_object_type === top.target_object_type
      && subject.target_object_id === top.target_object_id,
  );
  if (sameTarget && top.score >= THRESHOLDS.same_target_update) {
    return 'same_target_update';
  }
  if (top.score >= THRESHOLDS.likely_duplicate) {
    return 'likely_duplicate';
  }
  return 'possible_duplicate';
}

function buildReasons(input: {
  contentScore: number;
  titleScore: number;
  tagScore: number;
  sourceScore: number;
  sameTarget: boolean;
}): string[] {
  const reasons: string[] = [];
  if (input.contentScore >= 0.45) {
    reasons.push('content overlap');
  }
  if (input.titleScore >= 0.4) {
    reasons.push('title overlap');
  }
  if (input.tagScore > 0) {
    reasons.push('shared tags');
  }
  if (input.sourceScore > 0) {
    reasons.push('shared source refs');
  }
  if (input.sameTarget) {
    reasons.push('same target object');
  }
  return reasons.length > 0 ? reasons : ['weak text overlap'];
}

function buildSummaryLines(
  decision: DuplicateMemoryDecision,
  matches: DuplicateMemoryReviewMatch[],
): string[] {
  const lines = [`Duplicate review decision: ${decision}.`];
  const top = matches[0];
  if (top) {
    lines.push(`Top match: ${top.kind}/${top.id} scored ${top.score}.`);
    lines.push(`Reasons: ${top.reasons.join(', ')}.`);
  } else {
    lines.push('No duplicate candidates met the review threshold.');
  }
  return lines;
}

function tokenize(value: string): Set<string> {
  const tokens = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
  return new Set(tokens);
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const entry of left) {
    if (right.has(entry)) {
      intersection += 1;
    }
  }
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function normalizeStringArray(value: string[] | undefined): string[] {
  return Array.isArray(value)
    ? value.map((entry) => entry.trim()).filter((entry) => entry.length > 0)
    : [];
}

function normalizeOptionalString(value: string | null | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_LIMIT;
  }
  return Math.max(0, Math.min(MAX_LIMIT, Math.floor(value)));
}
```

- [ ] **Step 4: Run the service tests to verify they pass**

Run:

```bash
bun test test/duplicate-memory-review-service.test.ts
```

Expected: all tests in `test/duplicate-memory-review-service.test.ts` pass.

- [ ] **Step 5: Commit the service**

Run:

```bash
git add src/core/services/duplicate-memory-review-service.ts test/duplicate-memory-review-service.test.ts
git commit -m "feat: add memory duplicate review service"
```

Expected: one commit containing only the service and its service-level tests.

## Task 2: Expose Duplicate Review Through Operations

**Files:**
- Modify: `src/core/operations-memory-inbox.ts`
- Test: `test/duplicate-memory-review-operations.test.ts`

- [ ] **Step 1: Write failing operation tests**

Create `test/duplicate-memory-review-operations.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { operations } from '../src/core/operations.ts';
import { createMemoryInboxOperations, DEFAULT_MEMORY_INBOX_SCOPE_ID } from '../src/core/operations-memory-inbox.ts';
import { OperationError } from '../src/core/operations.ts';

function findOperation(name: string) {
  const operation = operations.find((entry) => entry.name === name);
  if (!operation) {
    throw new Error(`operation not found: ${name}`);
  }
  return operation;
}

test('review_duplicate_memory is registered in local and global operation lists', () => {
  const local = createMemoryInboxOperations({
    OperationError,
    defaultScopeId: DEFAULT_MEMORY_INBOX_SCOPE_ID,
  });

  expect(local.some((operation) => operation.name === 'review_duplicate_memory')).toBe(true);
  expect(operations.some((operation) => operation.name === 'review_duplicate_memory')).toBe(true);
});

test('review_duplicate_memory returns a likely duplicate page match', async () => {
  const engine = new SQLiteEngine(':memory:');
  await engine.init();
  await engine.putPage({
    slug: 'projects/acme-migration',
    type: 'project',
    title: 'Acme Migration',
    content: 'The Acme migration plan uses staged cutover with rollback notes and operator checkpoints.',
    tags: ['migration', 'acme'],
  });
  await engine.addTag('projects/acme-migration', 'migration');
  await engine.addTag('projects/acme-migration', 'acme');

  const operation = findOperation('review_duplicate_memory');
  const result = await operation.handler(
    { engine, dryRun: false },
    {
      subject_kind: 'proposed_memory',
      title: 'Acme migration plan',
      content: 'Acme migration plan uses staged cutover with rollback notes.',
      tags: ['migration', 'acme'],
      include_pages: true,
      include_candidates: false,
      limit: 5,
    },
  );

  expect((result as any).decision).toBe('likely_duplicate');
  expect((result as any).matches[0].id).toBe('projects/acme-migration');
});

test('review_duplicate_memory validates subject kind and content', async () => {
  const engine = new SQLiteEngine(':memory:');
  await engine.init();
  const operation = findOperation('review_duplicate_memory');

  await expect(operation.handler(
    { engine, dryRun: false },
    { subject_kind: 'unknown', content: 'valid content' },
  )).rejects.toMatchObject({ code: 'invalid_params' });

  await expect(operation.handler(
    { engine, dryRun: false },
    { subject_kind: 'proposed_memory', content: '   ' },
  )).rejects.toMatchObject({ code: 'invalid_params' });
});

test('create_memory_candidate_entry can include duplicate review when requested', async () => {
  const engine = new SQLiteEngine(':memory:');
  await engine.init();
  await engine.putPage({
    slug: 'projects/acme-migration',
    type: 'project',
    title: 'Acme Migration',
    content: 'The Acme migration plan uses staged cutover with rollback notes and operator checkpoints.',
    tags: ['migration', 'acme'],
  });

  const operation = findOperation('create_memory_candidate_entry');
  const result = await operation.handler(
    { engine, dryRun: false },
    {
      id: 'candidate-with-review',
      candidate_type: 'note_update',
      proposed_content: 'Acme migration plan uses staged cutover with rollback notes.',
      source_refs: ['User, direct message, 2026-05-09 09:00 KST'],
      status: 'captured',
      target_object_type: 'curated_note',
      target_object_id: 'projects/acme-migration',
      include_duplicate_review: true,
    },
  );

  expect((result as any).candidate.id).toBe('candidate-with-review');
  expect((result as any).duplicate_review.decision).toBe('same_target_update');
});

test('create_memory_candidate_entry keeps existing output shape by default', async () => {
  const engine = new SQLiteEngine(':memory:');
  await engine.init();

  const operation = findOperation('create_memory_candidate_entry');
  const result = await operation.handler(
    { engine, dryRun: false },
    {
      id: 'candidate-default-shape',
      candidate_type: 'fact',
      proposed_content: 'Release owner is Sam.',
      source_refs: ['User, direct message, 2026-05-09 09:00 KST'],
    },
  );

  expect((result as any).id).toBe('candidate-default-shape');
  expect((result as any).candidate).toBeUndefined();
  expect((result as any).duplicate_review).toBeUndefined();
});
```

- [ ] **Step 2: Run operation tests to verify they fail**

Run:

```bash
bun test test/duplicate-memory-review-operations.test.ts
```

Expected: fails because `review_duplicate_memory` is not registered and `include_duplicate_review` is not supported.

- [ ] **Step 3: Import the service and add operation constants**

In `src/core/operations-memory-inbox.ts`, add this import near the other service imports:

```ts
import {
  reviewDuplicateMemory,
  type DuplicateMemorySubjectKind,
} from './services/duplicate-memory-review-service.ts';
```

Add this constant near the existing value lists:

```ts
const DUPLICATE_MEMORY_SUBJECT_KIND_VALUES = ['page', 'memory_candidate', 'proposed_memory'] as const satisfies readonly DuplicateMemorySubjectKind[];
```

- [ ] **Step 4: Add array normalization helpers**

In `src/core/operations-memory-inbox.ts`, add these helpers near `normalizeSourceRefs`:

```ts
function normalizeOptionalStringArray(
  deps: { OperationError: OperationErrorCtor },
  field: string,
  value: unknown,
): string[] {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw invalidParams(deps, `${field} must be an array of strings`);
  }
  const normalized = value.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  if (normalized.length !== value.length) {
    throw invalidParams(deps, `${field} entries must be non-empty strings`);
  }
  return normalized;
}

function normalizeBoolean(value: unknown): boolean {
  return value === true;
}
```

- [ ] **Step 5: Register `review_duplicate_memory`**

In `createMemoryInboxOperations`, add this operation before `create_memory_candidate_entry`:

```ts
  const review_duplicate_memory: Operation = {
    name: 'review_duplicate_memory',
    description: 'Review a proposed memory payload against existing pages and memory candidates for likely duplicates.',
    params: {
      scope_id: { type: 'string', description: `Memory scope id (default: ${deps.defaultScopeId})` },
      subject_kind: {
        type: 'string',
        required: true,
        description: 'Kind of memory payload being reviewed',
        enum: [...DUPLICATE_MEMORY_SUBJECT_KIND_VALUES],
      },
      subject_id: { type: 'string', description: 'Optional id or slug to exclude from matching' },
      title: { type: 'string', description: 'Optional title for matching' },
      content: { type: 'string', required: true, description: 'Memory content to compare' },
      page_type: { type: 'string', description: 'Optional page type for the subject', enum: [...PAGE_TYPE_VALUES] },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional subject tags' },
      source_refs: { type: 'array', items: { type: 'string' }, description: 'Optional subject provenance strings' },
      candidate_type: { type: 'string', description: 'Optional candidate type', enum: [...MEMORY_CANDIDATE_TYPE_VALUES] },
      target_object_type: { type: 'string', description: 'Optional target object type', enum: [...MEMORY_CANDIDATE_TARGET_OBJECT_TYPE_VALUES] },
      target_object_id: { type: 'string', description: 'Optional target object id' },
      include_pages: { type: 'boolean', description: 'Whether canonical pages are included (default true)' },
      include_candidates: { type: 'boolean', description: 'Whether memory candidates are included (default true)' },
      limit: { type: 'number', description: 'Maximum matches to return' },
      exclude_ids: { type: 'array', items: { type: 'string' }, description: 'Additional page slugs or candidate ids to exclude' },
    },
    handler: async (ctx, p) => {
      const content = normalizeOptionalNonEmptyString(deps, 'content', p.content);
      if (!content) {
        throw invalidParams(deps, 'content must be a non-empty string');
      }
      return reviewDuplicateMemory(ctx.engine, {
        scope_id: typeof p.scope_id === 'string' ? p.scope_id : deps.defaultScopeId,
        subject_kind: requireEnumValue(deps, 'subject_kind', p.subject_kind, DUPLICATE_MEMORY_SUBJECT_KIND_VALUES),
        subject_id: normalizeOptionalNonEmptyString(deps, 'subject_id', p.subject_id) ?? undefined,
        title: normalizeOptionalNonEmptyString(deps, 'title', p.title),
        content,
        page_type: optionalEnumValue(deps, 'page_type', p.page_type, PAGE_TYPE_VALUES) ?? null,
        tags: normalizeOptionalStringArray(deps, 'tags', p.tags),
        source_refs: normalizeOptionalStringArray(deps, 'source_refs', p.source_refs),
        candidate_type: optionalEnumValue(deps, 'candidate_type', p.candidate_type, MEMORY_CANDIDATE_TYPE_VALUES) ?? null,
        target_object_type: optionalEnumValue(deps, 'target_object_type', p.target_object_type, MEMORY_CANDIDATE_TARGET_OBJECT_TYPE_VALUES) ?? null,
        target_object_id: normalizeOptionalTargetObjectId(deps, p.target_object_id),
        include_pages: p.include_pages !== false,
        include_candidates: p.include_candidates !== false,
        limit: normalizeLimit(deps, p.limit),
        exclude_ids: normalizeOptionalStringArray(deps, 'exclude_ids', p.exclude_ids),
      });
    },
    cliHints: { name: 'review-duplicate-memory', aliases: { n: 'limit' } },
  };
```

Add `review_duplicate_memory` to the returned operation array before `create_memory_candidate_entry`.

- [ ] **Step 6: Add opt-in duplicate review to candidate creation**

Add this parameter to `create_memory_candidate_entry.params`:

```ts
      include_duplicate_review: {
        type: 'boolean',
        description: 'When true, return a duplicate review alongside the created candidate.',
      },
```

Replace the final `return createMemoryCandidateEntryWithStatusEvent(...)` block with:

```ts
      const candidateInput = {
        id,
        scope_id: scopeId,
        candidate_type: requireEnumValue(deps, 'candidate_type', p.candidate_type, MEMORY_CANDIDATE_TYPE_VALUES),
        proposed_content: String(p.proposed_content),
        source_refs: normalizeSourceRefs(deps, p),
        generated_by: optionalEnumValue(deps, 'generated_by', p.generated_by, MEMORY_CANDIDATE_GENERATED_BY_VALUES) ?? 'manual',
        extraction_kind: optionalEnumValue(deps, 'extraction_kind', p.extraction_kind, MEMORY_CANDIDATE_EXTRACTION_KIND_VALUES) ?? 'manual',
        confidence_score: typeof p.confidence_score === 'number' ? p.confidence_score : 0.5,
        importance_score: typeof p.importance_score === 'number' ? p.importance_score : 0.5,
        recurrence_score: typeof p.recurrence_score === 'number' ? p.recurrence_score : 0,
        sensitivity: optionalEnumValue(deps, 'sensitivity', p.sensitivity, MEMORY_CANDIDATE_SENSITIVITY_VALUES) ?? 'work',
        status,
        target_object_type: optionalEnumValue(deps, 'target_object_type', p.target_object_type, MEMORY_CANDIDATE_TARGET_OBJECT_TYPE_VALUES) ?? null,
        target_object_id: normalizeOptionalTargetObjectId(deps, p.target_object_id),
        reviewed_at: normalizeOptionalIsoTimestamp(deps, 'reviewed_at', p.reviewed_at) ?? null,
        review_reason: typeof p.review_reason === 'string' ? p.review_reason : null,
        interaction_id: interactionId,
      };
      const created = await createMemoryCandidateEntryWithStatusEvent(ctx.engine, candidateInput);
      if (!normalizeBoolean(p.include_duplicate_review)) {
        return created;
      }
      const duplicateReview = await reviewDuplicateMemory(ctx.engine, {
        scope_id: created.scope_id,
        subject_kind: 'memory_candidate',
        subject_id: created.id,
        content: created.proposed_content,
        source_refs: created.source_refs,
        candidate_type: created.candidate_type,
        target_object_type: created.target_object_type,
        target_object_id: created.target_object_id,
        include_pages: true,
        include_candidates: true,
        limit: 5,
        exclude_ids: [created.id],
      });
      return { candidate: created, duplicate_review: duplicateReview };
```

Keep the dry-run response unchanged.

- [ ] **Step 7: Run operation tests to verify they pass**

Run:

```bash
bun test test/duplicate-memory-review-operations.test.ts
```

Expected: all operation tests pass.

- [ ] **Step 8: Commit operation exposure**

Run:

```bash
git add src/core/operations-memory-inbox.ts test/duplicate-memory-review-operations.test.ts
git commit -m "feat: expose memory duplicate review operation"
```

Expected: one commit containing operation registry changes and operation tests.

## Task 3: Integrate Duplicate Review Into Promotion Preflight

**Files:**
- Modify: `src/core/types.ts`
- Modify: `src/core/services/memory-inbox-service.ts`
- Test: `test/duplicate-memory-review-preflight.test.ts`

- [ ] **Step 1: Write failing preflight tests**

Create `test/duplicate-memory-review-preflight.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { preflightPromoteMemoryCandidate } from '../src/core/services/memory-inbox-service.ts';
import type { MemoryCandidateEntryInput } from '../src/core/types.ts';

function candidateInput(
  id: string,
  overrides: Partial<MemoryCandidateEntryInput> = {},
): MemoryCandidateEntryInput {
  return {
    id,
    scope_id: 'workspace:default',
    candidate_type: 'note_update',
    proposed_content: 'Acme migration plan uses staged cutover with rollback notes.',
    source_refs: ['User, direct message, 2026-05-09 09:00 KST'],
    generated_by: 'manual',
    extraction_kind: 'manual',
    confidence_score: 0.8,
    importance_score: 0.7,
    recurrence_score: 0.1,
    sensitivity: 'work',
    status: 'staged_for_review',
    target_object_type: 'curated_note',
    target_object_id: 'projects/acme-migration',
    ...overrides,
  };
}

test('promotion preflight defers a likely duplicate against a different canonical page', async () => {
  const engine = new SQLiteEngine(':memory:');
  await engine.init();
  await engine.putPage({
    slug: 'projects/acme-existing',
    type: 'project',
    title: 'Acme Existing Migration',
    content: 'Acme migration plan uses staged cutover with rollback notes.',
    tags: ['migration'],
  });
  await engine.createMemoryCandidateEntry(candidateInput('candidate-duplicate', {
    target_object_id: 'projects/acme-new',
  }));

  const result = await preflightPromoteMemoryCandidate(engine, { id: 'candidate-duplicate' });

  expect(result.decision).toBe('defer');
  expect(result.reasons).toContain('candidate_possible_duplicate');
  expect(result.duplicate_review?.decision).toBe('likely_duplicate');
  expect(result.duplicate_review?.top_match?.id).toBe('projects/acme-existing');
});

test('promotion preflight allows same target updates when other checks pass', async () => {
  const engine = new SQLiteEngine(':memory:');
  await engine.init();
  await engine.putPage({
    slug: 'projects/acme-migration',
    type: 'project',
    title: 'Acme Migration',
    content: 'Acme migration plan uses staged cutover with rollback notes.',
    tags: ['migration'],
  });
  await engine.createMemoryCandidateEntry(candidateInput('candidate-same-target'));

  const result = await preflightPromoteMemoryCandidate(engine, { id: 'candidate-same-target' });

  expect(result.decision).toBe('allow');
  expect(result.reasons).toEqual(['candidate_ready_for_promotion']);
  expect(result.duplicate_review?.decision).toBe('same_target_update');
});
```

- [ ] **Step 2: Run preflight tests to verify they fail**

Run:

```bash
bun test test/duplicate-memory-review-preflight.test.ts
```

Expected: fails because the preflight result has no duplicate review field and no duplicate reason.

- [ ] **Step 3: Add public preflight duplicate types**

In `src/core/types.ts`, add the new reason to `MemoryCandidatePromotionPreflightReason` before `candidate_ready_for_promotion`:

```ts
  | 'candidate_possible_duplicate'
```

Add these interfaces before `MemoryCandidatePromotionPreflightInput`:

```ts
export type MemoryCandidateDuplicateReviewDecision =
  | 'no_match'
  | 'possible_duplicate'
  | 'likely_duplicate'
  | 'same_target_update';

export interface MemoryCandidateDuplicateReviewSummary {
  decision: MemoryCandidateDuplicateReviewDecision;
  top_match?: {
    kind: 'page' | 'memory_candidate';
    id: string;
    score: number;
    reasons: string[];
  };
}
```

Add the optional summary to `MemoryCandidatePromotionPreflightResult`:

```ts
  duplicate_review?: MemoryCandidateDuplicateReviewSummary;
```

- [ ] **Step 4: Wire preflight to duplicate review**

In `src/core/services/memory-inbox-service.ts`, add this import:

```ts
import {
  reviewDuplicateMemory,
  summarizeDuplicateReviewForPreflight,
} from './duplicate-memory-review-service.ts';
```

Inside `preflightPromoteMemoryCandidate`, after the existing deterministic checks and before `reasons` is computed, add:

```ts
  const duplicateReview = await reviewDuplicateMemory(engine, {
    scope_id: entry.scope_id,
    subject_kind: 'memory_candidate',
    subject_id: entry.id,
    content: entry.proposed_content,
    source_refs: entry.source_refs,
    candidate_type: entry.candidate_type,
    target_object_type: entry.target_object_type,
    target_object_id: entry.target_object_id,
    include_pages: true,
    include_candidates: true,
    limit: 5,
    exclude_ids: [entry.id],
  });
  const duplicateSummary = summarizeDuplicateReviewForPreflight(duplicateReview);
  if (duplicateReview.decision === 'likely_duplicate') {
    deferReasons.push('candidate_possible_duplicate');
  }
```

Add the summary to the returned object:

```ts
    duplicate_review: duplicateSummary,
```

Add one summary line after the target line:

```ts
      `Duplicate review decision: ${duplicateReview.decision}.`,
```

- [ ] **Step 5: Add reason formatting**

In `src/core/services/memory-inbox-service.ts`, update `formatReasonLabel` so the new reason is readable:

```ts
    case 'candidate_possible_duplicate':
      return 'possible duplicate';
```

- [ ] **Step 6: Run preflight tests to verify they pass**

Run:

```bash
bun test test/duplicate-memory-review-preflight.test.ts
```

Expected: both preflight tests pass.

- [ ] **Step 7: Run existing memory inbox preflight regression tests**

Run:

```bash
bun test test/memory-inbox-service.test.ts test/scenarios/s06-promotion-requires-provenance.test.ts
```

Expected: existing preflight and promotion-requires-provenance tests pass.

- [ ] **Step 8: Commit preflight integration**

Run:

```bash
git add src/core/types.ts src/core/services/memory-inbox-service.ts test/duplicate-memory-review-preflight.test.ts
git commit -m "feat: defer duplicate memory promotion"
```

Expected: one commit containing preflight type and service changes.

## Task 4: Add End-To-End Phase 1 Acceptance Coverage

**Files:**
- Create: `test/phase1-duplicate-review.test.ts`

- [ ] **Step 1: Write the acceptance test**

Create `test/phase1-duplicate-review.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { operations } from '../src/core/operations.ts';

function findOperation(name: string) {
  const operation = operations.find((entry) => entry.name === name);
  if (!operation) {
    throw new Error(`operation not found: ${name}`);
  }
  return operation;
}

test('phase 1 duplicate review detects near duplicate before promotion', async () => {
  const engine = new SQLiteEngine(':memory:');
  await engine.init();
  await engine.putPage({
    slug: 'projects/acme-existing',
    type: 'project',
    title: 'Acme Existing Migration',
    content: 'Acme migration plan uses staged cutover with rollback notes and operator checkpoints.',
    tags: ['migration', 'acme'],
  });

  const create = findOperation('create_memory_candidate_entry');
  const created = await create.handler(
    { engine, dryRun: false },
    {
      id: 'candidate-phase1',
      candidate_type: 'note_update',
      proposed_content: 'Acme migration plan uses staged cutover with rollback notes.',
      source_refs: ['User, direct message, 2026-05-09 09:00 KST'],
      status: 'staged_for_review',
      sensitivity: 'work',
      target_object_type: 'curated_note',
      target_object_id: 'projects/acme-new',
      include_duplicate_review: true,
    },
  );
  expect((created as any).duplicate_review.decision).toBe('likely_duplicate');

  const preflight = findOperation('preflight_promote_memory_candidate');
  const result = await preflight.handler(
    { engine, dryRun: false },
    { id: 'candidate-phase1' },
  );

  expect((result as any).decision).toBe('defer');
  expect((result as any).reasons).toContain('candidate_possible_duplicate');
  expect((result as any).duplicate_review.top_match.id).toBe('projects/acme-existing');
});
```

- [ ] **Step 2: Run the acceptance test**

Run:

```bash
bun test test/phase1-duplicate-review.test.ts
```

Expected: the Phase 1 acceptance test passes.

- [ ] **Step 3: Run the focused duplicate review suite**

Run:

```bash
bun test test/duplicate-memory-review-service.test.ts test/duplicate-memory-review-operations.test.ts test/duplicate-memory-review-preflight.test.ts test/phase1-duplicate-review.test.ts
```

Expected: all duplicate-review tests pass together.

- [ ] **Step 4: Run adjacent regression tests**

Run:

```bash
bun test test/memory-inbox-service.test.ts test/memory-inbox-operations.test.ts test/memory-candidate-dedup-service.test.ts test/memory-candidate-scoring-operations.test.ts
```

Expected: adjacent memory inbox, candidate dedup, and candidate scoring tests pass.

- [ ] **Step 5: Commit acceptance coverage**

Run:

```bash
git add test/phase1-duplicate-review.test.ts
git commit -m "test: cover memory duplicate review flow"
```

Expected: one commit containing only the acceptance test.

## Task 5: Self-Review And Final Verification

**Files:**
- Inspect: all changed files from Tasks 1-4

- [ ] **Step 1: Verify no guarded reference names entered changed files**

Run:

```bash
git diff --name-only HEAD~4..HEAD
rg -n "O[p]enKB|m[e]mex" src/core test docs/superpowers/plans/2026-05-09-memory-duplicate-review-implementation.md
```

Expected: the first command lists only Phase 1 files. The second command prints no matches.

- [ ] **Step 2: Verify no placeholder text remains in the plan or code comments**

Run:

```bash
rg -n "T[B]D|T[O]DO|implement late[r]|fill in detail[s]" src/core test docs/superpowers/plans/2026-05-09-memory-duplicate-review-implementation.md
```

Expected: no matches in the duplicate-review files or this plan. Existing unrelated matches outside the changed files should not be edited.

- [ ] **Step 3: Run TypeScript checks if the repository exposes them**

Run:

```bash
bun run typecheck
```

Expected: typecheck passes. If the repository has no `typecheck` script, record the exact package-script error in the final handoff and rely on the focused Bun tests below.

- [ ] **Step 4: Run final focused tests**

Run:

```bash
bun test test/duplicate-memory-review-service.test.ts test/duplicate-memory-review-operations.test.ts test/duplicate-memory-review-preflight.test.ts test/phase1-duplicate-review.test.ts test/memory-inbox-service.test.ts test/memory-inbox-operations.test.ts test/memory-candidate-dedup-service.test.ts test/memory-candidate-scoring-operations.test.ts
```

Expected: all listed tests pass.

- [ ] **Step 5: Inspect the final diff**

Run:

```bash
git diff --stat
git diff -- src/core/services/duplicate-memory-review-service.ts src/core/types.ts src/core/services/memory-inbox-service.ts src/core/operations-memory-inbox.ts
```

Expected: the diff only adds duplicate review, operation exposure, preflight summary output, and tests. No unrelated cleanup is present.

- [ ] **Step 6: Commit any verification-only fixups**

If Tasks 1-4 left follow-up fixes staged or unstaged, commit them with:

```bash
git add src/core/services/duplicate-memory-review-service.ts src/core/types.ts src/core/services/memory-inbox-service.ts src/core/operations-memory-inbox.ts test/duplicate-memory-review-service.test.ts test/duplicate-memory-review-operations.test.ts test/duplicate-memory-review-preflight.test.ts test/phase1-duplicate-review.test.ts
git commit -m "fix: stabilize memory duplicate review"
```

Expected: this command creates a commit only if verification required code or test fixes. If there are no changes, do not create an empty commit.

## Final Acceptance Criteria

- `review_duplicate_memory` is available through `createMemoryInboxOperations` and the global `operations` registry.
- Duplicate review returns `no_match`, `possible_duplicate`, `likely_duplicate`, or `same_target_update` with ranked matches and reasons.
- Candidate creation returns the existing candidate shape by default.
- Candidate creation returns `{ candidate, duplicate_review }` only when `include_duplicate_review` is true.
- Promotion preflight includes `duplicate_review` and defers unresolved likely duplicates with `candidate_possible_duplicate`.
- Same-target updates do not block promotion when all other preflight checks pass.
- No schema migration is introduced.
- No automatic merge, supersession, page rewrite, or canonical mutation is added by duplicate review.
- Focused duplicate-review tests and adjacent memory inbox regression tests pass.
