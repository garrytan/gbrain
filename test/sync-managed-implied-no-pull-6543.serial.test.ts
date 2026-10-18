/**
 * #6543 C1: managed sync never pulls (the managed path read `noPull` only to refuse), so the CLI implies
 * `--no-pull` on a managed brain and prints one stderr line naming `gbrain sources refresh <id>`. Covers the
 * single-source and `--all` CLI paths here; the serve-delegated path is pinned in serve-sync-handoff.serial.test.ts.
 * The library refusal of an explicit pull (`performSync({ noPull: false })`) stays.
 *
 * Regression that fails it: the CLI refusing with writer_coordinator_required again, the notice landing on stdout
 * (it would corrupt `--json`), or the library refusal being dropped.
 */
import { afterAll, afterEach, beforeAll, expect, test, spyOn } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { performSync } from '../src/commands/sync.ts';
import { runSyncInner } from '../src/commands/sync/run.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-implied-no-pull-'));
let engine: PGLiteEngine;
const sources: string[] = [];
const out: string[] = [], err: string[] = [];
const origOut = process.stdout.write.bind(process.stdout), origErr = process.stderr.write.bind(process.stderr);
const origLog = console.log, origError = console.error;
function capture(): void {
  out.length = 0; err.length = 0;
  process.stdout.write = ((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ') + '\n'); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(' ') + '\n'); };
}
function release(): void { process.stdout.write = origOut; process.stderr.write = origErr; console.log = origLog; console.error = origError; }

function git(root: string, ...args: string[]): void {
  execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
}

async function fixture(): Promise<{ id: string; root: string }> {
  const id = `nopull-${randomUUID().replace(/-/g, '').slice(0, 16)}`; sources.push(id);
  const root = join(home, id); mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  writeFileSync(join(root, 'notes', 'a.md'), '---\ntitle: Note A\n---\nA durable observation.\n');
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root };
}

const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SOURCE: undefined, GBRAIN_SYNC_NO_DELEGATE: '1' };

beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
}, 120_000);
afterEach(() => release());
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    for (const id of sources) await engine.executeRaw('DELETE FROM sources WHERE id=$1', [id]);
    await engine.disconnect();
  });
  rmSync(home, { recursive: true, force: true });
});

test('single-source `gbrain sync --source <id>` on a managed brain imports without --no-pull and names sources refresh on stderr', async () => withEnv(env, async () => {
  const f = await fixture();
  capture();
  try { await runSyncInner(engine, ['--source', f.id, '--no-embed', '--no-extract', '--json']); } finally { release(); }
  const notice = err.find(line => line.includes('--no-pull is implied'));
  expect(notice).toBeDefined();
  expect(notice).toContain(`gbrain sources refresh ${f.id}`);
  expect(out.join('')).not.toContain('--no-pull is implied');
  expect((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1', [f.id]))[0].n).toBe(1);
}), 120_000);

test('`gbrain sync --all` on a managed brain implies --no-pull once for every source', async () => withEnv(env, async () => {
  const f = await fixture();
  capture();
  // The --all path ends a failed run with process.exit(1); trap it so a regression fails this test instead of the runner.
  const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`process.exit(${code})`); }) as never);
  try { await runSyncInner(engine, ['--all', '--no-embed', '--no-extract', '--json', '--yes']); } finally { exit.mockRestore(); release(); }
  expect(err.filter(line => line.includes('--no-pull is implied')).length).toBe(1);
  expect(err.join('')).not.toContain('writer_coordinator_required');
  expect(out.join('')).not.toContain('--no-pull is implied');
  expect((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE source_id=$1', [f.id]))[0].n).toBe(1);
}), 120_000);

test('the library refusal of an explicit pull stays', async () => withEnv(env, async () => {
  const f = await fixture();
  const thrown = await performSync(engine, { sourceId: f.id, repoPath: f.root, noPull: false, noEmbed: true, noExtract: true }).catch(e => e);
  expect((thrown as { code?: string }).code).toBe('writer_coordinator_required');
}), 120_000);
