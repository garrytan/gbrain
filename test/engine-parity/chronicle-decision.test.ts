/**
 * Engine parity for the write-time chronicle decision (chronicle/ledger.ts recordChronicleDecision): a chronicle-shaped
 * put commits on every engine, records the same ledger row, and answers the same `chronicle_backstop` receipt.
 *
 * Fail-first: on rust-engine/chronicle-decision-rust's base ac7d551949 cases 1, 2 and 4 fail on the Rust arm (the
 * decision ran raw SQL, which the Rust engine refuses, so the save ended failed with engine_capability_missing), and
 * case 5 fails on every arm (the decision members did not exist).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: (1) a new chronicle-shaped page commits, its ledger row reads back pending/auto with the page's slug,
 *    content hash and extractor version, and the receipt is `{ pending: 'next_cycle', daily_remaining: 200 }`;
 *    (2) a re-put of the same content commits and answers no receipt, and the ledger keeps one row (on Rust the re-put
 *    stops on the typed createVersion `preimage` refusal, bench-save-repro case 2's lane); (3) on a managed (git-rooted)
 *    source, add_link on a page with a pending automatic decision carries the decision to the revision it publishes,
 *    and a page whose decision was skipped gets no new row (Rust keeps no managed worktree: typed refusal); (4) the
 *    same receipt over MCP put_page (dispatchToolCall), stdio on every engine and http on the SQL engines; (5) the
 *    members themselves: the upsert's conflict path and backfill guard, the pending-automatic read, the activation
 *    insert keeping the first value, the truth-lead read and the 24 h reservation count; (6) a segmented meeting (over
 *    1 MiB, pages.segmented_storage on) records a pending row because the decision reads its stored truth lead (a
 *    truth-lead read that answers null records too_short; on Rust the segmented save stops on its raw-SQL body staging);
 *    (7) an upsert that wins keeps the event, cost-attempt and judge columns and clears the campaign stamp, and a guarded
 *    one leaves the row as it was (SQL arms; the Rust store test pins the same on its records); (8) an upsert for a
 *    missing source or page refuses with the SQL foreign-key error (code 23503, the same message on every engine; the
 *    source's key when both are missing) and writes nothing, and a soft-deleted page records.
 *  - Regression: the decision's activation insert, truth-lead read, add_link pending read, upsert, row read and daily
 *    count were `executeRaw` calls; the Rust engine refuses raw SQL, so every chronicle-shaped save failed on Rust.
 *  - Why existing coverage misses it: test/chronicle-*.test.ts run on PGLite and Postgres only; bench-save-repro case 3
 *    accepted the typed refusal on Rust.
 *  - Seam: none. Real engines and the put_page/add_link operation handlers.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { withEnv } from '../helpers/with-env.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { activatePersistence } from '../../src/core/persistence/activation.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ChronicleLedgerRow } from '../../src/core/chronicle/contract.ts';
import { CHRONICLE_EXTRACTOR_VERSION } from '../../src/core/chronicle/contract.ts';
import { operations } from '../../src/core/operations.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';

const { parityTest } = parityArms(testBackends());

const ctxFor = (engine: BrainEngine, sourceId: string) => ({ engine, sourceId, remote: false as const, writeWaitMs: 8000,
  config: { engine: engine.kind, embedding_disabled: true }, dryRun: false, logger: { info() {}, warn() {}, error() {}, debug() {} } });
/** One operation call; a refusal is answered as its code so the compared value says what went wrong. */
const run = async (engine: BrainEngine, name: string, params: Record<string, unknown>, sourceId = 'default') => {
  try {
    const r = await operations.find(o => o.name === name)!.handler(ctxFor(engine, sourceId) as never, params) as Record<string, unknown>;
    return { ok: true, state: r.state ?? null, status: r.status ?? null, chronicle_backstop: r.chronicle_backstop };
  } catch (error) {
    const out = { ok: false, code: (error as { code?: string }).code ?? String(error), detail: (error as { detail?: string }).detail ?? null };
    thrown.set(out, error);
    return out;
  }
};
/** The error each refused `run` caught, kept off the compared value. */
const thrown = new WeakMap<object, unknown>();
/**
 * A re-put of an existing page versions it with the `preimage` option, which the Rust createVersion member does not
 * serve yet (bench-save-repro case 2, another lane). Until it does, the Rust arm ends on that typed refusal.
 */
const preimageOnRust = (backend: string, out: { ok: boolean; code?: unknown; detail?: unknown }) => backend === 'rust' && out.ok === false
  && out.code === 'engine_capability_missing' && String(out.detail).startsWith('member=createVersion (option preimage)');
const put = async (engine: BrainEngine, slug: string, content: string, sourceId = 'default') => {
  const current = await engine.readPageSnapshot(slug, { sourceId });
  return run(engine, 'put_page', { slug, content, ...(current ? { expected_revision: current.revision } : {}) }, sourceId);
};
const today = new Date().toISOString().slice(0, 10);
const BODY = 'Alice and Bob reviewed the launch plan and agreed on the next steps for the beta. '.repeat(3);
const meeting = `---\ntype: meeting\ntitle: Sync\ndate: ${today}\n---\n\n${BODY}`;
const conversation = '---\ntitle: Conv\ntype: conversation\n---\n' + 'User: hello there, this is a long line of conversation text.\n'.repeat(90);
const PENDING = { pending: 'next_cycle', daily_remaining: 200 };

/** The ledger row of the page's current content, with its timestamps reduced to their type. */
async function ledgerRow(engine: BrainEngine, slug: string, sourceId = 'default') {
  const page = await engine.getPage(slug, { sourceId });
  if (!page) return null;
  const row = await engine.readChronicleRow({ sourceId, pageId: Number(page.id), contentHash: String(page.content_hash),
    extractorVersion: CHRONICLE_EXTRACTOR_VERSION });
  return row && shape(row, String(page.content_hash));
}
const shape = (row: ChronicleLedgerRow, contentHash: string) => ({
  state: row.state, reason: row.reason, trigger: row.trigger, no_extract: row.no_extract, slug: row.slug,
  hashIsThePages: row.content_hash === contentHash, extractor_version: row.extractor_version, principal_kind: row.principal_kind,
  decided_at: row.decided_at instanceof Date, updated_at: row.updated_at instanceof Date,
  next_attempt_at: row.next_attempt_at instanceof Date,
});
const PENDING_ROW = (slug: string) => ({ state: 'pending' as const, reason: null as string | null, trigger: 'auto' as const, no_extract: false, slug, hashIsThePages: true,
  extractor_version: CHRONICLE_EXTRACTOR_VERSION, principal_kind: 'local_cli', decided_at: true, updated_at: true, next_attempt_at: true });

describe('the write-time chronicle decision', () => {
  parityTest('a new conversation part commits, records a pending row and answers the pending receipt', { methods: ['readChronicleRow'] }, async (engine) => {
    try {
      const slug = 'conversations/conv-example/part-1';
      const part = await put(engine, slug, conversation);
      const out = { part, row: await ledgerRow(engine, slug) };
      expect(out).toEqual({ part: { ok: true, state: 'committed', status: 'created_or_updated', chronicle_backstop: PENDING }, row: PENDING_ROW(slug) });
      return out;
    } finally { await disposePersistenceConsumer(engine); }
  });

  parityTest('a re-put of the same content commits, answers no receipt and keeps the one row', { methods: ['readChronicleRow'] }, async (engine, backend) => {
    try {
      const first = await put(engine, 'meetings/sync-example', meeting);
      const firstRow = await ledgerRow(engine, 'meetings/sync-example');
      const again = await put(engine, 'meetings/sync-example', meeting);
      if (preimageOnRust(backend, again)) {
        expect({ first, firstRow }).toEqual({ first: { ok: true, state: 'committed', status: 'created_or_updated', chronicle_backstop: PENDING },
          firstRow: PENDING_ROW('meetings/sync-example') });
        throw thrown.get(again);
      }
      const out = { first, again, row: await ledgerRow(engine, 'meetings/sync-example') };
      expect(out).toEqual({ first: { ok: true, state: 'committed', status: 'created_or_updated', chronicle_backstop: PENDING },
        again: { ok: true, state: 'committed', status: 'skipped', chronicle_backstop: undefined }, row: PENDING_ROW('meetings/sync-example') });
      return out;
    } finally { await disposePersistenceConsumer(engine); }
  });

  parityTest('add_link carries a pending automatic decision to the revision it publishes, and leaves a skipped one as it was', { methods: ['readChronicleRow', 'getPage'], requires: 'managed_persistence', timeout: 60_000 }, async (engine, backend) => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-chronicle-decision-parity-')));
    try {
      return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        // add_link rewrites the from page's links fence only on a managed (git-rooted) source.
        const root = join(home, 'vault');
        mkdirSync(root, { recursive: true });
        writeFileSync(join(root, '.gitkeep'), '');
        execFileSync('git', ['-C', root, 'init', '-q']);
        execFileSync('git', ['-C', root, 'add', '.']);
        execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'init']);
        await createSource(engine, backend, 'vault', {}, root);
        try {
          // A claimed worktree on an activated managed brain (test/helpers/managed-brain.ts, without shared skills).
          await claimWorktree(engine, 'vault', root);
          await activatePersistence(engine, { confirmQuiesced: true });
          const person = await put(engine, 'people/alice-example', '---\ntype: person\ntitle: Alice Example\n---\nSynthetic test person.\n', 'vault');
          // The Rust engine keeps no managed worktree: its first write to one ends on the typed managed_persistence refusal.
          if (!person.ok && thrown.has(person)) throw thrown.get(person);
          const created = await put(engine, 'meetings/link-example', meeting, 'vault');
          // auto_chronicle false records a skipped decision: no pending row, so add_link must not decide that page again.
          await engine.setConfig('auto_chronicle', 'false');
          const skippedPut = await put(engine, 'meetings/skipped-example', meeting.replace('Sync', 'Skipped'), 'vault');
          await engine.unsetConfig('auto_chronicle');
          const hashOf = async (slug: string) => (await engine.getPage(slug, { sourceId: 'vault' }))?.content_hash ?? null;
          const before = { pending: await hashOf('meetings/link-example'), skipped: await hashOf('meetings/skipped-example') };
          const link = await run(engine, 'add_link', { from: 'meetings/link-example', to: 'people/alice-example', context: 'Synthetic participant' }, 'vault');
          const other = await run(engine, 'add_link', { from: 'meetings/skipped-example', to: 'people/alice-example', context: 'Synthetic participant' }, 'vault');
          // With the hold lifted on this test engine (GBRAIN_TEST_RUST_MANAGED=1, rust-managed.ts), a step of the managed
          // add_link the Rust store does not serve yet ends the case as stopped, never as equal.
          for (const step of [link, other]) if (!step.ok && (step as { code?: string }).code === 'engine_capability_missing' && thrown.has(step)) throw thrown.get(step);
          const after = { pending: await hashOf('meetings/link-example'), skipped: await hashOf('meetings/skipped-example') };
          const out = { person: person.ok, created: created.ok, skippedPut: skippedPut.ok, link: { ok: link.ok, code: (link as { code?: string }).code ?? null }, other: { ok: other.ok, code: (other as { code?: string }).code ?? null },
            newRevisions: { pending: before.pending !== null && after.pending !== before.pending, skipped: before.skipped !== null && after.skipped !== before.skipped },
            carried: await ledgerRow(engine, 'meetings/link-example', 'vault'), notCarried: await ledgerRow(engine, 'meetings/skipped-example', 'vault') };
          expect(out).toEqual({ person: true, created: true, skippedPut: true, link: { ok: true, code: null }, other: { ok: true, code: null },
            newRevisions: { pending: true, skipped: true }, carried: PENDING_ROW('meetings/link-example'), notCarried: null });
          return out;
        } finally { await disposePersistenceConsumer(engine); }
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  parityTest('over MCP, put_page of a chronicle-shaped page answers the pending receipt, on stdio and http', { methods: ['readChronicleRow'] }, async (engine, backend) => {
    // http needs a remote credential. The Rust store keeps no legacy tokens or OAuth write grants (rust/docs/store/journal.md),
    // so a remote write on Rust is refused permission_denied at admission: http runs on the SQL arms.
    const transports = backend === 'rust' ? ['stdio'] as const : ['stdio', 'http'] as const;
    const minted = backend === 'rust' ? null : await mintLegacyToken(engine, { name: `parity-${randomUUID()}`, scopes: ['read', 'write'], sourceGrant: ['default'], takesHolders: ['world'] });
    const call = async (slug: string, transport: 'stdio' | 'http') => {
      const opts = transport === 'stdio' ? { remote: false, sourceId: 'default' } : { remote: true, transport: 'http', sourceId: 'default', admissionOrigin: 'interactive', takesHoldersAllowList: ['world'],
        auth: { token: '', clientId: minted!.id, principal: { kind: 'legacy_token', id: minted!.id }, sourceId: 'default', allowedSources: ['default'], scopes: ['read', 'write'] } };
      const result = await dispatchToolCall(engine, 'put_page', { slug, content: meeting, request_id: randomUUID() }, opts as never);
      const body = JSON.parse(result.content[0]?.text ?? 'null') as Record<string, unknown> | null;
      return { isError: result.isError === true, error: body?.error ?? null, state: body?.state ?? null, chronicle_backstop: body?.chronicle_backstop ?? null };
    };
    try {
      const out: Record<string, unknown> = {};
      for (const transport of transports) {
        const slug = `meetings/mcp-${transport}-example`;
        out[transport] = { put: await call(slug, transport), stored: (await ledgerRow(engine, slug))?.state ?? null };
        expect({ transport, ...out[transport] as object } as Record<string, unknown>).toEqual({ transport,
          put: { isError: false, error: null, state: 'committed', chronicle_backstop: PENDING }, stored: 'pending' });
      }
      return out.stdio;
    } finally { await disposePersistenceConsumer(engine); }
  });
  parityTest('the decision members: the upsert conflict path, the pending read, the activation insert, the truth lead and the daily count', { methods: ['readChronicleRow', 'upsertChronicleRow', 'hasPendingAutoChronicleRow', 'insertConfigIfAbsent', 'getConfig', 'readPageTruthLead', 'countRecentChronicleReservations', 'getPage'] }, async (engine) => {
    try {
      const slug = 'meetings/members-example';
      const created = await put(engine, slug, meeting);
      const page = (await engine.getPage(slug, { sourceId: 'default' }))!;
      const key = { sourceId: 'default', pageId: Number(page.id), contentHash: String(page.content_hash), extractorVersion: CHRONICLE_EXTRACTOR_VERSION };
      const write = (state: string, trigger: string, reason: string | null) => engine.upsertChronicleRow({ ...key, slug, state, reason, trigger,
        principalKind: 'local_cli', principalId: null, requestId: null, noExtract: false, nextAttemptAt: state === 'pending' ? new Date().toISOString() : null });
      const pendingAfterPut = await engine.hasPendingAutoChronicleRow('default', key.pageId, CHRONICLE_EXTRACTOR_VERSION);
      // The conflict path: an automatic decision over the automatic pending row replaces it.
      const toSkipped = await write('skipped', 'auto', 'auto_chronicle_disabled');
      const skippedRow = await ledgerRow(engine, slug);
      const pendingAfterSkip = await engine.hasPendingAutoChronicleRow('default', key.pageId, CHRONICLE_EXTRACTOR_VERSION);
      // A backfill pending row is not overwritten by an automatic decision (the upsert's WHERE guard).
      const toBackfill = await write('pending', 'backfill', null);
      const autoOverBackfill = await write('skipped', 'auto', 'auto_chronicle_disabled');
      const backfillRow = await ledgerRow(engine, slug);
      const pendingIsAutoOnly = await engine.hasPendingAutoChronicleRow('default', key.pageId, CHRONICLE_EXTRACTOR_VERSION);
      const unknownKey = await engine.readChronicleRow({ ...key, contentHash: 'no-such-hash' });
      await engine.insertConfigIfAbsent('chronicle.parity_example', 'first');
      await engine.insertConfigIfAbsent('chronicle.parity_example', 'second');
      const out = {
        created: created.ok, pendingAfterPut, toSkipped, skipped: skippedRow && { state: skippedRow.state, reason: skippedRow.reason, trigger: skippedRow.trigger },
        pendingAfterSkip, toBackfill, autoOverBackfill, backfill: backfillRow && { state: backfillRow.state, trigger: backfillRow.trigger }, pendingIsAutoOnly,
        unknownKey, config: await engine.getConfig('chronicle.parity_example'), truthLead: await engine.readPageTruthLead(key.pageId),
        missingPageTruthLead: await engine.readPageTruthLead(2_000_000_000), dailyCount: await engine.countRecentChronicleReservations(),
      };
      expect(out).toEqual({ created: true, pendingAfterPut: true, toSkipped: true, skipped: { state: 'skipped', reason: 'auto_chronicle_disabled', trigger: 'auto' },
        pendingAfterSkip: false, toBackfill: true, autoOverBackfill: false, backfill: { state: 'pending', trigger: 'backfill' }, pendingIsAutoOnly: false,
        unknownKey: null, config: 'first', truthLead: null, missingPageTruthLead: null, dailyCount: 0 });
      return out;
    } finally { await disposePersistenceConsumer(engine); }
  });
  parityTest('a segmented meeting: the decision reads its stored truth lead, so it records a pending row, not too_short', { methods: ['readPageTruthLead', 'readChronicleRow', 'readPageSnapshot', 'setConfig'], requires: 'raw_sql' }, async (engine, backend) => {
    // Over 1 MiB with pages.segmented_storage on, the page row keeps no compiled_truth: the decision reads truth_lead.
    // The Rust engine stores it segmented too (`body_storage: 'segmented'`), but its page snapshot carries no
    // `bodyGeneration` yet (a known gap of the Rust segmented page read, not of the chronicle decision): the Rust arm
    // pins that gap below, so this case fails the day the snapshot carries the generation and the pin must go.
    const slug = 'meetings/segmented-example';
    const big = `---\ntype: meeting\ntitle: Long sync\ndate: ${today}\n---\n\n` + BODY.repeat(Math.ceil((1024 ** 2 + 4096) / BODY.length));
    await engine.setConfig('pages.segmented_storage', 'on');
    try {
      const part = await put(engine, slug, big);
      if (!part.ok && thrown.has(part)) throw thrown.get(part);
      // getPage refuses a segmented page (page_body_segmented); the snapshot carries its id, content hash and body generation.
      const snap = await engine.readPageSnapshot(slug, { sourceId: 'default' });
      const lead = snap ? await engine.readPageTruthLead(Number(snap.page.id)) : null;
      const row = snap && await engine.readChronicleRow({ sourceId: 'default', pageId: Number(snap.page.id), contentHash: String(snap.page.content_hash),
        extractorVersion: CHRONICLE_EXTRACTOR_VERSION });
      const storage = snap ? Object.getOwnPropertyDescriptor(snap.page, 'body_storage')?.value : null;
      if (backend === 'rust') expect(snap?.bodyGeneration, 'the Rust page snapshot now carries bodyGeneration: drop this pin').toBeUndefined();
      else expect(typeof snap?.bodyGeneration).toBe('number');
      const out = { part, row: row && shape(row, String(snap!.page.content_hash)), segmented: storage === 'segmented',
        lead: lead === null ? null : { startsWithBody: lead.startsWith(BODY.slice(0, 60)), longerThanMinimum: lead.length >= 200 } };
      expect(out).toEqual({ part: { ok: true, state: 'committed', status: 'created_or_updated', chronicle_backstop: PENDING }, row: PENDING_ROW(slug),
        segmented: true, lead: { startsWithBody: true, longerThanMinimum: true } });
      return out;
    } finally {
      await engine.setConfig('pages.segmented_storage', 'off');
      await disposePersistenceConsumer(engine);
    }
  });

  parityTest('an upsert that wins keeps the events and judge columns and clears the campaign stamp; a guarded one changes nothing', {
    methods: ['putPage', 'upsertChronicleRow', 'readChronicleRow'], requires: 'raw_sql',
  }, async (engine) => {
    // The Rust arm's named stop (RUST_ENGINE.md row 68): the columns no served Rust writer sets are seeded through SQL, so
    // the Rust arm stops on raw_sql here; the Rust store test chronicle_state::an_upsert_that_wins_* pins the same rule on
    // the store's records.
    const page = await engine.putPage('meetings/stamped-example', { type: 'meeting', title: 'Stamped', compiled_truth: 'A body.', timeline: '' });
    const key = (contentHash: string) => ({ sourceId: 'default', pageId: Number(page.id), contentHash, extractorVersion: CHRONICLE_EXTRACTOR_VERSION });
    const seed = (hash: string, age: string) => engine.executeRaw(`INSERT INTO chronicle_page_state (source_id, page_id, content_hash,
        extractor_version, slug, state, trigger, attempts, cost_usd, event_slugs, event_hashes, cost_attempts, judge_input_hash,
        judge_window_chars, judge_window_hash, judge_input_failures, campaign_id, attempt_cap_usd, max_attempts, pricing_policy,
        campaign_max_usd, decided_at, updated_at)
      VALUES ('default', $1, $2, $3, 'meetings/stamped-example', 'extracted', 'backfill', 1, 0.25,
        ARRAY['life/events/2026-11-20-abcd1234']::text[], ARRAY['e1']::text[], ARRAY[1]::int[], 'jih', 4000, 'jwh', 2, 'campaign-a',
        0.5, 3, 'priced', 5, now() - $4::interval, now() - $4::interval)`, [Number(page.id), hash, CHRONICLE_EXTRACTOR_VERSION, age]);
    const decide = (hash: string, trigger: string) => engine.upsertChronicleRow({ ...key(hash), slug: 'meetings/stamped-example', state: 'pending',
      reason: null, trigger, principalKind: 'local_cli', principalId: null, requestId: null, noExtract: false, nextAttemptAt: null });
    const kept = (row: ChronicleLedgerRow | null) => row && {
      state: row.state, event_slugs: row.event_slugs, event_hashes: row.event_hashes,
      cost_attempts: (row as unknown as { cost_attempts: unknown }).cost_attempts,
      judge: [row.judge_input_hash, row.judge_window_chars, row.judge_window_hash, row.judge_input_failures],
      campaign: [row.campaign_id, row.attempt_cap_usd, row.max_attempts, row.pricing_policy, row.campaign_max_usd].map(v => v === null ? null : 'set'),
    };
    await seed('h-guarded', '2 hours');
    const before = await engine.readChronicleRow(key('h-guarded'));
    const guarded = await decide('h-guarded', 'auto');
    const after = await engine.readChronicleRow(key('h-guarded'));
    await seed('h-old', '2 hours');
    await seed('h-new', '1 hour');
    const won = await decide('h-old', 'backfill');
    const out = { guarded, unchanged: JSON.stringify(after) === JSON.stringify(before), won, row: kept(await engine.readChronicleRow(key('h-old'))) };
    expect(out).toEqual({ guarded: false, unchanged: true, won: true, row: { state: 'pending', event_slugs: ['life/events/2026-11-20-abcd1234'],
      event_hashes: ['e1'], cost_attempts: [1], judge: ['jih', 4000, 'jwh', 2], campaign: [null, null, null, null, null] } });
    return out;
  });

  parityTest('an upsert for a missing source or page refuses and writes nothing; a soft-deleted page still records', {
    methods: ['putPage', 'softDeletePage', 'upsertChronicleRow', 'readChronicleRow'],
  }, async (engine) => {
    const page = await engine.putPage('meetings/fk-example', { type: 'meeting', title: 'Fk', compiled_truth: 'A body.', timeline: '' });
    const row = (sourceId: string, pageId: number) => ({ sourceId, pageId, contentHash: 'h-fk', extractorVersion: CHRONICLE_EXTRACTOR_VERSION,
      slug: 'meetings/fk-example', state: 'pending', reason: null, trigger: 'auto', principalKind: 'local_cli', principalId: null, requestId: null,
      noExtract: false, nextAttemptAt: null });
    // Every engine refuses as the SQL foreign keys do: code 23503 and the violation's message (it reaches agent output).
    const attempt = async (sourceId: string, pageId: number) => {
      try { return { written: await engine.upsertChronicleRow(row(sourceId, pageId)) }; } catch (error) {
        return { code: (error as { code?: string }).code ?? null, message: (error as Error).message };
      }
    };
    const violation = (column: 'source_id' | 'page_id') => ({ code: '23503',
      message: `insert or update on table "chronicle_page_state" violates foreign key constraint "chronicle_page_state_${column}_fkey"` });
    const read = (sourceId: string, pageId: number) => engine.readChronicleRow({ sourceId, pageId, contentHash: 'h-fk', extractorVersion: CHRONICLE_EXTRACTOR_VERSION });
    const missingPage = await attempt('default', Number(page.id) + 1_000_000);
    const missingPageRow = await read('default', Number(page.id) + 1_000_000);
    const missingSource = await attempt('no-such-source', Number(page.id));
    const missingSourceRow = await read('no-such-source', Number(page.id));
    // Both missing: PGLite and Postgres both report the source's key.
    const bothMissing = await attempt('no-such-source', Number(page.id) + 1_000_000);
    await engine.softDeletePage('meetings/fk-example');
    const softDeleted = await attempt('default', Number(page.id));
    const out = { missingPage, missingPageRow, missingSource, missingSourceRow, bothMissing, softDeleted,
      stored: (await read('default', Number(page.id)))?.state ?? null };
    expect(out).toEqual({ missingPage: violation('page_id'), missingPageRow: null, missingSource: violation('source_id'), missingSourceRow: null,
      bothMissing: violation('source_id'), softDeleted: { written: true }, stored: 'pending' });
    return out;
  });
});
