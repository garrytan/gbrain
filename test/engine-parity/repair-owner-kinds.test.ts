/**
 * BrainEngine parity — `gbrain repair ghost-pages`, `legacy-twins` and `rows-behind` on a brain with no owner binding
 * (batch 3 of the repair-on-Rust plan).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a brain whose default source has file-backed pages and no worktree binding, the preview and the apply
 *    of each kind give the same result or the same refusal code on PGLite, Postgres (DATABASE_URL) and the Rust engine
 *    (GBRAIN_TEST_RUST_ARM=1): ghost-pages and legacy-twins refuse `not_owner_host`, and rows-behind previews no rows
 *    and refuses an apply no preview printed.
 *  - Regression: each kind reads the source's owner binding first; before batch 3, a Rust brain stopped earlier at a
 *    raw page or source read, so the three arms disagreed on the refusal.
 *  - Why existing coverage misses it: test/repair-legacy-twins-6885.test.ts, test/ghost-pages-*.test.ts and the
 *    rows-behind tests run on PGLite or Postgres only.
 *  - Owner path: on a brain this host owns (a registered writer and a claimed worktree binding, which every engine now
 *    serves), ghost-pages previews the page whose file is gone and its apply soft-deletes exactly that page, and
 *    legacy-twins previews the twin pair, on every arm; its apply merges the pair on every arm (the twin's sync import
 *    record moves to the legacy page and the twin's op_checkpoints row is deleted through writeOpCheckpointRecord on the
 *    merge transaction). Before batch 8 a Rust brain stopped at the raw import-record read (ghost-pages) and the raw
 *    twin-merge conflict read (legacy-twins); until batch 6c its merge stopped by name ("repair twin merge").
 *  - segmented-mirror on an owned brain: the preview walks the source's segmented pages (listSegmentedPageSlugs) and
 *    lists none when no page has a withdrawal ledger, and the apply of that empty preview is a no-op, on every arm.
 *    Before this case a Rust brain stopped at the raw segmented-slug read. A page with a withdrawal ledger still
 *    reaches the raw fence overlay of prepareFileTarget, which waits for the managed_persistence capability.
 *  - Seam: none.
 */
import { describe, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { SYNC_IMPORT_PROVENANCE_OP, readSyncImportProvenance } from '../../src/core/persistence/sync-holds.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { resolveRepairScope, type RepairKind, type RepairResult } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { publishSegmentedPage, segmentText } from '../helpers/page-body-fixtures.ts';

const { parityTest } = parityArms(testBackends());

const quiet = { info() {}, warn() {}, error() {} } as never;

function shape(result: RepairResult, root?: string) {
  const { scope, ...rest } = result;
  let text = JSON.stringify({ ...rest, scope: { brain_id: typeof scope.brain_id, source_ids: scope.source_ids } })
    .replace(/\b[0-9a-f]{64}\b/g, '<sha256>');
  if (root) text = text.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>');
  // Postgres sequences keep counting across cases (harness reset), so a page id in a detail is not comparable.
  if (root) text = text.replace(/\(id \d+,/g, '(id <id>,');
  if (root) text = text.split(root).join('<root>');
  return JSON.parse(text);
}

/** A preview, then an apply of what it printed; a refusal is kept as its code and message. */
async function run(engine: BrainEngine, kind: RepairKind, root?: string) {
  const attempt = async (apply: boolean, expect?: string) => {
    try {
      const scope = await resolveRepairScope(engine);
      return shape(await (await repairRunner(engine, { apply, noEmbed: true, logger: quiet })).run(kind, scope, { explicit: true, ...(expect ? { expect } : {}) }), root);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return { refused: e.code ?? 'unknown', message: root ? e.message?.split(root).join('<root>') : e.message };
    }
  };
  const preview = await attempt(false);
  const hash = 'preview_hash' in preview ? preview.preview_hash as string | undefined : undefined;
  return { preview, apply: await attempt(true, hash) };
}

describe('engine parity: repair kinds that need the owner host', () => {
  parityTest('ghost-pages, legacy-twins and rows-behind answer alike on a brain with no owner binding', {
    methods: ['putPage', 'getWorktreeBinding'],
    timeout: 60_000,
  }, async (engine) => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-repair-owner-kinds-home-'));
    try {
      return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        await engine.putPage('notes/a-example', { type: 'note', title: 'a', compiled_truth: 'a body', timeline: '', source_path: 'notes/a-example.md' }, { sourceId: 'default' });
        await engine.putPage('notes/a-example-2', { type: 'note', title: 'a', compiled_truth: 'a body', timeline: '' }, { sourceId: 'default' });
        const out: Record<string, unknown> = {};
        for (const kind of ['ghost-pages', 'legacy-twins', 'rows-behind'] as const) out[kind] = await run(engine, kind);
        out.binding = await engine.getWorktreeBinding('default', null);
        return out;
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  /** A brain this host owns: a registered writer, the default source attached to a Git checkout and claimed. */
  async function ownedBrain<T>(engine: BrainEngine, seed: (root: string) => Promise<void>, body: (root: string) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-repair-owner-path-'));
    const root = join(dir, 'brain');
    mkdirSync(join(root, 'notes'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: root });
    try {
      return await withEnv({ GBRAIN_HOME: join(dir, 'home'), DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        await engine.attachSourcePath('default', root);
        await registerLocalWriter(engine, 'cli');
        await claimWorktree(engine, 'default', root);
        await seed(root);
        execFileSync('git', ['add', '-A'], { cwd: root });
        execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'seed'], { cwd: root });
        return await body(root);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const body = (title: string) => `---\ntype: note\ntitle: ${title}\n---\n\n${title} body.\n`;
  async function put(engine: BrainEngine, root: string, slug: string, sourcePath: string | null, file: boolean, title = slug) {
    if (file && sourcePath) writeFileSync(join(root, sourcePath), body(title));
    await engine.putPage(slug, { type: 'note', title, compiled_truth: `${title} body.`, timeline: '', ...(sourcePath ? { source_path: sourcePath } : {}) }, { sourceId: 'default' });
  }

  parityTest('on a brain this host owns, ghost-pages previews the page whose file is gone and the apply soft-deletes only it', {
    methods: ['putPage', 'attachSourcePath', 'getWorktreeBinding', 'listRepairScanPages', 'readOpCheckpointRecord', 'listPages'],
    timeout: 60_000,
  }, async (engine) => ownedBrain(engine, async (root) => {
    for (let i = 0; i < 12; i++) await put(engine, root, `notes/keep-${i}`, `notes/keep-${i}.md`, true);
    await put(engine, root, 'notes/ghost', 'notes/ghost.md', false);
  }, async (root) => {
    const result = await run(engine, 'ghost-pages', root);
    const live = (await engine.listPages({ sourceId: 'default', limit: 100 })).map(page => page.slug).sort();
    return { ...result, live };
  }));

  async function seedTwins(engine: BrainEngine, root: string) {
    for (let i = 0; i < 12; i++) await put(engine, root, `notes/keep-${i}`, `notes/keep-${i}.md`, true);
    await put(engine, root, 'notes/foo bar', null, false);
    await put(engine, root, 'notes/foo-bar', 'notes/Foo Bar.md', true, 'notes/foo bar');
  }

  parityTest('on a brain this host owns, legacy-twins previews the twin pair of one file', {
    methods: ['putPage', 'attachSourcePath', 'getWorktreeBinding', 'listRepairScanPages', 'listTwinMergeLosers'],
    timeout: 60_000,
  }, async (engine) => ownedBrain(engine, root => seedTwins(engine, root),
    async (root) => ({ preview: (await run(engine, 'legacy-twins', root)).preview })));

  parityTest('on a brain this host owns, legacy-twins merges the twin pair on every engine', {
    methods: ['putPage', 'attachSourcePath', 'getWorktreeBinding', 'listRepairScanPages', 'listTwinMergeLosers', 'listPages',
      'writeOpCheckpointRecord', 'readOpCheckpointRecord'],
    timeout: 60_000,
  }, async (engine) => ownedBrain(engine, root => seedTwins(engine, root), async (root) => {
    // The twin's sync import record: the merge moves it to the legacy page and deletes the twin's checkpoint row
    // (writeOpCheckpointRecord with no keys, on the merge transaction).
    const incarnation = (await engine.getWorktreeBinding('default', null))!.source_incarnation;
    const pageId = async (slug: string) => Number((await engine.getPage(slug, { sourceId: 'default' }))!.id);
    const twinId = await pageId('notes/foo-bar');
    const legacyId = await pageId('notes/foo bar');
    const fingerprint = (id: number) => `default:${incarnation}:${id}`;
    await engine.writeOpCheckpointRecord(SYNC_IMPORT_PROVENANCE_OP, fingerprint(twinId), [{ source_id: 'default', incarnation, page_id: twinId,
      origin: 'notes/Foo Bar.md', raw_sha256: 'a'.repeat(64), gbrain_version: '0.0.0', validated: true, recorded_at: '2026-01-01T00:00:00.000Z' }]);
    const records = async () => ({
      twin: (await readSyncImportProvenance(engine, 'default', incarnation, twinId))?.page_id === twinId,
      legacy: (await readSyncImportProvenance(engine, 'default', incarnation, legacyId))?.page_id === legacyId,
    });
    const scope = await resolveRepairScope(engine);
    const attempt = async (apply: boolean, expect?: string) =>
      (await repairRunner(engine, { apply, noEmbed: true, logger: quiet })).run('legacy-twins', scope, { explicit: true, ...(expect ? { expect } : {}) });
    const preview = await attempt(false);
    const applied = shape(await attempt(true, preview.preview_hash), root);
    const live = (await engine.listPages({ sourceId: 'default', limit: 100 })).map(page => page.slug).sort();
    expect(live.filter(slug => slug.startsWith('notes/foo'))).toHaveLength(1);
    const moved = await records();
    expect(moved).toEqual({ twin: false, legacy: true });
    return { preview: shape(preview, root), applied, live, moved };
  }));

  parityTest('on a brain this host owns, segmented-mirror walks the segmented pages and lists none without a withdrawal', {
    methods: ['putPage', 'attachSourcePath', 'getWorktreeBinding', 'createSegmentedPageShell', 'flipBodyGeneration', 'listSegmentedPageSlugs',
      'readPageSnapshot'],
    timeout: 60_000,
  }, async (engine) => ownedBrain(engine, async (root) => {
    await put(engine, root, 'notes/plain', 'notes/plain.md', true);
    await publishSegmentedPage(engine, 'notes/seg-b', [segmentText('second segmented body\n')]);
    await publishSegmentedPage(engine, 'notes/seg-a', [segmentText('first segmented body\n')]);
  }, async (root) => ({ ...(await run(engine, 'segmented-mirror', root)), slugs: await engine.listSegmentedPageSlugs('default') })));
});
