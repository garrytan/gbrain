/**
 * #9888 / #10236: a per-source atom opt-out. `sources.config.extract_atoms = false` (`gbrain sources set-extract-atoms <id> off`)
 * keeps one source's pages and transcripts away from provider-based atom extraction while another, otherwise identical
 * source stays eligible. The pages stay searchable; doctor counts the opted-out pages apart and never asks to drain them.
 * Real in-memory PGLite (a repo-less brain), no provider: the chat seam counts calls.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { countExtractAtomsBacklog, discoverExtractablePages, runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { computeExtractAtomsBacklogCheck } from '../src/commands/doctor.ts';
import { runSources } from '../src/commands/sources.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';

let engine: PGLiteEngine;
const EMPTY_HOME = mkdtempSync(join(tmpdir(), 'gbrain-xa-source-opt-out-'));
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(`INSERT INTO sources(id, name, config) VALUES ('source-a', 'source-a', '{}') ON CONFLICT (id) DO NOTHING`);
});

const BODY = 'A synthetic article about acme-example and its widgets. '.repeat(14);
const seed = (slug: string, sourceId: string) => engine.putPage(slug, { type: 'article', title: slug, compiled_truth: BODY }, { sourceId });

async function cli(args: string[]): Promise<{ out: string; verdict: number | null }> {
  const out: string[] = [];
  _resetCliExitVerdictForTests();
  const logSpy = spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { out.push(parts.map(String).join(' ')); });
  try { await runSources(engine, args); } finally { logSpy.mockRestore(); }
  const verdict = currentExitCode() || null;
  _resetCliExitVerdictForTests();
  process.exitCode = 0;
  return { out: out.join('\n'), verdict };
}
const optOut = (id: string) => engine.updateSourceConfig(id, { extract_atoms: false });
const config = async (id: string) => {
  const [row] = await engine.executeRaw<{ config: unknown }>('SELECT config FROM sources WHERE id=$1', [id]);
  return (typeof row!.config === 'string' ? JSON.parse(row!.config) : row!.config) as Record<string, unknown>;
};

describe('per-source extract_atoms opt-out (#9888)', () => {
  test('set-extract-atoms previews, applies under --expect and keeps the other config keys', async () => {
    await engine.executeRaw(`UPDATE sources SET config='{"strategy":"markdown"}' WHERE id='source-a'`);
    const preview = await cli(['set-extract-atoms', 'source-a', 'off', '--dry-run', '--json']);
    expect(JSON.parse(preview.out)).toEqual({ source_id: 'source-a', dry_run: true, current: 'on', target: 'off', changed: true,
      apply: ['gbrain', 'sources', 'set-extract-atoms', 'source-a', 'off', '--expect', 'on'] });
    expect(await config('source-a')).toEqual({ strategy: 'markdown' });
    const stale = await cli(['set-extract-atoms', 'source-a', 'off', '--expect', 'off', '--json']);
    expect(stale.verdict).toBe(1);
    expect(JSON.parse(stale.out)).toMatchObject({ error: 'preview_changed' });
    await cli(['set-extract-atoms', 'source-a', 'off', '--expect', 'on']);
    expect(await config('source-a')).toEqual({ strategy: 'markdown', extract_atoms: false });
    await cli(['set-extract-atoms', 'source-a', 'on', '--expect', 'off']);
    expect(await config('source-a')).toEqual({ strategy: 'markdown', extract_atoms: true });
    expect((await cli(['set-extract-atoms', 'no-such-source', 'off', '--json'])).verdict).toBe(2);
    const bare = await cli(['set-extract-atoms', 'source-a', 'off', '--expect']);
    expect(bare.verdict).toBe(2);
    expect(await config('source-a')).toEqual({ strategy: 'markdown', extract_atoms: true });
  });

  test('two identical sources: the opted-out one has no backlog, no candidates and no provider call', async () => {
    await seed('article/same', 'default');
    await seed('article/same', 'source-a');
    expect(await countExtractAtomsBacklog(engine, 'source-a')).toBe(1);
    await optOut('source-a');
    expect(await countExtractAtomsBacklog(engine, 'source-a')).toBe(0);
    expect(await countExtractAtomsBacklog(engine, 'default')).toBe(1);
    expect(await countExtractAtomsBacklog(engine)).toBe(1);
    expect(await countExtractAtomsBacklog(engine, undefined, { sourcePolicy: 'excluded' })).toBe(1);
    expect(await discoverExtractablePages(engine, 'source-a')).toEqual([]);
    expect((await discoverExtractablePages(engine, 'default')).map(p => p.slug)).toEqual(['article/same']);

    let calls = 0;
    const chat = (async () => { calls++; throw new Error('provider must not be called'); }) as never;
    const result = await runPhaseExtractAtoms(engine, { sourceId: 'source-a', _chat: chat,
      _transcripts: [{ filePath: '/corpus/session-a.txt', content: BODY, contentHash: 'a'.repeat(64) }] });
    expect(result.status).toBe('skipped');
    expect(result.details).toMatchObject({ reason: 'source_extract_atoms_off', source_id: 'source-a' });
    expect(calls).toBe(0);
    expect((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE source_id='source-a' AND deleted_at IS NULL"))[0]!.n).toBe(1);
  });

  test('turning a source off mid-run stops further provider calls', async () => {
    await seed('article/one', 'source-a');
    await seed('article/two', 'source-a');
    let calls = 0;
    const text = '[{"title":"a synthetic atom","atom_type":"insight","body":"b"}]';
    const chat = (async () => {
      calls++;
      await optOut('source-a');
      return { text, blocks: [{ type: 'text', text }], stopReason: 'end', model: 'test:model', providerId: 'test',
        usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 } };
    }) as never;
    await runPhaseExtractAtoms(engine, { sourceId: 'source-a', _chat: chat });
    expect(calls).toBe(1);
  });

  test('an opt-out that lands after an item is prepared sends nothing', async () => {
    await seed('article/prepared', 'source-a');
    let calls = 0;
    const chat = (async () => { calls++; throw new Error('provider must not be called'); }) as never;
    const realGetPage = engine.getPage.bind(engine);
    const spy = spyOn(engine, 'getPage').mockImplementation((async (...args: Parameters<typeof engine.getPage>) => {
      await optOut('source-a');
      return realGetPage(...args);
    }) as typeof engine.getPage);
    try { await runPhaseExtractAtoms(engine, { sourceId: 'source-a', _chat: chat }); } finally { spy.mockRestore(); }
    expect(calls).toBe(0);
  });

  test('doctor counts opted-out pages apart and never asks to drain them', async () => {
    for (let i = 0; i < 12; i++) await seed(`article/a-${i}`, 'source-a');
    await optOut('source-a');
    const check = await withEnv({ GBRAIN_HOME: EMPTY_HOME }, () => computeExtractAtomsBacklogCheck(engine));
    expect(check.status).toBe('ok');
    expect(check.message).not.toContain('--drain');
    expect(check.message).toContain('12 page(s) in a source with extract_atoms off');
    expect(check.details).toMatchObject({ backlog: 0, policy_excluded: 12, policy_excluded_by_source: [{ source_id: 'source-a', backlog: 12 }] });

    await seed('article/default-1', 'default');
    const scoped = await withEnv({ GBRAIN_HOME: EMPTY_HOME }, () => computeExtractAtomsBacklogCheck(engine, { sourceIds: ['default'] }));
    expect(scoped.details).toMatchObject({ backlog: 1 });
    expect((scoped.details as Record<string, unknown>).policy_excluded).toBeUndefined();
  });
});
