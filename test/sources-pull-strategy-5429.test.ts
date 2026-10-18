/**
 * `gbrain sources set-pull-strategy <id> <rebase|merge>` (#5429): the one
 * writer persists `sources.config.pull_strategy` by a single-key merge, the
 * reader `pullStrategyOf` defaults anything else to `rebase`, and `sources
 * list --json` reads it back. An invalid value, a missing source and a
 * connector source are refused without writing.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSources } from '../src/commands/sources.ts';
import { isPullStrategy, PULL_STRATEGIES, pullStrategyOf } from '../src/core/git-remote.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });

async function cli(args: string[]): Promise<{ out: string; err: string; exit: number | null }> {
  const out: string[] = [], err: string[] = [];
  let exit: number | null = null;
  const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => { exit = code ?? 0; throw new Error('EXIT'); }) as never);
  const logSpy = spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { out.push(parts.map(String).join(' ')); });
  const errSpy = spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { err.push(parts.map(String).join(' ')); });
  try { await runSources(engine, args); } catch (error) { if (!(error instanceof Error && error.message === 'EXIT')) throw error; }
  finally { exitSpy.mockRestore(); logSpy.mockRestore(); errSpy.mockRestore(); }
  return { out: out.join('\n'), err: err.join('\n'), exit };
}
const config = async (id: string) => (await engine.executeRaw<{ config: Record<string, unknown> }>('SELECT config FROM sources WHERE id=$1', [id]))[0]!.config;

test('the pull strategy enum is closed and anything else reads as rebase', () => {
  expect([...PULL_STRATEGIES]).toEqual(['rebase', 'merge']);
  expect(isPullStrategy('merge')).toBe(true);
  expect(isPullStrategy('MERGE')).toBe(false);
  expect(pullStrategyOf({ pull_strategy: 'merge' })).toBe('merge');
  expect(pullStrategyOf({ pull_strategy: 'ff-only' })).toBe('rebase');
  expect(pullStrategyOf({})).toBe('rebase');
  expect(pullStrategyOf(null)).toBe('rebase');
});

test('set-pull-strategy persists config.pull_strategy by a single-key merge and sources list --json reads it back', async () => {
  const id = `pull-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw(`INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,'/tmp/${id}','{"federated":true,"strategy":"code"}')`, [id]);
  let listed = JSON.parse((await cli(['list', '--json'])).out) as { sources: Array<{ id: string; pull_strategy: string }> };
  expect(listed.sources.find(source => source.id === id)).toMatchObject({ pull_strategy: 'rebase' });

  const set = await cli(['set-pull-strategy', id, 'merge']);
  expect(set.exit).toBeNull();
  expect(set.out).toContain(`Source "${id}" now pulls with strategy merge (was rebase).`);
  expect(set.out).toContain('merge --abort');
  expect(await config(id)).toEqual({ federated: true, strategy: 'code', pull_strategy: 'merge' });
  listed = JSON.parse((await cli(['list', '--json'])).out);
  expect(listed.sources.find(source => source.id === id)).toMatchObject({ pull_strategy: 'merge', strategy: 'code' });

  const back = await cli(['set-pull-strategy', id, 'rebase']);
  expect(back.out).toContain('now pulls with strategy rebase (was merge).');
  expect(back.out).not.toContain('merge --abort');
  expect(await config(id)).toEqual({ federated: true, strategy: 'code', pull_strategy: 'rebase' });
});

test('an invalid strategy, a missing source and a connector source are refused without writing', async () => {
  const id = `pull-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw(`INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,'/tmp/${id}','{}')`, [id]);
  const invalid = await cli(['set-pull-strategy', id, 'ff-only']);
  expect(invalid).toMatchObject({ exit: 2 });
  expect(invalid.err).toContain('invalid pull strategy "ff-only"');
  expect(await config(id)).toEqual({});
  expect((await cli(['set-pull-strategy', `missing-${randomUUID().slice(0, 6)}`, 'merge'])).exit).toBe(4);
  expect((await cli(['set-pull-strategy'])).exit).toBe(2);
  const connector = `gh-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw(`INSERT INTO sources(id,name,config) VALUES($1,$1,'{"kind":"github"}')`, [connector]);
  const refused = await cli(['set-pull-strategy', connector, 'merge']);
  expect(refused.exit).toBe(2);
  expect(refused.err).toContain('github connector source');
  expect(await config(connector)).toEqual({ kind: 'github' });
});
