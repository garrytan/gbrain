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
import { missingPages, policyApplies } from '../src/shadow/child-checks.ts';
import { ALICE, defineCheckScenarios, privacyFixture } from './helpers/shadow-checks-scenarios.ts';
import { startRig } from './helpers/shadow-stable-harness.ts';

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
    let transactions = 0;
    const moving = new Proxy(engine, { get: (target, prop) => {
      if (prop !== 'transaction') return Reflect.get(target, prop, target);
      return async (fn: never, opts: never) => {
        if (++transactions === 2) await target.executeRaw(`INSERT INTO access_rules(source_id,rule_id,prefix,readable_by,revision) VALUES('default','moved','elsewhere/',ARRAY['member:bob-example'],2)`);
        return target.transaction(fn, opts); // the policy read is the second transaction, between the two generation reads
      };
    } }) as BrainEngine;
    const rig = await startRig({ primary: moving, unseeded: true });
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
    expect(missingPages([a], [a, { page_id: 2, source_id: 's', slug: 'b' }, { source_id: 's', slug: 'c' }])).toEqual({ ids: [2], keys: ['s\u001fb', 's\u001fc'] });
    expect(missingPages(null, { id: 7, slug: 'p', source_id: 's' })).toEqual({ ids: [7], keys: ['s\u001fp'] });
    expect(missingPages([a], [{ page_id: 1, source_id: 's', slug: 'renamed' }])).toEqual({ ids: [], keys: [] });
    expect([policyApplies([{ excludePrivate: true }]), policyApplies([{ remote: { excludePrivate: true } }]), policyApplies([{ untrusted: { excludePrivate: true } }]), policyApplies([{ limit: 1 }, 'x'])]).toEqual([true, true, true, false]);
  });
});
