/**
 * robert-cos timeline-mutation patch — durable regression tests.
 *
 * Ships WITH the patch (second review item 14) so the matrix reruns from the
 * branch on every patch edit, instead of living only in canary transcripts.
 *
 * Coverage: get/update/remove by id; ATOMIC optimistic identity checks
 * (summary + date + owning slug + page source inside the mutation
 * predicate); wrong-source / wrong-slug refusals; same-numeric-id
 * cross-brain collision (ids are database-local); audit-write failure
 * refusing the mutation (intent-first); audit brain attribution and
 * 0700/0600 permissions; repeated removal idempotence; dry-run.
 *
 * PGLite runs fully offline. The same matrix runs against real Postgres when
 * ROBERT_COS_PG_TEST_URL_A and ROBERT_COS_PG_TEST_URL_B name two SCRATCH
 * databases (both are schema-initialized and mutated — never point them at
 * a real brain). Postgres engines connect with poolSize (instance-level
 * pools): the default module-singleton path silently reuses the first
 * connection for every later database_url, which would collapse the two
 * brains into one. Identities are salted per process and the collision test
 * aligns id sequences explicitly, so runs are robust against accumulated
 * rows — periodically recreating the scratch databases is hygiene, not a
 * requirement.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, chmodSync, statSync, readFileSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { PageInput } from '../src/core/types.ts';

const updateOp = operationsByName['update_timeline_entry'];
const removeOp = operationsByName['remove_timeline_entry'];

const DATE = '2026-08-14';
const DETAIL = 'life/events/2026/08/14/test-session granola:fx_evt_0001';

// Per-test unique identity, salted per process: scratch Postgres databases
// persist rows across tests AND across runs, so a deterministic counter
// alone would let a rerun's readbacks match the previous run's (already
// mutated) rows.
let seedCounter = 0;
const RUN_SALT = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
interface Identity { slug: string; summary: string }
function freshIdentity(): Identity {
  const n = ++seedCounter;
  return {
    slug: `entities/people/test-person-${RUN_SALT}-${n}--abc123`,
    summary: `Attended: Test Session ${RUN_SALT}-${n} -> life/events/2026/08/14/test-session`,
  };
}

function makeCtx(engine: BrainEngine, brainId: string): OperationContext {
  return {
    engine,
    config: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
    brainId,
  } as unknown as OperationContext;
}

async function seedEntry(engine: BrainEngine, ident: Identity): Promise<number> {
  await engine.putPage(
    ident.slug,
    { type: 'note', title: 'Test Person', compiled_truth: 'Synthetic test person.' } as unknown as PageInput,
    { sourceId: 'default' },
  );
  await engine.addTimelineEntry(
    ident.slug,
    { date: DATE, summary: ident.summary, detail: DETAIL, source: 'granola-ingest' },
    { sourceId: 'default' },
  );
  const entries = await engine.getTimeline(ident.slug, { sourceId: 'default' });
  const mine = entries.find((e) => e.summary === ident.summary);
  if (!mine) throw new Error('seed failed: entry not found after add');
  return mine.id;
}

const EXPECTED = (ident: Identity, overrides: Partial<Record<string, string>> = {}) => ({
  expected_summary: ident.summary,
  expected_date: DATE,
  expected_slug: ident.slug,
  page_source: 'default',
  ...overrides,
});

interface EngineVariant {
  name: string;
  make: () => Promise<BrainEngine>;
  makeSecond: () => Promise<BrainEngine>;
}

const variants: EngineVariant[] = [
  {
    name: 'PGLite',
    make: async () => {
      const e = new PGLiteEngine();
      await e.connect({});
      await e.initSchema();
      return e;
    },
    makeSecond: async () => {
      const e = new PGLiteEngine();
      await e.connect({});
      await e.initSchema();
      return e;
    },
  },
];

const PG_A = process.env.ROBERT_COS_PG_TEST_URL_A;
const PG_B = process.env.ROBERT_COS_PG_TEST_URL_B;
if (PG_A && PG_B) {
  // poolSize forces an instance-level connection: the module-singleton path
  // (no poolSize) silently reuses the FIRST database_url for every later
  // connect, which would collapse the two test brains into one database.
  const makePg = (url: string) => async () => {
    const e = new PostgresEngine();
    await e.connect({ database_url: url, poolSize: 2 });
    await e.initSchema();
    return e;
  };
  variants.push({ name: 'Postgres', make: makePg(PG_A), makeSecond: makePg(PG_B) });
}

let auditHome: string;
let priorGbrainHome: string | undefined;

beforeAll(() => {
  priorGbrainHome = process.env.GBRAIN_HOME;
  auditHome = mkdtempSync(join(tmpdir(), 'rc-tl-audit-'));
  process.env.GBRAIN_HOME = auditHome;
});

afterAll(() => {
  if (priorGbrainHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = priorGbrainHome;
  try { chmodSync(join(auditHome, '.gbrain'), 0o700); } catch { /* may not exist */ }
  rmSync(auditHome, { recursive: true, force: true });
});

function auditDir(): string {
  return join(auditHome, '.gbrain', 'audit');
}

function auditRecords(): Array<Record<string, unknown>> {
  if (!existsSync(auditDir())) return [];
  const records: Array<Record<string, unknown>> = [];
  // Only OUR weekly files: upstream gbrain audits (e.g. mount-ops) share
  // the audit directory with their own formats and default modes.
  for (const f of readdirSync(auditDir()).filter((n) => n.startsWith('timeline-mutations-'))) {
    for (const line of readFileSync(join(auditDir(), f), 'utf-8').split('\n')) {
      if (line.trim()) records.push(JSON.parse(line));
    }
  }
  return records;
}

for (const variant of variants) {
  describe(`timeline mutation by id (${variant.name})`, () => {
    let engine: BrainEngine;
    const cleanups: Array<() => Promise<void>> = [];

    beforeEach(async () => {
      engine = await variant.make();
      cleanups.push(() => engine.disconnect());
      // Restore the shared audit home in case a failure test degraded it.
      process.env.GBRAIN_HOME = auditHome;
    });

    afterAll(async () => {
      for (const c of cleanups.splice(0)) await c().catch(() => {});
    });

    test('get/update/remove round trip with full identity', async () => {
      const ident = freshIdentity();
      const id = await seedEntry(engine, ident);
      const ctx = makeCtx(engine, 'brain-a');

      const row = await engine.getTimelineEntryById(id);
      expect(row?.summary).toBe(ident.summary);
      expect(row?.page_slug).toBe(ident.slug);
      expect(row?.page_source).toBe('default');

      const upd = (await updateOp.handler(ctx, {
        id, ...EXPECTED(ident), summary: `${ident.summary} (renamed)`,
      })) as Record<string, unknown>;
      expect(upd.status).toBe('ok');
      expect(upd.audit).toBe('complete');
      expect((await engine.getTimelineEntryById(id))?.summary).toBe(`${ident.summary} (renamed)`);

      const rm = (await removeOp.handler(ctx, {
        id, ...EXPECTED(ident, { expected_summary: `${ident.summary} (renamed)` }),
      })) as Record<string, unknown>;
      expect(rm.status).toBe('ok');
      expect(await engine.getTimelineEntryById(id)).toBeNull();
    });

    test('engine predicate is atomic: any stale identity field matches zero rows', async () => {
      const ident = freshIdentity();
      const id = await seedEntry(engine, ident);
      const good = { summary: ident.summary, date: DATE, page_slug: ident.slug, page_source: 'default' };

      for (const stale of [
        { ...good, summary: 'someone changed it' },
        { ...good, date: '2026-08-15' },
        { ...good, page_slug: 'entities/people/wrong-person--zzzzzz' },
        { ...good, page_source: 'not-default' },
      ]) {
        expect(await engine.updateTimelineEntryById(id, stale, { detail: 'x' })).toBe(false);
        expect(await engine.removeTimelineEntryById(id, stale)).toBe(false);
      }
      const row = await engine.getTimelineEntryById(id);
      expect(row?.summary).toBe(ident.summary);
      expect(row?.detail).toBe(DETAIL);

      expect(await engine.removeTimelineEntryById(id, good)).toBe(true);
      expect(await engine.getTimelineEntryById(id)).toBeNull();
    });

    test('op refuses stale expected_summary without mutating', async () => {
      const ident = freshIdentity();
      const id = await seedEntry(engine, ident);
      const ctx = makeCtx(engine, 'brain-a');
      await expect(
        updateOp.handler(ctx, { id, ...EXPECTED(ident, { expected_summary: 'stale' }), detail: 'x' }),
      ).rejects.toThrow(/optimistic check failed/);
      expect((await engine.getTimelineEntryById(id))?.detail).toBe(DETAIL);
    });

    test('op refuses wrong page_source and wrong expected_slug', async () => {
      const ident = freshIdentity();
      const id = await seedEntry(engine, ident);
      const ctx = makeCtx(engine, 'brain-a');
      await expect(
        removeOp.handler(ctx, { id, ...EXPECTED(ident, { page_source: 'other' }) }),
      ).rejects.toThrow(/source mismatch/);
      await expect(
        removeOp.handler(ctx, { id, ...EXPECTED(ident, { expected_slug: 'entities/people/other--aaaaaa' }) }),
      ).rejects.toThrow(/slug mismatch/);
      expect(await engine.getTimelineEntryById(id)).not.toBeNull();
    });

    test('same numeric id in two brains: only the ctx brain mutates', async () => {
      const engineB = await variant.makeSecond();
      cleanups.push(() => engineB.disconnect());
      // Manufacture the dangerous collision case deliberately: the two
      // brains' id sequences drift apart as tests accumulate rows, so first
      // seed filler entries into whichever brain lags until both sequences
      // stand at the same value, then seed the SAME identity into both —
      // same numeric id, summary, slug and source in two different brains.
      let nA = await seedEntry(engine, freshIdentity());
      let nB = await seedEntry(engineB, freshIdentity());
      for (let i = 0; nA !== nB && i < 500; i++) {
        if (nA < nB) nA = await seedEntry(engine, freshIdentity());
        else nB = await seedEntry(engineB, freshIdentity());
      }
      expect(nA).toBe(nB);
      const ident = freshIdentity();
      const idA = await seedEntry(engine, ident);
      const idB = await seedEntry(engineB, ident);
      expect(idA).toBe(idB);

      const ctxA = makeCtx(engine, 'brain-a');
      const rm = (await removeOp.handler(ctxA, { id: idA, ...EXPECTED(ident) })) as Record<string, unknown>;
      expect(rm.status).toBe('ok');

      expect(await engine.getTimelineEntryById(idA)).toBeNull();
      // Brain B's identical row is untouched.
      const rowB = await engineB.getTimelineEntryById(idB);
      expect(rowB?.summary).toBe(ident.summary);
    });

    test('wrong-brain invocation is a safe noop', async () => {
      const engineB = await variant.makeSecond();
      cleanups.push(() => engineB.disconnect());
      const ident = freshIdentity();
      const idB = await seedEntry(engineB, ident);
      // The id must be absent in brain A: probe A and only assert the noop
      // when A genuinely has no such row (guaranteed on fresh scratch DBs).
      const inA = await engine.getTimelineEntryById(idB);
      expect(inA).toBeNull();
      const ctxA = makeCtx(engine, 'brain-a');
      const rm = (await removeOp.handler(ctxA, { id: idB, ...EXPECTED(ident) })) as Record<string, unknown>;
      expect(rm.status).toBe('noop');
      expect(rm.reason).toBe('not-found');
      expect(await engineB.getTimelineEntryById(idB)).not.toBeNull();
    });

    test('repeated removal is idempotent', async () => {
      const ident = freshIdentity();
      const id = await seedEntry(engine, ident);
      const ctx = makeCtx(engine, 'brain-a');
      const first = (await removeOp.handler(ctx, { id, ...EXPECTED(ident) })) as Record<string, unknown>;
      expect(first.status).toBe('ok');
      const second = (await removeOp.handler(ctx, { id, ...EXPECTED(ident) })) as Record<string, unknown>;
      expect(second.status).toBe('noop');
      expect(second.reason).toBe('not-found');
    });

    test('audit-write failure refuses the mutation (intent-first)', async () => {
      const ident = freshIdentity();
      const id = await seedEntry(engine, ident);
      const ctx = makeCtx(engine, 'brain-a');
      const lockedHome = mkdtempSync(join(tmpdir(), 'rc-tl-locked-'));
      mkdirSync(join(lockedHome, '.gbrain'), { mode: 0o500 });
      chmodSync(join(lockedHome, '.gbrain'), 0o500);
      process.env.GBRAIN_HOME = lockedHome;
      try {
        await expect(
          updateOp.handler(ctx, { id, ...EXPECTED(ident), detail: 'must not land' }),
        ).rejects.toThrow();
        // The mutation did NOT happen: no unaudited mutation is possible.
        expect((await engine.getTimelineEntryById(id))?.detail).toBe(DETAIL);
      } finally {
        process.env.GBRAIN_HOME = auditHome;
        chmodSync(join(lockedHome, '.gbrain'), 0o700);
        rmSync(lockedHome, { recursive: true, force: true });
      }
    });

    test('audit records carry brain attribution; dir 0700, files 0600', async () => {
      const ident = freshIdentity();
      const id = await seedEntry(engine, ident);
      const brainName = `brain-attribution-${variant.name}`;
      const ctx = makeCtx(engine, brainName);
      await updateOp.handler(ctx, { id, ...EXPECTED(ident), detail: 'audited change' });

      const records = auditRecords().filter((r) => r.brain === brainName);
      const phases = records.map((r) => r.phase);
      expect(phases).toContain('intent');
      expect(phases).toContain('result');
      const intent = records.find((r) => r.phase === 'intent') as Record<string, unknown>;
      expect(intent.op).toBe('update_timeline_entry');
      expect(intent.page_slug).toBe(ident.slug);
      expect((intent.before as Record<string, unknown>).detail).toBe(DETAIL);

      expect(statSync(auditDir()).mode & 0o777).toBe(0o700);
      // Our weekly files are 0600. Upstream gbrain writes its own audit
      // files (mount-ops JSONL) into this directory with default modes —
      // they are shielded by the 0700 directory, not by this contract.
      const ours = readdirSync(auditDir()).filter((f) => f.startsWith('timeline-mutations-'));
      expect(ours.length).toBeGreaterThan(0);
      for (const f of ours) {
        expect(statSync(join(auditDir(), f)).mode & 0o777).toBe(0o600);
      }
    });

    test('dry-run validates preconditions but mutates and audits nothing', async () => {
      const ident = freshIdentity();
      const id = await seedEntry(engine, ident);
      const before = auditRecords().length;
      const ctx = { ...makeCtx(engine, 'brain-a'), dryRun: true } as OperationContext;
      const res = (await updateOp.handler(ctx, { id, ...EXPECTED(ident), detail: 'dry' })) as Record<string, unknown>;
      expect(res.dry_run).toBe(true);
      expect((await engine.getTimelineEntryById(id))?.detail).toBe(DETAIL);
      expect(auditRecords().length).toBe(before);
    });

    test('update with no new values is refused', async () => {
      const ident = freshIdentity();
      const id = await seedEntry(engine, ident);
      const ctx = makeCtx(engine, 'brain-a');
      await expect(updateOp.handler(ctx, { id, ...EXPECTED(ident) })).rejects.toThrow(/no new values/);
    });
  });
}
