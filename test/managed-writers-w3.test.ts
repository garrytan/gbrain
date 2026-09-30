/**
 * Fix wave 3, Lane B: managed-brain maintenance writers that used to bypass
 * the coordinator (#5484 synthesize_concepts, #5523 chronicle extract, #5405
 * purge, #5280 enrich / add_link / remove_link / bootstrap verify cleanup).
 *
 * Contract: on a managed brain each writer's mutation lands as a COMMITTED
 * coordinated write with its intended result, instead of refusing with
 * `writer_coordinator_required` (or being refused by the managed writer
 * trigger). Runs on PGLite and, with DATABASE_URL, Postgres.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { operations } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCycle } from '../src/core/cycle.ts';
import { runPhaseSynthesizeConcepts } from '../src/core/cycle/synthesize-concepts.ts';
import { runChronicleExtract } from '../src/core/chronicle/extract-events.ts';
import { runEnrichCore } from '../src/commands/enrich.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { extractManagedStaleLinks } from '../src/core/persistence/links-maintenance.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-w3-writers-db-'));
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir }); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); resetGateway(); rmSync(dataDir, { recursive: true, force: true });
});

const logger = { info() {}, warn() {}, error() {} };
function ctxFor(engine: BrainEngine, sourceId: string): OperationContext {
  return { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger };
}

/** A filesystem source with an active local canonical owner; managed persistence turns on after `seed`. */
async function managedFixture(seed: (engine: BrainEngine, sourceId: string, root: string) => Promise<void>,
  run: (engine: BrainEngine, sourceId: string, root: string) => Promise<void>) {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-w3-writers-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    const sourceId = `w3b-${randomUUID().slice(0, 8)}`;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        await claimWorktree(engine, sourceId, root);
        await seed(engine, sourceId, root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        await run(engine, sourceId, root);
      });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

async function committed(engine: BrainEngine, sourceId: string, slug: string) {
  return engine.executeRaw<{ operation: string; intent: Record<string, unknown> | null; outcome: Record<string, unknown> | null }>(
    `SELECT operation,intent,outcome FROM persistence_requests WHERE source_id=$1 AND slug=$2 AND state='committed' ORDER BY sequence`,
    [sourceId, slug]);
}

async function putPage(engine: BrainEngine, sourceId: string, slug: string, content: string) {
  await submitPageMutation(ctxFor(engine, sourceId), { operation: 'put_page', params: { slug, content, request_id: randomUUID() } });
}

test('#5484: synthesize_concepts publishes through the coordinator: private first, provenance, then world', async () => {
  await managedFixture(async (engine, sourceId) => {
    for (const n of [1, 2]) {
      await putPage(engine, sourceId, `atoms/idea-${n}`,
        `---\ntitle: Idea ${n}\ntype: atom\nvisibility: world\nconcepts: [network-effects]\n---\nAtom ${n} about network effects.`);
    }
  }, async (engine, sourceId, root) => {
    const result = await runPhaseSynthesizeConcepts(engine, { sourceId, brainDir: root,
      _chat: async () => { throw new Error('a T3 concept must not call the model'); } });
    expect(result.status).toBe('ok');
    expect(result.details.concepts_written).toBe(1);
    const requests = await committed(engine, sourceId, 'concepts/network-effects');
    expect(requests.map(r => r.intent?.kind)).toEqual(['managed_maintenance_page', 'managed_maintenance_page']);
    expect(String(requests[0].intent?.content)).toContain('visibility: private');
    expect(String(requests[1].intent?.content)).toContain('visibility: world');
    const page = await engine.getPage('concepts/network-effects', { sourceId });
    expect(page?.frontmatter?.visibility).toBe('world');
    expect(page?.frontmatter?.synthesized_by).toBe('synthesize_concepts-v0.41');
    const links = await engine.getLinks('concepts/network-effects', { sourceId });
    expect(links.filter(l => l.link_source === 'concept-provenance').map(l => l.to_slug).sort()).toEqual(['atoms/idea-1', 'atoms/idea-2']);
  });
});

test('#5484: a concept whose provenance cannot land stays private (promotion is gated on provenance)', async () => {
  await managedFixture(async (engine, sourceId) => {
    await putPage(engine, sourceId, 'atoms/idea-1', '---\ntitle: Idea 1\ntype: atom\nconcepts: [moats]\n---\nAtom 1 about moats.');
  }, async (engine, sourceId, root) => {
    const result = await runPhaseSynthesizeConcepts(engine, { sourceId, brainDir: root, _atoms: [
      { slug: 'atoms/idea-1', title: 'Idea 1', body: 'Atom 1 about moats.', concept_refs: ['moats'], visibility: 'world' },
      { slug: 'atoms/missing', title: 'Missing', body: 'Not in this source.', concept_refs: ['moats'], visibility: 'world' },
    ] });
    expect(result.details.concepts_written).toBe(1);
    const requests = await committed(engine, sourceId, 'concepts/moats');
    expect(requests).toHaveLength(1);
    expect(String(requests[0].intent?.content)).toContain('visibility: private');
    expect((await engine.getPage('concepts/moats', { sourceId }))?.frontmatter?.visibility).toBe('private');
  });
});

test('#5484: a concept edited while its narrative is being synthesized is not overwritten (Codex review)', async () => {
  await managedFixture(async (engine, sourceId) => {
    for (const n of [1, 2, 3, 4, 5]) {
      await putPage(engine, sourceId, `atoms/flywheel-${n}`,
        `---\ntitle: Flywheel ${n}\ntype: atom\nvisibility: world\nconcepts: [flywheels]\n---\nAtom ${n} about flywheels.`);
    }
    await putPage(engine, sourceId, 'concepts/flywheels',
      '---\ntitle: flywheels\ntype: concept\nsynthesized_by: synthesize_concepts-v0.41\nsynthesis_mode: llm\nmember_hash: stale\n---\nOld narrative.');
  }, async (engine, sourceId, root) => {
    const result = await runPhaseSynthesizeConcepts(engine, { sourceId, brainDir: root, _chat: (async () => {
      const current = await engine.readPageSnapshot('concepts/flywheels', { sourceId });
      await submitPageMutation(ctxFor(engine, sourceId), { operation: 'put_page', params: { slug: 'concepts/flywheels',
        expected_revision: current!.revision, request_id: randomUUID(), content: '---\ntitle: flywheels\ntype: concept\n---\nA human rewrote this.' } });
      return { text: 'Fresh narrative.', usage: { input_tokens: 1, output_tokens: 1 }, model: 'anthropic:claude-sonnet-4-6' };
    }) as never });
    expect((result.details.publication_deferred as unknown[]).length).toBe(1);
    const page = await engine.getPage('concepts/flywheels', { sourceId });
    expect(page?.compiled_truth).toContain('A human rewrote this.');
    expect(page?.frontmatter?.synthesized_by).toBeUndefined();
  });
});

test('#5523: chronicle extract publishes the event page and its depth timeline row together, and never resurrects a deleted event', async () => {
  await managedFixture(async (engine, sourceId) => {
    await putPage(engine, sourceId, 'meetings/2026-03-02', '---\ntitle: Standup\ntype: meeting\ndate: 2026-03-02\n---\nWe met.');
  }, async (engine, sourceId) => {
    const judge = async () => ({ events: [{ when: '2026-03-02T09:00:00Z', who: ['people/alice-example'], what: 'Morning standup', kind: 'meeting' }] });
    const first = await runChronicleExtract(engine, { slug: 'meetings/2026-03-02', sourceId, judge });
    expect(first).toMatchObject({ status: 'extracted', events_written: 1 });
    const [event] = await engine.executeRaw<{ slug: string }>(
      "SELECT slug FROM pages WHERE source_id=$1 AND slug LIKE 'life/events/%' AND deleted_at IS NULL", [sourceId]);
    expect(event).toBeDefined();
    const requests = await committed(engine, sourceId, event.slug);
    expect(requests).toHaveLength(1);
    expect(requests[0].outcome?.event_projected).toBe(true);
    const timeline = await engine.executeRaw<{ summary: string }>(
      `SELECT t.summary FROM timeline_entries t JOIN pages d ON d.id=t.page_id JOIN pages e ON e.id=t.event_page_id
        WHERE d.source_id=$1 AND d.slug='meetings/2026-03-02' AND e.slug=$2`, [sourceId, event.slug]);
    expect(timeline.map(r => r.summary)).toEqual(['Morning standup']);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.softDeletePage(event.slug, { sourceId });
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    await runChronicleExtract(engine, { slug: 'meetings/2026-03-02', sourceId, judge });
    const after = await engine.readPageSnapshot(event.slug, { sourceId, includeDeleted: true });
    expect(after?.page.deleted_at).toBeTruthy();
  });
});

test('#5405: the purge phase hard-deletes expired tombstones through the coordinator and still runs', async () => {
  await managedFixture(async (engine, sourceId) => {
    await putPage(engine, sourceId, 'notes/expired', '---\ntitle: Expired\ntype: note\n---\nGone soon.');
    const snapshot = await engine.readPageSnapshot('notes/expired', { sourceId });
    await submitPageMutation(ctxFor(engine, sourceId), { operation: 'delete_page', params: {
      slug: 'notes/expired', expected_revision: snapshot!.revision, request_id: randomUUID() } });
    await engine.executeRaw("UPDATE pages SET deleted_at=now() - interval '100 hours' WHERE source_id=$1 AND slug='notes/expired'", [sourceId]);
  }, async (engine, sourceId, root) => {
    const report = await runCycle(engine, { brainDir: root, phases: ['purge'], sourceId });
    const phase = report.phases.find(p => p.phase === 'purge')!;
    expect(phase.status).toBe('ok');
    expect(phase.details.purged_pages_count).toBe(1);
    expect(await engine.readPageSnapshot('notes/expired', { sourceId, includeDeleted: true })).toBeNull();
    const requests = await committed(engine, sourceId, 'notes/expired');
    expect(requests.at(-1)?.outcome?.status).toBe('purged');
  });
});

test('#5405: a tombstone restored and deleted again after the purge scan is not purged (its window restarted)', async () => {
  const { purgeDeletedPagesCoordinated } = await import('../src/core/persistence/purge-deleted.ts');
  await managedFixture(async (engine, sourceId) => {
    await putPage(engine, sourceId, 'notes/cycled', '---\ntitle: Cycled\ntype: note\n---\nBack again.');
    const snapshot = await engine.readPageSnapshot('notes/cycled', { sourceId });
    await submitPageMutation(ctxFor(engine, sourceId), { operation: 'delete_page', params: {
      slug: 'notes/cycled', expected_revision: snapshot!.revision, request_id: randomUUID() } });
    await engine.executeRaw("UPDATE pages SET deleted_at=now() - interval '100 hours' WHERE source_id=$1 AND slug='notes/cycled'", [sourceId]);
  }, async (engine, sourceId) => {
    let cycled = false;
    const racing = Object.create(engine) as BrainEngine;
    racing.readPageSnapshot = async (slug, opts) => {
      if (!cycled && slug === 'notes/cycled') {
        cycled = true;
        const tomb = await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
        await submitPageMutation(ctxFor(engine, sourceId), { operation: 'restore_page', params: { slug, expected_revision: tomb!.revision, request_id: randomUUID() } });
        const live = await engine.readPageSnapshot(slug, { sourceId });
        await submitPageMutation(ctxFor(engine, sourceId), { operation: 'delete_page', params: { slug, expected_revision: live!.revision, request_id: randomUUID() } });
      }
      return engine.readPageSnapshot(slug, opts);
    };
    const result = await purgeDeletedPagesCoordinated(racing, 72);
    expect(result).toMatchObject({ count: 0, failed: 0, deferred: 1 });
    expect((await engine.readPageSnapshot('notes/cycled', { sourceId, includeDeleted: true }))?.page.deleted_at).toBeTruthy();
  });
});

test('#5405: the purge job fails when a coordinated purge fails, after reporting what it could not purge', async () => {
  const { registerBuiltinHandlers } = await import('../src/commands/jobs.ts');
  await managedFixture(async (engine, sourceId) => {
    await putPage(engine, sourceId, 'notes/stuck', '---\ntitle: Stuck\ntype: note\n---\nOwned elsewhere.');
    const snapshot = await engine.readPageSnapshot('notes/stuck', { sourceId });
    await submitPageMutation(ctxFor(engine, sourceId), { operation: 'delete_page', params: {
      slug: 'notes/stuck', expected_revision: snapshot!.revision, request_id: randomUUID() } });
    await engine.executeRaw("UPDATE pages SET deleted_at=now() - interval '100 hours' WHERE source_id=$1 AND slug='notes/stuck'", [sourceId]);
  }, async (engine, sourceId) => {
    const handlers = new Map<string, (job: unknown) => Promise<unknown>>();
    await registerBuiltinHandlers({ register(name: string, fn: (job: unknown) => Promise<unknown>) { handlers.set(name, fn); } } as never, engine);
    // Another host owns the canonical worktree now: the purge cannot publish here.
    await withEnv({ GBRAIN_HOME: mkdtempSync(join(tmpdir(), 'gbrain-w3-otherhost-')) }, async () => {
      await expect(handlers.get('purge')!({ id: 1, data: { scope: 'pages' } })).rejects.toThrow(/could not be purged through the coordinator/);
    });
    expect((await engine.readPageSnapshot('notes/stuck', { sourceId, includeDeleted: true }))?.page.deleted_at).toBeTruthy();
  });
});

test('#5280: enrich publishes the enriched page through the coordinator', async () => {
  await managedFixture(async (engine, sourceId) => {
    await putPage(engine, sourceId, 'people/alice-example', '---\ntitle: Alice Example\ntype: person\n---\nStub page.');
    await putPage(engine, sourceId, 'meetings/m1', '---\ntitle: M1\ntype: note\n---\nNotes about [[people/alice-example]].');
    await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, source, valid_from, visibility)
      VALUES ($1, 'people/alice-example', 'Alice founded WidgetCo and leads its design system.', 'test', now(), 'world')`, [sourceId]);
  }, async (engine, sourceId) => {
    const result = await runEnrichCore(engine, { sourceId, types: ['person'] as never[], order: 'inbound-links' as const, thinThreshold: 400,
      model: 'test:model', workers: 1, minContextChars: 20,
      synthesizeFn: async () => '## Overview\nAlice founded WidgetCo. [Source: meetings/m1]' });
    expect(result.pages_failed).toBe(0);
    expect(result.pages_enriched).toBe(1);
    const requests = await committed(engine, sourceId, 'people/alice-example');
    expect(requests.at(-1)?.intent?.kind).toBe('managed_maintenance_page');
    const page = await engine.getPage('people/alice-example', { sourceId });
    expect(page?.compiled_truth).toContain('Alice founded WidgetCo.');
    expect(page?.frontmatter?.enriched_by).toBeTruthy();
  });
});

test('enrich carries the page facts and takes fences over the model output (Codex review)', async () => {
  const facts = ['<!--- gbrain:facts:begin -->', '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
    '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
    '| 1 | Founded WidgetCo | fact | 1.0 | world | high | 2017-01-01 |  | linkedin |  |', '<!--- gbrain:facts:end -->'].join('\n');
  const takes = ['<!--- gbrain:takes:begin -->', '| # | claim | kind | who | weight | since | source |',
    '|---|-------|------|-----|--------|-------|--------|', '| 1 | Will ship widgets | take | brain | 0.5 | 2026-07 | notes |', '<!--- gbrain:takes:end -->'].join('\n');
  await managedFixture(async (engine, sourceId) => {
    await putPage(engine, sourceId, 'people/alice-example', `---\ntitle: Alice Example\ntype: person\n---\nStub.\n\n## Facts\n\n${facts}\n\n## Takes\n\n${takes}\n`);
    await putPage(engine, sourceId, 'meetings/m1', '---\ntitle: M1\ntype: note\n---\nNotes about [[people/alice-example]] and her widget design system work.');
  }, async (engine, sourceId) => {
    const activeFacts = () => engine.executeRaw(`SELECT id FROM facts WHERE source_id=$1 AND entity_slug='people/alice-example' AND expired_at IS NULL`, [sourceId]);
    const activeTakes = () => engine.executeRaw(`SELECT t.id FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1 AND p.slug='people/alice-example' AND t.active`, [sourceId]);
    const before = { facts: (await activeFacts()).length, takes: (await activeTakes()).length };
    expect(before).toEqual({ facts: 1, takes: 1 });
    const result = await runEnrichCore(engine, { sourceId, types: ['person'] as never[], order: 'inbound-links' as const, thinThreshold: 4000,
      model: 'test:model', workers: 1, minContextChars: 20,
      synthesizeFn: async () => '## Overview\nAlice founded WidgetCo. [Source: meetings/m1]' });
    expect(result.pages_enriched).toBe(1);
    const page = await engine.getPage('people/alice-example', { sourceId });
    expect(page?.compiled_truth).toContain('Alice founded WidgetCo.');
    expect(page?.compiled_truth).toContain('Founded WidgetCo');
    expect({ facts: (await activeFacts()).length, takes: (await activeTakes()).length }).toEqual(before);
  });
});

test('#5280: grade_takes resolves the judged take by page identity when its page is renamed during judging (Codex review)', async () => {
  const { runPhaseGradeTakes } = await import('../src/core/cycle/grade-takes.ts');
  const takes = (claim: string) => ['<!--- gbrain:takes:begin -->', '| # | claim | kind | who | weight | since | source |',
    '|---|-------|------|-----|--------|-------|--------|', `| 1 | ${claim} | take | brain | 0.6 | 2025-01 | notes |`, '<!--- gbrain:takes:end -->'].join('\n');
  await managedFixture(async (engine, sourceId) => {
    await putPage(engine, sourceId, 'notes/graded', `---\ntitle: Graded\ntype: note\n---\nDraft.\n\n${takes('Acme will ship widgets')}\n`);
  }, async (engine, sourceId, root) => {
    let renamed = false;
    const judge = async ({ take }: { take: { claim: string } }) => {
      // Other sources' takes on this shared test brain are not part of this case.
      if (take.claim !== 'Acme will ship widgets' || renamed) return { verdict: 'unresolvable' as const, confidence: 0.1, reasoning: 'n/a' };
      renamed = true;
      // Simulate a rename that already committed, then a new page taking over the old slug.
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw("UPDATE pages SET slug='notes/graded-renamed', source_path=replace(source_path,'notes/graded.md','notes/graded-renamed.md') WHERE source_id=$1 AND slug='notes/graded'", [sourceId]);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      renameSync(join(root, 'notes/graded.md'), join(root, 'notes/graded-renamed.md'));
      await putPage(engine, sourceId, 'notes/graded', `---\ntitle: Graded\ntype: note\n---\nNew page.\n\n${takes('An unrelated claim')}\n`);
      return { verdict: 'correct' as const, confidence: 0.99, reasoning: 'Acme shipped widgets.' };
    };
    const result = await runPhaseGradeTakes({ engine, sourceId, remote: false, config: {} as never, dryRun: false, logger } as never,
      { autoResolve: true, minAgeMonths: 0, judge: judge as never, evidenceRetriever: (async () => 'evidence') as never, promptVersion: 'w3-rename' });
    expect(result.details.auto_applied).toBe(1);
    const rows = await engine.executeRaw<{ slug: string; resolved_quality: string | null }>(
      `SELECT p.slug, t.resolved_quality FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1 ORDER BY p.slug`, [sourceId]);
    expect(rows).toEqual([{ slug: 'notes/graded', resolved_quality: null }, { slug: 'notes/graded-renamed', resolved_quality: 'correct' }]);
  });
});

test('#5280: grade_takes never applies a verdict to a fence row replaced before publication, and grades it again next run (Codex review)', async () => {
  const { runPhaseGradeTakes } = await import('../src/core/cycle/grade-takes.ts');
  const takes = (claim: string) => ['<!--- gbrain:takes:begin -->', '| # | claim | kind | who | weight | since | source |',
    '|---|-------|------|-----|--------|-------|--------|', `| 1 | ${claim} | take | brain | 0.6 | 2025-01 | notes |`, '<!--- gbrain:takes:end -->'].join('\n');
  await managedFixture(async (engine, sourceId) => {
    await putPage(engine, sourceId, 'notes/regraded', `---\ntitle: Regraded\ntype: note\n---\nDraft.\n\n${takes('Widgets ship in Q3')}\n`);
  }, async (engine, sourceId) => {
    const judged: string[] = [];
    const judge = async ({ take }: { take: { claim: string } }) => {
      judged.push(take.claim);
      return take.claim.startsWith('Widgets') || take.claim.startsWith('Gadgets')
        ? { verdict: 'correct' as const, confidence: 0.99, reasoning: 'shipped' } : { verdict: 'unresolvable' as const, confidence: 0.1, reasoning: 'n/a' };
    };
    let replaced = false;
    const racing = Object.create(engine) as BrainEngine;
    racing.readPageSnapshot = async (slug, opts) => {
      if (!replaced && slug === 'notes/regraded' && judged.includes('Widgets ship in Q3')) {
        replaced = true;
        const current = await engine.readPageSnapshot(slug, { sourceId });
        await submitPageMutation(ctxFor(engine, sourceId), { operation: 'put_page', params: { slug, expected_revision: current!.revision,
          request_id: randomUUID(), content: `---\ntitle: Regraded\ntype: note\n---\nDraft.\n\n${takes('Gadgets ship in Q4')}\n` } });
      }
      return engine.readPageSnapshot(slug, opts);
    };
    const opts = { autoResolve: true, minAgeMonths: 0, judge: judge as never, evidenceRetriever: (async () => 'evidence') as never, promptVersion: 'w3-replace' };
    const first = await runPhaseGradeTakes({ engine: racing, sourceId, remote: false, config: {} as never, dryRun: false, logger } as never, opts);
    expect(first.details.auto_applied).toBe(0);
    const resolved = () => engine.executeRaw<{ claim: string; resolved_quality: string | null }>(
      `SELECT t.claim, t.resolved_quality FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.source_id=$1 AND p.slug='notes/regraded' AND t.active`, [sourceId]);
    expect(await resolved()).toEqual([{ claim: 'Gadgets ship in Q4', resolved_quality: null }]);
    // The row returns to the judged claim: its cached verdict must not block a retry.
    const current = await engine.readPageSnapshot('notes/regraded', { sourceId });
    await submitPageMutation(ctxFor(engine, sourceId), { operation: 'put_page', params: { slug: 'notes/regraded', expected_revision: current!.revision,
      request_id: randomUUID(), content: `---\ntitle: Regraded\ntype: note\n---\nDraft.\n\n${takes('Widgets ship in Q3')}\n` } });
    const second = await runPhaseGradeTakes({ engine, sourceId, remote: false, config: {} as never, dryRun: false, logger } as never, opts);
    expect(second.details.auto_applied).toBe(1);
    expect(await resolved()).toEqual([{ claim: 'Widgets ship in Q3', resolved_quality: 'correct' }]);
  });
});

test('#5280: incremental extract on a managed brain handles only the requested slugs, leaving the backlog to the bounded drain (Codex review)', async () => {
  const { runExtractCore } = await import('../src/commands/extract.ts');
  const { LINK_EXTRACTOR_VERSION_TS } = await import('../src/core/link-extraction.ts');
  await managedFixture(async (engine, sourceId) => {
    await engine.setConfig('auto_link', 'false');
    await putPage(engine, sourceId, 'notes/changed', '---\ntitle: Changed\ntype: note\n---\nSee [[notes/backlog]].');
    await putPage(engine, sourceId, 'notes/backlog', '---\ntitle: Backlog\ntype: note\n---\nOld page.');
  }, async (engine, sourceId, root) => {
    try {
      expect(await engine.countStalePagesForExtraction({ sourceId, versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(2);
      const result = await runExtractCore(engine, { mode: 'all', dir: root, sourceId, slugs: ['notes/changed'], quiet: true });
      expect(result.pages_processed).toBe(1);
      expect(await engine.countStalePagesForExtraction({ sourceId, versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(1);
    } finally { await engine.setConfig('auto_link', 'true'); }
  });
});

test('#5280: manual add_link / remove_link are coordinated on a managed brain, and a manual link survives re-derivation and republication', async () => {
  const addLink = operations.find(o => o.name === 'add_link')!;
  const removeLink = operations.find(o => o.name === 'remove_link')!;
  await managedFixture(async (engine, sourceId) => {
    await putPage(engine, sourceId, 'people/alice-example', '---\ntitle: Alice\ntype: person\n---\nAlice works on widgets.');
    await putPage(engine, sourceId, 'companies/acme-example', '---\ntitle: Acme\ntype: company\n---\nAcme makes widgets.');
  }, async (engine, sourceId) => {
    const ctx = ctxFor(engine, sourceId);
    expect(await addLink.handler(ctx, { from: 'people/alice-example', to: 'companies/acme-example', link_type: 'works_at' })).toEqual({ status: 'ok' });
    const manual = async () => (await engine.getLinks('people/alice-example', { sourceId }))
      .filter(l => l.to_slug === 'companies/acme-example' && l.link_source === 'manual');
    expect(await manual()).toHaveLength(1);
    await submitPageMutation(ctx, { operation: 'put_page', params: { slug: 'people/alice-example', request_id: randomUUID(),
      expected_revision: (await engine.readPageSnapshot('people/alice-example', { sourceId }))!.revision,
      content: '---\ntitle: Alice\ntype: person\n---\nAlice still works on widgets.' } });
    await extractManagedStaleLinks(engine, { sourceId, slugs: ['people/alice-example'] });
    expect(await manual()).toHaveLength(1);
    expect(await removeLink.handler(ctx, { from: 'people/alice-example', to: 'companies/acme-example', link_source: 'manual' }))
      .toEqual({ status: 'ok', removed: 1 });
    expect(await manual()).toHaveLength(0);
  });
});
