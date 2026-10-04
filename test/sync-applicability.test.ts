/**
 * Lane E4 (agent-first operator wave): sync on a gbrain-owned content
 * directory refuses with `sync_not_applicable` (why + the import fix, never a
 * Git step it runs itself); `sync --all` skips it; the dream cycle's sync phase
 * reports it as a skip, not a failure.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { syncContentDirectory } from '../src/core/sync-applicability.ts';
import { contentSetupKey } from '../src/core/shared-skills/setup.ts';
import { performSync } from '../src/commands/sync.ts';
import { runCycle } from '../src/core/cycle.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { cliRenderContext, toAgentError } from '../src/core/agent-output.ts';

let engine: PGLiteEngine;
let home: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  home = mkdtempSync(join(tmpdir(), 'gbrain-sync-applicability-'));
});

function inHome<T>(fn: () => Promise<T>): Promise<T> {
  return withEnv({ GBRAIN_HOME: home }, fn);
}

async function addSource(id: string, localPath: string): Promise<void> {
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2) ON CONFLICT (id) DO UPDATE SET local_path=EXCLUDED.local_path', [id, localPath]);
}

function ownedContentDir(sourceId: string): string {
  const dir = join(home, '.gbrain', 'content', 'brain-example', sourceId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('syncContentDirectory', () => {
  test('a gbrain-owned content directory without .git is not syncable', () => inHome(async () => {
    const dir = ownedContentDir('notes-example');
    await addSource('notes-example', dir);
    expect(await syncContentDirectory(engine, { sourceId: 'notes-example' })).toMatchObject({ sourceId: 'notes-example', root: dir });
  }));

  test('the same directory after the user ran git init is syncable', () => inHome(async () => {
    const dir = ownedContentDir('notes-example');
    mkdirSync(join(dir, '.git'));
    await addSource('notes-example', dir);
    expect(await syncContentDirectory(engine, { sourceId: 'notes-example' })).toBeNull();
  }));

  test('a user directory outside gbrain content keeps the existing sync path', () => inHome(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-user-notes-'));
    await addSource('user-example', dir);
    expect(await syncContentDirectory(engine, { sourceId: 'user-example' })).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  }));

  test('an owned --content-root recorded in the setup receipt is not syncable', () => inHome(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-owned-root-'));
    await addSource('custom-example', dir);
    const [row] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='custom-example'");
    await engine.setConfig(contentSetupKey('custom-example', row.incarnation), JSON.stringify({ version: 1, owned_root: true, root: dir, repository_kind: 'content_directory' }));
    expect(await syncContentDirectory(engine, { sourceId: 'custom-example' })).toMatchObject({ root: dir });
    rmSync(dir, { recursive: true, force: true });
  }));
});

describe('performSync on a content directory', () => {
  test('refuses with sync_not_applicable, the import fix and the source id filled', () => inHome(async () => {
    const dir = ownedContentDir('notes-example');
    await addSource('notes-example', dir);
    const err = await performSync(engine, { sourceId: 'notes-example', noPull: true, noEmbed: true }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(OperationError);
    const e = err as OperationError;
    expect(e.code).toBe('sync_not_applicable');
    expect(e.reason).toBe('content_directory');
    expect(e.fix?.argv).toEqual(['gbrain', 'import', '<dir>', '--source', 'notes-example']);
    expect(e.fix?.inputs?.[0]?.name).toBe('dir');
    expect(e.fix?.consent).toEqual([]);
    expect(e.suggestion).toContain('ask the user first');
    const env = toAgentError(e, { transport: 'cli', command: 'sync', render: cliRenderContext() });
    expect(env.code).toBe('sync_not_applicable');
    expect(env.class).toBe('caller');
    expect(env.why).toContain('never initializes Git');
    expect(env.fix?.next).toBe('run');
  }));

  test('a keyless brain gets --no-embed in the import fix', () => inHome(async () => {
    const dir = ownedContentDir('notes-example');
    await addSource('notes-example', dir);
    await engine.setConfig('embedding_disabled', 'true');
    const err = await performSync(engine, { sourceId: 'notes-example', noPull: true, noEmbed: true }).then(() => null, (e: unknown) => e) as OperationError;
    expect(err.fix?.argv).toEqual(['gbrain', 'import', '<dir>', '--no-embed', '--source', 'notes-example']);
  }));

  test('the dream sync phase reports sync_not_applicable as a skip, not a failure', () => inHome(async () => {
    const dir = ownedContentDir('notes-example');
    await addSource('notes-example', dir);
    const report = await runCycle(engine, { brainDir: dir, phases: ['sync'], pull: false });
    const sync = report.phases.find(p => p.phase === 'sync');
    expect(sync?.status).toBe('skipped');
    expect(sync?.details).toMatchObject({ reason: 'sync_not_applicable' });
    expect(report.status).not.toBe('failed');
  }), 60_000);
});
