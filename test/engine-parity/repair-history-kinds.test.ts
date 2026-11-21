/**
 * BrainEngine parity: the history repair kinds of batch 6a of the repair-on-Rust plan.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a brain seeded so each preview lists at least one item, the preview and its apply are equal on
 *    PGLite, Postgres (DATABASE_URL) and the Rust engine (GBRAIN_TEST_RUST_ARM=1). purged-change-reasons lists the
 *    versions whose stored change reason is the trailer text of a tombstoned (commit, path) and its apply sets each
 *    approved one to '[purged]' on every arm. The version-reason members answer the same rows on every arm.
 *    redacted-facts restores a database-only row whose original words a page holds on every arm; a fenced row is restored
 *    by a page write on the SQL arms, and the Rust engine refuses that page write by name ("repair redacted-facts page
 *    write", lane 7's writer) before it writes anything of the page.
 *  - Regression: these kinds read and rewrite `page_versions` through executeRaw, so a Rust brain failed on a generic
 *    executeRaw refusal that named no step.
 *  - Why existing coverage misses it: test/purged-change-reasons-repair-gst2886.test.ts,
 *    test/purged-change-reason-8635.test.ts and test/repair-redacted-facts.test.ts seed with raw SQL on PGLite and
 *    Postgres only.
 *  - Seam: a host Git checkout attached as the source's path holds the `gbrain-reason` trailers; pages, versions and
 *    tombstones are seeded through the typed putPage, createVersion and writeReasonPurgeTombstones; facts through the
 *    typed insertFact and insertFacts.
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
import { renderFactsTable } from '../../src/core/facts-fence.ts';

const { parityTest } = parityArms(testBackends());

const quiet = { info() {}, warn() {}, error() {} } as never;

function shape(result: RepairResult, root?: string) {
  const { scope, ...rest } = result;
  let text = JSON.stringify({ ...rest, scope: { brain_id: typeof scope.brain_id, source_ids: scope.source_ids } })
    .replace(/\b[0-9a-f]{64}\b/g, '<sha256>').replace(/\b[0-9a-f]{40}\b/g, '<sha1>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>');
  if (root) text = text.split(root).join('<root>');
  // Postgres sequences keep counting across cases (harness reset), so a fact id in an item name is not comparable.
  text = text.replace(/#\d+/g, '#<id>');
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


// ---- redacted-facts ----

const ACME = 'companies/acme-example';
const NOTES = 'notes/operating-models';
const SOURCE_TEXT = 'Reading list. The Acme Business System (ABS) was developed under the CEO in the 1980s. '
  + 'The Example Operating System (EXOS) is positioned as a layer beneath the planning tools.';
const ABS_DAMAGED = 'Acme Business [redacted](ABS) was developed under the CEO in the 1980s';
const EXOS_DAMAGED = 'The Example Operating [redacted](EXOS) is positioned as a layer beneath the planning tools';

async function seedRedactedSource(engine: BrainEngine) {
  await engine.putPage(NOTES, { type: 'note', title: 'Operating models', compiled_truth: SOURCE_TEXT, timeline: '' }, { sourceId: 'default' });
}

/** The active text of each named fact, by name. */
async function factTexts(engine: BrainEngine, ids: Record<string, number>) {
  const out = {} as Record<string, string | null>;
  for (const [name, id] of Object.entries(ids)) {
    const [row] = await engine.listRedactedFactCandidates(['default'], [id]);
    out[name] = row ? row.fact : 'restored-or-inactive';
  }
  return out;
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
  parityTest('redacted-facts restores a database-only row on every arm', {
    methods: ['putPage', 'insertFact', 'listRedactedFactCandidates', 'listRetainedVersionBodies', 'restoreRedactedFactTexts'],
    timeout: 60_000,
  }, async (engine, backend) => withDir(async () => {
    await seedRedactedSource(engine);
    const out = await engine.insertFact({ fact: EXOS_DAMAGED, kind: 'fact', entity_slug: ACME, visibility: 'private', source: 'mcp:put_page',
      context: NOTES, embedding: null } as never, { source_id: 'default' });
    const id = Number(out.id);
    const run = await previewThenApply(engine, backend, 'redacted-facts', null);
    const after = await factTexts(engine, { exos: id });
    expect(after).toEqual({ exos: 'restored-or-inactive' });
    return { run, after };
  }));

  parityTest('redacted-facts restores a fenced row by a page write on the SQL arms, and the Rust engine refuses that write by name', {
    methods: ['putPage', 'insertFacts', 'listRedactedFactCandidates', 'listRetainedVersionBodies', 'listProjectedFenceRows'],
    requires: 'raw_sql', timeout: 60_000,
  }, async (engine, backend) => withDir(async () => {
    await seedRedactedSource(engine);
    const fence = renderFactsTable([{ rowNum: 1, claim: ABS_DAMAGED, kind: 'fact', confidence: 1, visibility: 'private', notability: 'high', active: true, context: NOTES }] as never);
    await engine.putPage(ACME, { type: 'company', title: 'Acme Example', compiled_truth: `Acme Example notes.\n\n## Facts\n\n${fence}\n`, timeline: '' }, { sourceId: 'default' });
    const res = await engine.insertFacts([{ fact: ABS_DAMAGED, kind: 'fact', entity_slug: ACME, visibility: 'private', source: 'fence', context: NOTES,
      row_num: 1, source_markdown_slug: ACME }] as never, { source_id: 'default' });
    const id = Number(res.ids[0]);
    try {
      const run = await previewThenApply(engine, backend, 'redacted-facts', 'repair redacted-facts page write');
      const after = await factTexts(engine, { abs: id });
      expect(after).toEqual({ abs: 'restored-or-inactive' });
      return { run, after };
    } finally {
      if (backend === 'rust') expect(await factTexts(engine, { abs: id })).toEqual({ abs: ABS_DAMAGED });
    }
  }));
  parityTest('the fact-text repair members answer and write the same rows on every arm', {
    methods: ['putPage', 'insertFacts', 'listRedactedFactCandidates', 'restoreRedactedFactTexts', 'listProjectedFenceRows', 'listUnexpiredFactIds',
      'lockFactRows', 'expireFactWithNote', 'expirePageFactsBySource', 'readMaxFactRowNum', 'listRetainedVersionBodies', 'createVersion'],
    timeout: 60_000,
  }, async (engine) => {
    const page = await engine.putPage('notes/rows', { type: 'note', title: 'Rows', compiled_truth: 'Rows body.', timeline: '' }, { sourceId: 'default' });
    const row = (fact: string, n: number | null, source: string, context: string | null = null) =>
      ({ fact, kind: 'fact', entity_slug: null, visibility: 'world', source, context, row_num: n, source_markdown_slug: n === null ? null : 'notes/rows' });
    const res = await engine.insertFacts([row('One [redacted](A) text', 1, 'cli:extract-conversation-facts:v2', 'ctx'), row('Two [redacted](B) text', null, 'mcp:put_page'),
      row('Three plain text', 2, 'fence'), row('Audit marker', 3, 'audit:terminal'), row('Audit legacy', 4, 'audit:legacy')] as never, { source_id: 'default' });
    const [one, two, three, audit, legacy] = res.ids.map(Number);
    const name = (id: number) => ({ [one!]: 'one', [two!]: 'two', [three!]: 'three', [audit!]: 'audit', [legacy!]: 'legacy' } as Record<number, string>)[id] ?? `?${id}`;
    const candidates = (await engine.listRedactedFactCandidates(['default'], null)).map(r => ({ ...r, id: name(r.id) }));
    const restored = (await engine.restoreRedactedFactTexts('default', [
      { id: one!, from_text: 'One [redacted](A) text', to_text: 'One Alpha (A) text', visibility: 'world', entity_slug: null, source_markdown_slug: 'notes/rows', row_num: 1 },
      { id: two!, from_text: 'Two [redacted](B) text', to_text: 'Two Beta (B) text', visibility: 'private', entity_slug: null, source_markdown_slug: null, row_num: null },
    ], 'restored by test')).map(name);
    const projected = await engine.listProjectedFenceRows('default', 'notes/rows', [1, 2, 9], ['One Alpha (A) text', 'Three plain text']);
    await engine.lockFactRows('default', [one!, two!]);
    const noted = await engine.expireFactWithNote('default', three!, 'retired by test');
    const again = await engine.expireFactWithNote('default', three!, 'retired by test');
    const wrongSource = await engine.expireFactWithNote('missing-source', two!, 'x');
    const bySource = await engine.expirePageFactsBySource('default', 'notes/rows', ['audit:terminal', 'audit:legacy']);
    const unexpired = (await engine.listUnexpiredFactIds([one!, two!, three!, audit!, legacy!, 999_999])).map(name);
    const maxRow = await engine.readMaxFactRowNum('default', 'notes/rows');
    const noRows = await engine.readMaxFactRowNum('default', 'notes/none');
    const after = (await engine.listRedactedFactCandidates(['default'], [one!, two!])).map(r => name(r.id));
    await engine.createVersion('notes/rows', { sourceId: 'default' });
    await engine.putPage('notes/rows', { type: 'note', title: 'Rows', compiled_truth: 'Rows body, edited.', timeline: '' }, { sourceId: 'default' });
    await engine.createVersion('notes/rows', { sourceId: 'default' });
    const bodies = (await engine.listRetainedVersionBodies(page.id, 1)).map(b => b.compiled_truth);
    const allBodies = (await engine.listRetainedVersionBodies(page.id, 50)).map(b => b.compiled_truth);
    return { candidates, restored, projected, noted, again, wrongSource, bySource, unexpired, maxRow, noRows, after, bodies, allBodies };
  });
});
