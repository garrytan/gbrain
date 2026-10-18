/**
 * #6786 — `chat_unavailable` is not a finished corpus file.
 *
 * `bootstrap verify` ran the corpus pass with a keyed capability report in a
 * process whose gateway could not serve the extraction model. Every window
 * came back `chat_unavailable`; the window runner recorded its turns as done
 * and the sweep wrote `.ingested {"skipped":"chat_unavailable"}`, so the
 * transcript was never extracted and retention later deleted it.
 *
 * Protects: an unservable model leaves windowed and writeback files pending
 * (no sidecar, no consumed turns) in the sweep and the compact harvest; a
 * file a pre-#6786 build marked that way (with or without `.progress`) is
 * extracted again with its source binding and retired turns kept, and its
 * facts land; retention GC keeps such a file at the un-ingested ceiling in
 * both orders (GC then sweep, sweep then GC); the corpus pass can be skipped.
 *
 * Imports only modules that predate #6786, so it runs against the old tree.
 * Hermetic in-memory PGLite + chat-transport stub (sweep.test.ts harness).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { CORPUS_INGESTED_SUFFIX, runMaintenanceSweep, type SweepReport } from '../src/core/sweep.ts';
import { __setChatTransportForTests, configureGateway, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import { RECIPES } from '../src/core/ai/recipes/index.ts';
import type { CapabilityReport } from '../src/core/capability.ts';
import { toCorpusText } from '../src/core/transcripts/claude-code-jsonl.ts';
import { parseCorpusTurns } from '../src/core/context/corpus-turns.ts';
import { corpusSpoolDir, ensureCorpusSpoolDir, gcCorpusTurnFiles, segmentFileName, writeSegment, appendSegmentLedger, wbFileName } from '../src/core/context/corpus-segments.ts';
import { __drainCheckpointHarvestForTests, __resetCheckpointHarvestForTests, HARVEST_RECEIPT_SUFFIX, scheduleCheckpointHarvest } from '../src/core/context/checkpoint-harvest.ts';
import { withEnv } from './helpers/with-env.ts';

const KEYED: CapabilityReport = {
  embeddings: { available: false },
  extraction: { available: true, provider: 'anthropic' },
  search: 'keyword-only',
  mode: 'keyed',
};
const DAY = 86_400_000;
const RETENTION = 30 * DAY;

let engine: PGLiteEngine;
let dir: string;
let home: string;
const tmpDirs: string[] = [];
let inputs: string[];

const authNames = [...new Set(Array.from(RECIPES.values()).flatMap((recipe) => recipe.auth_env?.required ?? []))];
const noKeys = Object.fromEntries(authNames.map((name) => [name, undefined]));

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
  await engine.executeRaw('DELETE FROM facts').catch(() => {});
  dir = mkdtempSync(join(tmpdir(), 'gbrain-6786-corpus-'));
  home = mkdtempSync(join(tmpdir(), 'gbrain-6786-home-'));
  tmpDirs.push(dir, home);
  await engine.setConfig('dream.synthesize.session_corpus_dir', dir);
  // Writeback turn files extract only while ambient writeback is on.
  await engine.setConfig('memory.auto_writeback', 'salient');
  inputs = [];
  __resetCheckpointHarvestForTests();
});

afterEach(async () => {
  __setChatTransportForTests(null);
  resetGateway();
  await engine.unsetConfig('memory.auto_writeback');
});

/** The verify process: a keyed capability report, but no servable extraction model. */
function unservable(): void {
  __setChatTransportForTests(null);
  configureGateway({ env: {} });
}

/** A working extractor: every window yields one fact naming its first turn marker. */
function servable(): void {
  __setChatTransportForTests(async (request): Promise<ChatResult> => {
    const content = String(request.messages[0].content);
    const text = content.slice(content.indexOf('<turn>\n') + '<turn>\n'.length, content.lastIndexOf('\n</turn>'));
    inputs.push(text);
    const marker = text.match(/\bT\d\d\b/)?.[0] ?? 'WB';
    return {
      text: JSON.stringify({ facts: [{ fact: `Keeps a written log of decision ${marker}`, kind: 'preference', entity: null, confidence: 0.9, notability: 'high' }] }),
      blocks: [], stopReason: 'end',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:test-stub', providerId: 'anthropic',
    };
  });
}

const sweep = (extra: Partial<Parameters<typeof runMaintenanceSweep>[1]> = {}): Promise<SweepReport> =>
  withEnv({ ...noKeys, GBRAIN_HOME: home }, () =>
    runMaintenanceSweep(engine, { sourceId: 'default', capabilities: KEYED, budgetMs: 120_000, batchLimit: 20, ...extra }));

const body = (tag: string, n = 5000): string => {
  let s = `${tag} `;
  while (s.length < n) s += `${tag.toLowerCase()} detail words\n`;
  return s.slice(0, n);
};
const corpus = (count: number): string =>
  toCorpusText(Array.from({ length: count }, (_, i) => ({ role: i % 2 === 0 ? 'user' as const : 'assistant' as const, text: body(`T${String(i).padStart(2, '0')}`) })));
const markers = (texts: string[]): string[] => [...new Set(texts.flatMap((t) => t.match(/\bT\d\d\b/g) ?? []))].sort();
const sidecar = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file + CORPUS_INGESTED_SUFFIX, 'utf8'));
const progress = (file: string): Record<string, any> => JSON.parse(readFileSync(file + '.progress', 'utf8'));
const corpusFacts = async (): Promise<string[]> =>
  (await engine.executeRaw<{ fact: string }>(`SELECT fact FROM facts WHERE source = 'sweep:corpus' ORDER BY fact`)).map((r) => r.fact);
const skipped = (r: SweepReport, reason: string): number => r.skipped.find((s) => s.reason === reason)?.count ?? 0;

function age(file: string, days: number): void {
  const t = new Date(Date.now() - days * DAY);
  utimesSync(file, t, t);
}

/**
 * What a pre-#6786 sweep left behind for a windowed file: every turn recorded
 * as done (one of them retired under writeback off), `finished` at the file's
 * stat, `skipped_reason: chat_unavailable`, the source binding, and the
 * zero-count `.ingested` sidecar.
 */
async function legacyUnavailable(file: string, opts: { progress: boolean; retire?: number }): Promise<{ retired: string | null }> {
  const turns = parseCorpusTurns(readFileSync(file, 'utf8'));
  const retired = opts.retire === undefined ? null : turns[opts.retire].sha256;
  if (opts.progress) {
    const st = statSync(file);
    writeFileSync(file + '.progress', JSON.stringify({
      version: 1, generation: 9,
      turns: turns.map(({ start, end, sha256 }) => ({ start, end, sha256 })),
      continuation: null, windows_done: turns.length,
      finished: { size: st.size, mtime_ms: st.mtimeMs, ino: st.ino },
      totals: { inserted: 0, duplicate: 0, superseded: 0 }, entity_slugs: [],
      skipped_reason: 'chat_unavailable',
      ...(retired ? { retired_turns: [retired] } : {}),
      source: { id: 'default', incarnation: await sourceIncarnation() },
      lease: null,
    }) + '\n');
  }
  writeFileSync(file + CORPUS_INGESTED_SUFFIX,
    JSON.stringify({ ingested_at: new Date().toISOString(), facts_inserted: 0, facts_duplicate: 0, skipped: 'chat_unavailable' }) + '\n');
  return { retired };
}

async function sourceIncarnation(): Promise<string> {
  const [row] = await engine.executeRaw<{ incarnation: string }>(`SELECT incarnation::text AS incarnation FROM sources WHERE id = 'default'`);
  return row.incarnation;
}

describe('#6786: an unservable extraction model leaves corpus files pending', () => {
  test('windowed and writeback files get no sidecar and no consumed turns; the next servable sweep extracts them', async () => {
    const file = join(dir, 'pending-session.txt');
    writeFileSync(file, corpus(3));
    const spool = ensureCorpusSpoolDir(dir);
    const wb = join(spool, wbFileName('sess-wb', 'a'.repeat(24), 'default'));
    writeFileSync(wb, '[user]\nWB I keep a written log of every decision I make.\n');

    unservable();
    const r1 = await sweep();
    expect(r1.corpusIngested).toBe(0);
    expect(existsSync(file + CORPUS_INGESTED_SUFFIX)).toBe(false);
    expect(existsSync(wb + CORPUS_INGESTED_SUFFIX)).toBe(false);
    expect(skipped(r1, 'corpus_chat_unavailable')).toBeGreaterThan(0);
    if (existsSync(file + '.progress')) {
      expect(progress(file).turns).toEqual([]);
      expect(progress(file).finished).toBeNull();
    }

    servable();
    const r2 = await sweep();
    expect(r2.corpusIngested).toBe(2);
    expect(markers(inputs)).toEqual(['T00', 'T01', 'T02']);
    expect(inputs.some((t) => t.includes('written log of every decision'))).toBe(true);
    expect(sidecar(file).skipped).toBeUndefined();
    expect(Number(sidecar(file).facts_inserted)).toBeGreaterThan(0);
    expect((await corpusFacts()).length).toBeGreaterThanOrEqual(3);
  });

  test('the compact harvest writes no receipt and records no window under an unservable model', async () => {
    await withEnv({ ...noKeys, GBRAIN_HOME: home }, async () => {
      const w = writeSegment(dir, 'sess-harvest', corpus(2));
      appendSegmentLedger(dir, 'sess-harvest', w.hash);
      const name = segmentFileName('sess-harvest', w.hash);
      const full = join(dir, name);
      unservable();
      expect(scheduleCheckpointHarvest({ engine, sourceId: 'default', sessionId: 'sess-harvest', corpusDir: dir, file: name, capabilities: KEYED }).status).toBe('scheduled');
      await __drainCheckpointHarvestForTests();
      expect(existsSync(full + CORPUS_INGESTED_SUFFIX)).toBe(false);
      expect(existsSync(full + HARVEST_RECEIPT_SUFFIX)).toBe(false);
      if (existsSync(full + '.progress')) expect(progress(full).turns).toEqual([]);
    });
    servable();
    const r = await sweep();
    expect(r.corpusIngested).toBe(1);
    expect(markers(inputs)).toEqual(['T00', 'T01']);
  });

  test('corpus: false skips the corpus pass (bootstrap verify): no model call, no sidecar', async () => {
    const file = join(dir, 'verify-pending.txt');
    writeFileSync(file, corpus(1));
    servable();
    const r = await sweep({ corpus: false } as never);
    expect(inputs).toEqual([]);
    expect(r.corpusIngested).toBe(0);
    expect(existsSync(file + CORPUS_INGESTED_SUFFIX)).toBe(false);
  });
});

describe('#6786: files a pre-#6786 sweep marked chat_unavailable are extracted again', () => {
  test('a consumed .progress is rewound: extraction runs, facts land, source binding and retired turns stay', async () => {
    const file = join(dir, 'legacy-progress.txt');
    writeFileSync(file, corpus(3));
    const { retired } = await legacyUnavailable(file, { progress: true, retire: 1 });
    const inc = await sourceIncarnation();

    servable();
    const r = await sweep();
    expect(r.corpusIngested).toBe(1);
    expect(markers(inputs)).toEqual(['T00', 'T02']);
    const facts = await corpusFacts();
    expect(facts.some((f) => f.includes('T00'))).toBe(true);
    expect(facts.some((f) => f.includes('T02'))).toBe(true);
    expect(facts.some((f) => f.includes('T01'))).toBe(false);
    expect(sidecar(file).skipped).toBeUndefined();
    expect(Number(sidecar(file).facts_inserted)).toBeGreaterThanOrEqual(2);
    const p = progress(file);
    expect(p.source).toEqual({ id: 'default', incarnation: inc });
    expect(p.retired_turns).toEqual([retired]);
    expect(p.skipped_reason).toBeUndefined();
    expect(p.finished).not.toBeNull();

    inputs = [];
    const again = await sweep();
    expect(inputs).toEqual([]);
    expect(again.corpusIngested).toBe(0);
  });

  test('a pre-window sidecar (no .progress) is not adopted as done: every turn is extracted', async () => {
    const file = join(dir, 'legacy-sidecar-only.txt');
    writeFileSync(file, corpus(2));
    age(file, 1);
    await legacyUnavailable(file, { progress: false });
    servable();
    const r = await sweep();
    expect(r.corpusIngested).toBe(1);
    expect(markers(inputs)).toEqual(['T00', 'T01']);
    expect((await corpusFacts()).length).toBeGreaterThanOrEqual(2);
  });

  test('a writeback turn marked chat_unavailable is extracted again', async () => {
    const spool = ensureCorpusSpoolDir(dir);
    const wb = join(spool, wbFileName('sess-wb-legacy', 'b'.repeat(24), 'default'));
    writeFileSync(wb, '[user]\nWB I keep a written log of every decision I make.\n');
    writeFileSync(wb + CORPUS_INGESTED_SUFFIX, JSON.stringify({ ingested_at: new Date().toISOString(), facts_inserted: 0, facts_duplicate: 0, skipped: 'chat_unavailable' }) + '\n');
    servable();
    const r = await sweep();
    expect(r.corpusIngested).toBe(1);
    expect(inputs.length).toBe(1);
    expect(sidecar(wb).skipped).toBeUndefined();
  });
});

describe('#6786: retention GC keeps a chat_unavailable file until it is extracted', () => {
  test('GC then sweep: an aged chat_unavailable file survives GC, then its facts land', async () => {
    const file = join(dir, 'aged-gc-first.txt');
    writeFileSync(file, corpus(2));
    age(file, 40);
    await legacyUnavailable(file, { progress: true });
    gcCorpusTurnFiles(dir, RETENTION);
    expect(existsSync(file)).toBe(true);
    // Its finished, extracted twin of the same age goes at retention.
    const done = join(dir, 'aged-done.txt');
    writeFileSync(done, corpus(1));
    age(done, 40);
    writeFileSync(done + CORPUS_INGESTED_SUFFIX, JSON.stringify({ ingested_at: new Date().toISOString(), facts_inserted: 1 }) + '\n');
    gcCorpusTurnFiles(dir, RETENTION);
    expect(existsSync(done)).toBe(false);
    expect(existsSync(file)).toBe(true);

    servable();
    const r = await sweep();
    expect(r.corpusIngested).toBe(1);
    expect((await corpusFacts()).some((f) => f.includes('T01'))).toBe(true);
    gcCorpusTurnFiles(dir, RETENTION);
    expect(existsSync(file)).toBe(false);
  });

  test('sweep then GC: an unservable sweep and a partial sweep both leave the aged file at the un-ingested ceiling', async () => {
    const file = join(dir, 'aged-sweep-first.txt');
    writeFileSync(file, corpus(3));
    age(file, 40);
    await legacyUnavailable(file, { progress: true });

    unservable();
    await sweep();
    gcCorpusTurnFiles(dir, RETENTION);
    expect(existsSync(file)).toBe(true);

    servable();
    await withEnv({ GBRAIN_CORPUS_WINDOWS_PER_SWEEP: '1' }, async () => {
      const partial = await sweep();
      expect(partial.corpus_files).toEqual([{ file: 'aged-sweep-first.txt', windows_done: 1, windows_remaining: 2 }]);
    });
    gcCorpusTurnFiles(dir, RETENTION);
    expect(existsSync(file)).toBe(true);

    const r = await sweep();
    expect(r.corpusIngested).toBe(1);
    expect(markers(inputs)).toEqual(['T00', 'T01', 'T02']);
    expect((await corpusFacts()).length).toBeGreaterThanOrEqual(3);
    gcCorpusTurnFiles(dir, RETENTION);
    expect(existsSync(file)).toBe(false);
  });

  test('past the un-ingested ceiling a chat_unavailable file is still deleted (the bound stands)', async () => {
    const file = join(dir, 'aged-past-ceiling.txt');
    writeFileSync(file, corpus(1));
    age(file, 91);
    await legacyUnavailable(file, { progress: true });
    gcCorpusTurnFiles(dir, RETENTION);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(corpusSpoolDir(dir))).toBe(false);
  });
});
