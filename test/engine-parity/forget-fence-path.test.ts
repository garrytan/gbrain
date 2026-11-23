/**
 * BrainEngine parity — forget on the fence path (forgetFactInFence, src/core/facts/forget.ts) and the forget_fact
 * operation's second call, on every engine.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: when the fact's source has a checkout and its page has a file, forget strikes the file's row with the
 *    caller's reason, and the stored body mirrors the file: an inline page takes the file's text, a segmented page the
 *    struck row in the segment that holds the fence. A second forget_fact call on the same id refuses with
 *    `fact_already_expired`; an expired fact leaves active recall and stays under `activeOnly: false`.
 *  - Regression: on a Rust brain the fence path stopped before the strike: readOnlyCheckout
 *    (persistence/mirror-read-only.ts) and resolvePageWriteTarget (write-through.ts) read the source and the page's
 *    file origin through `executeRaw`, which the Rust engine refuses.
 *  - Why existing coverage misses it: test/large-pages/forget-reason-segmented.test.ts and test/e2e/facts-forget.test.ts
 *    open PGLite and Postgres only, and test/engine-parity/forget-whole.test.ts forgets facts that sit on no page.
 *  - Seam: none. The checkout, page, writer and facts come from typed members and the import path; the files live in a
 *    temporary directory. The segmented case runs on the Rust arm through the typed segmented write members (the page
 *    read and deleted_at restore of the fence rewrite, the projection's chunk probes and retirement, the retired chunk
 *    vectors and the typed fence normalization).
 */
import { afterAll, describe, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { forgetFactInFence } from '../../src/core/facts/forget.ts';
import { materializeSegmentedBody } from '../../src/core/page-body/ingest.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from '../helpers/write-attribution.ts';
import { withEnv } from '../helpers/with-env.ts';

const { parityTest } = parityArms(testBackends());
const SRC = 'fenced';
const REASON = 'asked to drop it on the call';
const home = mkdtempSync(join(tmpdir(), 'gbrain-forget-fence-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const fence = (claim: string) => `<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | ${claim} | preference | 1.0 | world | medium | 2026-01-01 |  | chat | said at lunch |
| 2 | Walks to work | preference | 1.0 | world | medium | 2026-01-01 |  | chat |  |
<!--- gbrain:facts:end -->`;
const filler = (sections: number) => Array.from({ length: sections }, (_, i) => `## Part ${i}\n\n${'Notes on hiring and the budget review. '.repeat(30)}\n\n`).join('');

/** Files a page with a two-row fence in a fresh checkout of `SRC`, inserts row 1's fact, forgets it on the fence path;
 *  returns the forget's outcome, the page's storage and row 1 as stored and as filed. */
async function forgetOnFence(engine: BrainEngine, backend: ParityBackend, storage: 'inline' | 'segmented') {
  const root = mkdtempSync(join(home, `${backend}-${storage}-`));
  mkdirSync(join(root, 'notes'));
  await createSource(engine, backend, SRC, {}, root);
  await registerLocalWriter(engine, 'cli');
  if (storage === 'segmented') await engine.setConfig('pages.segmented_storage', 'on');
  const slug = `notes/forget-reason-${storage}`, claim = `Prefers the ${storage} window seat`;
  const content = `---\ntitle: Reason\ntype: note\n---\n\n# Reason\n\n## Facts\n\n${fence(claim)}\n\n${filler(storage === 'segmented' ? 1500 : 2)}`;
  writeFileSync(join(root, `${slug}.md`), content);
  await importFromContent(engine, slug, content, { noEmbed: true, sourceId: SRC });
  let id = 0;
  await engine.transaction(tx => withCoordinatedWrite(tx, [SRC], async () => {
    const out = await tx.insertFacts([{ fact: claim, entity_slug: slug, source_markdown_slug: slug, row_num: 1, kind: 'fact',
      visibility: 'world', source: 'test' }] as never, { source_id: SRC });
    id = Number(out.ids[0]);
  }, TEST_WRITE_ATTRIBUTION));
  try {
    const result = await withCoordinatedWrite(engine, [SRC], () => forgetFactInFence(engine, id, { reason: REASON }), TEST_WRITE_ATTRIBUTION);
    const page = await engine.getPage(slug, { sourceId: SRC });
    const stored = page?.body_storage === 'segmented'
      ? (await materializeSegmentedBody(engine, page.id, SRC)).compiled_truth
      : page?.compiled_truth ?? '';
    const row = (text: string) => text.split('\n').find(line => line.startsWith('| 1 |'));
    // getPage names body_storage only on a segmented page (rowToPage); an inline page omits it.
    return { result: { ok: result.ok, path: result.path }, storage: page ? page.body_storage ?? 'inline' : undefined, stored: row(stored), filed: row(readFileSync(join(root, `${slug}.md`), 'utf8')) };
  } finally {
    await disposePersistenceConsumer(engine).catch(() => undefined);
  }
}

describe('engine parity: forget on the fence path', () => {
  parityTest('forget strikes an inline page\'s fence row with the caller\'s reason, in the file and the stored body', {
    methods: ['insertFacts', 'getPage', 'readSourceState', 'readPageFileOrigin'],
    timeout: 180_000,
  }, async (engine, backend) => withEnv({ GBRAIN_HOME: home }, async () => {
    const out = await forgetOnFence(engine, backend, 'inline');
    expect(out.result).toEqual({ ok: true, path: 'fence' });
    expect(out.storage).toBe('inline');
    expect(out.stored).toContain(`forgotten: ${REASON} \\| said at lunch`);
    expect(out.stored).toBe(out.filed);
    return out;
  }));

  parityTest('forget strikes a segmented page\'s fence row with the caller\'s reason, in the file and the stored segment', {
    methods: ['insertFacts', 'getPage', 'readSourceState', 'readPageFileOrigin'],
    timeout: 300_000,
  }, async (engine, backend) => withEnv({ GBRAIN_HOME: home }, async () => {
    const out = await forgetOnFence(engine, backend, 'segmented');
    expect(out.result).toEqual({ ok: true, path: 'fence' });
    expect(out.storage).toBe('segmented');
    expect(out.stored).toContain(`forgotten: ${REASON} \\| said at lunch`);
    expect(out.stored).toBe(out.filed);
    return out;
  }));

  parityTest('a second forget_fact refuses with fact_already_expired, and an expired fact leaves active recall', {
    methods: ['insertFact', 'expireFact', 'listFactsByEntity'],
    timeout: 180_000,
  }, async (engine) => {
    try {
      const { id } = await engine.insertFact({ fact: 'forget me', kind: 'fact', source: 'test' } as never, { source_id: 'default' });
      const call = async () => {
        const r = await dispatchToolCall(engine, 'forget_fact', { id }, { remote: false, sourceId: 'default' });
        const payload = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
        return { isError: Boolean(r.isError), expired: payload.expired ?? null, error: payload.error ?? null };
      };
      const first = await call();
      const second = await call();
      const { id: hidden } = await engine.insertFact({ fact: 'will hide', kind: 'fact', entity_slug: 'forget-test', source: 'test' } as never, { source_id: 'default' });
      await engine.expireFact(hidden);
      const active = await engine.listFactsByEntity('default', 'forget-test');
      const all = await engine.listFactsByEntity('default', 'forget-test', { activeOnly: false });
      const out = { first, second, active: active.length, includesExpired: all.some(f => f.id === hidden) };
      expect(out).toEqual({ first: { isError: false, expired: true, error: null }, second: { isError: true, expired: null, error: 'fact_already_expired' }, active: 0, includesExpired: true });
      return out;
    } finally {
      await disposePersistenceConsumer(engine).catch(() => undefined);
    }
  });
});
