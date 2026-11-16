/**
 * #7299: propose_takes does not re-propose a claim the operator rejected on
 * the same page.
 *
 * Protects: after an operator rejects a proposal, an unrelated edit to the
 * page (a new content hash, so the page is extracted again) does not put the
 * same claim text back in the review queue; a different claim from the same
 * extraction still lands; a page whose only claims were rejected is cached at
 * its new hash so the next cycle spends no model call on it.
 * Fails when: proposals are inserted without checking the page's rejected rows.
 * Why new: the per-claim idempotency tests cover one content hash only.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runPhaseProposeTakes, type ProposeTakesExtractor } from '../src/core/cycle/propose-takes.ts';
import { rejectProposal } from '../src/core/take-proposals.ts';
import type { OperationContext } from '../src/core/operations.ts';

const SLUG = 'wiki/essays/release-cadence';
const REJECTED = 'Project Atlas uses a weekly release cadence.';
const OTHER = 'Project Atlas will ship its public beta in 2027.';
let engine: PGLiteEngine;

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

const ctx = (): OperationContext => ({ engine, config: {} as never, logger: { info() {}, warn() {}, error() {} } as never, dryRun: false, remote: false, sourceId: 'default' });
const put = (body: string) => engine.putPage(SLUG, { title: 'release cadence', type: 'analysis' as never, compiled_truth: body, frontmatter: {}, timeline: '' });
const pending = async () => (await engine.executeRaw<{ claim_text: string }>(
  "SELECT claim_text FROM take_proposals WHERE source_id='default' AND page_slug=$1 AND status='pending' ORDER BY claim_text", [SLUG])).map(r => r.claim_text);

test('#7299: a rejected claim is not proposed again after an unrelated edit; another claim still lands', async () => {
  let claims = [REJECTED];
  let calls = 0;
  const extractor: ProposeTakesExtractor = async () => { calls++; return claims.map(claim_text => ({ claim_text, kind: 'take', holder: 'brain', weight: 0.6 })); };

  await put('Project Atlas uses a weekly release cadence.');
  await runPhaseProposeTakes(ctx(), { extractor });
  const [first] = await engine.executeRaw<{ id: number }>("SELECT id FROM take_proposals WHERE page_slug=$1 AND claim_text=$2", [SLUG, REJECTED]);
  await rejectProposal({ engine, sourceId: 'default', actedBy: 'alice-example' }, Number(first!.id));

  await put('Project Atlas uses a weekly release cadence.\n\nAn unrelated paragraph about the team offsite.');
  const second = await runPhaseProposeTakes(ctx(), { extractor });
  expect(calls).toBe(2);
  expect(await pending()).toEqual([]);
  expect((second.details as Record<string, unknown>).proposals_inserted).toBe(0);

  const third = await runPhaseProposeTakes(ctx(), { extractor });
  expect(calls).toBe(2);
  expect((third.details as Record<string, unknown>).cache_hits).toBe(1);

  claims = [REJECTED, OTHER];
  await put('Project Atlas uses a weekly release cadence.\n\nThe public beta ships in 2027.');
  await runPhaseProposeTakes(ctx(), { extractor });
  expect(await pending()).toEqual([OTHER]);
});
