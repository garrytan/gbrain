/**
 * The evidence scenario shared by test/shadow-follow.test.ts (PGLite) and test/e2e/shadow-follow.test.ts (Postgres): a
 * seeded brain with the real Rust addon, a real shadow child and a wrapped primary. Reads at sample rate 1 must come
 * back as epoch-tagged ledger rows the aggregator folds into `reads`, with the addon's real digest and capability hash in the
 * epoch manifest, and the usage meter must have counted every call.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { RustAddon } from '../../src/core/rust-engine/addon-loader.ts';
import { servedCapabilities } from '../../src/core/rust-engine/store-capabilities.ts';
import { attachShadowParts } from '../../src/shadow/attach.ts';
import { capabilitySetHash, readEpoch } from '../../src/shadow/evidence-epoch.ts';
import { buildEvidenceStatus } from '../../src/shadow/evidence.ts';
import { writeSeedRecord } from '../../src/shadow/seed.ts';
import { fillSeedFixture, seedInto } from './shadow-seed-fixture.ts';
import { readEpochRecall } from '../../src/shadow/recall.ts';
import { vec, vectorFixture } from './shadow-checks-scenarios.ts';
import { withEnv } from './with-env.ts';

export interface EvidenceScenarioContext {
  primary: () => BrainEngine;
  addon: () => RustAddon;
  /** The built addon file the scenario's child loads (GBRAIN_RUST_ENGINE_ADDON). */
  addonPath: string;
  kind: 'pglite' | 'postgres';
}

export function defineEvidenceScenarios(ctx: EvidenceScenarioContext): void {
  test('reads through a real child become epoch-tagged rows with the addon digest, and every call is counted', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-shadow-evidence-real-'));
    try {
      const primary = ctx.primary();
      await fillSeedFixture(primary);
      const { record } = await seedInto(primary, ctx.addon(), home, ctx.kind);
      writeSeedRecord(home, record);
      const state = { version: 1, enabled: true, started_at: 'x', sample_rate: 1, queue_bound: 64, plan_hash: 'h', brain: 'b', primary_engine: ctx.kind };
      const calls = 6;
      await withEnv({ GBRAIN_RUST_ENGINE_ADDON: ctx.addonPath }, async () => {
        const attached = attachShadowParts(primary, home, state as never, { gbrainArgv: [process.execPath, join(import.meta.dir, '..', '..', 'src', 'cli.ts')] });
        for (let i = 0; i < 3; i++) await attached.engine.getPage('people/alice-example');
        await attached.engine.getPage('people/nobody-example');
        await attached.engine.searchKeyword('widget');
        await attached.engine.listPages();
        await attached.follower!.settle();
        await new Promise((resolve) => setTimeout(resolve, 50)); // the queue drains on the next event-loop turn
        expect(attached.queue.meter.take()![0]!.ops).toMatchObject({ getPage: { offered: 4 }, searchKeyword: { offered: 1 }, listPages: { offered: 1 } });
        attached.supervisor.stop(); // the child flushes its ledger and exits
        attached.reconciler!.stop();
        const rows = (): Array<Record<string, unknown>> => !existsSync(join(home, 'ledger')) ? [] : readdirSync(join(home, 'ledger'))
          .flatMap((n) => readFileSync(join(home, 'ledger', n), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)));
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline && rows().length < calls) await new Promise((resolve) => setTimeout(resolve, 100));
        const manifest = readEpoch(home)!;
        expect(manifest.inputs).toMatchObject({
          seed_id: record.seed_id, rust_addon_sha256: createHash('sha256').update(readFileSync(ctx.addonPath)).digest('hex'),
          capability_set_hash: capabilitySetHash(servedCapabilities()),
        });
        expect(rows()).toHaveLength(calls);
        expect(rows().every((r) => r.epoch_id === manifest.epoch_id)).toBe(true);
        // A mismatch on these comparisons is never a bare `diff`: it is stale or inconclusive.
        expect(rows().every((r) => ['match', 'stale', 'inconclusive'].includes(String(r.outcome)))).toBe(true);
        const evidence = buildEvidenceStatus({ dir: home });
        expect(evidence.reads!.ops.map((o) => o.op)).toEqual(['getPage', 'listPages', 'searchKeyword']);
        expect(evidence.reads!.ops.every((o) => o.minimum === 100)).toBe(true);
        expect(evidence.reads!.ops.reduce((n, o) => n + o.successful, 0)).toBe(rows().filter((r) => r.outcome === 'match').length);
        expect(evidence.child).toEqual({ panics: 0, faults: 0 });
        expect(evidence.evidence!.epoch_id).toBe(manifest.epoch_id);
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 120_000);

  test('a vector read through a real child is scored against the primary\'s exact reference: the real Rust engine\'s recall is measured, not assumed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-shadow-recall-real-'));
    try {
      const primary = ctx.primary();
      await vectorFixture(primary);
      const { record } = await seedInto(primary, ctx.addon(), home, ctx.kind);
      writeSeedRecord(home, record);
      const state = { version: 1, enabled: true, started_at: 'x', sample_rate: 1, queue_bound: 64, plan_hash: 'h', brain: 'b', primary_engine: ctx.kind };
      await withEnv({ GBRAIN_RUST_ENGINE_ADDON: ctx.addonPath }, async () => {
        const attached = attachShadowParts(primary, home, state as never, { gbrainArgv: [process.execPath, join(import.meta.dir, '..', '..', 'src', 'cli.ts')] });
        await attached.lsnWatch.ready(); // the freshness token the sample is held to is taken before the read starts
        // A moved first check is retried as in production, and the retry is refused until a reconcile pass has made the coverage watermark valid: run one first.
        const pass = await attached.reconciler!.run('full');
        expect(pass.error).toBeUndefined();
        const validBy = Date.now() + 30_000;
        while (Date.now() < validBy && !(await attached.supervisor.request<{ valid: boolean }>('state')).valid) await new Promise((resolve) => setTimeout(resolve, 100));
        expect((await attached.supervisor.request<{ valid: boolean }>('state')).valid).toBe(true);
        await attached.engine.searchVector(vec(3), { limit: 10 });
        await attached.follower!.settle();
        const deadline = Date.now() + 60_000;
        let lines = readEpochRecall(home, readEpoch(home)?.epoch_id ?? 'none') ?? [];
        while (Date.now() < deadline && lines.length < 1) { await new Promise((resolve) => setTimeout(resolve, 100)); lines = readEpochRecall(home, readEpoch(home)?.epoch_id ?? 'none') ?? []; }
        attached.supervisor.stop();
        attached.reconciler!.stop();
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({ vector: 1, primary: 1, ref_size: 10 }); // the real Rust engine returned the exact top ten
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 120_000);

  test('tags the primary sorts by its own collation come back as collation_order, and as a match where the host sorts in C order', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-shadow-collation-'));
    try {
      const primary = ctx.primary();
      await fillSeedFixture(primary);
      for (const tag of ['alpha', 'Beta', 'Zeta']) await primary.addTag('people/alice-example', tag);
      const { record } = await seedInto(primary, ctx.addon(), home, ctx.kind);
      writeSeedRecord(home, record);
      const theirs = await primary.getTags('people/alice-example');
      const cOrder = [...theirs].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
      if (ctx.kind === 'postgres') {
        const [{ datcollate }] = await primary.executeRaw<{ datcollate: string }>('SELECT datcollate FROM pg_database WHERE datname = current_database()');
        // Only a host whose collation is not C can show the class; say so when the arm cannot.
        if (!['C', 'POSIX'].includes(datcollate)) expect(theirs).not.toEqual(cOrder);
      }
      const state = { version: 1, enabled: true, started_at: 'x', sample_rate: 1, queue_bound: 64, plan_hash: 'h', brain: 'b', primary_engine: ctx.kind };
      await withEnv({ GBRAIN_RUST_ENGINE_ADDON: ctx.addonPath }, async () => {
        const attached = attachShadowParts(primary, home, state as never, { gbrainArgv: [process.execPath, join(import.meta.dir, '..', '..', 'src', 'cli.ts')] });
        await attached.engine.getTags('people/alice-example');
        await new Promise((resolve) => setTimeout(resolve, 50));
        attached.supervisor.stop();
        attached.reconciler!.stop();
        const file = () => (existsSync(join(home, 'ledger')) ? readdirSync(join(home, 'ledger')).map((n) => readFileSync(join(home, 'ledger', n), 'utf8').trim()).join('\n') : '');
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline && !file()) await new Promise((resolve) => setTimeout(resolve, 100));
        const rows = file().split('\n').filter(Boolean).map((l) => JSON.parse(l));
        expect(rows.map((r) => r.outcome)).toEqual([JSON.stringify(theirs) === JSON.stringify(cOrder) ? 'match' : 'collation_order']);
        const evidence = buildEvidenceStatus({ dir: home });
        expect(evidence.evidence!.collation_order).toEqual(rows[0].outcome === 'match' ? {} : { getTags: 1 });
        expect(evidence.reads!.ops).toEqual([{ op: 'getTags', successful: 1, minimum: 100 }]); // explained or matching, either way a success
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 120_000);
}
