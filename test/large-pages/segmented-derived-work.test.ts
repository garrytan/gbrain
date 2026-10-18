/**
 * Wave B derived work on segmented pages (pages.segmented_storage on): the
 * Life Chronicle decision and execution, the remote `links` effect and the
 * facts backstop meet pages whose body fields throw `page_body_segmented`.
 *
 * 1. Protects: a coordinated publication of a chronicle-shaped segmented page
 *    commits with a pending chronicle decision; the unmanaged discovery never
 *    reads a segmented page as `too_short` (which would retire its events);
 *    execution judges a segmented page within the single-string ceiling and,
 *    since PR 2 (lane 2e, full-pass mode), one above it too, from its lead
 *    (segmented-real-size.slow.test.ts, at that size);
 *    backfill counts segmented pages as eligible; a remote write's `links`
 *    effect on a segmented page commits its mention edges, read block by
 *    block; the facts backstop queues for a segmented page and a facts-absorb
 *    job extracts it from its segments (the head, then the appended tail); a
 *    trusted put_page (auto_link on) publishes a segmented page with its derived
 *    links and temporal evidence, edit_page edits one, and a put_page that
 *    shrinks one to inline versions the segmented body before demoting it;
 *    a segmented create is projected once at a time (#6143: the resident
 *    drain waits for the publication's own projection instead of chunking
 *    the same page beside it);
 *    re-linking one later (autoLinkWrittenPage, `extract --slugs`) reads its
 *    body; the managed stale-links pass after a managed import links a
 *    segmented page within the ceiling and one over it.
 * 2. Fails when: any of these paths reads `compiled_truth` of a segmented page
 *    object, sees its NULL column as an empty body, or skips a page over the
 *    single-string ceiling instead of reading its segments.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { submissionAuthority } from '../../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite } from '../../src/core/persistence/journal.ts';
import { localHostId, registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { preparePageMutation } from '../../src/core/persistence/page-prepare.ts';
import { publishMutation } from '../../src/core/persistence/coordinator.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { decideChronicle } from '../../src/core/chronicle/ledger.ts';
import { upsertChronicleRow } from '../../src/core/chronicle/ledger.ts';
import { runChronicleBackfill } from '../../src/core/chronicle/backfill.ts';
import { runPhaseChronicle } from '../../src/core/cycle/chronicle.ts';
import { makeFactsAbsorbHandler } from '../../src/core/minions/handlers/facts-absorb.ts';
import { __setChatTransportForTests, resetGateway, type ChatOpts, type ChatResult } from '../../src/core/ai/gateway.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';
import { conversationBody } from '../helpers/conversation-page.ts';
import { SEGMENTED_CREATE_SEAL_MAX_BYTES } from '../../src/core/page-body/limits.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { withVerifiedLocalRegistration } from '../../src/core/persistence/identity.ts';
import { extractManagedStaleLinks } from '../../src/core/persistence/links-maintenance.ts';
import { autoLinkWrittenPage } from '../../src/core/ops/pages.ts';
import { importManagedFile } from '../../src/core/persistence/import-mutations.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';

const config = { engine: 'pglite' as const, embedding_disabled: true };
const CLIENT = 'client-segmented-derived';
const today = new Date().toISOString().slice(0, 10);
const body = conversationBody(1_200_000, { seed: 61 });
const meeting = (title: string) => `---\ntype: meeting\ntitle: ${title}\ndate: ${today}\n---\n\n${body}\n`;
const linkedMeeting = (title: string, extra = '') => `---\ntype: meeting\ntitle: ${title}\ndate: ${today}\n---\n\nMet [[people/alice-example]], who works at [[companies/acme-example]].\n\n${body}\n${extra}`;
const note = (title: string) => `---\ntype: note\ntitle: ${title}\n---\n\nSee [[people/alice-example]].\n\n${body}\n`;
const home = mkdtempSync(join(tmpdir(), 'gbrain-segmented-derived-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);

afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
    await closePostgres?.();
  });
  rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const engine of engines) {
    await engine.executeRaw('DELETE FROM chronicle_page_state');
    await engine.executeRaw('DELETE FROM persistence_effects');
    await engine.executeRaw('DELETE FROM pages');
    await engine.setConfig('pages.segmented_storage', 'on');
    await engine.setConfig('chronicle.auto_settle_seconds', '0');
    await engine.setConfig('chronicle.activated_at', new Date(Date.now() - 60_000).toISOString());
  }
});

async function sourceIncarnation(engine: BrainEngine, sourceId = 'default'): Promise<string> {
  return (await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]))[0]!.incarnation;
}

/** One coordinated put_page through admission, preparation and publication; `remote` writes as an OAuth client. */
async function coordinatedPut(engine: BrainEngine, slug: string, content: string, remote = false) {
  return withEnv({ GBRAIN_HOME: home }, async () => {
    await registerLocalWriter(engine, 'cli');
    if (remote) {
      await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_secret_hash,client_name,scope,source_id)
        VALUES($1,'fixture-hash','segmented-client','read write','default') ON CONFLICT (client_id) DO NOTHING`, [CLIENT]);
    }
    const ctx: OperationContext = { engine, config, dryRun: false, remote, sourceId: 'default', logger: { info() {}, warn() {}, error() {} },
      ...(remote ? { auth: { token: 'fixture', clientId: CLIENT, principal: { kind: 'oauth_client', id: CLIENT }, scopes: ['read', 'write'], sourceId: 'default' } as OperationContext['auth'] } : {}) };
    const incarnation = await sourceIncarnation(engine);
    const authority = await submissionAuthority(ctx, 'put_page', 'default', incarnation, slug);
    await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default', sourceIncarnation: incarnation,
      slug, pageId: null, requestId: randomUUID(), callerIntent: { content }, intent: { content } });
    const row = (await claimNextWrite(engine, localHostId()))!;
    return publishMutation(engine, row, await preparePageMutation(engine, row, config));
  });
}

async function storage(engine: BrainEngine, slug: string): Promise<{ id: number; body_storage: string; content_hash: string }> {
  const [row] = await engine.executeRaw<{ id: number; body_storage: string; content_hash: string }>(
    "SELECT id, body_storage, content_hash FROM pages WHERE source_id='default' AND slug=$1", [slug]);
  return { ...row!, id: Number(row!.id) };
}

/** A trusted local tool call through the MCP dispatcher (admission, preparation, publication). */
async function localCall(engine: BrainEngine, name: string, params: Record<string, unknown>): Promise<{ isError: boolean; body: Record<string, unknown> }> {
  return withEnv({ GBRAIN_HOME: home }, async () => {
    const registration = await registerLocalWriter(engine, 'cli');
    const response = await withVerifiedLocalRegistration(engine, registration, () => dispatchToolCall(engine, name, params,
      { remote: false, config: { engine: engine.kind }, sourceId: 'default', logger: { info() {}, warn() {}, error() {} } } as never));
    return { isError: response.isError === true, body: JSON.parse((response.content[0] as { text: string }).text) };
  });
}

async function linkTargets(engine: BrainEngine) {
  for (const [slug, type] of [['people/alice-example', 'person'], ['companies/acme-example', 'company']] as const) {
    await engine.putPage(slug, { type, title: slug, compiled_truth: `${slug} fixture.`, timeline: '', frontmatter: {} }, { sourceId: 'default' });
  }
}

const ledger = (engine: BrainEngine) => engine.executeRaw<{ slug: string; state: string; reason: string | null; scheduled: boolean }>(
  'SELECT slug, state, reason, next_attempt_at IS NOT NULL AS scheduled FROM chronicle_page_state ORDER BY slug, decided_at');

describe('Life Chronicle on segmented pages', () => {
  test('a coordinated put_page of a chronicle-shaped segmented page commits with a pending decision', async () => {
    for (const engine of engines) {
      // A trusted write with auto_link off and a remote write both reach the in-transaction chronicle decision.
      await engine.setConfig('auto_link', 'false');
      try {
        for (const [slug, remote] of [['meetings/segmented-daily', false], ['meetings/segmented-weekly', true]] as const) {
          const committed = await coordinatedPut(engine, slug, meeting(slug), remote);
          expect({ state: committed.state, error: committed.error_code }).toEqual({ state: 'committed', error: null });
          expect((await storage(engine, slug)).body_storage).toBe('segmented');
          expect(committed.outcome?.chronicle_backstop).toMatchObject({ pending: 'next_cycle' });
        }
      } finally { await engine.unsetConfig('auto_link'); }
      expect(await ledger(engine)).toEqual([
        { slug: 'meetings/segmented-daily', state: 'pending', reason: null, scheduled: true },
        { slug: 'meetings/segmented-weekly', state: 'pending', reason: null, scheduled: true }]);
    }
  }, 300_000);

  test('the write decision keeps a segmented page over the single-string ceiling pending, never page_body_segmented or too_short', () => {
    const settings = { recentDays: 30, settleSeconds: 0 };
    const page = { type: 'meeting', slug: 'meetings/huge', frontmatter: { date: today }, body_storage: 'segmented' as const };
    const now = new Date();
    const over = decideChronicle({ page: { ...page, body_bytes: PAGE_MAX_BYTES + 1, compiled_truth: 'x'.repeat(200) }, authority: null,
      noExtract: false, enabled: true, settings, now });
    expect(over).toEqual({ state: 'pending', reason: null, nextAttemptAt: now });
  });

  test('unmanaged discovery decides a segmented page from its truth lead and the phase judges its materialized body', async () => {
    for (const engine of engines) {
      await importFromContent(engine, 'meetings/segmented-standup', meeting('Standup'), { sourceId: 'default', noEmbed: true });
      const page = await storage(engine, 'meetings/segmented-standup');
      expect(page.body_storage).toBe('segmented');
      // An earlier revision produced events: a too_short decision would schedule their retirement.
      await upsertChronicleRow(engine, { sourceId: 'default', pageId: page.id, contentHash: 'earlier-revision', slug: 'meetings/segmented-standup',
        state: 'pending', reason: null, trigger: 'auto', nextAttemptAt: null });
      await engine.executeRaw(`UPDATE chronicle_page_state SET state='extracted', event_hashes=ARRAY['h1'], event_slugs=ARRAY['life/events/e1']
        WHERE content_hash='earlier-revision'`);
      const judged: string[] = [];
      const run = await runPhaseChronicle(engine, { judge: async (input) => { judged.push(input.body); return { events: [] }; } });
      expect(run.details.reasons).not.toHaveProperty('too_short');
      expect(judged).toHaveLength(1);
      expect(judged[0]!.slice(0, 200)).toBe(body.slice(0, 200));
      const rows = await engine.executeRaw<{ state: string; reason: string | null }>(
        'SELECT state, reason FROM chronicle_page_state WHERE content_hash=$1', [page.content_hash]);
      expect(rows).toEqual([{ state: 'extracted', reason: 'no_events' }]);
    }
  }, 300_000);

  test('backfill counts a segmented chronicle page as eligible', async () => {
    for (const engine of engines) {
      await importFromContent(engine, 'meetings/segmented-review', meeting('Review'), { sourceId: 'default', noEmbed: true });
      const result = await runChronicleBackfill(engine, { dryRun: true, sourceId: 'default' });
      expect(result.skipped).not.toHaveProperty('too_short');
      expect(result.eligible).toBe(1);
    }
  }, 300_000);
});

describe('page-write effects on segmented pages', () => {
  test('a remote write of a segmented page commits its links effect from the segmented body', async () => {
    for (const engine of engines) {
      await linkTargets(engine);
      const committed = await coordinatedPut(engine, 'notes/segmented-remote', note('Remote'), true);
      expect(committed.state).toBe('committed');
      expect((await storage(engine, 'notes/segmented-remote')).body_storage).toBe('segmented');
      // The write queues embedding, facts-backstop and links effects; one pass runs them all.
      await withEnv({ GBRAIN_HOME: home }, () => runPersistenceEffects(engine, config, { hostId: localHostId(), limit: 10 }));
      const effects = await engine.executeRaw<{ state: string; error_code: string | null; outcome: Record<string, unknown> | null }>(
        "SELECT state, error_code, outcome FROM persistence_effects WHERE request_id=$1::uuid AND kind='links'", [committed.id]);
      expect(effects).toEqual([{ state: 'committed', error_code: null, outcome: { links: 'committed', added: 1, removed: 0, skipped_targets: [] } }]);
    }
  }, 300_000);

  test('a write of a segmented page queues the facts backstop as a facts-backstop effect', async () => {
    for (const engine of engines) {
      await engine.setConfig('facts.extraction_enabled', 'true');
      const committed = await coordinatedPut(engine, 'notes/segmented-facts', note('Facts'), true);
      expect(committed.state).toBe('committed');
      expect(committed.outcome?.facts_backstop).toEqual({ queued: true });
      expect(await engine.executeRaw("SELECT kind FROM persistence_effects WHERE request_id=$1::uuid AND kind='facts-backstop'", [committed.id]))
        .toEqual([{ kind: 'facts-backstop' }]);
    }
  }, 300_000);

  test('a facts-absorb job extracts a segmented page from its head, then from the text appended since', async () => {
    const prompts: string[] = [];
    __setChatTransportForTests(async (opts: ChatOpts): Promise<ChatResult> => {
      prompts.push(JSON.stringify(opts.messages));
      return { text: '{"facts":[]}', blocks: [], stopReason: 'end', model: 'test:stub', providerId: 'test',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 } };
    });
    try {
      for (const engine of engines) {
        prompts.length = 0;
        await engine.setConfig('facts.extraction_enabled', 'true');
        await importFromContent(engine, 'notes/segmented-absorb', note('Absorb'), { sourceId: 'default', noEmbed: true });
        expect((await storage(engine, 'notes/segmented-absorb')).body_storage).toBe('segmented');
        const run = () => withEnv({ GBRAIN_HOME: home }, () => makeFactsAbsorbHandler(engine)({ id: 1, name: 'facts-absorb', signal: new AbortController().signal,
          data: { slug: 'notes/segmented-absorb', sourceId: 'default', source: 'sync:import' } } as never));
        const first = await run();
        expect(first).not.toHaveProperty('skipped');
        expect(prompts.some(p => p.includes('See [[people/alice-example]]'))).toBe(true);
        prompts.length = 0;
        await importFromContent(engine, 'notes/segmented-absorb', `${note('Absorb')}\nAppended note: zebra-appended-marker reviewed the launch.\n`, { sourceId: 'default', noEmbed: true });
        expect((await storage(engine, 'notes/segmented-absorb')).body_storage).toBe('segmented');
        await run();
        expect(prompts.some(p => p.includes('zebra-appended-marker'))).toBe(true);
        expect(prompts.some(p => p.includes('See [[people/alice-example]]'))).toBe(false);
      }
    } finally {
      __setChatTransportForTests(null);
      resetGateway();
    }
  }, 300_000);
});

describe('trusted coordinated writes of segmented pages', () => {
  test('a trusted put_page with auto_link on (the default) publishes the segmented page and its derived links', async () => {
    for (const engine of engines) {
      await linkTargets(engine);
      const committed = await coordinatedPut(engine, 'meetings/segmented-linked', linkedMeeting('Linked'));
      expect({ state: committed.state, error: committed.error_code }).toEqual({ state: 'committed', error: null });
      expect((await storage(engine, 'meetings/segmented-linked')).body_storage).toBe('segmented');
      expect(committed.outcome?.chronicle_backstop).toMatchObject({ pending: 'next_cycle' });
      const links = await engine.executeRaw<{ slug: string }>(`SELECT t.slug FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
        WHERE f.slug='meetings/segmented-linked' ORDER BY t.slug`);
      expect([...new Set(links.map(link => link.slug))]).toEqual(['companies/acme-example', 'people/alice-example']);
    }
  }, 300_000);

  test('edit_page on a segmented page publishes the edit', async () => {
    for (const engine of engines) {
      await linkTargets(engine);
      expect((await localCall(engine, 'put_page', { slug: 'meetings/segmented-edit', content: linkedMeeting('Edit', 'Closing note one.\n') })).isError).toBe(false);
      const { body: before } = await localCall(engine, 'get_page', { slug: 'meetings/segmented-edit', body: 'none' });
      const edited = await localCall(engine, 'edit_page', { slug: 'meetings/segmented-edit', expected_revision: before.revision,
        edits: [{ old_text: 'Closing note one.', new_text: 'Closing note two.' }] });
      expect({ isError: edited.isError, code: edited.body.code }).toEqual({ isError: false, code: undefined });
      expect((await storage(engine, 'meetings/segmented-edit')).body_storage).toBe('segmented');
      const { body: after } = await localCall(engine, 'get_page', { slug: 'meetings/segmented-edit', body: 'none' });
      expect(after.revision).not.toBe(before.revision);
    }
  }, 300_000);

  test('a put_page that shrinks a segmented page to inline commits and versions the segmented body first', async () => {
    for (const engine of engines) {
      await linkTargets(engine);
      expect((await localCall(engine, 'put_page', { slug: 'meetings/segmented-shrink', content: linkedMeeting('Shrink') })).isError).toBe(false);
      const { body: before } = await localCall(engine, 'get_page', { slug: 'meetings/segmented-shrink', body: 'none' });
      const shrunk = await localCall(engine, 'put_page', { slug: 'meetings/segmented-shrink', expected_revision: before.revision, allow_shrink: true,
        content: `---\ntype: meeting\ntitle: Shrink\ndate: ${today}\n---\n\nMet [[people/alice-example]] again, briefly.\n` });
      expect({ isError: shrunk.isError, code: shrunk.body.code }).toEqual({ isError: false, code: undefined });
      const page = await storage(engine, 'meetings/segmented-shrink');
      expect(page.body_storage).toBe('inline');
      expect(await engine.executeRaw('SELECT body_storage FROM page_versions WHERE page_id=$1 ORDER BY id', [page.id])).toEqual([{ body_storage: 'segmented' }]);
    }
  }, 300_000);

  test('a segmented create is projected once at a time: the resident drain waits for the publication\'s own projection (#6143)', async () => {
    const slug = 'meetings/segmented-single-flight';
    const concurrent: Record<string, number> = {}, pages: Record<string, unknown> = {};
    for (const engine of engines) {
      await linkTargets(engine);
      let inside = 0, most = 0, arrivals = 0;
      // The first projection of the page to stage its chunks holds its seal open for a while: a second projection of the
      // same page running beside it (the resident drain picking up the queued job) reaches the same point meanwhile.
      installFaultHook(async (point, detail) => {
        if (point !== 'segmented:projection_staged' || detail.slug !== slug) return;
        inside++; arrivals++; most = Math.max(most, inside);
        if (arrivals === 1) for (const until = Date.now() + 1500; inside < 2 && Date.now() < until;) await new Promise(resolve => setTimeout(resolve, 20));
        inside--;
      });
      try {
        // Over SEGMENTED_CREATE_SEAL_MAX_BYTES, so the create commits unsealed and its chunks are built after commit.
        const content = linkedMeeting('Single flight', conversationBody(SEGMENTED_CREATE_SEAL_MAX_BYTES, { seed: 62 }));
        expect((await localCall(engine, 'put_page', { slug, content, wait_ms: 30_000 })).isError).toBe(false);
        for (const until = Date.now() + 120_000; Date.now() < until;) {
          const [row] = await engine.executeRaw<{ sealed: boolean }>(`SELECT text_projection_revision=knowledge_revision AS sealed FROM pages
            WHERE source_id='default' AND slug=$1`, [slug]);
          if (row?.sealed) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } finally { installFaultHook(undefined); }
      concurrent[engine.kind] = most;
      pages[engine.kind] = await engine.executeRaw(`SELECT body_storage, text_projection_revision=knowledge_revision AS sealed FROM pages
        WHERE source_id='default' AND slug=$1`, [slug]);
    }
    expect(concurrent).toEqual(Object.fromEntries(engines.map(engine => [engine.kind, 1])));
    expect(pages).toEqual(Object.fromEntries(engines.map(engine => [engine.kind, [{ body_storage: 'segmented', sealed: true }]])));
  }, 300_000);

  test('re-linking a segmented page later (autoLinkWrittenPage, extract --slugs) reads its body', async () => {
    for (const engine of engines) {
      await linkTargets(engine);
      await engine.setConfig('auto_link', 'false');
      try {
        await importFromContent(engine, 'notes/segmented-relink', `${note('Relink')}\n## Timeline\n\n- **2026-09-14** | Met Alice.\n`, { sourceId: 'default', noEmbed: true });
      } finally { await engine.unsetConfig('auto_link'); }
      const page = await storage(engine, 'notes/segmented-relink');
      expect(page.body_storage).toBe('segmented');
      const links = () => engine.executeRaw<{ slug: string }>(`SELECT t.slug FROM links l JOIN pages t ON t.id=l.to_page_id WHERE l.from_page_id=$1`, [page.id]);
      expect(await links()).toEqual([]);
      await autoLinkWrittenPage(engine, 'notes/segmented-relink', { sourceId: 'default' });
      expect(await links()).toEqual([{ slug: 'people/alice-example' }]);
      await engine.executeRaw('DELETE FROM timeline_entries WHERE page_id=$1', [page.id]);
      const extracted = await extractManagedStaleLinks(engine, { sourceId: 'default', slugs: ['notes/segmented-relink'], mentions: false });
      expect(extracted.timeline).toBe(1);
    }
  }, 300_000);

  test('the managed stale-links pass links a segmented page within the ceiling and one over it', async () => {
    for (const engine of engines) {
      await linkTargets(engine);
      const sourceId = `segmented-${randomUUID().slice(0, 8)}`;
      const root = join(home, sourceId);
      mkdirSync(join(root, 'notes'), { recursive: true });
      const linked = (bytes: number) => `---\ntype: note\ntitle: Managed\n---\n\nSee [[people/alice-example]].\n\n${conversationBody(bytes, { seed: 62 })}\n`;
      await withEnv({ GBRAIN_HOME: home }, async () => {
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.putPage('people/alice-example', { type: 'person', title: 'Alice', compiled_truth: 'Alice fixture.', timeline: '', frontmatter: {} }, { sourceId });
        await registerLocalWriter(engine, 'cli');
        await claimWorktree(engine, sourceId, root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        try {
          for (const [file, bytes] of [['notes/within.md', 1_200_000], ['notes/over.md', PAGE_MAX_BYTES + 1024 * 1024]] as const) {
            writeFileSync(join(root, file), linked(bytes));
            expect(await importManagedFile(engine, join(root, file), file, { sourceId, noEmbed: true })).toMatchObject({ status: 'imported' });
          }
          // The cycle's extract phase passes the slugs a sync changed (cycle.ts → runExtractCore → extractManagedStaleLinks).
          const result = await extractManagedStaleLinks(engine, { sourceId, slugs: ['notes/within', 'notes/over'], mentions: false });
          expect(result.skipped).toBe(0);
          const links = await engine.executeRaw<{ slug: string }>(`SELECT f.slug FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
            WHERE f.source_id=$1 AND t.slug='people/alice-example' ORDER BY f.slug`, [sourceId]);
          expect(links).toEqual([{ slug: 'notes/over' }, { slug: 'notes/within' }]);
        } finally {
          await disposePersistenceConsumer(engine);
          await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        }
      });
    }
  }, 600_000);

  test('the stale pass projects the dated rows of a page over the ceiling, and a smaller re-import without one bullet retracts its row', async () => {
    for (const engine of engines) {
      const sourceId = `segmented-${randomUUID().slice(0, 8)}`;
      const root = join(home, sourceId);
      mkdirSync(join(root, 'notes'), { recursive: true });
      const dated = (bytes: number, bullets: string[]) =>
        `---\ntype: note\ntitle: Dated\n---\n\n${conversationBody(bytes, { seed: 63 })}\n\n## Timeline\n\n${bullets.join('\n')}\n`;
      await withEnv({ GBRAIN_HOME: home }, async () => {
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await registerLocalWriter(engine, 'cli');
        await claimWorktree(engine, sourceId, root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        try {
          const file = join(root, 'notes/dated.md');
          const rows = () => engine.executeRaw<{ date: string; summary: string }>(`SELECT to_char(t.date,'YYYY-MM-DD') AS date, t.summary FROM timeline_entries t
            JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1 AND p.slug='notes/dated' AND t.event_page_id IS NULL ORDER BY t.date`, [sourceId]);
          writeFileSync(file, dated(PAGE_MAX_BYTES + 1024 * 1024, ['- **2026-03-04** | Kickoff', '- **2026-04-05** | Pricing review']));
          expect(await importManagedFile(engine, file, 'notes/dated.md', { sourceId, noEmbed: true })).toMatchObject({ status: 'imported' });
          // The streamed import projects no timeline; the stale pass adds the canonical rows it reads from the segments.
          expect((await extractManagedStaleLinks(engine, { sourceId, slugs: ['notes/dated'], mentions: false })).timeline).toBe(2);
          expect(await rows()).toEqual([{ date: '2026-03-04', summary: 'Kickoff' }, { date: '2026-04-05', summary: 'Pricing review' }]);
          const [stored] = await engine.executeRaw<{ body_storage: string; body_bytes: number }>(
            "SELECT body_storage, body_bytes FROM pages WHERE source_id=$1 AND slug='notes/dated'", [sourceId]);
          expect(stored!.body_storage).toBe('segmented');
          expect(Number(stored!.body_bytes)).toBeGreaterThan(PAGE_MAX_BYTES);
          // The prior body (over the ceiling, left unread) is read block by block to find the bullet this write removed.
          writeFileSync(file, dated(2_000_000, ['- **2026-03-04** | Kickoff']));
          expect(await importManagedFile(engine, file, 'notes/dated.md', { sourceId, noEmbed: true })).toMatchObject({ status: 'imported' });
          expect(await rows()).toEqual([{ date: '2026-03-04', summary: 'Kickoff' }]);
        } finally {
          await disposePersistenceConsumer(engine);
          await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        }
      });
    }
  }, 600_000);
});
