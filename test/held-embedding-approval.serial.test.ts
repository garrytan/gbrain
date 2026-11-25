/**
 * #6803 part 3 + #6847: held embedding budgets through the real CLI.
 *
 * Protects, on an on-disk two-source PGLite brain with large pages held
 * `upgrade_backfill` (the post-upgrade backfill's state) and a local
 * OpenAI-compatible embeddings server standing in for the provider:
 * - `gbrain embed --stale` reports `budget_limited` and prints the phrase
 *   with the approve commands, with `failures: 0` (was silent);
 * - `gbrain embed --held --dry-run` exits 0 on two sources and lists both
 *   (was exit 1); `--held --max-usd N` without `--source` refuses with
 *   `invalid_params` naming the per-source commands and releases nothing;
 * - on a provider that bills nothing (#6847), `--slugs <slug> --source <id>
 *   --max-usd 1` and `--held --source <id> --max-usd 1` embed every chunk and
 *   leave the row `open` with $0 spent (was: the hold reprinted, nothing
 *   embedded); `--yes` alone still leaves it held; doctor's `partial_embedding`
 *   fix and the hold line `meterPageBatch` prints, executed verbatim, release
 *   the hold, and the fix's verify then shows held 0 and capped 0 for that
 *   source while the other source stays held;
 * - an approval with no embedding credentials (`embedding_unavailable`) or a
 *   paid model with no price (`no_pricing`) is refused before the hold is
 *   released: state, cap and spend unchanged;
 * - on a paid provider whose text bills one token per character (dense CJK or
 *   minified code, four times the chars-per-token basis), doctor's printed
 *   approve finishes the page within its N and the verify shows held 0, while
 *   the same run with N = the estimate stops at its cap with chunks left.
 * Seams: none in-process; the real CLI (test/helpers/cli-spawn.ts) and a local
 * embeddings server (test/helpers/held-embedding-fixture.ts).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { BUDGET_STOP_EXIT_CODE } from '../src/core/exit-codes.ts';
import { argvOf, budgetRows, gbrain, makeHeldBrain, seedHeldPage, startFakeEmbeddings, withBrain, type FakeEmbeddings, type HeldBrain } from './helpers/held-embedding-fixture.ts';

type Fix = { argv: string[]; command: string; consent: string[]; next: string; preview_argv: string[]; verify: { argv: string[] } };
type Partial = { status: string; message: string; fix?: Fix; details?: { by_source: Array<{ source_id: string; est_usd: number; max_usd: number; fix: Fix }> } };
const json = (stdout: string) => JSON.parse(stdout) as Record<string, any>;
const partial = async (brain: HeldBrain): Promise<Partial> => {
  const run = await gbrain(brain, ['doctor', '--only', 'partial_embedding', '--json']);
  return json(run.stdout).checks.find((c: { name: string }) => c.name === 'partial_embedding');
};
const verify = async (brain: HeldBrain, fix: Fix) => {
  const run = await gbrain(brain, fix.verify.argv.slice(1));
  expect(run.exitCode, run.stderr).toBe(0);
  return json(run.stdout);
};
const row = async (brain: HeldBrain, slug: string) => (await budgetRows(brain)).find(r => r.slug === slug)!;
const approve = (source: string, n: string) => `gbrain embed --held --source ${source} --max-usd ${n}`;

let fake: FakeEmbeddings;
beforeAll(() => { fake = startFakeEmbeddings(); });
afterAll(() => fake.stop());

describe('a provider that bills nothing (ollama)', () => {
  let brain: HeldBrain;
  beforeEach(async () => {
    brain = await makeHeldBrain('ollama:nomic-embed-text', { OLLAMA_BASE_URL: fake.url });
    await withBrain(brain, async engine => {
      await seedHeldPage(engine, 'archive/day-a', 'default', 3);
      await seedHeldPage(engine, 'archive/day-b', 'alpha', 2);
    });
  }, 120_000);
  afterEach(() => brain.cleanup());

  test('embed --stale reports budget_limited and names the approval, never as a failure', async () => {
    const run = await gbrain(brain, ['embed', '--stale', '--json']);
    expect(run.exitCode, run.stderr).toBe(0);
    const doc = json(run.stdout);
    expect(doc.failures).toBe(0);
    expect(doc.budget_limited).toMatchObject({ held: 2, capped: 0, held_reasons: { upgrade_backfill: 2 }, pending_chunks: 5 });
    expect(doc.budget_limited.by_source.map((s: { source_id: string }) => s.source_id)).toEqual(['default', 'alpha']);
    expect(doc.budget_limited.fix.argv.slice(0, 7)).toEqual(['gbrain', ...argvOf(approve('default', '0.01'))]);
    expect(doc.budget_limited.fix).toMatchObject({ consent: [], next: 'ask_user' });
    expect(run.stderr).toContain('2 large page(s) have chunks waiting for embedding approval (2 held: upgrade_backfill); those chunks are keyword-only until approved.');
    expect(run.stderr).toContain(approve('alpha', '0.01'));
    expect((await budgetRows(brain)).map(r => [r.slug, r.state, r.embedded])).toEqual([['archive/day-a', 'held', 0], ['archive/day-b', 'held', 0]]);
  }, 120_000);

  test('embed --held --dry-run lists both sources and exits 0; --held --max-usd without --source refuses and releases nothing', async () => {
    const listing = await gbrain(brain, ['embed', '--held', '--dry-run', '--json']);
    expect(listing.exitCode, listing.stderr).toBe(0);
    const doc = json(listing.stdout);
    expect(doc).toMatchObject({ dryRun: true, held: 2, capped: 0, would_embed: 5 });
    expect(doc.pages.map((p: { slug: string; pending_chunks: number }) => [p.slug, p.pending_chunks]).sort()).toEqual([['archive/day-a', 3], ['archive/day-b', 2]]);
    expect(doc.sources.map((s: { source_id: string; fix: Fix }) => [s.source_id, s.fix.argv.slice(0, 7).join(' ')]))
      .toEqual([['default', approve('default', '0.01')], ['alpha', approve('alpha', '0.01')]]);
    const refused = await gbrain(brain, ['embed', '--held', '--max-usd', '1']);
    expect(refused.exitCode).toBe(2);
    expect(refused.stderr).toContain('invalid_params');
    expect(refused.stderr).toContain(approve('default', '0.01'));
    expect(refused.stderr).toContain(approve('alpha', '0.01'));
    expect((await budgetRows(brain)).map(r => [r.state, r.embedded])).toEqual([['held', 0], ['held', 0]]);
    expect(fake.calls).toBe(0);
  }, 120_000);

  test('#6847: --max-usd on --slugs and on --held releases the hold on a free provider; the ledger charges $0; --yes alone does not', async () => {
    const yes = await gbrain(brain, ['embed', '--slugs', 'archive/day-a', '--source', 'default', '--yes']);
    expect(yes.exitCode, yes.stderr).toBe(0);
    expect(yes.stderr).toContain('archive/day-a: embedding held (upgrade_backfill)');
    expect(await row(brain, 'archive/day-a')).toMatchObject({ state: 'held', embedded: 0 });
    const slugs = await gbrain(brain, ['embed', '--slugs', 'archive/day-a', '--source', 'default', '--max-usd', '1']);
    expect(slugs.exitCode, slugs.stderr).toBe(0);
    expect(await row(brain, 'archive/day-a')).toMatchObject({ state: 'open', embedded: 3, spent_usd: 0 });
    const held = await gbrain(brain, ['embed', '--held', '--source', 'alpha', '--max-usd', '1']);
    expect(held.exitCode, held.stderr).toBe(0);
    expect(await row(brain, 'archive/day-b')).toMatchObject({ state: 'open', embedded: 2, spent_usd: 0 });
  }, 120_000);

  test('doctor\'s fix and the meterPageBatch hold line, executed verbatim, release the hold; the verify shows held 0 and capped 0', async () => {
    const before = await partial(brain);
    expect(before.status).toBe('warn');
    expect(before.fix!.consent).toEqual([]);
    const ran = await gbrain(brain, argvOf(before.fix!.command));
    expect(ran.exitCode, ran.stderr).toBe(0);
    expect(await verify(brain, before.fix!)).toMatchObject({ held: 0, capped: 0 });
    expect(await row(brain, 'archive/day-a')).toMatchObject({ state: 'open', embedded: 3 });
    const after = await partial(brain);
    expect(after.status).toBe('warn');
    expect(after.details!.by_source.map(s => s.source_id)).toEqual(['alpha']);

    const hold = await gbrain(brain, ['embed', '--slugs', 'archive/day-b', '--source', 'alpha']);
    expect(hold.exitCode, hold.stderr).toBe(0);
    const printed = /With the user's approval: (gbrain embed [^\n]+)/.exec(hold.stderr)?.[1];
    expect(printed).toStartWith('gbrain embed --slugs archive/day-b --source alpha --max-usd 0.01');
    const released = await gbrain(brain, argvOf(printed!));
    expect(released.exitCode, released.stderr).toBe(0);
    expect(await row(brain, 'archive/day-b')).toMatchObject({ state: 'open', embedded: 2 });
    expect(await verify(brain, after.details!.by_source[0]!.fix)).toMatchObject({ held: 0, capped: 0 });
    expect((await partial(brain)).status).toBe('ok');
  }, 180_000);
});

describe('approvals refused before the hold is released', () => {
  const refusal = async (model: string, env: Record<string, string>, code: string) => {
    const brain = await makeHeldBrain(model, env);
    try {
      await withBrain(brain, engine => seedHeldPage(engine, 'archive/day-a', 'default', 2));
      const run = await gbrain(brain, ['embed', '--held', '--source', 'default', '--max-usd', '1']);
      expect(run.exitCode).not.toBe(0);
      expect(run.stdout + run.stderr).toContain(code);
      expect(await row(brain, 'archive/day-a')).toMatchObject({ state: 'held', reason: 'upgrade_backfill', cap_usd: null, spent_usd: 0, embedded: 0 });
    } finally {
      brain.cleanup();
    }
  };
  test('no embedding credentials: embedding_unavailable, hold and cap unchanged', () => refusal('openai:text-embedding-3-large', {}, 'embedding_unavailable'), 120_000);
  test('a paid model with no price: no_pricing, hold and cap unchanged', () => refusal('voyage:voyage-4-nano', { VOYAGE_API_KEY: ['pa', 'held', 'example'].join('-') }, 'no_pricing'), 120_000);
});

describe('a paid provider on dense text (one token per character)', () => {
  const CHUNKS = 400;
  let dense: FakeEmbeddings;
  let brain: HeldBrain;
  beforeEach(async () => {
    dense = startFakeEmbeddings({ dense: true });
    brain = await makeHeldBrain('openai:text-embedding-3-large', { OPENAI_API_KEY: ['sk', 'held', 'example'].join('-'), OPENAI_BASE_URL: dense.url });
    await withBrain(brain, engine => seedHeldPage(engine, 'archive/dense', 'default', CHUNKS));
  }, 120_000);
  afterEach(() => { dense.stop(); brain.cleanup(); });

  test('doctor\'s printed approve finishes the page within its N; the verify shows held 0', async () => {
    const found = await partial(brain);
    const fix = found.fix!;
    expect(fix.consent).toEqual(['paid', 'egress']);
    const n = Number(fix.argv[fix.argv.indexOf('--max-usd') + 1]);
    expect(n).toBeGreaterThanOrEqual(found.details!.by_source[0]!.est_usd * 1.5);
    const run = await gbrain(brain, argvOf(fix.command));
    expect(run.exitCode, run.stderr).toBe(0);
    expect(await row(brain, 'archive/dense')).toMatchObject({ state: 'open', embedded: CHUNKS });
    expect(dense.tokens * 0.13 / 1e6).toBeLessThanOrEqual(n);
    expect(await verify(brain, fix)).toMatchObject({ held: 0, capped: 0 });
  }, 240_000);

  test('the same run with N = the estimate stops at its cap with chunks left', async () => {
    const est = (await partial(brain)).details!.by_source[0]!.est_usd;
    const run = await gbrain(brain, ['embed', '--held', '--source', 'default', '--max-usd', (Math.ceil(est * 100) / 100).toFixed(2)]);
    expect(run.exitCode, run.stderr).toBe(BUDGET_STOP_EXIT_CODE);
    expect((await row(brain, 'archive/dense')).embedded).toBeLessThan(CHUNKS);
  }, 240_000);
});
