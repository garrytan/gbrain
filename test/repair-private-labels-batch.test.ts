/**
 * gbrain repair private-labels, applied a window at a time (GBRA-443).
 *
 * 1. Protects: a managed window is admitted as one maintenance batch and published in groups; a page whose write is
 *    declined (its file drifted before admission, or a refusal inside its publication group) fails alone and every other
 *    page of the group lands; every page's intent line is in the ledger before any page of the group is published, so
 *    each cleared label has its undo line even when the process dies after the group published; a ledger written before
 *    the write-ahead ledger (v0.60.641.0, no phase) still restores; the preview claims no re-embeds except for pages stored
 *    under per-chunk synopsis; pages an earlier apply tried and that did not change are listed after the rest; a
 *    preview-bound apply whose only failures are declines exits 0 with a declined summary; an apply result names its
 *    ledger and how many lines it appended; a preview-bound apply waits out a source refresh past the 10 s an
 *    interactive write gets, up to its own 10-minute ceiling, and past it is refused whole and resumes; a page an earlier
 *    apply tried that declines again does not count toward the systemic-failure stop, while fresh pages still do.
 * 2. Fails when: a decline fails or blocks another page, the batch path is not taken, the ledger is written after a page
 *    of its run, restore misses a page, the cost claims re-embeds, the order puts retried pages first, the exit is 1 for
 *    declines only (or 0 for anything else), the ledger fields are missing or wrong, or a refresh refuses the apply early.
 * 3. Real seams: PGLite and Postgres, repo-less and managed (a claimed worktree with Git), the gbrain repair command entry.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError, type OperationContext } from '../src/core/ops/contract.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { runRepairCommand, repairExitVerdict } from '../src/commands/repair.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { resolveRepairScope, type RepairResult } from '../src/core/repair/core.ts';
import { privateLabelsLedger } from '../src/commands/repair-private-labels.ts';
import type { PrivateLabelsLedgerLine } from '../src/core/repair/private-labels.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { persistenceHome } from '../src/core/persistence/identity.ts';
import { tryAcquireNativeLock } from '../src/core/persistence/native-lock.ts';
import { _setRepairRefreshWaitForTests, _setRefreshFenceWaitForTests } from '../src/core/persistence/admission-retry.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const NL = String.fromCharCode(10);
const logger = { info() {}, warn() {}, error() {} };

async function capture(fn: () => Promise<void>): Promise<string> {
  let printed = '';
  const original = console.log;
  console.log = (...parts: unknown[]) => { printed += parts.map(String).join(' ') + NL; };
  try { await fn(); } finally { console.log = original; }
  return printed;
}

/** One gbrain repair run through the command entry: its JSON result and the exit code it set. */
async function cli(engine: BrainEngine, argv: string[], env: Record<string, string> = {}): Promise<{ result: any; exit: number }> {
  _resetCliExitVerdictForTests();
  try {
    const printed = await withEnv({ GBRAIN_INTERACTIVE: '0', CI: '1', ...env }, () => capture(() => runRepairCommand(engine, [...argv, '--json'])));
    return { result: JSON.parse(printed).results[0], exit: currentExitCode() };
  } finally { _resetCliExitVerdictForTests(); process.exitCode = 0; }
}

const lines = (path: string): PrivateLabelsLedgerLine[] => existsSync(path) ? readFileSync(path, 'utf8').trim().split(NL).filter(Boolean).map(line => JSON.parse(line)) : [];
const labelled = (slug: string, extra: Record<string, unknown> = {}) => serializeMarkdown({ access: 'private', topic: 'kept', ...extra }, slug + ' body text.' + NL + NL + 'Second paragraph of ' + slug + '.', '',
  { type: 'note' as never, title: slug, tags: ['t1'] });
const put = (ctx: OperationContext, slug: string, content: string) => submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(), content } });
const frontmatter = async (engine: BrainEngine, slug: string) => (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.page.frontmatter as Record<string, unknown>;
const lastSequence = async (engine: BrainEngine) => String((await engine.executeRaw<{ s: string | null }>('SELECT max(sequence)::text AS s FROM persistence_requests'))[0]?.s ?? '0');
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), NL); durableGitRepo(root, ['.gitignore']); };

afterAll(() => { installFaultHook(undefined); _setRefreshFenceWaitForTests(null); _setRepairRefreshWaitForTests(null); });

describe('gbrain repair exit verdict (GBRA-443)', () => {
  const base = { stopped: undefined, complete: true, failed: [] as RepairResult['failed'] };
  const failed = (reason: string) => ({ item: 'default:notes/a', source_id: 'default', slug: 'notes/a', reason, message: 'x', retry: 'next_full_scan' as const });
  test('a preview-bound apply that is complete with only declines exits 0; anything else keeps exit 1', () => {
    expect(repairExitVerdict([{ ...base, failed: [failed('source_changed'), failed('page_body_segmented')] }], { previewBound: true })).toBe(0);
    expect(repairExitVerdict([{ ...base, failed: [failed('source_changed')] }])).toBe(1);
    expect(repairExitVerdict([{ ...base, failed: [failed('source_changed'), failed('internal')] }], { previewBound: true })).toBe(1);
    expect(repairExitVerdict([{ ...base, failed: [failed('source_changed')], complete: false }], { previewBound: true })).toBe(1);
    expect(repairExitVerdict([{ ...base, failed: [failed('source_changed')], stopped: { reason: 'capacity', message: 'x' } }], { previewBound: true })).toBe(1);
    expect(repairExitVerdict([base], { previewBound: true })).toBe(0);
  });
});

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  describe('[' + backend + '] repair private-labels on a repo-less brain (GBRA-443)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const home = mkdtempSync(join(tmpdir(), 'gbrain-private-labels-batch-'));
    const env = { GBRAIN_HOME: home };
    beforeAll(async () => {
      if (databaseUrl) ({ engine, close } = await isolatedPersistencePostgres(databaseUrl));
      else { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engine = pglite; close = () => pglite.disconnect(); }
    }, 120_000);
    afterAll(async () => { await disposePersistenceConsumer(engine); await close(); rmSync(home, { recursive: true, force: true }); });
    const seed = async (source: string, slug: string, extra: Record<string, unknown> = {}) => {
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [source]);
      const result = await importFromContent(engine, slug, labelled(slug, extra), { noEmbed: true, forceRechunk: true, sourceId: source });
      expect(result.status).toBe('imported');
    };
    const pageId = async (source: string, slug: string) => Number((await engine.readPageSnapshot(slug, { sourceId: source }))!.page.id);

    test('the preview claims no re-embeds for a label-only edit, except for a page stored under per-chunk synopsis or with a chunk that has no vector yet', async () => {
      await seed('source-e', 'notes/e0');
      await seed('source-e', 'notes/e1');
      const vector = '[' + Array(1536).fill(0.01).join(',') + ']';
      await engine.executeRaw("UPDATE content_chunks SET embedding=$1::text::vector WHERE page_id IN (SELECT id FROM pages WHERE source_id='source-e')", [vector]);
      const plain = (await cli(engine, ['private-labels', '--source', 'source-e'], env)).result;
      expect(plain.listing.length).toBe(2);
      expect(plain.cost.embedding_pages).toBe(0);
      await engine.executeRaw("UPDATE pages SET contextual_retrieval_mode='per_chunk_synopsis' WHERE source_id='source-e' AND slug='notes/e1'");
      const synopsis = (await cli(engine, ['private-labels', '--source', 'source-e'], env)).result;
      expect(synopsis.cost.embedding_pages).toBe(1);
      await engine.executeRaw("UPDATE content_chunks SET embedding=NULL WHERE page_id=(SELECT id FROM pages WHERE source_id='source-e' AND slug='notes/e0')");
      const unembedded = (await cli(engine, ['private-labels', '--source', 'source-e'], env)).result;
      expect(unembedded.cost.embedding_pages).toBe(2);
    });

    test('pages an earlier apply tried and that did not change are listed after every page not tried yet; the apply names its ledger and the lines it appended', async () => {
      const source = 'source-o';
      const slugs = [0, 1, 2, 3].map(i => 'notes/o' + i);
      for (const slug of slugs) await seed(source, slug);
      const { brain_id: brain } = await resolveRepairScope(engine, source);
      const path = await withEnv(env, async () => privateLabelsLedger(brain).path);
      mkdirSync(dirname(path), { recursive: true });
      // What an apply leaves for a page that declined: its intent line and nothing after it.
      for (const slug of slugs.slice(0, 2)) {
        const id = await pageId(source, slug);
        appendFileSync(path, JSON.stringify({ at: new Date().toISOString(), brain_id: brain, source_id: source, slug, page_id: id, revision_before: 'r', request_id: randomUUID(),
          removed: { access: 'private' }, phase: 'intent' }) + NL);
      }
      const preview = (await cli(engine, ['private-labels', '--source', source], env)).result;
      expect(preview.listing.map((entry: { item: string }) => entry.item)).toEqual([2, 3, 0, 1].map(i => source + ':' + slugs[i]));
      expect(preview.details.window.tried_before).toBe(2);
      expect(preview.warnings.some((w: string) => w.includes('2 listed page(s) were tried by an earlier apply'))).toBe(true);
      const before = lines(path).length;
      const { result: applied, exit } = await cli(engine, ['private-labels', '--source', source, '--apply', '--expect', preview.preview_hash], env);
      expect(exit).toBe(0);
      expect(applied.applied).toBe(4);
      expect(applied.declined).toBeUndefined();
      expect(applied.details.ledger).toBe(path);
      expect(applied.details.ledger_rows).toEqual({ intent: 4, committed: 4 });
      expect(applied.details.ledger_rows_written).toBe(8);
      expect(lines(path).length - before).toBe(applied.details.ledger_rows_written);
      for (const slug of slugs) expect('access' in ((await engine.readPageSnapshot(slug, { sourceId: source }))!.page.frontmatter as object)).toBe(false);
    });

    test('a ledger written by v0.60.641.0 (one line per landed write, no phase) still restores', async () => {
      const source = 'source-v';
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [source]);
      for (const slug of ['notes/v0', 'notes/v1']) {
        await importFromContent(engine, slug, serializeMarkdown({ topic: 'kept' }, slug + ' body.', '', { type: 'note' as never, title: slug, tags: [] }), { noEmbed: true, sourceId: source });
      }
      const { brain_id: brain } = await resolveRepairScope(engine, source);
      const path = await withEnv(env, async () => privateLabelsLedger(brain).path);
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify({ at: '2026-11-09T00:00:00.000Z', brain_id: brain, source_id: source, slug: 'notes/v0', page_id: await pageId(source, 'notes/v0'),
        revision_before: '1', request_id: randomUUID(), removed: { access: 'private' } }) + NL);
      appendFileSync(path, JSON.stringify({ at: '2026-11-09T00:00:01.000Z', brain_id: brain, source_id: source, slug: 'notes/v1', page_id: await pageId(source, 'notes/v1'),
        revision_before: '1', request_id: randomUUID(), removed: { access: 'private', visibility: 'private' } }) + NL);
      const preview = (await cli(engine, ['private-labels', '--source', source, '--class', 'restore'], env)).result;
      expect(preview.listing).toEqual([
        { item: source + ':notes/v0', class: 'restore', detail: 're-add access: private' },
        { item: source + ':notes/v1', class: 'restore', detail: 're-add access: private, visibility: private' },
      ]);
      const { result: restored, exit } = await cli(engine, ['private-labels', '--source', source, '--class', 'restore', '--apply', '--expect', preview.preview_hash], env);
      expect(exit).toBe(0);
      expect(restored.applied).toBe(2);
      expect((await engine.readPageSnapshot('notes/v0', { sourceId: source }))!.page.frontmatter).toEqual({ topic: 'kept', access: 'private' });
      expect((await engine.readPageSnapshot('notes/v1', { sourceId: source }))!.page.frontmatter).toEqual({ topic: 'kept', access: 'private', visibility: 'private' });
    });
  });

  describe('[' + backend + '] repair private-labels on a managed brain (GBRA-443)', () => {
    test('a window publishes as one maintenance batch; a page whose file drifted and a page refused inside its group decline alone; the run exits 0 and the next preview lists them last', () => managedBrain(async ({ engine, ctx, root }) => {
      const slugs = [0, 1, 2, 3, 4, 5].map(i => 'notes/label-' + i);
      for (const slug of slugs) await put(ctx, slug, labelled(slug));
      await settleManagedGitEffects(engine);
      const preview = (await cli(engine, ['private-labels', '--limit', '4'])).result;
      expect(preview.listing.map((entry: { item: string }) => entry.item)).toEqual(slugs.slice(0, 4).map(slug => 'default:' + slug));
      // No provider here, so these pages have no vectors yet: their write embeds them, and the preview counts them.
      expect(preview.cost.embedding_pages).toBe(4);
      const drifted = join(root, slugs[0] + '.md');
      writeFileSync(drifted, readFileSync(drifted, 'utf8') + NL + 'An edit made outside gbrain.' + NL);
      installFaultHook(async (point, detail) => {
        if (point !== 'consumer:preparing') return;
        const [row] = await engine.executeRaw<{ slug: string }>('SELECT slug FROM persistence_requests WHERE id=$1::uuid', [detail.writeId]);
        if (row?.slug === slugs[1]) throw new OperationError('source_changed', 'Forced decline inside the publication group.', 'Fixture.');
      });
      const after = await lastSequence(engine);
      let run;
      try { run = await cli(engine, ['private-labels', '--apply', '--expect', preview.preview_hash]); } finally { installFaultHook(undefined); }
      const { result: applied, exit } = run;
      expect(applied.failed.map((failed: { slug: string; reason: string }) => [failed.slug, failed.reason])).toEqual([[slugs[0], 'source_changed'], [slugs[1], 'source_changed']]);
      expect(applied.applied).toBe(2);
      expect(applied.complete).toBe(true);
      expect(applied.stopped).toBeUndefined();
      expect(applied.declined).toEqual({ source_changed: 2 });
      expect(exit).toBe(0);
      for (const slug of slugs.slice(0, 2)) expect((await frontmatter(engine, slug)).access).toBe('private');
      for (const slug of slugs.slice(2, 4)) expect('access' in await frontmatter(engine, slug)).toBe(false);
      const rows = await engine.executeRaw<{ slug: string; state: string; batch: string | null; published: string | null }>(`SELECT slug, state, intent->>'maintenance_batch' AS batch,
        published_at::text AS published FROM persistence_requests WHERE sequence>$1::bigint AND intent->>'kind'='managed_maintenance_page' ORDER BY sequence`, [after]);
      const landed = rows.filter(row => row.state === 'committed');
      expect(landed.map(row => row.slug)).toEqual(slugs.slice(2, 4));
      expect(landed.every(row => row.batch !== null)).toBe(true);
      expect(new Set(rows.map(row => row.batch)).size).toBe(1);
      // Postgres publishes a batch's pages in groups: the declined member left the group and the other two still published together.
      if (backend === 'postgres') expect(landed[0]!.published).toBe(landed[1]!.published);
      const path = applied.details.ledger as string;
      expect(applied.details.ledger_rows).toEqual({ intent: 4, committed: 2 });
      expect(lines(path).length).toBe(applied.details.ledger_rows_written);
      const next = (await cli(engine, ['private-labels', '--limit', '4'])).result;
      expect(next.listing.map((entry: { item: string }) => entry.item)).toEqual([4, 5, 0, 1].map(i => 'default:' + slugs[i]));
      expect(next.details.window.tried_before).toBe(2);
    }, { databaseUrl, setup }), 180_000);

    test('carried declines never stop a window: at half of its attempts at the tail, or as the whole window (complete, declined, exit 0); fresh pages that all decline still stop the run', () => managedBrain(async ({ engine, ctx, root }) => {
      const first = Array.from({ length: 16 }, (_, i) => 'notes/w1-' + String(i).padStart(2, '0'));
      for (const slug of first) await put(ctx, slug, labelled(slug));
      await settleManagedGitEffects(engine);
      const drift = (slug: string) => { const file = join(root, slug + '.md'); writeFileSync(file, readFileSync(file, 'utf8') + NL + 'An edit made outside gbrain.' + NL); };
      // Five drifted pages spread through the first window, so it completes with five declines.
      const declined = [1, 4, 7, 10, 13].map(i => first[i]!);
      for (const slug of declined) drift(slug);
      const one = (await cli(engine, ['private-labels', '--limit', '16'])).result;
      const w1 = await cli(engine, ['private-labels', '--apply', '--expect', one.preview_hash]);
      expect(w1.result.applied).toBe(11);
      expect(w1.result.failed.map((f: { reason: string }) => f.reason)).toEqual(Array(5).fill('source_changed'));
      // The next window holds five new pages and the five carried declines at its tail: one code has five hits and half of
      // the attempts, the breaker's third rule, yet the window applies the five and completes, because carried declines do not count.
      const second = Array.from({ length: 5 }, (_, i) => 'notes/w2-' + i);
      for (const slug of second) await put(ctx, slug, labelled(slug));
      await settleManagedGitEffects(engine);
      const two = (await cli(engine, ['private-labels', '--limit', '16'])).result;
      const w2 = await cli(engine, ['private-labels', '--apply', '--expect', two.preview_hash]);
      expect(w2.result.stopped).toBeUndefined();
      expect(w2.result.applied).toBe(5);
      expect(w2.result.complete).toBe(true);
      expect(two.listing.map((entry: { item: string }) => entry.item)).toEqual([...second, ...declined].map(slug => 'default:' + slug));
      expect(two.details.window.tried_before).toBe(5);
      expect(w2.result.declined).toEqual({ source_changed: 5 });
      expect(w2.exit).toBe(0);
      for (const slug of second) expect('access' in await frontmatter(engine, slug)).toBe(false);
      // A window of carried declines alone completes too, applies nothing and exits 0: none of them counts toward the breaker.
      const carried = (await cli(engine, ['private-labels', '--limit', '16'])).result;
      expect(carried.listing.length).toBe(5);
      const w3 = await cli(engine, ['private-labels', '--apply', '--expect', carried.preview_hash]);
      expect(w3.result.stopped).toBeUndefined();
      expect(w3.result.complete).toBe(true);
      expect(w3.result.applied).toBe(0);
      expect(w3.result.declined).toEqual({ source_changed: 5 });
      expect(w3.exit).toBe(0);
      // Pages not tried yet that all decline (as a dirty checkout makes them) still trip the breaker: the run stops and exits 1.
      const fresh = Array.from({ length: 6 }, (_, i) => 'notes/w3-' + i);
      for (const slug of fresh) await put(ctx, slug, labelled(slug));
      await settleManagedGitEffects(engine);
      for (const slug of fresh) drift(slug);
      const four = (await cli(engine, ['private-labels', '--limit', '16'])).result;
      const w4 = await cli(engine, ['private-labels', '--apply', '--expect', four.preview_hash]);
      expect(w4.result.stopped?.reason).toBe('item_failures_systemic');
      expect(w4.result.applied).toBe(0);
      // Every page the batch tried is reported, the ones past the stop included; the page the breaker stopped at is named by the stop.
      expect(w4.result.failed.map((f: { slug: string }) => f.slug).sort()).toEqual([...fresh.slice(0, 4), fresh[5]!, ...declined].sort());
      expect(w4.exit).toBe(1);
    }, { databaseUrl, setup }), 240_000);

    test('a page refused with a non-item error inside a batch stops the run with its code, and the pages after it, already published, are counted', () => managedBrain(async ({ engine, ctx }) => {
      const slugs = [0, 1, 2, 3].map(i => 'notes/stop-' + i);
      for (const slug of slugs) await put(ctx, slug, labelled(slug));
      await settleManagedGitEffects(engine);
      const preview = (await cli(engine, ['private-labels'])).result;
      installFaultHook(async (point, detail) => {
        if (point !== 'consumer:preparing') return;
        const [row] = await engine.executeRaw<{ slug: string }>('SELECT slug FROM persistence_requests WHERE id=$1::uuid', [detail.writeId]);
        if (row?.slug === slugs[1]) throw new OperationError('invalid_fence', 'Forced fence refusal inside the batch.', 'Fixture.');
      });
      let run;
      try { run = await cli(engine, ['private-labels', '--apply', '--expect', preview.preview_hash]); } finally { installFaultHook(undefined); }
      const { result, exit } = run;
      expect(result.stopped?.reason).toBe('invalid_fence');
      expect(result.stopped?.message).toContain(slugs[1]);
      expect(exit).toBe(1);
      expect(result.applied).toBe(3);
      expect((await frontmatter(engine, slugs[1])).access).toBe('private');
      for (const slug of [slugs[0], slugs[2], slugs[3]]) expect('access' in await frontmatter(engine, slug)).toBe(false);
      expect(result.details.ledger_rows).toEqual({ intent: 4, committed: 3 });
      expect(lines(result.details.ledger).length).toBe(result.details.ledger_rows_written);
    }, { databaseUrl, setup }), 180_000);

    test('a writer whose brain-wide outstanding cap is below the batch still applies every page: a refused batch halves the next ones and its page applies alone', () => managedBrain(async ({ engine, ctx }) => {
      const slugs = [0, 1, 2].map(i => 'notes/cap-' + i);
      for (const slug of slugs) await put(ctx, slug, labelled(slug));
      await settleManagedGitEffects(engine);
      await engine.setConfig('persistence.limits.brain_outstanding', '1');
      const preview = (await cli(engine, ['private-labels'])).result;
      const { result, exit } = await cli(engine, ['private-labels', '--apply', '--expect', preview.preview_hash]);
      expect(result.stopped).toBeUndefined();
      expect(result.applied).toBe(3);
      expect(result.complete).toBe(true);
      expect(exit).toBe(0);
      for (const slug of slugs) expect('access' in await frontmatter(engine, slug)).toBe(false);
    }, { databaseUrl, setup }), 180_000);

    test('every page of a run has its intent line before any of them is published, and a crash after the group published still restores each', () => managedBrain(async ({ engine, ctx, root }) => {
      const slugs = [0, 1, 2].map(i => 'notes/crash-' + i);
      for (const slug of slugs) await put(ctx, slug, labelled(slug));
      await settleManagedGitEffects(engine);
      const preview = (await cli(engine, ['private-labels'])).result;
      expect(preview.listing.length).toBe(3);
      const scope = await resolveRepairScope(engine);
      const real = privateLabelsLedger(scope.brain_id);
      const phases: string[] = [];
      const filesLabelledAtIntent: boolean[] = [];
      const crashing = { ...real, record(line: PrivateLabelsLedgerLine) {
        if (line.phase === 'intent') filesLabelledAtIntent.push(slugs.every(slug => /^access: private$/m.test(readFileSync(join(root, slug + '.md'), 'utf8'))));
        // The process dies after the group published and before this page's commit line: the throw stands in for it.
        if (line.phase === 'committed' && line.slug === slugs[1]) throw new Error('forced crash after the group published');
        phases.push(line.phase!);
        real.record(line);
      } };
      const applied = await (await repairRunner(engine, { apply: true, logger })).run('private-labels', scope, { explicit: true, expect: preview.preview_hash, privateLabelsLedger: crashing });
      expect(applied.failed).toEqual([]);
      expect(applied.applied).toBe(3);
      expect(filesLabelledAtIntent).toEqual([true, true, true]);
      expect(phases).toEqual(['intent', 'intent', 'intent', 'committed', 'committed']);
      for (const slug of slugs) expect('access' in await frontmatter(engine, slug)).toBe(false);
      const restorePreview = (await cli(engine, ['private-labels', '--class', 'restore'])).result;
      expect(restorePreview.listing.map((entry: { item: string }) => entry.item)).toEqual(slugs.map(slug => 'default:' + slug));
      const restored = (await cli(engine, ['private-labels', '--class', 'restore', '--apply', '--expect', restorePreview.preview_hash])).result;
      expect(restored.applied).toBe(3);
      for (const slug of slugs) expect((await frontmatter(engine, slug)).access).toBe('private');
    }, { databaseUrl, setup }), 180_000);

    test('a preview-bound apply waits out a source refresh past the interactive wait, up to its own ceiling; past it the step is refused whole and the same apply resumes; an interactive write keeps its own wait', () => managedBrain(async ({ engine, ctx }) => {
      await put(ctx, 'notes/fenced', labelled('notes/fenced'));
      await settleManagedGitEffects(engine);
      const preview = (await cli(engine, ['private-labels'])).result;
      expect(preview.listing.length).toBe(1);
      const binding = (await getWorktreeBinding(engine, 'default'))!;
      const fence = async () => {
        const lock = await tryAcquireNativeLock(join(persistenceHome(), 'locks', 'refresh-' + binding.worktree_id + '.lock'));
        expect(lock).not.toBeNull();
        const [row] = await engine.executeRaw<{ id: string }>(`INSERT INTO persistence_worktree_refreshes (worktree_id,source_ids,principal_id,owner_epoch,topology_generation,state,old_head,target_head,upstream_ref)
          VALUES ($1::uuid,ARRAY['default'],gen_random_uuid(),$2,$3,'fenced','a','b','origin/main') RETURNING id::text AS id`, [binding.worktree_id, binding.owner_epoch, binding.topology_generation]);
        return async () => {
          await engine.executeRaw("UPDATE persistence_worktree_refreshes SET state='completed', completed_at=now(), updated_at=now() WHERE id=$1::uuid", [row!.id]);
          await lock!.release();
        };
      };
      _setRefreshFenceWaitForTests(300);
      try {
        const release = await fence();
        const interactive = await put(ctx, 'notes/other', labelled('notes/other')).then(() => null, (error: unknown) => error as OperationError);
        expect(interactive?.code).toBe('worktree_refreshing');
        const pending = cli(engine, ['private-labels', '--apply', '--expect', preview.preview_hash]);
        await Bun.sleep(1500);
        await release();
        const { result: applied, exit } = await pending;
        expect(applied.applied).toBe(1);
        expect(exit).toBe(0);
        expect('access' in await frontmatter(engine, 'notes/fenced')).toBe(false);

        const held = ['notes/held', 'notes/held-b', 'notes/held-c'];
        for (const slug of held) await put(ctx, slug, labelled(slug));
        await settleManagedGitEffects(engine);
        const second = (await cli(engine, ['private-labels'])).result;
        _setRepairRefreshWaitForTests(400);
        const releaseHeld = await fence();
        const refused = await cli(engine, ['private-labels', '--apply', '--expect', second.preview_hash]).then(() => null, (error: unknown) => error as OperationError);
        await releaseHeld();
        // A refresh that outlasts the wait refuses the step whole: the refusal names the refresh and what it waited, and no page changed.
        expect(refused?.code).toBe('worktree_refreshing');
        expect(refused?.message).toMatch(/refresh [0-9a-f-]+ is fast-forwarding .*This call waited \d+ ms/);
        for (const slug of held) expect((await frontmatter(engine, slug)).access).toBe('private');
        // The same approved apply resumes once the refresh ended, although the refused pages now have intent lines.
        const resumed = (await cli(engine, ['private-labels', '--apply', '--expect', second.preview_hash])).result;
        expect(resumed.applied).toBe(3);
        expect(resumed.complete).toBe(true);
      } finally { _setRefreshFenceWaitForTests(null); _setRepairRefreshWaitForTests(null); }
    }, { databaseUrl, setup }), 180_000);
  });
}
