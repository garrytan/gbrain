/**
 * `grant_new_ops_available` with membership operations missing: the default
 * fix and its preview never add an operation gbrain says the owner approves by
 * name (join_brain, sync_brain_skills, leave_brain). The check lists those and
 * carries a separate by-name command, never the fix. The count and the commands
 * agree: missing = added by the default command + listed as by-name. Real CLI
 * subprocesses against a sandboxed PGLite brain, for an OAuth client and a
 * legacy token whose scopes allow the membership operations.
 * Regression it catches: a doctor fix that pre-fills by-name operations, which
 * turns the owner's by-name approval into one keystroke.
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
import { requiresExplicitApproval } from '../src/core/ops/execution-prerequisites.ts';
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

type Finding = { kind: string; id: string; name: string; preview_argv: string[] | null; argv: string[] | null; by_name_operations: string[]; by_name_argv: string[] | null;
  excluded_operations: { operation_snapshot: string[] } };
const check = () => withBrain(engine => checkGrantNewOps(engine, { cfg }));
const findings = async () => ((await check()).details?.grants ?? []) as Finding[];
const snapshotOf = (f: Finding) => withBrain(async engine => f.kind === 'oauth_client'
  ? (await readClientGrant(engine, f.id)).allowedOperations!
  : grantFromTokenRow((await engine.executeRaw<Record<string, unknown>>('SELECT * FROM access_tokens WHERE id = $1::uuid', [f.id]))[0]).allowedOperations!);

const ok = (kind: string, r: { exitCode: number; stderr: string }) =>
  expect({ kind, exitCode: r.exitCode, stderr: r.exitCode ? r.stderr : '' }).toEqual({ kind, exitCode: 0, stderr: '' });

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'gb-grant-by-name-'));
  home = join(root, 'home');
  db = join(root, 'db');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: db }));
  await withBrain(async engine => {
    await engine.initSchema();
    const profile = resolveGrantProfile({ profile: 'memory-writer', sourceId: 'default' });
    const snapshot = profile.allowedOperations!.filter(op => op !== 'put_pages');
    const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    await provider.registerClientManual('member-example', ['client_credentials'], 'read write skills_member_self', [], 'default', undefined, undefined, undefined,
      { ...profile, scopes: ['read', 'write', 'skills_member_self'], allowedOperations: snapshot });
    await mintLegacyToken(engine, { name: 'member-token-example', scopes: ['read', 'write', 'skills_member_self'], takesHolders: ['world'], allowedOperations: snapshot });
  });
}, 120_000);

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe('grant_new_ops_available leaves by-name operations out of the default fix', () => {
  test('missing = added by the default command + listed as by-name; the by-name command is separate and never the fix', async () => {
    const result = await check();
    const found = (result.details?.grants ?? []) as Finding[];
    expect(found.map(f => f.kind).sort()).toEqual(['legacy_token', 'oauth_client']);
    const fix = result.fix as { argv: string[]; preview_argv: string[]; user_message: string };
    for (const f of found) {
      const missing = f.excluded_operations.operation_snapshot;
      expect(missing).toContain('put_pages');
      const before = await snapshotOf(f);
      const preview = await cli(f.preview_argv!);
      ok(f.kind, preview);
      expect(await snapshotOf(f)).toEqual(before);
      ok(f.kind, await cli(f.argv!));
      const afterDefault = await snapshotOf(f);
      const added = afterDefault.filter(op => !before.includes(op));
      expect(added.filter(requiresExplicitApproval)).toEqual([]);
      expect([...f.by_name_operations].sort()).toEqual(missing.filter(requiresExplicitApproval).sort());
      expect([...f.by_name_operations].sort()).toEqual(['join_brain', 'leave_brain', 'sync_brain_skills']);
      expect(fix.argv).not.toEqual(f.by_name_argv);
      expect(result.message).toContain(`${f.by_name_operations.length} of the missing operations need the owner's approval by name (${f.by_name_operations.join(', ')})`);
      expect(preview.stdout).toContain(`Operations: ${before.join(', ')} -> ${afterDefault.join(', ')}`);
      expect([...added, ...f.by_name_operations].sort()).toEqual([...missing].sort());
    }
    expect(fix.user_message).toContain('need the owner\'s approval by name');

    const remaining = await check();
    const left = (remaining.details?.grants ?? []) as Finding[];
    expect(left.map(f => ({ kind: f.kind, argv: f.argv, missing: [...f.excluded_operations.operation_snapshot].sort() })).sort((a, b) => a.kind.localeCompare(b.kind)))
      .toEqual(['legacy_token', 'oauth_client'].map(kind => ({ kind, argv: null, missing: ['join_brain', 'leave_brain', 'sync_brain_skills'] })));
    expect(remaining.fix).toBeUndefined();
    for (const f of left) ok(f.kind, await cli(f.by_name_argv!));
    expect((await check()).status).toBe('ok');
  }, 240_000);
});
