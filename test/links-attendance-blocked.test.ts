/**
 * #5761: a meeting page left stale only by an unresolved attendee is
 * attendance-blocked, not extraction lag. Managed stale extraction marks it at
 * the revision it read; `links_extraction_lag` reports it in its own count; an
 * edit makes it lag again; once the attendee's person page exists the next
 * extraction publishes its links and clears the marker. The unmanaged
 * `extract --stale` sweep marks the same way. PGLite, and Postgres with
 * DATABASE_URL.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { extractManagedStaleLinks } from '../src/core/persistence/links-maintenance.ts';
import { checkLinksExtractionLag } from '../src/commands/doctor.ts';
import { extractStaleFromDB } from '../src/commands/extract.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-attendance-blocked-db-'));
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
const MEETING = 'meetings/2026-04-03';
const PERSON = 'people/alice-example';
const meeting = (body: string) => `---\ntitle: Planning\ntype: meeting\nattendees: [${PERSON}]\n---\n${body}\n\nSee [[notes/roadmap]].`;

function ctxFor(engine: BrainEngine, sourceId: string): OperationContext {
  return { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger };
}

async function putPage(engine: BrainEngine, sourceId: string, slug: string, content: string) {
  const current = await engine.readPageSnapshot(slug, { sourceId });
  await submitPageMutation(ctxFor(engine, sourceId), { operation: 'put_page',
    params: { slug, content, request_id: randomUUID(), ...(current ? { expected_revision: current.revision } : {}) } });
}

async function lag(engine: BrainEngine, sourceId: string) {
  const check = await checkLinksExtractionLag(engine, { sourceId });
  const details = check.details as { stale: number; attendance_blocked: number };
  return { stale: details.stale, blocked: details.attendance_blocked, message: check.message };
}

async function marker(engine: BrainEngine, sourceId: string) {
  const [row] = await engine.executeRaw<{ blocked: boolean | null; at: unknown; extracted: unknown }>(
    `SELECT links_attendance_blocked_revision = knowledge_revision AS blocked, links_attendance_blocked_at AS at, links_extracted_at AS extracted
       FROM pages WHERE source_id=$1 AND slug=$2`, [sourceId, MEETING]);
  return { blocked: row.blocked, at: row.at !== null, extracted: row.extracted !== null };
}

async function attended(engine: BrainEngine, sourceId: string) {
  return (await engine.getLinks(MEETING, { sourceId })).filter(l => l.to_slug === PERSON && l.link_type === 'attended').length;
}

/** A managed filesystem source with the meeting and its link target; auto_link off so extraction owns the links. */
async function managedFixture(run: (engine: BrainEngine, sourceId: string) => Promise<void>) {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-attendance-blocked-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    const sourceId = `att-${randomUUID().slice(0, 8)}`;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        await engine.setConfig('auto_link', 'false');
        await claimWorktree(engine, sourceId, root);
        await putPage(engine, sourceId, 'notes/roadmap', '---\ntitle: Roadmap\ntype: note\n---\nThe roadmap.');
        await putPage(engine, sourceId, MEETING, meeting('Kickoff.'));
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        await run(engine, sourceId);
      });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.setConfig('auto_link', 'true');
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

test('#5761: doctor reports an attendance-blocked page apart from lag; extraction keeps reconsidering it', async () => {
  await managedFixture(async (engine, sourceId) => {
    const first = await extractManagedStaleLinks(engine, { sourceId });
    expect(first).toMatchObject({ pages: 1, skipped: 1, remaining: 1 });
    const report = await lag(engine, sourceId);
    expect({ stale: report.stale, blocked: report.blocked }).toEqual({ stale: 0, blocked: 1 });
    expect(report.message).toContain('1 more page(s) wait on unresolved attendees');
    expect(await marker(engine, sourceId)).toEqual({ blocked: true, at: true, extracted: false });
    const again = await extractManagedStaleLinks(engine, { sourceId });
    expect(again).toMatchObject({ pages: 0, skipped: 1, remaining: 1 });
  });
});

test('#5761: an edit after the block makes the page count as lag again', async () => {
  await managedFixture(async (engine, sourceId) => {
    await extractManagedStaleLinks(engine, { sourceId });
    expect((await lag(engine, sourceId)).blocked).toBe(1);
    await putPage(engine, sourceId, MEETING, meeting('Kickoff, with notes.'));
    expect((await marker(engine, sourceId)).blocked).toBe(false);
    const report = await lag(engine, sourceId);
    expect({ stale: report.stale, blocked: report.blocked }).toEqual({ stale: 1, blocked: 0 });
    expect(report.message).not.toContain('unresolved attendees');
  });
});

test('#5761: creating the missing attendee lets the next extraction publish and clear the marker', async () => {
  await managedFixture(async (engine, sourceId) => {
    await extractManagedStaleLinks(engine, { sourceId });
    expect(await attended(engine, sourceId)).toBe(0);
    await putPage(engine, sourceId, PERSON, '---\ntitle: Alice Example\ntype: person\n---\nAlice.');
    const result = await extractManagedStaleLinks(engine, { sourceId });
    expect(result).toMatchObject({ skipped: 0, remaining: 0 });
    expect(await attended(engine, sourceId)).toBe(1);
    expect(await marker(engine, sourceId)).toEqual({ blocked: null, at: false, extracted: true });
    expect(await lag(engine, sourceId)).toMatchObject({ stale: 0, blocked: 0 });
  });
});

test('#5761: the unmanaged extract --stale sweep marks and clears the same way', async () => {
  for (const engine of engines) {
    const sourceId = `att-${randomUUID().slice(0, 8)}`;
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    await engine.putPage('notes/roadmap', { type: 'note', title: 'Roadmap', compiled_truth: 'The roadmap.' }, { sourceId });
    await engine.putPage(MEETING, { type: 'meeting', title: 'Planning', compiled_truth: 'Kickoff. See [[notes/roadmap]].',
      frontmatter: { attendees: [PERSON] } }, { sourceId });
    const opts = { includeFrontmatter: true, dryRun: false, jsonMode: false, quiet: true, sourceIdFilter: sourceId, catchUp: true };
    expect((await extractStaleFromDB(engine, opts)).skippedAttendanceIncomplete).toBe(1);
    expect((await marker(engine, sourceId)).blocked).toBe(true);
    expect(await lag(engine, sourceId)).toMatchObject({ stale: 0, blocked: 1 });
    await engine.putPage(PERSON, { type: 'person', title: 'Alice Example', compiled_truth: 'Alice.' }, { sourceId });
    const second = await extractStaleFromDB(engine, opts);
    expect(second.skippedAttendanceIncomplete ?? 0).toBe(0);
    expect(await attended(engine, sourceId)).toBe(1);
    expect(await marker(engine, sourceId)).toMatchObject({ blocked: null, extracted: true });
  }
});
