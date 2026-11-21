/**
 * BrainEngine parity: the history repair kinds of batch 6a of the repair-on-Rust plan.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a brain seeded so each preview lists at least one item, the preview and its apply are equal on
 *    PGLite, Postgres (DATABASE_URL) and the Rust engine (GBRAIN_TEST_RUST_ARM=1). purged-change-reasons lists the
 *    versions whose stored change reason is the trailer text of a tombstoned (commit, path) and its apply sets each
 *    approved one to '[purged]' on every arm. The version-reason members answer the same rows on every arm.
 *  - Regression: these kinds read and rewrite `page_versions` through executeRaw, so a Rust brain failed on a generic
 *    executeRaw refusal that named no step.
 *  - Why existing coverage misses it: test/purged-change-reasons-repair-gst2886.test.ts and
 *    test/purged-change-reason-8635.test.ts seed with raw SQL on PGLite and Postgres only.
 *  - Seam: a host Git checkout attached as the source's path holds the `gbrain-reason` trailers; pages, versions and
 *    tombstones are seeded through the typed putPage, createVersion and writeReasonPurgeTombstones.
 */
import { describe, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { resolveRepairScope, type RepairKind, type RepairResult } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';

const { parityTest } = parityArms(testBackends());

const quiet = { info() {}, warn() {}, error() {} } as never;

function shape(result: RepairResult, root?: string) {
  const { scope, ...rest } = result;
  let text = JSON.stringify({ ...rest, scope: { brain_id: typeof scope.brain_id, source_ids: scope.source_ids } })
    .replace(/\b[0-9a-f]{64}\b/g, '<sha256>').replace(/\b[0-9a-f]{40}\b/g, '<sha1>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>');
  if (root) text = text.split(root).join('<root>');
  return JSON.parse(text);
}

type RunOpts = Record<string, unknown>;
const runKind = async (engine: BrainEngine, kind: RepairKind, apply: boolean, opts: RunOpts = {}, source?: string) =>
  (await repairRunner(engine, { apply, noEmbed: true, logger: quiet })).run(kind, await resolveRepairScope(engine, source), { explicit: true, ...opts });

/** The refusal text of an error: its message and detail, where the capability and the step it names are. */
const refusalText = (err: unknown) => JSON.stringify({ message: (err as Error).message, detail: (err as { detail?: unknown }).detail });

/** A temporary GBRAIN_HOME and a host directory for checkouts; `fn` gets the directory. */
async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-repair-b6-'));
  try {
    return await withEnv({ GBRAIN_HOME: join(dir, 'home'), DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, () => fn(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A preview that lists at least one item, then the apply of its hash. On Rust an apply that stops names `stop`. */
async function previewThenApply(engine: BrainEngine, backend: string, kind: RepairKind, stop: string | null, opts: RunOpts = {}, root?: string) {
  const previewed = await runKind(engine, kind, false, opts);
  expect(previewed.affected).toBeGreaterThan(0);
  try {
    const applied = await runKind(engine, kind, true, { ...opts, expect: previewed.preview_hash });
    return { preview: shape(previewed, root), applied: shape(applied, root) };
  } catch (err) {
    if (backend === 'rust' && stop) expect(refusalText(err)).toContain(stop);
    throw err;
  }
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// ---- purged-change-reasons ----

const LEAKED = 'Alice Example asked to keep the launch date private.';

/**
 * A checkout attached to `default` with one commit whose `gbrain-reason` trailer is LEAKED, tombstoned for
 * notes/leaked.md. Three versions hold the text: one of the tombstoned path (evidenced), one of another path
 * (path_mismatch), one of a page with no path (path_mismatch); one version holds another reason.
 */
async function seedLeakedReasons(engine: BrainEngine, dir: string): Promise<string> {
  const root = join(dir, 'brain');
  mkdirSync(join(root, 'notes'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'notes', 'leaked.md'), '---\ntype: note\ntitle: Leaked\n---\n\nLeaked body.\n');
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-q', '-m', 'edit', '--trailer', `gbrain-reason: notes/leaked.md: ${LEAKED}`);
  const sha = git(root, 'rev-parse', 'HEAD');
  await engine.attachSourcePath('default', root);
  await engine.writeReasonPurgeTombstones('default', [{ commit_sha: sha, path: 'notes/leaked.md' }]);
  const note = (title: string, sourcePath?: string) => ({ type: 'note' as const, title, compiled_truth: `${title} body.`, timeline: '',
    ...(sourcePath ? { source_path: sourcePath } : {}) });
  for (const [slug, path, reason] of [['notes/leaked', 'notes/leaked.md', LEAKED], ['notes/elsewhere', 'notes/elsewhere.md', LEAKED],
    ['notes/pathless', undefined, LEAKED], ['notes/benign', 'notes/benign.md', 'Routine tidy-up.']] as const) {
    await engine.putPage(slug, note(slug, path), { sourceId: 'default' });
    await engine.createVersion(slug, { sourceId: 'default', reason });
    await engine.putPage(slug, { ...note(slug, path), compiled_truth: `${slug} body, edited.` }, { sourceId: 'default' });
  }
  return root;
}

describe('engine parity: the history repair kinds of batch 6a', () => {
  parityTest('purged-change-reasons previews the leaked reasons and the apply purges the approved ones on every arm', {
    methods: ['putPage', 'createVersion', 'attachSourcePath', 'writeReasonPurgeTombstones', 'listVersionsByChangeReason', 'replaceVersionChangeReasons', 'getVersions'],
    timeout: 60_000,
  }, async (engine, backend) => withDir(async (dir) => {
    const root = await seedLeakedReasons(engine, dir);
    const out = await previewThenApply(engine, backend, 'purged-change-reasons', null, { includeAmbiguous: true }, root);
    const reasons = {} as Record<string, Array<string | null>>;
    for (const slug of ['notes/leaked', 'notes/elsewhere', 'notes/pathless', 'notes/benign']) {
      reasons[slug] = (await engine.getVersions(slug, { sourceId: 'default' })).map(v => (v as { replaced_because?: string | null }).replaced_because ?? null);
    }
    const again = shape(await runKind(engine, 'purged-change-reasons', false, { includeAmbiguous: true }), root);
    return { out, reasons, again };
  }));

  parityTest('the version-reason members list and replace the same rows on every arm', {
    methods: ['putPage', 'createVersion', 'listVersionsByChangeReason', 'replaceVersionChangeReasons'],
    timeout: 60_000,
  }, async (engine) => {
    const note = (title: string) => ({ type: 'note' as const, title, compiled_truth: `${title} body.`, timeline: '', source_path: `${title}.md` });
    for (const [slug, reason] of [['notes/a', 'First reason.'], ['notes/b', 'Second reason.'], ['notes/c', 'First reason.']] as const) {
      await engine.putPage(slug, note(slug), { sourceId: 'default' });
      await engine.createVersion(slug, { sourceId: 'default', reason });
    }
    const strip = (rows: Array<{ id: number }>) => rows.map(({ id, ...rest }) => { void id; return rest; });
    const listed = await engine.listVersionsByChangeReason('default', ['First reason.', 'Second reason.']);
    const none = await engine.listVersionsByChangeReason('default', []);
    const otherSource = await engine.listVersionsByChangeReason('missing-source', ['First reason.']);
    const [a, b, c] = listed;
    // a is replaced; b is named with a text it does not hold, so it keeps its own; c is not named.
    const replaced = await engine.replaceVersionChangeReasons('default', [{ id: a!.id, reason: 'First reason.' }, { id: b!.id, reason: 'First reason.' }], '[purged]');
    expect(replaced).toEqual([a!.id]);
    const wrongSource = await engine.replaceVersionChangeReasons('missing-source', [{ id: c!.id, reason: 'First reason.' }], '[purged]');
    const after = await engine.listVersionsByChangeReason('default', ['First reason.', 'Second reason.', '[purged]']);
    return { listed: strip(listed), none, otherSource, replacedCount: replaced.length, wrongSource, after: strip(after), order: after.map(r => r.id === a!.id ? 'a' : r.id === b!.id ? 'b' : r.id === c!.id ? 'c' : '?') };
  });
});
