/**
 * `gbrain repair extractor-facts` (#5731, CEO-A9, ENG-O8, DX-O4, DX-T1), on
 * PGLite and, with a safe DATABASE_URL, Postgres
 * (test/e2e/repair-extractor-facts-postgres.test.ts).
 *
 * Protects: facts the pre-fix canonical projection expired come back only
 * with receipt evidence (a committed write of the page completed in the same
 * transaction, by a consumer older than v0.60.11.0); compacted receipts still
 * count; separate-transaction, post-fix, fence-history and unmanaged rows are
 * ambiguous and need --include-ambiguous with that preview's hash;
 * superseded, withdrawn and duplicated rows are never restored; the apply
 * restores exactly the previewed set, rechecks each fact, and a resumed apply
 * restores no new candidate.
 * Seams: the pre-fix projection's expiry is reproduced by its SQL effect (a
 * real committed page write, then `expired_at` and the receipt's completion
 * set in one transaction); the crash replaces the handler's apply for one run.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { VERSION } from '../src/version.ts';
import { operations } from '../src/core/operations.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { extractorFactsRepair, EXTRACTOR_FACTS_INTENT } from '../src/core/repair/extractor-facts.ts';
import { extractorFactsCheck } from '../src/commands/doctor/checks/extractor-facts.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { compactWriteReceipts } from '../src/core/persistence/journal.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { runExtractConversationFactsCore } from '../src/commands/extract-conversation-facts.ts';
import { writeSingleFact } from '../src/core/facts/write-single.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const EXTRACTOR = 'cli:extract-conversation-facts:sess';
const ENTITY = 'people/alice-example';

interface RepairJson { results: Array<{ affected: number; residuals: Record<string, number>; apply_command: string; applied: number; skipped: number;
  warnings?: string[]; listing?: Array<{ item: string; class: string; detail?: string }>; outcomes?: Record<string, number>;
  outcome_items?: Array<{ item: string; outcome: string; reason?: string }> }> }

async function refusal(run: () => Promise<unknown>): Promise<OperationError> {
  try { await run(); } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected a refusal');
}

/** `home` only outside a managed brain, whose helper already set GBRAIN_HOME (the owner's host identity). */
async function repair(engine: BrainEngine, home: string | null, args: string[]): Promise<RepairJson> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
  const run = () => runRepairCommand(engine, ['extractor-facts', ...args, '--json']);
  try { await (home ? withEnv({ GBRAIN_HOME: home }, run) : run()); } finally { console.log = original; }
  return JSON.parse(lines.join('\n')) as RepairJson;
}
const hashOf = (json: RepairJson) => json.results[0].apply_command.match(/--expect ([0-9a-f]+)/)![1];

/** A conversation page with extractor facts at row numbers 1..n, as `extract-conversation-facts` leaves it. */
async function conversation(engine: BrainEngine, slug: string, facts: string[], root?: string, sourceId = 'default'): Promise<number[]> {
  const page = await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'Alice: I will send the deck on Friday.\nBob: Thanks.' }, { sourceId });
  if (root) {
    await engine.executeRaw('UPDATE pages SET source_path=$1 WHERE id=$2', [`${slug}.md`, page.id]);
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
    mkdirSync(dirname(join(root, `${slug}.md`)), { recursive: true });
    writeFileSync(join(root, `${slug}.md`), serializePageToMarkdown(snapshot.page, snapshot.tags));
  }
  const ids: number[] = [];
  for (const [i, fact] of facts.entries()) {
    const [row] = await engine.executeRaw<{ id: number }>(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, source_session,
      row_num, source_markdown_slug) VALUES ($1, $2, $3, 'commitment', 'private', $4, 'sess', $5, $6) RETURNING id`, [sourceId, ENTITY, fact, EXTRACTOR, i + 1, slug]);
    ids.push(Number(row.id));
  }
  return ids;
}

async function factState(engine: BrainEngine, ids: number[]) {
  return engine.executeRaw<{ id: number; active: boolean; row_num: number | null }>(
    'SELECT id::int AS id, expired_at IS NULL AS active, row_num FROM facts WHERE id=ANY($1::bigint[]) ORDER BY id', [ids]);
}
const activeIds = async (engine: BrainEngine, ids: number[]) => (await factState(engine, ids)).filter(row => row.active).map(row => row.id);

describe('extractor-facts is CLI-only (ENG-O13)', () => {
  test('no operation exposes it over MCP', () => {
    expect(operations.map(op => op.name).filter(name => /repair|extractor/.test(name))).toEqual([]);
  });
});

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-extractor-facts-'));
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  /** A real managed write of the page, then the pre-fix projection's effect on its extractor facts. */
  async function prefixExpire(engine: BrainEngine, ctx: OperationContext, slug: string,
    opts: { transaction?: 'same' | 'separate'; consumer?: string | null; ids?: number[] } = {}): Promise<string> {
    const receipt = await submitPageMutation(ctx, { operation: 'add_timeline_entry',
      params: { request_id: randomUUID(), slug, date: '2026-03-01', summary: `note ${randomUUID().slice(0, 8)}`, source: 'operator' } }) as { request_id: string };
    const [row] = await engine.executeRaw<{ id: string }>('SELECT id::text AS id FROM persistence_requests WHERE request_id=$1::uuid', [receipt.request_id]);
    const expire = (tx: BrainEngine) => tx.executeRaw(`UPDATE facts SET expired_at=now(), row_num=NULL WHERE source_id='default'
      AND source_markdown_slug=$1 AND source LIKE 'cli:extract-conversation-facts%' AND expired_at IS NULL ${opts.ids ? 'AND id=ANY($2::bigint[])' : ''}`,
    opts.ids ? [slug, opts.ids] : [slug]);
    const complete = async (tx: BrainEngine) => {
      await declarePersistenceProtocol(tx);
      await tx.executeRaw('UPDATE persistence_requests SET completed_at=now(), consumer_version=$2 WHERE id=$1::uuid', [row.id, opts.consumer === undefined ? null : opts.consumer]);
    };
    if ((opts.transaction ?? 'same') === 'same') {
      await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => { await complete(tx); await expire(tx); }));
    } else {
      await engine.transaction(tx => complete(tx));
      // PGLite's now() has millisecond resolution: a later transaction is at least one tick later.
      await new Promise(resolve => setTimeout(resolve, 5));
      await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => expire(tx)));
    }
    return row.id;
  }

  describe(`gbrain repair extractor-facts, managed (${backend})`, () => {
    test('the fix holds: a managed write to a conversation page leaves its extractor facts active', async () => {
      let ids: number[] = [];
      await managedBrain(async ({ engine, ctx }) => {
        await submitPageMutation(ctx, { operation: 'add_timeline_entry',
          params: { request_id: randomUUID(), slug: 'conversations/fixed', date: '2026-03-01', summary: 'after the fix', source: 'operator' } });
        expect(await activeIds(engine, ids)).toEqual(ids);
        expect((await repair(engine, null, [])).results[0].residuals).toEqual({ evidenced: 0, ambiguous: 0, excluded: 0 });
      }, { databaseUrl, setup: async ({ engine, root }) => { ids = await conversation(engine, 'conversations/fixed', ['Alice sends the deck'], root); } });
    }, 120_000);

    test('retained, compacted and ambiguous histories: preview, hash-bound apply, recall, then --include-ambiguous', async () => {
      const seeded: Record<string, number[]> = {};
      await managedBrain(async ({ engine, ctx }) => {
        const [retainedA, retainedB, superseded, withdrawn, duplicated] = seeded.retained;
        // An active copy of one claim and a withdrawal of another, then one pre-fix publication expires the page.
        await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
          await tx.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, row_num, source_markdown_slug)
            VALUES ('default', $1, 'Alice sends the deck on Friday', 'commitment', 'private', $2, 9, 'conversations/retained')`, [ENTITY, EXTRACTOR]);
          await tx.executeRaw("INSERT INTO fact_withdrawals (source_id, visibility, subject, fact_hash) VALUES ('default', 'private', '*', gbrain_fact_fingerprint('Alice withdrew this claim'))");
        }));
        await prefixExpire(engine, ctx, 'conversations/retained', { ids: [retainedA, retainedB, superseded, withdrawn, duplicated] });
        await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () =>
          tx.executeRaw('UPDATE facts SET superseded_by=$1 WHERE id=$2', [retainedA, superseded])));
        const compacted = await prefixExpire(engine, ctx, 'conversations/compacted');
        // Older than the 30-day receipt retention, so compaction drops its intent but keeps its completion.
        await engine.transaction(async tx => {
          await declarePersistenceProtocol(tx);
          await tx.executeRaw("UPDATE persistence_effects SET state='committed' WHERE request_id=$1::uuid", [compacted]);
          await tx.executeRaw("UPDATE persistence_requests SET completed_at=completed_at-interval '40 days' WHERE id=$1::uuid", [compacted]);
        });
        await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () =>
          tx.executeRaw("UPDATE facts SET expired_at=expired_at-interval '40 days' WHERE source_markdown_slug='conversations/compacted'")));
        expect(await compactWriteReceipts(engine, 30)).toBeGreaterThanOrEqual(1);
        expect((await engine.executeRaw<{ compacted: boolean }>('SELECT compacted FROM persistence_requests WHERE id=$1::uuid', [compacted]))[0].compacted).toBe(true);
        await prefixExpire(engine, ctx, 'conversations/separate', { transaction: 'separate' });
        await prefixExpire(engine, ctx, 'conversations/post-fix', { consumer: VERSION });
        await prefixExpire(engine, ctx, 'conversations/fenced');

        const preview = await repair(engine, null, []);
        const classes = Object.fromEntries(preview.results[0].listing!.map(entry => [Number(entry.item.split('#')[1]), entry.class]));
        expect(classes).toEqual({
          [retainedA]: 'evidenced', [retainedB]: 'evidenced', [superseded]: 'excluded:superseded', [withdrawn]: 'excluded:withdrawn',
          [duplicated]: 'excluded:active_duplicate', [seeded.compacted[0]]: 'evidenced',
          [seeded.separate[0]]: 'ambiguous', [seeded['post-fix'][0]]: 'ambiguous', [seeded.fenced[0]]: 'ambiguous',
        });
        const details = Object.fromEntries(preview.results[0].listing!.map(entry => [Number(entry.item.split('#')[1]), entry.detail]));
        expect(details[seeded.separate[0]]).toContain('no committed write of the page completed at the exact expiry instant');
        expect(details[seeded['post-fix'][0]]).toContain('fixed consumer');
        expect(details[seeded.fenced[0]]).toContain('fence facts');
        expect(details[retainedA]).toContain('unstamped');
        expect(preview.results[0].residuals).toEqual({ evidenced: 3, ambiguous: 3, excluded: 3 });
        expect(preview.results[0].affected).toBe(2);
        const hash = hashOf(preview);
        expect(preview.results[0].apply_command).toBe(`gbrain repair extractor-facts --apply --expect ${hash}`);
        const everything = Object.values(seeded).flat();
        const activeBefore = await activeIds(engine, everything);

        const unbound = await refusal(() => repair(engine, null, ['--apply']));
        expect(unbound.toJSON()).toMatchObject({ error: 'invalid_params', docs: 'docs/guides/repair.md#explicit-only-repair-kinds',
          suggestion: 'Preview first: gbrain repair extractor-facts — then run the apply command it prints: gbrain repair extractor-facts --apply --expect <preview-hash>' });
        const stale = await refusal(() => repair(engine, null, ['--apply', '--expect', 'f'.repeat(64)]));
        expect(stale.toJSON()).toMatchObject({ error: 'preview_changed', docs: 'docs/guides/repair.md#preview-changed',
          message: `The preview changed since ${'f'.repeat(64)}; re-run gbrain repair extractor-facts and use the new hash.` });
        expect(await activeIds(engine, everything)).toEqual(activeBefore);

        const applied = await repair(engine, null, ['--apply', '--expect', hash]);
        expect(applied.results[0]).toMatchObject({ applied: 2, skipped: 0, outcomes: { restored: 2 } });
        const restored = [retainedA, retainedB, seeded.compacted[0]];
        expect(await activeIds(engine, everything)).toEqual([...activeBefore, ...restored].sort((a, b) => a - b));
        // Per-history counts (CEO-A9 completion criteria): restored, ambiguous (left for --include-ambiguous), excluded, unresolved.
        const activeNow = new Set(await activeIds(engine, everything));
        const report = Object.fromEntries(Object.entries(seeded).map(([history, ids]) => {
          const mine = ids.filter(id => classes[id] !== undefined);
          const restoredHere = mine.filter(id => activeNow.has(id)).length;
          return [history, { restored: restoredHere, ambiguous: mine.filter(id => classes[id] === 'ambiguous').length,
            excluded: mine.filter(id => classes[id].startsWith('excluded')).length,
            unresolved: mine.filter(id => classes[id] === 'evidenced' && !activeNow.has(id)).length }];
        }));
        expect(report).toEqual({
          retained: { restored: 2, ambiguous: 0, excluded: 3, unresolved: 0 },
          compacted: { restored: 1, ambiguous: 0, excluded: 0, unresolved: 0 },
          separate: { restored: 0, ambiguous: 1, excluded: 0, unresolved: 0 },
          'post-fix': { restored: 0, ambiguous: 1, excluded: 0, unresolved: 0 },
          fenced: { restored: 0, ambiguous: 1, excluded: 0, unresolved: 0 },
        });
        const rows = await factState(engine, [retainedA, retainedB]);
        expect(rows.map(row => row.row_num)).toEqual([10, 11]);
        const requests = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM persistence_requests WHERE intent->>'kind'=$1 AND state='committed'", [EXTRACTOR_FACTS_INTENT]);
        expect(requests[0].n).toBe(2);
        const recall = operations.find(op => op.name === 'recall')!;
        const recalled = await recall.handler({ ...ctx, remote: false }, { entity: ENTITY }) as { facts: Array<{ fact_id: string }> };
        for (const id of restored) expect(recalled.facts.map(fact => Number(fact.fact_id))).toContain(id);
        expect(await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='repair-approval' AND fingerprint=$1", [`extractor-facts:${hash}`])).toEqual([]);

        const wide = await repair(engine, null, ['--include-ambiguous']);
        expect(wide.results[0].residuals).toEqual({ evidenced: 0, ambiguous: 3, excluded: 3 });
        const wideHash = hashOf(wide);
        expect(wide.results[0].apply_command).toBe(`gbrain repair extractor-facts --include-ambiguous --apply --expect ${wideHash}`);
        expect((await refusal(() => repair(engine, null, ['--apply', '--expect', wideHash]))).code).toBe('preview_changed');
        const wideApplied = await repair(engine, null, ['--include-ambiguous', '--apply', '--expect', wideHash]);
        expect(wideApplied.results[0].outcomes).toEqual({ restored: 3 });
        expect(await activeIds(engine, [superseded, withdrawn])).toEqual([]);
        const after = await repair(engine, null, []);
        expect(after.results[0].residuals).toEqual({ evidenced: 0, ambiguous: 0, excluded: 3 });
      }, { databaseUrl, setup: async ({ engine, root }) => {
        seeded.retained = await conversation(engine, 'conversations/retained', ['Alice sends the deck', 'Alice books the venue',
          'Alice hires a designer', 'Alice withdrew this claim', 'Alice sends the deck on Friday'], root);
        seeded.compacted = await conversation(engine, 'conversations/compacted', ['Alice reviews the budget'], root);
        seeded.separate = await conversation(engine, 'conversations/separate', ['Alice calls the bank'], root);
        seeded['post-fix'] = await conversation(engine, 'conversations/post-fix', ['Alice drafts the memo'], root);
        seeded.fenced = await conversation(engine, 'conversations/fenced', ['Alice signs the lease'], root);
        await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, row_num, source_markdown_slug, expired_at)
          VALUES ('default', 'conversations/fenced', 'A fence row on this page', 'fact', 'private', 'fence', 7, 'conversations/fenced', now())`);
      } });
    }, 180_000);

    test('a fact edited between preview and apply reports changed_since_preview and stays expired; the rest restore', async () => {
      let ids: number[] = [];
      await managedBrain(async ({ engine, ctx }) => {
        await prefixExpire(engine, ctx, 'conversations/edited');
        const preview = await repair(engine, null, []);
        expect(preview.results[0].residuals).toEqual({ evidenced: 2, ambiguous: 0, excluded: 0 });
        await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () =>
          tx.executeRaw("UPDATE facts SET fact='Alice sends the revised deck' WHERE id=$1", [ids[1]])));
        const applied = await repair(engine, null, ['--apply', '--expect', hashOf(preview)]);
        expect(applied.results[0]).toMatchObject({ applied: 1, outcomes: { partially_restored: 1 } });
        expect(applied.results[0].outcome_items![0].reason).toBe(`1 of 2 restored; changed since the preview: ${ids[1]}`);
        expect(await activeIds(engine, ids)).toEqual([ids[0]]);
      }, { databaseUrl, setup: async ({ engine, root }) => { ids = await conversation(engine, 'conversations/edited', ['Alice sends the deck', 'Alice books the venue'], root); } });
    }, 120_000);

    test('within a duplicate group the evidenced row is restored, not an older ambiguous one (Codex review)', async () => {
      let ids: number[] = [];
      await managedBrain(async ({ engine, ctx }) => {
        await prefixExpire(engine, ctx, 'conversations/dupes', { transaction: 'separate' });
        const [{ id: later }] = await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw<{ id: number }>(
          `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, row_num, source_markdown_slug)
           VALUES ('default', $1, 'Alice sends the deck', 'commitment', 'private', $2, 5, 'conversations/dupes') RETURNING id::int AS id`, [ENTITY, EXTRACTOR])));
        await prefixExpire(engine, ctx, 'conversations/dupes', { ids: [Number(later)] });
        const preview = await repair(engine, null, []);
        expect(preview.results[0].listing!.map(entry => [Number(entry.item.split('#')[1]), entry.class])).toEqual([
          [ids[0], 'excluded:duplicate_candidate'], [Number(later), 'evidenced']]);
        const applied = await repair(engine, null, ['--apply', '--expect', hashOf(preview)]);
        expect(applied.results[0].outcomes).toEqual({ restored: 1 });
        expect(await activeIds(engine, [ids[0], Number(later)])).toEqual([Number(later)]);
      }, { databaseUrl, setup: async ({ engine, root }) => { ids = await conversation(engine, 'conversations/dupes', ['Alice sends the deck'], root); } });
    }, 120_000);

    test('crash after a publication, before the cursor: the resumed apply replays its receipt and restores no new candidate (ENG-O8)', async () => {
      const seeded: Record<string, number[]> = {};
      await managedBrain(async ({ engine, ctx }) => {
        await prefixExpire(engine, ctx, 'conversations/a', { ids: [seeded.a[0]] });
        await prefixExpire(engine, ctx, 'conversations/b');
        const preview = await repair(engine, null, []);
        const hash = hashOf(preview);
        expect(preview.results[0].affected).toBe(2);
        const original = extractorFactsRepair.apply;
        extractorFactsRepair.apply = async (...args) => { await original(...args); throw new Error('simulated crash after publication'); };
        try { await expect(repair(engine, null, ['--apply', '--expect', hash])).rejects.toThrow('simulated crash after publication'); }
        finally { extractorFactsRepair.apply = original; }
        expect(await activeIds(engine, [...seeded.a, ...seeded.b])).toEqual(seeded.a);
        // A new defect-evidenced candidate appears on the half-applied page after the preview.
        await prefixExpire(engine, ctx, 'conversations/a', { ids: [seeded.a[1]] });
        const resumed = await repair(engine, null, ['--apply', '--expect', hash]);
        expect(resumed.results[0]).toMatchObject({ affected: 1, applied: 1, residuals: { already_restored_pages: 1 }, outcomes: { restored: 1 } });
        expect(await activeIds(engine, [...seeded.a, ...seeded.b])).toEqual([seeded.a[0], ...seeded.b]);
        const requests = await engine.executeRaw<{ slug: string; n: number }>(`SELECT slug, count(*)::int AS n FROM persistence_requests
          WHERE intent->>'kind'=$1 AND state='committed' GROUP BY slug ORDER BY slug`, [EXTRACTOR_FACTS_INTENT]);
        expect(requests).toEqual([{ slug: 'conversations/a', n: 1 }, { slug: 'conversations/b', n: 1 }]);
        expect((await refusal(() => repair(engine, null, ['--apply', '--expect', hash]))).code).toBe('preview_changed');
        expect((await repair(engine, null, [])).results[0].residuals).toEqual({ evidenced: 1, ambiguous: 0, excluded: 0 });
      }, { databaseUrl, setup: async ({ engine, root }) => {
        seeded.a = await conversation(engine, 'conversations/a', ['Alice sends the deck', 'Alice books the venue'], root);
        seeded.b = await conversation(engine, 'conversations/b', ['Bob reviews the budget'], root);
      } });
    }, 120_000);

    test('the preview warns, naming the host, when a consumer older than this release published after the cutoff', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        const request = await prefixExpire(engine, ctx, 'conversations/mixed');
        // The host upgraded after the pre-fix write: writer-version observation starts here.
        await new Promise(resolve => setTimeout(resolve, 5));
        await engine.executeRaw('UPDATE persistence_brain SET writer_version_cutoff=now() WHERE singleton=1');
        const quiet = await repair(engine, null, []);
        expect(quiet.results[0].warnings ?? []).toEqual([]);
        const host = randomUUID();
        await engine.transaction(async tx => {
          await declarePersistenceProtocol(tx);
          // A host still running v0.60.10.0 publishes after the upgrade cutoff.
          await tx.executeRaw(`UPDATE persistence_requests SET consumer_version='0.60.10.0', consumer_host_id=$2::uuid, published_at=now()
            WHERE id=$1::uuid`, [request, host]);
        });
        const warned = await repair(engine, null, []);
        expect(warned.results[0].warnings).toEqual([expect.stringContaining(`host ${host} still published writes with a consumer older than this release (0.60.10.0`)]);
      }, { databaseUrl, setup: async ({ engine, root }) => { await conversation(engine, 'conversations/mixed', ['Alice sends the deck'], root); } });
    }, 120_000);

    test('recovery journey: doctor, preview, apply, doctor, running the printed commands verbatim (DX-O15d)', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        await prefixExpire(engine, ctx, 'conversations/journey');
        const before = await extractorFactsCheck(engine);
        expect(before).toMatchObject({ name: 'extractor_facts_expired', status: 'warn', details: { evidenced: 3, ambiguous: 0 } });
        const printed = before.message.match(/gbrain repair extractor-facts(?= )/)![0];
        const preview = await repair(engine, null, printed.split(' ').slice(3));
        const applied = await repair(engine, null, preview.results[0].apply_command.split(' ').slice(3));
        expect(applied.results[0].outcomes).toEqual({ restored: 1 });
        expect(await extractorFactsCheck(engine)).toMatchObject({ status: 'ok', details: { evidenced: 0, ambiguous: 0 } });
      }, { databaseUrl, setup: async ({ engine, root }) => {
        await conversation(engine, 'conversations/journey', ['Alice sends the deck', 'Alice books the venue', 'Alice hires a designer'], root);
      } });
    }, 120_000);
  });

  describe(`cross-lane journey (ENG-O14): #5731 restore with managed writeSingleFact and a re-extraction (${backend})`, () => {
    const CHAT = `---\ntitle: Synthetic chat\ntype: conversation\n---\n${[
      '**Alice Example** (2024-03-15 9:00 AM): I will send the signed contract by Friday.',
      '**Bob Demo** (2024-03-15 9:01 AM): Great, thanks.',
    ].join('\n')}\n`;
    const CLAIM = 'Alice Example will send the signed contract by Friday.';
    const extractor = async () => [{ fact: CLAIM, kind: 'commitment' as const, entity_slug: ENTITY,
      confidence: 1, notability: 'high' as const, source: 'test', visibility: 'private' as const }];

    test('extract, pre-fix expiry, doctor, preview, apply, recall, remember, re-extract, doctor', async () => {
      await managedBrain(async ({ engine, ctx }) => {
        const slug = 'conversations/synthetic-chat';
        const extracted = await runExtractConversationFactsCore(engine, { sourceId: 'default', overrideDisabled: true, extractor, types: ['conversation'] });
        expect(extracted.facts_inserted).toBe(1);
        const rows = () => engine.executeRaw<{ id: number; fact: string; active: boolean; row_num: number | null }>(
          "SELECT id::int AS id, fact, expired_at IS NULL AS active, row_num FROM facts WHERE source_id='default' AND source_markdown_slug=$1 ORDER BY id", [slug]);
        const original = await rows();
        expect(original.map(row => [row.fact, row.active])).toEqual([[CLAIM, true], ['EXTRACTION_COMPLETE', true]]);
        await prefixExpire(engine, ctx, slug);
        expect((await rows()).every(row => !row.active && row.row_num === null)).toBe(true);

        expect((await extractorFactsCheck(engine)).details).toMatchObject({ evidenced: 2, ambiguous: 0 });
        const preview = await repair(engine, null, []);
        const applied = await repair(engine, null, preview.results[0].apply_command.split(' ').slice(3));
        expect(applied.results[0].outcomes).toEqual({ restored: 1 });
        const restored = await rows();
        expect(restored.map(row => [row.id, row.active])).toEqual(original.map(row => [row.id, true]));
        const recalled = await operations.find(op => op.name === 'recall')!.handler(ctx, { entity: ENTITY }) as { facts: Array<{ fact_id: string }> };
        expect(recalled.facts.map(fact => Number(fact.fact_id))).toContain(original[0].id);

        // writeSingleFact dedups against the restored fact for the same entity and keeps an absent entity's claim apart.
        const same = await writeSingleFact(engine, 'default', { fact: CLAIM, provenance: 'fixture', entity: ENTITY, kind: 'commitment' });
        expect(same).toMatchObject({ status: 'duplicate', id: original[0].id, entity_slug: ENTITY });
        const other = await writeSingleFact(engine, 'default', { fact: CLAIM, provenance: 'fixture', entity: 'Carol Absent', kind: 'commitment' });
        expect(other).toMatchObject({ status: 'inserted', entity_slug: 'carol-absent' });

        // A forced re-extraction replaces the restored batch, active, with nothing expired left behind on the page.
        const rerun = await runExtractConversationFactsCore(engine, { sourceId: 'default', overrideDisabled: true, extractor, types: ['conversation'], force: true });
        expect([rerun.facts_inserted, rerun.orphan_facts_cleaned]).toEqual([1, 2]);
        expect((await rows()).map(row => [row.fact, row.active])).toEqual([[CLAIM, true], ['EXTRACTION_COMPLETE', true]]);
        expect((await extractorFactsCheck(engine)).status).toBe('ok');
        expect((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM facts WHERE entity_slug='carol-absent' AND expired_at IS NULL"))[0].n).toBe(1);
      }, { databaseUrl, setup: async ({ engine, root }) => {
        await engine.setConfig('conversation_parser.llm_fallback_enabled', 'false');
        const person = await engine.putPage(ENTITY, { type: 'person', title: 'Alice Example', compiled_truth: '# Alice Example' }, { sourceId: 'default' });
        await engine.executeRaw('UPDATE pages SET source_path=$1 WHERE id=$2', [`${ENTITY}.md`, person.id]);
        const personSnapshot = (await engine.readPageSnapshot(ENTITY, { sourceId: 'default' }))!;
        mkdirSync(join(root, 'people'), { recursive: true });
        writeFileSync(join(root, `${ENTITY}.md`), serializePageToMarkdown(personSnapshot.page, personSnapshot.tags));
        const page = await engine.putPage('conversations/synthetic-chat', { type: 'conversation', title: 'Synthetic chat',
          compiled_truth: CHAT.split('---\n')[2].trim() }, { sourceId: 'default' });
        await engine.executeRaw('UPDATE pages SET source_path=$1 WHERE id=$2', ['conversations/synthetic-chat.md', page.id]);
        const snapshot = (await engine.readPageSnapshot('conversations/synthetic-chat', { sourceId: 'default' }))!;
        mkdirSync(join(root, 'conversations'), { recursive: true });
        writeFileSync(join(root, 'conversations/synthetic-chat.md'), serializePageToMarkdown(snapshot.page, snapshot.tags));
      } });
    }, 180_000);
  });

  describe(`gbrain repair extractor-facts, unmanaged (${backend})`, () => {
    let engine: BrainEngine;
    let close: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(databaseUrl!));
      else { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engine = pglite; }
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    }, 120_000);
    afterAll(async () => { if (close) await close(); else await engine.disconnect(); });

    test('every candidate is ambiguous; only --include-ambiguous with its own hash restores them', async () => {
      const sourceId = `ef-u-${randomUUID().slice(0, 8)}`;
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      const ids = await conversation(engine, 'conversations/unmanaged', ['Alice sends the deck', 'Alice books the venue'], undefined, sourceId);
      const superseded = (await conversation(engine, 'conversations/unmanaged-2', ['Alice hires a designer'], undefined, sourceId))[0];
      // The same claim about another entity on the same page is a distinct fact, not a duplicate (Codex review).
      const [{ id: bobs }] = await engine.executeRaw<{ id: number }>(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, row_num, source_markdown_slug)
        VALUES ($1, 'people/bob-example', 'Alice sends the deck', 'commitment', 'private', $2, 3, 'conversations/unmanaged') RETURNING id::int AS id`, [sourceId, EXTRACTOR]);
      ids.push(Number(bobs));
      await engine.executeRaw("UPDATE facts SET expired_at=now(), row_num=NULL WHERE source_id=$1", [sourceId]);
      await engine.executeRaw('UPDATE facts SET superseded_by=$1 WHERE id=$2', [ids[0], superseded]);
      const preview = await repair(engine, home, ['--source', sourceId]);
      expect(preview.results[0].residuals).toEqual({ evidenced: 0, ambiguous: 3, excluded: 1 });
      expect(preview.results[0].affected).toBe(0);
      expect(preview.results[0].listing!.map(entry => entry.detail)).toContain('unmanaged brain: no write receipt can prove the expiry');
      expect((await refusal(() => repair(engine, home, ['--source', sourceId, '--apply', '--expect', hashOf(preview)]))).code).toBe('preview_changed');
      const wide = await repair(engine, home, ['--source', sourceId, '--include-ambiguous']);
      expect(wide.results[0].affected).toBe(1);
      // The hash is bound to the preview's source scope: applying it brain-wide refuses (Codex review).
      expect((await refusal(() => repair(engine, home, ['--include-ambiguous', '--apply', '--expect', hashOf(wide)]))).code).toBe('preview_changed');
      const applied = await repair(engine, home, ['--source', sourceId, '--include-ambiguous', '--apply', '--expect', hashOf(wide)]);
      expect(applied.results[0].outcomes).toEqual({ restored: 1 });
      expect(await factState(engine, [...ids, superseded])).toEqual([
        { id: ids[0], active: true, row_num: 1 }, { id: ids[1], active: true, row_num: 2 }, { id: superseded, active: false, row_num: null },
        { id: ids[2], active: true, row_num: 3 }]);
      expect((await repair(engine, home, ['--source', sourceId])).results[0].residuals).toEqual({ evidenced: 0, ambiguous: 0, excluded: 1 });
    }, 60_000);

    test('a --limit run always advances: a partially restored page is not retried by the next run (Codex review)', async () => {
      const sourceId = `ef-l-${randomUUID().slice(0, 8)}`;
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      const first = await conversation(engine, 'conversations/limit-a', ['Alice sends the deck', 'Alice books the venue'], undefined, sourceId);
      const second = await conversation(engine, 'conversations/limit-b', ['Bob reviews the budget'], undefined, sourceId);
      await engine.executeRaw('UPDATE facts SET expired_at=now(), row_num=NULL WHERE source_id=$1', [sourceId]);
      const wide = await repair(engine, home, ['--source', sourceId, '--include-ambiguous']);
      await engine.executeRaw("UPDATE facts SET fact='Alice sends the revised deck' WHERE id=$1", [first[1]]);
      const apply = ['--source', sourceId, '--include-ambiguous', '--apply', '--expect', hashOf(wide), '--limit', '1'];
      expect((await repair(engine, home, apply)).results[0].outcomes).toEqual({ partially_restored: 1 });
      const next = await repair(engine, home, apply);
      expect(next.results[0]).toMatchObject({ affected: 1, outcomes: { restored: 1 } });
      expect(await activeIds(engine, [...first, ...second])).toEqual([first[0], second[0]]);
      expect((await refusal(() => repair(engine, home, apply))).code).toBe('preview_changed');
    }, 60_000);

    test('a page deleted and recreated at the same slug since the preview restores nothing (Codex review)', async () => {
      const sourceId = `ef-r-${randomUUID().slice(0, 8)}`;
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      const ids = await conversation(engine, 'conversations/recreated', ['Alice sends the deck'], undefined, sourceId);
      await engine.executeRaw('UPDATE facts SET expired_at=now(), row_num=NULL WHERE source_id=$1', [sourceId]);
      const wide = await repair(engine, home, ['--source', sourceId, '--include-ambiguous']);
      await engine.deletePage('conversations/recreated', { sourceId });
      await engine.putPage('conversations/recreated', { type: 'note', title: 'Another page', compiled_truth: 'Unrelated.' }, { sourceId });
      const applied = await repair(engine, home, ['--source', sourceId, '--include-ambiguous', '--apply', '--expect', hashOf(wide)]);
      expect(applied.results[0].outcomes).toEqual({ changed_since_preview: 1 });
      expect(await activeIds(engine, ids)).toEqual([]);
    }, 60_000);
  });
}
