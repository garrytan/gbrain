/**
 * #8059 end to end: the content-repair lane wraps prose-quoted fence markers, on a managed Git source and on a
 * repo-less brain, through the real `fences` kind.
 *
 * 1. Protects: a committed transcript that quotes the facts markers in prose above a real fence is held `invalid_fence`
 *    with reason `quoted_marker` (not a person's `repeated_marker`), listed as repairable; `sync unblock --apply`
 *    wraps the mentions in backticks through the managed write-back with a receipt, and the next sync imports the page
 *    with its real fence. A hold an older gbrain screened (no `quote_version`) is screened once more, without moving the
 *    parser version. On a brain with no repository, `repair content` previews the stored page as `quote_marker` and
 *    `--apply --expect` rewrites it in the database; the real fence's rows land.
 * 2. Fails when: the hold stays manual, unblock refuses it, the edit drops a row or misses the receipt, or the db path
 *    does not repair.
 * 3. PGLite, and PostgreSQL when DATABASE_URL is set.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readSyncStatus, unblockSync } from '../src/core/persistence/sync-status.ts';
import { holdRescreenDue, readGitHold, SYNC_IMPORT_PARSER_VERSION } from '../src/core/persistence/sync-holds.ts';
import { RECOVERY_VERSION } from '../src/core/markdown.ts';
import { FENCE_VERSION } from '../src/core/fence-repair/refusal.ts';
import { QUOTE_SCREEN_VERSION } from '../src/core/fence-repair/quote-markers.ts';
import { FACTS_FENCE_BEGIN as B, FACTS_FENCE_END as E } from '../src/core/facts-fence.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import type { RepairResult } from '../src/core/repair/core.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-8059-'));
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_FENCE_REPAIR_SCAN_MS: '60000', OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, VOYAGE_API_KEY: undefined };
const backends = testBackends();
const engines: Array<{ kind: string; engine: BrainEngine }> = [];
const repoless: Array<{ kind: string; engine: BrainEngine }> = [];
const closers: Array<() => Promise<void>> = [];
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const tick = (m: string) => `\`${m}\``;
const HEADER = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |';
const SEP = '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|';
const row = (n: number) => `| ${n} | Acme Example claim ${n} | fact | 0.9 | world | medium | 2024-01-01 |  | note | ctx |`;
const FENCE = [B, HEADER, SEP, row(1), row(2), E].join('\n');
const PROSE = (b: string, e: string) => `In the call we said ${b} starts a fence and ${e} ends it.\n\n`;
const md = (body: string) => `---\ntitle: Transcript\ntype: note\n---\n${body}`;

beforeAll(async () => {
  for (const into of [engines, repoless]) {
    if (backends.includes('pglite')) { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); into.push({ kind: 'pglite', engine: lite }); }
    if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); into.push({ kind: 'postgres', engine: pg.engine }); closers.push(pg.close); }
  }
}, 180_000);
afterAll(async () => {
  await withEnv(env, async () => { for (const { engine } of [...engines, ...repoless]) { await disposePersistenceConsumer(engine); await engine.disconnect(); } });
  for (const close of closers) await close();
  rmSync(home, { recursive: true, force: true });
});

async function managedSource(engine: BrainEngine, files: Record<string, string>) {
  const id = `q-${randomUUID().replace(/-/g, '').slice(0, 20)}`, root = join(home, id);
  mkdirSync(root); git(root, 'init', '-q');
  for (const [path, body] of Object.entries(files)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), body); }
  commit(root, 'fixture');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root, opts: { sourceId: id, noPull: true, noEmbed: true, noExtract: true } };
}

async function cli(engine: BrainEngine, args: string[]): Promise<string> {
  const out: string[] = [];
  const log = console.log;
  console.log = (...parts: unknown[]) => { out.push(parts.join(' ')); };
  try { await runRepairCommand(engine, args); } finally { console.log = log; }
  return out.join('\n');
}

test('a transcript that quotes the markers in prose is held quoted_marker, and sync unblock --apply wraps them with a receipt', async () => withEnv(env, async () => {
  for (const { kind, engine } of engines) {
    const f = await managedSource(engine, { 'notes/plain.md': md('Plain.\n') });
    await performManagedSync(engine, f.opts);
    writeFileSync(join(f.root, 'notes/transcript.md'), md(`${PROSE(B, E)}${FENCE}\n`));
    commit(f.root, 'transcript');
    expect((await performManagedSync(engine, f.opts)).held?.map(h => h.path), kind).toEqual(['notes/transcript.md']);
    const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [f.id]);
    const hold = await readGitHold(engine, f.id, source!.incarnation, 'notes/transcript.md');
    expect(hold?.meta.fence?.reason, kind).toBe('quoted_marker');
    expect(hold?.meta.quote_version, kind).toBe(QUOTE_SCREEN_VERSION);
    expect((await readSyncStatus(engine, f.id)).holds.find(h => h.path === 'notes/transcript.md')?.needs_human, kind).toBe(false);

    const applied = await unblockSync(engine, f.id, { apply: true, noLlm: true });
    expect(applied.refused, kind).toEqual([]);
    expect(applied.applied.find(entry => entry.path === 'notes/transcript.md'), kind).toMatchObject({ action: 'repair',
      repair: { kind: 'fences', outcome: 'repaired', tier: 'deterministic', receipt: { mode: 'managed', path: 'notes/transcript.md', classes: 'quote_marker', hold_cleared: true } } });
    expect(readFileSync(join(f.root, 'notes/transcript.md'), 'utf8'), kind).toBe(md(`${PROSE(tick(B), tick(E))}${FENCE}\n`));

    await performManagedSync(engine, f.opts);
    expect(await readGitHold(engine, f.id, source!.incarnation, 'notes/transcript.md'), kind).toBeNull();
    const page = await engine.getPage('notes/transcript', { sourceId: f.id });
    expect(page?.compiled_truth, kind).toContain(tick(B));
    const facts = await engine.executeRaw<{ row_num: number }>('SELECT row_num FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 ORDER BY row_num', [f.id, 'notes/transcript']);
    expect(facts.map(r => Number(r.row_num)), kind).toEqual([1, 2]);
  }
}), 240_000);

test('an invalid_fence hold an older gbrain screened is screened once more, and the parser version does not move', () => {
  const meta = { recovery_version: RECOVERY_VERSION, fence_version: FENCE_VERSION };
  expect(holdRescreenDue({ code: 'invalid_fence', meta }, false)).toBe(true);
  expect(holdRescreenDue({ code: 'invalid_fence', meta: { ...meta, quote_version: QUOTE_SCREEN_VERSION } }, false)).toBe(false);
  expect(SYNC_IMPORT_PARSER_VERSION).toBe(`import=1;frontmatter=${RECOVERY_VERSION};fence=${FENCE_VERSION}`);
});

test('a brain with no repository: repair content previews the deterministic repair of the stored page and --apply --expect rewrites it in the database', async () => withEnv(env, async () => {
  for (const { kind, engine } of repoless) {
    const sourceId = `d-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    await engine.executeRaw("INSERT INTO sources(id,name,config) VALUES($1,$1,'{}')", [sourceId]);
    await engine.putPage('notes/db-transcript', { type: 'note', title: 'Transcript', compiled_truth: `${PROSE(B, E)}${FENCE}\n`, timeline: '' }, { sourceId });
    const preview = JSON.parse(await cli(engine, ['content', '--source', sourceId, '--json'])) as { preview_hashes: Record<string, string | null>; results: RepairResult[] };
    const fences = preview.results.find(r => r.kind === 'fences')!;
    expect(fences.listing?.map(entry => [entry.item, entry.class]), kind).toEqual([[`${sourceId}:notes/db-transcript`, 'deterministic']]);
    const hashes = [preview.preview_hashes.fences, preview.preview_hashes['slug-conflicts']].join(',');
    const applied = JSON.parse(await cli(engine, ['content', '--source', sourceId, '--apply', '--expect', hashes, '--json'])) as { results: RepairResult[] };
    expect(applied.results.find(r => r.kind === 'fences'), kind).toMatchObject({ mode: 'apply', applied: 1, outcomes: { repaired: 1 } });
    expect(applied.results.find(r => r.kind === 'fences')!.outcome_items![0], kind).toMatchObject({ outcome: 'repaired', detail: { tier: 'deterministic', classes: 'quote_marker', mode: 'db' } });
    const page = await engine.getPage('notes/db-transcript', { sourceId });
    expect(page?.compiled_truth.trimEnd(), kind).toBe(`${PROSE(tick(B), tick(E))}${FENCE}`);
    const facts = await engine.executeRaw<{ row_num: number }>('SELECT row_num FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 ORDER BY row_num', [sourceId, 'notes/db-transcript']);
    expect(facts.map(r => Number(r.row_num)), kind).toEqual([1, 2]);
  }
}), 240_000);
