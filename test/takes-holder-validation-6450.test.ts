/**
 * #6450: `takes_add` accepted any string as `holder` (and `takes_supersede`
 * any explicit override), so `''`, `'   '`, `'Not A Slug!'` or
 * `'people/Bad Slug'` were published into the page's takes fence, where the
 * next write refused the whole fence (`target_fence_malformed`) and the page
 * was wedged until `gbrain repair fences`.
 *
 * The write boundary now trims the holder, validates it against the fence
 * grammar (`isValidHolder`: `world`, `brain`, `people/<slug>`,
 * `companies/<slug>`, or a legacy bare slug) and refuses `invalid_params`
 * before any page, file or table change; the supersede validates only an
 * explicit override, never the inherited holder. Every prepared fence is
 * round-tripped before publication, so no write can leave behind a fence the
 * next write would refuse. A page whose stored holder is already malformed is
 * refused as before, and the refusal names `gbrain repair fences`.
 *
 * Fresh page per case; every refusal asserts the stored body, revision and
 * takes rows unchanged. PGLite, trusted local caller. Synthetic content only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { TAKES_FENCE_BEGIN as TB, TAKES_FENCE_END as TE, isValidHolder, parseTakesFence } from '../src/core/takes-fence.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const TH = '| # | claim | kind | who | weight | since | source |\n|---|---|---|---|---|---|---|';
const takeRow = (n: number, claim: string, who: string) => `| ${n} | ${claim} | take | ${who} | 0.7 | 2026-01 | chat |`;
const takesFence = (...rows: string[]) => `${TB}\n${TH}\n${rows.join('\n')}\n${TE}`;
const page = (title: string, body = 'Synthetic prose.') => `---\ntitle: ${title}\n---\n# ${title}\n\n${body}\n`;

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-takes-holder-6450-'));
const env = { GBRAIN_HOME: home };
const op = (name: string) => operations.find(o => o.name === name)!;
let n = 0;

function ctx(): OperationContext {
  return { engine, config: { engine: 'pglite' as const }, logger: { info: () => {}, warn: () => {}, error: () => {} }, dryRun: false,
    remote: false, sourceId: 'default', deferEmbeds: true } as OperationContext;
}
async function freshPage(): Promise<string> {
  const slug = `people/holder-case-${++n}`;
  await op('put_page').handler(ctx(), { slug, content: page(`Case ${n}`) });
  return slug;
}
interface State { body: string; revision: unknown; rows: unknown[]; committed: number }
async function state(slug: string): Promise<State> {
  const snapshot = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
  const rows = await engine.executeRaw('SELECT row_num, claim, holder, active FROM takes WHERE page_id=$1 ORDER BY row_num', [snapshot.page.id]);
  const [{ committed }] = await engine.executeRaw<{ committed: number }>("SELECT count(*)::int AS committed FROM persistence_requests WHERE slug=$1 AND state='committed'", [slug]);
  return { body: snapshot.page.compiled_truth, revision: snapshot.revision, rows, committed };
}
async function refusal(run: () => Promise<unknown>): Promise<OperationError> {
  try { await run(); } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected a refusal');
}
const add = (slug: string, holder: string, claim = 'A synthetic take') => op('takes_add').handler(ctx(), { slug, claim, kind: 'take', holder, weight: 0.6, since: '2026-02' }) as Promise<Record<string, any>>;
const supersede = (slug: string, row_num: number, holder?: string) => op('takes_supersede').handler(ctx(), { slug, row_num, claim: 'A replacement take', ...(holder !== undefined ? { holder } : {}) }) as Promise<Record<string, any>>;
const holders = async (slug: string) => parseTakesFence((await engine.getPage(slug, { sourceId: 'default' }))!.compiled_truth).takes.map(t => [t.rowNum, t.holder, t.active]);

/** A refusal leaves the page exactly as it was (body, revision, takes rows) and commits no request. */
async function expectUnchanged(slug: string, before: State): Promise<void> {
  const after = await state(slug);
  expect(after.body).toBe(before.body);
  expect(after.revision).toEqual(before.revision);
  expect(after.rows).toEqual(before.rows);
  expect(after.committed).toBe(before.committed);
}

beforeAll(async () => withEnv(env, async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }), 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

describe('isValidHolder (pure probe)', () => {
  test('rejects the malformed forms and accepts the grammar; whitespace is valid only after a trim', () => {
    for (const bad of ['', '   ', 'Not A Slug!', 'people/Bad Slug', ' world ']) expect(isValidHolder(bad)).toBe(false);
    for (const ok of ['world', 'brain', 'people/alice-example', 'companies/acme-example', 'xxxxx']) expect(isValidHolder(ok)).toBe(true);
    expect(isValidHolder(' world '.trim())).toBe(true);
  });
});

describe('takes_add refuses a malformed holder before any state change (#6450)', () => {
  for (const holder of ['', '   ', 'Not A Slug!', 'people/Bad Slug']) {
    test(`holder ${JSON.stringify(holder)} → invalid_params, page untouched, and the next takes_add on that page still succeeds`, () => withEnv(env, async () => {
      const slug = await freshPage();
      const before = await state(slug);
      const error = await refusal(() => add(slug, holder));
      expect(error.canonicalCode).toBe('invalid_params');
      expect(error.message).toMatch(/holder/i);
      expect(error.message).toContain('people/<slug>');
      await expectUnchanged(slug, before);
      const next = await add(slug, 'world', 'A follow-up take');
      expect(next.holder).toBe('world');
      expect(await holders(slug)).toEqual([[1, 'world', true]]);
    }));
  }

  test('a padded valid holder is trimmed, validated and stored as the bare value', () => withEnv(env, async () => {
    const slug = await freshPage();
    const result = await add(slug, ' world ');
    expect(result.holder).toBe('world');
    expect(await holders(slug)).toEqual([[1, 'world', true]]);
    expect(await engine.executeRaw('SELECT holder FROM takes k JOIN pages p ON p.id=k.page_id WHERE p.slug=$1', [slug])).toEqual([{ holder: 'world' }]);
  }));

  test('a valid legacy bare-slug holder is accepted and its row can be superseded without an override', () => withEnv(env, async () => {
    const slug = await freshPage();
    expect((await add(slug, 'xxxxx')).holder).toBe('xxxxx');
    const superseded = await supersede(slug, 1);
    expect(superseded).toMatchObject({ old_row: 1, new_row: 2 });
    expect(await holders(slug)).toEqual([[1, 'xxxxx', false], [2, 'xxxxx', true]]);
  }));
});

describe('takes_supersede validates only an explicit holder override (#6450)', () => {
  test('a malformed override → invalid_params with the fence untouched; a padded valid override is trimmed', () => withEnv(env, async () => {
    const slug = await freshPage();
    await add(slug, 'world');
    const before = await state(slug);
    const error = await refusal(() => supersede(slug, 1, 'Not A Slug!'));
    expect(error.canonicalCode).toBe('invalid_params');
    expect(error.message).toMatch(/holder/i);
    await expectUnchanged(slug, before);
    const ok = await supersede(slug, 1, ' brain ');
    expect(ok).toMatchObject({ old_row: 1, new_row: 2 });
    expect(await holders(slug)).toEqual([[1, 'world', false], [2, 'brain', true]]);
  }));

  test('a stored holder that is already malformed keeps refusing every takes write, and the refusal names gbrain repair fences', () => withEnv(env, async () => {
    const slug = await freshPage();
    await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(
      'UPDATE pages SET compiled_truth=$3 WHERE source_id=$1 AND slug=$2', ['default', slug, `# Legacy\n\nSynthetic prose.\n\n${takesFence(takeRow(1, 'An old take', 'Not A Slug!'))}\n`]), TEST_WRITE_ATTRIBUTION));
    const before = await state(slug);
    // The existing malformed-fence refusal stays: typed invalid_fence / target_fence_malformed for the supersede.
    const superseded = await refusal(() => supersede(slug, 1));
    expect({ code: superseded.canonicalCode, reason: superseded.reason }).toEqual({ code: 'invalid_fence', reason: 'target_fence_malformed' });
    expect(JSON.stringify(superseded.toJSON())).toContain('gbrain repair fences');
    await expectUnchanged(slug, before);
    // takes_add normalizes what it can; a holder it cannot resolve leaves the fence unparseable and the write refused.
    const added = await refusal(() => add(slug, 'world'));
    expect(['invalid_fence', 'invalid_params']).toContain(added.canonicalCode);
    expect(JSON.stringify(added.toJSON())).toContain('gbrain repair fences');
    await expectUnchanged(slug, before);
  }));
});
