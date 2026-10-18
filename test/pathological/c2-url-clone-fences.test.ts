/**
 * C-2 (GBRA-130, #6946): gbrain never writes into a `gbrain sources add --url`
 * clone it pulls with `git pull --ff-only`, and a clone an older release
 * dirtied has an exit.
 *
 * Protects: on an unmanaged brain, a fact about a page of a gbrain-owned clone
 * stays database-only (recallable, `row_num` NULL) instead of landing in a
 * `## Facts` fence in the clone, and a page write-through skips the clone, so
 * the next upstream change to that file still fast-forwards. A clone an older
 * release already dirtied makes sync print the typed refusal
 * `pull_blocked_local_changes` (ask_user, naming the preview-first repair), and
 * `gbrain repair url-clone-fences` proves per file that the diff against HEAD
 * is only appended fence rows, backs the file up, moves those rows
 * database-only (the database side commits first), restores the file from
 * HEAD and leaves a file with any other edit untouched and named. A run-scoped
 * failure in the database step stops the repair before any file is restored.
 * Fails when: the fence writer or write-through writes into an owned clone,
 * the pull failure stays an untyped "Fix the pull", or the repair restores a
 * file whose diff it did not prove, restores before the database side
 * commits, or loses a fact row.
 * Seams: `sources add --url` accepts https:// only, so the clone is a plain
 * `git clone` of a local upstream registered with the row `addSource` writes
 * (`managed_clone: true`, `remote_url` = the clone's origin) and pulled under
 * GBRAIN_GIT_ALLOW_FILE_TRANSPORT=1. The pre-fix dirty state comes from the
 * real fence writer while the row's ownership marker is lifted, then restored.
 * Run-scoped errors come from an engine wrapper. PGLite always, Postgres when
 * DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { gbrainPath, type GBrainConfig } from '../../src/core/config.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { writeSingleFact } from '../../src/core/facts/write-single.ts';
import { FACTS_FENCE_BEGIN } from '../../src/core/facts-fence.ts';
import { writePageThrough, _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { resolveRepairScope, type RepairKind, type RepairResult } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { expectItemFailure, expectOthersUnchanged, expectUnitNotAborted, pathologicalArms, runScopedErrors, snapshotItems } from './harness.ts';

const SOURCE = 'acme-docs';
const ALICE = 'people/alice-example';
const BOB = 'people/bob-example';
const NOTE = 'notes/acme-example';
const KIND = 'url-clone-fences' as RepairKind;
const ALICE_FACT = 'Alice Example leads the platform team at Acme Example.';
const BOB_FACT = 'Bob Example runs the Acme Example design studio.';

const personMd = (title: string, body: string) => `---\ntype: person\ntitle: ${title}\n---\n\n# ${title}\n\n${body}\n`;
const git = (dir: string, args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

type SyncResult = Awaited<ReturnType<typeof import('../../src/commands/sync.ts').performSync>>;
interface FactRow { id: number; row_num: number | null; expired: boolean; fact: string }
interface Clone {
  engine: BrainEngine;
  root: string;
  /** `git status` of tracked files in the clone ('' when clean). */
  dirty(): string;
  /** Commit a change to `rel` upstream. */
  push(rel: string, content: string): void;
  /** Sync the clone source (pull enabled), with stderr captured. */
  sync(): Promise<{ result: SyncResult; stderr: string }>;
  /** A fact about `slug` written by the real fence writer as an older release did (ownership marker lifted for the write). */
  legacyFence(slug: string, fact: string): Promise<number>;
  facts(slug: string): Promise<FactRow[]>;
}

async function withClone(databaseUrl: string | undefined, run: (c: Clone) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-c2-'));
  try {
    await withEnv({ GBRAIN_HOME: join(dir, 'home'), GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1', DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      _resetWriteThroughCacheForTest();
      const upstream = join(dir, 'upstream');
      mkdirSync(join(upstream, 'people'), { recursive: true });
      mkdirSync(join(upstream, 'notes'), { recursive: true });
      git(upstream, ['init', '-q', '-b', 'main']);
      git(upstream, ['config', 'user.email', 't@t.co']);
      git(upstream, ['config', 'user.name', 't']);
      writeFileSync(join(upstream, `${ALICE}.md`), personMd('Alice Example', 'Alice Example works at Acme Example.'));
      writeFileSync(join(upstream, `${BOB}.md`), personMd('Bob Example', 'Bob Example works at Acme Example.'));
      writeFileSync(join(upstream, `${NOTE}.md`), '---\ntype: note\ntitle: Acme Example\n---\n\n# Acme Example\n\nA company note.\n');
      git(upstream, ['add', '-A']);
      git(upstream, ['commit', '-q', '-m', 'initial']);
      const root = join(dir, 'clones', SOURCE);
      execFileSync('git', ['clone', '-q', `file://${upstream}`, root], { stdio: 'pipe' });
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      const config = { remote_url: `file://${upstream}`, managed_clone: true };
      const setConfig = (value: Record<string, unknown>) => engine.executeRaw('UPDATE sources SET config = $1::text::jsonb WHERE id = $2', [JSON.stringify(value), SOURCE]);
      try {
        await engine.executeRaw('INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, $3::text::jsonb)', [SOURCE, root, JSON.stringify(config)]);
        const c: Clone = {
          engine, root,
          dirty: () => git(root, ['status', '--porcelain', '--untracked-files=no']).trim(),
          push(rel, content) { writeFileSync(join(upstream, rel), content); git(upstream, ['commit', '-q', '-am', `edit ${rel}`]); },
          async sync() {
            const { performSync } = await import('../../src/commands/sync.ts');
            const lines: string[] = [];
            const origError = console.error;
            const origWrite = process.stderr.write.bind(process.stderr);
            console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
            (process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = (chunk: unknown) => { lines.push(String(chunk)); return true; };
            try {
              return { result: await performSync(engine, { sourceId: SOURCE, repoPath: root, noEmbed: true, noExtract: true }), stderr: lines.join('\n') };
            } finally {
              console.error = origError;
              process.stderr.write = origWrite;
            }
          },
          async legacyFence(slug, fact) {
            await setConfig({ remote_url: config.remote_url });
            try {
              return (await writeSingleFact(engine, SOURCE, { fact, provenance: 'test:c2', entity: slug, visibility: 'world', remote: false })).id;
            } finally { await setConfig(config); }
          },
          async facts(slug) {
            const rows = await engine.executeRaw<FactRow>(
              'SELECT id, row_num, expired_at IS NOT NULL AS expired, fact FROM facts WHERE source_id = $1 AND entity_slug = $2 ORDER BY id', [SOURCE, slug]);
            return rows.map(r => ({ id: Number(r.id), row_num: r.row_num === null ? null : Number(r.row_num), expired: r.expired, fact: r.fact }));
          },
        };
        expect((await c.sync()).result.status).toBe('first_sync');
        await run(c);
      } finally { await close(); }
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const repair = async (engine: BrainEngine, opts: { apply: boolean; expect?: string; source?: string }): Promise<RepairResult> => {
  const source = opts.source ?? SOURCE;
  const scope = await resolveRepairScope(engine, source);
  return (await repairRunner(engine, { apply: opts.apply, logger: { info() {}, warn() {}, error() {} } as never }))
    .run(KIND, scope, { explicit: true, sourceFlag: source, ...(opts.expect ? { expect: opts.expect } : {}) });
};
/** A stale approval's apply: the run's restored count and outcomes, or the refusal code it threw. */
const staleApply = (engine: BrainEngine, expectHash: string | undefined, source?: string) =>
  repair(engine, { apply: true, expect: expectHash, source }).then(
    result => ({ applied: result.applied, outcomes: result.outcomes as Record<string, number> | undefined, code: null as string | null }),
    (error: { code?: string }) => ({ applied: 0, outcomes: undefined as Record<string, number> | undefined, code: error.code ?? String(error) }));
const head = (c: Clone, rel: string) => git(c.root, ['show', `HEAD:${rel}`]);
const pageBody = async (engine: BrainEngine, slug: string) =>
  (await engine.executeRaw<{ compiled_truth: string }>('SELECT compiled_truth FROM pages WHERE source_id = $1 AND slug = $2', [SOURCE, slug]))[0]?.compiled_truth ?? '';

/** The engine whose `transaction` throws `error` once `armed()` is true. */
function failingTransactions(engine: BrainEngine, error: () => unknown, armed: () => boolean): BrainEngine {
  return new Proxy(engine, {
    get(target, prop) {
      if (prop === 'transaction') return (...args: unknown[]) => armed() ? Promise.reject(error()) : (target.transaction as (...a: unknown[]) => unknown)(...args);
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`C-2 gbrain-owned --url clones (${backend})`, () => {
    test('C-2 guard: a fact about a clone page stays database-only and recallable, write-through skips the clone, and the next upstream change pulls', async () => {
      await withClone(databaseUrl, async c => {
        const before = await snapshotItems(c.engine, SOURCE);
        const written = await expectUnitNotAborted(() => writeSingleFact(c.engine, SOURCE, { fact: ALICE_FACT, provenance: 'test:c2', entity: ALICE, visibility: 'world', remote: false }));
        expect({ dirty: c.dirty() }).toEqual({ dirty: '' });
        expect(await c.facts(ALICE)).toEqual([{ id: written.id, row_num: null, expired: false, fact: ALICE_FACT }]);
        const through = await writePageThrough(c.engine, NOTE, { sourceId: SOURCE });
        expect({ written: through.written, skipped: through.skipped }).toEqual({ written: false, skipped: 'url_clone' });
        expect({ dirty: c.dirty() }).toEqual({ dirty: '' });
        c.push(`${ALICE}.md`, personMd('Alice Example', 'Alice Example works at Acme Example. UPSTREAM-EDIT-1.'));
        const synced = await c.sync();
        expect({ status: synced.result.status, reason: synced.result.reason }).toEqual({ status: 'synced', reason: undefined });
        expect(await pageBody(c.engine, ALICE)).toContain('UPSTREAM-EDIT-1');
        expect((await c.facts(ALICE)).map(f => [f.id, f.row_num, f.expired])).toEqual([[written.id, null, false]]);
        expectOthersUnchanged(before, await snapshotItems(c.engine, SOURCE), { expectProgress: [ALICE] });
        const putPage = operations.find(o => o.name === 'put_page')!;
        const ctx = { engine: c.engine, config: {} as GBrainConfig, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: SOURCE } as unknown as OperationContext;
        const put = await putPage.handler(ctx, { slug: 'notes/agent-example', content: '---\ntype: note\ntitle: Agent Example\n---\n\n# Agent Example\n\nAGENT-EDIT.\n' })
          .then(() => 'database_only', (e: { code?: string }) => e.code);
        expect({ status: git(c.root, ['status', '--porcelain']).trim(), put })
          .toEqual({ status: '', put: backend === 'pglite' ? 'database_only' : 'owner_unavailable' });
        if (put === 'database_only') expect(await pageBody(c.engine, 'notes/agent-example')).toContain('AGENT-EDIT');
      });
    }, 180_000);

    test('C-2 refusal: a clone an older release dirtied makes sync name pull_blocked_local_changes and the preview-first repair', async () => {
      await withClone(databaseUrl, async c => {
        await c.legacyFence(ALICE, ALICE_FACT);
        expect(c.dirty()).toBe(`M ${ALICE}.md`);
        c.push(`${ALICE}.md`, personMd('Alice Example', 'Alice Example works at Acme Example. UPSTREAM-EDIT-2.'));
        const blocked = await c.sync();
        expect({ status: blocked.result.status, reason: blocked.result.reason }).toEqual({ status: 'partial', reason: 'pull_failed' });
        expect({ code: blocked.stderr.includes('pull_blocked_local_changes'), fix: blocked.stderr.includes(`gbrain repair url-clone-fences --source ${SOURCE}`) })
          .toEqual({ code: true, fix: true });
        const { urlClonePullBlock } = await import('../../src/core/url-clone.ts');
        const block = await urlClonePullBlock(c.engine, SOURCE);
        expect(block).toMatchObject({ code: 'pull_blocked_local_changes', source_id: SOURCE, paths: [`${ALICE}.md`] });
        expect({ ask_user: block!.fix.ask_user, preview: block!.fix.preview_argv }).toEqual({ ask_user: true, preview: ['gbrain', 'repair', 'url-clone-fences', '--source', SOURCE] });
        const again = await c.sync();
        expect({ status: again.result.status, reason: again.result.reason }).toEqual({ status: 'partial', reason: 'pull_failed' });
      });
    }, 180_000);

    test('C-2 repair: the preview proves fence-only diffs and refuses a file with a user edit; the apply moves rows database-only, restores from HEAD, and sync pulls again', async () => {
      await withClone(databaseUrl, async c => {
        const aliceFact = await c.legacyFence(ALICE, ALICE_FACT);
        const bobFact = await c.legacyFence(BOB, BOB_FACT);
        const bobFile = join(c.root, `${BOB}.md`);
        writeFileSync(bobFile, readFileSync(bobFile, 'utf8').replace('works at Acme Example.', 'works at Acme Example. A LOCAL USER EDIT.'));
        const bobBytes = readFileSync(bobFile, 'utf8');
        const [aliceRow] = await c.facts(ALICE);
        expect(aliceRow!.row_num).not.toBeNull();
        c.push(`${ALICE}.md`, personMd('Alice Example', 'Alice Example works at Acme Example. UPSTREAM-EDIT-3.'));
        expect((await c.sync()).result.reason).toBe('pull_failed');
        const before = await snapshotItems(c.engine, SOURCE);

        const preview = await expectUnitNotAborted(() => repair(c.engine, { apply: false }));
        expect(preview.listing).toEqual([
          { item: `${SOURCE}:${ALICE}.md`, class: 'fence_rows_only', detail: expect.stringContaining('1 fence row') },
          { item: `${SOURCE}:${BOB}.md`, class: 'non_fence_edit', detail: expect.stringContaining(`gbrain repair ${KIND} --source ${SOURCE}`) },
        ]);
        expectItemFailure({ key: preview.listing![1]!.item, code: preview.listing![1]!.class, fix: preview.listing![1]!.detail },
          { key: `${SOURCE}:${BOB}.md`, code: 'non_fence_edit', fix: /gbrain repair url-clone-fences --source acme-docs/ });
        expect(preview.apply_command).toContain(`--expect ${preview.preview_hash}`);
        expect(preview.apply_command).toContain('--yes');
        expect({ dirty: c.dirty(), alice: (await c.facts(ALICE))[0]!.row_num }).toEqual({ dirty: `M ${ALICE}.md\n M ${BOB}.md`, alice: aliceRow!.row_num });

        const applied = await expectUnitNotAborted(() => repair(c.engine, { apply: true, expect: preview.preview_hash }));
        expect({ applied: applied.applied, failed: applied.failed, outcomes: applied.outcomes }).toEqual({ applied: 1, failed: [], outcomes: { restored: 1 } });
        const backup = applied.outcome_items![0]!.detail!.backup as string;
        expect(readFileSync(backup, 'utf8')).toContain(FACTS_FENCE_BEGIN);
        expect(readFileSync(join(c.root, `${ALICE}.md`), 'utf8')).toBe(head(c, `${ALICE}.md`));
        expect(c.dirty()).toBe(`M ${BOB}.md`);
        expect(readFileSync(bobFile, 'utf8')).toBe(bobBytes);
        expect(await c.facts(ALICE)).toEqual([{ id: aliceFact, row_num: null, expired: false, fact: ALICE_FACT }]);
        expect((await c.facts(BOB)).map(f => [f.id, f.row_num !== null, f.expired])).toEqual([[bobFact, true, false]]);
        expect(await pageBody(c.engine, ALICE)).not.toContain(FACTS_FENCE_BEGIN);
        expectOthersUnchanged(before, await snapshotItems(c.engine, SOURCE), { changed: [ALICE] });

        const synced = await c.sync();
        expect({ status: synced.result.status, reason: synced.result.reason }).toEqual({ status: 'synced', reason: undefined });
        expect(await pageBody(c.engine, ALICE)).toContain('UPSTREAM-EDIT-3');
        expect((await c.facts(ALICE)).map(f => [f.id, f.row_num, f.expired])).toEqual([[aliceFact, null, false]]);
      });
    }, 240_000);

    test('C-2 recovery: once the user edit is gone the file previews fence-only and clears; a file that moved since the preview is not restored', async () => {
      await withClone(databaseUrl, async c => {
        await c.legacyFence(BOB, BOB_FACT);
        const bobFile = join(c.root, `${BOB}.md`);
        const fenced = readFileSync(bobFile, 'utf8');
        writeFileSync(bobFile, fenced.replace('works at Acme Example.', 'works at Acme Example. A LOCAL USER EDIT.'));
        expect((await repair(c.engine, { apply: false })).listing!.map(l => l.class)).toEqual(['non_fence_edit']);
        writeFileSync(bobFile, fenced);
        const preview = await repair(c.engine, { apply: false });
        expect(preview.listing!.map(l => l.class)).toEqual(['fence_rows_only']);
        writeFileSync(bobFile, `${fenced}\nMOVED AFTER THE PREVIEW\n`);
        const moved = await expectUnitNotAborted(() => repair(c.engine, { apply: true, expect: preview.preview_hash }));
        expect({ applied: moved.applied, outcomes: moved.outcomes }).toEqual({ applied: 0, outcomes: { changed_since_preview: 1 } });
        expect(readFileSync(bobFile, 'utf8')).toBe(`${fenced}\nMOVED AFTER THE PREVIEW\n`);
        expect((await c.facts(BOB)).every(f => f.row_num !== null)).toBe(true);
        writeFileSync(bobFile, fenced);
        const fresh = await repair(c.engine, { apply: false });
        const cleared = await expectUnitNotAborted(() => repair(c.engine, { apply: true, expect: fresh.preview_hash }));
        expect(cleared.outcomes).toEqual({ restored: 1 });
        expect({ dirty: c.dirty(), rows: (await c.facts(BOB)).map(f => [f.row_num, f.expired]) }).toEqual({ dirty: '', rows: [[null, false]] });
      });
    }, 240_000);

    test('C-2 binding: an approval for clone A applied after the source moved to clone B (sources set-path) refuses preview_changed and changes nothing', async () => {
      await withClone(databaseUrl, async c => {
        await c.legacyFence(ALICE, ALICE_FACT);
        const aliceFile = join(c.root, `${ALICE}.md`);
        const dirtyBytes = readFileSync(aliceFile, 'utf8');
        const preview = await repair(c.engine, { apply: false });
        expect(preview.listing!.map(l => l.class)).toEqual(['fence_rows_only']);
        c.push(`${ALICE}.md`, personMd('Alice Example', 'Alice Example works at Acme Example. CLONE-B-HEAD.'));
        const cloneB = join(c.root, '..', `${SOURCE}-b`);
        execFileSync('git', ['clone', '-q', git(c.root, ['remote', 'get-url', 'origin']).trim(), cloneB], { stdio: 'pipe' });
        const { runSetPath } = await import('../../src/commands/sources-set-path.ts');
        await runSetPath(c.engine, [SOURCE, cloneB]);
        expect((await c.engine.executeRaw<{ local_path: string }>('SELECT local_path FROM sources WHERE id = $1', [SOURCE]))[0]!.local_path).toBe(cloneB);
        const rows = await c.facts(ALICE);
        const before = await snapshotItems(c.engine, SOURCE);
        expect(await staleApply(c.engine, preview.preview_hash)).toEqual({ applied: 0, outcomes: undefined, code: 'preview_changed' });
        expect({ file: readFileSync(aliceFile, 'utf8') === dirtyBytes, dirty: c.dirty(), facts: await c.facts(ALICE) })
          .toEqual({ file: true, dirty: `M ${ALICE}.md`, facts: rows });
        expect(await pageBody(c.engine, ALICE)).not.toContain('CLONE-B-HEAD');
        expectOthersUnchanged(before, await snapshotItems(c.engine, SOURCE));
      });
    }, 180_000);

    test('C-2 binding: an approval applied after the source was replaced under the same id (new incarnation) refuses preview_changed and changes nothing', async () => {
      await withClone(databaseUrl, async c => {
        await c.legacyFence(ALICE, ALICE_FACT);
        const aliceFile = join(c.root, `${ALICE}.md`);
        const dirtyBytes = readFileSync(aliceFile, 'utf8');
        const preview = await repair(c.engine, { apply: false });
        expect(preview.listing!.map(l => l.class)).toEqual(['fence_rows_only']);
        const [row] = await c.engine.executeRaw<{ incarnation: string; config: unknown }>('SELECT incarnation::text AS incarnation, config FROM sources WHERE id = $1', [SOURCE]);
        await c.engine.executeRaw('DELETE FROM sources WHERE id = $1', [SOURCE]);
        await c.engine.executeRaw('INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, $3::text::jsonb)',
          [SOURCE, c.root, typeof row!.config === 'string' ? row!.config : JSON.stringify(row!.config)]);
        const [replaced] = await c.engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id = $1', [SOURCE]);
        expect(replaced!.incarnation).not.toBe(row!.incarnation);
        const before = await snapshotItems(c.engine, SOURCE);
        expect(await staleApply(c.engine, preview.preview_hash)).toEqual({ applied: 0, outcomes: undefined, code: 'preview_changed' });
        expect({ file: readFileSync(aliceFile, 'utf8') === dirtyBytes, dirty: c.dirty(), facts: await c.facts(ALICE), page: await pageBody(c.engine, ALICE) })
          .toEqual({ file: true, dirty: `M ${ALICE}.md`, facts: [], page: '' });
        expectOthersUnchanged(before, await snapshotItems(c.engine, SOURCE));
      });
    }, 180_000);

    test('C-2 binding: a saved approval applied with a different --source refuses preview_changed and changes nothing', async () => {
      await withClone(databaseUrl, async c => {
        await c.legacyFence(ALICE, ALICE_FACT);
        const aliceFile = join(c.root, `${ALICE}.md`);
        const dirtyBytes = readFileSync(aliceFile, 'utf8');
        await c.engine.executeRaw("INSERT INTO sources (id, name, config) VALUES ('other-example', 'other-example', '{}'::jsonb)");
        const preview = await repair(c.engine, { apply: false });
        expect(preview.listing!.map(l => l.class)).toEqual(['fence_rows_only']);
        const rows = await c.facts(ALICE);
        const before = await snapshotItems(c.engine, SOURCE);
        expect(await staleApply(c.engine, preview.preview_hash, 'other-example')).toEqual({ applied: 0, outcomes: undefined, code: 'preview_changed' });
        expect({ file: readFileSync(aliceFile, 'utf8') === dirtyBytes, dirty: c.dirty(), facts: await c.facts(ALICE) })
          .toEqual({ file: true, dirty: `M ${ALICE}.md`, facts: rows });
        expectOthersUnchanged(before, await snapshotItems(c.engine, SOURCE));
      });
    }, 180_000);

    test('C-2 binding: a fence-only change staged after the preview refuses preview_changed and leaves the index, file and rows as they were', async () => {
      await withClone(databaseUrl, async c => {
        await c.legacyFence(ALICE, ALICE_FACT);
        const aliceFile = join(c.root, `${ALICE}.md`);
        const dirtyBytes = readFileSync(aliceFile, 'utf8');
        const preview = await repair(c.engine, { apply: false });
        expect(preview.listing!.map(l => l.class)).toEqual(['fence_rows_only']);
        git(c.root, ['add', '--', `${ALICE}.md`]);
        expect(c.dirty()).toBe(`M  ${ALICE}.md`);
        const rows = await c.facts(ALICE);
        const before = await snapshotItems(c.engine, SOURCE);
        expect(await staleApply(c.engine, preview.preview_hash)).toEqual({ applied: 0, outcomes: { preview_changed: 1 }, code: null });
        expect({ file: readFileSync(aliceFile, 'utf8') === dirtyBytes, dirty: c.dirty(), facts: await c.facts(ALICE) })
          .toEqual({ file: true, dirty: `M  ${ALICE}.md`, facts: rows });
        expectOthersUnchanged(before, await snapshotItems(c.engine, SOURCE));
      });
    }, 180_000);

    for (const { name, error } of runScopedErrors()) {
      test(`C-2 run: a run-scoped failure (${name}) in the database step stops the repair and restores nothing`, async () => {
        await withClone(databaseUrl, async c => {
          await c.legacyFence(ALICE, ALICE_FACT);
          const aliceFile = join(c.root, `${ALICE}.md`);
          const dirtyBytes = readFileSync(aliceFile, 'utf8');
          const rows = await c.facts(ALICE);
          const preview = await repair(c.engine, { apply: false });
          const before = await snapshotItems(c.engine, SOURCE);
          const failing = failingTransactions(c.engine, error, () => existsSync(gbrainPath('backups', 'url-clone-fences')));
          const run = await repair(failing, { apply: true, expect: preview.preview_hash })
            .then(result => ({ stopped: result.stopped?.reason ?? null, applied: result.applied }), (e: unknown) => ({ stopped: e instanceof Error ? 'thrown' : String(e), applied: 0 }));
          expect({ stopped: run.stopped !== null, applied: run.applied }).toEqual({ stopped: true, applied: 0 });
          expect(readFileSync(aliceFile, 'utf8')).toBe(dirtyBytes);
          expect(await c.facts(ALICE)).toEqual(rows);
          expectOthersUnchanged(before, await snapshotItems(c.engine, SOURCE));
        });
      }, 180_000);
    }
  });
}
