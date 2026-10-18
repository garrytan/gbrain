/**
 * B-12 (GBRA-130): a slug segment longer than a file name may be (bytes, not
 * UTF-16 units) is refused as a caller error before admission, never retried
 * as a storage failure.
 *
 * Protects: put_page and its dry run refuse a NEW page whose segment is over
 * the 240-byte file-name budget (90 CJK characters: 270 bytes, 90 UTF-16
 * units) with invalid_params, detail slug_not_portable and the shortened slug
 * to write instead, while a healthy sibling write lands and nothing else
 * changes; a page an older gbrain stored under such a slug keeps its row, and
 * publishing its file ends its write failed with invalid_params (nativeFileTarget
 * refuses a name over NAME_MAX and maps ENAMETOOLONG to detail file_name_too_long) instead of storage_error with a
 * "repair the filesystem" fix agents retry. A run-scoped error while checking
 * the existing identity is not turned into a slug refusal.
 * Fails when: validatePageSlug's 255-unit check is the only gate (the write is
 * admitted and its publication fails storage_error), or ENAMETOOLONG falls into
 * nativeFileTarget's generic inaccessible branch.
 * Seams: none; the run case wraps the engine in a Proxy. PGLite always,
 * Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operations, OperationError, type OperationContext } from '../../src/core/operations.ts';
import { nativeFileTarget } from '../../src/core/persistence/native-file-target.ts';
import { expectItemFailure, expectOthersUnchanged, expectUnitNotAborted, managedBrain, pathologicalArms, runScopedErrors, snapshotItems } from './harness.ts';

const putPage = operations.find(op => op.name === 'put_page')!;
const LONG = 'notes/' + '漢'.repeat(90);
const body = (title: string) => `---\ntitle: ${title}\ntype: note\n---\n# ${title}\n\nBody of ${title}.\n`;

async function refusal(run: Promise<unknown>): Promise<OperationError> {
  try { await run; } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected a refusal');
}
const asFailure = (key: string, error: OperationError) => ({ key, code: String(error.code), detail: error.detail, fix: error.fix });

function failingReads(engine: BrainEngine, injected: unknown): BrainEngine {
  return new Proxy(engine, { get(target, prop) {
    if (prop === 'readPageSnapshot') return () => Promise.reject(injected);
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`B-12 slug segment bytes (${backend})`, () => {
    test('B-12 item: a new 90-CJK-character segment is refused invalid_params with a shorter slug; a sibling lands', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await putPage.handler(ctx, { slug: 'notes/kept', content: body('Kept') });
        const before = await snapshotItems(engine, 'default');
        const error = await refusal(Promise.resolve(putPage.handler(ctx, { slug: LONG, content: body('Long') })));
        expect({ code: error.code, detail: error.detail }).toEqual({ code: 'invalid_params', detail: 'slug_not_portable' });
        const suggestion = 'notes/' + '漢'.repeat(78);
        expectItemFailure(asFailure(LONG, error), { key: LONG, code: 'invalid_params', fix: new RegExp(`^gbrain get ${suggestion}$`) });
        expect(error.suggestion).toContain(`gbrain put ${suggestion}`);
        const dry = await refusal(Promise.resolve(putPage.handler({ ...ctx, dryRun: true }, { slug: LONG, content: body('Long') })));
        expect({ code: dry.code, detail: dry.detail }).toEqual({ code: 'invalid_params', detail: 'slug_not_portable' });
        await expectUnitNotAborted(() => Promise.resolve(putPage.handler(ctx, { slug: 'notes/sibling', content: body('Sibling') })));
        expect(await engine.getPage(LONG, { sourceId: 'default' })).toBeNull();
        expectOthersUnchanged(before, await snapshotItems(engine, 'default'), { changed: ['notes/sibling'] });
        expect(await engine.getPage('notes/sibling', { sourceId: 'default' })).not.toBeNull();
        await expectUnitNotAborted(() => Promise.resolve(putPage.handler(ctx, { slug: suggestion, content: body('Long') })));
      }, { databaseUrl });
    }, 120_000);

    test('B-12 item: a stored long-segment page publishes as a failed invalid_params write, not storage_error', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await putPage.handler(ctx, { slug: 'notes/kept', content: body('Kept') });
        const before = await snapshotItems(engine, 'default');
        const snapshot = (await engine.readPageSnapshot(LONG, { sourceId: 'default' }))!;
        const error = await refusal(Promise.resolve(putPage.handler(ctx, { slug: LONG, content: body('Legacy'), expected_revision: snapshot.revision, request_id: randomUUID() })));
        expect({ code: error.code, writeError: error.writeError, message: error.message })
          .toEqual({ code: 'invalid_params', writeError: 'invalid_params', message: 'The canonical file name is longer than the file system allows.' });
        expect(error.suggestion).toContain('will not publish');
        expectOthersUnchanged(before, await snapshotItems(engine, 'default'));
      }, { databaseUrl, setup: async ({ engine, root }) => {
        mkdirSync(join(root, 'notes'));
        await engine.putPage(LONG, { type: 'note', title: 'Legacy', compiled_truth: 'stored body', timeline: '' }, { sourceId: 'default' });
      } });
    }, 120_000);

    test('B-12 item: nativeFileTarget maps ENAMETOOLONG to invalid_params file_name_too_long', () => {
      const root = mkdtempSync(join(tmpdir(), 'gbrain-b12-'));
      try {
        let thrown: unknown;
        try { nativeFileTarget(root, join(root, 'notes', '漢'.repeat(90) + '.md')); } catch (error) { thrown = error; }
        expect(thrown).toBeInstanceOf(OperationError);
        expect({ code: (thrown as OperationError).code, detail: (thrown as OperationError).detail }).toEqual({ code: 'invalid_params', detail: 'file_name_too_long' });
        expect(nativeFileTarget(root, join(root, 'notes', '漢'.repeat(70) + '.md'))).toBe(join(root, 'notes', '漢'.repeat(70) + '.md'));
      } finally { rmSync(root, { recursive: true, force: true }); }
    });

    for (const injected of runScopedErrors().filter(e => e.name === 'connection lost' || e.name === 'failed transaction (25P02)')) {
      test(`B-12 run: a run-scoped error (${injected.name}) while checking the identity is not a slug refusal`, async () => {
        await managedBrain(async ({ engine, ctx }) => {
          const before = await snapshotItems(engine, 'default');
          const error = injected.error();
          const dryCtx: OperationContext = { ...ctx, dryRun: true, engine: failingReads(engine, error) };
          let thrown: unknown;
          try { await putPage.handler(dryCtx, { slug: LONG, content: body('Long') }); } catch (e) { thrown = e; }
          expect(thrown).toBe(error);
          expectOthersUnchanged(before, await snapshotItems(engine, 'default'));
        }, { databaseUrl });
      }, 120_000);
    }
  });
}
