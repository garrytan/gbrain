/**
 * `grant_new_ops_available` fix commands, run as real CLI subprocesses against
 * a sandboxed PGLite brain: the preview the check prints shows the operation
 * list before and after and changes nothing, and the apply command grants every
 * operation the check counted, for an OAuth client and a legacy token, so the
 * check is ok afterwards. Nothing outside the grant's scopes is added.
 * Regression it catches: a fix that adds one operation (`put_pages`) while the
 * check counts many, leaving remote clients unable to reach new tools.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createEngine } from '../src/core/engine-factory.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { readClientGrant, resolveGrantProfile } from '../src/core/grants/service.ts';
import { grantFromTokenRow } from '../src/core/grants/model.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { checkGrantNewOps } from '../src/commands/doctor/checks/grant-new-ops.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';

const CLI = join(resolve(import.meta.dir, '..'), 'src', 'cli.ts');
const cfg = { engine: 'pglite' } as any;
let root: string, home: string, db: string;

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) out[key] = value;
  for (const key of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_BRAIN_ID', 'GBRAIN_SOURCE', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY']) delete out[key];
  return { ...out, HOME: home, GBRAIN_HOME: home, GBRAIN_SELF_UPGRADE_MODE: 'off', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_SWEEP: '0' };
}

async function cli(argv: string[]) {
  expect(argv[0]).toBe('gbrain');
  const proc = Bun.spawn(['bun', 'run', CLI, ...argv.slice(1)], { cwd: root, env: env(), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

async function withBrain<T>(run: (engine: BrainEngine) => Promise<T>): Promise<T> {
  const config = { engine: 'pglite' as const, database_path: db };
  const engine = await createEngine(config);
  await engine.connect(config);
  try { return await run(engine); } finally { await disposePersistenceConsumer(engine); await engine.disconnect(); }
}

type Finding = { kind: string; id: string; name: string; preview_argv: string[]; argv: string[]; excluded_operations: { operation_snapshot: string[] } };
const check = () => withBrain(engine => checkGrantNewOps(engine, { cfg }));
const findings = async () => ((await check()).details?.grants ?? []) as Finding[];
const snapshotOf = (f: Finding) => withBrain(async engine => f.kind === 'oauth_client'
  ? (await readClientGrant(engine, f.id)).allowedOperations!
  : grantFromTokenRow((await engine.executeRaw<Record<string, unknown>>('SELECT * FROM access_tokens WHERE id = $1::uuid', [f.id]))[0]).allowedOperations!);

/** A writer granted before several operations existed: its snapshot lacks three it may call. */
const writerOps = () => resolveGrantProfile({ profile: 'memory-writer', sourceId: 'default' }).allowedOperations!;
let dropped: string[] = [];

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'gb-grant-fix-'));
  home = join(root, 'home');
  db = join(root, 'db');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: db }));
  await withBrain(async engine => {
    await engine.initSchema();
    const all = writerOps();
    dropped = ['put_pages', ...all.filter(op => op !== 'put_pages' && op !== 'get_page').slice(0, 2)];
    const snapshot = all.filter(op => !dropped.includes(op));
    const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const profile = resolveGrantProfile({ profile: 'memory-writer', sourceId: 'default' });
    await provider.registerClientManual('writer-example', ['client_credentials'], 'read write', [], 'default', undefined, undefined, undefined,
      { ...profile, surface: 'starter', surfaceSetBy: 'operator', allowedOperations: snapshot });
    await mintLegacyToken(engine, { name: 'token-example', scopes: ['read', 'write'], takesHolders: ['world'], allowedOperations: snapshot });
  });
}, 120_000);

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe('grant_new_ops_available fix commands', () => {
  test('the preview shows the before and after operation lists and changes nothing; the apply grants every counted operation', async () => {
    const found = await findings();
    expect(found.map(f => f.kind).sort()).toEqual(['legacy_token', 'oauth_client']);
    for (const f of found) {
      const counted = f.excluded_operations.operation_snapshot;
      expect(counted).toContain('put_pages');
      expect(counted.length).toBeGreaterThan(1);
      const before = await snapshotOf(f);

      const preview = await cli(f.preview_argv);
      expect({ kind: f.kind, exitCode: preview.exitCode, stderr: preview.exitCode ? preview.stderr : '' }).toEqual({ kind: f.kind, exitCode: 0, stderr: '' });
      expect(await snapshotOf(f)).toEqual(before);

      const applied = await cli(f.argv);
      expect({ kind: f.kind, exitCode: applied.exitCode, stderr: applied.exitCode ? applied.stderr : '' }).toEqual({ kind: f.kind, exitCode: 0, stderr: '' });
      const after = await snapshotOf(f);
      expect([...after].sort()).toEqual([...new Set([...before, ...counted])].sort());
      expect(preview.stdout).toContain(`Operations: ${before.join(', ')} -> ${after.join(', ')}`);
    }
    const recheck = await check();
    expect({ status: recheck.status, grants: (recheck.details?.grants as unknown[]).length }).toEqual({ status: 'ok', grants: 0 });
  }, 240_000);
});
