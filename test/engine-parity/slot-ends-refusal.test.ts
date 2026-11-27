/**
 * BrainEngine parity — the read-time slot ends (src/core/search/slot-ends.ts applySlotEnds) fail open on a database
 * error and refuse on a missing engine capability.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a listSlotRows read that fails with any error but `engine_capability_missing` leaves the rows as stored;
 *    an `engine_capability_missing` refusal reaches the caller, so a reader on an engine without the
 *    slot read refuses by name instead of showing an ended value (an old employer, city or role) as current. On PGLite
 *    and Postgres, where listSlotRows runs one SQL read and never refuses a capability, recall and the recall op show
 *    the same facts as before the refusal was let through.
 *  - Regression: a blanket catch turned the Rust engine's refusal into "no slot ends", so Rust recall answered with
 *    the old employer still current and no sign of a skipped read.
 *  - Why existing coverage misses it: test/facts-slot-windows-gbra574.test.ts runs on PGLite and Postgres only, where
 *    the read never refuses; test/engine-parity/caller-typed-reads.test.ts pins the recall split but not the fail-open path.
 *  - Seam: applySlotEnds through a stub engine whose only member, listSlotRows, rejects with the error a read can
 *    raise (a plain test: the failure is injected, so no engine arm runs), then, on every arm, the `gbrain recall`
 *    command in process and the `recall` op handler over stored slot rows.
 */
import { describe, expect, test } from 'bun:test';
import { runRecall } from '../../src/commands/recall.ts';
import type { BrainEngine, NewFact } from '../../src/core/engine.ts';
import { isEngineCapabilityRefusal } from '../../src/core/engine-capability-refusal.ts';
import { CONVERSATION_FACTS_SOURCE_PREFIX } from '../../src/core/facts/audit-sources.ts';
import { operations } from '../../src/core/operations.ts';
import { capabilityMissing } from '../../src/core/rust-engine/errors.ts';
import { applySlotEnds } from '../../src/core/search/slot-ends.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const ALICE = 'people/alice-example';
const SCOPE = { sourceId: 'default', worldOnly: false, excludePrivate: false };

/** An engine whose only member, listSlotRows, rejects with `fail`: applySlotEnds reads nothing else. */
function slotReadFailing(fail: () => Error): BrainEngine {
  return { listSlotRows: () => Promise.reject(fail()) } as unknown as BrainEngine;
}

describe('engine parity: read-time slot ends on a failed slot read', () => {
  // No engine arm runs here: the failure is injected, so this is the same on every lane by construction.
  test('a database error from listSlotRows leaves the rows as stored; a capability refusal reaches the caller', async () => {
    const rows = [
      { id: 1, source_id: 'default', entity_slug: ALICE, dimension: 'employer', valid_until: null, fact: 'Alice Example works at Acme Example.' },
      { id: 2, source_id: 'default', entity_slug: ALICE, dimension: 'employer', valid_until: null, fact: 'Alice Example joined Beta Example.' },
    ];
    const reset = slotReadFailing(() => Object.assign(new Error('Connection terminated unexpectedly'), { code: 'ECONNRESET' }));
    const missingTable = slotReadFailing(() => Object.assign(new Error('relation "facts" does not exist'), { code: '42P01' }));
    const refusing = slotReadFailing(() => capabilityMissing('facts', 'listSlotRows'));
    const got = {
      reset: await applySlotEnds(reset, SCOPE, rows, { activeOnly: true }),
      missingTable: await applySlotEnds(missingTable, SCOPE, rows, { activeOnly: false }),
      refused: await applySlotEnds(refusing, SCOPE, rows, { activeOnly: true }).then(
        () => null, (e: unknown) => ({ refusal: isEngineCapabilityRefusal(e), message: (e as Error).message, detail: (e as { detail?: string }).detail })),
    };
    expect(got).toEqual({
      reset: rows,
      missingTable: rows,
      refused: { refusal: true, message: "This brain's engine does not support listSlotRows yet (it needs the facts capability), so nothing ran.",
        detail: 'member=listSlotRows capability=facts outcome=none written=nothing' },
    });
  });

  parityTest('recall and the recall op show an employer a later one ended as ended, as before the refusal was let through', {
    methods: ['insertFacts', 'listSlotRows'],
  }, async (engine) => {
    const P1 = new Date('2024-01-10T00:00:00Z');
    const P2 = new Date('2024-06-10T00:00:00Z');
    const said = (fact: string, valid: Date, slug: string, row: number, value?: string): NewFact & { row_num: number; source_markdown_slug: string } => ({
      fact, entity_slug: ALICE, visibility: 'world', source: `${CONVERSATION_FACTS_SOURCE_PREFIX}:test`, embedding: null, valid_from: valid,
      row_num: row, source_markdown_slug: slug, ...(value ? { dimension: 'employer', value } : {}),
    } as NewFact & { row_num: number; source_markdown_slug: string });
    await engine.insertFacts([said('Alice Example works at Acme Example.', P1, 'meetings/chat-a', 1, 'Acme Example'),
      said('Alice Example likes green tea.', P1, 'meetings/chat-a', 2)], { source_id: 'default' });
    await engine.insertFacts([said('Alice Example joined Beta Example.', P2, 'meetings/chat-b', 1, 'Beta Example')], { source_id: 'default' });
    const cli = async (args: string[]) => {
      let out = '';
      const write = process.stdout.write.bind(process.stdout);
      const writeErr = process.stderr.write.bind(process.stderr);
      process.stdout.write = ((c: unknown) => { out += String(c); return true; }) as typeof process.stdout.write;
      process.stderr.write = (() => true) as typeof process.stderr.write;
      try { await runRecall(engine, [...args, '--json', '--source', 'default']); } finally {
        process.stdout.write = write;
        process.stderr.write = writeErr;
        process.exitCode = 0;
      }
      return shown((JSON.parse(out) as { facts?: Fact[] }).facts);
    };
    const op = async (params: Record<string, unknown>) => {
      const recall = operations.find(o => o.name === 'recall')!;
      const ctx = { engine, config: { engine: engine.kind }, remote: false, dryRun: false, sourceId: 'default', logger: { info() {}, warn() {}, error() {} } };
      return shown(((await recall.handler(ctx as never, params)) as { facts?: Fact[] }).facts);
    };
    const answer = async () => ({
      cli: await cli([ALICE]), cliHistory: await cli([ALICE, '--include-expired']),
      op: await op({ entity: ALICE }), opHistory: await op({ entity: ALICE, include_expired: true }),
    });
    const got = await answer();
    const open = { 'Alice Example joined Beta Example.': null, 'Alice Example likes green tea.': null };
    const history = { ...open, 'Alice Example works at Acme Example.': '2024-06-10' };
    expect(got).toEqual({ cli: open, cliHistory: history, op: open, opHistory: history });
    return got;
  });
});

type Fact = { fact: string; valid_until?: string | null };
/** Each fact shown (a quoted excerpt unwrapped) with its valid_until day (null: open). */
function shown(facts: Fact[] | undefined): Record<string, string | null> {
  return Object.fromEntries((facts ?? []).map(f => [/```text\n([^\n]*)\n```/.exec(f.fact)?.[1] ?? f.fact, f.valid_until ? String(f.valid_until).slice(0, 10) : null] as const));
}
