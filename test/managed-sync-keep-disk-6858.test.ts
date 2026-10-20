/**
 * #6858 ask 1: a managed sync import whose publication recovery parked on `unexpected_file_bytes` (a marker stamped into
 * its canonical file while the publication was in flight, then the connection dropped, so the recovery recorded no
 * failure), resolved the documented way (`gbrain repair stuck-recovery --keep disk`). The request then ends
 * `conflict` / `source_changed` with the abandonment message, which no classifier knew: the run parked
 * `blocked_by_failures` and every later plain sync returned the same parked run. The abandoned page is a changed-file
 * page fault now: it is retried after the manifest end in the same pass, imported when the disk bytes are HEAD's
 * (the lossless case), held `worktree_dirty` when they are an uncommitted edit, and the rest of the source drains.
 * #6712 PR 4b: a non-company source runs the live pass, which pins HEAD, so the lossless case ends at the commit of the
 * kept bytes rather than the cursor's frozen target.
 * Synthetic content only.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readManagedSyncFailures } from '../src/core/persistence/sync-failures.ts';
import { fileChangedAfterAdmission } from '../src/core/persistence/sync-page-fault.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { withEnv } from './helpers/with-env.ts';
import { stuckRecoveryFixture } from './helpers/stuck-recovery-fixture.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-keep-disk-6858-'));
const engines: BrainEngine[] = [];
const roots: string[] = [];
const sources: string[] = [];
let closePostgres: (() => Promise<void>) | undefined;
function git(root: string, ...args: string[]): string { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function commit(root: string, message = 'synthetic content'): string { git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); return git(root, 'rev-parse', 'HEAD'); }
const note = (body: string) => `---\ntitle: Example\n---\n${body}\n`;
// A pinned import whose canonical correction (a fixable facts fence: `partnership` maps to `fact`) rewrites the file, so its publication carries a recovery record.
const FB = '<!--- gbrain:facts:begin -->', FBE = '<!--- gbrain:facts:end -->';
const FH = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|';
const fixable = (body: string, marker = '') => `---\ntitle: Fixable\n${marker}---\n${body}\n\n${FB}\n${FH}\n| 1 | Sentinelzq8 partners with an example vendor | partnership | 1.0 | private | medium | 2026-01-01 |  | chat |  |\n${FBE}\n`;
const STAMP = 'embed_skip:\n  reason: oversized\n  assessed_at: 2026-10-15T21:27:12.000Z\n';

async function fixture(engine: BrainEngine, files: Record<string, string>) {
  const id = `keepdisk-${randomUUID().replace(/-/g, '').slice(0, 16)}`; sources.push(id);
  const root = join(home, id); mkdirSync(root); git(root, 'init', '-q');
  for (const [path, body] of Object.entries(files)) writeFileSync(join(root, path), body);
  commit(root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root, opts: { sourceId: id, noPull: true, noEmbed: true, noExtract: true, noBulk: true } };
}

/** Version two of a, b (the correctable page) and c; b's publication is stamped mid-flight and its connection drops, then --keep disk resolves it. */
async function abandonedMidRun(engine: BrainEngine, stamped: (root: string) => void) {
  const f = await fixture(engine, { 'a.md': note('Alpha one.'), 'b.md': fixable('Beta one.'), 'c.md': note('Gamma one.') });
  expect((await performManagedSync(engine, f.opts)).status).toBe('first_sync');
  writeFileSync(join(f.root, 'a.md'), note('Alpha two.')); writeFileSync(join(f.root, 'b.md'), fixable('Beta two.')); writeFileSync(join(f.root, 'c.md'), note('Gamma two.'));
  const pin = commit(f.root, 'version two');
  let fired = false;
  installFaultHook(async (point, detail) => {
    if (point !== 'publication:prepared' || detail.sourceId !== f.id || fired) return;
    const [row] = await engine.executeRaw<{ slug: string }>('SELECT slug FROM persistence_requests WHERE request_id=$1', [detail.requestId]);
    if (row?.slug !== 'b') return;
    fired = true;
    writeFileSync(join(f.root, 'b.md'), fixable('Beta two.', STAMP));
    throw Object.assign(new Error('write ECONNRESET'), { code: 'ECONNRESET' });
  });
  let first;
  try { first = await performManagedSync(engine, f.opts); } finally { installFaultHook(undefined); }
  expect(fired).toBe(true);
  expect(first).toMatchObject({ status: 'partial', managedWrite: { slug: 'b', reason: 'unexpected_file_bytes' } });
  stamped(f.root);
  const fx = stuckRecoveryFixture(engine, roots);
  const preview = await fx.repair(f.id);
  expect(preview.affected).toBe(1);
  const applied = await fx.repair(f.id, { apply: true, expect: preview.preview_hash, keep: 'disk' });
  expect(applied.outcomes).toEqual({ resolved: 1 });
  // The follow-up names the plain sync that finishes the abandoned import, not a reconcile first.
  expect(String(applied.outcome_items![0]!.detail!.next)).toContain(`Next: gbrain sync --source ${f.id} --no-pull.`);
  const [abandoned] = await engine.executeRaw<Pick<WriteRequest, 'state' | 'error_code' | 'error_message'>>(
    "SELECT state,error_code,error_message FROM persistence_requests WHERE source_id=$1 AND slug='b' ORDER BY created_at DESC LIMIT 1", [f.id]);
  expect(abandoned).toMatchObject({ state: 'conflict', error_code: 'source_changed' });
  expect(abandoned.error_message ?? '').toContain('--keep disk');
  expect(fileChangedAfterAdmission(abandoned)).toBe(true);
  // The in-process consumer backs off after the dropped connection; the next sync starts a fresh one, as a restarted owner would.
  await disposePersistenceConsumer(engine);
  return { f, pin };
}

/** Resumes until the run settles; the in-process consumer may return a pass or two partial while it drains c. */
async function settle(engine: BrainEngine, opts: Parameters<typeof performManagedSync>[1]) {
  let result = await performManagedSync(engine, opts);
  for (let i = 0; i < 8 && result.status === 'partial' && result.reason === 'writer_pending'; i++) { await new Promise(r => setTimeout(r, 1000)); result = await performManagedSync(engine, opts); }
  return result;
}

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  installFaultHook(undefined);
  await withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      for (const id of sources) await engine.executeRaw('DELETE FROM sources WHERE id=$1', [id]); await engine.disconnect(); }
  });
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

test('#6858: a page abandoned by repair stuck-recovery --keep disk with uncommitted disk bytes is held worktree_dirty and the rest of the run drains', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  for (const engine of engines) {
    const { f, pin } = await abandonedMidRun(engine, () => {});
    const resumed = await settle(engine, f.opts);
    expect(resumed).toMatchObject({ status: 'synced', toCommit: pin, held_count: 1, held: [{ path: 'b.md', code: 'worktree_dirty' }] });
    expect(resumed.failedFiles ?? 0).toBe(0);
    expect(await readManagedSyncFailures(engine, [f.id])).toEqual([]);
    expect((await engine.getPage('c', { sourceId: f.id }))?.compiled_truth).toContain('Gamma two.');
    expect((await engine.getPage('b', { sourceId: f.id }))?.compiled_truth).toContain('Beta one.');
    expect(readFileSync(join(f.root, 'b.md'), 'utf8')).toBe(fixable('Beta two.', STAMP));
  }
}), 240_000);

test('#6858: when the kept disk bytes are HEAD (the lossless --keep disk case) the re-freeze imports them in the same pass', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  for (const engine of engines) {
    const { f, pin } = await abandonedMidRun(engine, root => { commit(root, 'the stamped bytes are committed'); });
    const head = git(f.root, 'rev-parse', 'HEAD');
    expect(head).not.toBe(pin);
    // The pass pins HEAD, the commit of the stamped bytes, where the cursor finished at its frozen target.
    const resumed = await settle(engine, f.opts);
    expect(resumed).toMatchObject({ status: 'synced', toCommit: head, pass: { kind: 'full', outcome: 'synced', remaining: 0 } });
    expect(resumed.held ?? []).toEqual([]);
    expect(resumed.failedFiles ?? 0).toBe(0);
    expect(await readManagedSyncFailures(engine, [f.id])).toEqual([]);
    expect((await engine.getPage('b', { sourceId: f.id }))?.compiled_truth).toContain('Beta two.');
    expect((await engine.getPage('c', { sourceId: f.id }))?.compiled_truth).toContain('Gamma two.');
  }
}), 240_000);
