/**
 * BrainEngine parity — the segmented-mirror repair's statements (engine-sql/segmented-mirror-effects.ts):
 * `insertRemirrorEffects` and `readRemirrorEffects` (repair/segmented-mirror.ts admitRemirror and the apply's effect
 * wait), and `listGlobalPurgeWithdrawals`, the `*` purge lookup of the typed withdrawal overlay
 * (page-state/snapshot.ts overlayCanonicalBodiesTyped, which the repair's file check runs).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a re-mirror queues one `withdrawal-mirror` and one `git` effect for its request, never twice, and none for
 *    an unknown source; the read answers them in kind order with state, error code, open recovery, parked and skipped
 *    pages, none for another request, and refuses a request id that is not a uuid with the `::uuid` cast's message. The
 *    purge lookup answers the source's subject-`*` purges of the asked fingerprints only, world rows only when asked,
 *    in (visibility, fingerprint) order; the typed overlay drops a purged fence row from a body the same way the raw
 *    overlay does. On every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm through
 *    test/engine-parity/harness.ts).
 *  - Regression: the statements were raw SQL in the repair, so the Rust engine refused the re-mirror's admission, its
 *    effect wait and the file check of a page with a purge marker at `executeRaw`.
 *  - Why existing coverage misses it: test/engine-parity/repair-owner-kinds.test.ts walks segmented pages with no
 *    withdrawal, so it never reaches the overlay, the effect insert or the read.
 *  - Seam: none. Typed members and the real admission path only (no executeRaw: D18).
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { submissionAuthority } from '../../src/core/persistence/authority.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { admitWrite } from '../../src/core/persistence/journal.ts';
import { renderFactsTable } from '../../src/core/facts-fence.ts';
import { fenceClaimHashes } from '../../src/core/facts/withdrawal-overlay.ts';
import { overlayCanonicalBodies, overlayCanonicalBodiesTyped } from '../../src/core/page-state/snapshot.ts';

const { parityTest } = parityArms(testBackends());

const REQUEST = 'c0000000-0000-4000-8000-0000000000d1';
const OTHER = 'c0000000-0000-4000-8000-0000000000d2';

/** 'ok', or the part of the refusal message `pattern` matches (the whole message when it does not match). */
async function outcome(run: () => Promise<unknown>, pattern: RegExp): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return pattern.exec(message)?.[0] ?? message;
  }
}

/** Admits one put_page request for `slug` through the real admission path; it stays queued. */
async function admitPut(engine: BrainEngine, slug: string, requestId: string) {
  const source = await engine.readSourceMembership('default');
  const ctx: OperationContext = { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: 'default',
    logger: { info() {}, warn() {}, error() {} } } as OperationContext;
  const authority = await submissionAuthority(ctx, 'put_page', 'default', source!.incarnation, slug);
  return admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default',
    sourceIncarnation: source!.incarnation, slug, requestId, callerIntent: { body: slug }, intent: { body: slug } });
}

const KEPT = 'Alice Example runs the platform team';
const PURGED = 'Alice Example prefers written agendas';
const BODY = `# Alice Example\n\n## Facts\n\n${renderFactsTable([
  { rowNum: 1, claim: KEPT, kind: 'fact', confidence: 1, visibility: 'world', notability: 'high', active: true },
  { rowNum: 2, claim: PURGED, kind: 'fact', confidence: 1, visibility: 'world', notability: 'high', active: true },
] as never)}\n`;
/** The same fence with the purged row alone, whose claim fingerprints the purges name. */
const PURGED_BODY = `## Facts\n\n${renderFactsTable([
  { rowNum: 2, claim: PURGED, kind: 'fact', confidence: 1, visibility: 'world', notability: 'high', active: true },
] as never)}\n`;

describe('engine parity: the segmented-mirror repair statements', () => {
  parityTest('a re-mirror queues its mirror and Git effects once, and the read answers them in kind order', {
    methods: ['insertRemirrorEffects', 'readRemirrorEffects', 'readSourceMembership', 'transaction'],
    timeout: 60_000,
  }, async (engine) => {
    await registerLocalWriter(engine, 'cli');
    const row = await admitPut(engine, 'notes/remirror', REQUEST);
    const data = { version: 2, commit_subject: 'gbrain: re-mirror segmented page notes/remirror', targets: [{ slug: 'notes/remirror', page_id: 1, revision: '1' }],
      parked: true, skipped: [{ slug: 'notes/remirror', reason: 'preview_changed' }] };
    await engine.transaction(tx => tx.insertRemirrorEffects(row.id, 'default', data));
    await engine.transaction(tx => tx.insertRemirrorEffects(row.id, 'default', { version: 2 }));
    await engine.transaction(tx => tx.insertRemirrorEffects(row.id, 'no-such-source', { version: 2 }));
    const effects = await engine.readRemirrorEffects(row.id);
    const other = await engine.readRemirrorEffects(OTHER);
    const bad = await outcome(() => engine.readRemirrorEffects('not-a-request'), /invalid input syntax for type uuid: "[^"]*"/);
    const skipped = [{ slug: 'notes/remirror', reason: 'preview_changed' }];
    const answers = { effects, other, bad };
    expect(answers).toEqual({
      effects: [
        { kind: 'git', state: 'queued', error_code: null, recovering: false, parked: true, skipped },
        { kind: 'withdrawal-mirror', state: 'queued', error_code: null, recovering: false, parked: true, skipped },
      ],
      other: [],
      bad: 'invalid input syntax for type uuid: "not-a-request"',
    });
    return answers;
  });

  parityTest('the * purge lookup answers the asked fingerprints, and the typed overlay drops the purged fence row', {
    methods: ['listGlobalPurgeWithdrawals', 'insertFactPurge', 'normalizeFenceLines'],
    timeout: 60_000,
  }, async (engine, backend) => {
    const [normalized, purgedOnly] = await engine.normalizeFenceLines([BODY, PURGED_BODY], ['', '']);
    const purgedHashes = fenceClaimHashes([purgedOnly!.body ?? '']);
    const all = fenceClaimHashes([normalized!.body ?? '']);
    expect(purgedHashes.length).toBeGreaterThan(0);
    const purge = (visibility: string, subject: string, factHash: string) =>
      engine.insertFactPurge({ sourceId: 'default', visibility, subject, factHash, requestId: null, actor: 'test', reason: null });
    await purge('world', '*', purgedHashes[0]!);
    await purge('private', '*', purgedHashes[0]!);
    await purge('world', 'people/alice-example', all.find(h => !purgedHashes.includes(h))!);
    await purge('world', '*', 'f'.repeat(64));
    const shape = (rows: Array<{ visibility: string; fact_hash: string; withdrawn_at: unknown; purged?: boolean }>) =>
      rows.map(w => ({ visibility: w.visibility, hashed: purgedHashes.indexOf(w.fact_hash), purged: w.purged,
        at: typeof w.withdrawn_at === 'string' && !Number.isNaN(Date.parse(w.withdrawn_at)) }));
    const every = shape(await engine.listGlobalPurgeWithdrawals('default', all, false));
    const world = shape(await engine.listGlobalPurgeWithdrawals('default', all, true));
    const none = await engine.listGlobalPurgeWithdrawals('default', [], false);
    const marker = { sourceId: 'default', marker: { count: 3, world_only: true } };
    const typed = await overlayCanonicalBodiesTyped(engine, BODY, '', [], marker as never);
    if (backend !== 'rust') expect(typed).toEqual(await overlayCanonicalBodies(engine.executeRaw.bind(engine), BODY, '', [], marker as never));
    const answers = { every, world, none, keeps: typed.compiled_truth.includes(KEPT), drops: !typed.compiled_truth.includes(PURGED) };
    expect(answers).toEqual({
      every: [{ visibility: 'private', hashed: 0, purged: true, at: true }, { visibility: 'world', hashed: 0, purged: true, at: true }],
      world: [{ visibility: 'world', hashed: 0, purged: true, at: true }],
      none: [], keeps: true, drops: true,
    });
    return answers;
  });
});
