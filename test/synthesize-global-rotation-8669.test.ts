/**
 * #8669: the global maintenance cycle (no --source) ran the synthesize phase
 * for its own source only, so captured sessions owned by other sources were
 * reported `corpus_source_other` and never synthesized. The phase now takes
 * turns: each global cycle runs it once, for one source that owns captured
 * sessions, in rotation, so every owning source is covered. An archived source
 * never takes a turn and its sessions stay held. No provider is called: the
 * chat transport is stubbed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCycle, type PhaseResult } from '../src/core/cycle.ts';
import { synthesisRotation } from '../src/core/cycle/synthesize-source-routing.ts';
import { ensureCorpusSpoolDir, sessionCorpusFileName } from '../src/core/context/corpus-segments.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { __setMaintenanceWriteWaitForTests } from '../src/core/persistence/maintenance-wait.ts';
import { configureGateway, resetGateway, __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let dataDir: string;
let home: string;
beforeAll(async () => {
  __setMaintenanceWriteWaitForTests(5_000);
  dataDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-rotation-db-'));
  home = join(dataDir, 'brain-default');
  mkdirSync(home);
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  engine = new PGLiteEngine();
  await engine.connect({ database_path: dataDir });
  await engine.initSchema();
}, 120_000);
afterAll(async () => {
  __setMaintenanceWriteWaitForTests(null);
  await engine.disconnect();
  resetGateway();
  rmSync(dataDir, { recursive: true, force: true });
});

const quote = 'we keep the quarterly plan in one place so every team reads the same numbers';
const usage = { input_tokens: 100, output_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 0 };

interface Fixture { home: string; other: string; spool: string; meetings: string; calls: () => number }

async function fixture(run: (f: Fixture) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-synth-rotation-'));
  const corpus = join(dir, 'corpus');
  const other = `source-b-${randomUUID().slice(0, 8)}`;
  const meetings = join(dir, 'meetings');
  for (const d of [corpus, meetings, join(dir, 'brain-b')]) mkdirSync(d);
  let calls = 0;
  try {
    await withEnv({ GBRAIN_HOME: join(dataDir, 'home'), ANTHROPIC_API_KEY: 'sk-test-synth-rotation', GBRAIN_SOURCE: undefined }, async () => {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [home]);
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [other, join(dir, 'brain-b')]);
      await engine.setConfig('sync.write_through', 'true');
      await claimWorktree(engine, 'default', home);
      await claimWorktree(engine, other, join(dir, 'brain-b'));
      for (const [key, value] of Object.entries({
        'dream.synthesize.enabled': 'true', 'dream.synthesize.cooldown_hours': '0',
        'dream.synthesize.min_chars': '100', 'dream.synthesize.link_manifest': 'false',
        'dream.synthesize.mode': 'oneshot', 'dream.synthesize.session_corpus_dir': corpus,
        'dream.synthesize.meeting_transcripts_dir': meetings, 'dream.synthesize.rotation_turn': 'default',
        'models.dream.synthesize': 'anthropic:claude-sonnet-4-6', 'models.dream.triage': 'anthropic:claude-sonnet-4-6',
      })) await engine.setConfig(key, value);
      __setChatTransportForTests(async opts => {
        calls++;
        const user = String(opts.messages?.[0]?.content ?? '');
        const hash = /hash suffix \(USE THIS in slugs\): ([a-z0-9-]+)/i.exec(user)?.[1] ?? 'missing';
        const text = (opts.system ?? '').startsWith('You triage a conversation transcript')
          ? JSON.stringify({ score: 0.9, content_type: 'reflection', segments: [{ quote, note: 'evidence' }], entities: [], reasons: ['durable insight'] })
          : JSON.stringify({ pages: [{ slug: `wiki/personal/reflections/session-${hash}`, title: 'Session', type: 'note',
            body: 'A durable planning habit with [[people/example]].' }], skipped: false });
        return { text, blocks: [{ type: 'text', text }], stopReason: 'end', usage, model: opts.model!, providerId: 'anthropic' };
      });
      await run({ home, other, spool: ensureCorpusSpoolDir(corpus), meetings, calls: () => calls });
    });
  } finally {
    __setChatTransportForTests(null);
    await engine.executeRaw("DELETE FROM pages WHERE slug LIKE 'wiki/personal/reflections/%'");
    await engine.executeRaw('DELETE FROM sources WHERE id=$1', [other]);
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeTranscript(path: string, topic: string): void {
  writeFileSync(path, `[user]\n${quote}. Today we covered ${topic}.\n\n${'[assistant]\nDiscuss the long term roadmap.\n\n'.repeat(15)}`);
}

/** The source every synthesized page landed in, by the basename of the transcript it came from. */
async function synthesizedSources(other: string): Promise<Record<string, string[]>> {
  const rows = await engine.executeRaw<{ source_id: string; raw_source: string }>(
    `SELECT source_id, frontmatter->>'raw_source' AS raw_source FROM pages
      WHERE slug LIKE 'wiki/personal/reflections/session-%' AND deleted_at IS NULL
        AND source_id IN ('default', $1) ORDER BY source_id`, [other]);
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[basename(r.raw_source)] ??= []).push(r.source_id);
  return out;
}

/** The global maintenance lane's call: one phase, no --source, the configured checkout. */
async function globalSynthesize(home: string) {
  const report = await runCycle(engine, { brainDir: home, phases: ['synthesize'], pull: false, forceGlobalOrphans: true });
  const runs = report.phases.filter(p => p.phase === 'synthesize');
  expect(runs).toHaveLength(1);
  return runs[0]!;
}

describe('global synthesize takes turns over the sources that own captured sessions (#8669)', () => {
  test('two global cycles synthesize both sources\' sessions, one synthesize run per cycle', async () => {
    await fixture(async ({ home, other, spool, meetings, calls }) => {
      const own = sessionCorpusFileName('sess-home', 'default');
      const others = sessionCorpusFileName('sess-other', other);
      writeTranscript(join(spool, own), 'the shared planning calendar');
      writeTranscript(join(spool, others), 'the client renewal terms');
      writeTranscript(join(meetings, 'standup.txt'), 'the weekly standup');
      const done = { [own]: ['default'], 'standup.txt': ['default'], [others]: [other] };

      const first = await globalSynthesize(home);
      expect(first.status).toBe('ok');
      expect(await synthesizedSources(other)).toEqual({ [own]: ['default'], 'standup.txt': ['default'] });
      expect(first.details.source_routing).toMatchObject({ corpus_source_other: { [other]: 1 } });

      const second = await globalSynthesize(home);
      expect(second.status).toBe('ok');
      expect(await synthesizedSources(other)).toEqual(done);
      expect(second.details.source_id).toBe(other);

      const before = calls();
      await globalSynthesize(home);
      await globalSynthesize(home);
      expect(calls()).toBe(before);
      expect(await synthesizedSources(other)).toEqual(done);
    });
  }, 240_000);

  test('an archived source never takes a turn, and its sessions stay held', async () => {
    await fixture(async ({ home, other, spool }) => {
      const own = sessionCorpusFileName('sess-home-2', 'default');
      writeTranscript(join(spool, own), 'the hiring loop');
      writeTranscript(join(spool, sessionCorpusFileName('sess-archived', other)), 'the office move');
      await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [other]);
      await engine.setConfig('dream.synthesize.rotation_turn', other);
      for (let i = 0; i < 3; i++) {
        const run = await globalSynthesize(home);
        expect(run.details.source_routing).toMatchObject({ source_id: 'default', held: { corpus_source_archived: 1 } });
      }
      expect(await synthesizedSources(other)).toEqual({ [own]: ['default'] });
    });
  }, 240_000);
});

describe('the synthesize turn moves forward through every owning source (#8669)', () => {
  const result = (status: PhaseResult['status'], details: Record<string, unknown>): PhaseResult =>
    ({ phase: 'synthesize', status, duration_ms: 0, summary: '', details });
  const routing = (others: string[]) => ({ source_routing: { corpus_source_other: Object.fromEntries(others.map(id => [id, 1])), held: {} } });

  async function withSources(run: (alpha: string, beta: string) => Promise<void>) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-synth-turn-'));
    const suffix = randomUUID().slice(0, 8);
    const [alpha, beta] = [`alpha-${suffix}`, `beta-${suffix}`];
    try {
      for (const id of [alpha, beta]) {
        mkdirSync(join(dir, id));
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [id, join(dir, id)]);
      }
      await engine.setConfig('dream.synthesize.rotation_turn', 'default');
      await run(alpha, beta);
    } finally {
      await engine.executeRaw('DELETE FROM sources WHERE id = ANY($1::text[])', [[alpha, beta]]);
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const step = async (outcome: PhaseResult) => {
    const rotation = (await synthesisRotation(engine, 'default', true))!;
    await rotation.settle(outcome, false);
    return { ran: rotation.turn?.sourceId ?? 'default', next: await engine.getConfig('dream.synthesize.rotation_turn') };
  };

  test('a source whose run fails before discovery passes the turn on instead of back to the cycle\'s own source', async () => {
    await withSources(async (alpha, beta) => {
      expect(await step(result('ok', routing([alpha, beta])))).toEqual({ ran: 'default', next: alpha });
      expect(await step(result('fail', {}))).toEqual({ ran: alpha, next: beta });
      expect(await step(result('ok', routing(['default', alpha])))).toEqual({ ran: beta, next: 'default' });
    });
  });

  test('a cooldown or budget skip keeps the turn', async () => {
    await withSources(async (alpha, beta) => {
      await step(result('ok', routing([alpha, beta])));
      expect(await step(result('skipped', { reason: 'cooldown_active' }))).toEqual({ ran: alpha, next: alpha });
      expect(await step(result('skipped', { reason: 'insufficient_cycle_budget' }))).toEqual({ ran: alpha, next: alpha });
    });
  });
});

