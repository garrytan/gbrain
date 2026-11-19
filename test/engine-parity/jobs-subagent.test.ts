/**
 * BrainEngine parity — the subagent transcript and tool ledger (engine-sql/jobs-subagent.ts): the messages and tool
 * rows a subagent job writes as it runs, the reads crash replay, the transcript views and the read budget make, and
 * the reads the dream cycle makes to learn which pages its children wrote.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member returns the same rows on every engine arm (PGLite always; Postgres with DATABASE_URL; the
 *    Rust arm through test/engine-parity/harness.ts): messages by `message_idx` (newest only on request) with the
 *    first writer of an index winning; tool rows in replay order (`message_idx`, ordinal with a legacy NULL as 0, id)
 *    or id order; the same raw `tool_use_id` kept per turn and ordinal; a settle that touches its own row first, then a
 *    legacy NULL-ordinal row, and never a row already complete; a failure that inserts a row only when its position has
 *    none; the stable-id upsert that hands a replay the id its first run minted; LIKE-prefix scoping; byte sums of the
 *    jsonb text; bytewise slug order; the staged page of each slug (the last one); the committed-write join to the
 *    job's idempotency key; the timeline-request join; a batch that banks atomically; and the cascade that a job's
 *    deletion takes the transcript with it.
 *  - Regression: an engine that lets a late failure overwrite a completed tool result, settles a sibling's row, rebanks
 *    a position it already holds, orders replay differently, counts the bytes of another key order, drops the last
 *    staged page, or keeps rows of a deleted job feeds a resumed subagent a wrong transcript: a tool re-run that should
 *    have been replayed, or pages the dream cycle attributes to the wrong run.
 *  - Why existing coverage misses it: these statements ran through `executeRaw` inside the subagent handler and the
 *    cycle code, which the parity cases cannot call (D18); test/minions-subagent-*.test.ts drive PGLite only.
 *  - Seam: none. Real engines, typed methods only. Row ids are left out of the compared views (a conflicting insert
 *    spends a Postgres sequence value, the Rust store does not) and checked only to ascend; job ids are compared
 *    relative to the case's first job and timestamps only as present.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { AdmitJobPolicy, AdmitJobSpec, JobInsertValues } from '../../src/core/engine-sql/jobs.ts';
import type { SubagentMessageInsert, SubagentMessageRow, SubagentToolInsert, SubagentToolRow } from '../../src/core/engine-sql/jobs-subagent.ts';
import { APPLICATION_AUTHORITY, coalesceDecision, parseSubmissionAuthority } from '../../src/core/minions/submission-authority.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

function values(name: string, extra: Partial<JobInsertValues> = {}): JobInsertValues {
  return {
    name, queue: 'default', status: 'waiting', priority: 0, data: {}, max_attempts: 3, backoff_type: 'exponential',
    backoff_delay: 1000, backoff_jitter: 0.2, delay_until: null, parent_job_id: null, on_child_fail: 'fail_parent',
    max_children: null, timeout_ms: null, lock_duration_ms: null, remove_on_complete: false, remove_on_fail: false,
    idempotency_key: null, quiet_hours: null, stagger_key: null, private_queue_owner_job_id: null,
    private_queue_owner_token: null, private_queue_lease_until: null, submission_authority: APPLICATION_AUTHORITY,
    spend_authorization: null, max_stalled: null, ...extra,
  };
}

const policy = (): AdmitJobPolicy => ({
  decide: async (_tx, row) => coalesceDecision(row, APPLICATION_AUTHORITY),
  parentAuthorityKind: raw => parseSubmissionAuthority(raw)?.kind ?? null,
});

/** A new job (the transcript's foreign key). */
async function add(engine: BrainEngine, name: string, extra: Partial<JobInsertValues> = {}): Promise<number> {
  const spec: Partial<AdmitJobSpec> & { insert: JobInsertValues } = { insert: values(name, extra) };
  const out = await engine.admitJob({ maxSpawnDepth: 5, ...spec }, policy());
  return Number(out.row.id);
}

async function threw(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return false;
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'engine_capability_missing') throw error;
    return true;
  }
}

const json = (value: unknown): string => JSON.stringify(value);
/** JSON text of a jsonb value that is a string (a double-encoded pre-fix row). */
const encoded = (value: unknown): string => JSON.stringify(JSON.stringify(value));

function msg(idx: number, role: 'user' | 'assistant', blocks: string, extra: Partial<SubagentMessageInsert> = {}): SubagentMessageInsert {
  return { message_idx: idx, role, content_blocks: blocks, tokens_in: null, tokens_out: null, tokens_cache_read: null, tokens_cache_create: null, model: null, ...extra };
}

function tool(idx: number, ordinal: number | null, toolUseId: string, name: string, input: string, status: 'pending' | 'complete' = 'pending'): SubagentToolInsert {
  return { message_idx: idx, ordinal, tool_use_id: toolUseId, tool_name: name, input, status };
}

/** Messages as the engines must agree on them: ids and times left out (checked to ascend / be present). */
function msgView(rows: SubagentMessageRow[], base: number) {
  return rows.map(r => ({
    job: r.job_id - base, idx: r.message_idx, role: r.role, blocks: json(r.content_blocks), tokens: [r.tokens_in, r.tokens_out, r.tokens_cache_read, r.tokens_cache_create],
    model: r.model, ended: r.ended_at instanceof Date,
  }));
}

function toolView(rows: SubagentToolRow[], base: number) {
  return rows.map(r => ({
    job: r.job_id - base, msg: r.message_idx, ordinal: r.ordinal, toolUseId: r.tool_use_id, name: r.tool_name, input: json(r.input), status: r.status,
    output: r.output === null ? null : json(r.output), error: r.error, schemaVersion: r.schema_version, provider: r.provider_id,
    stableId: r.gbrain_tool_use_id, started: r.started_at instanceof Date, ended: r.ended_at instanceof Date,
  }));
}

const ascending = (rows: Array<{ id: number }>) => rows.every((r, i) => i === 0 || rows[i - 1]!.id < r.id);

const STABLE = (n: number) => `a0000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

describe('engine parity: subagent transcript and tool ledger', () => {
  parityTest('messages are kept by index, the first writer of an index wins, and reads list them in index order or the newest only',
    { methods: ['admitJob', 'insertSubagentMessage', 'listSubagentMessages', 'countSubagentMessages'] }, async engine => {
      const a = await add(engine, 'sub-a');
      const b = await add(engine, 'sub-b');
      const empty = await add(engine, 'sub-empty');
      await engine.insertSubagentMessage(a, msg(2, 'assistant', json([{ type: 'text', text: 'third' }]), { tokens_in: 7, tokens_out: 9, tokens_cache_read: 0, tokens_cache_create: 3, model: 'm-1' }));
      await engine.insertSubagentMessage(a, msg(0, 'user', json([{ zeta: 1, alpha: { b: 2, a: [3, 'é\u{1f600}'] }, type: 'text', text: 'héllo' }])));
      await engine.insertSubagentMessage(a, msg(1, 'assistant', json([{ type: 'tool_use', id: 'toolu_01', name: 'brain_get_page', input: { slug: 'x' } }])));
      // A second write of index 2 (another role, other blocks) leaves the first as it was.
      await engine.insertSubagentMessage(a, msg(2, 'user', json([{ type: 'text', text: 'overwrite attempt' }]), { tokens_in: 1, model: 'm-2' }));
      // A double-encoded row (a pre-fix jsonb string) and an empty block list.
      await engine.insertSubagentMessage(b, msg(0, 'user', encoded([{ type: 'text', text: 'double' }])));
      await engine.insertSubagentMessage(b, msg(1, 'assistant', json([])));
      const all = await engine.listSubagentMessages(a);
      const last = await engine.listSubagentMessages(a, { last: true });
      const lastB = await engine.listSubagentMessages(b, { last: true });
      const counts = { a: await engine.countSubagentMessages(a), b: await engine.countSubagentMessages(b), empty: await engine.countSubagentMessages(empty) };
      expect(all.map(r => r.message_idx)).toEqual([0, 1, 2]);
      expect(all[2]?.role).toBe('assistant');
      expect(ascending(all)).toBe(false); // ids follow insertion order (2, 0, 1), not message_idx
      return {
        all: msgView(all, a), last: msgView(last, a), lastB: msgView(lastB, a), both: msgView(await engine.listSubagentMessages(b), a), counts,
        none: await engine.listSubagentMessages(empty), noneLast: await engine.listSubagentMessages(empty, { last: true }),
        idsFollowInsertion: all.map(r => r.message_idx).join() === '0,1,2' && [...all].sort((x, y) => x.id - y.id).map(r => r.message_idx).join() === '2,0,1',
      };
    });

  parityTest('a message needs a job, a user or assistant role and a block list',
    { methods: ['admitJob', 'insertSubagentMessage', 'countSubagentMessages'] }, async engine => {
      const a = await add(engine, 'sub-a');
      const refused = {
        noJob: await threw(() => engine.insertSubagentMessage(a + 100_000, msg(0, 'user', json([])))),
        badRole: await threw(() => engine.insertSubagentMessage(a, msg(0, 'system' as 'user', json([])))),
        badJson: await threw(() => engine.insertSubagentMessage(a, msg(0, 'user', '{not json'))),
      };
      expect(refused).toEqual({ noJob: true, badRole: true, badJson: true });
      return { refused, count: await engine.countSubagentMessages(a) };
    });

  parityTest('tool rows keep the same raw tool id per turn and ordinal, never rebank an occupied position, and list in replay or id order',
    { methods: ['admitJob', 'recordSubagentToolExecutions', 'listSubagentToolExecutions'] }, async engine => {
      const a = await add(engine, 'sub-a');
      const b = await add(engine, 'sub-b');
      // The same raw provider id on every turn and ordinal, banked out of order, plus legacy NULL-ordinal rows.
      await engine.recordSubagentToolExecutions(a, [
        tool(2, 1, 'toolu_01', 'brain_search', json({ q: 'two-one' })),
        tool(1, 0, 'toolu_01', 'brain_get_page', json({ slug: 'one-zero' })),
        tool(2, 0, 'toolu_01', 'brain_get_page', json({ slug: 'two-zero' })),
        tool(1, null, 'toolu_legacy', 'brain_get_page', json({ slug: 'legacy-a' })),
        tool(1, null, 'toolu_legacy', 'brain_get_page', json({ slug: 'legacy-b' })),
        tool(3, 5, 'toolu_01', 'brain_put_page', json({ slug: 'p', content: 'c' }), 'complete'),
      ]);
      // An occupied position stays as it is, whatever the second batch says; a free one is banked.
      await engine.recordSubagentToolExecutions(a, [
        tool(2, 0, 'toolu_other', 'brain_search', json({ slug: 'replaced?' })),
        tool(2, 2, 'toolu_01', 'brain_get_page', json({ slug: 'two-two' })),
      ]);
      await engine.recordSubagentToolExecutions(b, [tool(0, 0, 'toolu_01', 'brain_get_page', json({ slug: 'other-job' }))]);
      const replay = await engine.listSubagentToolExecutions(a, 'replay');
      const byId = await engine.listSubagentToolExecutions(a, 'id');
      expect(replay.map(r => `${r.message_idx}:${r.ordinal}`)).toEqual(['1:0', '1:null', '1:null', '2:0', '2:1', '2:2', '3:5']);
      expect(byId.map(r => `${r.message_idx}:${r.ordinal}`)).toEqual(['2:1', '1:0', '2:0', '1:null', '1:null', '3:5', '2:2']);
      expect(ascending(byId)).toBe(true);
      return {
        replay: toolView(replay, a), byId: toolView(byId, a), other: toolView(await engine.listSubagentToolExecutions(b, 'replay'), a),
        none: await engine.listSubagentToolExecutions(b + 100_000, 'id'),
      };
    });

  parityTest('the legacy guard skips a banked row only when a legacy row of the same turn and tool id exists',
    { methods: ['admitJob', 'recordSubagentToolExecutions', 'listSubagentToolExecutions'] }, async engine => {
      const a = await add(engine, 'sub-a');
      await engine.recordSubagentToolExecutions(a, [tool(1, null, 'toolu_01', 'brain_get_page', json({ legacy: true }))]);
      await engine.recordSubagentToolExecutions(a, [
        tool(1, 0, 'toolu_01', 'brain_get_page', json({ guarded: 'same turn and id' })), // skipped: the legacy row stands for it
        tool(1, 1, 'toolu_02', 'brain_get_page', json({ guarded: 'other id' })), // banked
        tool(2, 0, 'toolu_01', 'brain_get_page', json({ guarded: 'other turn' })), // banked
      ], { legacyGuard: true });
      // Without the guard the same row is banked beside the legacy one.
      await engine.recordSubagentToolExecutions(a, [tool(1, 0, 'toolu_01', 'brain_get_page', json({ unguarded: true }))]);
      const rows = toolView(await engine.listSubagentToolExecutions(a, 'replay'), a);
      expect(rows.map(r => JSON.parse(r.input))).toEqual([{ legacy: true }, { unguarded: true }, { guarded: 'other id' }, { guarded: 'other turn' }]);
      return rows;
    });

  parityTest('a batch of tool rows is banked atomically, and a row needs a job and a pending or complete status',
    { methods: ['admitJob', 'recordSubagentToolExecutions', 'listSubagentToolExecutions'] }, async engine => {
      const a = await add(engine, 'sub-a');
      const badStatus = await threw(() => engine.recordSubagentToolExecutions(a, [
        tool(1, 0, 'toolu_01', 'brain_get_page', json({ n: 0 })),
        { ...tool(1, 1, 'toolu_02', 'brain_get_page', json({ n: 1 })), status: 'bogus' as 'pending' },
      ]));
      const badJson = await threw(() => engine.recordSubagentToolExecutions(a, [
        tool(1, 0, 'toolu_01', 'brain_get_page', json({ n: 0 })), tool(1, 1, 'toolu_02', 'brain_get_page', '{not json'),
      ]));
      const noJob = await threw(() => engine.recordSubagentToolExecutions(a + 100_000, [tool(1, 0, 'toolu_01', 'brain_get_page', json({}))]));
      const afterRefusals = (await engine.listSubagentToolExecutions(a, 'id')).length;
      await engine.recordSubagentToolExecutions(a, []);
      expect({ badStatus, badJson, noJob, afterRefusals }).toEqual({ badStatus: true, badJson: true, noJob: true, afterRefusals: 0 });
      return { badStatus, badJson, noJob, afterRefusals, empty: (await engine.listSubagentToolExecutions(a, 'id')).length };
    });

  parityTest('startSubagentToolExecution mints a stable id once, and a replay gets the id of the row already there',
    { methods: ['admitJob', 'startSubagentToolExecution', 'recordSubagentToolExecutions', 'listSubagentToolExecutions'] }, async engine => {
      const a = await add(engine, 'sub-a');
      const first = await engine.startSubagentToolExecution(a, { message_idx: 1, ordinal: 0, tool_use_id: 'toolu_01', tool_name: 'brain_get_page', input: json({ slug: 'x' }), gbrain_tool_use_id: STABLE(1), provider_id: 'anthropic' });
      // The replay offers a new candidate for the same position: the first run's id comes back and the row stays.
      const replay = await engine.startSubagentToolExecution(a, { message_idx: 1, ordinal: 0, tool_use_id: 'toolu_01', tool_name: 'brain_search', input: json({ q: 'changed' }), gbrain_tool_use_id: STABLE(2), provider_id: 'openai' });
      // The same raw id at another ordinal and in another turn are rows of their own.
      const sibling = await engine.startSubagentToolExecution(a, { message_idx: 1, ordinal: 1, tool_use_id: 'toolu_01', tool_name: 'brain_get_page', input: json({ slug: 'y' }), gbrain_tool_use_id: STABLE(3), provider_id: 'anthropic' });
      const nextTurn = await engine.startSubagentToolExecution(a, { message_idx: 2, ordinal: 0, tool_use_id: 'toolu_01', tool_name: 'brain_get_page', input: json(null), gbrain_tool_use_id: STABLE(4), provider_id: 'anthropic' });
      // A row banked without a stable id owns its position: the start leaves it and has no id to hand back.
      await engine.recordSubagentToolExecutions(a, [tool(3, 0, 'toolu_01', 'brain_get_page', json({ slug: 'banked' }))]);
      const banked = await engine.startSubagentToolExecution(a, { message_idx: 3, ordinal: 0, tool_use_id: 'toolu_01', tool_name: 'brain_get_page', input: json({ slug: 'z' }), gbrain_tool_use_id: STABLE(5), provider_id: 'anthropic' });
      // An uppercase id is stored in its canonical lowercase form.
      const upper = await engine.startSubagentToolExecution(a, { message_idx: 4, ordinal: 0, tool_use_id: 'toolu_01', tool_name: 'brain_get_page', input: json({}), gbrain_tool_use_id: STABLE(6).toUpperCase(), provider_id: 'anthropic' });
      const refusedId = await threw(() => engine.startSubagentToolExecution(a, { message_idx: 5, ordinal: 0, tool_use_id: 'toolu_01', tool_name: 'brain_get_page', input: json({}), gbrain_tool_use_id: 'not-a-uuid', provider_id: 'anthropic' }));
      const noJob = await threw(() => engine.startSubagentToolExecution(a + 100_000, { message_idx: 1, ordinal: 0, tool_use_id: 'toolu_01', tool_name: 'brain_get_page', input: json({}), gbrain_tool_use_id: STABLE(7), provider_id: 'anthropic' }));
      expect({ first, replay, banked, upper }).toEqual({ first: STABLE(1), replay: STABLE(1), banked: null, upper: STABLE(6) });
      return { first, replay, sibling, nextTurn, banked, upper, refusedId, noJob, rows: toolView(await engine.listSubagentToolExecutions(a, 'replay'), a) };
    });

  parityTest('a settle by stable id touches every row with that id whatever its status; an unknown id touches none',
    { methods: ['admitJob', 'startSubagentToolExecution', 'completeSubagentToolExecution', 'failSubagentToolExecution', 'listSubagentToolExecutions'] }, async engine => {
      const a = await add(engine, 'sub-a');
      const start = (idx: number, ord: number, stable: string) => engine.startSubagentToolExecution(a, { message_idx: idx, ordinal: ord, tool_use_id: 'toolu_01', tool_name: 'brain_get_page', input: json({ idx, ord }), gbrain_tool_use_id: stable, provider_id: 'anthropic' });
      await start(1, 0, STABLE(1));
      await start(1, 1, STABLE(2));
      await start(2, 0, STABLE(2)); // two rows share one stable id
      await start(3, 0, STABLE(3));
      const complete = {
        one: await engine.completeSubagentToolExecution({ gbrainToolUseId: STABLE(1) }, json({ z: 1, a: [1, 2] })),
        shared: await engine.completeSubagentToolExecution({ gbrainToolUseId: STABLE(2) }, json('text')),
        unknown: await engine.completeSubagentToolExecution({ gbrainToolUseId: STABLE(9) }, json({})),
        upperCase: await engine.completeSubagentToolExecution({ gbrainToolUseId: STABLE(3).toUpperCase() }, json({})),
        notAUuid: await engine.completeSubagentToolExecution({ gbrainToolUseId: 'not-a-uuid' }, json({})),
      };
      // No status guard by id: a failure lands on a complete row, a completion on a failed one, and a null output is stored.
      const fail = {
        completed: await engine.failSubagentToolExecution({ gbrainToolUseId: STABLE(1) }, 'late failure'),
        unknown: await engine.failSubagentToolExecution({ gbrainToolUseId: STABLE(9) }, 'nobody'),
        pending: await engine.failSubagentToolExecution({ gbrainToolUseId: STABLE(3) }, 'tool threw'),
      };
      const again = await engine.completeSubagentToolExecution({ gbrainToolUseId: STABLE(3) }, json(null));
      expect({ ...complete, ...fail, again }).toMatchObject({ one: 1, shared: 2, unknown: 0, completed: 1, pending: 1, again: 1 });
      return { complete, fail, again, rows: toolView(await engine.listSubagentToolExecutions(a, 'replay'), a) };
    });

  parityTest('a settle by position takes its own ordinal first, then a legacy row, and never a row already complete',
    { methods: ['admitJob', 'recordSubagentToolExecutions', 'completeSubagentToolExecution', 'failSubagentToolExecution', 'listSubagentToolExecutions'] }, async engine => {
      const a = await add(engine, 'sub-a');
      const at = (idx: number, ordinal: number, toolUseId = 'toolu_01') => ({ jobId: a, messageIdx: idx, ordinal, toolUseId });
      await engine.recordSubagentToolExecutions(a, [
        tool(1, 0, 'toolu_01', 'brain_get_page', json({ n: '1:0' })), // own row, and a same-id sibling below
        tool(1, 1, 'toolu_01', 'brain_get_page', json({ n: '1:1' })),
        tool(2, null, 'toolu_01', 'brain_get_page', json({ n: '2:legacy' })), // legacy row only
        tool(3, 0, 'toolu_01', 'brain_get_page', json({ n: '3:own' })), // own row beside a legacy one
        tool(3, null, 'toolu_01', 'brain_get_page', json({ n: '3:legacy' })),
        tool(4, 0, 'toolu_01', 'brain_get_page', json({ n: '4:done' }), 'complete'), // already complete
        tool(4, null, 'toolu_01', 'brain_get_page', json({ n: '4:legacy' })),
      ]);
      const results = {
        own: await engine.completeSubagentToolExecution(at(1, 0), json({ out: 'own' })),
        // Ordinal 7 has no row: the legacy NULL row of turn 2 takes it.
        legacy: await engine.completeSubagentToolExecution(at(2, 7), json({ out: 'legacy' })),
        // Own row first even though the legacy row has the lower id.
        ownFirst: await engine.completeSubagentToolExecution(at(3, 0), json({ out: 'own-first' })),
        // Turn 4: the own row is complete and is never rewritten; the legacy row settles instead.
        skipsComplete: await engine.completeSubagentToolExecution(at(4, 0), json({ out: 'second' })),
        // Everything of turn 4 is settled now: nothing is left to touch.
        nothingLeft: await engine.completeSubagentToolExecution(at(4, 0), json({ out: 'third' })),
        wrongId: await engine.completeSubagentToolExecution(at(1, 1, 'toolu_other'), json({ out: 'x' })),
        wrongTurn: await engine.completeSubagentToolExecution(at(9, 0), json({ out: 'x' })),
        // A failed row can still be completed, and a complete row is never failed.
        failOwn: await engine.failSubagentToolExecution(at(1, 1), 'boom'),
        failAgain: await engine.failSubagentToolExecution(at(1, 1), 'boom again'),
        failComplete: await engine.failSubagentToolExecution(at(1, 0), 'late'),
        completeFailed: await engine.completeSubagentToolExecution(at(1, 1), json({ out: 'recovered' })),
      };
      expect(results).toEqual({ own: 1, legacy: 1, ownFirst: 1, skipsComplete: 1, nothingLeft: 0, wrongId: 0, wrongTurn: 0, failOwn: 1, failAgain: 1, failComplete: 0, completeFailed: 1 });
      return { results, rows: toolView(await engine.listSubagentToolExecutions(a, 'replay'), a) };
    });

  parityTest('a failure inserts a row only when its position has none, and never touches a complete row or another tool id',
    { methods: ['admitJob', 'recordSubagentToolExecutions', 'failSubagentToolExecution', 'listSubagentToolExecutions'] }, async engine => {
      const a = await add(engine, 'sub-a');
      const at = (idx: number, ordinal: number, toolUseId = 'toolu_01') => ({ jobId: a, messageIdx: idx, ordinal, toolUseId });
      const fallback = (name: string, input: unknown) => ({ tool_name: name, input: json(input) });
      await engine.recordSubagentToolExecutions(a, [
        tool(2, 0, 'toolu_01', 'brain_get_page', json({ n: 'complete' }), 'complete'),
        tool(3, 0, 'toolu_01', 'brain_get_page', json({ n: 'pending' })),
        tool(4, 0, 'toolu_01', 'brain_get_page', json({ n: 'other id pending' })),
        tool(5, null, 'toolu_01', 'brain_get_page', json({ n: 'legacy' })),
      ]);
      const results = {
        // No row at the position: one is inserted failed, with its input and an end time.
        inserted: await engine.failSubagentToolExecution(at(1, 0), 'rejected upfront', fallback('brain_put_page', { slug: 'x' })),
        // No row and no fallback: nothing happens.
        noFallback: await engine.failSubagentToolExecution(at(1, 1), 'nobody home'),
        // A complete row is neither updated nor replaced.
        complete: await engine.failSubagentToolExecution(at(2, 0), 'late failure', fallback('brain_get_page', { n: 'replacement' })),
        // A pending row is failed in place (the UPDATE leg); the fallback input is not used.
        pending: await engine.failSubagentToolExecution(at(3, 0), 'tool threw', fallback('brain_get_page', { n: 'unused' })),
        // The position holds another call's row (a different tool id): it is left alone.
        otherId: await engine.failSubagentToolExecution(at(4, 0, 'toolu_02'), 'not mine', fallback('brain_get_page', { n: 'unused' })),
        // A legacy row settles through the UPDATE leg for any ordinal.
        legacy: await engine.failSubagentToolExecution(at(5, 3), 'legacy failed', fallback('brain_get_page', { n: 'unused' })),
        // A failed row fails again with the new error.
        again: await engine.failSubagentToolExecution(at(1, 0), 'rejected twice', fallback('brain_put_page', { slug: 'x' })),
      };
      expect(results).toEqual({ inserted: 1, noFallback: 0, complete: 0, pending: 1, otherId: 0, legacy: 1, again: 1 });
      return { results, rows: toolView(await engine.listSubagentToolExecutions(a, 'replay'), a) };
    });

  parityTest('hasSubagentToolExecution, listSubagentWriteOutcomes and listSubagentOneshotLedger scope by status and by LIKE prefix, in id order',
    { methods: ['admitJob', 'recordSubagentToolExecutions', 'completeSubagentToolExecution', 'failSubagentToolExecution', 'hasSubagentToolExecution', 'listSubagentWriteOutcomes', 'listSubagentOneshotLedger'] }, async engine => {
      const a = await add(engine, 'sub-a');
      const b = await add(engine, 'sub-b');
      const empty = await add(engine, 'sub-empty');
      const at = (ordinal: number, toolUseId: string) => ({ jobId: a, messageIdx: 1, ordinal, toolUseId });
      await engine.recordSubagentToolExecutions(a, [
        tool(1, 0, 'oneshot-aaaa1111', 'brain_put_page', json({ slug: 'notes/a', content: 'body a', request_id: 'req-a', batch_id: 'batch-1' })),
        tool(1, 1, 'oneshot-bbbb2222', 'brain_put_page', json({ slug: 7, content: { nested: { z: 1, a: [true, null] } }, request_id: null, batch_id: 'batch-1' })),
        tool(1, 2, 'oneshot-cccc3333-skip', 'oneshot_skip', json({ skip_reason: 'nothing worth keeping' }), 'complete'),
        tool(1, 3, 'oneshot-dddd4444', 'brain_put_page', encoded({ slug: 'notes/double', content: 'double-encoded' })),
        tool(1, 4, 'toolu_01', 'brain_put_page', json({ slug: 'notes/plain', content: 'plain call' })),
        tool(1, 5, 'oneshotXeeee5555', 'brain_put_page', json({ slug: 'notes/near-miss' })),
        tool(1, 6, 'a_b-1', 'brain_get_page', json({ slug: 'underscore' })),
        tool(1, 7, 'axb-1', 'brain_get_page', json({ slug: 'letter' })),
        tool(1, 8, '100%-done', 'brain_get_page', json({ slug: 'percent' })),
        tool(1, 9, 'oneshot-ffff6666', 'brain_get_page', json({ slug: 'notes/read' })),
      ]);
      await engine.recordSubagentToolExecutions(b, [tool(1, 0, 'oneshot-bbbb0000', 'brain_put_page', json({ slug: 'notes/other-job' }))]);
      await engine.completeSubagentToolExecution(at(0, 'oneshot-aaaa1111'), json({ status: 'ok', slug: 'notes/a' }));
      await engine.failSubagentToolExecution(at(1, 'oneshot-bbbb2222'), 'embedding dimension mismatch');
      await engine.completeSubagentToolExecution(at(4, 'toolu_01'), json({ b: 1, a: 2 }));
      const has = async (jobId: number, opts?: { status?: string; toolUseIdPrefix?: string }) => engine.hasSubagentToolExecution(jobId, opts);
      const checks = {
        any: await has(a), none: await has(empty),
        complete: await has(a, { status: 'complete' }), failed: await has(a, { status: 'failed' }), pending: await has(a, { status: 'pending' }), other: await has(b, { status: 'complete' }),
        oneshot: await has(a, { toolUseIdPrefix: 'oneshot-' }), oneshotNone: await has(empty, { toolUseIdPrefix: 'oneshot-' }), missingPrefix: await has(a, { toolUseIdPrefix: 'nope-' }),
        oneshotComplete: await has(a, { status: 'complete', toolUseIdPrefix: 'oneshot-' }), oneshotFailed: await has(b, { status: 'failed', toolUseIdPrefix: 'oneshot-' }),
        wildcardUnderscore: await has(a, { toolUseIdPrefix: 'one_hot-' }), wildcardPercent: await has(a, { toolUseIdPrefix: 'one%' }),
        escapedUnderscore: await has(a, { toolUseIdPrefix: 'a\\_b' }), unescapedUnderscore: await has(b, { toolUseIdPrefix: 'a_b' }), emptyPrefix: await has(empty, { toolUseIdPrefix: '' }),
        literalPercent: await has(a, { toolUseIdPrefix: '100\\%' }),
      };
      expect(checks).toMatchObject({ any: true, none: false, oneshotNone: false, wildcardUnderscore: true, escapedUnderscore: true, unescapedUnderscore: false, literalPercent: true });
      const outcomes = (rows: Array<{ status: string; error: string | null; output: unknown }>) => rows.map(r => ({ status: r.status, error: r.error, output: r.output === null ? null : json(r.output) }));
      const ledger = (await engine.listSubagentOneshotLedger(a, 'oneshot-')).map(r => ({ ...r, ordinal: r.ordinal }));
      expect(ledger.map(r => r.tool_use_id)).toEqual(['oneshot-aaaa1111', 'oneshot-bbbb2222', 'oneshot-cccc3333-skip', 'oneshot-dddd4444', 'oneshot-ffff6666']);
      return {
        checks,
        outcomes: outcomes(await engine.listSubagentWriteOutcomes(a)),
        scoped: outcomes(await engine.listSubagentWriteOutcomes(a, 'oneshot-')),
        scopedNone: outcomes(await engine.listSubagentWriteOutcomes(a, 'zzz')),
        noJob: outcomes(await engine.listSubagentWriteOutcomes(empty)),
        ledger,
        wildcardLedger: (await engine.listSubagentOneshotLedger(a, 'one_hot')).map(r => r.tool_use_id),
        otherLedger: await engine.listSubagentOneshotLedger(b, 'oneshot-'),
        emptyLedger: await engine.listSubagentOneshotLedger(empty, 'oneshot-'),
      };
    });

  parityTest('summarizeSubagentToolExecutions counts rows and sums the bytes of their jsonb output text across jobs',
    { methods: ['admitJob', 'recordSubagentToolExecutions', 'completeSubagentToolExecution', 'failSubagentToolExecution', 'summarizeSubagentToolExecutions'] }, async engine => {
      const a = await add(engine, 'sub-a');
      const b = await add(engine, 'sub-b');
      const c = await add(engine, 'sub-c');
      const at = (jobId: number, idx: number, ordinal: number) => ({ jobId, messageIdx: idx, ordinal, toolUseId: 'toolu_01' });
      const read = (idx: number, ordinal: number) => tool(idx, ordinal, 'toolu_01', 'brain_get_page', json({}));
      await engine.recordSubagentToolExecutions(a, [read(1, 0), read(1, 1), read(2, 0), read(2, 1), read(2, 2), tool(3, 0, 'toolu_01', 'brain_search', json({}))]);
      await engine.recordSubagentToolExecutions(b, [read(1, 0), read(1, 1)]);
      await engine.recordSubagentToolExecutions(c, [read(1, 0)]);
      // Key order and spacing: jsonb text is `{"a": 1, "bb": 2}` however the output was sent.
      await engine.completeSubagentToolExecution(at(a, 1, 0), '{"bb":2,"a":1}');
      await engine.completeSubagentToolExecution(at(a, 1, 1), json({ text: 'héllo wörld \u{1f600}', nested: { list: [1, 2.5, 'x', null, true], empty: {} } }));
      await engine.completeSubagentToolExecution(at(a, 2, 0), 'null'); // jsonb null is the text `null`: 4 bytes
      await engine.completeSubagentToolExecution(at(a, 2, 1), json('a string'));
      await engine.failSubagentToolExecution(at(a, 2, 2), 'failed reads have no output');
      await engine.completeSubagentToolExecution(at(a, 3, 0), json({ not: 'a read' }));
      await engine.completeSubagentToolExecution(at(b, 1, 0), json({ other: 'job' }));
      const reads = { toolName: 'brain_get_page', status: 'complete' };
      const sums = {
        a: await engine.summarizeSubagentToolExecutions([a], reads),
        b: await engine.summarizeSubagentToolExecutions([b], reads),
        both: await engine.summarizeSubagentToolExecutions([a, b, c], reads),
        pendingOnly: await engine.summarizeSubagentToolExecutions([a, b, c], { toolName: 'brain_get_page', status: 'pending' }),
        failed: await engine.summarizeSubagentToolExecutions([a], { toolName: 'brain_get_page', status: 'failed' }),
        search: await engine.summarizeSubagentToolExecutions([a], { toolName: 'brain_search', status: 'complete' }),
        noRows: await engine.summarizeSubagentToolExecutions([c], reads),
        noJobs: await engine.summarizeSubagentToolExecutions([], reads),
        unknownJob: await engine.summarizeSubagentToolExecutions([a + 100_000], reads),
      };
      expect(sums.noRows).toEqual({ count: 0, output_bytes: 0 });
      expect(sums.a.count).toBe(4);
      return sums;
    });

  parityTest('the dream cycle reads list the slugs, writes and committed puts of completed brain_put_page calls',
    { methods: ['admitJob', 'recordSubagentToolExecutions', 'completeSubagentToolExecution', 'failSubagentToolExecution', 'listSubagentPutPageSlugs', 'listSubagentPutPageWrites', 'listSubagentRetainedPutPages'] }, async engine => {
      const a = await add(engine, 'sub-a', { idempotency_key: 'dream:synth-v2:key-a' });
      const b = await add(engine, 'sub-b');
      const c = await add(engine, 'sub-c');
      const at = (jobId: number, ordinal: number) => ({ jobId, messageIdx: 1, ordinal, toolUseId: 'toolu_01' });
      const put = (ordinal: number, input: string, name = 'brain_put_page') => tool(1, ordinal, 'toolu_01', name, input);
      await engine.recordSubagentToolExecutions(a, [
        put(0, json({ slug: 'notes/b', request_id: 'r-1', content: 'x' })),
        put(1, json({ slug: 'Notes/B' })), // bytewise order puts capitals first
        put(2, json({ slug: 'notes/a' })),
        put(3, json({ slug: 'notes/é' })),
        put(4, encoded({ slug: 'notes/double-encoded' })), // a pre-fix double-encoded input
        put(5, json({ slug: 123 })), // a non-string slug is read as its text
        put(6, json({ title: 'no slug at all' })),
        put(7, json({ slug: null })),
        put(8, json({ slug: 'notes/pending' })), // never settled
        put(9, json({ slug: 'notes/failed' })),
        put(10, json({ slug: 'notes/read' }), 'brain_get_page'),
        put(11, json({ slug: 'notes/b' })), // a duplicate slug in one job
        put(12, json({ slug: 'notes/staged', request_id: 'r-2' })),
      ]);
      await engine.recordSubagentToolExecutions(b, [put(0, json({ slug: 'notes/b' })), put(1, json({ slug: 'notes/c', request_id: 'r-3' }))]);
      await engine.recordSubagentToolExecutions(c, [put(0, json({ slug: 'notes/c-only' }))]);
      const outputs: Array<[number, number, unknown]> = [
        [a, 0, { state: 'committed', revision: 'rev-1', status: 'ok' }], [a, 1, { status: 'ok' }], [a, 2, { state: 'committed', revision: 'rev-2' }],
        [a, 3, { state: 'queued' }], [a, 4, { state: 'committed', revision: 'rev-4' }], [a, 5, null], [a, 6, 'committed'], [a, 7, { state: 'committed', revision: 'rev-7' }],
        [a, 10, { state: 'committed' }], [a, 11, { state: 'committed', revision: 'rev-11' }], [a, 12, { status: 'staged', state: 'committed', revision: 'rev-12' }],
        [b, 0, { state: 'committed', revision: 'rev-b0' }], [b, 1, { state: 'committed', revision: 'rev-b1' }], [c, 0, { status: 'ok' }],
      ];
      for (const [jobId, ordinal, out] of outputs) await engine.completeSubagentToolExecution(at(jobId, ordinal), json(out));
      await engine.failSubagentToolExecution(at(a, 9), 'dimension mismatch');
      const writes = (await engine.listSubagentPutPageWrites([a, b])).map(r => ({ job: r.job_id - a, slug: r.slug, started: r.started_at instanceof Date }));
      const retained = (await engine.listSubagentRetainedPutPages([a, b, c])).map(r => ({ job: r.job_id - a, key: r.job_key, input: json(r.input), output: json(r.output), started: r.started_at instanceof Date }));
      const slugs = {
        a: await engine.listSubagentPutPageSlugs([a]), ab: await engine.listSubagentPutPageSlugs([a, b]), c: await engine.listSubagentPutPageSlugs([c]),
        none: await engine.listSubagentPutPageSlugs([]), unknown: await engine.listSubagentPutPageSlugs([a + 100_000]),
      };
      expect(slugs.a.slice(0, 2)).toEqual(['123', 'Notes/B']);
      expect(slugs.a.at(-1)).toBeNull();
      expect(retained.map(r => r.job)).toEqual([0, 0, 0, 0, 0, 0, 1, 1]);
      return {
        slugs, writes, retained,
        noWrites: await engine.listSubagentPutPageWrites([]), noRetained: await engine.listSubagentRetainedPutPages([]),
        unknownWrites: await engine.listSubagentPutPageWrites([a + 100_000]),
      };
    });

  parityTest('a put_page input that is a string of invalid JSON refuses the slug reads, as the SQL cast does',
    { methods: ['admitJob', 'recordSubagentToolExecutions', 'completeSubagentToolExecution', 'listSubagentPutPageSlugs', 'listSubagentPutPageWrites'] }, async engine => {
      const good = await add(engine, 'sub-good');
      const bad = await add(engine, 'sub-bad');
      const pending = await add(engine, 'sub-pending');
      await engine.recordSubagentToolExecutions(good, [tool(1, 0, 'toolu_01', 'brain_put_page', json({ slug: 'notes/ok' }))]);
      await engine.recordSubagentToolExecutions(bad, [tool(1, 0, 'toolu_01', 'brain_put_page', json('this is not a json document'))]);
      // A row that is not complete is never read, so its input is never cast.
      await engine.recordSubagentToolExecutions(pending, [tool(1, 0, 'toolu_01', 'brain_put_page', json('this is not a json document'))]);
      for (const id of [good, bad]) await engine.completeSubagentToolExecution({ jobId: id, messageIdx: 1, ordinal: 0, toolUseId: 'toolu_01' }, json({ status: 'ok' }));
      const result = {
        good: await engine.listSubagentPutPageSlugs([good]),
        withPending: await engine.listSubagentPutPageSlugs([good, pending]),
        bad: await threw(() => engine.listSubagentPutPageSlugs([bad])),
        mixed: await threw(() => engine.listSubagentPutPageSlugs([good, bad])),
        writes: await threw(() => engine.listSubagentPutPageWrites([bad])),
      };
      expect(result).toEqual({ good: ['notes/ok'], withPending: ['notes/ok'], bad: true, mixed: true, writes: true });
      return result;
    });

  parityTest('listSubagentStagedPages returns the last staged page of each slug, slugs in byte order with a slugless call last',
    { methods: ['admitJob', 'recordSubagentToolExecutions', 'completeSubagentToolExecution', 'failSubagentToolExecution', 'listSubagentStagedPages'] }, async engine => {
      const a = await add(engine, 'sub-a');
      const b = await add(engine, 'sub-b');
      const at = (jobId: number, ordinal: number) => ({ jobId, messageIdx: 1, ordinal, toolUseId: 'toolu_01' });
      const put = (ordinal: number, input: unknown, name = 'brain_put_page') => tool(1, ordinal, 'toolu_01', name, json(input));
      await engine.recordSubagentToolExecutions(a, [
        put(0, { slug: 'notes/b', content: 'b input 1' }), put(1, { slug: 'notes/a', content: 'a input' }), put(2, { slug: 'notes/b', content: 'b input 2' }),
        put(3, { slug: 'Notes/Z', content: 'capital z input' }), put(4, { slug: 'notes/c', content: 'c input' }), put(5, { slug: 'notes/b', content: 'b input 3' }),
        put(6, { slug: 'notes/gone', content: 'failed' }), put(7, { slug: 'notes/read', content: 'read' }, 'brain_get_page'), put(8, { slug: 'notes/pending', content: 'pending' }),
        put(9, { content: 'no slug anywhere' }),
      ]);
      await engine.recordSubagentToolExecutions(b, [put(0, { slug: 'notes/b', content: 'other job' })]);
      const staged = (slug: string | null, content?: string) => json({ status: 'staged', ...(slug === null ? {} : { slug }), ...(content === undefined ? {} : { content }) });
      await engine.completeSubagentToolExecution(at(a, 0), staged('notes/b', 'b output 1'));
      await engine.completeSubagentToolExecution(at(a, 1), staged('notes/a')); // the content falls back to the input
      await engine.completeSubagentToolExecution(at(a, 2), staged('notes/b', 'b output 2'));
      await engine.completeSubagentToolExecution(at(a, 3), staged('Notes/Z', 'capital z output'));
      await engine.completeSubagentToolExecution(at(a, 4), json({ status: 'ok', slug: 'notes/c', content: 'written, not staged' }));
      await engine.completeSubagentToolExecution(at(a, 5), staged('notes/b')); // the last staged b: no output content, so its input's
      await engine.failSubagentToolExecution(at(a, 6), 'refused');
      await engine.completeSubagentToolExecution(at(a, 7), staged('notes/read', 'a read'));
      await engine.completeSubagentToolExecution(at(a, 9), staged(null, 'slugless output'));
      await engine.completeSubagentToolExecution(at(b, 0), staged('notes/b', 'b of the other job'));
      const result = { a: await engine.listSubagentStagedPages(a), b: await engine.listSubagentStagedPages(b), none: await engine.listSubagentStagedPages(b + 100_000) };
      expect(result.a).toEqual([
        { slug: 'Notes/Z', content: 'capital z output' }, { slug: 'notes/a', content: 'a input' }, { slug: 'notes/b', content: 'b input 3' }, { slug: null, content: 'slugless output' },
      ]);
      return result;
    });

  parityTest('listSubagentTimelineAppendCalls joins add_timeline_entry calls to committed, ok timeline requests of the source',
    { methods: ['admitJob', 'recordSubagentToolExecutions', 'listSubagentTimelineAppendCalls', 'readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'stampWriteClaim', 'completeWriteRow'] }, async (engine, backend) => {
      await createSource(engine, backend, 'other-src');
      const a = await add(engine, 'sub-a');
      const b = await add(engine, 'sub-b');
      const KEYS = ['principal:local_cli:parity-writer', 'brain'];
      const rid = (n: number) => `b0000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
      let seq = 0;
      /** One journal request, admitted, claimed and completed as `terminal` (or left queued). */
      const request = async (n: number, opts: { operation?: string; source?: string; slug: string; terminal?: { state: 'committed' | 'failed'; outcome: unknown } }) => {
        const source = await engine.readSourceMembership(opts.source ?? 'default');
        await engine.lockPersistenceCounters(KEYS);
        const row = await engine.insertWriteRequest({
          principalKind: 'local_cli', principalId: 'parity-writer', requestId: rid(n), operation: opts.operation ?? 'add_timeline_entry', sourceId: opts.source ?? 'default',
          sourceIncarnation: source!.incarnation, pageId: null, slug: opts.slug, worktreeId: null, topologyGeneration: null, digest: 'd'.repeat(64),
          intent: { kind: opts.operation ?? 'add_timeline_entry', slug: opts.slug }, authority: { scopes: ['write'] }, intentBytes: 100, terminalReservation: 4096,
          targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: KEYS, clientRequestId: null, state: 'queued', deferredRefreshId: null,
        });
        if (!opts.terminal) return;
        await engine.stampWriteClaim(row.id, `c0000000-0000-4000-8000-0000000000${String(++seq).padStart(2, '0')}`, 60_000, json({ phase: 'parity' }));
        await engine.completeWriteRow({
          id: row.id, state: opts.terminal.state, outcome: opts.terminal.outcome as Record<string, unknown>, errorCode: opts.terminal.state === 'failed' ? 'parity_error' : null,
          errorMessage: opts.terminal.state === 'failed' ? 'parity' : null, consumerVersion: 'parity', consumerHostId: null, errorDetail: null, resultBytes: 100, counterKeys: KEYS,
          intentBytes: 100, retainedBytes: 500, terminalReservation: 4096, probePurges: false,
        });
      };
      await request(1, { slug: 'notes/one', terminal: { state: 'committed', outcome: { status: 'ok' } } });
      await request(2, { slug: 'notes/two', terminal: { state: 'committed', outcome: { status: 'ok' } } });
      await request(3, { slug: 'notes/skipped', terminal: { state: 'committed', outcome: { status: 'skipped' } } });
      await request(4, { slug: 'notes/failed', terminal: { state: 'failed', outcome: null as unknown } });
      await request(5, { slug: 'notes/queued' });
      await request(6, { slug: 'notes/other-source', source: 'other-src', terminal: { state: 'committed', outcome: { status: 'ok' } } });
      await request(7, { slug: 'notes/put', operation: 'put_page', terminal: { state: 'committed', outcome: { status: 'ok' } } });
      await request(8, { slug: 'notes/double', terminal: { state: 'committed', outcome: { status: 'ok' } } });
      const call = (ordinal: number, input: string, name = 'brain_add_timeline_entry') => tool(1, ordinal, 'toolu_01', name, input);
      const entry = (n: number, slug: string, extra: Record<string, unknown> = {}) => json({ slug, date: '2026-01-02', summary: `entry ${n}`, request_id: rid(n), ...extra });
      await engine.recordSubagentToolExecutions(a, [
        call(0, entry(2, 'notes/two', { z: 1, detail: 'later request first' })), // id order, not request order
        call(1, entry(1, 'notes/one')),
        call(2, entry(3, 'notes/skipped')), call(3, entry(4, 'notes/failed')), call(4, entry(5, 'notes/queued')), call(5, entry(6, 'notes/other-source')),
        call(6, entry(7, 'notes/put')), call(7, encoded({ slug: 'notes/double', summary: 'double', request_id: rid(8) })),
        call(8, json({ slug: 'notes/none', summary: 'no request id' })), call(9, entry(1, 'notes/one', { summary: 'a replay of request one' })),
        call(10, entry(9, 'notes/unknown-request')), call(11, json({ slug: 'notes/one', request_id: rid(1).toUpperCase() })),
        call(12, entry(2, 'notes/two'), 'brain_put_page'),
      ]);
      await engine.recordSubagentToolExecutions(b, [call(0, entry(1, 'notes/one', { summary: 'another job' }))]);
      const view = (rows: Array<{ request_id: string; slug: string; input: unknown }>) => rows.map(r => ({ request: r.request_id.slice(-2), slug: r.slug, input: json(r.input) }));
      const result = {
        a: view(await engine.listSubagentTimelineAppendCalls([a], 'default')), ab: view(await engine.listSubagentTimelineAppendCalls([a, b], 'default')),
        other: view(await engine.listSubagentTimelineAppendCalls([a], 'other-src')), unknownSource: view(await engine.listSubagentTimelineAppendCalls([a], 'nope')),
        none: await engine.listSubagentTimelineAppendCalls([], 'default'),
      };
      expect(result.a.map(r => r.request)).toEqual(['02', '01', '08', '01']);
      return result;
    });

  parityTest('deleting a finished job takes its transcript and tool rows with it and leaves the other jobs alone',
    { methods: ['admitJob', 'cancelJobs', 'deleteTerminalJob', 'insertSubagentMessage', 'recordSubagentToolExecutions', 'startSubagentToolExecution', 'listSubagentMessages', 'listSubagentToolExecutions', 'countSubagentMessages', 'hasSubagentToolExecution'] }, async engine => {
      const done = await add(engine, 'sub-done');
      const live = await add(engine, 'sub-live');
      const kept = await add(engine, 'sub-kept');
      for (const id of [done, live, kept]) {
        await engine.insertSubagentMessage(id, msg(0, 'user', json([{ type: 'text', text: `job ${id - done}` }])));
        await engine.recordSubagentToolExecutions(id, [tool(1, 0, 'toolu_01', 'brain_get_page', json({ slug: 'x' }))]);
        await engine.startSubagentToolExecution(id, { message_idx: 1, ordinal: 1, tool_use_id: 'toolu_01', tool_name: 'brain_get_page', input: json({}), gbrain_tool_use_id: STABLE(10 + (id - done)), provider_id: 'anthropic' });
      }
      await engine.cancelJobs([done]);
      const deleted = { live: await engine.deleteTerminalJob(live), done: await engine.deleteTerminalJob(done) };
      const state = async (id: number) => ({
        messages: (await engine.listSubagentMessages(id)).length, count: await engine.countSubagentMessages(id),
        tools: (await engine.listSubagentToolExecutions(id, 'replay')).length, has: await engine.hasSubagentToolExecution(id),
      });
      // The stable ids of the deleted job are free again: nothing of it is left to claim them.
      const reuse = await engine.startSubagentToolExecution(kept, { message_idx: 1, ordinal: 2, tool_use_id: 'toolu_01', tool_name: 'brain_get_page', input: json({}), gbrain_tool_use_id: STABLE(10), provider_id: 'anthropic' });
      expect(deleted).toEqual({ live: false, done: true });
      return { deleted, done: await state(done), live: await state(live), kept: await state(kept), reuse };
    });
});
