/**
 * #4618 seat identity in dream output: synthesize credits each page to the
 * seat recorded in its transcript's `.seat.json` sidecar, on the managed
 * (maintenance publish) and unmanaged (provenance stamp) paths; patterns
 * credits a seat only when every input reflection shares one.
 *
 * Authoring gate: protects the user-visible `seat` frontmatter on synthesized
 * pages (the household case: two seats, one brain). A regression that drops
 * the stamp on either write path, credits the wrong transcript's seat, stamps
 * a seat without a sidecar, or keys synthesis on the seat (a paid re-run when
 * a sidecar appears later) fails here. Existing synthesis tests never write a
 * sidecar. No production seam: the chat transport stub is the existing one.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseSynthesize } from '../src/core/cycle/synthesize.ts';
import { runPhasePatterns } from '../src/core/cycle/patterns.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { __setMaintenanceWriteWaitForTests } from '../src/core/persistence/maintenance-wait.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { configureGateway, resetGateway, __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let dataDir: string;
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  __setMaintenanceWriteWaitForTests(5_000);
  dataDir = mkdtempSync(join(tmpdir(), 'gbrain-seat-synth-db-'));
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir });
    await engine.initSchema();
    engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine);
    closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  __setMaintenanceWriteWaitForTests(null);
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  resetGateway();
  rmSync(dataDir, { recursive: true, force: true });
});

const quote = 'we charge for durability because reliable memories should survive every tool';
const usage = { input_tokens: 100, output_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 0 };

interface Fixture { engine: BrainEngine; sourceId: string; root: string; corpus: string; calls: () => number }

async function fixture(managed: boolean, run: (f: Fixture) => Promise<void>) {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-seat-synth-'));
    const root = join(dir, 'brain');
    const corpus = join(dir, 'corpus');
    mkdirSync(root);
    mkdirSync(corpus);
    const sourceId = `seat-${randomUUID().slice(0, 8)}`;
    let calls = 0;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home'), ANTHROPIC_API_KEY: 'sk-test-seat' }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        await claimWorktree(engine, sourceId, root);
        for (const [key, value] of Object.entries({
          'dream.synthesize.enabled': 'true', 'dream.synthesize.cooldown_hours': '0',
          'dream.synthesize.min_chars': '100', 'dream.synthesize.link_manifest': 'false',
          'dream.synthesize.mode': 'oneshot', 'dream.synthesize.session_corpus_dir': corpus,
          'models.dream.synthesize': 'anthropic:claude-sonnet-4-6', 'models.dream.triage': 'anthropic:claude-sonnet-4-6',
          'models.dream.patterns': 'anthropic:claude-sonnet-4-6', 'dream.patterns.enabled': 'true',
        })) await engine.setConfig(key, value);
        await submitPageMutation(pageCtx(engine, sourceId), { operation: 'put_page', params: {
          slug: 'people/example', content: '---\ntitle: Example\ntype: note\n---\nExample evidence.', request_id: randomUUID() } });
        if (managed) await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        __setChatTransportForTests(async opts => {
          calls++;
          const user = String(opts.messages?.[0]?.content ?? '');
          const hash = /hash suffix \(USE THIS in slugs\): ([a-z0-9-]+)/i.exec(user)?.[1] ?? 'missing';
          const text = (opts.system ?? '').startsWith('You triage a conversation transcript')
            ? JSON.stringify({ score: 0.9, content_type: 'reflection', segments: [{ quote, note: 'evidence' }], entities: [], reasons: ['durable insight'] })
            : JSON.stringify({ pages: [{ slug: `wiki/personal/reflections/session-${hash}`, title: 'Session', type: 'note',
              body: 'A durable memory strategy with [[people/example]].' }], skipped: false });
          return { text, blocks: [{ type: 'text', text }], stopReason: 'end', usage, model: opts.model!, providerId: 'anthropic' };
        });
        await run({ engine, sourceId, root, corpus, calls: () => calls });
      });
    } finally {
      __setChatTransportForTests(null);
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

const pageCtx = (engine: BrainEngine, sourceId: string) => ({ engine, sourceId, remote: false as const,
  config: { engine: engine.kind, embedding_disabled: true }, dryRun: false, logger: { info() {}, warn() {}, error() {} } });

function writeSession(corpus: string, sessionId: string, topic: string, seat?: string): string {
  const path = join(corpus, `${sessionId}.txt`);
  writeFileSync(path, `[user]\n${quote}. Today we covered ${topic}.\n\n${'[assistant]\nDiscuss the long term roadmap.\n\n'.repeat(15)}`);
  if (seat) {
    writeFileSync(join(corpus, `${sessionId}.seat.json`), JSON.stringify({
      version: 1, seat, seat_source: 'env', hook_lane: 'workspace', harness: 'claude-code', first_seen: '2026-09-20T00:00:00.000Z',
    }) + '\n', { mode: 0o600 });
  }
  return path;
}

/** Synthesized pages by the basename of the transcript each came from. */
async function pagesByTranscript(engine: BrainEngine, sourceId: string): Promise<Map<string, { slug: string; frontmatter: Record<string, unknown> }>> {
  const rows = await engine.executeRaw<{ slug: string; frontmatter: Record<string, unknown> }>(
    "SELECT slug, frontmatter FROM pages WHERE source_id=$1 AND slug LIKE 'wiki/personal/reflections/session-%'", [sourceId]);
  return new Map(rows.map(r => [basename(String(r.frontmatter.raw_source)), r]));
}

for (const managed of [true, false]) describe(`${managed ? 'managed' : 'unmanaged'} synthesis seat stamp (#4618)`, () => {
  test('7-9. two seats, one brain: each page credits its transcript\'s seat; no sidecar ⇒ no seat; a later sidecar re-synthesizes nothing', async () => {
    await fixture(managed, async ({ engine, sourceId, root, corpus, calls }) => {
      writeSession(corpus, 'sess-alice', 'the durable storage plan', 'alice-desk');
      writeSession(corpus, 'sess-bob', 'the household budget review', 'bob-desk');
      writeSession(corpus, 'sess-plain', 'the garden watering schedule');
      const opts = { brainDir: root, sourceId, dryRun: false };
      const first = await runPhaseSynthesize(engine, opts);
      expect(first).toMatchObject({ status: 'ok' });
      const pages = await pagesByTranscript(engine, sourceId);
      expect([...pages.keys()].sort()).toEqual(['sess-alice.txt', 'sess-bob.txt', 'sess-plain.txt']);
      expect(pages.get('sess-alice.txt')!.frontmatter.seat).toBe('alice-desk');
      expect(pages.get('sess-bob.txt')!.frontmatter.seat).toBe('bob-desk');
      expect(pages.get('sess-plain.txt')!.frontmatter).not.toHaveProperty('seat');
      expect(pages.get('sess-alice.txt')!.frontmatter.dream_generated).toBe(true);
      const file = parseMarkdown(readFileSync(join(root, `${pages.get('sess-bob.txt')!.slug}.md`), 'utf8'));
      expect(file.frontmatter.seat).toBe('bob-desk');

      const spent = calls();
      const [{ n: jobs }] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM minion_jobs');
      writeSession(corpus, 'sess-plain', 'the garden watering schedule', 'carol-desk');
      await disposePersistenceConsumer(engine);
      const replay = await runPhaseSynthesize(engine, opts);
      expect(replay).toMatchObject({ status: 'ok' });
      expect(calls()).toBe(spent);
      const [{ n: jobsAfter }] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM minion_jobs');
      expect(jobsAfter).toBe(jobs);
      expect((await pagesByTranscript(engine, sourceId)).get('sess-plain.txt')!.frontmatter).not.toHaveProperty('seat');
    });
  }, 120_000);

  // A model updating an existing pattern page copies its frontmatter, seat included; once the reflections
  // that earned the seat age out of the window, the rewrite must not keep crediting it.
  test('patterns credit a seat only when every input reflection shares it, and drop one they no longer earn', async () => {
    for (const [seats, carried] of [[['alice-desk', 'alice-desk', 'alice-desk'], ''], [['alice-desk', 'bob-desk', 'alice-desk'], ''],
      [['alice-desk', 'bob-desk', 'alice-desk'], 'seat: alice-desk\n']] as const) {
      await fixture(managed, async ({ engine, sourceId, root }) => {
        await engine.setConfig('agent.use_gateway_loop', 'true');
        const ctx = pageCtx(engine, sourceId);
        for (const [i, seat] of seats.entries()) {
          await submitPageMutation(ctx, { operation: 'put_page', params: { slug: `wiki/personal/reflections/example-${i}`,
            content: `---\ntitle: Reflection ${i}\ntype: note\nseat: ${seat}\n---\nA recurring worry about durability, take ${i}.`, request_id: randomUUID() } });
        }
        let calls = 0;
        __setChatTransportForTests(async opts => {
          calls++;
          const write = calls === 1;
          return { text: write ? '' : 'Saved the pattern.', blocks: write ? [{ type: 'tool-call', toolCallId: 'pattern-write', toolName: 'brain_put_page', input: {
            slug: 'wiki/personal/patterns/durability', content: `---\ntitle: Durability pattern\ntype: note\n${carried}---\nA recurring theme in [[wiki/personal/reflections/example-0]].`,
          } }] : [{ type: 'text', text: 'Saved the pattern.' }], stopReason: write ? 'tool_calls' : 'end', usage, model: opts.model!, providerId: 'anthropic' };
        });
        const result = await runPhasePatterns(engine, { brainDir: root, sourceId, dryRun: false, once: true, cycleDate: '2026-09-20' });
        expect(result.details.patterns_written).toBe(1);
        const page = (await engine.readPageSnapshot('wiki/personal/patterns/durability', { sourceId }))!;
        expect(page.page.frontmatter.dream_generated).toBe(true);
        if (new Set(seats).size === 1) expect(page.page.frontmatter.seat).toBe('alice-desk');
        else expect(page.page.frontmatter).not.toHaveProperty('seat');
      });
    }
  }, 120_000);
});
