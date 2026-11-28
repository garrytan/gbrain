/**
 * Engine parity: the phantom redirect, the supersede proposal accept and undo, and the label write when the transaction that
 * publishes their file runs its callback again.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a transaction callback may run more than once (the multi-user Rust engine runs it again from a fresh snapshot
 *    after a commit lost on write_conflict, design interface I-1), and only the run that commits counts. These four writes
 *    publish a file inside that callback, so a run that lost its commit leaves the file changed while the database rolls
 *    back. The rerun must start from the bytes the first run found: the phantom redirect still merges the phantom's rows
 *    into the canonical page's file, a supersede proposal still accepts and undoes, and a label write still writes the
 *    label, each once, and the file and the database agree afterwards. Every arm answers the same.
 *  - Regression: the rerun's file precondition read the published file as an outside edit. The phantom redirect held the
 *    phantom as `file_database_drift` (`during`), the proposal accept and undo refused with a file that no longer matched
 *    the plan, and the label write returned `file_changed` (raised as `source_changed`, "its file changed after it was
 *    read"), each while the file kept a change the database had rolled back.
 *  - Why existing coverage misses it: the unit cases for these writes (phantom-redirect-merge, decide/conflict-proposals,
 *    repair-facts-previews-3) run each transaction once; the multi-user lanes meet a rerun only under contention, by chance.
 *  - Seam: none in production. force-rerun.ts wraps engine.transaction and forces the first run that published the file (its
 *    `after` reads the file when a callback returns). On a multi-user Rust brain the forced run ends with a write_conflict
 *    error, so the engine's real optimistic retry runs the callback again; every other arm runs it once in a transaction it
 *    rolls back and once for real, so the same file state meets the rerun there too.
 *  - Not forced on the served Rust arm (GBRAIN_TEST_RUST_SERVED=1): there the owner behind the served client runs the
 *    transactions on its own engine, out of the case's reach. The cases still run there and check the same end state.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect } from 'bun:test';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { rustMuArmRequested, rustServedRequested } from './rust-arm.ts';
import { forceRerunOnHit, type ForcedRerun } from './force-rerun.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { tryRedirectPhantom } from '../../src/core/cycle/phantom-redirect.ts';
import { applyProposalAction } from '../../src/core/facts/proposal-supersede.ts';
import { filesInCheckout, writeLabelFile } from '../../src/core/repair/label-write.ts';
import { serializePageToMarkdown } from '../../src/core/markdown.ts';
import { insertProposal } from '../../src/core/ai/decide/proposals-store.ts';
import { TEST_WRITE_ATTRIBUTION } from '../helpers/write-attribution.ts';

const { parityTest } = parityArms(testBackends());
const SRC = 'work';
const opened: BrainEngine[] = [];

afterEach(async () => {
  for (const engine of opened.splice(0)) await disposePersistenceConsumer(engine).catch(() => undefined);
});

/** Whether this arm forces anything: the served arm's owner runs the transactions where the case cannot reach them (header). */
const forcing = () => !rustServedRequested();

/** On the multi-user arm the engine must take the optimistic path, or the case proves nothing about it. */
function assertArm(engine: BrainEngine, backend: ParityBackend, rerun: ForcedRerun | null): void {
  if (backend === 'rust' && rustMuArmRequested() && !rustServedRequested()) {
    expect((engine as { multiuser?: boolean }).multiuser).toBe(true);
    expect(rerun?.seen.multiuser).toBe(true);
  }
}

const fence = (rows: string[]) => `<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${rows.map((claim, i) => `| ${i + 1} | ${claim} | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |`).join('\n')}
<!--- gbrain:facts:end -->`;

/** A fresh checkout for source `work` in a temporary home; `run` gets its root. */
async function inCheckout<T>(engine: BrainEngine, backend: ParityBackend, run: (root: string) => Promise<T>): Promise<T> {
  opened.push(engine);
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-cycle-txn-rerun-')));
  try {
    return await withEnv({ GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: join(home, 'audit'), DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const root = join(home, 'checkout');
      mkdirSync(join(root, 'people'), { recursive: true });
      await createSource(engine, backend, SRC, {}, root);
      await registerLocalWriter(engine, 'cli');
      return await run(root);
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/** Files `content` at `slug` in the checkout and imports it, so the stored body and the file agree. */
async function filePage(engine: BrainEngine, root: string, slug: string, content: string): Promise<void> {
  writeFileSync(join(root, `${slug}.md`), content);
  await importFromContent(engine, slug, content, { noEmbed: true, sourceId: SRC });
}

/** Runs `body` with the first transaction run that left `file` changed forced once; the wrapper is restored after. */
async function forcedOnPublish<T>(engine: BrainEngine, file: string, body: (rerun: ForcedRerun | null) => Promise<T>): Promise<T> {
  if (!forcing()) return body(null);
  const original = readFileSync(file, 'utf8');
  const rerun = forceRerunOnHit(engine, { limit: 1, after: () => readFileSync(file, 'utf8') !== original });
  try { return await body(rerun); } finally { rerun.restore(); }
}

describe('engine parity: file-publishing writes whose transaction runs again', () => {
  parityTest('a phantom redirect whose canonical-file transaction runs twice merges the phantom rows into the file once and holds nothing', {
    methods: ['getPage', 'listPhantomFactRows'],
    timeout: 240_000,
  }, async (engine, backend) => inCheckout(engine, backend, async root => {
    const canonicalFile = join(root, 'people', 'alice-example.md');
    await filePage(engine, root, 'people/alice-example', `---\ntitle: Alice Example\ntype: person\n---\n\n# Alice Example\n\n## Facts\n\n${fence(['Founded acme-example'])}\n`);
    await filePage(engine, root, 'alice', `---\ntitle: alice\ntype: person\n---\n\n# alice\n\n## Facts\n\n${fence(['Mentors at widget-co'])}\n`);
    const phantom = (await engine.getPage('alice', { sourceId: SRC }))!;
    const before = readFileSync(canonicalFile, 'utf8');
    const { result, rerun } = await forcedOnPublish(engine, canonicalFile, async rerun => {
      assertArm(engine, backend, rerun);
      return { result: await tryRedirectPhantom(engine, phantom, SRC, root, false), rerun };
    });
    if (forcing()) expect(rerun!.seen.forced).toBeGreaterThanOrEqual(1);
    const filed = readFileSync(canonicalFile, 'utf8');
    const stored = (await engine.getPage('people/alice-example', { sourceId: SRC }))!.compiled_truth;
    const out = {
      outcome: result.outcome, canonical: result.canonical, held: result.held ?? null,
      filed_changed: filed !== before,
      filed_rows: filed.split('\n').filter(l => /^\| \d+ \|/.test(l)).map(l => l.split('|')[2]!.trim()),
      file_matches_db: filed.includes(stored.trim()),
      phantom_live: (await engine.getPage('alice', { sourceId: SRC })) !== null,
    };
    expect(out).toEqual({ outcome: 'redirected', canonical: 'people/alice-example', held: null, filed_changed: true,
      filed_rows: ['Founded acme-example', 'Mentors at widget-co'], file_matches_db: true, phantom_live: false });
    return out;
  }));

  // The supersede proposal's accept and undo publish the page's fence file inside their transaction.
  const PAIR_SLUG = 'people/alice-example';
  /** Files a page with two fence rows, inserts both as facts and proposes that row 2 supersedes row 1. */
  async function proposePair(engine: BrainEngine, root: string) {
    await filePage(engine, root, PAIR_SLUG, `---\ntitle: Alice Example\ntype: person\n---\n\n# Alice Example\n\n## Facts\n\n${fence(['Leads research at acme-example', 'Leads design at acme-example'])}\n`);
    const ids: number[] = [];
    await engine.transaction(tx => withCoordinatedWrite(tx, [SRC], async () => {
      const out = await tx.insertFacts(['Leads research at acme-example', 'Leads design at acme-example'].map((fact, i) => ({ fact, entity_slug: PAIR_SLUG,
        source_markdown_slug: PAIR_SLUG, row_num: i + 1, kind: 'fact', visibility: 'world', source: 'test' })) as never, { source_id: SRC });
      ids.push(...out.ids.map(Number));
    }, TEST_WRITE_ATTRIBUTION));
    const id = (await insertProposal(engine, { source_id: SRC, sweep_id: 'sweep-1', pair_index: 0, new_fact_id: ids[1]!, old_fact_id: ids[0]!,
      direction: 'new_supersedes_old', p_supersede: 0.9, threshold: 0.8, proposal_floor: 0.5, model_resolved: 'model-a' }))!;
    return { id, oldId: ids[0]!, newId: ids[1]! };
  }
  /** Row 1 of the fence as filed and as stored, the proposal's status and the old fact's state, with ids named by relation. */
  async function pairState(engine: BrainEngine, file: string, pair: { id: number; oldId: number; newId: number }) {
    const row = (text: string) => (text.split('\n').find(line => line.startsWith('| 1 |')) ?? '').replaceAll(`#${pair.newId}`, '#NEW').replace(/\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?/g, 'DATE');
    const filed = readFileSync(file, 'utf8');
    const stored = (await engine.getPage(PAIR_SLUG, { sourceId: SRC }))!.compiled_truth;
    const old = (await engine.listFactsByEntity(SRC, PAIR_SLUG, { activeOnly: false })).find(f => Number(f.id) === pair.oldId)!;
    return { filed: row(filed), stored: row(stored), file_matches_db: filed.includes(stored.trim()),
      proposal: (await engine.getDecideProposal(pair.id))!.status, old_expired: old.expired_at !== null && old.expired_at !== undefined,
      old_superseded_by_new: Number(old.superseded_by) === pair.newId };
  }

  parityTest('a proposal accept whose fence-file transaction runs twice accepts once and the file and the database both carry the struck row', {
    methods: ['readPairFactRow', 'expireSupersededFact', 'getDecideProposal', 'listFactsByEntity'],
    timeout: 240_000,
  }, async (engine, backend) => inCheckout(engine, backend, async root => {
    const pair = await proposePair(engine, root);
    const file = join(root, `${PAIR_SLUG}.md`);
    const { result, rerun } = await forcedOnPublish(engine, file, async rerun => {
      assertArm(engine, backend, rerun);
      return { result: await applyProposalAction(engine, pair.id, 'accept'), rerun };
    });
    if (forcing()) expect(rerun!.seen.forced).toBeGreaterThanOrEqual(1);
    const out = { status: result.status, reason: result.reason ?? null, ...await pairState(engine, file, pair) };
    expect(out).toMatchObject({ status: 'accepted', reason: null, file_matches_db: true, proposal: 'accepted', old_expired: true, old_superseded_by_new: true });
    expect(out.filed).toContain('~~Leads research at acme-example~~');
    expect(out.stored).toBe(out.filed);
    return out;
  }));

  parityTest('a proposal undo whose fence-file transaction runs twice undoes once and the file and the database both carry the restored row', {
    methods: ['readPairFactRow', 'restoreSupersededFact', 'getDecideProposal', 'listFactsByEntity'],
    timeout: 240_000,
  }, async (engine, backend) => inCheckout(engine, backend, async root => {
    const pair = await proposePair(engine, root);
    const file = join(root, `${PAIR_SLUG}.md`);
    expect((await applyProposalAction(engine, pair.id, 'accept')).status).toBe('accepted');
    const { result, rerun } = await forcedOnPublish(engine, file, async rerun => {
      assertArm(engine, backend, rerun);
      return { result: await applyProposalAction(engine, pair.id, 'undo'), rerun };
    });
    if (forcing()) expect(rerun!.seen.forced).toBeGreaterThanOrEqual(1);
    const out = { status: result.status, reason: result.reason ?? null, ...await pairState(engine, file, pair) };
    expect(out).toMatchObject({ status: 'undone', reason: null, file_matches_db: true, proposal: 'undone', old_expired: false, old_superseded_by_new: false });
    expect(out.filed).not.toContain('~~');
    expect(out.stored).toBe(out.filed);
    return out;
  }));

  parityTest('a label write whose file-writing transaction runs twice writes the label into the file and the page once, and the hardened checkout ends committed and clean', {
    methods: ['readPageSnapshot', 'getPage', 'listCheckoutFiles', 'refreshPageOrigin'],
    timeout: 240_000,
  }, async (engine, backend) => inCheckout(engine, backend, async root => {
    const slug = 'people/alice-example';
    const file = join(root, `${slug}.md`);
    const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', ...args], { encoding: 'utf8' });
    git('init', '-q', '-b', 'main');
    // A hardened checkout (the durability hook's banner, a no-op body): the label write commits its file, so a lost run leaves a commit too.
    writeFileSync(join(root, '.git', 'hooks', 'post-commit'), '#!/usr/bin/env bash\n# gbrain brain-durability post-commit hook (v0.42.44+)\nexit 0\n', { mode: 0o755 });
    await filePage(engine, root, slug, `---\ntitle: Alice Example\ntype: person\n---\n\n# Alice Example\n\nWorks at acme-example.\n`);
    // The page records its file, as a synced page does: the repair writes only a page with a recorded file in a checkout.
    await engine.transaction(tx => withCoordinatedWrite(tx, [SRC], () => tx.refreshPageOrigin(slug, { sourceId: SRC, sourcePath: `${slug}.md`, sourceUri: null }), TEST_WRITE_ATTRIBUTION));
    git('add', '-A');
    git('commit', '-qm', 'alice');
    const before = readFileSync(file, 'utf8');
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId: SRC }))!;
    const path = (await filesInCheckout(engine, [Number(snapshot.page.id)])).get(Number(snapshot.page.id));
    expect(path).toBeDefined();
    const content = serializePageToMarkdown({ ...snapshot.page, frontmatter: { ...snapshot.page.frontmatter, visibility: 'private' } }, snapshot.tags);
    const { written, rerun } = await forcedOnPublish(engine, file, async rerun => {
      assertArm(engine, backend, rerun);
      return { written: await writeLabelFile(engine, { source_id: SRC, slug }, { revision: snapshot.revision, content, edit: { set: { visibility: 'private' }, remove: [] },
        embed: false, preview: 'gbrain repair visibility', path: path! }), rerun };
    });
    if (forcing()) expect(rerun!.seen.forced).toBeGreaterThanOrEqual(1);
    const filed = readFileSync(file, 'utf8');
    const stored = (await engine.getPage(slug, { sourceId: SRC }))!;
    const out = {
      // A string is the revision written; an object is a held or refused outcome, null a page that moved.
      written: typeof written === 'string' ? 'written' : written === null ? 'moved' : written.outcome,
      filed_label: filed.split('\n').filter(line => line.startsWith('visibility:')),
      filed_other_lines_kept: filed.replace(/^visibility:.*\n/m, '') === before,
      stored_label: stored.frontmatter.visibility ?? null,
      checkout_clean: git('status', '--porcelain') === '',
      committed_file_is_filed: git('show', `HEAD:${slug}.md`) === filed,
    };
    expect(out).toEqual({ written: 'written', filed_label: ['visibility: private'], filed_other_lines_kept: true, stored_label: 'private', checkout_clean: true, committed_file_is_filed: true });
    return out;
  }));
});
