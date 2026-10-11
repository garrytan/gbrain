/**
 * B5 offline safety gate and operator journeys for pinned questions (C4),
 * registered once per engine: test/pinned-questions-safety.test.ts (PGLite)
 * and test/e2e/pinned-questions-postgres.test.ts (live Postgres). Stub model
 * only; no network.
 *
 * Protects: restricted grants never see a question page or answer on any
 * read surface; answer text never enters pages, chunks, versions or export;
 * every evidence change (edit, soft and hard delete, forget, clock expiry,
 * supersession, visibility, take, timeline, owner edit, a fact's source page
 * quarantined) marks the dependent
 * sentence stale on the next read with no cycle; refresh never publishes over
 * a concurrent change, a duplicate worker, a crash between publication
 * stages, or a failure; consent, keyless, budget and worker states carry an
 * actionable next step; the dream.auto_think migration keeps every opt-out.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { recordFactWithdrawal } from '../../src/core/facts/withdrawal.ts';
import { __resetPrivateVisibilityCacheForTests } from '../../src/core/search/private-visibility.ts';
import { __setChatTransportForTests } from '../../src/core/ai/gateway.ts';
import { operationScopesAllowed } from '../../src/core/scope.ts';
import { operationsByName } from '../../src/core/operations.ts';
import { runExport } from '../../src/commands/export.ts';
import { pinQuestion, questionStatus, refreshQuestion, unpinQuestion, listQuestions } from '../../src/core/questions/service.ts';
import { refreshPin } from '../../src/core/questions/refresh.ts';
import { getPin } from '../../src/core/questions/store.ts';
import { parseQuestionId, questionSlug } from '../../src/core/questions/identity.ts';
import { migrateAutoThinkToPins } from '../../src/core/questions/auto-think-migration.ts';
import { runPhaseStandingQuestions } from '../../src/core/questions/phase.ts';
import type { QuestionReceipt } from '../../src/core/questions/receipt.ts';
import { withEnv } from './with-env.ts';
import { CANARY, ENTITY, MODEL, QUESTION, localCtx, mcp, page, putPage, seedBrain, stubChat, stubTransport, type Seeded } from './pinned-questions-fixture.ts';

type Pinned = { created: boolean; activated: boolean; receipt: QuestionReceipt };

async function pin(engine: BrainEngine, s: Seeded, chat = stubChat(), extra: Record<string, unknown> = {}): Promise<Pinned> {
  return pinQuestion(localCtx(engine, s.sourceId), { question: QUESTION, scope: { entity: ENTITY }, ...extra }, { chat: chat.fn });
}

const status = (engine: BrainEngine, s: Seeded, id: string) => questionStatus(localCtx(engine, s.sourceId), { id });
const sentence = (r: QuestionReceipt, needle: string) => r.answer!.find(x => x.text.includes(needle));

async function revisionOf(engine: BrainEngine, sourceId: string, slug: string): Promise<string> {
  return (await engine.readPageSnapshot(slug, { sourceId }))!.revision;
}

async function setRemotePrivate(engine: BrainEngine, visible: boolean): Promise<void> {
  if (visible) await engine.setConfig('search.remote_private_pages', 'visible');
  else await engine.executeRaw("DELETE FROM config WHERE key = 'search.remote_private_pages'");
  __resetPrivateVisibilityCacheForTests();
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

export function registerPinnedQuestionSuite(label: string, getEngine: () => BrainEngine): void {
  const env = { ANTHROPIC_API_KEY: 'sk-test-pinned-questions' };
  const run = (name: string, fn: (engine: BrainEngine) => Promise<void>, timeout = 60_000) =>
    test(name, async () => {
      const engine = getEngine();
      await engine.setConfig('models.standing_questions', MODEL);
      await withEnv(env, () => fn(engine));
    }, timeout);

  describe(`${label}: lifecycle and consent`, () => {
    run('a CLI pin is active, answers first, is idempotent and keeps the answer out of its page', async (engine) => {
      const s = await seedBrain(engine);
      const chat = stubChat();
      const first = await pin(engine, s, chat);
      expect(first.created).toBe(true);
      expect(first.receipt).toMatchObject({ state: 'active', freshness: 'fresh', blocked_reason: null, page_materialized: true, answer_revision: 1 });
      expect(first.receipt.answer!.length).toBeGreaterThan(3);
      expect(first.receipt.answer!.every(x => x.text.startsWith(CANARY) && !x.stale)).toBe(true);
      expect(first.receipt.verify.mcp).toEqual({ tool: 'questions_status', arguments: { id: first.receipt.id } });
      expect(first.receipt.evidence_watermark?.page_generation).toBeGreaterThan(0);
      const again = await pin(engine, s, chat);
      expect(again).toMatchObject({ created: false, receipt: { id: first.receipt.id, answer_revision: 1 } });
      expect(chat.calls).toHaveLength(1);
      const parsed = parseQuestionId(first.receipt.id, 'default')!;
      const [row] = await engine.executeRaw<{ type: string; vis: string; marker: string; body: string }>(
        `SELECT type, frontmatter->>'visibility' AS vis, frontmatter->>'pinned_question' AS marker, compiled_truth AS body FROM pages WHERE source_id = $1 AND slug = $2`,
        [parsed.sourceId, parsed.slug]);
      expect(row).toMatchObject({ type: 'question', vis: 'private', marker: first.receipt.id });
      expect(row!.body).not.toContain(CANARY);
    });

    run('the same question in two sources has two source-qualified ids', async (engine) => {
      const a = await seedBrain(engine);
      const b = await seedBrain(engine);
      const pa = await pin(engine, a);
      const pb = await pin(engine, b);
      expect(pa.receipt.id).not.toBe(pb.receipt.id);
      expect(pa.receipt.id.startsWith(`${a.sourceId}:questions/`)).toBe(true);
      expect(pb.receipt.slug).toBe(pa.receipt.slug);
      const listed = await listQuestions(localCtx(engine, a.sourceId), { source: a.sourceId });
      expect(listed.questions.map(q => q.id)).toEqual([pa.receipt.id]);
    });

    run('an MCP pin stays inactive with no model call until the owner activates it', async (engine) => {
      const s = await seedBrain(engine);
      await setRemotePrivate(engine, true);
      const calls = { calls: 0, fail: false };
      __setChatTransportForTests(stubTransport(calls));
      try {
        const { body } = await mcp(engine, 'questions_pin', { question: QUESTION, scope: { entity: ENTITY } }, { scopes: ['read', 'write'], sourceId: s.sourceId });
        const receipt = (body as unknown as Pinned).receipt;
        expect(receipt).toMatchObject({ state: 'inactive', inactive_reason: 'awaiting_consent', freshness: 'awaiting_refresh', blocked_reason: 'awaiting_consent', page_materialized: false });
        expect(receipt.fix).toMatchObject({ argv: ['gbrain', 'questions', 'pin', '--id', receipt.id], consent: ['paid'], actor: 'user' });
        const refreshed = await mcp(engine, 'questions_refresh', { id: receipt.id }, { scopes: ['read', 'write'], sourceId: s.sourceId });
        expect(refreshed.body).toMatchObject({ blocked_reason: 'awaiting_consent', refresh: { status: 'blocked', blocked_reason: 'awaiting_consent' } });
        expect(calls.calls).toBe(0);
        const activated = await pinQuestion(localCtx(engine, s.sourceId), { id: receipt.id }, { chat: stubChat().fn });
        expect(activated).toMatchObject({ created: false, activated: true, receipt: { state: 'active', freshness: 'fresh', page_materialized: true } });
      } finally {
        __setChatTransportForTests(null);
        await setRemotePrivate(engine, false);
      }
    });

    run('unpin stops refreshes and archives the page, keeping the owner notes', async (engine) => {
      const s = await seedBrain(engine);
      const pinned = await pin(engine, s);
      const { slug } = parseQuestionId(pinned.receipt.id, 'default')!;
      const snap = await engine.readPageSnapshot(slug, { sourceId: s.sourceId });
      await putPage(engine, s.sourceId, slug, `---\n${Object.entries(snap!.page.frontmatter as Record<string, unknown>).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\ntitle: ${JSON.stringify(snap!.page.title)}\ntype: question\n---\n${snap!.page.compiled_truth}\nMy own note about acme.\n`, snap!.revision);
      const out = await unpinQuestion(localCtx(engine, s.sourceId), { id: pinned.receipt.id });
      expect(out).toMatchObject({ unpinned: true, receipt: { state: 'archived', freshness: 'archived', blocked_reason: null, fix: null } });
      const [row] = await engine.executeRaw<{ status: string; body: string }>(`SELECT frontmatter->>'status' AS status, compiled_truth AS body FROM pages WHERE source_id = $1 AND slug = $2`, [s.sourceId, slug]);
      expect(row).toMatchObject({ status: 'archived' });
      expect(row!.body).toContain('My own note about acme.');
      const chat = stubChat();
      expect((await refreshPin(engine, s.sourceId, slug, { trigger: 'manual', chat: chat.fn, leaseOwner: 't' })).status).toBe('skipped');
      expect((await unpinQuestion(localCtx(engine, s.sourceId), { id: pinned.receipt.id })).unpinned).toBe(false);
      const phase = await runPhaseStandingQuestions(engine, { dryRun: false, chat: chat.fn });
      expect(JSON.stringify(phase.details)).not.toContain(pinned.receipt.id.split(':')[1]!);
      expect(chat.calls).toHaveLength(0);
    });
  });

  describe(`${label}: zero leakage to restricted grants`, () => {
    run('restricted grants never see question pages or answers on any read surface', async (engine) => {
      const s = await seedBrain(engine);
      const pinned = await pin(engine, s);
      const { slug } = parseQuestionId(pinned.receipt.id, 'default')!;
      const grants = [
        { scopes: ['read', 'write'], sourceId: s.sourceId },
        { scopes: ['read'], sourceId: s.sourceId },
      ];
      for (const g of grants) {
        for (const [tool, params] of [
          ['search', { query: 'acme-example widgets leads' }],
          ['query', { query: QUESTION }],
          ['list_pages', { type: 'question' }],
          ['list_pages', {}],
          ['get_page', { slug }],
          ['get_page', { slug, fuzzy: true }],
          ['get_versions', { slug }],
          ['context_pack', { entities: ENTITY }],
          ['recall', { query: QUESTION }],
        ] as Array<[string, Record<string, unknown>]>) {
          const { text, result } = await mcp(engine, tool, params, g);
          const echoed = params.slug === slug;
          expect({ tool, leaked: text.includes(CANARY) || (!echoed && text.includes(slug)) || text.includes(QUESTION) || text.includes('pinned_questions') })
            .toEqual({ tool, leaked: false });
          if (tool === 'get_page') expect(result.isError).toBe(true);
        }
        const byId = { id: pinned.receipt.id };
        for (const [tool, params] of [
          ['questions_list', {}],
          ['questions_status', byId],
          ['questions_refresh', byId],
          ['questions_unpin', byId],
          ['questions_pin', { ...byId, question: QUESTION }],
        ] as Array<[string, Record<string, unknown>]>) {
          const { result, body } = await mcp(engine, tool, params, g);
          expect({ tool, isError: result.isError, code: body.code }).toEqual({ tool, isError: true, code: 'question_owner_only' });
          expect(JSON.stringify(body)).not.toContain(CANARY);
        }
      }
      await setRemotePrivate(engine, true);
      try {
        const fenced = { scopes: ['read', 'write'], sourceId: s.sourceId, boundSlugPrefixes: ['notes/'] };
        const { body } = await mcp(engine, 'questions_status', { id: pinned.receipt.id }, fenced);
        expect(body.code).toBe('question_owner_only');
        const pack = await mcp(engine, 'context_pack', { entities: ENTITY }, fenced);
        expect(pack.text).not.toContain(CANARY);
      } finally { await setRemotePrivate(engine, false); }
    });

    run('answer text never enters pages, chunks, versions, history or export', async (engine) => {
      const s = await seedBrain(engine);
      const pinned = await pin(engine, s);
      await refreshQuestion(localCtx(engine, s.sourceId), { id: pinned.receipt.id, full: true }, { chat: stubChat().fn });
      const like = `%${CANARY}%`;
      const [counts] = await engine.executeRaw<{ pages: number; chunks: number; versions: number }>(
        `SELECT (SELECT count(*)::int FROM pages WHERE compiled_truth LIKE $1 OR timeline LIKE $1 OR frontmatter::text LIKE $1) AS pages,
                (SELECT count(*)::int FROM content_chunks WHERE chunk_text LIKE $1) AS chunks,
                (SELECT count(*)::int FROM page_versions WHERE compiled_truth LIKE $1 OR frontmatter::text LIKE $1) AS versions`, [like]);
      expect(counts).toEqual({ pages: 0, chunks: 0, versions: 0 });
      const dir = mkdtempSync(join(tmpdir(), 'pq-export-'));
      try {
        await runExport(engine, ['--dir', dir, '--source', s.sourceId]);
        const files = walk(dir);
        expect(files.some(f => f.includes('questions'))).toBe(true);
        for (const f of files) expect(readFileSync(f, 'utf8')).not.toContain(CANARY);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  });

  describe(`${label}: read-time staleness (no cycle)`, () => {
    const cases: Array<{ name: string; needle: string; reason: string; mutate: (engine: BrainEngine, s: Seeded, slug: string) => Promise<void>; expiringInMs?: number }> = [
      { name: 'edited page', needle: 'notes/widget-plan', reason: 'page_changed', mutate: async (engine, s) =>
        putPage(engine, s.sourceId, 'notes/widget-plan', page('note', 'Widget plan', 'The widget plan slipped to June.'), await revisionOf(engine, s.sourceId, 'notes/widget-plan')) },
      { name: 'soft-deleted page', needle: 'notes/widget-plan', reason: 'page_deleted', mutate: async (engine, s) => {
        await submitPageMutation(localCtx(engine, s.sourceId), { operation: 'delete_page', params: { slug: 'notes/widget-plan', source_id: s.sourceId, expected_revision: await revisionOf(engine, s.sourceId, 'notes/widget-plan') } });
      } },
      { name: 'hard-deleted page (cascade)', needle: 'timeline people/alice-example', reason: 'timeline_missing', mutate: async (engine, s) => {
        await engine.executeRaw('DELETE FROM pages WHERE source_id = $1 AND slug = $2', [s.sourceId, 'people/alice-example']);
      } },
      { name: 'forgotten fact', needle: '40 employees', reason: 'fact_withdrawn', mutate: async (engine, s) => { await recordFactWithdrawal(engine, s.factId, s.sourceId); } },
      { name: 'fact expired by the clock alone', needle: 'widget sale', reason: 'fact_expired', expiringInMs: 2_500, mutate: async () => { await new Promise(r => setTimeout(r, 3_000)); } },
      { name: 'superseded fact', needle: '40 employees', reason: 'fact_superseded', mutate: async (engine, s) => {
        const [n] = await engine.executeRaw<{ id: string }>(`INSERT INTO facts (source_id, entity_slug, fact, kind, source, visibility, confidence, valid_from)
          VALUES ($1, $2, 'Acme example has 55 employees', 'fact', 'test', 'world', 1, now()) RETURNING id`, [s.sourceId, ENTITY]);
        await engine.executeRaw('UPDATE facts SET superseded_by = $2 WHERE id = $1', [s.factId, Number(n!.id)]);
      } },
      { name: 'page made private', needle: 'notes/widget-plan', reason: 'page_changed', mutate: async (engine, s) =>
        putPage(engine, s.sourceId, 'notes/widget-plan', page('note', 'Widget plan', 'The widget plan for acme-example ships in March.', 'visibility: private\n'), await revisionOf(engine, s.sourceId, 'notes/widget-plan')) },
      { name: 'deactivated take', needle: 'take on people/alice-example', reason: 'take_inactive', mutate: async (engine, s) => { await engine.executeRaw('UPDATE takes SET active = false WHERE id = $1', [s.takeId]); } },
      { name: 'removed timeline entry', needle: 'timeline people/alice-example', reason: 'timeline_missing', mutate: async (engine, s) => { await engine.executeRaw('DELETE FROM timeline_entries WHERE id = $1', [s.timelineId]); } },
      { name: 'fact whose source page was quarantined after it was projected', needle: '40 employees', reason: 'fact_source_quarantined', mutate: async (engine, s) => {
        await engine.executeRaw('UPDATE facts SET source_markdown_slug = $2 WHERE id = $1', [s.factId, 'notes/widget-plan']);
        await engine.executeRaw(`UPDATE pages SET frontmatter = COALESCE(frontmatter, '{}'::jsonb) || '{"quarantine": {"reason": "junk_pattern", "detail": "test"}}'::jsonb
          WHERE source_id = $1 AND slug = 'notes/widget-plan'`, [s.sourceId]);
      } },
    ];
    for (const c of cases) {
      run(`${c.name} makes the dependent sentence stale on read, and context_pack withholds it`, async (engine) => {
        const s = await seedBrain(engine, { expiringInMs: c.expiringInMs });
        const pinned = await pin(engine, s);
        const before = sentence(pinned.receipt, c.needle);
        expect(before).toMatchObject({ stale: false });
        const { slug } = parseQuestionId(pinned.receipt.id, 'default')!;
        await c.mutate(engine, s, slug);
        const notices: Array<{ code: string; kind: string; fix?: unknown }> = [];
        const after = await questionStatus({ ...localCtx(engine, s.sourceId), emitNotice: (n) => { notices.push(n); } }, { id: pinned.receipt.id });
        expect(after.freshness).toBe('stale');
        expect(notices).toMatchObject([{ code: 'pinned_answer_stale', kind: 'degraded' }]);
        expect(sentence(after, c.needle)).toMatchObject({ stale: true, reasons: [c.reason] });
        expect(after.fix?.mcp?.tool).toBe('questions_refresh');
        const pack = await (await import('../../src/core/questions/service.ts')).pinnedAnswersForPack(localCtx(engine, s.sourceId), [ENTITY]);
        expect(pack?.withheld?.stale_sentences).toBe(after.sentences.stale);
        expect(JSON.stringify(pack?.pinned_questions ?? [])).not.toContain(before!.text);
      }, 30_000);
    }

    run('an owner edit to the question page becomes an owner claim, stale until the next refresh', async (engine) => {
      const s = await seedBrain(engine);
      const pinned = await pin(engine, s);
      const { slug } = parseQuestionId(pinned.receipt.id, 'default')!;
      const edit = async (note: string) => {
        const snap = (await engine.readPageSnapshot(slug, { sourceId: s.sourceId }))!;
        const fm = Object.entries(snap.page.frontmatter as Record<string, unknown>).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');
        await putPage(engine, s.sourceId, slug, `---\n${fm}\ntitle: ${JSON.stringify(snap.page.title)}\ntype: question\n---\n# ${QUESTION}\n\n${note}\n`, snap.revision);
      };
      await edit('Acme example is moving widget production to Porto.');
      const viaRefresh = await refreshQuestion(localCtx(engine, s.sourceId), { id: pinned.receipt.id }, { chat: stubChat().fn });
      const owner = viaRefresh.answer!.find(x => x.origin === 'owner');
      expect(owner).toMatchObject({ text: 'Acme example is moving widget production to Porto.', stale: false });
      await edit('Acme example moved widget production to Porto in May.');
      const after = await status(engine, s, pinned.receipt.id);
      expect(after.answer!.find(x => x.origin === 'owner')).toMatchObject({ stale: true, reasons: ['owner_edited'] });
    });
  });

  describe(`${label}: refresh protocol`, () => {
    run('refresh edits the previous answer for new evidence and recomputes after a deletion', async (engine) => {
      const s = await seedBrain(engine);
      const pinned = await pin(engine, s);
      const { slug } = parseQuestionId(pinned.receipt.id, 'default')!;
      await putPage(engine, s.sourceId, 'notes/widget-factory', page('note', 'Widget factory', 'acme-example opened a second widget factory led by Alice example.'));
      const chat = stubChat();
      const incremental = await refreshPin(engine, s.sourceId, slug, { trigger: 'manual', chat: chat.fn, leaseOwner: 't' });
      expect(incremental).toMatchObject({ status: 'published', mode: 'incremental' });
      expect(chat.calls[0]).toContain('Previous answer');
      await submitPageMutation(localCtx(engine, s.sourceId), { operation: 'delete_page', params: { slug: 'notes/widget-factory', source_id: s.sourceId, expected_revision: await revisionOf(engine, s.sourceId, 'notes/widget-factory') } });
      const full = await refreshPin(engine, s.sourceId, slug, { trigger: 'manual', chat: chat.fn, leaseOwner: 't' });
      expect(full).toMatchObject({ status: 'published', mode: 'full' });
      expect(chat.calls[1]).not.toContain('Previous answer');
      expect((await status(engine, s, pinned.receipt.id)).freshness).toBe('fresh');
    });

    run('a concurrent owner edit during refresh keeps the previous answer stale (revision revalidated at commit)', async (engine) => {
      const s = await seedBrain(engine);
      const pinned = await pin(engine, s);
      const { slug } = parseQuestionId(pinned.receipt.id, 'default')!;
      await putPage(engine, s.sourceId, 'notes/widget-plan', page('note', 'Widget plan', 'The widget plan ships in April.'), await revisionOf(engine, s.sourceId, 'notes/widget-plan'));
      const outcome = await refreshPin(engine, s.sourceId, slug, { trigger: 'manual', chat: stubChat().fn, leaseOwner: 't', hooks: {
        beforeCommit: async () => putPage(engine, s.sourceId, 'notes/widget-plan', page('note', 'Widget plan', 'The widget plan ships in May.'), await revisionOf(engine, s.sourceId, 'notes/widget-plan')),
      } });
      expect(outcome).toMatchObject({ status: 'conflict' });
      const after = await status(engine, s, pinned.receipt.id);
      expect(after).toMatchObject({ answer_revision: 1, freshness: 'stale', last_error: 'concurrent_change' });
      expect(sentence(after, 'notes/widget-plan')).toMatchObject({ stale: true });
      expect((await getPin(engine, s.sourceId, slug))!.lease_token).toBeNull();
    });

    run('duplicate workers: one holds the lease, the other reports in_progress, one publication lands', async (engine) => {
      const s = await seedBrain(engine);
      const pinned = await pin(engine, s);
      const { slug } = parseQuestionId(pinned.receipt.id, 'default')!;
      const chat = stubChat();
      let release!: () => void;
      chat.gate = new Promise(r => { release = r; });
      const first = refreshPin(engine, s.sourceId, slug, { trigger: 'cycle', chat: chat.fn, leaseOwner: 'worker-a' });
      while (chat.calls.length === 0) await new Promise(r => setTimeout(r, 10));
      const second = await refreshPin(engine, s.sourceId, slug, { trigger: 'cycle', chat: stubChat().fn, leaseOwner: 'worker-b' });
      expect(second).toEqual({ status: 'in_progress' });
      expect((await status(engine, s, pinned.receipt.id)).freshness).toBe('refreshing');
      release();
      expect((await first).status).toBe('published');
      expect((await getPin(engine, s.sourceId, slug))!.answer_revision).toBe(2);
    });

    run('a crash between publication stages publishes nothing and keeps the previous answer', async (engine) => {
      const s = await seedBrain(engine);
      const pinned = await pin(engine, s);
      const { slug } = parseQuestionId(pinned.receipt.id, 'default')!;
      const before = await getPin(engine, s.sourceId, slug);
      const outcome = await refreshPin(engine, s.sourceId, slug, { trigger: 'manual', chat: stubChat().fn, leaseOwner: 't', full: true, hooks: {
        betweenPublicationStages: () => { throw new Error('simulated crash after the answer update'); },
      } });
      expect(outcome).toMatchObject({ status: 'failed', error: 'refresh_failed:publish' });
      const after = (await getPin(engine, s.sourceId, slug))!;
      expect(after).toMatchObject({ answer_revision: before!.answer_revision, lease_token: null });
      expect(after.answer).toEqual(before!.answer);
      const [ev] = await engine.executeRaw<{ n: number; rev: number }>('SELECT count(*)::int AS n, max(answer_revision)::int AS rev FROM question_evidence WHERE question_id = $1', [after.id]);
      expect(ev).toMatchObject({ rev: 1 });
      expect(ev!.n).toBeGreaterThan(0);
      const r = await status(engine, s, pinned.receipt.id);
      expect(r).toMatchObject({ freshness: 'fresh', blocked_reason: 'refresh_failed' });
      expect(r.fix?.mcp).toEqual({ tool: 'questions_refresh', arguments: { id: pinned.receipt.id, full: true } });
    });

    run("a crashed worker's lease is taken over only after it expires", async (engine) => {
      const s = await seedBrain(engine);
      const pinned = await pin(engine, s);
      const { slug } = parseQuestionId(pinned.receipt.id, 'default')!;
      await engine.executeRaw(`UPDATE pinned_questions SET lease_token = 'dead', lease_owner = 'crashed', lease_expires_at = now() + interval '1 hour' WHERE source_id = $1 AND slug = $2`, [s.sourceId, slug]);
      expect((await refreshPin(engine, s.sourceId, slug, { trigger: 'cycle', chat: stubChat().fn, leaseOwner: 'w' })).status).toBe('in_progress');
      await engine.executeRaw(`UPDATE pinned_questions SET lease_expires_at = now() - interval '1 second' WHERE source_id = $1 AND slug = $2`, [s.sourceId, slug]);
      expect((await refreshPin(engine, s.sourceId, slug, { trigger: 'cycle', chat: stubChat().fn, leaseOwner: 'w' })).status).toBe('published');
    });

    run('a failed refresh keeps the previous answer with its stale flags; the next refresh recovers', async (engine) => {
      const s = await seedBrain(engine);
      const pinned = await pin(engine, s);
      await putPage(engine, s.sourceId, 'notes/widget-plan', page('note', 'Widget plan', 'The widget plan ships in July.'), await revisionOf(engine, s.sourceId, 'notes/widget-plan'));
      const chat = stubChat();
      chat.fail = true;
      const failed = await refreshQuestion(localCtx(engine, s.sourceId), { id: pinned.receipt.id }, { chat: chat.fn });
      expect(failed).toMatchObject({ freshness: 'stale', blocked_reason: 'refresh_failed', answer_revision: 1, refresh: { status: 'failed', error: 'refresh_failed:provider_error' } });
      expect(sentence(failed, 'notes/widget-plan')).toMatchObject({ stale: true });
      chat.fail = false;
      const recovered = await refreshQuestion(localCtx(engine, s.sourceId), { id: pinned.receipt.id, full: true }, { chat: chat.fn });
      expect(recovered).toMatchObject({ freshness: 'fresh', blocked_reason: null, answer_revision: 2, last_error: null });
    });

    run('question pages, synthesis pages and pages repeating a stored answer are never evidence', async (engine) => {
      const s = await seedBrain(engine);
      await putPage(engine, s.sourceId, 'synthesis/acme-widgets', page('synthesis', 'Acme widgets', 'acme-example widgets are built in Lisbon and Alice example leads it.'));
      await putPage(engine, s.sourceId, 'notes/retyped-question', page('question', 'Retyped', 'Where does acme-example build widgets? Alice example leads it.'));
      const pinned = await pin(engine, s);
      await putPage(engine, s.sourceId, 'notes/copied-answer', page('note', 'Copied', `${pinned.receipt.answer![0]!.text} acme-example widgets leads.`));
      const { slug } = parseQuestionId(pinned.receipt.id, 'default')!;
      const chat = stubChat();
      await refreshPin(engine, s.sourceId, slug, { trigger: 'manual', chat: chat.fn, leaseOwner: 't', full: true });
      const cited = (await engine.executeRaw<{ page_slug: string | null }>(
        'SELECT DISTINCT page_slug FROM question_evidence WHERE question_id = (SELECT id FROM pinned_questions WHERE source_id = $1 AND slug = $2)', [s.sourceId, slug])).map(r => r.page_slug);
      for (const banned of ['synthesis/acme-widgets', 'notes/retyped-question', 'notes/copied-answer', slug]) expect(cited).not.toContain(banned);
      for (const banned of ['synthesis/acme-widgets', 'notes/retyped-question', 'notes/copied-answer']) expect(chat.calls.join('\n')).not.toContain(banned);
    });

    run('a quarantined page, and facts projected from it before it was quarantined, are never evidence (#6284)', async (engine) => {
      const s = await seedBrain(engine);
      await putPage(engine, s.sourceId, 'notes/widget-scrape', page('note', 'Widget scrape', 'Scraped listing: acme-example widgets are built in Lisbon by Alice example.'));
      await engine.executeRaw('UPDATE facts SET source_markdown_slug = $2 WHERE id = $1', [s.factId, 'notes/widget-scrape']);
      await engine.executeRaw(`UPDATE pages SET frontmatter = COALESCE(frontmatter, '{}'::jsonb) || '{"quarantine": {"reason": "junk_pattern", "detail": "test"}}'::jsonb
        WHERE source_id = $1 AND slug = ANY($2::text[])`, [s.sourceId, ['notes/widget-scrape', 'notes/widget-plan']]);
      const pinned = await pinQuestion(localCtx(engine, s.sourceId), { question: QUESTION, scope: { slug_prefix: 'notes/' } }, { chat: stubChat().fn });
      const { slug } = parseQuestionId(pinned.receipt.id, 'default')!;
      const chat = stubChat();
      await refreshPin(engine, s.sourceId, slug, { trigger: 'manual', chat: chat.fn, leaseOwner: 't', full: true });
      const scoped = await pinQuestion(localCtx(engine, s.sourceId), { question: 'How many employees does acme-example have?', scope: { entity: ENTITY } }, { chat: chat.fn });
      const cited = await engine.executeRaw<{ page_slug: string | null; item_id: string | number | null; kind: string }>(
        'SELECT page_slug, item_id, kind FROM question_evidence WHERE question_id IN (SELECT id FROM pinned_questions WHERE source_id = $1)', [s.sourceId]);
      expect(cited.map(r => r.page_slug)).not.toContain('notes/widget-scrape');
      expect(cited.map(r => r.page_slug)).not.toContain('notes/widget-plan');
      expect(cited.filter(r => r.kind === 'fact').map(r => Number(r.item_id))).not.toContain(s.factId);
      expect(scoped.receipt.answer!.some(x => x.text.includes('widget sale'))).toBe(true);
      for (const banned of ['notes/widget-scrape', 'notes/widget-plan', '40 employees']) expect(chat.calls.join('\n')).not.toContain(banned);
    });

    run('the first answer is a bounded wait: a slow model leaves awaiting_refresh and releases the lease', async (engine) => {
      const s = await seedBrain(engine);
      const chat = stubChat();
      chat.gate = new Promise(() => {});
      const slowFn: typeof chat.fn = (req) => Promise.race([chat.fn(req), new Promise<never>((_, rej) => req.signal?.addEventListener('abort', () => rej(new Error('aborted'))))]);
      const out = await pinQuestion(localCtx(engine, s.sourceId), { question: QUESTION, scope: { entity: ENTITY }, wait_ms: 200 }, { chat: slowFn });
      expect(out.receipt).toMatchObject({ freshness: 'awaiting_refresh', refresh: { status: 'timeout' } });
      expect(out.receipt.fix?.mcp?.tool).toBe('questions_refresh');
      expect((await getPin(engine, s.sourceId, out.receipt.slug))!.lease_token).toBeNull();
    });
  });

  describe(`${label}: blocked states carry the next step`, () => {
    run('keyless: the pin is kept, awaiting_refresh, blocked no_model_key with the key fix', async (engine) => {
      const s = await seedBrain(engine);
      await withEnv({ ANTHROPIC_API_KEY: undefined, GBRAIN_HOME: mkdtempSync(join(tmpdir(), 'pq-keyless-')) }, async () => {
        const out = await pinQuestion(localCtx(engine, s.sourceId), { question: QUESTION, scope: { entity: ENTITY } });
        expect(out.receipt).toMatchObject({ state: 'active', freshness: 'awaiting_refresh', blocked_reason: 'no_model_key', refresh: { status: 'blocked', blocked_reason: 'no_model_key' } });
        expect(out.receipt.fix).toMatchObject({ argv: ['gbrain', 'providers', 'list'], actor: 'user', consent: ['credentials', 'paid'] });
        expect(out.receipt.fix?.verify?.mcp).toEqual({ tool: 'questions_status', arguments: { id: out.receipt.id } });
      });
    });

    run('a spent budget blocks the refresh before any model call', async (engine) => {
      const s = await seedBrain(engine);
      await engine.setConfig('cycle.standing_questions.budget_usd', '0.000001');
      try {
        const chat = stubChat();
        const out = await pin(engine, s, chat);
        expect(out.receipt).toMatchObject({ freshness: 'awaiting_refresh', blocked_reason: 'budget_exhausted' });
        expect(out.receipt.fix?.argv).toEqual(['gbrain', 'config', 'set', 'cycle.standing_questions.budget_usd', '<usd>']);
        expect(chat.calls).toHaveLength(0);
      } finally { await engine.executeRaw("DELETE FROM config WHERE key = 'cycle.standing_questions.budget_usd'"); }
    });

    run('no worker: a stale answer with nothing scheduled says so; the cycle phase refreshes it and clears it', async (engine) => {
      await engine.executeRaw("DELETE FROM config WHERE key = 'cycle.standing_questions.last_run_at'");
      const s = await seedBrain(engine);
      await withEnv({ GBRAIN_HOME: mkdtempSync(join(tmpdir(), 'pq-noworker-')) }, async () => {
        const pinned = await pin(engine, s);
        await putPage(engine, s.sourceId, 'notes/widget-plan', page('note', 'Widget plan', 'The widget plan ships in August.'), await revisionOf(engine, s.sourceId, 'notes/widget-plan'));
        const stale = await status(engine, s, pinned.receipt.id);
        expect(stale).toMatchObject({ freshness: 'stale', blocked_reason: 'no_worker' });
        expect(stale.fix?.why).toContain('autopilot');
        await engine.executeRaw("UPDATE pinned_questions SET cooldown_days = 0 WHERE source_id = $1", [s.sourceId]);
        const phase = await runPhaseStandingQuestions(engine, { dryRun: false, chat: stubChat().fn });
        expect((phase.details as { refreshed: number }).refreshed).toBeGreaterThanOrEqual(1);
        expect(await status(engine, s, pinned.receipt.id)).toMatchObject({ freshness: 'fresh', blocked_reason: null });
      });
    });

    run('the cycle phase honors max_per_cycle and never refreshes inactive pins', async (engine) => {
      const s = await seedBrain(engine);
      const ctx = localCtx(engine, s.sourceId);
      for (const q of ['Who leads acme-example?', 'Where are acme-example widgets built?', 'When does the widget plan ship?']) {
        await pinQuestion(ctx, { question: q, defer: true }, { chat: stubChat().fn });
      }
      await engine.executeRaw(`UPDATE pinned_questions SET state = 'inactive', inactive_reason = 'awaiting_consent' WHERE source_id = $1 AND question LIKE 'When%'`, [s.sourceId]);
      await engine.executeRaw(`UPDATE pinned_questions SET state = 'archived' WHERE source_id <> $1`, [s.sourceId]);
      await engine.setConfig('cycle.standing_questions.max_per_cycle', '1');
      try {
        const chat = stubChat();
        const phase = await runPhaseStandingQuestions(engine, { dryRun: false, chat: chat.fn });
        expect(phase.details).toMatchObject({ candidates: 2, refreshed: 1 });
        expect(chat.calls).toHaveLength(1);
      } finally { await engine.executeRaw("DELETE FROM config WHERE key = 'cycle.standing_questions.max_per_cycle'"); }
    });
  });

  describe(`${label}: operator journeys over MCP`, () => {
    const preapprovedHome = () => {
      const home = mkdtempSync(join(tmpdir(), 'pq-home-'));
      mkdirSync(join(home, '.gbrain'), { recursive: true });
      writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', consent: { preapprove: { paid: { max_usd_per_run: 2 } } } }));
      return home;
    };

    run('MCP-only: pin under a paid preapproval, then refresh, with no shell', async (engine) => {
      const s = await seedBrain(engine);
      await setRemotePrivate(engine, true);
      const calls = { calls: 0, fail: false };
      __setChatTransportForTests(stubTransport(calls));
      try {
        await withEnv({ GBRAIN_HOME: preapprovedHome() }, async () => {
          const grant = { scopes: ['read', 'write'], sourceId: s.sourceId };
          const pinned = (await mcp(engine, 'questions_pin', { question: QUESTION, scope: { entity: ENTITY } }, grant)).body as unknown as Pinned;
          expect(pinned.receipt).toMatchObject({ state: 'active', freshness: 'fresh', page_materialized: false });
          expect(calls.calls).toBe(1);
          await putPage(engine, s.sourceId, 'notes/widget-plan', page('note', 'Widget plan', 'The widget plan ships in September.'), await revisionOf(engine, s.sourceId, 'notes/widget-plan'));
          const stale = await mcp(engine, 'questions_status', { id: pinned.receipt.id }, grant);
          expect(stale.body).toMatchObject({ freshness: 'stale' });
          const refreshed = await mcp(engine, 'questions_refresh', { id: pinned.receipt.id }, grant);
          expect(refreshed.body).toMatchObject({ freshness: 'fresh', refresh: { status: 'published' } });
          const pack = await mcp(engine, 'context_pack', { entities: ENTITY }, grant);
          expect((pack.body.pinned_questions as Array<{ id: string }>)?.[0]?.id).toBe(pinned.receipt.id);
        });
      } finally {
        __setChatTransportForTests(null);
        await setRemotePrivate(engine, false);
      }
    });

    run('a read-only connection lists and reads but cannot mutate', async (engine) => {
      const s = await seedBrain(engine);
      const pinned = await pin(engine, s);
      await setRemotePrivate(engine, true);
      try {
        const grant = { scopes: ['read'], sourceId: s.sourceId };
        const listed = await mcp(engine, 'questions_list', {}, grant);
        expect(listed.result.isError).toBeFalsy();
        expect((listed.body.questions as QuestionReceipt[]).map(q => q.id)).toEqual([pinned.receipt.id]);
        expect((listed.body.counts as Record<string, number>).total).toBe(1);
        expect((await mcp(engine, 'questions_status', { id: pinned.receipt.id }, grant)).body).toMatchObject({ freshness: 'fresh' });
        for (const op of ['questions_pin', 'questions_refresh', 'questions_unpin']) expect(operationScopesAllowed(['read'], operationsByName[op]!)).toBe(false);
        for (const op of ['questions_list', 'questions_status']) expect(operationScopesAllowed(['read'], operationsByName[op]!)).toBe(true);
      } finally { await setRemotePrivate(engine, false); }
    });

    run('a failed refresh is recovered over MCP by running its fix', async (engine) => {
      const s = await seedBrain(engine);
      const pinned = await pin(engine, s);
      await setRemotePrivate(engine, true);
      const calls = { calls: 0, fail: true };
      __setChatTransportForTests(stubTransport(calls));
      try {
        const grant = { scopes: ['read', 'write'], sourceId: s.sourceId };
        await putPage(engine, s.sourceId, 'notes/widget-plan', page('note', 'Widget plan', 'The widget plan ships in October.'), await revisionOf(engine, s.sourceId, 'notes/widget-plan'));
        const failed = (await mcp(engine, 'questions_refresh', { id: pinned.receipt.id }, grant)).body as unknown as QuestionReceipt;
        expect(failed).toMatchObject({ blocked_reason: 'refresh_failed', freshness: 'stale' });
        calls.fail = false;
        const next = failed.fix!.mcp!;
        const recovered = (await mcp(engine, next.tool, next.arguments, grant)).body as unknown as QuestionReceipt;
        expect(recovered).toMatchObject({ freshness: 'fresh', blocked_reason: null, refresh: { status: 'published', mode: 'full' } });
      } finally {
        __setChatTransportForTests(null);
        await setRemotePrivate(engine, false);
      }
    });
  });

  describe(`${label}: dream.auto_think migration`, () => {
    const keys = ['dream.auto_think.enabled', 'dream.auto_think.questions', 'dream.auto_think.max_per_cycle', 'dream.auto_think.auto_commit',
      'dream.auto_think.budget', 'dream.auto_think.cooldown_days', 'dream.auto_think.model', 'models.auto_think', 'dream.auto_think.allow_unpriced',
      'cycle.standing_questions.max_per_cycle', 'cycle.standing_questions.budget_usd', 'cycle.standing_questions.allow_unpriced'];
    const reset = async (engine: BrainEngine) => {
      for (const k of keys) await engine.executeRaw('DELETE FROM config WHERE key = $1', [k]);
      await engine.executeRaw(`DELETE FROM pinned_questions WHERE origin = 'auto_think'`);
    };
    const migrated = (engine: BrainEngine) => engine.executeRaw<{ question: string; state: string; inactive_reason: string | null; publish_mode: string; model: string | null; cooldown_days: number }>(
      `SELECT question, state, inactive_reason, publish_mode, model, cooldown_days FROM pinned_questions WHERE origin = 'auto_think' ORDER BY question`);

    run('maps all seven keys without creating consent, makes no model call, and is idempotent', async (engine) => {
      const calls = { calls: 0, fail: false };
      __setChatTransportForTests(stubTransport(calls));
      try {
        await reset(engine);
        await engine.setConfig('dream.auto_think.questions', JSON.stringify(['Who leads acme-example?', 'who leads   acme-example?', 'Who leads acme-example?', 'What changed this week?']));
        await engine.setConfig('dream.auto_think.enabled', 'false');
        await engine.setConfig('dream.auto_think.budget', '3.5');
        await engine.setConfig('dream.auto_think.cooldown_days', '7');
        await engine.setConfig('dream.auto_think.max_per_cycle', '2');
        await engine.setConfig('models.auto_think', 'anthropic:claude-opus-4-7');
        await engine.setConfig('dream.auto_think.allow_unpriced', 'true');
        const report = await migrateAutoThinkToPins(engine);
        expect(report).toMatchObject({ questions: 2, inserted: 2, state: 'inactive', publish_mode: 'draft' });
        const rows = await migrated(engine);
        expect(rows.map(r => r.question)).toEqual(['What changed this week?', 'Who leads acme-example?']);
        expect(rows.every(r => r.state === 'inactive' && r.inactive_reason === 'migrated_disabled' && r.publish_mode === 'draft'
          && r.model === 'anthropic:claude-opus-4-7' && Number(r.cooldown_days) === 7)).toBe(true);
        expect(await engine.getConfig('cycle.standing_questions.max_per_cycle')).toBe('2');
        expect(await engine.getConfig('cycle.standing_questions.budget_usd')).toBe('3.5');
        expect(await engine.getConfig('cycle.standing_questions.allow_unpriced')).toBe('true');
        expect((await migrateAutoThinkToPins(engine)).inserted).toBe(0);
        expect(await migrated(engine)).toHaveLength(2);
        expect(calls.calls).toBe(0);
        const chat = stubChat();
        await runPhaseStandingQuestions(engine, { dryRun: false, chat: chat.fn });
        expect(chat.calls.filter(c => c.includes('What changed this week?'))).toHaveLength(0);
      } finally { __setChatTransportForTests(null); await reset(engine); }
    });

    run('enabled with a zero budget imports inactive; enabled with auto_commit imports inactive and published', async (engine) => {
      try {
        await reset(engine);
        await engine.setConfig('dream.auto_think.questions', JSON.stringify(['Who leads acme-example?']));
        await engine.setConfig('dream.auto_think.enabled', 'true');
        await engine.setConfig('dream.auto_think.budget', '0');
        expect(await migrateAutoThinkToPins(engine)).toMatchObject({ state: 'inactive' });
        expect((await migrated(engine))[0]).toMatchObject({ inactive_reason: 'migrated_zero_budget' });
        expect(await engine.getConfig('cycle.standing_questions.budget_usd')).toBeNull();
        await reset(engine);
        await engine.setConfig('dream.auto_think.questions', JSON.stringify(['Who leads acme-example?']));
        await engine.setConfig('dream.auto_think.enabled', 'true');
        await engine.setConfig('dream.auto_think.auto_commit', 'true');
        expect(await migrateAutoThinkToPins(engine)).toMatchObject({ state: 'inactive', publish_mode: 'publish' });
        expect((await migrated(engine))[0]).toMatchObject({ state: 'inactive', publish_mode: 'publish', inactive_reason: 'migrated_enabled', cooldown_days: 30 });
        expect(questionSlug('Who leads acme-example?', { source: 'default' })).toMatch(/^questions\/who-leads-acme-example-[0-9a-f]{8}$/);
      } finally { await reset(engine); }
    });

    run('an enabled auto_think imports inactive pins that standing_questions skips until the owner activates one', async (engine) => {
      const question = 'Which widgets did acme-example ship this quarter?';
      try {
        await reset(engine);
        await engine.setConfig('dream.auto_think.questions', JSON.stringify([question]));
        await engine.setConfig('dream.auto_think.enabled', 'true');
        await engine.setConfig('dream.auto_think.budget', '2.5');
        expect(await migrateAutoThinkToPins(engine)).toMatchObject({ inserted: 1, state: 'inactive' });
        expect((await migrated(engine))[0]).toMatchObject({ state: 'inactive', inactive_reason: 'migrated_enabled' });
        expect(await engine.getConfig('cycle.standing_questions.budget_usd')).toBe('2.5');
        const id = `default:${questionSlug(question, { source: 'default' })}`;
        const status = await questionStatus(localCtx(engine, 'default'), { id });
        expect(status).toMatchObject({ state: 'inactive', blocked_reason: 'awaiting_consent', fix: { argv: ['gbrain', 'questions', 'pin', '--id', id] } });

        const before = stubChat();
        const idle = await runPhaseStandingQuestions(engine, { dryRun: false, chat: before.fn });
        expect(before.calls.filter(c => c.includes(question))).toHaveLength(0);
        expect((idle.details as { outcomes: Array<{ id: string }> }).outcomes.map(o => o.id)).not.toContain(id);

        const activated = await pinQuestion(localCtx(engine, 'default'), { id, defer: true });
        expect(activated).toMatchObject({ created: false, activated: true, receipt: { state: 'active' } });
        const after = stubChat();
        const ran = await runPhaseStandingQuestions(engine, { dryRun: false, chat: after.fn });
        expect((ran.details as { outcomes: Array<{ id: string }> }).outcomes.map(o => o.id)).toContain(id);
        expect(after.calls.filter(c => c.includes(question)).length).toBeGreaterThan(0);
      } finally { await reset(engine); }
    });
  });
}
