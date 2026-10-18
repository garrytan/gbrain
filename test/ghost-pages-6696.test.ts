/**
 * #6696 B5: ghost pages, one classifier.
 *
 * A ghost is a live page whose canonical file is gone on the owner host (`liveFileDrift` reason
 * `canonical_file_missing`). Protects: the classifier per state (agrees, drift, missing file, declared db_only, deleted
 * page), doctor `ghost_pages`, `gbrain pages ghosts --json`, and `gbrain repair ghost-pages`: preview, consent refusal
 * (exit 3, nothing changed), apply of exactly the previewed set, refusal off the owner host, the mass-delete valve, a file
 * restored between preview and apply (before the run, before preparation, before filesystem publication), the unmanaged
 * soft delete, and the exact argv the terminal-receipt classifier prints. Every case drives a real PGLite brain with a
 * claimed canonical worktree; none needs a seam beyond the existing persistence fault hook.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { liveFileDrift } from '../src/core/persistence/drift-conflicts.ts';
import { classifyTerminal } from '../src/core/persistence/terminal-classify.ts';
import { readGhostPages, ghostPageNow } from '../src/core/ghost-pages.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { AUTO_REPAIR_REGISTRY, EXPLICIT_REPAIR_REGISTRY, repairForCheck, repairRunner, repairSpec } from '../src/core/repair/registry.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { runPagesGhosts } from '../src/commands/pages-ghosts.ts';
import { ghostPagesEntry } from '../src/commands/doctor/checks/ghost-pages.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { withEnv } from './helpers/with-env.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const logger = { info() {}, warn() {}, error() {} };
let engine: BrainEngine;

interface Fixture { root: string; home: string; sourceId: string; ctx: OperationContext }

async function fixture(run: (f: Fixture) => Promise<void>, opts: { managed?: boolean } = {}): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-ghosts-'));
  const root = join(dir, 'brain'); mkdirSync(root);
  const home = join(dir, 'home');
  execFileSync('git', ['init', '-q'], { cwd: root });
  const sourceId = `ghost-${randomUUID().slice(0, 8)}`;
  const managed = opts.managed !== false;
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
      await engine.setConfig('sync.write_through', 'true');
      await claimWorktree(engine, sourceId, root);
      if (managed) await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const ctx = { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger } as OperationContext;
      await run({ root, home, sourceId, ctx });
    });
  } finally {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [sourceId]);
    rmSync(dir, { recursive: true, force: true });
  }
}

const page = (title: string) => `---\ntype: note\ntitle: ${title}\n---\n\n${title} body.\n`;
const put = (ctx: OperationContext, slug: string) => submitPageMutation(ctx, { operation: 'put_page', params: { slug, content: page(slug), request_id: randomUUID() } });
const live = async (sourceId: string, slug: string) => (await engine.executeRaw<{ n: number }>(
  'SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [sourceId, slug]))[0]!.n === 1;

async function capture(fn: () => Promise<void>): Promise<string> {
  let printed = '';
  const original = console.log, write = process.stdout.write;
  console.log = (...parts: unknown[]) => { printed += `${parts.map(String).join(' ')}\n`; };
  process.stdout.write = ((chunk: string | Uint8Array) => { printed += String(chunk); return true; }) as typeof process.stdout.write;
  try { await fn(); } finally { console.log = original; process.stdout.write = write; }
  return printed;
}

async function refusal(fn: () => Promise<unknown>): Promise<OperationError> {
  try { await fn(); } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected a refusal');
}

const repair = async (sourceId: string, opts: { apply?: boolean; expect?: string } = {}) => (await repairRunner(engine, { apply: opts.apply === true, logger }))
  .run('ghost-pages', await resolveRepairScope(engine, sourceId), { explicit: true, sourceFlag: sourceId, expect: opts.expect });

/** notes/agrees (file matches), notes/drift (file edited), notes/ghost (file removed), scratch/kept (declared db_only, file removed), notes/gone (deleted). */
async function seed(f: Fixture): Promise<string> {
  writeFileSync(join(f.root, 'gbrain.yml'), 'storage:\n  db_only:\n    - scratch/\n');
  for (const slug of ['notes/agrees', 'notes/drift', 'notes/ghost', 'scratch/kept', 'notes/gone']) await put(f.ctx, slug);
  writeFileSync(join(f.root, 'notes/drift.md'), readFileSync(join(f.root, 'notes/drift.md'), 'utf8').replace('body.', 'body, edited in the file only.'));
  const ghostBytes = readFileSync(join(f.root, 'notes/ghost.md'), 'utf8');
  unlinkSync(join(f.root, 'notes/ghost.md'));
  if (existsSync(join(f.root, 'scratch/kept.md'))) unlinkSync(join(f.root, 'scratch/kept.md'));
  const gone = (await engine.readPageSnapshot('notes/gone', { sourceId: f.sourceId }))!;
  await submitPageMutation(f.ctx, { operation: 'delete_page', params: { slug: 'notes/gone', expected_revision: gone.revision, request_id: randomUUID() } });
  return ghostBytes;
}

for (const backend of testBackends()) describe(`#6696 B5 ghost pages (${backend})`, () => {
  let closePostgres: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (backend === 'pglite') {
      const pglite = new PGLiteEngine();
      await pglite.connect({}); await pglite.initSchema(); engine = pglite;
    } else {
      const pg = await isolatedPersistencePostgres(requirePostgresTestDatabase());
      engine = pg.engine; closePostgres = pg.close;
    }
  }, 120_000);
  afterAll(async () => {
    await disposePersistenceConsumer(engine);
    if (closePostgres) await closePostgres(); else await engine.disconnect();
  });
  beforeEach(() => _resetCliExitVerdictForTests());
  afterEach(() => { installFaultHook(undefined); _resetCliExitVerdictForTests(); });

  test('one classifier: a missing canonical file is a ghost; agrees, drift, declared db_only and deleted pages are not', () => fixture(async f => {
    await seed(f);
    expect((await liveFileDrift(engine, f.sourceId, 'notes/ghost')).reason).toBe('canonical_file_missing');
    expect((await liveFileDrift(engine, f.sourceId, 'notes/drift')).reason).toBe('file_database_drift');
    expect((await liveFileDrift(engine, f.sourceId, 'notes/agrees')).reason).toBe('agrees');
    expect((await liveFileDrift(engine, f.sourceId, 'scratch/kept')).reason).toBe('database_only');
    const summary = await readGhostPages(engine, { sourceIds: [f.sourceId] });
    expect(summary).toMatchObject({ status: 'known', count: 1, truncated: false, exact: true,
      by_source: [{ source_id: f.sourceId, count: 1, status: 'known' }] });
    expect(summary.samples).toEqual([{ source_id: f.sourceId, slug: 'notes/ghost', path: 'notes/ghost.md', revision: expect.any(String), page_id: expect.any(Number) }]);
    expect(summary.inspected).toBe(4);
    expect((await ghostPageNow(engine, f.sourceId, 'notes/agrees')).ghost).toBeNull();
  }));

  test('doctor ghost_pages counts the ghosts with bounded samples and the read-only preview as its fix', () => fixture(async f => {
    await seed(f);
    const [check] = await ghostPagesEntry.run({ engine } as never) as Array<Record<string, any>>;
    expect(check).toMatchObject({ name: 'ghost_pages', status: 'warn', details: { count: 1, inspected: 4, truncated: false, exact: true } });
    expect(check.details.samples.map((s: { slug: string }) => s.slug)).toEqual(['notes/ghost']);
    expect(check.fix).toMatchObject({ argv: ['gbrain', 'repair', 'ghost-pages', '--source', f.sourceId, '--json'], consent: [], actor: 'agent',
      requires_exclusive: false, verify: { argv: ['gbrain', 'doctor', '--only', 'ghost_pages', '--json'] }, docs: 'docs/guides/repair.md#ghost-pages' });
    expect(check.message).toContain(`gbrain repair ghost-pages --source ${f.sourceId}`);
    expect(categorizeCheck('ghost_pages')).toBe('brain');
    expect(repairForCheck('ghost_pages')?.kind).toBe('ghost-pages');
  }));

  test('off the owner host doctor is ok/info, pages ghosts and the repair refuse not_owner_host', () => fixture(async f => {
    await seed(f);
    const hash = (await repair(f.sourceId)).preview_hash!;
    await withEnv({ GBRAIN_HOME: join(f.home, '..', 'other-host') }, async () => {
      const [check] = await ghostPagesEntry.run({ engine } as never) as Array<Record<string, any>>;
      expect(check).toMatchObject({ name: 'ghost_pages', status: 'ok', severity: 'info', readiness_state: 'not_applicable' });
      expect((await readGhostPages(engine, { sourceIds: [f.sourceId] })).reason).toBe('not_owner_host');
      expect((await refusal(() => runPagesGhosts(engine, ['--source', f.sourceId, '--json']))).code).toBe('not_owner_host');
      expect((await refusal(() => repair(f.sourceId))).code).toBe('not_owner_host');
      expect((await refusal(() => repair(f.sourceId, { apply: true, expect: hash }))).code).toBe('not_owner_host');
    });
    expect(await live(f.sourceId, 'notes/ghost')).toBe(true);
  }));

  test('pages ghosts --json lists the ghost with its recorded path and revision', () => fixture(async f => {
    await seed(f);
    const out = JSON.parse(await capture(() => runPagesGhosts(engine, ['--source', f.sourceId, '--json'])));
    expect(out).toMatchObject({ source_id: f.sourceId, status: 'known', count: 1, inspected: 4, truncated: false, exact: true });
    expect(out.ghosts).toEqual([{ source_id: f.sourceId, slug: 'notes/ghost', path: 'notes/ghost.md', revision: expect.any(String), page_id: expect.any(Number) }]);
    expect(out.next[0]).toContain(`gbrain repair ghost-pages --source ${f.sourceId}`);
  }));

  test('the exact argv the terminal classifier prints is a read-only preview that prints the apply command with its hash', () => fixture(async f => {
    await seed(f);
    const verdict = classifyTerminal({ source_id: f.sourceId, slug: 'notes/ghost', operation: 'put_page', state: 'conflict', error_code: 'source_changed',
      error_detail: null, error_message: 'The canonical file was removed outside coordinated publication.', recovery: null, blocked_reason: null, compacted: false })!;
    expect(verdict.action.argv).toEqual(['gbrain', 'repair', 'ghost-pages', '--source', f.sourceId]);
    const out = await capture(() => runRepairCommand(engine, verdict.action.argv!.slice(2)));
    expect(out).toContain('ghost-pages: 1 item(s) to repair');
    expect(out).toContain(`canonical_file_missing: ${f.sourceId}:notes/ghost (file notes/ghost.md is missing`);
    expect(out).toMatch(new RegExp(`apply: gbrain repair ghost-pages --source ${f.sourceId} --apply --expect [0-9a-f]{64} --yes`));
    expect(out).toContain('gbrain restore <slug> --force');
    expect(out).toContain('72 h');
    expect(await live(f.sourceId, 'notes/ghost')).toBe(true);
  }));

  test('preview, consent refusal with zero changes, then apply soft-deletes exactly the previewed set', () => fixture(async f => {
    await seed(f);
    expect(repairSpec('ghost-pages')).toMatchObject({ explicit_only: true, preview_bound: true, consent: 'destructive', embeds: 'none', checks: ['ghost_pages'] });
    expect(EXPLICIT_REPAIR_REGISTRY.map(spec => spec.kind)).toContain('ghost-pages');
    expect(AUTO_REPAIR_REGISTRY.map(spec => spec.kind)).not.toContain('ghost-pages');
    const preview = JSON.parse(await capture(() => runRepairCommand(engine, ['ghost-pages', '--source', f.sourceId, '--json']))).results[0];
    expect(preview.listing.map((entry: { item: string }) => entry.item)).toEqual([`${f.sourceId}:notes/ghost`]);
    expect(preview.apply_command).toBe(`gbrain repair ghost-pages --source ${f.sourceId} --apply --expect ${preview.preview_hash} --yes`);
    const requests = async () => Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1', [f.sourceId]))[0]!.n);
    const before = await requests();

    const priorExitCode = process.exitCode;
    const refused = await withEnv({ GBRAIN_INTERACTIVE: '0', CI: '1' }, () => capture(() =>
      runRepairCommand(engine, ['ghost-pages', '--source', f.sourceId, '--apply', '--expect', preview.preview_hash, '--json'])));
    expect(currentExitCode()).toBe(3);
    process.exitCode = priorExitCode ?? 0;
    expect(refused).toContain('user_message');
    expect(refused).toContain('gbrain restore <slug> --force');
    expect(await live(f.sourceId, 'notes/ghost')).toBe(true);
    expect(await requests()).toBe(before);
    _resetCliExitVerdictForTests();

    const applied = JSON.parse(await withEnv({ GBRAIN_INTERACTIVE: '0', CI: '1' }, () => capture(() =>
      runRepairCommand(engine, ['ghost-pages', '--source', f.sourceId, '--apply', '--expect', preview.preview_hash, '--yes', '--json'])))).results[0];
    expect(applied).toMatchObject({ mode: 'apply', applied: 1, skipped: 0, failed: [], complete: true, outcomes: { soft_deleted: 1 } });
    expect(await live(f.sourceId, 'notes/ghost')).toBe(false);
    for (const slug of ['notes/agrees', 'notes/drift', 'scratch/kept']) expect(await live(f.sourceId, slug)).toBe(true);
    expect((await readGhostPages(engine, { sourceIds: [f.sourceId] })).count).toBe(0);
  }));

  test('the mass-delete valve refuses when ghosts are over half of the file-backed pages', () => fixture(async f => {
    const slugs = Array.from({ length: 22 }, (_, i) => `notes/page-${String(i).padStart(2, '0')}`);
    for (const slug of slugs) await put(f.ctx, slug);
    for (const slug of slugs.slice(0, 12)) unlinkSync(join(f.root, `${slug}.md`));
    const preview = await repair(f.sourceId);
    expect(preview.affected).toBe(12);
    expect(preview.residuals).toMatchObject({ ghosts: 12, file_backed: 22 });
    expect(preview.warnings?.[0]).toContain('ghost_mass_delete_refused');
    const error = await refusal(() => repair(f.sourceId, { apply: true, expect: preview.preview_hash }));
    expect(error.code).toBe('ghost_mass_delete_refused');
    for (const slug of slugs) expect(await live(f.sourceId, slug)).toBe(true);
  }));

  test('a file restored between preview and apply keeps its page and asks for a new preview', () => fixture(async f => {
    const bytes = await seed(f);
    const preview = await repair(f.sourceId);
    writeFileSync(join(f.root, 'notes/ghost.md'), bytes);
    const applied = await repair(f.sourceId, { apply: true, expect: preview.preview_hash });
    expect(applied).toMatchObject({ applied: 0, skipped: 1, outcomes: { file_restored: 1 } });
    expect(applied.outcome_items![0]!.reason).toContain(`gbrain repair ghost-pages --source ${f.sourceId}`);
    expect(await live(f.sourceId, 'notes/ghost')).toBe(true);
  }));

  for (const point of ['consumer:preparing', 'consumer:prepared'] as const) {
    test(`a file restored at ${point} is refused by the ${point === 'consumer:preparing' ? 'preparer' : 'filesystem publication'} and the page is kept`, () => fixture(async f => {
      const bytes = await seed(f);
      const preview = await repair(f.sourceId);
      installFaultHook((at, detail) => {
        if (at === point && detail.operation === 'submit_job') writeFileSync(join(f.root, 'notes/ghost.md'), bytes);
      });
      const applied = await repair(f.sourceId, { apply: true, expect: preview.preview_hash });
      expect(applied).toMatchObject({ applied: 0, outcomes: { file_restored: 1 } });
      expect(await live(f.sourceId, 'notes/ghost')).toBe(true);
      expect(readFileSync(join(f.root, 'notes/ghost.md'), 'utf8')).toBe(bytes);
    }));
  }

  test('an unmanaged brain soft-deletes the approved ghost directly', () => fixture(async f => {
    mkdirSync(join(f.root, 'notes'));
    for (const slug of ['notes/one', 'notes/two']) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body.` }, { sourceId: f.sourceId });
      await engine.executeRaw('UPDATE pages SET source_path=$3 WHERE source_id=$1 AND slug=$2', [f.sourceId, slug, `${slug}.md`]);
      const snapshot = (await engine.readPageSnapshot(slug, { sourceId: f.sourceId }))!;
      const { serializePageToMarkdown } = await import('../src/core/markdown.ts');
      writeFileSync(join(f.root, `${slug}.md`), serializePageToMarkdown(snapshot.page, snapshot.tags));
    }
    unlinkSync(join(f.root, 'notes/two.md'));
    const preview = await repair(f.sourceId);
    expect(preview.sample).toEqual([`${f.sourceId}:notes/two`]);
    const applied = await repair(f.sourceId, { apply: true, expect: preview.preview_hash });
    expect(applied).toMatchObject({ applied: 1, outcomes: { soft_deleted: 1 } });
    expect(await live(f.sourceId, 'notes/two')).toBe(false);
    expect(await live(f.sourceId, 'notes/one')).toBe(true);
  }, { managed: false }));
});
