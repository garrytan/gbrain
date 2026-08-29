/**
 * Cathedral 5 (WI5) — the DONE-CRITERION test: post-compaction recall. A fact
 * from the pre-compaction window survives context death via a brain:// link
 * re-pull THROUGH THE SURFACE THE AGENT USES (handleToolCall get_page,
 * trusted-local) — never a raw engine read (raw reads prove storage, not
 * recall). Plus the harvest discipline: claim fencing, receipt-ordered
 * commits, abort-after-partial retryability, gate skips, handler validation.
 *
 * Serial: real PGLite engine + module-global harvest queue + GBRAIN_HOME env.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __setChatTransportForTests, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import { __resetFactsQueueForTests } from '../src/core/facts/queue.ts';
import type { CapabilityReport } from '../src/core/capability.ts';
import { CORPUS_CLAIM_SUFFIX, CORPUS_INGESTED_SUFFIX } from '../src/core/sweep.ts';
import {
  __drainCheckpointHarvestForTests,
  __resetCheckpointHarvestForTests,
  HARVEST_RECEIPT_SUFFIX,
  scheduleCheckpointHarvest,
  shutdownCheckpointHarvest,
} from '../src/core/context/checkpoint-harvest.ts';
import { appendSegmentLedger, segmentFileName, segmentHash, writeSegment } from '../src/core/context/corpus-segments.ts';
import { getCheckpointManifest } from '../src/core/context/session-state.ts';
import { makeContextPackIpcHandler } from '../src/mcp/context-pack-handler.ts';
import { handleToolCall } from '../src/mcp/server.ts';
import { readHeartbeatTail } from '../src/core/context/hook-heartbeat.ts';

const KEYED: CapabilityReport = {
  embeddings: { available: false },
  extraction: { available: true, provider: 'anthropic' },
  search: 'keyword-only',
  mode: 'keyed',
};
const KEYLESS: CapabilityReport = {
  embeddings: { available: false },
  extraction: { available: false },
  search: 'keyword-only',
  mode: 'keyless',
};

let engine: PGLiteEngine;
let corpusDir: string;
let homeDir: string;
let savedHome: string | undefined;
const tmpDirs: string[] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

beforeEach(async () => {
  __resetCheckpointHarvestForTests();
  corpusDir = mkdtempSync(join(tmpdir(), 'gb-ckpt-corpus-'));
  homeDir = mkdtempSync(join(tmpdir(), 'gb-ckpt-home-'));
  tmpDirs.push(corpusDir, homeDir);
  savedHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = homeDir;
  await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
  await engine.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`).catch(() => {});
  await engine.executeRaw('DELETE FROM facts').catch(() => {});
  await engine.executeRaw('DELETE FROM pages').catch(() => {});
  await engine.executeRaw('DELETE FROM session_context_state').catch(() => {});
});

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
  __resetFactsQueueForTests();
  if (savedHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = savedHome;
});

function chatStub(facts: Array<{ fact: string; entity: string | null }>) {
  __setChatTransportForTests(async (): Promise<ChatResult> => ({
    text: JSON.stringify({
      facts: facts.map((f) => ({ fact: f.fact, kind: 'decision', entity: f.entity, confidence: 1.0, notability: 'high' })),
    }),
    blocks: [],
    stopReason: 'end',
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'test:stub',
    providerId: 'test',
  }));
}

/** Bank a segment + ledger entry the way `gbrain hook compact` does. */
function bankSegment(sessionId: string, text: string): { file: string; hash: string } {
  const w = writeSegment(corpusDir, sessionId, text);
  appendSegmentLedger(corpusDir, sessionId, w.hash);
  return { file: segmentFileName(sessionId, w.hash), hash: w.hash };
}

/** Brain repo dir with sources.local_path so fence-writes are enabled. */
async function enableFenceWrites(): Promise<string> {
  const brainDir = mkdtempSync(join(tmpdir(), 'gb-ckpt-brain-'));
  tmpDirs.push(brainDir);
  await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [brainDir]);
  return brainDir;
}

describe('post-compaction recall (the done criterion)', () => {
  test('segment → harvest → truthful manifest → link re-pull via trusted get_page', async () => {
    const brainDir = await enableFenceWrites();
    await engine.putPage('people/alice-example', {
      type: 'person', title: 'Alice Example', compiled_truth: 'Alice Example is a synthetic fixture person.',
    }, { sourceId: 'default' });
    chatStub([
      { fact: 'decided to move the auth check into the middleware', entity: 'people/alice-example' },
      { fact: 'unparented aside that produces no link', entity: null },
    ]);

    const seg = bankSegment('sess-recall', 'User: we decided to move the auth check into the middleware.\n');
    const ack = scheduleCheckpointHarvest({
      engine, sourceId: 'default', sessionId: 'sess-recall', corpusDir, file: seg.file, capabilities: KEYED,
    });
    expect(ack.status).toBe('scheduled');
    await __drainCheckpointHarvestForTests();

    // Facts durable with hook provenance.
    const rows = await engine.executeRaw<{ source: string; source_session: string }>(
      `SELECT source, source_session FROM facts WHERE source = 'hook:compact'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].source_session).toBe('sess-recall');

    // Manifest banked: ONLY the resolvable fence-written link, seg-hash keyed.
    const links = (await getCheckpointManifest(engine, 'default', null, 'sess-recall'))!;
    expect(links).toHaveLength(1);
    expect(links[0].slug).toBe('people/alice-example');
    expect(links[0].title).toBe('Alice Example');
    expect(links[0].seg).toBe(seg.hash);
    expect(links[0].n).toBe(1);

    // Commit order artifacts: .ingested written LAST, receipt consumed, claim released.
    const full = join(corpusDir, seg.file);
    expect(existsSync(full + CORPUS_INGESTED_SUFFIX)).toBe(true);
    expect(existsSync(full + HARVEST_RECEIPT_SUFFIX)).toBe(false);
    expect(existsSync(full + CORPUS_CLAIM_SUFFIX)).toBe(false);

    // THE RECALL: re-pull the link through the agent's actual surfaces
    // (trusted-local handleToolCall) — raw engine reads would prove storage,
    // not recall. get_page proves the brain:// link RESOLVES; the `recall`
    // memory verb proves the FACT survived context death (fence-writes are
    // file-first by design — the DB page body catches up at sync, while the
    // fact row is queryable immediately).
    const page = await handleToolCall(engine, 'get_page', { slug: links[0].slug }, { sourceId: 'default' });
    expect(JSON.stringify(page)).toContain('Alice Example');
    const recalled = await handleToolCall(
      engine, 'recall', { entity: 'people/alice-example', budget_tokens: 2000 }, { sourceId: 'default' },
    );
    expect(JSON.stringify(recalled)).toContain('auth check into the middleware');
    // The fence itself IS on disk (system-of-record) for the next sync.
    const fenceFile = readFileSync(join(brainDir, 'people/alice-example.md'), 'utf8');
    expect(fenceFile).toContain('auth check into the middleware');

    // Heartbeat telemetry: counts + codes only.
    const hb = (await readHeartbeatTail(5)).find((e) => e.event === 'checkpoint-harvest');
    expect(hb?.outcome).toBe('ok');
    expect(hb?.inserted).toBeGreaterThan(0);
    expect(hb?.links).toBe(1);
    expect(JSON.stringify(hb)).not.toContain('alice-example'); // never slugs [S3#7]
  });

  test('receipt retry publishes the manifest WITHOUT re-extracting (no chat transport needed)', async () => {
    await engine.putPage('people/charlie-example', {
      type: 'person', title: 'Charlie Example', compiled_truth: 'Synthetic fixture.',
    }, { sourceId: 'default' });
    // No chatStub: extraction would throw. The receipt path must not extract.
    const seg = bankSegment('sess-receipt', 'window text already extracted last time\n');
    const full = join(corpusDir, seg.file);
    writeFileSync(full + HARVEST_RECEIPT_SUFFIX, JSON.stringify({
      session_id: 'sess-receipt', seg: seg.hash, links: ['people/charlie-example'], ts: new Date().toISOString(),
    }) + '\n');

    scheduleCheckpointHarvest({
      engine, sourceId: 'default', sessionId: 'sess-receipt', corpusDir, file: seg.file, capabilities: KEYED,
    });
    await __drainCheckpointHarvestForTests();

    const links = (await getCheckpointManifest(engine, 'default', null, 'sess-receipt'))!;
    expect(links.map((l) => l.slug)).toEqual(['people/charlie-example']);
    const ingested = JSON.parse(readFileSync(full + CORPUS_INGESTED_SUFFIX, 'utf8')) as { from_receipt?: boolean };
    expect(ingested.from_receipt).toBe(true);
    expect(existsSync(full + HARVEST_RECEIPT_SUFFIX)).toBe(false);
  });

  test('manifest publish failure keeps the receipt, skips .ingested, and the retry recovers (adversarial review)', async () => {
    await engine.putPage('people/dora-example', {
      type: 'person', title: 'Dora Example', compiled_truth: 'Synthetic fixture.',
    }, { sourceId: 'default' });
    const seg = bankSegment('sess-mfail', 'window text extracted; publish will fail\n');
    const full = join(corpusDir, seg.file);
    writeFileSync(full + HARVEST_RECEIPT_SUFFIX, JSON.stringify({
      session_id: 'sess-mfail', seg: seg.hash, links: ['people/dora-example'], ts: new Date().toISOString(),
    }) + '\n');

    // Force the publish to fail: pre-v132 shape (column missing).
    await engine.executeRaw('ALTER TABLE session_context_state DROP COLUMN checkpoint_manifest');
    try {
      scheduleCheckpointHarvest({
        engine, sourceId: 'default', sessionId: 'sess-mfail', corpusDir, file: seg.file, capabilities: KEYED,
      });
      await __drainCheckpointHarvestForTests();
      // Receipt kept (the only durable copy of the links), no .ingested —
      // deleting either here would lose the links forever.
      expect(existsSync(full + HARVEST_RECEIPT_SUFFIX)).toBe(true);
      expect(existsSync(full + CORPUS_INGESTED_SUFFIX)).toBe(false);
      const hb = (await readHeartbeatTail(5)).find((e) => e.event === 'checkpoint-harvest');
      expect(hb?.outcome).toBe('degraded');
      expect(hb?.reason).toBe('manifest_failed');
    } finally {
      await engine.executeRaw(
        `ALTER TABLE session_context_state ADD COLUMN checkpoint_manifest JSONB NOT NULL DEFAULT '[]'::jsonb`,
      );
    }

    // Retry after recovery: publishes from the receipt (no extraction), cleans up.
    scheduleCheckpointHarvest({
      engine, sourceId: 'default', sessionId: 'sess-mfail', corpusDir, file: seg.file, capabilities: KEYED,
    });
    await __drainCheckpointHarvestForTests();
    const links = (await getCheckpointManifest(engine, 'default', null, 'sess-mfail'))!;
    expect(links.map((l) => l.slug)).toEqual(['people/dora-example']);
    expect(existsSync(full + HARVEST_RECEIPT_SUFFIX)).toBe(false);
    expect(existsSync(full + CORPUS_INGESTED_SUFFIX)).toBe(true);
  });

  test('non-resolvable link candidates are never banked (truthful links)', async () => {
    await enableFenceWrites();
    // Receipt names a slug whose page does NOT exist.
    const seg = bankSegment('sess-lies', 'text\n');
    const full = join(corpusDir, seg.file);
    writeFileSync(full + HARVEST_RECEIPT_SUFFIX, JSON.stringify({
      session_id: 'sess-lies', seg: seg.hash, links: ['people/nobody-here'], ts: new Date().toISOString(),
    }) + '\n');
    scheduleCheckpointHarvest({
      engine, sourceId: 'default', sessionId: 'sess-lies', corpusDir, file: seg.file, capabilities: KEYED,
    });
    await __drainCheckpointHarvestForTests();
    expect(await getCheckpointManifest(engine, 'default', null, 'sess-lies')).toEqual([]);
    expect(existsSync(full + CORPUS_INGESTED_SUFFIX)).toBe(true); // still done — facts durable regardless
  });
});

describe('harvest discipline', () => {
  test('abort mid-pipeline writes NOTHING and stays retryable (post-check on partial-returning pipeline)', async () => {
    __setChatTransportForTests(async (): Promise<ChatResult> => {
      await new Promise((r) => setTimeout(r, 200)); // outlive the 1ms budget
      return {
        text: JSON.stringify({ facts: [] }), blocks: [], stopReason: 'end',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'test:stub', providerId: 'test',
      };
    });
    const seg = bankSegment('sess-abort', 'window that will be aborted\n');
    const full = join(corpusDir, seg.file);
    scheduleCheckpointHarvest({
      engine, sourceId: 'default', sessionId: 'sess-abort', corpusDir, file: seg.file,
      capabilities: KEYED, timeoutMs: 1,
    });
    await __drainCheckpointHarvestForTests();
    expect(existsSync(full + HARVEST_RECEIPT_SUFFIX)).toBe(false);
    expect(existsSync(full + CORPUS_INGESTED_SUFFIX)).toBe(false);
    expect(existsSync(full + CORPUS_CLAIM_SUFFIX)).toBe(false); // released — retryable
    const hb = (await readHeartbeatTail(5)).find((e) => e.event === 'checkpoint-harvest');
    expect(hb?.reason).toBe('aborted');
  });

  test('keyless capability gate skips cleanly: no sidecars, claim released, typed reason', async () => {
    const seg = bankSegment('sess-keyless', 'text\n');
    const full = join(corpusDir, seg.file);
    scheduleCheckpointHarvest({
      engine, sourceId: 'default', sessionId: 'sess-keyless', corpusDir, file: seg.file, capabilities: KEYLESS,
    });
    await __drainCheckpointHarvestForTests();
    expect(existsSync(full + CORPUS_INGESTED_SUFFIX)).toBe(false); // sweep retries when a key appears
    expect(existsSync(full + CORPUS_CLAIM_SUFFIX)).toBe(false);
    const hb = (await readHeartbeatTail(5)).find((e) => e.event === 'checkpoint-harvest');
    expect(hb?.reason).toBe('keyless');
  });

  test('shutdown drops the queue and refuses new work (serve-lifecycle seam)', async () => {
    await shutdownCheckpointHarvest();
    const ack = scheduleCheckpointHarvest({
      engine, sourceId: 'default', sessionId: 's', corpusDir, file: 's.seg-abc.txt', capabilities: KEYED,
    });
    expect(ack).toEqual({ status: 'skipped', reason: 'shutting_down' });
  });
});

describe('context_pack handler arms', () => {
  test('bankOnly + flushCorpusFile: bad basename / traversal / missing file are typed skips; valid file schedules', async () => {
    const handler = makeContextPackIpcHandler(engine, 'default');
    const base = { kind: 'context_pack' as const, protocol: 2 as const, secret: 's', sessionId: 'sess-h', bankOnly: true, window: [{ role: 'user' as const, text: 'acme-example ships widgets' }] };

    const bad = await handler({ ...base, flushCorpusFile: '../../etc/passwd.txt' });
    expect(bad?.checkpointFlush).toEqual({ status: 'skipped', reason: 'bad_basename' });
    const slash = await handler({ ...base, flushCorpusFile: 'x/y.txt' });
    expect(slash?.checkpointFlush).toEqual({ status: 'skipped', reason: 'bad_basename' });
    const missing = await handler({ ...base, flushCorpusFile: 'sess-h.seg-nothere.txt' });
    expect(missing?.checkpointFlush).toEqual({ status: 'skipped', reason: 'not_found' });

    // Stub the transport BEFORE scheduling: pump() starts the job
    // synchronously, so a shutdown race cannot reliably beat it — with
    // ambient provider keys that would be a REAL LLM call (pre-landing
    // review, testing). The stub makes the drain fast and spend-free.
    chatStub([]);
    const seg = bankSegment('sess-h', 'handler text\n');
    const ok = await handler({ ...base, flushCorpusFile: seg.file });
    expect(ok?.checkpointFlush?.status).toBe('scheduled');
    await __drainCheckpointHarvestForTests();
  });

  test('manifestOnly returns links and is side-effect-free (no cursor advance, no banking) [REGRESSION PIN]', async () => {
    const handler = makeContextPackIpcHandler(engine, 'default');
    await engine.executeRaw(
      `INSERT INTO session_context_state (source_id, client_id, session_id, checkpoint_manifest, last_wake_at)
       VALUES ('default', 'local', 'sess-m', $1::text::jsonb, now() - interval '1 hour')`,
      [JSON.stringify([{ slug: 'a', title: 'A', at: new Date().toISOString(), n: 1, seg: 'h1' }])],
    );
    const before = await engine.executeRaw<{ last_wake_at: string; standing_entities: unknown }>(
      `SELECT last_wake_at::text AS last_wake_at, standing_entities FROM session_context_state WHERE session_id = 'sess-m'`,
    );
    const res = await handler({
      kind: 'context_pack', protocol: 2, secret: 's', sessionId: 'sess-m', manifestOnly: true,
      window: [{ role: 'user', text: 'should not be banked' }],
      entities: ['should-not-be-banked'],
    });
    expect(res?.checkpointLinks?.map((l) => l.slug)).toEqual(['a']);
    expect(res?.text).toBe('');
    const after = await engine.executeRaw<{ last_wake_at: string; standing_entities: unknown }>(
      `SELECT last_wake_at::text AS last_wake_at, standing_entities FROM session_context_state WHERE session_id = 'sess-m'`,
    );
    expect(after[0].last_wake_at).toBe(before[0].last_wake_at);
    expect(after[0].standing_entities).toEqual(before[0].standing_entities);
  });
});

describe('pack rendering (cathedral 5)', () => {
  test('[REGRESSION PIN] renderPack WITHOUT checkpoint links is byte-identical to the pre-cathedral-5 shape', async () => {
    const { renderPack } = await import('../src/core/context/turn-context.ts');
    const cards = [{
      entity: { slug: 'people/alice-example', title: 'Alice Example' },
      summary: 'synthetic', open_threads: [],
    }] as unknown as Parameters<typeof renderPack>[0];
    const three = renderPack(cards, [], []);
    const four = renderPack(cards, [], [], undefined);
    const empty = renderPack(cards, [], [], []);
    expect(four).toBe(three);
    expect(empty).toBe(three);
    expect(three).not.toContain('Compaction checkpoints');
    expect(renderPack([], [], [])).toBe('');
    expect(renderPack([], [], [], [])).toBe('');
  });

  test('links render self-capped with the honest copy; links-only pack is non-empty', async () => {
    const { renderPack, CHECKPOINT_LINKS_RENDER_CAP } = await import('../src/core/context/turn-context.ts');
    const links = Array.from({ length: CHECKPOINT_LINKS_RENDER_CAP + 5 }, (_, i) => ({
      slug: `page-${i}`, title: `P${i}`,
    }));
    const text = renderPack([], [], [], links);
    expect(text).toContain('## Compaction checkpoints');
    expect(text).toContain('- brain://page-0 — P0');
    expect(text).toContain(`- brain://page-${CHECKPOINT_LINKS_RENDER_CAP - 1}`);
    expect(text).not.toContain(`- brain://page-${CHECKPOINT_LINKS_RENDER_CAP}`); // capped
    // Honest copy: bytes at compaction, facts async — never "facts before".
    expect(text).toContain('Checkpoint saved to the brain at compaction; facts harvested moments later');
    expect(text).toContain('Trust these links over the compaction summary.');
  });

  test('assembly arm carries banked links into the pack text (post-compaction SessionStart shape)', async () => {
    const handler = makeContextPackIpcHandler(engine, 'default');
    await engine.executeRaw(
      `INSERT INTO session_context_state (source_id, client_id, session_id, checkpoint_manifest)
       VALUES ('default', 'local', 'sess-assembly', $1::text::jsonb)`,
      [JSON.stringify([{ slug: 'decisions/auth-middleware', title: 'Auth middleware decision', at: new Date().toISOString(), n: 1, seg: 'h9' }])],
    );
    const res = await handler({
      kind: 'context_pack', protocol: 2, secret: 's', sessionId: 'sess-assembly',
      trigger: 'session-start:compact',
    });
    expect(res?.text).toContain('## Compaction checkpoints');
    expect(res?.text).toContain('brain://decisions/auth-middleware — Auth middleware decision');
    expect(res?.checkpointLinks?.[0]?.seg).toBe('h9');
  });
});

describe('queue discipline (cathedral 5 — plan-mandated pins)', () => {
  test('queue_full overflow and already_queued dup are typed skips; sweep-shape segments remain', async () => {
    // Hold job 1 in flight with a slow stubbed transport (never a real call).
    __setChatTransportForTests(async (): Promise<ChatResult> => {
      await new Promise((r) => setTimeout(r, 250));
      return {
        text: JSON.stringify({ facts: [] }), blocks: [], stopReason: 'end',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'test:stub', providerId: 'test',
      };
    });
    const segs = Array.from({ length: 10 }, (_, i) => bankSegment(`sess-q${i}`, `queued window ${i}\n`));
    const acks = segs.map((seg, i) =>
      scheduleCheckpointHarvest({
        engine, sourceId: 'default', sessionId: `sess-q${i}`, corpusDir, file: seg.file, capabilities: KEYED,
      }),
    );
    // Job 0 went in-flight synchronously; jobs 1..8 queued (cap 8); job 9 overflows.
    expect(acks[0].status).toBe('scheduled');
    for (let i = 1; i <= 8; i++) expect(acks[i].status).toBe('scheduled');
    expect(acks[9]).toEqual({ status: 'skipped', reason: 'queue_full' });
    // Duplicate of a QUEUED file is a typed skip too.
    const dup = scheduleCheckpointHarvest({
      engine, sourceId: 'default', sessionId: 'sess-q1', corpusDir, file: segs[1].file, capabilities: KEYED,
    });
    expect(dup).toEqual({ status: 'skipped', reason: 'already_queued' });
    await __drainCheckpointHarvestForTests();
    // The overflowed segment is still a plain .txt in the corpus dir — the
    // sweep backstop extracts it later (no .ingested was written for it).
    expect(existsSync(join(corpusDir, segs[9].file))).toBe(true);
    expect(existsSync(join(corpusDir, segs[9].file + CORPUS_INGESTED_SUFFIX))).toBe(false);
  }, 30_000);
});
