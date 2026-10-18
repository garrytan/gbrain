/**
 * #6268 (W13 P3.4, R14): every corpus file carries the session's source.
 *
 * Before the fix a compaction segment or session-end file carried no source,
 * so the sweep filed its facts under whatever source the PASS ran for. Here a
 * session pinned to `client-a` (GBRAIN_SOURCE) writes its corpus through the
 * real hook entry points, the sweep runs for `default`, and the facts must
 * land in `client-a`. The rest pins the R14 contract: stamped files live in
 * the spool subdirectory an old sweeper never reads, the session source is
 * frozen at the first resolution, a resumed window refuses a source change,
 * legacy unstamped files are held (or adopted only with evidence), and the
 * unresolved marker can never collide with a real source id.
 *
 * Hermetic in-memory PGLite + chat-transport stub (sweep.test.ts harness).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runMaintenanceSweep } from '../src/core/sweep.ts';
import { runHook } from '../src/commands/hook.ts';
import { runSweep } from '../src/commands/sweep.ts';
import {
  CORPUS_SPOOL_SUBDIR, CORPUS_UNRESOLVED_STAMP, corpusFileSessionId, ensureCorpusSpoolDir, isCorpusSourceStamp,
  parseSegmentFileName, parseWbFileName, segmentFileName, sessionCorpusFileName, writeSegment,
} from '../src/core/context/corpus-segments.ts';
import { freezeSessionSource, openSessionSource, readSessionSource, resolveCorpusFileSource } from '../src/core/context/corpus-source.ts';
import { runCorpusWindows, corpusFileStat } from '../src/core/context/corpus-windows.ts';
import { toCorpusText } from '../src/core/transcripts/claude-code-jsonl.ts';
import { isValidSourceId } from '../src/core/source-id.ts';
import { makeContextPackIpcHandler } from '../src/mcp/context-pack-handler.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { statSync } from 'node:fs';
import { __setChatTransportForTests, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import type { CapabilityReport } from '../src/core/capability.ts';
import { withEnv } from './helpers/with-env.ts';

const KEYED: CapabilityReport = {
  embeddings: { available: false },
  extraction: { available: true, provider: 'anthropic' },
  search: 'keyword-only',
  mode: 'keyed',
};

let engine: PGLiteEngine;
let home: string;
const tmpDirs: string[] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('client-a','client-a') ON CONFLICT DO NOTHING");
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const corpus = () => join(home, '.gbrain', 'transcripts', 'corpus');

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM facts').catch(() => {});
  home = mkdtempSync(join(tmpdir(), 'gbrain-corpus-src-'));
  tmpDirs.push(home);
  mkdirSync(join(home, 'ws'), { recursive: true });
  mkdirSync(corpus(), { recursive: true });
  await engine.setConfig('dream.synthesize.session_corpus_dir', corpus());
  __setChatTransportForTests(async (): Promise<ChatResult> => ({
    text: JSON.stringify({ facts: [{ fact: 'Ships the quarterly report on Fridays.', kind: 'fact', entity: null, confidence: 1, notability: 'high' }] }),
    blocks: [], stopReason: 'end',
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic',
  }));
});

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
});

const userLine = (text: string) => JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: text } });
const assistantLine = (text: string) =>
  JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text }] } });
const boundaryLine = () => JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: 'conversation compacted' });

function seedTranscript(name: string, lines: string[]): string {
  const dir = join(home, 'projects', 'p1');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
}

async function hook(event: string, sid: string, transcript: string): Promise<void> {
  expect(await runHook([event], {
    stdin: JSON.stringify({ session_id: sid, transcript_path: transcript, cwd: join(home, 'ws') }),
    transcriptRoot: join(home, 'projects'),
    disableTelemetry: true,
  })).toBe(0);
}

async function factSources(): Promise<string[]> {
  const rows = await engine.executeRaw<{ source_id: string }>('SELECT DISTINCT source_id FROM facts ORDER BY source_id');
  return rows.map((r) => r.source_id);
}

describe('#6268 corpus files carry the session source', () => {
  test('issue repro: a client-a session swept under default files its facts in client-a', async () => {
    const transcript = seedTranscript('s.jsonl', [
      userLine('We agreed that Alice ships the quarterly report on Fridays.'),
      assistantLine('Noted, Fridays it is.'),
      boundaryLine(),
      userLine('And the board deck goes out on Mondays.'),
      assistantLine('Got it.'),
    ]);
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SOURCE: 'client-a', GBRAIN_HOOKS: undefined }, async () => {
      await hook('compact', 'sess-client-a', transcript);
      await hook('session-end', 'sess-client-a', transcript);
    });
    const r = await runMaintenanceSweep(engine, { sourceId: 'default', capabilities: KEYED });
    expect(r.corpusIngested).toBeGreaterThan(0);
    expect(await factSources()).toEqual(['client-a']);
  });
});

const spool = () => join(corpus(), CORPUS_SPOOL_SUBDIR);
const txt = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.endsWith('.txt')) : []);
const corpusText = (turns: string[]) => toCorpusText(turns.map((text, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, text })));
async function sweepAs(source = 'default') {
  return runMaintenanceSweep(engine, { sourceId: source, capabilities: KEYED, budgetMs: 60_000 });
}
async function addSource(id: string, localPath?: string) {
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2) ON CONFLICT DO NOTHING', [id, localPath ?? null]);
}

describe('#6268 R14: stamps, spool, frozen session source', () => {
  test('explicit default stamp: a default session names default in every file, all inside the spool', async () => {
    const transcript = seedTranscript('d.jsonl', [userLine('We ship the quarterly report on Fridays.'), assistantLine('ok'), boundaryLine(), userLine('more'), assistantLine('ok')]);
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SOURCE: 'default', GBRAIN_HOOKS: undefined }, async () => {
      await hook('compact', 'sess-default', transcript);
      await hook('session-end', 'sess-default', transcript);
    });
    const names = txt(spool());
    expect(names.length).toBeGreaterThanOrEqual(2);
    expect(names.every((n) => n.endsWith('.src-default.txt'))).toBe(true);
    expect(names).toContain(sessionCorpusFileName('sess-default', 'default'));
    await sweepAs('default');
    expect(await factSources()).toEqual(['default']);
  });

  test('new writer, old sweeper: no stamped file lands where a pre-stamp sweeper reads (the top-level .txt listing)', async () => {
    const transcript = seedTranscript('o.jsonl', [userLine('A fact about the Friday report.'), assistantLine('ok')]);
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SOURCE: 'client-a', GBRAIN_HOOKS: undefined }, async () => {
      await hook('session-end', 'sess-old-sweeper', transcript);
    });
    // A pre-stamp sweeper lists `readdir(corpusDir)` `.txt` and files every non-wb one under its pass source.
    expect(txt(corpus())).toEqual([]);
    expect(txt(spool())).toEqual([sessionCorpusFileName('sess-old-sweeper', 'client-a')]);
  });

  test('old writer, new sweeper: legacy names still parse; a legacy wb stamp is honored', () => {
    expect(parseSegmentFileName('s1.seg-0123456789abcdef01234567.txt')).toEqual({ sessionId: 's1', hash: '0123456789abcdef01234567' });
    expect(parseSegmentFileName('s1.seg-0123456789abcdef01234567.src-client-a.txt')).toEqual({ sessionId: 's1', hash: '0123456789abcdef01234567', stamp: 'client-a' });
    expect(parseWbFileName('s1.wb-0123456789abcdef01234567.src-client-a.txt')?.sourceId).toBe('client-a');
    expect(corpusFileSessionId('s1.txt')).toBe('s1');
    expect(corpusFileSessionId('s1.src-client-a.txt')).toBe('s1');
    expect(corpusFileSessionId(segmentFileName('s1', '0123456789abcdef01234567', 'default'))).toBe('s1');
  });

  test('legacy unstamped file on a multi-source brain is held (never the pass source), then mapped explicitly', async () => {
    writeFileSync(join(corpus(), 'sess-legacy.txt'), corpusText(['Alice ships the quarterly report on Fridays.', 'ok']));
    const r1 = await sweepAs('default');
    expect(r1.skipped).toContainEqual({ reason: 'corpus_legacy_unstamped', count: 1 });
    expect(await factSources()).toEqual([]);
    expect(existsSync(join(corpus(), 'sess-legacy.txt.ingested'))).toBe(false);

    _resetCliExitVerdictForTests();
    const log: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { log.push(a.join(' ')); };
    try {
      await runSweep(engine, ['--assign-corpus', 'client-a']);
      expect(readSessionSource(spool(), 'sess-legacy')).toBeNull(); // preview writes nothing
      await runSweep(engine, ['--assign-corpus', 'client-a', '--apply']);
    } finally {
      console.log = orig;
    }
    expect(log.join('\n')).toContain('sess-legacy');
    expect(readSessionSource(spool(), 'sess-legacy')).toMatchObject({ source_id: 'client-a', tier: 'operator' });
    await sweepAs('default');
    expect(await factSources()).toEqual(['client-a']);
  });

  test('legacy file adopted with durable session evidence: the same session\'s frozen spool record', async () => {
    writeFileSync(join(corpus(), 'sess-evidence.txt'), corpusText(['Alice ships the quarterly report on Fridays.', 'ok']));
    freezeSessionSource(corpus(), 'sess-evidence', 'client-a', 'env');
    const r = await resolveCorpusFileSource(engine, corpus(), 'sess-evidence.txt', 'legacy');
    expect(r).toMatchObject({ ok: true, sourceId: 'client-a', via: 'session_record' });
    await sweepAs('default');
    expect(await factSources()).toEqual(['client-a']);
  });

  test('session source frozen at session start: a later capture with another GBRAIN_SOURCE keeps the first', async () => {
    await withEnv({ GBRAIN_SOURCE: 'client-a' }, async () => {
      expect((await openSessionSource(corpus(), 'sess-frozen', { cwd: join(home, 'ws'), harness: 'test' })).stamp).toBe('client-a');
    });
    await withEnv({ GBRAIN_SOURCE: 'default' }, async () => {
      expect((await openSessionSource(corpus(), 'sess-frozen', { cwd: join(home, 'ws'), harness: 'test' })).stamp).toBe('client-a');
    });
  });

  test('the unresolved marker cannot collide with a real source named "unresolved"', async () => {
    expect(isValidSourceId(CORPUS_UNRESOLVED_STAMP)).toBe(false);
    expect(isCorpusSourceStamp('unresolved')).toBe(true);
    await addSource('unresolved');
    const dir = ensureCorpusSpoolDir(corpus());
    writeFileSync(join(dir, sessionCorpusFileName('sess-real', 'unresolved')), corpusText(['Alice ships the quarterly report on Fridays.', 'ok']));
    writeFileSync(join(dir, sessionCorpusFileName('sess-marker', CORPUS_UNRESOLVED_STAMP)), corpusText(['Bob ships the board deck on Mondays.', 'ok']));
    const r = await sweepAs('default');
    expect(r.skipped).toContainEqual({ reason: 'corpus_source_unresolved', count: 1 });
    expect(await factSources()).toEqual(['unresolved']);
  });

  test('unresolved session: the brain resolves the recorded cwd (tiers 4-6) once and freezes it', async () => {
    const ws = join(home, 'ws-b');
    mkdirSync(ws, { recursive: true });
    await addSource('client-b', ws);
    const transcript = seedTranscript('u.jsonl', [userLine('Alice ships the quarterly report on Fridays.'), assistantLine('ok')]);
    await withEnv({ GBRAIN_HOME: home, GBRAIN_SOURCE: undefined, GBRAIN_HOOKS: undefined }, async () => {
      expect(await runHook(['session-end'], {
        stdin: JSON.stringify({ session_id: 'sess-unpinned', transcript_path: transcript, cwd: ws }),
        transcriptRoot: join(home, 'projects'), disableTelemetry: true,
      })).toBe(0);
    });
    expect(txt(spool())).toEqual([sessionCorpusFileName('sess-unpinned', CORPUS_UNRESOLVED_STAMP)]);
    await sweepAs('default');
    expect(await factSources()).toEqual(['client-b']);
    expect(readSessionSource(spool(), 'sess-unpinned')).toMatchObject({ source_id: 'client-b', tier: 'engine' });
  });

  test('two-window resume across sources is refused, and so is a recreated source (incarnation)', async () => {
    const dir = ensureCorpusSpoolDir(corpus());
    const full = join(dir, sessionCorpusFileName('sess-resume', 'client-a'));
    const long = 'x'.repeat(7_000);
    writeFileSync(full, corpusText([`first ${long}`, 'ok', `second ${long}`, 'ok']));
    const raw = readFileSync(full, 'utf8');
    const run = (source: { id: string; incarnation: string }) => runCorpusWindows({
      full, raw, fileStat: corpusFileStat(statSync(full)), maxWindows: 1, overBudget: () => false,
      signal: new AbortController().signal, source,
      extract: async () => ({ inserted: 0, duplicate: 0, superseded: 0, fact_ids: [], entity_slugs: [] }),
    });
    const first = await run({ id: 'client-a', incarnation: 'inc-1' });
    expect(first.status).toBe('partial');
    expect((await run({ id: 'default', incarnation: 'inc-0' })).status).toBe('source_changed');
    expect((await run({ id: 'client-a', incarnation: 'inc-2' })).status).toBe('source_changed');
    expect((await run({ id: 'client-a', incarnation: 'inc-1' })).status).toBe('complete');
  });

  test('a session bound to a source incarnation holds its files after the source is deleted and recreated', async () => {
    await addSource('client-c');
    const dir = ensureCorpusSpoolDir(corpus());
    freezeSessionSource(corpus(), 'sess-inc', 'client-c', 'env');
    writeFileSync(join(dir, sessionCorpusFileName('sess-inc', 'client-c')), corpusText(['one', 'ok']));
    expect((await resolveCorpusFileSource(engine, corpus(), sessionCorpusFileName('sess-inc', 'client-c'), 'spool')).ok).toBe(true);
    await engine.executeRaw("DELETE FROM sources WHERE id = 'client-c'");
    await addSource('client-c');
    expect(await resolveCorpusFileSource(engine, corpus(), sessionCorpusFileName('sess-inc', 'client-c'), 'spool'))
      .toEqual({ ok: false, reason: 'corpus_source_incarnation_changed' });
  });

  test('manifest and links publish under the stamped source', async () => {
    const repo = join(home, 'repo-a');
    mkdirSync(join(repo, 'people'), { recursive: true });
    writeFileSync(join(repo, 'people', 'alice-example.md'), '---\ntype: person\ntitle: Alice Example\n---\n\nx\n');
    await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'client-a'", [repo]);
    await engine.executeRaw("INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline) VALUES ('people/alice-example', 'client-a', 'person', 'Alice Example', 'x', '') ON CONFLICT DO NOTHING");
    __setChatTransportForTests(async (): Promise<ChatResult> => ({
      text: JSON.stringify({ facts: [{ fact: 'Ships the quarterly report on Fridays.', kind: 'fact', entity: 'people/alice-example', confidence: 1, notability: 'high' }] }),
      blocks: [], stopReason: 'end',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic',
    }));
    const dir = ensureCorpusSpoolDir(corpus());
    const w = writeSegment(dir, 'sess-manifest', corpusText(['Alice Example ships the quarterly report on Fridays.', 'ok']), 'client-a');
    expect(w.file.endsWith('.src-client-a.txt')).toBe(true);
    await sweepAs('default');
    const { getCheckpointManifest } = await import('../src/core/context/session-state.ts');
    expect((await getCheckpointManifest(engine, 'client-a', null, 'sess-manifest'))?.map((l) => l.slug)).toEqual(['people/alice-example']);
    expect((await getCheckpointManifest(engine, 'default', null, 'sess-manifest')) ?? []).toEqual([]);
    await engine.executeRaw("UPDATE sources SET local_path = NULL WHERE id = 'client-a'");
  });

  test('serve IPC: a foreign sourceId and a flush stamped for another source are refused, never rerouted', async () => {
    const handler = makeContextPackIpcHandler(engine, 'default');
    await expect(handler({ protocol: 2, secret: 's', sessionId: 'sess-ipc', sourceId: 'client-a', bankOnly: true } as never)).rejects.toThrow('source_mismatch');
    const dir = ensureCorpusSpoolDir(corpus());
    const name = sessionCorpusFileName('sess-ipc', 'client-a');
    writeFileSync(join(dir, name), corpusText(['x', 'y']));
    const res = await handler({ protocol: 2, secret: 's', sessionId: 'sess-ipc', bankOnly: true, flushCorpusFile: name } as never) as { checkpointFlush?: unknown };
    expect(res.checkpointFlush).toEqual({ status: 'skipped', reason: 'source_mismatch' });
  });

  test('serve IPC: an unpinned session\'s unresolved record freezes to the serve\'s own source', async () => {
    await openSessionSource(corpus(), 'sess-serve', { cwd: null, harness: 'test' });
    expect(readSessionSource(spool(), 'sess-serve')?.source_id).toBeNull();
    const handler = makeContextPackIpcHandler(engine, 'default');
    await handler({ protocol: 2, secret: 's', sessionId: 'sess-serve', bankOnly: true } as never);
    expect(readSessionSource(spool(), 'sess-serve')).toMatchObject({ source_id: 'default', tier: 'serve' });
  });
});
