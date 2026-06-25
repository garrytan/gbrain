import { describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BrainEngine } from '../src/core/engine.ts';
import { OperationError, operations } from '../src/core/operations.ts';
import type { Operation, OperationContext } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { SUBBRAIN_REGISTRY_CONFIG_KEY } from '../src/core/subbrains.ts';

const STALE_HASH = 'a'.repeat(64);
const MISSING_HASH = 'b'.repeat(64);
const DEFAULT_PAGE_SOURCE = '[Source: Page write precondition fixture, 2026-04-25 12:00 PM KST]';
const DEFAULT_WRITE_SESSION_SOURCE_REF = 'Source: write session precondition test';

function routedContentHash(content: string): string {
  return createHash('sha256').update(content.trim()).digest('hex');
}

function getOperation(name: string): Operation {
  const operation = operations.find((candidate) => candidate.name === name);
  if (!operation) {
    throw new Error(`${name} operation is missing`);
  }
  return operation;
}

async function withSqliteEngine<T>(fn: (ctx: OperationContext) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'mbrain-page-write-precondition-'));
  const engine = new SQLiteEngine();
  try {
    await engine.connect({
      engine: 'sqlite',
      database_path: join(dir, 'brain.db'),
    });
    await engine.initSchema();
    return await fn({
      engine: engine as unknown as BrainEngine,
      config: {} as any,
      logger: console,
      dryRun: false,
    });
  } finally {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

function pageContent(title: string, body: string, timeline: string): string {
  const citedTimeline = timeline.includes('[Source:') ? timeline : `${timeline} ${DEFAULT_PAGE_SOURCE}`;
  return `---
type: concept
title: ${title}
---

${body}

---

${citedTimeline}
	`;
}

function sourceCitation(sourceRef: string): string {
  return `[Source: ${sourceRef.replace(/^Source:\s*/i, '')}]`;
}

function writeSessionPageContent(title: string, body: string, sourceRef = DEFAULT_WRITE_SESSION_SOURCE_REF): string {
  return `---
type: concept
title: ${title}
---

${body} ${sourceCitation(sourceRef)}
`;
}

async function createWriteSession(
  ctx: OperationContext,
  input: {
    id: string;
    routeDecisionId: string;
    targetSlug: string;
    expectedContentHash: string | null;
    sourceRefs?: string[];
    scopeId?: string;
    expiresAt?: Date;
    routedContent?: string;
  },
) {
  const governanceMetadata =
    input.routedContent === undefined
      ? { source: 'test' }
      : {
          source: 'test',
          routed_content: input.routedContent,
          routed_content_hash: routedContentHash(input.routedContent),
        };
  return await (ctx.engine as any).createMemoryWriteSession({
    id: input.id,
    route_decision_id: input.routeDecisionId,
    scope_id: input.scopeId ?? 'workspace:default',
    actor: 'mbrain:route_memory_writeback',
    target_slug: input.targetSlug,
    target_object_type: 'curated_note',
    expected_content_hash: input.expectedContentHash,
    source_refs: input.sourceRefs ?? [DEFAULT_WRITE_SESSION_SOURCE_REF],
    route_decision: 'canonical_write_allowed',
    intended_operation: 'put_page',
    route_reasons: ['canonical_write_allowed'],
    missing_requirements: [],
    governance_metadata: governanceMetadata,
    expires_at: input.expiresAt ?? new Date(Date.now() + 60_000),
  });
}

describe('put_page content hash preconditions and mutation ledger', () => {
  test('invalid expected_content_hash rejects before mutation or ledger recording', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/invalid-precondition-hash';

      await put.handler(ctx, {
        slug,
        content: pageContent('Invalid Precondition Hash', 'Original compiled truth.', '- 2026-04-25 | Initial evidence.'),
        expected_content_hash: null,
      });
      const before = await ctx.engine.getPage(slug);
      expect(before?.content_hash).toBeTruthy();

      let error: unknown;
      try {
        await put.handler(ctx, {
          slug,
          content: pageContent('Invalid Precondition Hash', 'This content should not be written.', '- 2026-04-25 | Invalid hash attempted update.'),
          expected_content_hash: 'not-a-sha',
          session_id: 'put-page-invalid-hash-session',
          source_refs: ['Source: invalid hash test'],
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(OperationError);
      expect((error as OperationError).code).toBe('invalid_params');
      expect((error as Error).message).toContain('expected_content_hash');
      expect(await ctx.engine.getPage(slug)).toMatchObject({
        content_hash: before?.content_hash,
        compiled_truth: before?.compiled_truth,
      });
      expect(
        await ctx.engine.listMemoryMutationEvents({
          session_id: 'put-page-invalid-hash-session',
        }),
      ).toEqual([]);
    });
  });

  test('missing expected_content_hash rejects public put_page before existing page updates', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/precondition-required-for-update';
      const initial = pageContent('Precondition Required For Update', 'Original compiled truth.', '- 2026-04-25 | Initial evidence.');
      const updated = pageContent(
        'Precondition Required For Update',
        'Updated compiled truth should not be written.',
        '- 2026-04-25 | Updated evidence should not appear.',
      );

      await put.handler(ctx, {
        slug,
        content: initial,
        expected_content_hash: null,
      });
      const before = await ctx.engine.getPage(slug);
      expect(before?.content_hash).toBeTruthy();

      await expect(
        put.handler(ctx, {
          slug,
          content: updated,
          session_id: 'put-page-missing-precondition-session',
          source_refs: ['Source: missing expected hash update test'],
        }),
      ).rejects.toMatchObject({
        code: 'invalid_params',
        message: expect.stringContaining('route_first'),
      });

      expect(await ctx.engine.getPage(slug)).toMatchObject({
        content_hash: before?.content_hash,
        compiled_truth: before?.compiled_truth,
      });
    });
  });

  test('stale expected_content_hash rejects without mutating existing page and records one conflict event', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/precondition-stale';
      const sessionId = 'put-page-stale-session';
      const initial = pageContent('Precondition Stale', 'Original compiled truth.', '- 2026-04-25 | Initial evidence.');
      const updated = pageContent('Precondition Stale', 'Updated compiled truth should not be written.', '- 2026-04-25 | Updated evidence should not appear.');

      await put.handler(ctx, {
        slug,
        content: initial,
        expected_content_hash: null,
      });
      const before = await ctx.engine.getPage(slug);
      expect(before?.content_hash).toBeTruthy();

      let error: unknown;
      try {
        await put.handler(ctx, {
          slug,
          content: updated,
          expected_content_hash: STALE_HASH,
          session_id: sessionId,
          source_refs: ['Source: stale precondition test'],
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(OperationError);
      expect((error as OperationError).code).toBe('write_conflict');
      expect((error as Error).message).toContain('content hash mismatch');

      const after = await ctx.engine.getPage(slug);
      expect(after?.content_hash).toBe(before?.content_hash);
      expect(after?.compiled_truth).toBe(before?.compiled_truth);
      expect(after?.compiled_truth).not.toContain('Updated compiled truth');

      const events = await ctx.engine.listMemoryMutationEvents({
        session_id: sessionId,
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        session_id: sessionId,
        realm_id: 'work',
        actor: 'mbrain:put_page',
        operation: 'put_page',
        target_kind: 'page',
        target_id: slug,
        scope_id: 'workspace:default',
        source_refs: ['Source: stale precondition test'],
        expected_target_snapshot_hash: STALE_HASH,
        current_target_snapshot_hash: before?.content_hash,
        result: 'conflict',
        dry_run: false,
      });
      expect(events[0].conflict_info).toEqual({
        reason: 'content_hash_mismatch',
        expected_content_hash: STALE_HASH,
        current_content_hash: before?.content_hash,
      });
    });
  });

  test('expected_content_hash on missing page rejects and records a conflict event', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/precondition-missing';
      const sessionId = 'put-page-missing-session';

      let error: unknown;
      try {
        await put.handler(ctx, {
          slug,
          content: pageContent('Precondition Missing', 'This page should not be created.', '- 2026-04-25 | Missing page attempted update.'),
          expected_content_hash: MISSING_HASH,
          session_id: sessionId,
          source_refs: ['Source: missing precondition test'],
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(OperationError);
      expect((error as OperationError).code).toBe('write_conflict');
      expect((error as Error).message).toContain('Page not found');

      expect(await ctx.engine.getPage(slug)).toBeNull();

      const events = await ctx.engine.listMemoryMutationEvents({
        session_id: sessionId,
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        session_id: sessionId,
        operation: 'put_page',
        target_kind: 'page',
        target_id: slug,
        result: 'conflict',
        expected_target_snapshot_hash: MISSING_HASH,
        current_target_snapshot_hash: null,
        source_refs: ['Source: missing precondition test'],
      });
      expect(events[0].conflict_info).toEqual({
        reason: 'missing_page',
        expected_content_hash: MISSING_HASH,
      });
    });
  });

  test('null expected_content_hash creates only when the page is absent', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/precondition-create-only';

      await put.handler(ctx, {
        slug,
        content: pageContent('Precondition Create Only', 'This page should be created only when absent.', '- 2026-04-25 | Missing target creation.'),
        expected_content_hash: null,
        session_id: 'put-page-create-only-session',
        source_refs: ['Source: create-only precondition test'],
      });

      const created = await ctx.engine.getPage(slug);
      expect(created?.compiled_truth).toBe('This page should be created only when absent.');
      expect(created?.content_hash).toBeTruthy();
    });
  });

  test('null expected_content_hash rejects existing pages without overwriting them', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/precondition-create-only-conflict';

      await put.handler(ctx, {
        slug,
        content: pageContent('Precondition Create Only Conflict', 'Original compiled truth.', '- 2026-04-25 | Initial evidence.'),
        expected_content_hash: null,
      });
      const before = await ctx.engine.getPage(slug);

      await expect(
        put.handler(ctx, {
          slug,
          content: pageContent(
            'Precondition Create Only Conflict',
            'This content should not overwrite an existing page.',
            '- 2026-04-25 | Conflicting create-only write.',
          ),
          expected_content_hash: null,
          session_id: 'put-page-create-only-conflict-session',
          source_refs: ['Source: create-only conflict test'],
        }),
      ).rejects.toMatchObject({ code: 'write_conflict' });

      const after = await ctx.engine.getPage(slug);
      expect(after?.content_hash).toBe(before?.content_hash);
      expect(after?.compiled_truth).toBe('Original compiled truth.');
      const events = await ctx.engine.listMemoryMutationEvents({
        session_id: 'put-page-create-only-conflict-session',
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.conflict_info).toEqual({
        reason: 'page_exists',
        expected_content_hash: null,
        current_content_hash: before?.content_hash,
      });
    });
  });

  test('conflict ledger failure preserves write_conflict and does not mutate the page', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/conflict-ledger-failure';

      await put.handler(ctx, {
        slug,
        content: pageContent('Conflict Ledger Failure', 'Original compiled truth.', '- 2026-04-25 | Initial evidence.'),
        expected_content_hash: null,
      });
      const before = await ctx.engine.getPage(slug);
      expect(before?.content_hash).toBeTruthy();

      const originalCreateMemoryMutationEvent = ctx.engine.createMemoryMutationEvent.bind(ctx.engine);
      ctx.engine.createMemoryMutationEvent = async (input) => {
        if (input.session_id === 'put-page-conflict-ledger-failure-session') {
          throw new Error('ledger write failed');
        }
        return originalCreateMemoryMutationEvent(input);
      };

      let error: unknown;
      try {
        await put.handler(ctx, {
          slug,
          content: pageContent('Conflict Ledger Failure', 'This content should not be written.', '- 2026-04-25 | Failed conflict audit attempted update.'),
          expected_content_hash: STALE_HASH,
          session_id: 'put-page-conflict-ledger-failure-session',
          source_refs: ['Source: conflict ledger failure test'],
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(OperationError);
      expect((error as OperationError).code).toBe('write_conflict');
      expect((error as Error).message).toContain('content hash mismatch');
      expect(await ctx.engine.getPage(slug)).toMatchObject({
        content_hash: before?.content_hash,
        compiled_truth: before?.compiled_truth,
      });
      expect(
        await ctx.engine.listMemoryMutationEvents({
          session_id: 'put-page-conflict-ledger-failure-session',
        }),
      ).toEqual([]);
    });
  });

  test('stale expected_content_hash records conflict ledger after precondition transaction exits', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/conflict-ledger-outside-transaction';
      const sessionId = 'put-page-conflict-ledger-outside-transaction-session';

      await put.handler(ctx, {
        slug,
        content: pageContent('Conflict Ledger Outside Transaction', 'Original compiled truth.', '- 2026-04-25 | Initial evidence.'),
        expected_content_hash: null,
      });
      const before = await ctx.engine.getPage(slug);
      expect(before?.content_hash).toBeTruthy();

      let inTransaction = false;
      const conflictLedgerTransactionStates: boolean[] = [];
      const originalTransaction = ctx.engine.transaction.bind(ctx.engine);
      const originalCreateMemoryMutationEvent = ctx.engine.createMemoryMutationEvent.bind(ctx.engine);

      ctx.engine.transaction = async <T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> => {
        return originalTransaction(async (tx) => {
          inTransaction = true;
          try {
            return await fn(tx);
          } finally {
            inTransaction = false;
          }
        });
      };

      ctx.engine.createMemoryMutationEvent = async (input) => {
        if (input.session_id === sessionId && input.result === 'conflict') {
          conflictLedgerTransactionStates.push(inTransaction);
        }
        return originalCreateMemoryMutationEvent(input);
      };

      let error: unknown;
      try {
        await put.handler(ctx, {
          slug,
          content: pageContent(
            'Conflict Ledger Outside Transaction',
            'This content should not be written.',
            '- 2026-04-25 | Transaction state attempted update.',
          ),
          expected_content_hash: STALE_HASH,
          session_id: sessionId,
          source_refs: ['Source: conflict ledger transaction state test'],
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(OperationError);
      expect((error as OperationError).code).toBe('write_conflict');
      expect(conflictLedgerTransactionStates).toEqual([false]);
      expect(await ctx.engine.getPage(slug)).toMatchObject({
        content_hash: before?.content_hash,
        compiled_truth: before?.compiled_truth,
      });
    });
  });

  test('correct expected_content_hash allows update and records applied event with final hash', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/precondition-correct';
      const sessionId = 'put-page-correct-session';

      await put.handler(ctx, {
        slug,
        content: pageContent('Precondition Correct', 'Original compiled truth.', '- 2026-04-25 | Initial evidence.'),
        expected_content_hash: null,
      });
      const before = await ctx.engine.getPage(slug);
      expect(before?.content_hash).toBeTruthy();

      const result = (await put.handler(ctx, {
        slug,
        content: pageContent('Precondition Correct', 'Updated compiled truth is written.', '- 2026-04-25 | Updated evidence appears.'),
        expected_content_hash: before?.content_hash,
        session_id: sessionId,
        realm_id: 'realm-correct',
        actor: 'agent-correct',
        scope_id: 'scope-correct',
        source_refs: ['Source: correct precondition test'],
      })) as any;

      expect(result).toMatchObject({ slug, status: 'created_or_updated' });

      const after = await ctx.engine.getPage(slug);
      expect(after?.content_hash).toBeTruthy();
      expect(after?.content_hash).not.toBe(before?.content_hash);
      expect(after?.compiled_truth).toContain('Updated compiled truth is written.');

      const events = await ctx.engine.listMemoryMutationEvents({
        session_id: sessionId,
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        session_id: sessionId,
        realm_id: 'realm-correct',
        actor: 'agent-correct',
        operation: 'put_page',
        target_kind: 'page',
        target_id: slug,
        scope_id: 'scope-correct',
        result: 'applied',
        expected_target_snapshot_hash: before?.content_hash,
        current_target_snapshot_hash: after?.content_hash,
        source_refs: ['Source: correct precondition test'],
        dry_run: false,
      });
      expect(events[0].conflict_info).toBeNull();
    });
  });

  test('write_session_id allows one routed put_page and records route ids in the ledger', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/write-session-correct';
      const sessionId = 'memory-write-session:correct';
      const routeDecisionId = 'route-memory-writeback:correct';
      const sourceRefs = ['Source: write session routed update test'];
      const routedContent = 'Updated compiled truth is authorized by a write session.';

      await put.handler(ctx, {
        slug,
        content: pageContent('Write Session Correct', 'Original compiled truth.', '- 2026-04-25 | Initial evidence.'),
        expected_content_hash: null,
      });
      const before = await ctx.engine.getPage(slug);
      expect(before?.content_hash).toBeTruthy();
      await createWriteSession(ctx, {
        id: sessionId,
        routeDecisionId,
        targetSlug: slug,
        expectedContentHash: before?.content_hash ?? null,
        sourceRefs,
        routedContent,
      });

      const result = (await put.handler(ctx, {
        slug,
        content: writeSessionPageContent('Write Session Correct', routedContent, sourceRefs[0]),
        write_session_id: sessionId,
      })) as any;

      expect(result).toMatchObject({ slug, status: 'created_or_updated' });
      const after = await ctx.engine.getPage(slug);
      expect(after?.compiled_truth).toContain('Updated compiled truth is authorized by a write session.');
      const session = await (ctx.engine as any).getMemoryWriteSession(sessionId);
      expect(session).toMatchObject({
        id: sessionId,
        status: 'applied',
        consumed_by_event_id: expect.any(String),
      });
      expect(session.consumed_at).toBeInstanceOf(Date);

      const events = await ctx.engine.listMemoryMutationEvents({
        operation: 'put_page',
        target_id: slug,
      });
      const applied = events.find((event) => event.session_id === sessionId);
      expect(applied).toMatchObject({
        result: 'applied',
        expected_target_snapshot_hash: before?.content_hash,
        current_target_snapshot_hash: after?.content_hash,
        source_refs: sourceRefs,
      });
      expect(applied?.metadata).toMatchObject({
        precondition_supplied: true,
        route_decision_id: routeDecisionId,
        write_session_id: sessionId,
      });

      await expect(
        put.handler(ctx, {
          slug,
          content: writeSessionPageContent('Write Session Correct', 'This second write must not reuse the consumed session.'),
          write_session_id: sessionId,
        }),
      ).rejects.toThrow(/write session.*applied|already consumed/i);
    });
  });

  test('write session rejects extra unrouted compiled truth', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/write-session-extra-claim';
      const sessionId = 'memory-write-session:extra-claim';
      const routedContent = 'Only this routed claim is authorized.';
      await createWriteSession(ctx, {
        id: sessionId,
        routeDecisionId: 'route-memory-writeback:extra-claim',
        targetSlug: slug,
        expectedContentHash: null,
        routedContent,
      });

      await expect(
        put.handler(ctx, {
          slug,
          content: writeSessionPageContent('Write Session Extra Claim', `${routedContent}\n\nAn extra unrouted canonical claim must not be written.`),
          write_session_id: sessionId,
        }),
      ).rejects.toThrow(/routed content/i);

      expect(await ctx.engine.getPage(slug)).toBeNull();
      const session = await (ctx.engine as any).getMemoryWriteSession(sessionId);
      expect(session).toMatchObject({
        status: 'abandoned',
        status_reason: expect.stringContaining('routed_content_mismatch'),
      });
    });
  });

  test('write session rejects extra unrouted timeline content', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/write-session-extra-timeline';
      const sessionId = 'memory-write-session:extra-timeline';
      const routedContent = 'Only the routed compiled truth is authorized.';
      await createWriteSession(ctx, {
        id: sessionId,
        routeDecisionId: 'route-memory-writeback:extra-timeline',
        targetSlug: slug,
        expectedContentHash: null,
        routedContent,
      });

      await expect(
        put.handler(ctx, {
          slug,
          content: pageContent(
            'Write Session Extra Timeline',
            `${routedContent} ${sourceCitation(DEFAULT_WRITE_SESSION_SOURCE_REF)}`,
            `- 2026-04-25 | Extra unrouted timeline claim. ${sourceCitation(DEFAULT_WRITE_SESSION_SOURCE_REF)}`,
          ),
          write_session_id: sessionId,
        }),
      ).rejects.toThrow(/timeline/i);

      expect(await ctx.engine.getPage(slug)).toBeNull();
      const session = await (ctx.engine as any).getMemoryWriteSession(sessionId);
      expect(session).toMatchObject({
        status: 'abandoned',
        status_reason: expect.stringContaining('routed_timeline_not_authorized'),
      });
    });
  });

  test('write session requires every routed source ref to appear in page citations', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/write-session-missing-source-ref';
      const sessionId = 'memory-write-session:missing-source-ref';
      const sourceRefs = ['Source: routed source A', 'Source: routed source B'];
      const routedContent = 'All routed source refs must remain visible.';
      await createWriteSession(ctx, {
        id: sessionId,
        routeDecisionId: 'route-memory-writeback:missing-source-ref',
        targetSlug: slug,
        expectedContentHash: null,
        sourceRefs,
        routedContent,
      });

      await expect(
        put.handler(ctx, {
          slug,
          content: writeSessionPageContent('Write Session Missing Source Ref', routedContent, sourceRefs[0]),
          write_session_id: sessionId,
        }),
      ).rejects.toThrow(/source_refs/i);

      expect(await ctx.engine.getPage(slug)).toBeNull();
      const session = await (ctx.engine as any).getMemoryWriteSession(sessionId);
      expect(session).toMatchObject({
        status: 'abandoned',
        status_reason: expect.stringContaining('source_refs_mismatch'),
      });
    });
  });

  test('write session rejects unrouted page metadata and tags on create', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/write-session-forged-metadata';
      const sessionId = 'memory-write-session:forged-metadata';
      const routedContent = 'Only this routed claim is authorized.';
      await createWriteSession(ctx, {
        id: sessionId,
        routeDecisionId: 'route-memory-writeback:forged-metadata',
        targetSlug: slug,
        expectedContentHash: null,
        routedContent,
      });

      await expect(
        put.handler(ctx, {
          slug,
          content: `---
type: person
title: Forged Type
priority: forged
tags: [unauthorized-tag]
---

${routedContent} ${sourceCitation(DEFAULT_WRITE_SESSION_SOURCE_REF)}
`,
          write_session_id: sessionId,
        }),
      ).rejects.toThrow(/metadata|frontmatter|tags/i);

      expect(await ctx.engine.getPage(slug)).toBeNull();
      const session = await (ctx.engine as any).getMemoryWriteSession(sessionId);
      expect(session).toMatchObject({
        status: 'abandoned',
        status_reason: expect.stringContaining('page_metadata_mismatch'),
      });
    });
  });

  test('write session rejects unrouted page metadata and tag changes on update', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/write-session-existing-metadata';
      const sessionId = 'memory-write-session:existing-metadata';
      const routedContent = 'Updated claim is routed but metadata is not.';
      await put.handler(ctx, {
        slug,
        content: `---
type: concept
title: Write Session Existing Metadata
priority: kept
tags: [kept-tag]
---

Original compiled truth. ${DEFAULT_PAGE_SOURCE}
`,
        expected_content_hash: null,
      });
      const before = await ctx.engine.getPage(slug);
      expect(before?.frontmatter).toEqual({ priority: 'kept' });
      expect(await ctx.engine.getTags(slug)).toEqual(['kept-tag']);
      await createWriteSession(ctx, {
        id: sessionId,
        routeDecisionId: 'route-memory-writeback:existing-metadata',
        targetSlug: slug,
        expectedContentHash: before?.content_hash ?? null,
        routedContent,
      });

      await expect(
        put.handler(ctx, {
          slug,
          content: `---
type: concept
title: Write Session Existing Metadata
priority: forged
tags: [kept-tag, unauthorized-tag]
---

${routedContent} ${sourceCitation(DEFAULT_WRITE_SESSION_SOURCE_REF)}
`,
          write_session_id: sessionId,
        }),
      ).rejects.toThrow(/metadata|frontmatter|tags/i);

      const after = await ctx.engine.getPage(slug);
      expect(after?.compiled_truth).toContain('Original compiled truth.');
      expect(after?.frontmatter).toEqual({ priority: 'kept' });
      expect(await ctx.engine.getTags(slug)).toEqual(['kept-tag']);
      const session = await (ctx.engine as any).getMemoryWriteSession(sessionId);
      expect(session).toMatchObject({
        status: 'abandoned',
        status_reason: expect.stringContaining('page_metadata_mismatch'),
      });
    });
  });

  test('write session update preserves existing timeline evidence', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/write-session-preserve-timeline';
      const sessionId = 'memory-write-session:preserve-timeline';
      const routedContent = 'Routed compiled truth update must preserve existing timeline.';
      const timeline = '- 2026-06-25 | Seed timeline evidence must remain after routed update.';
      await put.handler(ctx, {
        slug,
        content: pageContent('Write Session Preserve Timeline', 'Original compiled truth.', timeline),
        expected_content_hash: null,
      });
      const before = await ctx.engine.getPage(slug);
      expect(before?.timeline).toContain('Seed timeline evidence');
      await createWriteSession(ctx, {
        id: sessionId,
        routeDecisionId: 'route-memory-writeback:preserve-timeline',
        targetSlug: slug,
        expectedContentHash: before?.content_hash ?? null,
        routedContent,
      });

      await put.handler(ctx, {
        slug,
        content: writeSessionPageContent('Write Session Preserve Timeline', routedContent),
        write_session_id: sessionId,
      });

      const after = await ctx.engine.getPage(slug);
      expect(after?.compiled_truth).toContain(routedContent);
      expect(after?.timeline).toContain('Seed timeline evidence');
    });
  });

  test('write session audit identifiers cannot be caller overridden', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/write-session-audit-ids';
      const sessionId = 'memory-write-session:audit-ids';
      const routeDecisionId = 'route-memory-writeback:audit-ids';
      const routedContent = 'Audit identifiers come from the write session.';
      await createWriteSession(ctx, {
        id: sessionId,
        routeDecisionId,
        targetSlug: slug,
        expectedContentHash: null,
        routedContent,
      });

      await put.handler(ctx, {
        slug,
        content: writeSessionPageContent('Write Session Audit Ids', routedContent),
        write_session_id: sessionId,
        session_id: 'attacker:chosen-session',
        realm_id: 'attacker:realm',
        metadata: {
          session_id: 'attacker:metadata-session',
          realm_id: 'attacker:metadata-realm',
          actor: 'attacker:metadata-actor',
          scope_id: 'attacker:metadata-scope',
          source_refs: ['Source: attacker metadata'],
          route_decision_id: 'attacker:route',
          write_session_id: 'attacker:write-session',
          user_note: 'kept',
        },
      });

      const events = await ctx.engine.listMemoryMutationEvents({
        operation: 'put_page',
        target_id: slug,
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          session_id: sessionId,
          realm_id: 'work',
          metadata: expect.objectContaining({
            route_decision_id: routeDecisionId,
            write_session_id: sessionId,
            session_id: sessionId,
            realm_id: 'work',
            actor: 'mbrain:route_memory_writeback',
            scope_id: 'workspace:default',
            source_refs: [DEFAULT_WRITE_SESSION_SOURCE_REF],
            user_note: 'kept',
          }),
        }),
      );
    });
  });

  test('write session records personal realm for personal scoped writes', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/write-session-personal-realm';
      const sessionId = 'memory-write-session:personal-realm';
      const routedContent = 'Personal scoped write sessions use personal realm.';
      await createWriteSession(ctx, {
        id: sessionId,
        routeDecisionId: 'route-memory-writeback:personal-realm',
        targetSlug: slug,
        expectedContentHash: null,
        scopeId: 'personal:default',
        routedContent,
      });

      await put.handler(ctx, {
        slug,
        content: writeSessionPageContent('Write Session Personal Realm', routedContent),
        write_session_id: sessionId,
        realm_id: 'attacker:realm',
      });

      const events = await ctx.engine.listMemoryMutationEvents({
        session_id: sessionId,
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        realm_id: 'personal',
        scope_id: 'personal:default',
        metadata: expect.objectContaining({
          realm_id: 'personal',
          scope_id: 'personal:default',
        }),
      });
    });
  });

  test('write session cannot be consumed for a different target slug', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const sessionId = 'memory-write-session:wrong-slug';
      await createWriteSession(ctx, {
        id: sessionId,
        routeDecisionId: 'route-memory-writeback:wrong-slug',
        targetSlug: 'concepts/write-session-source',
        expectedContentHash: null,
      });

      await expect(
        put.handler(ctx, {
          slug: 'ideas/write-session-source',
          content: pageContent(
            'Write Session Wrong Slug',
            'This page must not be written with a session for another slug.',
            '- 2026-04-25 | Wrong slug attempt evidence.',
          ),
          write_session_id: sessionId,
        }),
      ).rejects.toThrow(/write session.*target/i);

      expect(await ctx.engine.getPage('ideas/write-session-source')).toBeNull();
      const session = await (ctx.engine as any).getMemoryWriteSession(sessionId);
      expect(session).toMatchObject({
        status: 'abandoned',
        status_reason: expect.stringContaining('target_slug_mismatch'),
      });
    });
  });

  test('expired write session fails closed and is marked expired', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/write-session-expired';
      const sessionId = 'memory-write-session:expired';
      await createWriteSession(ctx, {
        id: sessionId,
        routeDecisionId: 'route-memory-writeback:expired',
        targetSlug: slug,
        expectedContentHash: null,
        expiresAt: new Date(Date.now() - 60_000),
      });

      await expect(
        put.handler(ctx, {
          slug,
          content: pageContent('Write Session Expired', 'Expired sessions must not write canonical memory.', '- 2026-04-25 | Expired attempt evidence.'),
          write_session_id: sessionId,
        }),
      ).rejects.toThrow(/write session.*expired/i);

      expect(await ctx.engine.getPage(slug)).toBeNull();
      const session = await (ctx.engine as any).getMemoryWriteSession(sessionId);
      expect(session).toMatchObject({
        status: 'expired',
        status_reason: expect.stringContaining('expired_before_put_page'),
      });
    });
  });

  test('write session without routed content binding fails closed', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/write-session-missing-routed-content';
      const sessionId = 'memory-write-session:missing-routed-content';
      await createWriteSession(ctx, {
        id: sessionId,
        routeDecisionId: 'route-memory-writeback:missing-routed-content',
        targetSlug: slug,
        expectedContentHash: null,
      });

      await expect(
        put.handler(ctx, {
          slug,
          content: pageContent(
            'Write Session Missing Routed Content',
            'A write session without routed content metadata must not authorize this page.',
            '- 2026-04-25 | Missing routed content attempt evidence.',
          ),
          write_session_id: sessionId,
        }),
      ).rejects.toThrow(/routed content/i);

      expect(await ctx.engine.getPage(slug)).toBeNull();
      const session = await (ctx.engine as any).getMemoryWriteSession(sessionId);
      expect(session).toMatchObject({
        status: 'abandoned',
        status_reason: expect.stringContaining('routed_content_missing'),
      });
    });
  });

  test('stale write session hash rejects and is marked superseded', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/write-session-stale';
      const sessionId = 'memory-write-session:stale';
      const routedContent = 'Stale routed write must not overwrite the newer page.';

      await put.handler(ctx, {
        slug,
        content: pageContent('Write Session Stale', 'Original compiled truth.', '- 2026-04-25 | Initial evidence.'),
        expected_content_hash: null,
      });
      const before = await ctx.engine.getPage(slug);
      expect(before?.content_hash).toBeTruthy();
      await createWriteSession(ctx, {
        id: sessionId,
        routeDecisionId: 'route-memory-writeback:stale',
        targetSlug: slug,
        expectedContentHash: before?.content_hash ?? null,
        routedContent,
      });
      await put.handler(ctx, {
        slug,
        content: pageContent('Write Session Stale', 'Independent update happens before session consumption.', '- 2026-04-25 | Independent update evidence.'),
        expected_content_hash: before?.content_hash,
        source_refs: ['Source: stale write session independent update'],
      });

      await expect(
        put.handler(ctx, {
          slug,
          content: writeSessionPageContent('Write Session Stale', routedContent),
          write_session_id: sessionId,
        }),
      ).rejects.toMatchObject({ code: 'write_conflict' });

      const session = await (ctx.engine as any).getMemoryWriteSession(sessionId);
      expect(session).toMatchObject({
        status: 'superseded',
        consumed_by_event_id: expect.any(String),
        status_reason: expect.stringContaining('content_hash_mismatch'),
      });
      const conflicts = await ctx.engine.listMemoryMutationEvents({
        operation: 'put_page',
        target_id: slug,
        result: 'conflict',
      });
      expect(conflicts).toContainEqual(
        expect.objectContaining({
          id: session.consumed_by_event_id,
          session_id: sessionId,
          result: 'conflict',
        }),
      );
    });
  });

  test('put_page writes the markdown repo file before importing the DB projection when repo is provided', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-put-page-repo-'));
      const slug = 'concepts/markdown-first-write';
      const content = pageContent('Markdown First Write', 'Markdown-first compiled truth is written to disk.', '- 2026-04-25 | Markdown-first write evidence.');

      try {
        const result = (await put.handler(ctx, {
          slug,
          content,
          repo: repoPath,
          expected_content_hash: null,
          session_id: 'put-page-markdown-first-write-session',
          source_refs: ['Source: markdown-first write test'],
        })) as any;

        const filePath = join(repoPath, 'concepts', 'markdown-first-write.md');
        expect(result).toMatchObject({ slug, status: 'created_or_updated' });
        expect(existsSync(filePath)).toBe(true);
        expect(readFileSync(filePath, 'utf-8')).toBe(content);

        const page = await ctx.engine.getPage(slug);
        expect(page?.compiled_truth).toContain('Markdown-first compiled truth is written to disk.');
        const manifest = await ctx.engine.getNoteManifestEntry('workspace:default', slug);
        expect(manifest?.path).toBe('concepts/markdown-first-write.md');
      } finally {
        rmSync(repoPath, { recursive: true, force: true });
      }
    });
  });

  test('put_page rejects when the markdown repo file changed independently from the DB page', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-put-page-conflict-'));
      const slug = 'concepts/markdown-file-conflict';
      const initial = pageContent('Markdown File Conflict', 'Initial compiled truth.', '- 2026-04-25 | Initial evidence.');
      const independentMarkdownEdit = pageContent(
        'Markdown File Conflict',
        'User edited the markdown file outside MBrain.',
        '- 2026-04-25 | Independent markdown edit evidence.',
      );
      const agentUpdate = pageContent(
        'Markdown File Conflict',
        'Agent update should not overwrite the independent markdown edit.',
        '- 2026-04-25 | Agent overwrite attempt evidence.',
      );

      try {
        await put.handler(ctx, {
          slug,
          content: initial,
          repo: repoPath,
          expected_content_hash: null,
          session_id: 'put-page-markdown-file-conflict-seed',
        });
        const before = await ctx.engine.getPage(slug);
        expect(before?.content_hash).toBeTruthy();

        const filePath = join(repoPath, 'concepts', 'markdown-file-conflict.md');
        writeFileSync(filePath, independentMarkdownEdit);

        let error: unknown;
        try {
          await put.handler(ctx, {
            slug,
            content: agentUpdate,
            repo: repoPath,
            expected_content_hash: before?.content_hash,
            session_id: 'put-page-markdown-file-conflict-session',
            source_refs: ['Source: markdown conflict test'],
          });
        } catch (caught) {
          error = caught;
        }

        expect(error).toBeInstanceOf(OperationError);
        expect((error as OperationError).code).toBe('write_conflict');
        expect((error as Error).message).toContain('markdown file changed');
        expect(readFileSync(filePath, 'utf-8')).toBe(independentMarkdownEdit);
        const after = await ctx.engine.getPage(slug);
        expect(after?.content_hash).toBe(before?.content_hash);
        expect(after?.compiled_truth).toBe(before?.compiled_truth);
        expect(after?.compiled_truth).not.toContain('Agent update should not overwrite');
      } finally {
        rmSync(repoPath, { recursive: true, force: true });
      }
    });
  });

  test('put_page uses the configured markdown repo path when repo is omitted', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-put-page-configured-repo-'));
      const slug = 'concepts/configured-markdown-repo';
      const content = pageContent(
        'Configured Markdown Repo',
        'Configured markdown repo path should receive the page file.',
        '- 2026-04-25 | Configured markdown repo evidence.',
      );

      try {
        await ctx.engine.setConfig('markdown.repo_path', repoPath);
        await put.handler(ctx, {
          slug,
          content,
          expected_content_hash: null,
          session_id: 'put-page-configured-markdown-repo-session',
          source_refs: ['Source: configured markdown repo test'],
        });

        expect(readFileSync(join(repoPath, 'concepts', 'configured-markdown-repo.md'), 'utf-8')).toBe(content);
      } finally {
        rmSync(repoPath, { recursive: true, force: true });
      }
    });
  });

  test('put_page writes prefixed slugs to the matching registered subbrain repo', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const personalRepo = mkdtempSync(join(tmpdir(), 'mbrain-put-page-personal-subbrain-'));
      const slug = 'personal/concepts/subbrain-write';
      const content = pageContent(
        'Subbrain Write',
        'Sub-brain write-back should strip the prefix for the physical path.',
        '- 2026-05-07 | Sub-brain write-back evidence.',
      );

      try {
        await ctx.engine.setConfig(
          SUBBRAIN_REGISTRY_CONFIG_KEY,
          JSON.stringify({
            subbrains: {
              personal: {
                id: 'personal',
                path: personalRepo,
                prefix: 'personal',
                default: true,
              },
            },
          }),
        );

        await put.handler(ctx, {
          slug,
          content,
          expected_content_hash: null,
          session_id: 'put-page-subbrain-write-session',
          source_refs: ['Source: subbrain write-back test'],
        });

        expect(readFileSync(join(personalRepo, 'concepts', 'subbrain-write.md'), 'utf-8')).toBe(content);
        expect(existsSync(join(personalRepo, 'personal', 'concepts', 'subbrain-write.md'))).toBe(false);
        const page = await ctx.engine.getPage(slug);
        expect(page?.title).toBe('Subbrain Write');
        const manifest = await ctx.engine.getNoteManifestEntry('workspace:default', slug);
        expect(manifest?.path).toBe('concepts/subbrain-write.md');
      } finally {
        rmSync(personalRepo, { recursive: true, force: true });
      }
    });
  });

  test('put_page rejects a prefix-only subbrain slug', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const personalRepo = mkdtempSync(join(tmpdir(), 'mbrain-put-page-prefix-only-'));

      try {
        await ctx.engine.setConfig(
          SUBBRAIN_REGISTRY_CONFIG_KEY,
          JSON.stringify({
            subbrains: {
              personal: {
                id: 'personal',
                path: personalRepo,
                prefix: 'personal',
              },
            },
          }),
        );

        await expect(
          put.handler(ctx, {
            slug: 'personal',
            content: pageContent('Prefix Only', 'This write should be rejected before mutation.', '- 2026-05-07 | Prefix-only write attempt.'),
            expected_content_hash: null,
            session_id: 'put-page-prefix-only-session',
            source_refs: ['Source: prefix-only subbrain write test'],
          }),
        ).rejects.toThrow(/missing path after prefix/i);

        expect(await ctx.engine.getPage('personal')).toBeNull();
      } finally {
        rmSync(personalRepo, { recursive: true, force: true });
      }
    });
  });

  test('put_page rejects unknown prefixes when a subbrain registry is active and repo is omitted', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const personalRepo = mkdtempSync(join(tmpdir(), 'mbrain-put-page-unknown-prefix-'));

      try {
        await ctx.engine.setConfig(
          SUBBRAIN_REGISTRY_CONFIG_KEY,
          JSON.stringify({
            subbrains: {
              personal: {
                id: 'personal',
                path: personalRepo,
                prefix: 'personal',
              },
            },
          }),
        );

        await expect(
          put.handler(ctx, {
            slug: 'office/concepts/unknown',
            content: pageContent('Unknown Prefix', 'This write has no registered sub-brain prefix.', '- 2026-05-07 | Unknown prefix write attempt.'),
            expected_content_hash: null,
            session_id: 'put-page-unknown-prefix-session',
            source_refs: ['Source: unknown subbrain prefix test'],
          }),
        ).rejects.toThrow(/does not match any registered sub-brain prefix/i);

        expect(await ctx.engine.getPage('office/concepts/unknown')).toBeNull();
      } finally {
        rmSync(personalRepo, { recursive: true, force: true });
      }
    });
  });

  test('put_page rejects markdown targets whose parent path escapes through a symlink', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-put-page-symlink-repo-'));
      const outsidePath = mkdtempSync(join(tmpdir(), 'mbrain-put-page-symlink-outside-'));

      try {
        symlinkSync(outsidePath, join(repoPath, 'concepts'), 'dir');

        await expect(
          put.handler(ctx, {
            slug: 'concepts/symlink-escape',
            content: pageContent('Symlink Escape', 'This write must not leave the configured markdown repo.', '- 2026-04-25 | Symlink escape attempt.'),
            repo: repoPath,
            expected_content_hash: null,
            session_id: 'put-page-symlink-escape-session',
            source_refs: ['Source: symlink escape test'],
          }),
        ).rejects.toThrow(/escapes repo|symlink/i);

        expect(existsSync(join(outsidePath, 'symlink-escape.md'))).toBe(false);
        expect(await ctx.engine.getPage('concepts/symlink-escape')).toBeNull();
      } finally {
        rmSync(repoPath, { recursive: true, force: true });
        rmSync(outsidePath, { recursive: true, force: true });
      }
    });
  });

  test('put_page rejects markdown targets whose final file is a symlink', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-put-page-file-symlink-repo-'));
      const outsidePath = mkdtempSync(join(tmpdir(), 'mbrain-put-page-file-symlink-outside-'));

      try {
        writeFileSync(join(outsidePath, 'target.md'), 'outside');
        symlinkSync(join(outsidePath, 'target.md'), join(repoPath, 'linked.md'));

        await expect(
          put.handler(ctx, {
            slug: 'linked',
            content: pageContent('Linked', 'This write must not read or overwrite a symlink target.', '- 2026-05-07 | Final symlink write attempt.'),
            repo: repoPath,
            expected_content_hash: null,
            session_id: 'put-page-file-symlink-session',
            source_refs: ['Source: final symlink escape test'],
          }),
        ).rejects.toThrow(/symlink/i);

        expect(readFileSync(join(outsidePath, 'target.md'), 'utf-8')).toBe('outside');
        expect(await ctx.engine.getPage('linked')).toBeNull();
      } finally {
        rmSync(repoPath, { recursive: true, force: true });
        rmSync(outsidePath, { recursive: true, force: true });
      }
    });
  });

  test('put_page hashes existing subbrain markdown with the prefixed canonical slug', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-put-page-prefix-hash-repo-'));
      const content = [
        '---',
        'title: Prefix Hash',
        '---',
        '',
        'This page relies on path-inferred type under the systems prefix.',
        '',
        '---',
        '',
        `- 2026-05-07 | Prefix hash fixture. ${DEFAULT_PAGE_SOURCE}`,
        '',
      ].join('\n');

      try {
        await ctx.engine.setConfig(
          SUBBRAIN_REGISTRY_CONFIG_KEY,
          JSON.stringify({
            subbrains: {
              systems: { id: 'systems', path: repoPath, prefix: 'systems' },
            },
          }),
        );

        await put.handler(ctx, {
          slug: 'systems/foo',
          content,
          expected_content_hash: null,
          session_id: 'put-page-prefix-hash-seed',
          source_refs: ['Source: prefix hash seed test'],
        });

        const result = (await put.handler(ctx, {
          slug: 'systems/foo',
          content,
          expected_content_hash: (await ctx.engine.getPage('systems/foo'))?.content_hash,
          session_id: 'put-page-prefix-hash-repeat',
          source_refs: ['Source: prefix hash repeat test'],
        })) as any;

        expect(result.status).toBe('skipped');
        expect(await ctx.engine.getPage('systems/foo')).not.toBeNull();
      } finally {
        rmSync(repoPath, { recursive: true, force: true });
      }
    });
  });

  test('put_page strips a registered prefix when explicit repo points at the matching subbrain repo', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-put-page-explicit-subbrain-repo-'));

      try {
        await ctx.engine.setConfig(
          SUBBRAIN_REGISTRY_CONFIG_KEY,
          JSON.stringify({
            subbrains: {
              personal: { id: 'personal', path: repoPath, prefix: 'personal' },
            },
          }),
        );

        await put.handler(ctx, {
          slug: 'personal/people/alice',
          content: pageContent(
            'Alice',
            'This write uses an explicit repo that matches the registered sub-brain.',
            '- 2026-05-07 | Explicit repo subbrain write.',
          ),
          repo: repoPath,
          expected_content_hash: null,
          session_id: 'put-page-explicit-subbrain-repo-session',
          source_refs: ['Source: explicit subbrain repo test'],
        });

        expect(existsSync(join(repoPath, 'people', 'alice.md'))).toBe(true);
        expect(existsSync(join(repoPath, 'personal', 'people', 'alice.md'))).toBe(false);
      } finally {
        rmSync(repoPath, { recursive: true, force: true });
      }
    });
  });

  test('oversized markdown-first put_page leaves the existing file and DB projection unchanged', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-put-page-oversized-repo-'));
      const slug = 'concepts/oversized-markdown-first';
      const initial = pageContent('Oversized Markdown First', 'Original compiled truth.', '- 2026-04-25 | Initial evidence.');

      try {
        await put.handler(ctx, {
          slug,
          content: initial,
          repo: repoPath,
          expected_content_hash: null,
          session_id: 'put-page-oversized-markdown-first-seed',
        });
        const filePath = join(repoPath, 'concepts', 'oversized-markdown-first.md');
        const before = await ctx.engine.getPage(slug);
        expect(before?.content_hash).toBeTruthy();

        const result = (await put.handler(ctx, {
          slug,
          content: `${'x'.repeat(5_000_001)} ${DEFAULT_PAGE_SOURCE}`,
          repo: repoPath,
          expected_content_hash: before?.content_hash,
          session_id: 'put-page-oversized-markdown-first-session',
          source_refs: ['Source: oversized markdown-first test'],
        })) as any;

        expect(result).toMatchObject({
          slug,
          status: 'skipped',
          chunks: 0,
        });
        expect(result.error).toContain('Content too large');
        expect(readFileSync(filePath, 'utf-8')).toBe(initial);
        const after = await ctx.engine.getPage(slug);
        expect(after?.content_hash).toBe(before?.content_hash);
        expect(after?.compiled_truth).toBe(before?.compiled_truth);

        const events = await ctx.engine.listMemoryMutationEvents({
          session_id: 'put-page-oversized-markdown-first-session',
        });
        expect(events).toHaveLength(1);
        expect(events[0].result).toBe('failed');
      } finally {
        rmSync(repoPath, { recursive: true, force: true });
      }
    });
  });

  test('markdown-first put_page restores the file when applied ledger recording fails', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-put-page-ledger-rollback-repo-'));
      const slug = 'concepts/markdown-ledger-rollback';
      const initial = pageContent('Markdown Ledger Rollback', 'Original compiled truth.', '- 2026-04-25 | Initial evidence.');
      const update = pageContent(
        'Markdown Ledger Rollback',
        'This update should roll back when ledger recording fails.',
        '- 2026-04-25 | Ledger failure attempted update.',
      );

      try {
        await put.handler(ctx, {
          slug,
          content: initial,
          repo: repoPath,
          expected_content_hash: null,
          session_id: 'put-page-markdown-ledger-rollback-seed',
        });
        const before = await ctx.engine.getPage(slug);
        expect(before?.content_hash).toBeTruthy();
        const filePath = join(repoPath, 'concepts', 'markdown-ledger-rollback.md');
        expect(readFileSync(filePath, 'utf-8')).toBe(initial);

        const originalCreateMemoryMutationEvent = ctx.engine.createMemoryMutationEvent.bind(ctx.engine);
        ctx.engine.createMemoryMutationEvent = async (input) => {
          if (input.session_id === 'put-page-markdown-ledger-rollback-session') {
            throw new Error('ledger write failed');
          }
          return originalCreateMemoryMutationEvent(input);
        };

        await expect(
          put.handler(ctx, {
            slug,
            content: update,
            repo: repoPath,
            expected_content_hash: before?.content_hash,
            session_id: 'put-page-markdown-ledger-rollback-session',
            source_refs: ['Source: markdown ledger rollback test'],
          }),
        ).rejects.toThrow(/ledger write failed/);

        expect(readFileSync(filePath, 'utf-8')).toBe(initial);
        const after = await ctx.engine.getPage(slug);
        expect(after?.content_hash).toBe(before?.content_hash);
        expect(after?.compiled_truth).toBe(before?.compiled_truth);
      } finally {
        rmSync(repoPath, { recursive: true, force: true });
      }
    });
  });

  test('markdown-first put_page does not rewrite the file when content is unchanged', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const repoPath = mkdtempSync(join(tmpdir(), 'mbrain-put-page-unchanged-repo-'));
      const slug = 'concepts/unchanged-markdown-first';
      const content = pageContent(
        'Unchanged Markdown First',
        'The file content is already current.',
        '- 2026-04-25 | Initial unchanged markdown-first evidence.',
      );

      try {
        await put.handler(ctx, {
          slug,
          content,
          repo: repoPath,
          expected_content_hash: null,
          session_id: 'put-page-unchanged-markdown-first-seed',
        });

        const filePath = join(repoPath, 'concepts', 'unchanged-markdown-first.md');
        const oldDate = new Date('2026-01-01T00:00:00.000Z');
        utimesSync(filePath, oldDate, oldDate);
        const beforeMtime = statSync(filePath).mtimeMs;

        const result = (await put.handler(ctx, {
          slug,
          content,
          repo: repoPath,
          expected_content_hash: (await ctx.engine.getPage(slug))?.content_hash,
          session_id: 'put-page-unchanged-markdown-first-session',
          source_refs: ['Source: unchanged markdown-first optimization test'],
        })) as any;

        expect(result).toMatchObject({
          slug,
          status: 'skipped',
          chunks: 0,
        });
        expect(readFileSync(filePath, 'utf-8')).toBe(content);
        expect(statSync(filePath).mtimeMs).toBe(beforeMtime);
      } finally {
        rmSync(repoPath, { recursive: true, force: true });
      }
    });
  });

  test('matching expected_content_hash with unchanged content records an applied ledger event', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/precondition-unchanged';
      const sessionId = 'put-page-unchanged-session';
      const content = pageContent('Precondition Unchanged', 'Compiled truth stays the same.', '- 2026-04-25 | Initial unchanged evidence.');

      await put.handler(ctx, { slug, content, expected_content_hash: null });
      const before = await ctx.engine.getPage(slug);
      expect(before?.content_hash).toBeTruthy();

      const result = (await put.handler(ctx, {
        slug,
        content,
        expected_content_hash: before?.content_hash,
        session_id: sessionId,
        source_refs: ['Source: unchanged precondition test'],
      })) as any;

      expect(result).toMatchObject({ slug, status: 'skipped', chunks: 0 });

      const after = await ctx.engine.getPage(slug);
      expect(after?.content_hash).toBe(before?.content_hash);

      const events = await ctx.engine.listMemoryMutationEvents({
        session_id: sessionId,
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        session_id: sessionId,
        operation: 'put_page',
        target_kind: 'page',
        target_id: slug,
        result: 'applied',
        expected_target_snapshot_hash: before?.content_hash,
        current_target_snapshot_hash: before?.content_hash,
        source_refs: ['Source: unchanged precondition test'],
      });
      expect(events[0].conflict_info).toBeNull();
      expect(events[0].metadata).toMatchObject({
        import_status: 'skipped',
        skipped_reason: 'content_hash_unchanged',
      });
    });
  });

  test('expected_content_hash reads the page through the write-lock path', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/precondition-write-lock-path';

      await put.handler(ctx, {
        slug,
        content: pageContent('Precondition Write Lock Path', 'Original compiled truth.', '- 2026-04-25 | Initial evidence.'),
        expected_content_hash: null,
      });
      const before = await ctx.engine.getPage(slug);
      expect(before?.content_hash).toBeTruthy();

      let getPageForUpdateCalls = 0;
      const originalGetPage = ctx.engine.getPage.bind(ctx.engine);
      (
        ctx.engine as BrainEngine & {
          getPageForUpdate?: BrainEngine['getPage'];
        }
      ).getPageForUpdate = async (requestedSlug) => {
        getPageForUpdateCalls += 1;
        return originalGetPage(requestedSlug);
      };

      await put.handler(ctx, {
        slug,
        content: pageContent('Precondition Write Lock Path', 'Updated compiled truth.', '- 2026-04-25 | Updated evidence.'),
        expected_content_hash: before?.content_hash,
        session_id: 'put-page-write-lock-path-session',
      });

      expect(getPageForUpdateCalls).toBe(1);
    });
  });

  test('string-list source_refs are accepted and normalized for put_page audit', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/string-list-source-refs';
      const sessionId = 'put-page-string-list-source-refs-session';

      await put.handler(ctx, {
        slug,
        content: pageContent('String List Source Refs', 'String-list source refs should be accepted.', '- 2026-04-25 | String list source refs test.'),
        expected_content_hash: null,
        session_id: sessionId,
        source_refs: 'Source: string list one\nSource: string list two',
      });

      const events = await ctx.engine.listMemoryMutationEvents({
        session_id: sessionId,
      });
      expect(events).toHaveLength(1);
      expect(events[0].source_refs).toEqual(['Source: string list one', 'Source: string list two']);
    });
  });

  test('JSON-array string source_refs are accepted and normalized for put_page audit', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/json-string-source-refs';
      const sessionId = 'put-page-json-string-source-refs-session';

      await put.handler(ctx, {
        slug,
        content: pageContent('JSON String Source Refs', 'JSON-array string source refs should be accepted.', '- 2026-04-25 | JSON string source refs test.'),
        expected_content_hash: null,
        session_id: sessionId,
        source_refs: '["Source: JSON string one", " Source: JSON string two "]',
      });

      const events = await ctx.engine.listMemoryMutationEvents({
        session_id: sessionId,
      });
      expect(events).toHaveLength(1);
      expect(events[0].source_refs).toEqual(['Source: JSON string one', 'Source: JSON string two']);
    });
  });

  test('bracketed MBrain source citation string is accepted as one put_page source ref', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/bracketed-mbrain-source-ref';
      const sessionId = 'put-page-bracketed-mbrain-source-ref-session';
      const sourceRef = '[Source: User, direct message, 2026-04-26 KST]';

      await put.handler(ctx, {
        slug,
        content: pageContent(
          'Bracketed MBrain Source Ref',
          'Bracketed MBrain source citations should be accepted.',
          '- 2026-04-26 | Bracketed source ref test.',
        ),
        expected_content_hash: null,
        session_id: sessionId,
        source_refs: sourceRef,
      });

      const events = await ctx.engine.listMemoryMutationEvents({
        session_id: sessionId,
      });
      expect(events).toHaveLength(1);
      expect(events[0].source_refs).toEqual([sourceRef]);
    });
  });

  test('comma-containing non-bracket source citation string is accepted as one put_page source ref', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/comma-containing-source-ref';
      const sessionId = 'put-page-comma-containing-source-ref-session';
      const sourceRef = 'Source: User, direct message, 2026-04-26 KST';

      await put.handler(ctx, {
        slug,
        content: pageContent(
          'Comma Containing Source Ref',
          'Comma-containing source citations should be accepted.',
          '- 2026-04-26 | Comma-containing source ref test.',
        ),
        expected_content_hash: null,
        session_id: sessionId,
        source_refs: sourceRef,
      });

      const events = await ctx.engine.listMemoryMutationEvents({
        session_id: sessionId,
      });
      expect(events).toHaveLength(1);
      expect(events[0].source_refs).toEqual([sourceRef]);
    });
  });

  test('non-string array source_refs reject before page mutation or ledger recording', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/non-string-array-source-refs';
      const sessionId = 'put-page-non-string-array-source-refs-session';

      let error: unknown;
      try {
        await put.handler(ctx, {
          slug,
          content: pageContent('Non String Array Source Refs', 'This page should not be written.', '- 2026-04-25 | Non-string array source refs test.'),
          expected_content_hash: null,
          session_id: sessionId,
          source_refs: [123],
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(OperationError);
      expect((error as OperationError).code).toBe('invalid_params');
      expect((error as Error).message).toContain('source_refs');
      expect(await ctx.engine.getPage(slug)).toBeNull();
      expect(await ctx.engine.listMemoryMutationEvents({ session_id: sessionId })).toEqual([]);
    });
  });

  test('non-string JSON-array string source_refs reject before page mutation or ledger recording', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/non-string-json-source-refs';
      const sessionId = 'put-page-non-string-json-source-refs-session';

      let error: unknown;
      try {
        await put.handler(ctx, {
          slug,
          content: pageContent('Non String JSON Source Refs', 'This page should not be written.', '- 2026-04-25 | Non-string JSON source refs test.'),
          expected_content_hash: null,
          session_id: sessionId,
          source_refs: '[123]',
        });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(OperationError);
      expect((error as OperationError).code).toBe('invalid_params');
      expect((error as Error).message).toContain('source_refs');
      expect(await ctx.engine.getPage(slug)).toBeNull();
      expect(await ctx.engine.listMemoryMutationEvents({ session_id: sessionId })).toEqual([]);
    });
  });

  test('normal put_page without audit params records an applied ledger event using defaults', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/default-audit';

      const result = (await put.handler(ctx, {
        slug,
        content: pageContent('Default Audit', 'Default audit fields should be used.', '- 2026-04-25 | Default audit test.'),
        expected_content_hash: null,
      })) as any;
      expect(result).toMatchObject({ slug, status: 'created_or_updated' });

      const page = await ctx.engine.getPage(slug);
      const events = await ctx.engine.listMemoryMutationEvents({
        target_id: slug,
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        realm_id: 'work',
        actor: 'mbrain:put_page',
        operation: 'put_page',
        target_kind: 'page',
        target_id: slug,
        scope_id: 'workspace:default',
        source_refs: ['Source: mbrain put_page operation'],
        expected_target_snapshot_hash: null,
        current_target_snapshot_hash: page?.content_hash,
        result: 'applied',
        dry_run: false,
      });
      expect(events[0].session_id).toMatch(/^put_page:direct:/);
    });
  });

  test('default audit session ids are unique for unrelated direct writes', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');

      await put.handler(ctx, {
        slug: 'concepts/default-session-one',
        content: pageContent('Default Session One', 'First direct write.', '- 2026-04-25 | First default session id test.'),
        expected_content_hash: null,
      });
      await put.handler(ctx, {
        slug: 'concepts/default-session-two',
        content: pageContent('Default Session Two', 'Second direct write.', '- 2026-04-25 | Second default session id test.'),
        expected_content_hash: null,
      });

      const one = await ctx.engine.listMemoryMutationEvents({
        target_id: 'concepts/default-session-one',
      });
      const two = await ctx.engine.listMemoryMutationEvents({
        target_id: 'concepts/default-session-two',
      });
      expect(one).toHaveLength(1);
      expect(two).toHaveLength(1);
      expect(one[0].session_id).toMatch(/^put_page:direct:/);
      expect(two[0].session_id).toMatch(/^put_page:direct:/);
      expect(one[0].session_id).not.toBe(two[0].session_id);
    });
  });

  test('explicit audit session_id is preserved', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/explicit-session-preserved';

      await put.handler(ctx, {
        slug,
        content: pageContent('Explicit Session Preserved', 'Explicit audit session ids should be preserved.', '- 2026-04-25 | Explicit session id test.'),
        expected_content_hash: null,
        session_id: 'put-page-explicit-session',
      });

      const events = await ctx.engine.listMemoryMutationEvents({
        target_id: slug,
      });
      expect(events).toHaveLength(1);
      expect(events[0].session_id).toBe('put-page-explicit-session');
    });
  });

  test('applied ledger failure rolls back the page mutation', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/applied-ledger-rollback';

      await put.handler(ctx, {
        slug,
        content: pageContent('Applied Ledger Rollback', 'Original compiled truth.', '- 2026-04-25 | Initial evidence.'),
        expected_content_hash: null,
      });
      const before = await ctx.engine.getPage(slug);
      expect(before?.content_hash).toBeTruthy();

      const originalCreateMemoryMutationEvent = ctx.engine.createMemoryMutationEvent.bind(ctx.engine);
      ctx.engine.createMemoryMutationEvent = async (input) => {
        if (input.session_id === 'put-page-applied-ledger-failure-session') {
          throw new Error('ledger write failed');
        }
        return originalCreateMemoryMutationEvent(input);
      };

      await expect(
        put.handler(ctx, {
          slug,
          content: pageContent(
            'Applied Ledger Rollback',
            'This update should roll back when ledger recording fails.',
            '- 2026-04-25 | Ledger failure attempted update.',
          ),
          expected_content_hash: before?.content_hash,
          session_id: 'put-page-applied-ledger-failure-session',
          source_refs: ['Source: applied ledger failure test'],
        }),
      ).rejects.toThrow(/ledger write failed/);

      const after = await ctx.engine.getPage(slug);
      expect(after?.content_hash).toBe(before?.content_hash);
      expect(after?.compiled_truth).toBe(before?.compiled_truth);
      expect(
        await ctx.engine.listMemoryMutationEvents({
          session_id: 'put-page-applied-ledger-failure-session',
        }),
      ).toEqual([]);
    });
  });

  test('oversized content returns import error and records a failed ledger event', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const slug = 'concepts/oversized-content';
      const sessionId = 'put-page-oversized-session';

      const result = (await put.handler(ctx, {
        slug,
        content: `${'x'.repeat(5_000_001)} ${DEFAULT_PAGE_SOURCE}`,
        expected_content_hash: null,
        session_id: sessionId,
        source_refs: ['Source: oversized content test'],
      })) as any;

      expect(result).toMatchObject({
        slug,
        status: 'skipped',
        chunks: 0,
      });
      expect(result.error).toContain('Content too large');
      expect(await ctx.engine.getPage(slug)).toBeNull();

      const events = await ctx.engine.listMemoryMutationEvents({
        session_id: sessionId,
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        session_id: sessionId,
        operation: 'put_page',
        target_kind: 'page',
        target_id: slug,
        result: 'failed',
        current_target_snapshot_hash: null,
        source_refs: ['Source: oversized content test'],
      });
      expect(events[0].metadata).toMatchObject({
        error: result.error,
      });
    });
  });

  test('ctx.dryRun does not write and does not record', async () => {
    await withSqliteEngine(async (ctx) => {
      const put = getOperation('put_page');
      const dryCtx = { ...ctx, dryRun: true };
      const slug = 'concepts/dry-run-precondition';

      const result = (await put.handler(dryCtx, {
        slug,
        content: pageContent('Dry Run Precondition', 'This dry run should not be written.', '- 2026-04-25 | Dry run attempted update.'),
        expected_content_hash: MISSING_HASH,
        session_id: 'put-page-dry-run-session',
      })) as any;

      expect(result).toEqual({ dry_run: true, action: 'put_page', slug });
      expect(await ctx.engine.getPage(slug)).toBeNull();
      expect(
        await ctx.engine.listMemoryMutationEvents({
          session_id: 'put-page-dry-run-session',
        }),
      ).toEqual([]);
    });
  });
});

describe('timeline operation preconditions', () => {
  test('add_timeline_entry rejects missing pages instead of silently succeeding', async () => {
    await withSqliteEngine(async (ctx) => {
      const addTimelineEntry = getOperation('add_timeline_entry');

      await expect(
        addTimelineEntry.handler(ctx, {
          slug: 'concepts/missing-timeline-target',
          date: '2026-06-16',
          summary: 'This should not be recorded.',
          source: 'timeline precondition test',
        }),
      ).rejects.toMatchObject({
        name: 'OperationError',
        code: 'page_not_found',
      } satisfies Partial<OperationError>);

      expect(await ctx.engine.getTimeline('concepts/missing-timeline-target')).toEqual([]);
    });
  });
});
