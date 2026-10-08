/**
 * #6091 / W2.1: an explicit `memory.auto_writeback off` stops every ambient
 * capture lane — the serve compact harvest, the sweep's `.seg-` backstop and
 * (D1) the SessionEnd `<sid>.txt` transcript lane — while an unset value keeps
 * today's behavior for the compact and SessionEnd lanes. Read errors, plane
 * drift and invalid modes hold (no extraction, nothing terminal). A file banked
 * under explicit off is never extracted later, even after the operator turns
 * writeback back on, and a resumed session extracts only its new turns.
 *
 * Serial: real PGLite engines, module-global harvest queue, GBRAIN_HOME env.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __setChatTransportForTests, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import { __resetFactsQueueForTests } from '../src/core/facts/queue.ts';
import type { CapabilityReport } from '../src/core/capability.ts';
import { CORPUS_INGESTED_SUFFIX, runMaintenanceSweep } from '../src/core/sweep.ts';
import { __drainCheckpointHarvestForTests, __resetCheckpointHarvestForTests, scheduleCheckpointHarvest } from '../src/core/context/checkpoint-harvest.ts';
import { appendSegmentLedger, gcCorpusArtifacts, segmentFileName, writeSegment } from '../src/core/context/corpus-segments.ts';
import { brainIdentity, recordCaptureIfOff } from '../src/core/context/capture-consent.ts';
import { parseCorpusTurns } from '../src/core/context/corpus-turns.ts';
import { runHook } from '../src/commands/hook.ts';
import { discoverTranscripts } from '../src/core/cycle/transcript-discovery.ts';

const KEYED: CapabilityReport = {
  embeddings: { available: false },
  extraction: { available: true, provider: 'anthropic' },
  search: 'keyword-only',
  mode: 'keyed',
};

let engine: PGLiteEngine;
let homeDir: string;
let corpusDir: string;
let savedHome: string | undefined;
const tmpDirs: string[] = [];
let prompts: string[] = [];
let onCall: (() => Promise<void>) | null = null;

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
  homeDir = mkdtempSync(join(tmpdir(), 'gb-consent-home-'));
  tmpDirs.push(homeDir);
  savedHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = homeDir;
  corpusDir = join(homeDir, '.gbrain', 'transcripts', 'corpus');
  mkdirSync(corpusDir, { recursive: true });
  await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
  await engine.unsetConfig('memory.auto_writeback');
  await engine.executeRaw('DELETE FROM facts').catch(() => {});
  prompts = [];
  onCall = null;
  __setChatTransportForTests(async (opts): Promise<ChatResult> => {
    prompts.push(JSON.stringify(opts));
    if (onCall) await onCall();
    return {
      text: JSON.stringify({ facts: [{ fact: 'chose the blue deployment window', kind: 'decision', entity: null, confidence: 1, notability: 'high' }] }),
      blocks: [],
      stopReason: 'end',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'test:stub',
      providerId: 'test',
    };
  });
});

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
  __resetFactsQueueForTests();
  if (savedHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = savedHome;
});

/** Both planes, the way `gbrain config set memory.auto_writeback <mode>` writes them. */
async function setMode(mode: string | null, opts: { db?: boolean; file?: boolean } = {}): Promise<void> {
  const cfgPath = join(homeDir, '.gbrain', 'config.json');
  if (opts.file !== false) {
    writeFileSync(cfgPath, JSON.stringify({ engine: 'pglite', ...(mode === null ? {} : { memory: { auto_writeback: mode } }) }) + '\n');
  }
  if (opts.db !== false) {
    if (mode === null) await engine.unsetConfig('memory.auto_writeback');
    else await engine.setConfig('memory.auto_writeback', mode);
  }
}

function bankSegment(sessionId: string, text: string): string {
  const w = writeSegment(corpusDir, sessionId, text);
  appendSegmentLedger(corpusDir, sessionId, w.hash);
  return segmentFileName(sessionId, w.hash);
}

async function factCount(source: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM facts WHERE source = $1`, [source]);
  return Number(rows[0]?.n ?? 0);
}

function sidecar(name: string): Record<string, unknown> | null {
  const p = join(corpusDir, name + CORPUS_INGESTED_SUFFIX);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

async function harvest(file: string, sessionId: string): Promise<void> {
  scheduleCheckpointHarvest({ engine, sourceId: 'default', sessionId, corpusDir, file, capabilities: KEYED });
  await __drainCheckpointHarvestForTests();
}

const sweep = () => runMaintenanceSweep(engine, { sourceId: 'default', capabilities: KEYED, budgetMs: 30_000 });

const corpusText = (turns: string[]): string =>
  turns.map((t, i) => `${i % 2 === 0 ? '[user]' : '[assistant]'}\n${t}`).join('\n\n') + '\n';

/** A Claude Code transcript + `gbrain hook session-end`, exactly as the harness runs it. */
async function sessionEnd(sessionId: string, turns: string[]): Promise<void> {
  const projects = join(homeDir, 'claude', 'projects', 'p1');
  mkdirSync(projects, { recursive: true });
  mkdirSync(join(homeDir, 'ws'), { recursive: true });
  const transcript = join(projects, `${sessionId}.jsonl`);
  writeFileSync(transcript, turns.map((t, i) => i % 2 === 0
    ? JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: t } })
    : JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: t }] } }),
  ).join('\n') + '\n');
  expect(await runHook(['session-end'], {
    stdin: JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: join(homeDir, 'ws') }),
    transcriptRoot: join(homeDir, 'claude', 'projects'),
    spawnPush: () => {},
    spawnBackupCheck: () => {},
  })).toBe(0);
}

describe('explicit off stops every ambient lane (#6091)', () => {
  test('serve compact harvest: zero provider calls, terminal writeback_off sidecar', async () => {
    await setMode('off');
    const file = bankSegment('sess-c1', 'User: we picked the blue deployment window.\n');
    await harvest(file, 'sess-c1');
    expect(prompts.length).toBe(0);
    expect(await factCount('hook:compact')).toBe(0);
    expect(sidecar(file)?.skipped).toBe('writeback_off');
  });

  test('sweep backstop on a .seg- segment: zero provider calls, sidecar written', async () => {
    await setMode('off');
    const file = bankSegment('sess-c2', 'User: we picked the blue deployment window.\n');
    await sweep();
    expect(prompts.length).toBe(0);
    expect(await factCount('sweep:corpus')).toBe(0);
    expect(sidecar(file)?.skipped).toBe('writeback_off');
  });

  test('D1: the SessionEnd <sid>.txt transcript lane stops under explicit off', async () => {
    await setMode('off');
    writeFileSync(join(corpusDir, 'sess-c3.txt'), corpusText(['we picked the blue deployment window', 'noted']));
    await sweep();
    expect(prompts.length).toBe(0);
    expect(await factCount('sweep:corpus')).toBe(0);
    expect(sidecar('sess-c3.txt')?.skipped).toBe('writeback_off');
  });

  test('explicit off retires even on a keyless brain', async () => {
    await setMode('off');
    writeFileSync(join(corpusDir, 'sess-c4.txt'), corpusText(['we picked the blue deployment window', 'noted']));
    await runMaintenanceSweep(engine, {
      sourceId: 'default', budgetMs: 30_000,
      capabilities: { embeddings: { available: false }, extraction: { available: false }, search: 'keyword-only', mode: 'keyless' },
    });
    expect(sidecar('sess-c4.txt')?.skipped).toBe('writeback_off');
  });
});

describe('unset keeps today\'s behavior for the compact and SessionEnd lanes', () => {
  test('compact harvest extracts on unset', async () => {
    await setMode(null);
    const file = bankSegment('sess-u1', 'User: we picked the blue deployment window.\n');
    await harvest(file, 'sess-u1');
    expect(prompts.length).toBe(1);
    expect(await factCount('hook:compact')).toBe(1);
  });

  test('SessionEnd transcript extracts on unset', async () => {
    await setMode(null);
    writeFileSync(join(corpusDir, 'sess-u2.txt'), corpusText(['we picked the blue deployment window', 'noted']));
    await sweep();
    expect(prompts.length).toBe(1);
    expect(await factCount('sweep:corpus')).toBe(1);
  });
});

describe('incoherent config holds: nothing extracted, nothing terminal', () => {
  test('invalid mode value holds the compact and SessionEnd lanes', async () => {
    await setMode('sometimes');
    const seg = bankSegment('sess-h1', 'User: we picked the blue deployment window.\n');
    writeFileSync(join(corpusDir, 'sess-h1.txt'), corpusText(['we picked the blue deployment window', 'noted']));
    await harvest(seg, 'sess-h1');
    await sweep();
    expect(prompts.length).toBe(0);
    expect(sidecar(seg)).toBeNull();
    expect(sidecar('sess-h1.txt')).toBeNull();
  });

  test('plane drift (DB row absent, file mirror on) holds', async () => {
    await setMode('salient', { db: false });
    writeFileSync(join(corpusDir, 'sess-h2.txt'), corpusText(['we picked the blue deployment window', 'noted']));
    await sweep();
    expect(prompts.length).toBe(0);
    expect(sidecar('sess-h2.txt')).toBeNull();
  });

  test('a failed dual-write of off (DB row absent, file mirror off) holds, never extracts', async () => {
    await setMode('off', { db: false });
    const seg = bankSegment('sess-h3', 'User: we picked the blue deployment window.\n');
    await harvest(seg, 'sess-h3');
    expect(prompts.length).toBe(0);
    expect(sidecar(seg)).toBeNull();
  });
});

describe('durable revocation: a capture under off never extracts later', () => {
  test('off then on with the worker stopped: the off-period transcript is never extracted', async () => {
    await setMode('off');
    await sessionEnd('sess-r1', ['we picked the blue deployment window', 'noted']);
    expect(existsSync(join(corpusDir, 'sess-r1.txt'))).toBe(true);
    await setMode('salient');
    await sweep();
    expect(prompts.length).toBe(0);
    expect(await factCount('sweep:corpus')).toBe(0);
  });

  test('resumed session: off-period turns stay retired, turns banked under on extract', async () => {
    await setMode('off');
    await sessionEnd('sess-r2', ['old secret plan alpha', 'ack alpha']);
    await setMode('salient');
    await sessionEnd('sess-r2', ['old secret plan alpha', 'ack alpha', 'new public plan beta', 'ack beta']);
    await sweep();
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain('new public plan beta');
    expect(prompts[0]).not.toContain('old secret plan alpha');
  });

  test('a rewrite that puts earlier on-period turns before the off-period turns still never extracts them', async () => {
    await setMode('off');
    await sessionEnd('sess-r5', ['old secret plan alpha', 'ack alpha']);
    await sweep();
    expect(prompts.length).toBe(0);
    await setMode('salient');
    await sessionEnd('sess-r5', ['earlier public plan zeta', 'ack zeta', 'old secret plan alpha', 'ack alpha', 'new public plan beta', 'ack beta']);
    await sweep();
    const sent = prompts.join('\n');
    expect(sent).toContain('earlier public plan zeta');
    expect(sent).toContain('new public plan beta');
    expect(sent).not.toContain('old secret plan alpha');
    expect(sent).not.toContain('ack alpha');
  });

  test('a worker-side retire is honored when the rewrite puts new turns first', async () => {
    await setMode('off');
    const full = join(corpusDir, 'sess-r6.txt');
    writeFileSync(full, corpusText(['old secret plan alpha', 'ack alpha']));
    await sweep();
    expect(sidecar('sess-r6.txt')?.skipped).toBe('writeback_off');
    await setMode('salient');
    writeFileSync(full, corpusText(['earlier public plan zeta', 'ack zeta', 'old secret plan alpha', 'ack alpha']));
    rmSync(full + CORPUS_INGESTED_SUFFIX, { force: true });
    await sweep();
    const sent = prompts.join('\n');
    expect(sent).toContain('earlier public plan zeta');
    expect(sent).not.toContain('old secret plan alpha');
  });

  test('appended turns after a worker-side retire: only the new turns extract', async () => {
    await setMode('off');
    const full = join(corpusDir, 'sess-r3.txt');
    writeFileSync(full, corpusText(['old secret plan alpha', 'ack alpha']));
    await sweep();
    expect(sidecar('sess-r3.txt')?.skipped).toBe('writeback_off');
    await setMode('salient');
    writeFileSync(full, corpusText(['old secret plan alpha', 'ack alpha', 'new public plan beta', 'ack beta']));
    rmSync(full + CORPUS_INGESTED_SUFFIX, { force: true });
    await sweep();
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain('new public plan beta');
    expect(prompts[0]).not.toContain('old secret plan alpha');
  });

  test('off set while a provider call is in flight: nothing is published', async () => {
    await setMode('salient');
    writeFileSync(join(corpusDir, 'sess-r4.txt'), corpusText(['we picked the blue deployment window', 'noted']));
    onCall = async () => { await setMode('off'); };
    await sweep();
    expect(prompts.length).toBe(1);
    expect(await factCount('sweep:corpus')).toBe(0);
  });
});

describe('two brains on one machine', () => {
  let other: PGLiteEngine;
  let homeB: string;
  beforeAll(async () => {
    other = new PGLiteEngine();
    await other.connect({});
    await other.initSchema();
  }, 120_000);
  afterAll(async () => { await other.disconnect(); });
  beforeEach(async () => {
    homeB = mkdtempSync(join(tmpdir(), 'gb-consent-homeB-'));
    tmpDirs.push(homeB);
    mkdirSync(join(homeB, '.gbrain', 'transcripts', 'corpus'), { recursive: true });
    writeFileSync(join(homeB, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', memory: { auto_writeback: 'salient' } }) + '\n');
    await other.setConfig('memory.auto_writeback', 'salient');
    await other.executeRaw('DELETE FROM facts').catch(() => {});
  });
  const asBrainB = async <T>(fn: () => Promise<T>): Promise<T> => {
    const homeA = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = homeB;
    try { return await fn(); } finally { process.env.GBRAIN_HOME = homeA; }
  };

  test('each brain applies its own mode to its own captures', async () => {
    await setMode('off');
    await sessionEnd('sess-m1', ['alpha said to brain A', 'ack']);
    await asBrainB(async () => {
      await other.setConfig('dream.synthesize.session_corpus_dir', join(homeB, '.gbrain', 'transcripts', 'corpus'));
      await sessionEnd('sess-m2', ['beta said to brain B', 'ack']);
    });
    await sweep();
    expect(prompts.length).toBe(0);
    await asBrainB(() => runMaintenanceSweep(other, { sourceId: 'default', capabilities: KEYED, budgetMs: 30_000 }));
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain('beta said to brain B');
  });

  // W4.2: two brains whose hooks bank the same session file in one shared corpus directory.
  const OFF = { engine: 'pglite', memory: { auto_writeback: 'off' } } as never;
  const shared = (sessionId: string, turns: string[]) => {
    const file = join(corpusDir, `${sessionId}.txt`);
    return { file, text: corpusText(turns) };
  };

  test('W4.2: brain B capturing under off never erases brain A\'s off record for the same file', async () => {
    await setMode('off');
    const { file, text } = shared('sess-w42a', ['delta said to brain A under off', 'ack']);
    recordCaptureIfOff(OFF, file, text);
    await asBrainB(async () => { recordCaptureIfOff(OFF, file, text + '\n[user]\nepsilon said to brain B\n'); });
    writeFileSync(file, text);
    await setMode('salient');
    await sweep();
    expect(prompts.length).toBe(0);
  });

  test('W4.2: a pre-upgrade record of this brain is unioned on the first per-brain write and survives an older writer replacing it', async () => {
    await setMode('off');
    const { file, text } = shared('sess-w42b', ['zeta said to brain A before the upgrade', 'ack']);
    const legacy = file + '.capture-off.json';
    writeFileSync(legacy, JSON.stringify({ version: 1, brain: brainIdentity(), source: null, at: new Date().toISOString(),
      turns: parseCorpusTurns(text).map((t) => t.sha256) }) + '\n');
    const later = text + '\n[user]\neta said to brain A after the upgrade\n';
    recordCaptureIfOff(OFF, file, later);
    // An older gbrain on brain B still writes the single legacy file and drops A's turns from it.
    await asBrainB(async () => {
      writeFileSync(legacy, JSON.stringify({ version: 1, brain: brainIdentity(), source: null, at: new Date().toISOString(), turns: [] }) + '\n');
    });
    writeFileSync(file, later);
    await setMode('salient');
    await sweep();
    expect(prompts.length).toBe(0);
  });

  test('W4.2: an unreadable capture-off record holds the file instead of reading as "no record"', async () => {
    const { file, text } = shared('sess-w42c', ['theta said under off, record later corrupted', 'ack']);
    writeFileSync(file + '.capture-off.json', '{"version":1,"brain":');
    writeFileSync(file, text);
    await setMode('salient');
    await sweep();
    expect(prompts.length).toBe(0);
    expect(() => recordCaptureIfOff(OFF, file, text)).toThrow(/unreadable/);
  });

  test('W4.2: GC reaps any brain\'s orphaned record only past the grace period and keeps a live file\'s records', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gb-consent-gc-'));
    tmpDirs.push(dir);
    const old = new Date(Date.now() - 60 * 60 * 1000);
    const orphanB = join(dir, 'gone.txt.capture-off.bbbbbbbbbbbbbbbbbbbbbbbb.json');
    const freshB = join(dir, 'pending.txt.capture-off.bbbbbbbbbbbbbbbbbbbbbbbb.json');
    const liveA = join(dir, 'live.txt.capture-off.aaaaaaaaaaaaaaaaaaaaaaaa.json');
    for (const p of [orphanB, freshB, liveA]) writeFileSync(p, '{}\n');
    writeFileSync(join(dir, 'live.txt'), '[user]\nhi\n');
    utimesSync(orphanB, old, old);
    utimesSync(liveA, old, old);
    gcCorpusArtifacts(dir, 24 * 60 * 60 * 1000, []);
    expect(existsSync(orphanB)).toBe(false);
    expect(existsSync(freshB)).toBe(true);
    expect(existsSync(liveA)).toBe(true);
  });

  test('pin: a capture record written by another brain in a shared corpus directory is ignored', async () => {
    await setMode('off');
    await sessionEnd('sess-m3', ['gamma in the shared directory', 'ack']);
    await asBrainB(async () => {
      await other.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
      await runMaintenanceSweep(other, { sourceId: 'default', capabilities: KEYED, budgetMs: 30_000 });
    });
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain('gamma in the shared directory');
  });
});

describe('dream synthesis never reads off-period turns', () => {
  test('discovery drops turns captured under off and skips a file holding nothing else', async () => {
    await setMode('off');
    await sessionEnd('sess-d1', ['old secret plan alpha', 'ack alpha']);
    await sessionEnd('sess-d2', ['private plan gamma', 'ack gamma']);
    await setMode('salient');
    await sessionEnd('sess-d1', ['earlier public plan zeta', 'ack zeta', 'old secret plan alpha', 'ack alpha', 'new public plan beta', 'ack beta']);
    const found = discoverTranscripts({ corpusDir, minChars: 1 });
    const d1 = found.find((t) => t.basename === 'sess-d1');
    expect(d1?.content).toContain('earlier public plan zeta');
    expect(d1?.content).toContain('new public plan beta');
    expect(d1?.content).not.toContain('old secret plan alpha');
    expect(found.some((t) => t.basename === 'sess-d2')).toBe(false);
  });
});
