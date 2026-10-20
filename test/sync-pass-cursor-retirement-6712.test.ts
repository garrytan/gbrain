/**
 * #6712 PR 4b lane C (design v3.2 §3.5): the first live pass of a managed, non-company source retires every legacy
 * cursor row of that source incarnation, on a real PGLite managed brain.
 *
 * Protects: after the first pass, `op_checkpoints` holds no `managed-sync`, `managed-sync-manifest` or
 * `managed-sync-slice` row of the synced source (an unfinished cursor under the current key with its manifest and its
 * path-slice record, an unfinished cursor under an older key with its manifest, and a finished older-key cursor with
 * its manifest), the pass row `managed-sync-pass` / `<source>:<incarnation>` exists, the unfinished cursor's options seed
 * the pass's episode (`inherited.from = 'legacy_cursor'`, so the pass inherits its `noExtract`), and the same three kinds of rows of a company source in the
 * same brain stay byte-identical (completed_keys and updated_at). An orphaned slice record (no cursor row left beside it)
 * is retired by the first pass too.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { performSync } from '../src/commands/sync/perform.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { activateSharedSkillPersistence } from '../src/core/persistence/skill-activation.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { managedCursorKey } from '../src/core/persistence/sync-cursor-key.ts';
import { resolveManagedSyncContext } from '../src/core/persistence/sync-discovery.ts';
import { managedSyncAuthority } from '../src/core/persistence/sync-authority.ts';
import { syncCursorOptions, writeSyncSlice } from '../src/core/persistence/sync-slices.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const note = (title: string) => `---\ntype: concept\ntitle: ${title}\n---\n\nA committed note named ${title} at acme-example.\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true };
const COMPANY = 'acme-example-co';
const LEGACY_OPS = ['managed-sync', 'managed-sync-manifest', 'managed-sync-slice'];
const NAMES = ['acme-example', 'alice-example', 'fund-a'];

let engine: PGLiteEngine;
let home: string;
const env = () => ({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined });

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-cursor-retirement-6712-'));
  await withEnv(env(), async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
});

afterAll(async () => {
  await withEnv(env(), async () => { await disposePersistenceConsumer(engine); });
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

type Row = { op: string; fingerprint: string; completed_keys: unknown; updated_at: string };
const legacyRows = (db: BrainEngine) => db.executeRaw<Row>(`SELECT op, fingerprint, completed_keys, updated_at::text AS updated_at FROM op_checkpoints
  WHERE op = ANY($1::text[]) ORDER BY op, fingerprint COLLATE "C"`, [LEGACY_OPS]);
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
async function put(db: BrainEngine, op: string, fingerprint: string, completedKeys: unknown, updatedAt: string) {
  await db.executeRaw('INSERT INTO op_checkpoints(op, fingerprint, completed_keys, updated_at) VALUES($1, $2, $3::text::jsonb, $4::timestamptz)',
    [op, fingerprint, JSON.stringify(completedKeys), updatedAt]);
}
const incarnationOf = async (db: BrainEngine, sourceId: string) =>
  (await db.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]))[0]!.incarnation;

/** A managed brain whose default source is a claimed, committed checkout that has never synced, beside the company source's registration. */
async function plantManagedBrain(db: BrainEngine, dir = 'content'): Promise<string> {
  const root = join(home, dir); mkdirSync(join(root, 'notes'), { recursive: true });
  await db.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [root]);
  git(root, 'init', '-q');
  for (const name of NAMES) writeFileSync(join(root, `notes/${name}.md`), note(name));
  git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
  await db.executeRaw('INSERT INTO sources(id, name) VALUES($1, $1)', [COMPANY]);
  await claimWorktree(db, 'default', root);
  await activateSharedSkillPersistence(db, { confirmQuiesced: true });
  return root;
}

/**
 * The legacy rows an older binary left for the default source: an unfinished cursor under the current key (a path slice
 * of its first sync) with its manifest and slice record, an unfinished cursor under an older key with its manifest, and
 * a finished older-key cursor with its manifest. No request is open under any of them.
 */
async function seedDefaultCursors(db: BrainEngine, root: string, incarnation: string) {
  const context = await resolveManagedSyncContext(db, OPTS as never);
  const authority = await managedSyncAuthority(db, 'default', incarnation, root);
  const head = git(root, 'rev-parse', 'HEAD');
  const entries = NAMES.map(name => ({ path: `notes/${name}.md`, sourcePath: `notes/${name}.md`, action: 'import', working: false, slug: `notes/${name}`, pageId: null, revision: null }));
  const syncOptions = syncCursorOptions(OPTS as never);
  const processingOptions = { noEmbed: true, noExtract: true, noSchemaPack: false };
  const binding = { ...context.binding, owner_epoch: String((context.binding as { owner_epoch?: unknown }).owner_epoch), topology_generation: String(context.binding.topology_generation) };
  const cursor = (runId: string, done: boolean, extra: Record<string, unknown> = {}) => ({ binding, root: context.root, gitRoot: context.gitRoot, sourceId: 'default', incarnation,
    from: null, target: head, slugMode: 'git-root', discoveredAt: at(90), runId, index: done ? entries.length : 0, authority, processingOptions, syncOptions,
    counts: { added: done ? entries.length : 0, modified: 0, deleted: 0, chunks: 0 }, ...(done ? { done: true } : {}), total: entries.length, ...extra });
  const slice = { phase: 'import' as const, after: null, head, target: head };
  await put(db, 'managed-sync', managedCursorKey(incarnation, undefined), [cursor('run-6712-current', false, { slice: { ...slice, done: false } })], at(10));
  await put(db, 'managed-sync-manifest', 'run-6712-current', entries, at(10));
  await writeSyncSlice(db, 'default', incarnation, syncOptions, slice);
  await put(db, 'managed-sync', 'legacy-6712-unfinished', [cursor('run-6712-older', false)], at(60));
  await put(db, 'managed-sync-manifest', 'run-6712-older', entries, at(60));
  await put(db, 'managed-sync', 'legacy-6712-finished', [cursor('run-6712-finished', true)], at(120));
  await put(db, 'managed-sync-manifest', 'run-6712-finished', entries, at(120));
}

/** The same three kinds of rows for a company source: its unfinished and finished approval cursors, their manifests, and a slice record. */
async function seedCompanyCursors(db: BrainEngine) {
  const incarnation = await incarnationOf(db, COMPANY);
  const approval = { receiptId: 'receipt-acme-example', plan: { plan_digest: 'plan-acme-example' } } as never;
  const entries = [{ path: 'handbook/fund-a.md', sourcePath: 'handbook/fund-a.md', action: 'import', working: false, slug: 'handbook/fund-a', pageId: null, revision: null }];
  const header = (runId: string, done: boolean) => ({ sourceId: COMPANY, incarnation, runId, index: done ? 1 : 0, total: 1, companyReceiptId: 'receipt-acme-example',
    counts: { added: 0, modified: 0, deleted: 0, chunks: 0 }, ...(done ? { done: true } : {}) });
  await put(db, 'managed-sync', managedCursorKey(incarnation, approval), [header('run-6712-company', false)], at(30));
  await put(db, 'managed-sync-manifest', 'run-6712-company', entries, at(30));
  await put(db, 'managed-sync', 'legacy-6712-company-finished', [header('run-6712-company-finished', true)], at(180));
  await put(db, 'managed-sync-manifest', 'run-6712-company-finished', entries, at(180));
  await writeSyncSlice(db, COMPANY, incarnation, syncCursorOptions({}), { phase: 'import', after: null, head: 'c0ffee', target: 'c0ffee' });
}
const isCompanyRow = (row: Row) => row.op === 'managed-sync' ? (row.completed_keys as Array<{ sourceId?: string }>)[0]?.sourceId === COMPANY
  : row.op === 'managed-sync-manifest' ? row.fingerprint.startsWith('run-6712-company') : row.fingerprint.startsWith(`${COMPANY}:`);

describe('#6712 PR 4b lane C: the first live pass retires legacy cursor rows (§3.5)', () => {
  test('no managed-sync, managed-sync-manifest or managed-sync-slice row of the synced source remains; the pass row exists; the company source is untouched', () => withEnv(env(), async () => {
    const root = await plantManagedBrain(engine);
    const incarnation = await incarnationOf(engine, 'default');
    await seedDefaultCursors(engine, root, incarnation);
    await seedCompanyCursors(engine);
    const seeded = await legacyRows(engine);
    const company = seeded.filter(isCompanyRow);
    expect(company.map(row => row.op)).toEqual(['managed-sync', 'managed-sync', 'managed-sync-manifest', 'managed-sync-manifest', 'managed-sync-slice']);
    expect(seeded.filter(row => !isCompanyRow(row)).map(row => row.op)).toEqual(['managed-sync', 'managed-sync', 'managed-sync', 'managed-sync-manifest', 'managed-sync-manifest', 'managed-sync-manifest', 'managed-sync-slice']);

    const result = await performSync(engine, OPTS as never);
    expect({ status: result.status, reason: result.reason ?? null }).toEqual({ status: 'first_sync', reason: null });

    expect(await legacyRows(engine)).toEqual(company);
    expect(await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='managed-sync-pass' AND fingerprint=$1", [`default:${incarnation}`])).toHaveLength(1);
    // The unfinished cursor's options seeded the episode: the --no-extract it carried is inherited by this pass, which did not pass it.
    expect(result.inherited_options).toEqual(['noExtract']);
    expect((await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id='default' AND deleted_at IS NULL ORDER BY slug")).map(row => row.slug))
      .toEqual(NAMES.map(name => `notes/${name}`));
  }), 180_000);

});

describe('#6712 PR 4b: the first live pass retires an orphaned slice record', () => {
  let orphan: PGLiteEngine;
  beforeAll(async () => {
    await withEnv(env(), async () => { orphan = new PGLiteEngine(); await orphan.connect({}); await orphan.initSchema(); });
  });
  afterAll(async () => {
    await withEnv(env(), async () => { await disposePersistenceConsumer(orphan); });
    await orphan.disconnect();
  });

  test('an orphaned slice record, with no cursor row beside it, is retired by the first pass; the company slice stays', () => withEnv(env(), async () => {
    const root = await plantManagedBrain(orphan, 'orphan');
    const incarnation = await incarnationOf(orphan, 'default');
    const head = git(root, 'rev-parse', 'HEAD');
    await writeSyncSlice(orphan, 'default', incarnation, syncCursorOptions(OPTS as never), { phase: 'import', after: null, head, target: head });
    await writeSyncSlice(orphan, COMPANY, await incarnationOf(orphan, COMPANY), syncCursorOptions({}), { phase: 'import', after: null, head: 'c0ffee', target: 'c0ffee' });
    const company = (await legacyRows(orphan)).filter(isCompanyRow);
    expect((await legacyRows(orphan)).map(row => row.op)).toEqual(['managed-sync-slice', 'managed-sync-slice']);
    const result = await performSync(orphan, OPTS as never);
    expect(result.status).toBe('first_sync');
    expect(await legacyRows(orphan)).toEqual(company);
  }), 180_000);
});
