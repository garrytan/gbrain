/**
 * #7897: `gbrain repair url-clone-fences` (src/core/repair/url-clone-fences.ts) restored a gbrain-owned clone file by
 * importing HEAD's bytes through `importFromContent` without the private-request hold and ignored the result. A HEAD
 * that asks for `visibility: private` in a spelling page privacy does not read (sync holds it `visibility_noncanonical`)
 * was imported world-readable on an unmanaged brain and reported `restored`.
 *
 * Protects: the preview lists such a file under the hold's code, and apply (from that preview, or from an approval saved
 * before this release that listed it `fence_rows_only`) reports `held` with the code: the row is kept database-only and
 * the file is restored from HEAD, so the clone pulls the upstream fix, but HEAD is not imported and the page stays as it
 * was. HEAD with `visibility: private` still restores a private page, and a HEAD that
 * asks for nothing private still restores. The brain has no repository of its own (no `sync.repo_path`); the repair
 * applies only to a source that is an owned Git clone, so there is no clone-less arm.
 *
 * PGLite here; Postgres through test/e2e/url-clone-fences-private-hold-7897-postgres.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { writeSingleFact } from '../src/core/facts/write-single.ts';
import { resolveRepairScope, type RepairKind, type RepairResult } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { saveApprovedSet, type ApprovedSetKey } from '../src/core/persistence/preview-approval.ts';
import { isPrivatePage } from '../src/core/search/private-visibility.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const SOURCE = 'source-a';
const ALICE = 'people/alice-example';
const FILE = `${ALICE}.md`;
const KIND = 'url-clone-fences' as RepairKind;
const person = (extra: string) => `---\ntype: person\ntitle: Alice Example\n${extra}---\n\n# Alice Example\n\nAlice Example works at Acme Example.\n`;
const git = (dir: string, args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

interface Clone { engine: BrainEngine; root: string; upstream: string; file: () => string; head: () => string; page: () => Promise<{ frontmatter: Record<string, unknown>; compiled_truth: string } | null>;
  rows: () => Promise<Array<number | null>> }

/**
 * An owned clone whose first sync imported a world page; HEAD then moves to `extra` frontmatter (an upstream commit the clone pulled) and an
 * older gbrain's fence writer appends one row to the working copy, so the file differs from HEAD by fence rows only.
 */
async function withClone(databaseUrl: string | undefined, extra: string, run: (c: Clone) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-7897-clone-'));
  try {
    await withEnv({ GBRAIN_HOME: join(dir, 'home'), GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1', DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      _resetWriteThroughCacheForTest();
      const upstream = join(dir, 'upstream');
      mkdirSync(join(upstream, 'people'), { recursive: true });
      git(upstream, ['init', '-q', '-b', 'main']);
      git(upstream, ['config', 'user.email', 'test@example.com']);
      git(upstream, ['config', 'user.name', 'Test Example']);
      writeFileSync(join(upstream, FILE), person(''));
      git(upstream, ['add', '-A']);
      git(upstream, ['commit', '-q', '-m', 'initial']);
      const root = join(dir, 'clones', SOURCE);
      execFileSync('git', ['clone', '-q', `file://${upstream}`, root], { stdio: 'pipe' });
      git(root, ['config', 'user.email', 'test@example.com']);
      git(root, ['config', 'user.name', 'Test Example']);
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      const config = { remote_url: `file://${upstream}`, managed_clone: true };
      try {
        await engine.executeRaw('INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, $3::text::jsonb)', [SOURCE, root, JSON.stringify(config)]);
        const { performSync } = await import('../src/commands/sync.ts');
        expect((await performSync(engine, { sourceId: SOURCE, repoPath: root, noEmbed: true, noExtract: true })).status).toBe('first_sync');
        writeFileSync(join(upstream, FILE), person(extra));
        git(upstream, ['commit', '-q', '-am', 'head moves']);
        git(root, ['pull', '-q', '--ff-only']);
        await engine.executeRaw('UPDATE sources SET config = $1::text::jsonb WHERE id = $2', [JSON.stringify({ remote_url: config.remote_url }), SOURCE]);
        await writeSingleFact(engine, SOURCE, { fact: 'Alice Example leads the platform team at Acme Example.', provenance: 'test:7897', entity: ALICE, visibility: 'world', remote: false });
        await engine.executeRaw('UPDATE sources SET config = $1::text::jsonb WHERE id = $2', [JSON.stringify(config), SOURCE]);
        const c: Clone = {
          engine, root, upstream,
          file: () => readFileSync(join(root, FILE), 'utf8'),
          head: () => git(root, ['show', `HEAD:${FILE}`]),
          page: async () => (await engine.getPage(ALICE, { sourceId: SOURCE })) as never,
          rows: async () => (await engine.executeRaw<{ row_num: number | null }>('SELECT row_num FROM facts WHERE source_id = $1 AND entity_slug = $2 ORDER BY id', [SOURCE, ALICE]))
            .map(r => r.row_num === null ? null : Number(r.row_num)),
        };
        expect(parseFactsFence(c.file()).facts.length).toBe(1);
        await run(c);
      } finally { await close(); }
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const repair = async (engine: BrainEngine, opts: { apply: boolean; expect?: string }): Promise<RepairResult> =>
  (await repairRunner(engine, { apply: opts.apply, logger: { info() {}, warn() {}, error() {} } as never }))
    .run(KIND, await resolveRepairScope(engine, SOURCE), { explicit: true, sourceFlag: SOURCE, ...(opts.expect ? { expect: opts.expect } : {}) });

/** The approved set a preview from before this release saved for the file (it listed it `fence_rows_only`). */
async function savedApproval(c: Clone): Promise<string> {
  const [source] = await c.engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id = $1', [SOURCE]);
  const [page] = await c.engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id = $1 AND slug = $2', [SOURCE, ALICE]);
  const hash = 'a'.repeat(64);
  await saveApprovedSet(c.engine, { command: 'url-clone-fences' as ApprovedSetKey['command'], hash }, [{ source_id: SOURCE, incarnation: source!.incarnation,
    root: realpathSync(c.root), path: FILE, slug: ALICE, page_id: Number(page!.id), head_sha256: sha256(c.head()), work_sha256: sha256(c.file()),
    rows: parseFactsFence(c.file()).facts.map(f => f.rowNum), selection: [SOURCE] }]);
  return hash;
}

const arms = testBackends().map(backend => ({ backend, databaseUrl: backend === 'pglite' ? undefined : requirePostgresTestDatabase() }));
for (const { backend, databaseUrl } of arms) describe(`[${backend}] repair url-clone-fences (#7897)`, () => {
  /** The held file is restored and HEAD is not imported: the page is unchanged and world-readable, the row is database-only, and the clone pulls the upstream fix. */
  const expectHeldRestore = async (c: Clone, page: Awaited<ReturnType<Clone['page']>>, applied: RepairResult) => {
    expect({ applied: applied.applied, outcomes: applied.outcomes, item: applied.outcome_items?.[0] })
      .toEqual({ applied: 1, outcomes: { held: 1 }, item: expect.objectContaining({ outcome: 'held', reason: 'visibility_noncanonical' }) });
    expect({ file: c.file() === c.head(), page: await c.page(), rows: await c.rows() }).toEqual({ file: true, page, rows: [null] });
    expect(Object.keys((await c.page())!.frontmatter).map(k => k.toLowerCase())).not.toContain('visibility');
    writeFileSync(join(c.upstream, FILE), person('visibility: private\n'));
    git(c.upstream, ['commit', '-q', '-am', 'upstream fixes the spelling']);
    expect(() => git(c.root, ['pull', '-q', '--ff-only'])).not.toThrow();
  };

  test('a HEAD asking for Visibility: private previews under visibility_noncanonical; apply restores the file without importing HEAD, so the clone pulls again', async () => {
    await withClone(databaseUrl, 'Visibility: private\n', async c => {
      const page = await c.page();
      const preview = await repair(c.engine, { apply: false });
      expect(preview.listing).toEqual([{ item: `${SOURCE}:${FILE}`, class: 'visibility_noncanonical', detail: expect.stringContaining('restored from HEAD so the clone can pull again') }]);
      await expectHeldRestore(c, page, await repair(c.engine, { apply: true, expect: preview.preview_hash }));
    });
  }, 180_000);

  test('an approval saved before the fix applies as held: the file is restored and its row kept database-only, HEAD is not imported', async () => {
    await withClone(databaseUrl, 'visibility: Private\n', async c => {
      const page = await c.page();
      await expectHeldRestore(c, page, await repair(c.engine, { apply: true, expect: await savedApproval(c) }));
    });
  }, 180_000);

  for (const [name, extra, isPrivate] of [['visibility: private', 'visibility: private\n', true], ['no private request', 'tags: [example]\n', false]] as const) {
    test(`a HEAD with ${name} still restores, and the page is ${isPrivate ? 'private' : 'world-readable'}`, async () => {
      await withClone(databaseUrl, extra, async c => {
        const preview = await repair(c.engine, { apply: false });
        expect(preview.listing!.map(l => l.class)).toEqual(['fence_rows_only']);
        const applied = await repair(c.engine, { apply: true, expect: preview.preview_hash });
        expect({ applied: applied.applied, outcomes: applied.outcomes }).toEqual({ applied: 1, outcomes: { restored: 1 } });
        expect({ file: c.file() === c.head(), rows: await c.rows(), private: isPrivatePage((await c.page())!) }).toEqual({ file: true, rows: [null], private: isPrivate });
      });
    }, 180_000);
  }
});
