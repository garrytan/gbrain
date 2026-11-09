/**
 * Wave C 1F (T-DX4, dx-r3-outside-5): per-page embedding approvals through the real CLI.
 *
 * 1. Protects: `gbrain embed <slug>` without an approval estimates the page and asks for `--max-usd <ceiling>`
 *    (not `--yes`, which never raises a page's allowance); `gbrain embed <slug> --max-usd N` approves a held page
 *    (it used to drop the approval); a run the per-page cap stops reports `budget_limited` and exits 11; a
 *    `--max-usd` below the page's whole estimate is a partial slice, not a `cost_cap_exceeded` refusal; and
 *    `--held --background` is admitted (inline on PGLite) instead of refused.
 * 2. Fails when: the slug run is unestimated or its fix says `--yes`, the positional path drops `--max-usd`, a
 *    capped page run exits 0, a partial approval is refused up front, or `--held --background` refuses.
 * 3. On-disk PGLite brain made by `gbrain init`, a local OpenAI-compatible embeddings server (no paid call).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { BUDGET_STOP_EXIT_CODE, CONFIRMATION_REQUIRED_EXIT_CODE } from '../src/core/exit-codes.ts';
import { budgetRows, gbrain, makeHeldBrain, seedHeldPage, startFakeEmbeddings, withBrain, type FakeEmbeddings, type HeldBrain } from './helpers/held-embedding-fixture.ts';

const json = (stdout: string) => JSON.parse(stdout) as Record<string, any>;
const row = async (brain: HeldBrain, slug: string) => (await budgetRows(brain)).find(r => r.slug === slug)!;

let fake: FakeEmbeddings;
let brain: HeldBrain;
beforeAll(() => { fake = startFakeEmbeddings(); });
afterAll(() => fake.stop());
beforeEach(async () => {
  brain = await makeHeldBrain('openai:text-embedding-3-large', { OPENAI_API_KEY: ['sk', 'held', 'example'].join('-'), OPENAI_BASE_URL: fake.url });
  await withBrain(brain, engine => seedHeldPage(engine, 'archive/day-a', 'default', 3));
}, 120_000);
afterEach(() => brain.cleanup());

describe('gbrain embed <slug> on a large page', () => {
  test('without an approval it estimates the page and asks for --max-usd <ceiling>, not --yes; that command approves it', async () => {
    const asked = await gbrain(brain, ['embed', 'archive/day-a', '--source', 'default', '--json']);
    expect(asked.exitCode, asked.stderr).toBe(CONFIRMATION_REQUIRED_EXIT_CODE);
    const payload = json(asked.stdout);
    expect(payload.est_usd).toBeGreaterThan(0);
    const argv: string[] = payload.fix.argv;
    expect(argv).not.toContain('--yes');
    const ceiling = Number(argv[argv.indexOf('--max-usd') + 1]);
    expect(ceiling).toBeGreaterThanOrEqual(payload.est_usd * 1.5);
    expect(fake.calls).toBe(0);

    const approved = await gbrain(brain, argv.slice(1));
    expect(approved.exitCode, approved.stderr).toBe(0);
    expect(await row(brain, 'archive/day-a')).toMatchObject({ state: 'open', embedded: 3 });
  }, 240_000);

  test('a run the per-page cap stops reports budget_limited and exits 11', async () => {
    await withBrain(brain, async engine => {
      await engine.executeRaw('DELETE FROM page_embedding_budget');
      await engine.setConfig('embed.max_usd_per_page', '0.0001');
    });
    const run = await gbrain(brain, ['embed', 'archive/day-a', '--source', 'default', '--yes', '--json']);
    expect(run.exitCode, run.stderr).toBe(BUDGET_STOP_EXIT_CODE);
    const doc = json(run.stdout);
    expect(doc.reason).toBe('budget_limited');
    expect(doc.budget_limited).toMatchObject({ capped: 1 });
    const after = await row(brain, 'archive/day-a');
    expect(after.state).toBe('capped');
    expect(after.embedded).toBeLessThan(3);
  }, 240_000);

  test('--max-usd below the whole estimate is a partial slice: it runs and stops at the cap instead of refusing', async () => {
    const run = await gbrain(brain, ['embed', '--slugs', 'archive/day-a', '--source', 'default', '--max-usd', '0.0001', '--json']);
    expect(run.stderr).not.toContain('cost_cap_exceeded');
    expect(run.exitCode, run.stderr).toBe(BUDGET_STOP_EXIT_CODE);
    expect((await row(brain, 'archive/day-a')).state).not.toBe('held');
  }, 240_000);

  test('--held --background is admitted: on PGLite it runs inline and releases the hold', async () => {
    const run = await gbrain(brain, ['embed', '--held', '--background', '--source', 'default', '--max-usd', '1']);
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stderr).not.toContain('runs in the foreground');
    expect(await row(brain, 'archive/day-a')).toMatchObject({ state: 'open', embedded: 3 });
  }, 240_000);
});
