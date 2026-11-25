/**
 * BrainEngine parity: the history repair kinds of batch 6a of the repair-on-Rust plan.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a brain seeded so each preview lists at least one item, the preview and its apply are equal on
 *    PGLite, Postgres (DATABASE_URL) and the Rust engine (GBRAIN_TEST_RUST_ARM=1). purged-change-reasons lists the
 *    versions whose stored change reason is the trailer text of a tombstoned (commit, path) and its apply sets each
 *    approved one to '[purged]' on every arm. The version-reason members answer the same rows on every arm.
 *    redacted-facts restores a database-only row whose original words a page holds on every arm; a fenced row is restored
 *    by a page write the same way on every arm.
 *    overwritten-edits lists a database edit a managed sync import archived (seeded through the typed journal members
 *    and coordinated writes, so the version receipts name both requests) the same way on every arm; the restore is a
 *    page write on the SQL arms, and the Rust engine refuses it by name ("repair overwritten-edits page write").
 *    accepted-takes lists the take an accepted `forget` proposal's `takes_remove` request removed (the archived version
 *    holds the row, the live fence reserves its number) the same way on every arm, and its restore (a page write) too.
 *    atoms-restore lists the restorable re-extraction retirements (and counts the kept ones by reason) the same way on
 *    every arm, and its unmanaged apply restores the atom live without its retirement stamp on every arm.
 *    moved-pages, on a brain this host owns with a real Git history: a ghost page whose file was deleted while another
 *    file of the same name holds other content is held (`first_blob_differs`) the same way on every arm; a ghost page
 *    whose file a commit moved is listed as moved on the SQL arms, and the Rust engine refuses the verdict's access
 *    comparison by name ("repair moved-pages access check": the privacy predicate has no typed member).
 *    private-labels previews an alias-labelled page on the SQL arms, and the Rust engine refuses its privacy scan by name
 *    ("repair private-labels privacy scan": the label scan and the dependents read evaluate the privacy predicate).
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
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { renderTakesFence, type ParsedTake } from '../../src/core/takes-fence.ts';

const { parityTest } = parityArms(testBackends());

const quiet = { info() {}, warn() {}, error() {} } as never;

function shape(result: RepairResult, root?: string) {
  const { scope, ...rest } = result;
  let text = JSON.stringify({ ...rest, scope: { brain_id: typeof scope.brain_id, source_ids: scope.source_ids } })
    .replace(/\b[0-9a-f]{64}\b/g, '<sha256>').replace(/\b[0-9a-f]{40}\b/g, '<sha1>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<uuid>').replace(/\b[0-9a-f]{12}\b/g, '<commit>');
  if (root) text = text.split(root).join('<root>');
  // Postgres sequences keep counting across cases (harness reset), so a page, fact or version id is not comparable; nor
  // is a request's completion time or a commit id.
  text = text.replace(/#\d+/g, '#<id>').replace(/"version_id":\d+/g, '"version_id":"<id>"').replace(/version \d+/g, 'version <id>')
    .replace(/@v\d+/g, '@v<id>').replace(/restore_version:\d+/g, 'restore_version:<id>')
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, '<time>').replace(/"page_id":\d+/g, '"page_id":"<id>"').replace(/\(id \d+/g, '(id <id>');
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


// ---- overwritten-edits ----

const JOURNAL_KEYS = ['principal:local_cli:history-writer', 'brain'];

/** A committed request of `operation` with `intent` and `outcome`; answers its row id. */
async function committedRequest(engine: BrainEngine, requestId: string, operation: string, intent: unknown, outcome: unknown, page: { id: number; slug: string } | null = null): Promise<string> {
  const source = await engine.readSourceMembership('default');
  await engine.lockPersistenceCounters(JOURNAL_KEYS);
  const { id } = await engine.insertWriteRequest({
    principalKind: 'local_cli', principalId: 'history-writer', requestId, operation, sourceId: 'default',
    sourceIncarnation: source!.incarnation, pageId: page?.id ?? null, slug: page?.slug ?? 'notes/overwritten', worktreeId: null,
    topologyGeneration: null, digest: 'd'.repeat(64), intent, authority: { scopes: ['write'] },
    intentBytes: 100, terminalReservation: 8192, targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity',
    admitterHostId: null, counterKeys: JOURNAL_KEYS, clientRequestId: null, state: 'queued', deferredRefreshId: null,
  });
  await engine.completeWriteRow({ id, state: 'committed', outcome, errorCode: null, errorMessage: null, consumerVersion: 'parity', consumerHostId: null,
    errorDetail: null, resultBytes: 400, counterKeys: JOURNAL_KEYS, intentBytes: 100, retainedBytes: 500, terminalReservation: 8192, probePurges: false });
  return id;
}

/**
 * notes/overwritten: a database-only edit (request W, outcome persistence.mode database) that a managed sync import
 * (request S) archived and replaced with other content.
 */
async function seedOverwrite(engine: BrainEngine) {
  const w = await committedRequest(engine, 'c0000000-0000-4000-8000-0000000000a1', 'put_page', { kind: 'put_page' }, { persistence: { mode: 'database' } });
  const s = await committedRequest(engine, 'c0000000-0000-4000-8000-0000000000a2', 'submit_job', { kind: 'managed_sync_import' }, { imported_file: true });
  const page = (body: string) => ({ type: 'note' as const, title: 'Overwritten', compiled_truth: body, timeline: '' });
  const as = (requestId: string, fn: (tx: BrainEngine) => Promise<unknown>) => engine.transaction(tx =>
    withCoordinatedWrite(tx, ['default'], () => fn(tx), { requestId, principal: { kind: 'local_cli', id: 'history-writer' } }));
  await as(w, tx => tx.putPage('notes/overwritten', page('The database edit the user made.'), { sourceId: 'default' }));
  await as(s, async (tx) => {
    await tx.createVersion('notes/overwritten', { sourceId: 'default' });
    await tx.putPage('notes/overwritten', page('The committed file the import published.'), { sourceId: 'default' });
  });
}


// ---- accepted-takes ----

const bet = (rowNum: number, claim: string): ParsedTake => ({ rowNum, claim, kind: 'bet', holder: 'world', weight: 0.6, active: true });

/**
 * people/mina-example: row 2 ("Mina prefers tea") was removed by a `takes_remove` request R that applied accepted
 * proposal tp<n> (change `deactivated`); R archived the version holding the row, and the live fence reserves row 2.
 */
async function seedAcceptedRemoval(engine: BrainEngine) {
  const slug = 'people/mina-example';
  const body = (takes: ParsedTake[], reserved: number[]) => ({ type: 'person' as const, title: 'Mina Example', timeline: '',
    compiled_truth: `# Mina Example\n\nProse.\n\n## Takes\n\n${renderTakesFence(takes, reserved)}\n` });
  const saved = await engine.putPage(slug, body([bet(1, 'Mina will move to Lima'), bet(2, 'Mina prefers tea')], []), { sourceId: 'default' });
  await engine.addTakesBatch([{ page_id: saved.id, row_num: 1, claim: 'Mina will move to Lima', kind: 'bet', holder: 'world', weight: 0.6, active: true, superseded_by: null }] as never);
  const proposal = await engine.insertTrustProposal({ action: 'forget', sourceId: 'default', target: { table: 'takes', id: 1 },
    before: { change: 'deactivated', writer_tier: 'agent_written' }, proposer: 'put_page' } as never);
  expect(await engine.transitionTrustProposal(proposal.id, 'pending', 'accepted')).toBe(true);
  const r = await committedRequest(engine, 'c0000000-0000-4000-8000-0000000000b1', 'takes_remove', { trust_accept: String(proposal.id), row_num: 2 }, {},
    { id: Number(saved.id), slug });
  await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
    await tx.createVersion(slug, { sourceId: 'default' });
    await tx.putPage(slug, body([bet(1, 'Mina will move to Lima')], [2]), { sourceId: 'default' });
  }, { requestId: r, principal: { kind: 'local_cli', id: 'history-writer' } }));
}


// ---- atoms-restore ----

/**
 * notes/origin is live. atoms/restorable (hash h1) is the latest retirement of its origin with an unstamped version at
 * h1; atoms/older (hash h0, retired earlier) is an older generation; atoms/orphan names a gone origin; atoms/replaced
 * shares an origin with the live atoms/live at another hash.
 */
async function seedRetiredAtoms(engine: BrainEngine) {
  const put = (slug: string, type: string, frontmatter: Record<string, unknown>) =>
    engine.putPage(slug, { type: type as never, title: slug, compiled_truth: `${slug} body.`, timeline: '', frontmatter }, { sourceId: 'default' });
  await put('notes/origin', 'note', {});
  await put('notes/other-origin', 'note', {});
  const retire = async (slug: string, origin: string, hash: string, at: string) => {
    await put(slug, 'atom', { source_slug: origin, source_hash: hash });
    await engine.createVersion(slug, { sourceId: 'default' });
    await put(slug, 'atom', { source_slug: origin, source_hash: hash, retired_by: 'managed-reextract', retired_at: at });
    await engine.softDeletePage(slug, { sourceId: 'default' });
  };
  await retire('atoms/older', 'notes/origin', 'h0', '2026-01-01T00:00:00.000Z');
  await retire('atoms/restorable', 'notes/origin', 'pending:h1', '2026-02-01T00:00:00.000Z');
  await retire('atoms/orphan', 'notes/gone', 'h2', '2026-02-01T00:00:00.000Z');
  await retire('atoms/replaced', 'notes/other-origin', 'h3', '2026-02-01T00:00:00.000Z');
  await put('atoms/live', 'atom', { source_slug: 'notes/other-origin', source_hash: 'h4' });
}


// ---- moved-pages ----

const noteBody = (title: string) => `---\ntype: note\ntitle: ${title}\n---\n\n${title} body.\n`;

/** A checkout attached to `default`, this host its registered writer and owner; `steps` commit files in order. */
async function ownedCheckout(engine: BrainEngine, dir: string): Promise<string> {
  const root = join(dir, 'brain');
  mkdirSync(join(root, 'notes'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  await engine.attachSourcePath('default', root);
  await registerLocalWriter(engine, 'cli');
  await claimWorktree(engine, 'default', root);
  return root;
}

function commitAll(root: string, message: string) {
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-q', '-m', message);
}

async function putNotePage(engine: BrainEngine, slug: string, title: string, sourcePath: string) {
  await engine.putPage(slug, { type: 'note', title, compiled_truth: `${title} body.`, timeline: '', source_path: sourcePath }, { sourceId: 'default' });
}

/** Twelve file-backed pages keep the source's file ratio over the ghost floor. */
async function keepPages(engine: BrainEngine, root: string) {
  for (let i = 0; i < 12; i++) {
    writeFileSync(join(root, 'notes', `keep-${i}.md`), noteBody(`notes/keep-${i}`));
    await putNotePage(engine, `notes/keep-${i}`, `notes/keep-${i}`, `notes/keep-${i}.md`);
  }
}

describe('engine parity: the history repair kinds of batch 6a', () => {
  parityTest('readPageVersionRow reads the version row revert_version reverts to, and null for another page or id', {
    methods: ['putPage', 'createVersion', 'readPageVersionRow'], timeout: 60_000,
  }, async (engine) => {
    const page = await engine.putPage('notes/versioned', { type: 'note', title: 'First', compiled_truth: 'First body.', timeline: '- **2024-03-01** | manual — One', frontmatter: { tags_note: 'a' } }, { sourceId: 'default' });
    const version = await engine.createVersion('notes/versioned', { sourceId: 'default' });
    const other = await engine.putPage('notes/other', { type: 'note', title: 'Other', compiled_truth: 'Other body.', timeline: '' }, { sourceId: 'default' });
    const row = await engine.readPageVersionRow(Number(version.id), page.id);
    const pick = (v: typeof row) => v && { page: v.page_id === page.id, title: v.title, type: v.type, compiled_truth: v.compiled_truth, timeline: v.timeline,
      frontmatter: v.frontmatter, tags: v.tags, is_deleted: v.is_deleted ?? null, body_storage: v.body_storage ?? null };
    return { row: pick(row), otherPage: await engine.readPageVersionRow(Number(version.id), other.id), noSuchId: await engine.readPageVersionRow(Number(version.id) + 1000, page.id) };
  });

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

  parityTest('redacted-facts restores a fenced row by a page write the same way on every arm', {
    methods: ['putPage', 'insertFacts', 'listRedactedFactCandidates', 'listRetainedVersionBodies', 'listProjectedFenceRows'],
    timeout: 60_000,
  }, async (engine, backend) => withDir(async () => {
    await seedRedactedSource(engine);
    const fence = renderFactsTable([{ rowNum: 1, claim: ABS_DAMAGED, kind: 'fact', confidence: 1, visibility: 'private', notability: 'high', active: true, context: NOTES }] as never);
    await engine.putPage(ACME, { type: 'company', title: 'Acme Example', compiled_truth: `Acme Example notes.\n\n## Facts\n\n${fence}\n`, timeline: '' }, { sourceId: 'default' });
    const res = await engine.insertFacts([{ fact: ABS_DAMAGED, kind: 'fact', entity_slug: ACME, visibility: 'private', source: 'fence', context: NOTES,
      row_num: 1, source_markdown_slug: ACME }] as never, { source_id: 'default' });
    const id = Number(res.ids[0]);
    const run = await previewThenApply(engine, backend, 'redacted-facts', null);
    const after = await factTexts(engine, { abs: id });
    expect(after).toEqual({ abs: 'restored-or-inactive' });
    return { run, after };
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
  parityTest('overwritten-edits previews and restores the database edit an import overwrote the same way on every arm', {
    methods: ['insertWriteRequest', 'completeWriteRow', 'setWriteContext', 'putPage', 'createVersion', 'listOverwriteCandidates', 'listVersionsAfter',
      'listOverwriteLivePages', 'readVersionContent'],
    timeout: 60_000,
  }, async (engine, backend) => withDir(async () => {
    await seedOverwrite(engine);
    const scanned = await engine.listOverwriteCandidates('default', null, 10);
    expect(scanned.map(row => row.slug)).toEqual(['notes/overwritten']);
    return previewThenApply(engine, backend, 'overwritten-edits', 'repair overwritten-edits page write');
  }));
  parityTest('accepted-takes previews the take an accepted removal took and restores it the same way on every arm', {
    methods: ['putPage', 'addTakesBatch', 'insertTrustProposal', 'transitionTrustProposal', 'insertWriteRequest', 'completeWriteRow', 'setWriteContext',
      'createVersion', 'listAcceptedTakeRemovals', 'readArchivedVersionBody', 'readTakeRowTier'],
    timeout: 60_000,
  }, async (engine, backend) => withDir(async () => {
    await seedAcceptedRemoval(engine);
    expect((await engine.listAcceptedTakeRemovals(['default'], null)).map(r => r.row_num)).toEqual([2]);
    const run = await previewThenApply(engine, backend, 'accepted-takes', null);
    const pageId = Number((await engine.getPage('people/mina-example', { sourceId: 'default' }))!.id);
    expect(await engine.readTakeRowTier(pageId, 2)).not.toBeNull();
    return run;
  }));
  parityTest('atoms-restore previews the restorable atom and counts the kept ones the same way, and restores it on every arm', {
    methods: ['putPage', 'createVersion', 'softDeletePage', 'listRestorableAtoms', 'countKeptAtomRetirements', 'lockPageKeys', 'restorePage', 'removePageFrontmatterKeys'],
    timeout: 60_000,
  }, async (engine, backend) => withDir(async () => {
    await seedRetiredAtoms(engine);
    const listed = (await engine.listRestorableAtoms(['default'], null)).map(({ id, origin_page_id, version_id, incarnation, revision, ...rest }) => {
      void id; void origin_page_id; void incarnation; void revision;
      return { ...rest, has_version: version_id !== null };
    });
    expect(listed.map(row => row.slug)).toEqual(['atoms/restorable']);
    const kept = await engine.countKeptAtomRetirements(['default']);
    const otherSource = await engine.listRestorableAtoms(['missing-source'], null);
    const run = await previewThenApply(engine, backend, 'atoms-restore', null);
    const restored = await engine.getPage('atoms/restorable', { sourceId: 'default' });
    expect(restored?.frontmatter).toEqual({ source_slug: 'notes/origin', source_hash: 'pending:h1' });
    return { listed, kept, otherSource, run, restored: { slug: restored?.slug, frontmatter: restored?.frontmatter } };
  }));
  parityTest('moved-pages holds a deleted file whose name another file reuses the same way on every arm', {
    methods: ['putPage', 'attachSourcePath', 'getWorktreeBinding', 'listLivePagesByFileName'],
    timeout: 60_000,
  }, async (engine) => withDir(async (dir) => {
    const root = await ownedCheckout(engine, dir);
    await keepPages(engine, root);
    mkdirSync(join(root, 'notes', 'archive'), { recursive: true });
    writeFileSync(join(root, 'notes', 'plan.md'), noteBody('Plan'));
    await putNotePage(engine, 'notes/plan', 'Plan', 'notes/plan.md');
    commitAll(root, 'seed');
    rmSync(join(root, 'notes', 'plan.md'));
    writeFileSync(join(root, 'notes', 'archive', 'plan.md'), noteBody('Another plan'));
    await putNotePage(engine, 'notes/archive/plan', 'Another plan', 'notes/archive/plan.md');
    commitAll(root, 'delete the plan, add another');
    const previewed = shape(await runKind(engine, 'moved-pages', false), root);
    expect(JSON.stringify(previewed)).toContain('first_blob_differs');
    return previewed;
  }));

  parityTest('moved-pages lists a moved file the same way on every arm', {
    methods: ['putPage', 'attachSourcePath', 'getWorktreeBinding', 'listLivePagesBySourcePaths', 'hasSegmentedHistory'],
    timeout: 60_000,
  }, async (engine, backend) => withDir(async (dir) => {
    const root = await ownedCheckout(engine, dir);
    await keepPages(engine, root);
    writeFileSync(join(root, 'notes', 'old.md'), noteBody('Moved'));
    await putNotePage(engine, 'notes/old', 'Moved', 'notes/old.md');
    commitAll(root, 'seed');
    git(root, 'mv', 'notes/old.md', 'notes/new.md');
    await putNotePage(engine, 'notes/new', 'Moved', 'notes/new.md');
    commitAll(root, 'move');
    try {
      const previewed = shape(await runKind(engine, 'moved-pages', false), root);
      expect(previewed.affected).toBe(1);
      return previewed;
    } catch (err) {
      if (backend === 'rust') expect(refusalText(err)).toContain('repair moved-pages access check');
      throw err;
    }
  }));
  parityTest('private-labels previews an alias-labelled page the same way on every arm', {
    methods: ['putPage'], timeout: 60_000,
  }, async (engine, backend) => withDir(async () => {
    await engine.putPage('notes/aliased', { type: 'note', title: 'Aliased', compiled_truth: 'Aliased body.', timeline: '', frontmatter: { access: 'private' } }, { sourceId: 'default' });
    try {
      const previewed = shape(await runKind(engine, 'private-labels', false));
      expect(previewed.affected).toBeGreaterThan(0);
      return previewed;
    } catch (err) {
      if (backend === 'rust') expect(refusalText(err)).toContain('repair private-labels privacy scan');
      throw err;
    }
  }));
  parityTest('private-labels lists the pages a clear would expose, and its scans answer the same rows on every arm', {
    methods: ['putPage', 'listLabelledPages', 'listLiveLabelRows', 'listClearDependents'], timeout: 60_000,
  }, async (engine) => withDir(async () => {
    const put = (slug: string, type: string, frontmatter: Record<string, unknown>) =>
      engine.putPage(slug, { type: type as never, title: slug, compiled_truth: `${slug} body.`, timeline: '', frontmatter }, { sourceId: 'default' });
    const aliased = await put('notes/aliased', 'note', { access: 'private' });
    await put('notes/strong', 'note', { access: 'restricted' });
    await put('notes/declared', 'note', { visibility: 'world', derived_from: ['notes/aliased.md'] });
    await put('atoms/from-aliased', 'atom', { visibility: 'world', source_slug: 'notes/aliased' });
    // A Life Chronicle event whose origin is the aliased page: private now (its origin is not visible), public once the clear applies.
    await put('events/from-aliased', 'event', { visibility: 'world', captured_via: 'life-chronicle:example', event: { depth: 'notes/aliased' } });
    await put('notes/unrelated', 'note', { visibility: 'world' });
    const name = new Map<number, string>();
    const labelled = (await engine.listLabelledPages(['default'], 0, null, 60_000)).map(row => { name.set(Number(row.id), row.slug); return [row.slug, row.git, row.chars]; });
    const live = (await engine.listLiveLabelRows([aliased.id], 60_000)).map(row => [row.slug, row.revision === null ? null : typeof row.revision]);
    const ids = new Map<number, string>();
    for (const slug of ['notes/declared', 'atoms/from-aliased', 'events/from-aliased', 'notes/unrelated', 'notes/aliased']) {
      const page = await engine.getPage(slug, { sourceId: 'default' });
      ids.set(Number(page!.id), slug);
    }
    const dependents = (await engine.listClearDependents({ ids: [aliased.id], sourceIds: ['default'], slugs: ['notes/aliased'], keys: ['access'] }, 60_000))
      .map(row => [ids.get(Number(row.id)) ?? row.id, ids.get(Number(row.cleared_id)) ?? row.cleared_id, row.category]);
    expect(dependents).toEqual([['events/from-aliased', 'notes/aliased', 'life_chronicle']]);
    const previewed = shape(await runKind(engine, 'private-labels', false));
    return { labelled, live, dependents, previewed };
  }));
  parityTest('the version, overwrite and moved-page reads answer the same rows on every arm', {
    methods: ['insertWriteRequest', 'completeWriteRow', 'setWriteContext', 'putPage', 'createVersion', 'listOverwriteCandidates', 'listVersionsAfter',
      'listOverwriteLivePages', 'readVersionContent', 'readArchivedVersionBody', 'listLivePagesBySourcePaths', 'listLivePagesByFileName',
      'listLivePagesSharingFrontmatterId', 'hasSegmentedHistory', 'readLivePagesByIds'],
    timeout: 60_000,
  }, async (engine) => {
    await seedOverwrite(engine);
    const [candidate] = await engine.listOverwriteCandidates('default', ['notes/overwritten'], 5);
    const pageId = Number(candidate!.page_id), versionId = Number(candidate!.version_id);
    const content = (row: { title: unknown; type: unknown; compiled_truth: unknown; timeline: unknown; frontmatter: unknown; tags: unknown; body_storage: unknown } | null) =>
      row && { title: row.title, type: row.type, compiled_truth: row.compiled_truth, timeline: row.timeline, body_storage: row.body_storage,
        frontmatter: typeof row.frontmatter === 'string' ? JSON.parse(row.frontmatter) : row.frontmatter, tags: row.tags };
    const later = (await engine.listVersionsAfter([pageId], 0)).map(v => ({ ...content(v), writer: v.write_request_id === candidate!.db_request_id ? 'w' : v.write_request_id === null ? null : 'other' }));
    const none = await engine.listVersionsAfter([pageId], versionId);
    const live = (await engine.listOverwriteLivePages([pageId, 999_999])).map(p => ({ ...content(p), revision_writer: p.revision_write_request_id === candidate!.import_request_id ? 's' : 'other' }));
    const version = content(await engine.readVersionContent(versionId, pageId));
    const wrongPage = await engine.readVersionContent(versionId, pageId + 1);
    const archived = await engine.readArchivedVersionBody(pageId, candidate!.import_request_id);
    const notArchived = await engine.readArchivedVersionBody(pageId, candidate!.db_request_id);
    const put = (slug: string, sourcePath: string | null, frontmatter: Record<string, unknown> = {}) =>
      engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body.`, timeline: '', frontmatter, ...(sourcePath ? { source_path: sourcePath } : {}) }, { sourceId: 'default' });
    const a = await put('notes/a', 'notes/a.md', { id: 'shared-id' });
    const b = await put('notes/b', 'docs/a.md', { id: 'shared-id' });
    await put('notes/c', 'notes/c.md', { id: 7 });
    await put('notes/d', 'a.md');
    const slugsOf = (rows: Array<{ slug: string }>) => rows.map(r => r.slug);
    const strip = (rows: Array<{ id: number; slug: string; revision: string; source_path: string | null }>) => rows.map(({ slug, source_path }) => ({ slug, source_path }));
    return {
      later, none, live, version, wrongPage,
      archived: archived && { compiled_truth: archived.compiled_truth, body_storage: archived.body_storage, same: archived.id === versionId }, notArchived,
      byPaths: strip(await engine.listLivePagesBySourcePaths('default', Number(a.id), ['notes/a.md', 'docs/a.md', 'notes/c.md', 'missing.md'])),
      byName: await engine.listLivePagesByFileName('default', Number(a.id), 'a.md'),
      sharing: await engine.listLivePagesSharingFrontmatterId('default', Number(a.id)),
      sharingNone: await engine.listLivePagesSharingFrontmatterId('default', 999_999),
      segmented: await engine.hasSegmentedHistory(Number(a.id)),
      byIds: slugsOf(await engine.readLivePagesByIds('default', [Number(a.id), Number(b.id), 999_999])).sort(),
      otherSource: await engine.readLivePagesByIds('missing-source', [Number(a.id)]),
    };
  });
});
