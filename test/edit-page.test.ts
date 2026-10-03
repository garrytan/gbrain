/**
 * edit_page — change parts of a page without re-sending it (#5616).
 *
 * put_page replaces the whole page, so a one-line change to a large page
 * meant emitting the page verbatim as a tool argument. edit_page takes exact
 * string replacements against the canonical `content` get_page returns and
 * writes through the put_page path under expected_revision:
 *   - one replacement lands; the rest of the page, the timeline and the
 *     revision chain behave as a put_page of the same content would
 *   - each old_string must occur exactly once: zero or several matches refuse
 *     the whole call naming the edit, and nothing is written
 *   - a stale expected_revision refuses with revision_conflict
 *   - expected_revision is required; force is not accepted
 *   - edits apply in order, each seeing the result of the one before
 *   - edits that change nothing are refused rather than written
 *   - a remote caller edits the text it can read and the stored facts rows
 *     survive untouched (the put_page fence rule; the fence is re-serialized
 *     exactly as a remote put_page re-serializes it)
 *   - a missing page is refused: edit_page does not create
 *
 * Hermetic in-memory PGLite.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway } from '../src/core/ai/gateway.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { applyPageEdits } from '../src/core/ops/edit-page.ts';
import { FACTS_FENCE_BEGIN, FACTS_FENCE_END } from '../src/core/facts-fence.ts';
import type { GBrainConfig } from '../src/core/config.ts';

let engine: PGLiteEngine;
const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

const getPage = operations.find((o) => o.name === 'get_page')!;
const putPage = operations.find((o) => o.name === 'put_page')!;
const editPage = operations.find((o) => o.name === 'edit_page')!;

function ctxFor(remote: boolean): OperationContext {
  return {
    engine,
    config: {} as GBrainConfig,
    logger: noopLogger,
    dryRun: false,
    remote,
    sourceId: 'default',
  } as OperationContext;
}
const localCtx = () => ctxFor(false);

beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
}, 30_000);

const PAGE = `---
type: note
title: Widget Co plan
---

## Current state

- The pilot starts in May.
- The budget is 10 units.
- Open question: who signs?

## Decisions

- Ship the pilot before the budget review.

<!-- timeline -->

- **2024-05-01** | call — pilot agreed
`;

const FENCE = `${FACTS_FENCE_BEGIN}
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Alice founded Acme | fact | 0.9 | world | high | 2024-01-01 |  | intro call |  |
${FACTS_FENCE_END}`;

const ENTITY = `---
type: person
title: Alice Example
---

Alice runs Acme.

## Facts

${FENCE}

<!-- timeline -->

- **2024-05-01** | call — Series A closed
`;

async function read(slug: string, ctx: OperationContext = localCtx()) {
  return (await getPage.handler(ctx, { slug, include_content: true, content_only: true })) as Record<string, unknown>;
}

async function seed(slug: string, content: string = PAGE): Promise<string> {
  await putPage.handler(localCtx(), { slug, content });
  return (await read(slug)).revision as string;
}

async function refusal(fn: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await fn();
  } catch (e) {
    return e as Record<string, unknown>;
  }
  throw new Error('expected a refusal');
}

describe('applyPageEdits', () => {
  test('replaces each old_string once, in order', () => {
    expect(applyPageEdits('a b c', [{ old_string: 'b', new_string: 'B' }, { old_string: 'B c', new_string: 'x' }])).toBe('a x');
  });
  test('a replacement string is literal: $& and $1 are not expanded', () => {
    expect(applyPageEdits('cost: n', [{ old_string: 'n', new_string: '$& $1 $$' }])).toBe('cost: $& $1 $$');
  });
  test('zero matches refuse, naming the edit', () => {
    expect(() => applyPageEdits('a b', [{ old_string: 'z', new_string: '' }])).toThrow(/edits\[0\]: old_string not found/);
  });
  test('several matches refuse, naming the edit and the count', () => {
    expect(() => applyPageEdits('a a', [{ old_string: 'a', new_string: 'b' }])).toThrow(/edits\[0\]: old_string occurs 2 times/);
  });
});

describe('edit_page', () => {
  test('one replacement lands and the rest of the page is untouched', async () => {
    const slug = 'projects/widget-edit';
    const rev = await seed(slug);
    const before = (await read(slug)).content as string;
    const res = await editPage.handler(localCtx(), {
      slug, expected_revision: rev,
      edits: [{ old_string: '- The budget is 10 units.', new_string: '- The budget is 12 units.' }],
    }) as Record<string, unknown>;
    expect(res.edits_applied).toBe(1);
    const page = await read(slug);
    const after = page.content as string;
    expect(after).toBe(before.replace('- The budget is 10 units.', '- The budget is 12 units.'));
    expect(after).toContain('pilot agreed');
    expect(page.revision).not.toBe(rev);
  }, 30_000);

  test('zero or several matches refuse the whole call and write nothing', async () => {
    const slug = 'projects/widget-match';
    const rev = await seed(slug);
    const notFound = await refusal(() => editPage.handler(localCtx(), {
      slug, expected_revision: rev,
      edits: [{ old_string: '- The pilot starts in May.', new_string: '- The pilot starts in June.' }, { old_string: 'no such line', new_string: 'x' }],
    }));
    expect(notFound.code).toBe('edit_not_found');
    expect(String(notFound.message)).toContain('edits[1]');
    const ambiguous = await refusal(() => editPage.handler(localCtx(), {
      slug, expected_revision: rev, edits: [{ old_string: 'the ', new_string: 'THE ' }],
    }));
    expect(ambiguous.code).toBe('edit_ambiguous');
    const page = await read(slug);
    expect(page.revision).toBe(rev);
    expect(page.content as string).toContain('- The pilot starts in May.');
  }, 30_000);

  test('a stale expected_revision refuses with revision_conflict', async () => {
    const slug = 'projects/widget-stale';
    const rev = await seed(slug);
    await editPage.handler(localCtx(), { slug, expected_revision: rev, edits: [{ old_string: 'in May', new_string: 'in June' }] });
    const stale = await refusal(() => editPage.handler(localCtx(), { slug, expected_revision: rev, edits: [{ old_string: 'in June', new_string: 'in July' }] }));
    expect(stale.code).toBe('revision_conflict');
    expect((await read(slug)).content as string).toContain('in June');
  }, 30_000);

  test('expected_revision is required and force is not accepted', async () => {
    const slug = 'projects/widget-rev';
    const rev = await seed(slug);
    const missing = await refusal(() => editPage.handler(localCtx(), { slug, edits: [{ old_string: 'in May', new_string: 'in June' }] }));
    expect(missing.code).toBe('invalid_params');
    expect(String(missing.message)).toContain('expected_revision');
    const forced = await refusal(() => editPage.handler(localCtx(), { slug, force: true, expected_revision: rev, edits: [{ old_string: 'in May', new_string: 'in June' }] }));
    expect(forced.code).toBe('invalid_params');
    expect(String(forced.message)).toContain('force');
    expect((await read(slug)).revision).toBe(rev);
  }, 30_000);

  test('edits apply in order, each seeing the result of the one before', async () => {
    const slug = 'projects/widget-order';
    const rev = await seed(slug);
    await editPage.handler(localCtx(), {
      slug, expected_revision: rev,
      edits: [
        { old_string: '- Open question: who signs?', new_string: '- Alice signs.' },
        { old_string: '- Alice signs.\n', new_string: '' },
      ],
    });
    const after = (await read(slug)).content as string;
    expect(after).not.toContain('who signs');
    expect(after).not.toContain('Alice signs');
    expect(after).toContain('- The budget is 10 units.\n\n## Decisions');
  }, 30_000);

  test('edits that change nothing are refused, not written', async () => {
    const slug = 'projects/widget-noop';
    const rev = await seed(slug);
    const same = await refusal(() => editPage.handler(localCtx(), { slug, expected_revision: rev, edits: [{ old_string: 'in May', new_string: 'in May' }] }));
    expect(same.code).toBe('no_change');
    expect((await read(slug)).revision).toBe(rev);
    const empty = await refusal(() => editPage.handler(localCtx(), { slug, expected_revision: rev, edits: [] }));
    expect(empty.code).toBe('invalid_params');
  }, 30_000);

  test('a remote caller edits the text it can read and the stored facts rows survive', async () => {
    const fenceRows = (s: string) => s.slice(s.indexOf(FACTS_FENCE_BEGIN), s.indexOf(FACTS_FENCE_END)).split('\n').filter((l) => l.startsWith('|'));
    const slugEdit = 'people/alice-remote-edit';
    const slugPut = 'people/alice-remote-put';
    await putPage.handler(localCtx(), { slug: slugEdit, content: ENTITY });
    await putPage.handler(localCtx(), { slug: slugPut, content: ENTITY });
    const rowsBefore = fenceRows((await read(slugEdit)).content as string);
    expect(rowsBefore.length).toBe(3);
    const remote = ctxFor(true);
    const seenEdit = await read(slugEdit, remote);
    await editPage.handler(remote, { slug: slugEdit, expected_revision: seenEdit.revision, edits: [{ old_string: 'Alice runs Acme.', new_string: 'Alice runs Acme and advises Beta.' }] });
    // the same change through a remote put_page of the same edited content: edit_page must land identically
    const seenPut = await read(slugPut, remote);
    await putPage.handler(remote, { slug: slugPut, expected_revision: seenPut.revision, content: (seenPut.content as string).replace('Alice runs Acme.', 'Alice runs Acme and advises Beta.') });
    const afterEdit = (await read(slugEdit)).content as string;
    const afterPut = (await read(slugPut)).content as string;
    expect(afterEdit).toContain('Alice runs Acme and advises Beta.');
    expect(fenceRows(afterEdit)).toEqual(rowsBefore);
    expect(afterEdit).toContain('Series A closed');
    expect(afterEdit.replace(slugEdit, slugPut)).toBe(afterPut.replace(slugEdit, slugPut));
  }, 30_000);

  test('a missing page is refused: edit_page does not create', async () => {
    const missing = await refusal(() => editPage.handler(localCtx(), { slug: 'projects/never-written', expected_revision: 'x', edits: [{ old_string: 'a', new_string: 'b' }] }));
    expect(missing.code).toBe('page_not_found');
  }, 30_000);

  test('dry run validates and writes nothing', async () => {
    const slug = 'projects/widget-dry';
    const rev = await seed(slug);
    const res = await editPage.handler({ ...localCtx(), dryRun: true }, { slug, expected_revision: rev, edits: [{ old_string: 'in May', new_string: 'in June' }] }) as Record<string, unknown>;
    expect(res.dry_run).toBe(true);
    expect(res.edits).toBe(1);
    expect((await read(slug)).revision).toBe(rev);
  }, 30_000);
});
