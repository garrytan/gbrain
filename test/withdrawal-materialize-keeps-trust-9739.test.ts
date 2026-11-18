import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { materializePageSnapshot } from '../src/core/page-state/materialize.ts';
import { withWriteTrust } from '../src/core/persistence/context.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => {
  await engine.disconnect();
});

test('materializing a withdrawal overlay keeps the page trust tier', async () => {
  const claim = 'Acme ships widgets';
  const body = `Intro\n\n<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|\n| 1 | ${claim} | fact | 1.0 | world | medium | 2026-01-01 | | test | |\n<!--- gbrain:facts:end -->`;
  await engine.transaction(tx => withWriteTrust(tx, { tier: 'agent_written', origin: { channel: 'test' } }, () =>
    tx.putPage('companies/acme-example', { type: 'note', title: 'Acme', compiled_truth: body, timeline: '', frontmatter: {} })));
  const tier = async () => (await engine.executeRaw<{ trust_tier: string }>("SELECT trust_tier FROM pages WHERE slug='companies/acme-example'"))[0].trust_tier;
  expect(await tier()).toBe('agent_written');
  await engine.executeRaw(`INSERT INTO fact_withdrawals(source_id,visibility,fact_hash) VALUES ('default','world',gbrain_fact_fingerprint($1))`, [claim]);
  const snapshot = (await engine.readPageSnapshot('companies/acme-example', { sourceId: 'default' }))!;
  expect(snapshot.withdrawals).toHaveLength(1);
  let error: unknown;
  try { await materializePageSnapshot(engine, snapshot); } catch (e) { error = e; }
  expect(error).toBeUndefined();
  const stored = (await engine.executeRaw<{ compiled_truth: string }>("SELECT compiled_truth FROM pages WHERE slug='companies/acme-example'"))[0];
  expect(stored.compiled_truth).toContain(`~~${claim}~~`);
  expect(await tier()).toBe('agent_written');
});
