/**
 * `gbrain sources set-sync <id> <on|off>` (GBRA-108): sets config.syncEnabled preview-first, with --expect binding the
 * apply to the previewed state, by a single-key merge; automatic sync reads it through sync-policy.ts.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSources } from '../src/commands/sources.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { automaticSyncSkip } from '../src/core/sync-policy.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });

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
const row = async (id: string) => (await engine.executeRaw<{ id: string; local_path: string | null; config: unknown }>('SELECT id, local_path, config FROM sources WHERE id=$1', [id]))[0]!;
const config = async (id: string) => { const c = (await row(id)).config; return (typeof c === 'string' ? JSON.parse(c) : c) as Record<string, unknown>; };

test('set-sync previews, applies under --expect, keeps the other config keys and turns automatic sync off and on', async () => {
  const id = `sync-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw(`INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,'/tmp/${id}','{"strategy":"code"}')`, [id]);
  const preview = await cli(['set-sync', id, 'off', '--dry-run', '--json']);
  expect(JSON.parse(preview.out)).toEqual({ source_id: id, dry_run: true, current: 'on', target: 'off', changed: true, apply: ['gbrain', 'sources', 'set-sync', id, 'off', '--expect', 'on'] });
  expect(await config(id)).toEqual({ strategy: 'code' });
  const applied = await cli(['set-sync', id, 'off', '--expect', 'on', '--json']);
  expect(JSON.parse(applied.out)).toEqual({ source_id: id, dry_run: false, current: 'on', target: 'off', changed: true });
  expect(await config(id)).toEqual({ strategy: 'code', syncEnabled: false });
  expect((await automaticSyncSkip(engine, await row(id)))?.reason).toBe('sync_disabled');
  expect(JSON.parse((await cli(['set-sync', id, 'off', '--json'])).out)).toMatchObject({ changed: false, current: 'off' });
  await cli(['set-sync', id, 'on', '--expect', 'off']);
  expect(await config(id)).toEqual({ strategy: 'code', syncEnabled: true });
  expect((await automaticSyncSkip(engine, await row(id)))?.reason).not.toBe('sync_disabled');
});

test('an apply whose --expect no longer holds refuses preview_changed and changes nothing; bad input and unknown sources refuse', async () => {
  const id = `sync-${randomUUID().slice(0, 8)}`;
  await engine.executeRaw(`INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,'/tmp/${id}','{"syncEnabled":false}')`, [id]);
  const stale = await cli(['set-sync', id, 'on', '--expect', 'on', '--json']);
  expect(stale.verdict).toBe(1);
  expect(JSON.parse(stale.out)).toMatchObject({ error: 'preview_changed', fix: { argv: ['gbrain', 'sources', 'set-sync', id, 'on', '--dry-run', '--json'] } });
  expect(await config(id)).toEqual({ syncEnabled: false });
  expect((await cli(['set-sync', id, 'maybe', '--json'])).verdict).toBe(2);
  expect((await cli(['set-sync', id, 'on', '--expect', 'yes'])).verdict).toBe(2);
  const missing = await cli(['set-sync', 'no-such-source', 'off', '--json']);
  expect(missing.verdict).toBe(2);
  expect(JSON.parse(missing.out)).toMatchObject({ error: 'invalid_params' });
});
