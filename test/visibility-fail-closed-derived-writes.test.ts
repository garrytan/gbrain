/**
 * Derived and retried writes never land broader than their source (fail closed).
 *
 * - Facts auto-extracted from a `visibility: private` page were stamped with the
 *   brain default; with `facts.default_visibility=world` they came out world, and
 *   a fact with no fence page was then returned to remote callers by recall and the
 *   entity card. They are private now, on the page-write backstop and on
 *   extract_facts with a private `source_slug`.
 * - `remember` with no visibility hard-defaulted to world: a reworded retry that
 *   dropped the parameter widened a private save. It now resolves private for a
 *   private target page or an explicit private brain default, and stays world
 *   otherwise (the v1 contract).
 * - A page marked private only by a privacy alias (`access`, `confidentiality`)
 *   counts as private for everything derived from it; remote page reads honor the
 *   aliases by default; `visibility.honor_aliases false` opts out.
 * - Connector re-renders keep a page's private label; Google private events render private.
 * - The doctor check lists what is already labelled wider than its source, and the
 *   visibility repair previews it and changes it only with --apply.
 *
 * PGLite and Postgres (DATABASE_URL); stub transports, zero model calls; synthetic names.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { runFactsBackstop } from '../src/core/facts/backstop.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { derivedVisibilityCheck } from '../src/commands/doctor/checks/derived-visibility.ts';
import { visibilityRepair } from '../src/core/repair/visibility.ts';
import { resolveRepairScope, runRepair } from '../src/core/repair/core.ts';
import { __resetPrivateVisibilityCacheForTests, effectiveVisibility, isDerivationPrivate } from '../src/core/search/private-visibility.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { renderCalendarEventPage, withPrivateVisibility } from '../src/core/google/google-render.ts';
import { importRendered } from '../src/core/google/sweep-shared.ts';
import type { CalendarEventData } from '../src/core/google/types.ts';
import { segmentedRememberRefusal } from '../src/core/persistence/verb-errors.ts';

const DIMS = 1536;
const PERSON = 'people/alice-example';
const PRIVATE_PERSON = 'people/dana-example';
const NOTE = 'notes/private-session-example';
const BODY = 'Alice Example shared the confidential acquisition terms of the example company during a private session. '.repeat(2);
const CLAIM = 'Alice Example shared the confidential acquisition terms';

const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
  for (const backend of testBackends()) {
    if (backend === 'pglite') {
      const engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
      engines.push(engine);
    } else {
      const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      engines.push(isolated.engine);
      closePostgres = isolated.close;
    }
  }
}, 120_000);
afterAll(async () => {
  __setChatTransportForTests(null); __setEmbedTransportForTests(null);
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  resetGateway();
});

function stubExtraction(fact: string) {
  __setChatTransportForTests(async (): Promise<ChatResult> => ({
    text: JSON.stringify({ facts: [{ fact, kind: 'fact', entity: PERSON, confidence: 1, notability: 'high' }] }),
    blocks: [], stopReason: 'end', usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'test:stub', providerId: 'test' }));
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({
    embeddings: values.map(() => Array.from({ length: DIMS }, (_, i) => (i === 0 ? 1 : 0))) })) as never);
}

const ctxFor = (engine: BrainEngine, sourceId: string, remote: boolean) => ({ engine, config: { engine: engine.kind }, remote, sourceId, dryRun: false,
  logger: { info() {}, warn() {}, error() {} } }) as unknown as OperationContext;

/** A fresh source holding a world person page, a private person page and a private note mentioning the world person. */
async function source(engine: BrainEngine, managed: boolean) {
  const sourceId = `vis-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  await registerLocalWriter(engine, 'cli');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [managed]);
  const put = (slug: string, type: string, title: string, body: string, frontmatter: Record<string, unknown>) =>
    engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.putPage(slug, { type, title, compiled_truth: body, timeline: '', frontmatter }, { sourceId }), TEST_WRITE_ATTRIBUTION));
  await put(PERSON, 'person', 'Alice Example', 'Alice Example is a person.', {});
  await put(PRIVATE_PERSON, 'person', 'Dana Example', 'Dana Example is a person.', { visibility: 'private' });
  await put(NOTE, 'note', 'Session notes', BODY, { visibility: 'private' });
  return { sourceId, local: ctxFor(engine, sourceId, false), remote: ctxFor(engine, sourceId, true) };
}

async function factRows(engine: BrainEngine, sourceId: string) {
  return engine.executeRaw<{ id: number; fact: string; visibility: string }>('SELECT id,fact,visibility FROM facts WHERE source_id=$1 AND expired_at IS NULL ORDER BY id', [sourceId]);
}

/** What a remote (MCP) caller can read about the world person: recall's facts and the entity card's recent facts. */
async function remoteReadable(remote: OperationContext) {
  const recall = await operationsByName.recall!.handler(remote, { entity: PERSON }) as { facts: Array<{ fact: string }> };
  const card = await operationsByName.entity!.handler(remote, { name: PERSON }) as { card?: { recent_facts?: Array<{ fact: string }> } };
  return [...recall.facts.map(f => f.fact), ...(card.card?.recent_facts ?? []).map(f => f.fact)];
}

async function onEachEngine(body: (engine: BrainEngine) => Promise<void>) {
  for (const engine of engines) {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-visibility-'));
    try { await withEnv({ GBRAIN_HOME: home }, () => body(engine)); }
    finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw("DELETE FROM config WHERE key='facts.default_visibility'");
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(home, { recursive: true, force: true });
    }
  }
}

describe('facts extracted from a private page stay private', () => {
  test('page-write backstop on a world-default brain: the fact is private and remote callers cannot read it', async () => {
    await onEachEngine(async engine => {
      const s = await source(engine, false);
      await engine.setConfig('facts.default_visibility', 'world');
      stubExtraction(CLAIM);
      const result = await runFactsBackstop({ slug: NOTE, type: 'note', compiled_truth: BODY, frontmatter: { visibility: 'private' } },
        { engine, config: { engine: engine.kind } as never, sourceId: s.sourceId, sessionId: null, source: 'mcp:put_page', mode: 'inline', visibility: 'world' });
      expect((result as { inserted?: number }).inserted).toBe(1);
      expect((await factRows(engine, s.sourceId)).map(r => [r.fact, r.visibility])).toEqual([[CLAIM, 'private']]);
      expect(await remoteReadable(s.remote)).not.toContain(CLAIM);
      expect((await derivedVisibilityCheck(engine, s.sourceId)).details).toMatchObject({ world_facts_from_private_sources: 0 });
    });
  }, 120_000);

  test('a world page still yields world facts under a world default (no over-tightening)', async () => {
    await onEachEngine(async engine => {
      const s = await source(engine, false);
      await engine.setConfig('facts.default_visibility', 'world');
      stubExtraction(CLAIM);
      await runFactsBackstop({ slug: 'notes/open-example', type: 'note', compiled_truth: BODY, frontmatter: {} },
        { engine, config: { engine: engine.kind } as never, sourceId: s.sourceId, sessionId: null, source: 'mcp:put_page', mode: 'inline', visibility: 'world' });
      expect((await factRows(engine, s.sourceId)).map(r => r.visibility)).toEqual(['world']);
    });
  }, 120_000);

  test('extract_facts on a managed brain with a private source_slug writes private even when world was asked for', async () => {
    await onEachEngine(async engine => {
      const s = await source(engine, true);
      stubExtraction(CLAIM);
      const r = await operationsByName.extract_facts!.handler(s.local, { turn_text: BODY, visibility: 'world', source_slug: NOTE }) as { inserted: number };
      expect(r.inserted).toBe(1);
      expect((await factRows(engine, s.sourceId)).map(row => [row.fact, row.visibility])).toEqual([[CLAIM, 'private']]);
      expect(await remoteReadable(s.remote)).not.toContain(CLAIM);
    });
  }, 120_000);

  test('remote extract_facts: a private or unseen source_slug writes private alike; a world source keeps world', async () => {
    await onEachEngine(async engine => {
      const s = await source(engine, true);
      const extract = async (claim: string, source_slug: string) => {
        stubExtraction(claim);
        await operationsByName.extract_facts!.handler(s.remote, { turn_text: BODY, visibility: 'world', source_slug });
        return (await factRows(engine, s.sourceId)).find(r => r.fact === claim)?.visibility;
      };
      expect(await extract(CLAIM, NOTE)).toBe('private');
      expect(await extract('Alice Example joined the example board', 'notes/never-written-example')).toBe('private');
      expect(await extract('Alice Example moved to the example city', PERSON)).toBe('world');
      expect(await remoteReadable(s.remote)).not.toContain(CLAIM);
    });
  }, 120_000);
});

describe('remember without a visibility never widens', () => {
  const remember = (ctx: OperationContext, params: Record<string, unknown>) =>
    operationsByName.remember!.handler(ctx, { provenance: 'synthetic test', infer_entity: false, ...params }) as Promise<{ id: string; status: string }>;
  const visibilityOf = async (engine: BrainEngine, id: string) =>
    (await engine.executeRaw<{ visibility: string }>('SELECT visibility FROM facts WHERE id=$1', [Number(id)]))[0]?.visibility;

  test('onto a private entity page it saves private; an explicit world is honored; a world page keeps the world default', async () => {
    await onEachEngine(async engine => {
      const s = await source(engine, true);
      const onPrivate = await remember(s.local, { fact: 'Dana Example prefers morning meetings', entity: PRIVATE_PERSON });
      expect(await visibilityOf(engine, onPrivate.id)).toBe('private');
      const onWorld = await remember(s.local, { fact: 'Alice Example prefers morning meetings', entity: PERSON });
      expect(await visibilityOf(engine, onWorld.id)).toBe('world');
      const explicit = await remember(s.local, { fact: 'Dana Example uses a standing desk', entity: PRIVATE_PERSON, visibility: 'world' });
      expect(await visibilityOf(engine, explicit.id)).toBe('world');
    });
  }, 120_000);

  test('an explicit private brain default applies to remember; the same request_id replays the same private fact', async () => {
    await onEachEngine(async engine => {
      const s = await source(engine, true);
      await engine.setConfig('facts.default_visibility', 'private');
      const request_id = randomUUID();
      const first = await remember(s.local, { fact: 'Alice Example signed the renewal', entity: PERSON, request_id });
      expect(await visibilityOf(engine, first.id)).toBe('private');
      const replay = await remember(s.local, { fact: 'Alice Example signed the renewal', entity: PERSON, request_id });
      expect(replay.id).toBe(first.id);
      expect((await factRows(engine, s.sourceId)).filter(r => r.fact === 'Alice Example signed the renewal')).toHaveLength(1);
      expect(await remoteReadable(s.remote)).not.toContain('Alice Example signed the renewal');
    });
  }, 120_000);
});

describe('privacy aliases (access, confidentiality) count for everything derived', () => {
  const putAliased = (engine: BrainEngine, sourceId: string, slug: string, type: string, frontmatter: Record<string, unknown>, body = 'Synthetic body.') =>
    engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.putPage(slug, { type, title: slug, compiled_truth: body, timeline: '', frontmatter },
      { sourceId }), TEST_WRITE_ATTRIBUTION));

  test('the shared helper reads the alias values case-insensitively and nothing else', () => {
    for (const fm of [{ access: 'private' }, { access: ' Restricted ' }, { access: 'CONFIDENTIAL' }, { confidentiality: 'secret' }, { confidentiality: 'Private' }]) {
      expect(isDerivationPrivate({ type: 'meeting', frontmatter: fm })).toBe(true);
      expect(effectiveVisibility({ kind: 'page', page: { type: 'meeting', frontmatter: fm } })).toBe('private');
    }
    for (const fm of [{ access: 'work' }, { access: 'public' }, { confidentiality: 'internal' }, {}]) {
      expect(isDerivationPrivate({ type: 'meeting', frontmatter: fm })).toBe(false);
    }
  });

  test('remember onto an aliased entity page and extraction from an aliased page both write private', async () => {
    await onEachEngine(async engine => {
      const s = await source(engine, true);
      await putAliased(engine, s.sourceId, 'people/erin-example', 'person', { access: 'private', confidentiality: 'confidential' });
      const saved = await operationsByName.remember!.handler(s.local, { fact: 'Erin Example agreed to the term sheet', entity: 'people/erin-example',
        provenance: 'synthetic test', infer_entity: false }) as { id: string };
      expect((await engine.executeRaw<{ visibility: string }>('SELECT visibility FROM facts WHERE id=$1', [Number(saved.id)]))[0]!.visibility).toBe('private');
      await putAliased(engine, s.sourceId, 'meetings/session-example', 'meeting', { access: 'restricted' }, BODY);
      stubExtraction(CLAIM);
      await operationsByName.extract_facts!.handler(s.local, { turn_text: BODY, visibility: 'world', source_slug: 'meetings/session-example' });
      expect((await factRows(engine, s.sourceId)).find(r => r.fact === CLAIM)?.visibility).toBe('private');
    });
  }, 120_000);

  test('remote page reads hide alias-private pages by default; local reads are unchanged; honor_aliases false opts out', async () => {
    await onEachEngine(async engine => {
      const s = await source(engine, false);
      __resetPrivateVisibilityCacheForTests();
      await putAliased(engine, s.sourceId, 'meetings/aliased-example', 'meeting', { access: 'private' }, 'Zephyrquill synthetic agenda.');
      await putAliased(engine, s.sourceId, 'meetings/open-example', 'meeting', { access: 'public' }, 'Zephyrquill open agenda.');
      const read = (ctx: OperationContext, slug: string) => operationsByName.get_page!.handler(ctx, { slug }).then(() => true, () => false);
      const found = async (ctx: OperationContext) => {
        const listed = await operationsByName.list_pages!.handler(ctx, { type: 'meeting' }) as unknown;
        const rows = (Array.isArray(listed) ? listed : (listed as { pages: unknown[] }).pages) as Array<{ slug: string }>;
        return rows.map(row => row.slug).filter(slug => slug.startsWith('meetings/')).sort();
      };
      expect(await read(s.remote, 'meetings/aliased-example')).toBe(false);
      expect(await read(s.remote, 'meetings/open-example')).toBe(true);
      expect(await found(s.remote)).toEqual(['meetings/open-example']);
      expect(await read(s.local, 'meetings/aliased-example')).toBe(true);
      expect(await found(s.local)).toEqual(['meetings/aliased-example', 'meetings/open-example']);
      await engine.setConfig('visibility.honor_aliases', 'false');
      __resetPrivateVisibilityCacheForTests();
      try {
        expect(await read(s.remote, 'meetings/aliased-example')).toBe(true);
        expect(await found(s.remote)).toEqual(['meetings/aliased-example', 'meetings/open-example']);
      } finally { await engine.executeRaw("DELETE FROM config WHERE key='visibility.honor_aliases'"); __resetPrivateVisibilityCacheForTests(); }
      expect(await read(s.remote, 'meetings/aliased-example')).toBe(false);
    });
  }, 120_000);
});

describe('already-affected rows: listed by doctor, previewed by the repair, changed only with --apply', () => {
  test('aliased page, its world chronicle event and a world fact extracted from it', async () => {
    await onEachEngine(async engine => {
      const s = await source(engine, false);
      const meeting = 'meetings/aliased-session-example';
      await engine.transaction(tx => withCoordinatedWrite(tx, [s.sourceId], async () => {
        await tx.putPage(meeting, { type: 'meeting', title: 'Session', compiled_truth: 'A session.', timeline: '', frontmatter: { access: 'private' } }, { sourceId: s.sourceId });
        await tx.putPage('chronicle/2026/10/session-example', { type: 'event', title: 'Session', compiled_truth: 'A session.', timeline: '',
          frontmatter: { captured_via: 'life-chronicle:auto', visibility: 'world', event: { depth: meeting } } }, { sourceId: s.sourceId });
      }, TEST_WRITE_ATTRIBUTION));
      const [fact] = await engine.executeRaw<{ id: number }>(`INSERT INTO facts (source_id, fact, kind, entity_slug, visibility, source, context, valid_from)
        VALUES ($1, $2, 'fact', $3, 'world', 'mcp:put_page', $4, now()) RETURNING id`, [s.sourceId, CLAIM, PERSON, meeting]);
      expect(await remoteReadable(s.remote)).toContain(CLAIM);

      const check = await derivedVisibilityCheck(engine, s.sourceId);
      expect(check.status).toBe('warn');
      expect(check.details).toMatchObject({ alias_pages_without_visibility: 1, looser_events: 1, world_facts_from_private_sources: 1,
        world_facts_remotely_readable: 1, remotely_readable_fact_ids: [String(fact!.id)] });
      expect(check.message).not.toContain(meeting);
      expect(check.message).toContain('Remote page reads hide them (to show them: gbrain config set visibility.honor_aliases false).');

      const home = mkdtempSync(join(tmpdir(), 'gbrain-visibility-repair-'));
      try {
        await withEnv({ GBRAIN_HOME: home }, async () => {
          const ctx = { ...s.local, config: { engine: engine.kind, embedding_disabled: true } } as OperationContext;
          const scope = await resolveRepairScope(engine, s.sourceId);
          const preview = await runRepair(ctx, visibilityRepair, scope, { apply: false });
          expect(preview.affected).toBe(3);
          expect((await engine.executeRaw<{ visibility: string }>('SELECT visibility FROM facts WHERE id=$1', [fact!.id]))[0]!.visibility).toBe('world');
          expect((await engine.readPageSnapshot(meeting, { sourceId: s.sourceId }))!.page.frontmatter.visibility).toBeUndefined();
          const applied = await runRepair(ctx, visibilityRepair, scope, { apply: true });
          expect(applied).toMatchObject({ applied: 3, complete: true });
        });
      } finally { rmSync(home, { recursive: true, force: true }); }
      expect((await engine.readPageSnapshot(meeting, { sourceId: s.sourceId }))!.page.frontmatter.visibility).toBe('private');
      expect((await engine.readPageSnapshot('chronicle/2026/10/session-example', { sourceId: s.sourceId }))!.page.frontmatter.visibility).toBe('private');
      expect((await engine.executeRaw<{ visibility: string }>('SELECT visibility FROM facts WHERE id=$1', [fact!.id]))[0]!.visibility).toBe('private');
      expect(await remoteReadable(s.remote)).not.toContain(CLAIM);
      expect((await derivedVisibilityCheck(engine, s.sourceId)).status).toBe('ok');
    });
  }, 120_000);
});

describe('connector pages keep a private label', () => {
  const event: CalendarEventData = { id: 'ev-example', summary: 'Private appointment', description: '', startIso: '2026-10-01T10:00:00Z',
    endIso: '2026-10-01T11:00:00Z', allDay: false, organizer: null, attendees: [], location: null, hangoutLink: null, htmlLink: null,
    status: 'confirmed', account: 'me@example.com' };

  test('a Google private event renders visibility: private; a default one renders no label', () => {
    expect(renderCalendarEventPage({ ...event, private: true })!.markdown).toContain('\nvisibility: private\n---');
    expect(renderCalendarEventPage(event)!.markdown).not.toContain('visibility:');
    expect(withPrivateVisibility('---\ntitle: x\nvisibility: world\n---\n\nbody\n')).toBe('---\ntitle: x\nvisibility: private\n---\n\nbody\n');
  });

  test('a re-render of a page the owner made private keeps it private (tighten-only)', async () => {
    await onEachEngine(async engine => {
      const s = await source(engine, false);
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-connector-'));
      try {
        const deps = { engine, sourceId: s.sourceId, cfg: { account: 'me@example.com', dir }, opts: {}, log() {}, tick() {} } as never;
        const summary = { pagesAffected: [], chunksCreated: 0, added: 0, modified: 0 } as never;
        const rendered = renderCalendarEventPage(event)!;
        const slug = (await importRendered(deps, rendered.relPath, rendered.markdown, undefined as never, summary, new Set()))!;
        const page = (await engine.readPageSnapshot(slug, { sourceId: s.sourceId }))!.page;
        expect(page.frontmatter.visibility).toBeUndefined();
        await engine.transaction(tx => withCoordinatedWrite(tx, [s.sourceId], () => tx.putPage(slug, { ...page, frontmatter: { ...page.frontmatter, visibility: 'private' } },
          { sourceId: s.sourceId }), TEST_WRITE_ATTRIBUTION));
        const moved = renderCalendarEventPage({ ...event, summary: 'Private appointment (moved)' })!;
        await importRendered(deps, rendered.relPath, moved.markdown, undefined as never, summary, new Set());
        const after = (await engine.readPageSnapshot(slug, { sourceId: s.sourceId }))!.page;
        expect(after.title).toBe('Private appointment (moved)');
        expect(after.frontmatter.visibility).toBe('private');
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }, 120_000);
});

describe('the segmented-entity retry keeps the original call', () => {
  test('its fix carries the resolved visibility, kind and ttl; without them visibility is an input, never the world default', () => {
    const carried = segmentedRememberRefusal(PRIVATE_PERSON, 'default', false, { visibility: 'private', kind: 'preference', ttl: '30d' }).fix!;
    expect(carried.mcp!.arguments).toMatchObject({ visibility: 'private', kind: 'preference', ttl: '30d', infer_entity: false });
    expect(carried.argv).toEqual(expect.arrayContaining(['--visibility', 'private']));
    const bare = segmentedRememberRefusal(PRIVATE_PERSON, 'default', false).fix!;
    expect(bare.mcp!.arguments).toMatchObject({ visibility: '<VISIBILITY>' });
    expect(bare.inputs!.map(i => i.name)).toContain('VISIBILITY');
  });
});
