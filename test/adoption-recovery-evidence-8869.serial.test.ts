/** #8869: adoption recovery reads the commit ledger before taking DB recovery locks.
 * Process-global filesystem observation is isolated in the serial lane.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { recoverPublication } from '../src/core/persistence/coordinator.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { git, page, withRefreshFixture, type RefreshFixture } from './helpers/worktree-refresh-fixture.ts';

const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  if (testBackends().includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({}); await engine.initSchema(); engines.push(engine);
  }
  if (testBackends().includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); if (engine.kind === 'pglite') await engine.disconnect(); }
  await closePostgres?.();
});

async function fixture(run: (f: RefreshFixture) => Promise<void>) {
  for (const engine of engines) await withRefreshFixture(engine, async f => {
    git(f.root, 'config', 'user.name', 'Example');
    git(f.root, 'config', 'user.email', 'example@example.invalid');
    git(f.root, 'config', 'commit.gpgsign', 'false');
    await engine.executeRaw("UPDATE persistence_host_bindings SET git_durability='enabled'");
    await engine.setConfig(`persistence.adopt_local_edits.source.${f.alpha}`, 'true');
    await engine.setConfig('persistence.adopt_quiet_ms', '0');
    fs.writeFileSync(join(f.root, 'alpha', 'one.md'), page('Alpha one', 'The first alpha observation.\n\nAn uncommitted local edit.'));
    try { await run(f); } finally {
      installFaultHook(undefined);
      await engine.executeRaw("DELETE FROM config WHERE key LIKE 'persistence.adopt%'");
    }
  });
}
const adoption = async (f: RefreshFixture) => (await f.engine.executeRaw<WriteRequest>(
  "SELECT * FROM persistence_requests WHERE source_id=$1 AND intent ? 'adoptLocalEdit' ORDER BY sequence DESC LIMIT 1", [f.alpha]))[0]!;
const write = (f: RefreshFixture) => dispatchToolCall(f.engine, 'add_timeline_entry',
  { slug: 'one', date: '2026-11-06', summary: 'Entry after the local edit.' },
  { remote: true, transport: 'stdio', sourceId: f.alpha, admissionOrigin: 'interactive' });

for (const intentOnly of [false, true]) test(`ledger proof stays outside recovery transactions (${intentOnly ? 'intent only' : 'commit row'})`, () => fixture(async f => {
  const originalTransaction = f.engine.transaction;
  const originalRead = fs.readFileSync;
  let depth = 0, observing = false, fired = 0, commit = '';
  const reads: number[] = [];
  f.engine.transaction = async function (this: BrainEngine, fn, opts) {
    return originalTransaction.call(this, async tx => {
      depth++;
      try { return await fn(tx); } finally { depth--; }
    }, opts);
  } as BrainEngine['transaction'];
  const reader = spyOn(fs, 'readFileSync').mockImplementation(function (...args: Parameters<typeof fs.readFileSync>) {
    if (observing && String(args[0]).endsWith('commit-ledger.jsonl')) reads.push(depth);
    return originalRead(...args);
  } as typeof fs.readFileSync);
  installFaultHook((point, detail) => {
    if (point !== 'publication:before_commit' || detail.operation !== 'put_page' || detail.sourceId !== f.alpha || fired++) return;
    commit = git(f.root, 'rev-parse', 'HEAD');
    if (intentOnly) {
      const path = join(f.root, '.git', 'gbrain', 'commit-ledger.jsonl');
      const lines = originalRead(path, 'utf8').split('\n').filter(line => {
        try { const row = JSON.parse(line); return row.e !== 'commit' || row.sha !== commit; } catch { return true; }
      });
      fs.writeFileSync(path, lines.join('\n'));
    }
    observing = true;
    throw new Error('example terminal failure after adoption commit');
  });
  try {
    await write(f).catch(() => undefined);
    const done = await adoption(f);
    expect(fired).toBe(1);
    expect(done.state).toBe('failed');
    expect(done.recovery).toBeNull();
    expect((done.outcome as { persistence?: unknown }).persistence).toMatchObject({ git_commit: commit, landed_before_row: true });
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every(value => value === 0)).toBe(true);
  } finally { reader.mockRestore(); f.engine.transaction = originalTransaction; }
}), 180_000);

test('foreign HEAD movement after proof collection refuses before restoration and a fresh recovery names the original commit', () => fixture(async f => {
  const originalTransaction = f.engine.transaction;
  const originalRead = fs.readFileSync;
  let observing = false, collected = false, moved = false, fired = 0, commit = '';
  const refusals: Array<{ code: string; recovery: boolean; unchanged: boolean }> = [];
  const target = join(f.root, 'alpha', 'one.md');
  const bytes = originalRead(target, 'utf8');
  const reader = spyOn(fs, 'readFileSync').mockImplementation(function (...args: Parameters<typeof fs.readFileSync>) {
    if (observing && String(args[0]).endsWith('commit-ledger.jsonl')) collected = true;
    return originalRead(...args);
  } as typeof fs.readFileSync);
  f.engine.transaction = async function (this: BrainEngine, fn, opts) {
    const changeHead = observing && collected && !moved;
    if (changeHead) {
      moved = true;
      git(f.root, 'commit', '-q', '--allow-empty', '-m', 'Foreign HEAD movement');
    }
    try { return await originalTransaction.call(this, fn, opts); }
    catch (error) {
      if (changeHead) refusals.push({ code: (error as { code: string }).code,
        recovery: (await adoption(f)).recovery !== null, unchanged: originalRead(target, 'utf8') === bytes });
      throw error;
    }
  } as BrainEngine['transaction'];
  installFaultHook((point, detail) => {
    if (point !== 'publication:before_commit' || detail.operation !== 'put_page' || detail.sourceId !== f.alpha || fired++) return;
    commit = git(f.root, 'rev-parse', 'HEAD');
    observing = true;
    throw new Error('example terminal failure after adoption commit');
  });
  try {
    await write(f).catch(() => undefined);
    expect(moved).toBe(true);
    expect(refusals).toEqual([{ code: 'recovery_required', recovery: true, unchanged: true }]);
    const pending = await adoption(f);
    const done = await recoverPublication(f.engine, pending.id, localHostId(), false,
      { code: 'storage_error', message: 'Example terminal failure.', detail: { origin: 'owner_exception' } });
    expect(done.state).toBe('failed');
    expect(done.recovery).toBeNull();
    expect((done.outcome as { persistence?: unknown }).persistence).toMatchObject({ git_commit: commit, landed_before_row: true });
    expect(git(f.root, 'rev-parse', 'HEAD^')).toBe(commit);
  } finally { reader.mockRestore(); f.engine.transaction = originalTransaction; }
}), 180_000);
