// #5180: the cycle's lint phase on a managed brain. Legacy lint writes fixed
// files straight into the worktree, which the managed filesystem guard
// refuses (`writer_coordinator_required`), so every per-source cycle ended
// `partial`. On a managed brain lint now publishes each repair through the
// persistence coordinator (DB row + worktree file in one guarded write),
// leaves files it cannot rewrite pending instead of failing, and keeps the
// legacy filesystem path for unmanaged brains.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runLintCore, type LintIssue } from '../src/commands/lint.ts';
import { runPhaseLint } from '../src/core/cycle.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { disposePersistenceConsumer, startPersistenceConsumer } from '../src/core/persistence/service.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { waitFor } from './helpers/wait-for.ts';

const PREAMBLE = 'Of course. Here is a detailed brain page for Jane Doe.\n\n';
const BODY = '# Jane Doe\n\nContent that stays.\n';
const PAGE = `---\ntitle: Jane Doe\ntype: person\n---\n${PREAMBLE}${BODY}`;
// A page the coordinator wrote carries `ingested_at`, so lint sees TWO fixable
// issues on it: the LLM preamble and `missing-created` (promotable from
// `ingested_at`, #3958). A hand-written file has only the preamble to fix.
const FIXABLE_ON_INDEXED_PAGE = 2;

const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-managed-lint-db-'));
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  const engine = new PGLiteEngine();
  await engine.connect({ database_path: dataDir }); await engine.initSchema(); engines.push(engine);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); resetGateway(); rmSync(dataDir, { recursive: true, force: true });
});

async function fixture(run: (engine: BrainEngine, sourceId: string, root: string) => Promise<void>, owner = true) {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-managed-lint-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    const sourceId = `lint-${randomUUID().slice(0, 8)}`;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        if (owner) await claimWorktree(engine, sourceId, root);
        await run(engine, sourceId, root);
      });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

async function seed(engine: BrainEngine, sourceId: string, slug = 'people/jane-doe', content = PAGE) {
  const ctx = { engine, sourceId, remote: false as const, config: { engine: engine.kind, embedding_disabled: true },
    dryRun: false, logger: { info() {}, warn() {}, error() {} } };
  const current = await engine.readPageSnapshot(slug, { sourceId });
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content, request_id: randomUUID(),
    ...(current ? { expected_revision: current.revision } : {}) } });
}

async function requests(engine: BrainEngine, sourceId: string): Promise<number> {
  return (await engine.executeRaw('SELECT id FROM persistence_requests WHERE source_id=$1', [sourceId])).length;
}

test('managed lint publishes a repair through the coordinator: DB row and worktree file change together', async () => {
  await fixture(async (engine, sourceId, root) => {
    await seed(engine, sourceId);
    const file = join(root, 'people/jane-doe.md');
    expect(readFileSync(file, 'utf8')).toContain(PREAMBLE.trim());
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const before = await requests(engine, sourceId);

    const result = await runLintCore({ target: root, fix: true, engine, sourceId });
    expect(result).toMatchObject({ pages_scanned: 1, total_fixable: FIXABLE_ON_INDEXED_PAGE, total_fixed: FIXABLE_ON_INDEXED_PAGE, fix_pending: 0, write_path: 'coordinator' });

    const snapshot = (await engine.readPageSnapshot('people/jane-doe', { sourceId }))!;
    expect(snapshot.page.compiled_truth).not.toContain('Of course');
    expect(snapshot.page.compiled_truth).toContain('Content that stays.');
    const onDisk = readFileSync(file, 'utf8');
    expect(onDisk).not.toContain('Of course');
    expect(onDisk).toContain('Content that stays.');
    expect(await requests(engine, sourceId)).toBe(before + 1);

    // A second pass finds nothing to fix and admits nothing.
    const again = await runLintCore({ target: root, fix: true, engine, sourceId });
    expect(again).toMatchObject({ total_fixable: 0, total_fixed: 0, fix_pending: 0 });
    expect(await requests(engine, sourceId)).toBe(before + 1);
  });
}, 30_000);

test('managed lint dry-run reports the fixable issue and admits nothing', async () => {
  await fixture(async (engine, sourceId, root) => {
    await seed(engine, sourceId);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const file = join(root, 'people/jane-doe.md');
    const bytes = readFileSync(file, 'utf8');
    const before = await requests(engine, sourceId);
    const result = await runLintCore({ target: root, fix: true, dryRun: true, engine, sourceId });
    expect(result).toMatchObject({ total_fixable: FIXABLE_ON_INDEXED_PAGE, dryRun: true, write_path: 'none', fix_pending: 0 });
    expect(readFileSync(file, 'utf8')).toBe(bytes);
    expect(await requests(engine, sourceId)).toBe(before);
  });
}, 30_000);

test('managed lint leaves a file with no indexed page pending instead of writing the worktree', async () => {
  await fixture(async (engine, sourceId, root) => {
    await seed(engine, sourceId);
    mkdirSync(join(root, 'notes'));
    const stray = join(root, 'notes/stray.md');
    writeFileSync(stray, PAGE);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const before = await requests(engine, sourceId);

    const seen: Array<{ rel: string; rules: string[] }> = [];
    const result = await runLintCore({ target: root, fix: true, engine, sourceId,
      onPageIssues: (rel, issues) => seen.push({ rel, rules: issues.map(i => i.rule) }) });
    // jane-doe: 2 fixable, fixed. stray: preamble fixable but unpublishable (+1 pending issue), missing-created not promotable.
    expect(result).toMatchObject({ pages_scanned: 2, total_fixable: FIXABLE_ON_INDEXED_PAGE + 1, total_fixed: FIXABLE_ON_INDEXED_PAGE, fix_pending: 1, write_path: 'coordinator' });
    expect(readFileSync(stray, 'utf8')).toBe(PAGE);
    expect(seen.find(s => s.rel === 'notes/stray.md')?.rules).toContain('managed-write-pending');
    expect(readFileSync(join(root, 'people/jane-doe.md'), 'utf8')).not.toContain('Of course');
    expect(await requests(engine, sourceId)).toBe(before + 1);
    expect(await engine.readPageSnapshot('notes/stray', { sourceId })).toBeNull();
  });
}, 30_000);

test('the cycle lint phase reports the coordinator write path and stays ok on a healthy managed brain', async () => {
  await fixture(async (engine, sourceId, root) => {
    await seed(engine, sourceId);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const result = await runPhaseLint(root, false, engine, undefined, sourceId);
    expect(result.status).toBe('ok');
    expect(result.details).toMatchObject({ issues: FIXABLE_ON_INDEXED_PAGE, fixed: FIXABLE_ON_INDEXED_PAGE, write_path: 'coordinator', fix_pending: 0 });
    expect(readFileSync(join(root, 'people/jane-doe.md'), 'utf8')).not.toContain('Of course');
  });
}, 30_000);

test('the cycle lint phase fails without an active canonical owner and never touches the worktree', async () => {
  await fixture(async (engine, sourceId, root) => {
    mkdirSync(join(root, 'people'));
    const file = join(root, 'people/jane-doe.md');
    writeFileSync(file, PAGE);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const result = await runPhaseLint(root, false, engine, undefined, sourceId);
    expect(result.status).toBe('fail');
    expect(result.error?.message).toContain('canonical owner');
    expect(readFileSync(file, 'utf8')).toBe(PAGE);
    expect(await requests(engine, sourceId)).toBe(0);
  }, false);
}, 30_000);

test('unmanaged lint keeps the legacy filesystem write path', async () => {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-legacy-lint-'));
    try {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      mkdirSync(join(dir, 'people'));
      const file = join(dir, 'people/jane-doe.md');
      writeFileSync(file, PAGE);
      const result = await runLintCore({ target: dir, fix: true, engine });
      expect(result).toMatchObject({ total_fixed: 1, fix_pending: 0, write_path: 'filesystem' });
      expect(readFileSync(file, 'utf8')).not.toContain('Of course');
      expect(existsSync(join(dir, '.gbrain-owner.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}, 30_000);

// ── Diverged files (P1-1): the coordinator's source_changed refusal is a pending issue, never a failed run ──

const JANE = 'people/jane-doe';
const BOB = 'people/bob-example';

async function body(engine: BrainEngine, sourceId: string, slug: string): Promise<string> {
  return (await engine.readPageSnapshot(slug, { sourceId }))!.page.compiled_truth;
}

async function lintCollecting(engine: BrainEngine, sourceId: string, root: string) {
  const byFile = new Map<string, LintIssue[]>();
  const result = await runLintCore({ target: root, fix: true, engine, sourceId, onPageIssues: (rel, issues) => byFile.set(rel, issues) });
  const pending = (rel: string) => byFile.get(rel)?.find(i => i.rule === 'managed-write-pending');
  return { result, pending };
}

/** Every pending issue carries the stable code, the guide link and never prescribes a sync. */
function expectPendingContract(issue: LintIssue | undefined, reason: string): LintIssue {
  expect(issue).toBeDefined();
  expect(issue).toMatchObject({ rule: 'managed-write-pending', fixable: false, code: 'managed_write_pending', reason });
  expect(issue!.docs).toContain('docs/guides/concurrent-writes.md#lint-repairs-waiting-on-a-managed-brain');
  expect(issue!.fix?.argv ?? []).not.toContain('sync');
  return issue!;
}

test('probe A: an unsynced hand edit leaves its page pending with the coordinator reconcile fix; the run fixes the other page', async () => {
  await fixture(async (engine, sourceId, root) => {
    await seed(engine, sourceId);
    await seed(engine, sourceId, BOB, PAGE.replace('Jane Doe', 'Bob Example'));
    const file = join(root, `${JANE}.md`);
    const edited = `${readFileSync(file, 'utf8')}\nA hand edit not yet synced.\n`;
    writeFileSync(file, edited);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const before = await requests(engine, sourceId);

    const { result, pending } = await lintCollecting(engine, sourceId, root);
    expect(result).toMatchObject({ pages_scanned: 2, total_fixed: FIXABLE_ON_INDEXED_PAGE, fix_pending: 1, write_path: 'coordinator' });
    const issue = expectPendingContract(pending(`${JANE}.md`), 'file_database_drift');
    expect(issue.fix).toMatchObject({ argv: ['gbrain', 'sources', 'reconcile', sourceId, JANE, '--brain', 'host', '--preview'], next: 'run' });
    expect(result.pending_issues).toEqual([issue]);
    // Neither copy of the diverged page changed, and no request was journaled for it.
    expect(readFileSync(file, 'utf8')).toBe(edited);
    expect(await body(engine, sourceId, JANE)).toContain('Of course');
    expect(await body(engine, sourceId, JANE)).not.toContain('hand edit');
    expect(await requests(engine, sourceId)).toBe(before + 1);
    // The other page was repaired in the same run.
    expect(await body(engine, sourceId, BOB)).not.toContain('Of course');
    expect(readFileSync(join(root, `${BOB}.md`), 'utf8')).not.toContain('Of course');
  });
}, 60_000);

test('probe B: a file older than the database stays pending and the newer database content survives', async () => {
  await fixture(async (engine, sourceId, root) => {
    await seed(engine, sourceId);
    const file = join(root, `${JANE}.md`);
    const older = readFileSync(file, 'utf8');
    await seed(engine, sourceId, JANE, PAGE.replace('Content that stays.', 'Content that stays.\n\nA newer database line.'));
    writeFileSync(file, older);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');

    const { result, pending } = await lintCollecting(engine, sourceId, root);
    expect(result).toMatchObject({ total_fixed: 0, fix_pending: 1 });
    const issue = expectPendingContract(pending(`${JANE}.md`), 'file_database_drift');
    expect(issue.fix?.argv).toEqual(['gbrain', 'sources', 'reconcile', sourceId, JANE, '--brain', 'host', '--preview']);
    expect(await body(engine, sourceId, JANE)).toContain('A newer database line.');
    expect(readFileSync(file, 'utf8')).toBe(older);
  });
}, 60_000);

test('a file sync holds keeps the hold repair as its fix', async () => {
  await fixture(async (engine, sourceId, root) => {
    await seed(engine, sourceId);
    const file = join(root, `${JANE}.md`);
    writeFileSync(file, `${readFileSync(file, 'utf8')}\nHeld edit.\n`);
    const snapshot = (await engine.readPageSnapshot(JANE, { sourceId }))!;
    const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [sourceId]);
    await writeGitHold(engine, { source_id: sourceId, incarnation, path: `${JANE}.md`, source_path: `${JANE}.md`, slug: JANE,
      page_id: Number(snapshot.page.id), code: 'invalid_frontmatter', message: 'Invalid YAML frontmatter: key "title" at line 2 continues on unquoted lines.',
      upstream_version: 'sha-fixture', observed_at: new Date().toISOString(), run_id: 'run-1', mode: 'managed',
      meta: { reason: 'needs_interpretation', key: 'title', line: 2, recovery_version: 1 } });
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');

    const { result, pending } = await lintCollecting(engine, sourceId, root);
    expect(result.fix_pending).toBe(1);
    const issue = expectPendingContract(pending(`${JANE}.md`), 'held_file');
    expect(issue.fix?.argv).toEqual(['gbrain', 'repair', 'frontmatter', '--source', sourceId, '--include-ambiguous']);
  });
}, 60_000);

test('a canonical file removed between scan and repair is pending as canonical_file_missing', async () => {
  await fixture(async (engine, sourceId, root) => {
    await seed(engine, sourceId);
    const file = join(root, `${JANE}.md`);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const restore = await interceptSnapshot(engine, sourceId, JANE, 'before', async () => { unlinkSync(file); });
    try {
      const { result, pending } = await lintCollecting(engine, sourceId, root);
      expect(result.fix_pending).toBe(1);
      expectPendingContract(pending(`${JANE}.md`), 'canonical_file_missing');
      expect(await body(engine, sourceId, JANE)).toContain('Of course');
    } finally { restore(); }
  });
}, 60_000);

test('a listed canonical file removed before its scan read: managed --fix reports canonical_file_missing, report-only reports file_removed_during_scan', async () => {
  for (const fix of [true, false]) {
    await fixture(async (engine, sourceId, root) => {
      await seed(engine, sourceId, BOB, PAGE.replace(/Jane Doe/g, 'Bob Example'));
      await seed(engine, sourceId);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const byFile = new Map<string, LintIssue[]>();
      let scanned = 0;
      const result = await runLintCore({ target: root, fix, engine, sourceId, onPageIssues: (rel, issues) => byFile.set(rel, issues),
        onPageScanned: () => { if (scanned++ === 0) unlinkSync(join(root, `${JANE}.md`)); } });
      expect(result.pages_scanned).toBe(2);
      if (fix) {
        expect(result.fix_pending).toBe(1);
        expect(result.pending_issues).toEqual([expectPendingContract(byFile.get(`${JANE}.md`)?.[0], 'canonical_file_missing')]);
        expect(await body(engine, sourceId, JANE)).toContain('Of course');
        expect(await body(engine, sourceId, BOB)).not.toContain('Of course');
      } else {
        expect(result.fix_pending).toBe(0);
        expect(byFile.get(`${JANE}.md`)).toEqual([expect.objectContaining({ rule: 'file-removed-during-scan', code: 'file_removed_during_scan', fixable: false,
          fix: expect.objectContaining({ argv: ['gbrain', 'lint', root] }) })]);
      }
    });
  }
}, 60_000);

/**
 * Runs `effect` once, around lint's first revision read of `slug` (in publishLintFix, after the scan read):
 * before it (the read sees the effect) or after it. The persistence consumer reads page snapshots through the
 * same engine (the seeded page's git and embedding effects), so the seed's effects settle first and only
 * lint's own read counts: a background read must never fire the effect.
 */
async function interceptSnapshot(engine: BrainEngine, sourceId: string, slug: string, when: 'before' | 'after', effect: () => Promise<void>): Promise<() => void> {
  startPersistenceConsumer(engine, { engine: engine.kind });
  await waitFor(async () => (await engine.executeRaw(`SELECT 1 FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
    WHERE r.source_id=$1 AND e.state IN ('queued','running')`, [sourceId])).length === 0, { label: `${engine.kind}: effects of ${slug} settled before interception` });
  const original = engine.readPageSnapshot;
  let fired = false;
  // A transaction handle inherits this property, so the read keeps its own receiver.
  engine.readPageSnapshot = async function (this: BrainEngine, s: string, opts?: Parameters<BrainEngine['readPageSnapshot']>[1]) {
    if (fired || s !== slug || !new Error().stack?.includes('publishLintFix')) return original.call(this, s, opts);
    fired = true;
    if (when === 'before') await effect();
    const snapshot = await original.call(this, s, opts);
    if (when === 'after') await effect();
    return snapshot;
  } as BrainEngine['readPageSnapshot'];
  return () => { engine.readPageSnapshot = original; };
}

const NEWER = PAGE.replace('Content that stays.', 'Content that stays.\n\nA concurrent publication.');

test('a publication after the scan but before lint reads the revision is repaired as published, never overwritten', async () => {
  await fixture(async (engine, sourceId, root) => {
    await seed(engine, sourceId);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const restore = await interceptSnapshot(engine, sourceId, JANE, 'before', () => seed(engine, sourceId, JANE, NEWER));
    try {
      const { result } = await lintCollecting(engine, sourceId, root);
      expect(result.fix_pending).toBe(0);
    } finally { restore(); }
    const stored = await body(engine, sourceId, JANE);
    expect(stored).toContain('A concurrent publication.');
    expect(stored).not.toContain('Of course');
    expect(readFileSync(join(root, `${JANE}.md`), 'utf8')).toContain('A concurrent publication.');
  });
}, 60_000);

test('a publication between the revision read and the submission is refused as revision_changed', async () => {
  await fixture(async (engine, sourceId, root) => {
    await seed(engine, sourceId);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const restore = await interceptSnapshot(engine, sourceId, JANE, 'after', () => seed(engine, sourceId, JANE, NEWER));
    try {
      const { result, pending } = await lintCollecting(engine, sourceId, root);
      expect(result.fix_pending).toBe(1);
      const issue = expectPendingContract(pending(`${JANE}.md`), 'revision_changed');
      expect(issue.fix?.argv).toEqual(['gbrain', 'get', '--source', sourceId, '--', JANE]);
    } finally { restore(); }
    const stored = await body(engine, sourceId, JANE);
    expect(stored).toContain('A concurrent publication.');
    expect(stored).toContain('Of course');
  });
}, 60_000);

test('fixable formatting differences are repaired, not mistaken for divergence', async () => {
  await fixture(async (engine, sourceId, root) => {
    await seed(engine, sourceId);
    const file = join(root, `${JANE}.md`);
    const original = readFileSync(file, 'utf8');
    const [, frontmatter, rest] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(original)!;
    // Same page, other bytes: frontmatter keys reversed and the title quoted.
    const reformatted = `---\n${frontmatter.split('\n').reverse().join('\n').replace(/^title: (.*)$/m, 'title: "$1"')}\n---\n${rest}`;
    expect(reformatted).not.toBe(original);
    writeFileSync(file, reformatted);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');

    const { result } = await lintCollecting(engine, sourceId, root);
    expect(result).toMatchObject({ total_fixed: FIXABLE_ON_INDEXED_PAGE, fix_pending: 0 });
    expect(await body(engine, sourceId, JANE)).not.toContain('Of course');
  });
}, 60_000);

test('a cycle with a fresh hand edit ends its lint phase at warn with one pending issue instead of failing', async () => {
  await fixture(async (engine, sourceId, root) => {
    await seed(engine, sourceId);
    const file = join(root, `${JANE}.md`);
    writeFileSync(file, `${readFileSync(file, 'utf8')}\nFresh hand edit.\n`);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const phase = await runPhaseLint(root, false, engine, undefined, sourceId);
    expect(phase.status).toBe('warn');
    expect(phase.error).toBeUndefined();
    expect(phase.details).toMatchObject({ fixed: 0, fix_pending: 1, lint_fix: true, write_path: 'coordinator' });
    expect((phase.details.pending as LintIssue[]).map(i => [i.code, i.reason])).toEqual([['managed_write_pending', 'file_database_drift']]);
  });
}, 60_000);

test('cycle.lint_fix=false makes the cycle lint phase report-only; true (the default) repairs', async () => {
  await fixture(async (engine, sourceId, root) => {
    await seed(engine, sourceId);
    const file = join(root, `${JANE}.md`);
    const bytes = readFileSync(file, 'utf8');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    const before = await requests(engine, sourceId);
    try {
      await engine.setConfig('cycle.lint_fix', 'false');
      const off = await runPhaseLint(root, false, engine, undefined, sourceId);
      expect(off.status).toBe('warn');
      expect(off.summary).toContain('cycle.lint_fix=false');
      expect(off.details).toMatchObject({ issues: FIXABLE_ON_INDEXED_PAGE, fixed: 0, lint_fix: false, write_path: 'none', fix_pending: 0 });
      expect(readFileSync(file, 'utf8')).toBe(bytes);
      expect(await requests(engine, sourceId)).toBe(before);

      await engine.setConfig('cycle.lint_fix', 'true');
      const on = await runPhaseLint(root, false, engine, undefined, sourceId);
      expect(on.status).toBe('ok');
      expect(on.details).toMatchObject({ fixed: FIXABLE_ON_INDEXED_PAGE, lint_fix: true, write_path: 'coordinator' });
      expect(readFileSync(file, 'utf8')).not.toContain('Of course');
    } finally {
      await engine.unsetConfig('cycle.lint_fix');
    }
  });
}, 60_000);
