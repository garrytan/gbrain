/**
 * Shadow privacy evidence (plan a2, decision 6) on PGLite: the wrapper captures the caller's frozen access record with each
 * sampled read, the child runs Rust under it, and every Rust page the primary's answer lacked is judged on the PRIMARY by
 * its read policy for that caller, through the real supervisor ask route (scenarios in
 * test/helpers/shadow-checks-scenarios.ts, shared with the Postgres twin test/e2e/shadow-checks.test.ts).
 *
 * Protects: a same-source private page, a member-restricted page, a folder-restricted page and a page derived from private
 * content each read as `privacy_diverged` and pause mirroring; an authorized page outside the primary's top k does not; a
 * page edited during the check, or a policy generation that moves during it, is inconclusive, never clean; a read that did
 * not ask for the policy is not judged; Rust runs under the captured access; the stable rerun outcomes and the exact vector
 * reference hold on a real primary.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withCallerAccess } from '../src/core/search/private-visibility.ts';
import { createAsker, extraRows, missingPages, policyApplies, privacyVerdict, safeCode } from '../src/shadow/child-checks.ts';
import { ALICE, defineCheckScenarios, privacyFixture } from './helpers/shadow-checks-scenarios.ts';
import { sleep, startRig } from './helpers/shadow-stable-harness.ts';

let engine: PGLiteEngine;
let dataDir: string;

beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  dataDir = mkdtempSync(join(tmpdir(), 'gbrain-shadow-privacy-'));
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: dataDir } as never);
  await engine.initSchema();
}, 120_000);
afterAll(async () => {
  await engine.disconnect();
  rmSync(dataDir, { recursive: true, force: true });
  resetGateway();
});

defineCheckScenarios({ primary: () => engine, dialect: 'pglite' });

describe('policy generation', () => {
  test('an access rule added during the check moves the generation: inconclusive, never a pause', async () => {
    const ids = await privacyFixture(engine);
    let done = false;
    const moving = new Proxy(engine, { get: (target, prop) => {
      if (prop !== 'transaction') return Reflect.get(target, prop, target);
      return async (fn: (tx: BrainEngine) => Promise<unknown>, opts: never) => {
        let generationRead = false;
        const result = await target.transaction(async (tx) => fn(new Proxy(tx, { get: (t, p) => (p === 'executeRaw' ? (text: string, ...a: never[]) => { if (text.includes('access_policy_revisions')) generationRead = true; return (t.executeRaw as Function).call(t, text, ...a); } : Reflect.get(t, p, t)) }) as BrainEngine), opts);
        if (generationRead && !done) { done = true; await target.executeRaw(`INSERT INTO access_rules(source_id,rule_id,prefix,readable_by,revision) VALUES('default','moved','elsewhere/',ARRAY['member:bob-example'],2)`); } // the rule lands right after the first generation read: between the two
        return result;
      };
    } }) as BrainEngine;
    const rig = await startRig({ primary: moving, unseeded: true });
    done = false; // the rig's own reads before the sample are not the check
    try {
      rig.rust.listPages = async () => [{ id: ids['priv/a'], slug: 'priv/a', source_id: 'default', title: 'x', type: 'note' }];
      await withCallerAccess(ALICE, () => rig.engine.listPages({ limit: 100, excludePrivate: true }));
      expect((await rig.finish())[0]).toMatchObject({ outcome: 'inconclusive', reason: 'privacy_check_moved' });
      expect(rig.stoppedBy).toBeNull();
    } finally { rig.cleanup(); }
  });
});

describe('page candidates', () => {
  test('are the Rust pages the primary did not show, by id or by source and slug; the policy is only asked for under excludePrivate', () => {
    const a = { page_id: 1, source_id: 's', slug: 'a' };
    expect(missingPages([a], [a, { page_id: 2, source_id: 's', slug: 'b' }, { source_id: 's', slug: 'c' }])).toEqual({ ids: [2], keys: ['s\u001fc'], chunks: [] }); // a slug is sent only for a row with no page id
    expect(missingPages(null, { id: 7, slug: 'p', source_id: 's' })).toEqual({ ids: [7], keys: [], chunks: [] });
    expect(missingPages([a], [{ page_id: 1, source_id: 's', slug: 'renamed' }])).toEqual({ ids: [], keys: [], chunks: [] });
    expect([policyApplies([{ excludePrivate: true }]), policyApplies([{ remote: { excludePrivate: true } }]), policyApplies([{ untrusted: { excludePrivate: true } }]), policyApplies([{ limit: 1 }, 'x'])]).toEqual([true, true, true, false]);
  });

  test('a row is the primary\'s only at row identity: the same chunk id with other text, or another chunk of the same page, is extra', () => {
    const own = { page_id: 1, source_id: 's', slug: 'a', chunk_id: 10, chunk_text: 'the primary text' };
    expect(extraRows([own], [own]).rows).toEqual([]);
    expect(extraRows([own], [{ ...own, score: 0.1 }]).rows).toEqual([]); // a score is not identity
    expect(extraRows([own], [{ ...own, chunk_text: 'SUBSTITUTED' }]).rows).toHaveLength(1);
    expect(extraRows([own], [{ ...own, chunk_id: 11, chunk_text: 'another chunk' }]).rows).toMatchObject([{ id: 1, chunk: { id: 11 } }]);
    expect(missingPages([own], [{ ...own, chunk_id: 11, chunk_text: 'x' }])).toEqual({ ids: [1], keys: [], chunks: [11] });
    expect(extraRows([own], [{ chunk_text: 'no page identity' }]).unidentified).toBe(1);
  });

  test('a row that differs from the primary\'s row of that page and chunk in any field but a score, or names no valid chunk, is unidentified, never cleared', () => {
    const own = { page_id: 1, source_id: 's', slug: 'a', title: 'T', chunk_id: 10, chunk_text: 'the primary text', score: 0.9 };
    expect(extraRows([own], [{ ...own, score: 0.1 }])).toEqual({ rows: [], unidentified: 0 });
    for (const changed of [{ title: 'SUBSTITUTED TITLE' }, { stale: true }, { chunk_source: 'timeline' }]) expect([changed, extraRows([own], [{ ...own, ...changed }])]).toEqual([changed, { rows: [], unidentified: 1 }]);
    for (const chunk of [{ chunk_id: undefined }, { chunk_id: null }, { chunk_id: '10' }, { chunk_id: 1.5 }]) expect([chunk, extraRows([own], [{ ...own, ...chunk, chunk_text: 'ARBITRARY' }]).unidentified]).toEqual([chunk, 1]);
    expect(extraRows([own], [{ page_id: 2, source_id: 's', slug: 'b', title: 'T', score: 0.5 }]).unidentified).toBe(1); // a ranked row on another page with no chunk at all
    expect(extraRows([own], [{ page_id: 2, source_id: 's', slug: 'b', title: 'T', chunk_id: 12, chunk_text: 'other', score: 0.5 }])).toMatchObject({ rows: [{ id: 2, chunk: { id: 12 } }], unidentified: 0 }); // a new chunk on a new page is for the primary to judge
    expect(extraRows([{ page_id: 1, source_id: 's', slug: 'a' }], [{ page_id: 3, source_id: 's', slug: 'c' }]).rows).toMatchObject([{ id: 3 }]); // page rows carry no chunk: page-only
  });

  test('a malformed element of the Rust answer makes the verdict incomplete on the sample and the rerun path alike, whatever the serving process says', async () => {
    const saysClean = Object.assign(async () => ({ verdict: 'clean', complete: true }), { answer() {}, closeAll() {} }) as never;
    const args = [{ excludePrivate: true }];
    const row = { page_id: 1, source_id: 's', slug: 'a', chunk_id: 10, chunk_text: 't', score: 0.5 };
    for (const phase of ['sample', 'rerun'] as const) {
      expect([phase, await privacyVerdict(saysClean, args, [], [null, 'private canary'], 'sid', phase, 0)]).toEqual([phase, { verdict: 'clean', complete: false }]);
      expect([phase, await privacyVerdict(saysClean, args, [row], [row, 7], 'sid', phase, 0)]).toEqual([phase, { verdict: 'clean', complete: false }]);
    }
    expect(await privacyVerdict(saysClean, args, [], [], 'sid', 'rerun', 0)).toEqual({ verdict: 'clean', complete: true }); // control: all rows well formed
  });

  test('a read that answers a list is never complete when its answer is not a list: a null, an undefined or one row, on the sample and the rerun path', async () => {
    const saysClean = Object.assign(async () => ({ verdict: 'clean', complete: true }), { answer() {}, closeAll() {} }) as never;
    const args = [{ excludePrivate: true }];
    const row = { page_id: 1, source_id: 's', slug: 'a', chunk_id: 10, chunk_text: 't', score: 0.5 };
    for (const phase of ['sample', 'rerun'] as const) {
      for (const answer of [null, undefined, row]) expect([phase, answer, await privacyVerdict(saysClean, args, [row], answer, 'sid', phase, 0, true)]).toEqual([phase, answer, { verdict: 'clean', complete: false }]);
      expect(await privacyVerdict(saysClean, args, [row], [row], 'sid', phase, 0, true)).toEqual({ verdict: 'clean', complete: true }); // control: a list
    }
    expect(await privacyVerdict(saysClean, args, row, null, 'sid', 'sample', 0, false)).toEqual({ verdict: 'clean', complete: true }); // a read that answers one row, or none, may answer null
  });

  test('an answer is accepted only with the asking child\'s session nonce, and a failure code is a plain bounded token', async () => {
    const sent: string[] = [];
    const mine = createAsker((line) => { sent.push(line); }, 'session-B');
    const pending = mine({ kind: 'rerun' }, 5_000);
    const id = JSON.parse(sent[0]!).id as number;
    expect(JSON.parse(sent[0]!)).toMatchObject({ t: 'ask', id, session: 'session-B' });
    mine.answer({ id, session: 'session-A', ok: true, value: 'from the old child' }); // meant for another child: ignored
    mine.answer({ id, ok: true, value: 'no session' });
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await sleep(20);
    expect(settled).toBe(false);
    mine.answer({ id, session: 'session-B', ok: true, value: 'mine' });
    expect(await pending).toBe('mine');
    expect([safeCode('watermark_invalid'), safeCode('A message with CANARY text'), safeCode('x'.repeat(80)), safeCode(undefined), safeCode('Upper')]).toEqual(['watermark_invalid', 'failed', 'failed', 'failed', 'failed']);
  });
});
