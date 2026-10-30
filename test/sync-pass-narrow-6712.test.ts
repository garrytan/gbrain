/**
 * #6712 PR 4b fix 3, first part: a taken confirm round at the previous round's tree patches the previous round's origin
 * domain (claims, claimants, domain, spelling twins, the attestation walk) at the origins the pass wrote, and classifies
 * again only the paths whose kept entry could change (sync-pass-narrow.ts). Every other round reads in full, as before.
 *
 * Protects: on each case, every taken round after the first gives exactly the level a cacheless full read of the same
 * database and tree gives: each path's class, state (attestation `A`, spelling twin), page, revision and claimants, and
 * the level's reconcilable count, holds and kind. Cases: a round-1 edit, a rename that moves a page's origin (old and new)
 * and a new page, alone and beside tombstones at the rename's and the new page's origins, several live pages on one
 * origin (#6948), several tombstones, two spellings and a differing identity (GBRA-130); and the seeded mix. Open work
 * admitted between rounds on an untouched path: the narrowed round re-checks each kept entry against it (`keptUnread`) and
 * classifies that path again (keeping the entry is red). A marker written between rounds: the confirm round declines it.
 * A round whose seam refuses the patch (`sync:level_narrow`) builds the domain whole and says so (`narrow: 'forced'`).
 *
 * PGLite here; Postgres through test/e2e/sync-pass-narrow-6712-postgres.test.ts.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { installFaultHook, type FaultDetail, type FaultPoint } from '../src/core/persistence/fault-points.ts';
import { admitWrite } from '../src/core/persistence/journal.ts';
import { preparePageAdmission } from '../src/core/persistence/page-mutations.ts';
import { writeOriginDeletedMarker } from '../src/core/persistence/sync-markers.ts';
import { waitFor } from './helpers/wait-for.ts';
import { readShadowLevel, type ShadowLevel } from '../src/core/persistence/sync-pass.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { __resetTreeReuseForTests } from '../src/core/persistence/sync-tree-reuse.ts';
import { mixSetup, seedMix } from '../scripts/bench/sync-convergence-seeded.ts';
import { rebuildPendingPageProjections } from '../src/core/page-state/projections.ts';
import { dropOriginIndex } from './helpers/origin-index.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string, body = `The body of ${title}.`, front = '') => `---\ntype: concept\ntitle: ${title}\n${front}---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (const slug of ['a', 'b', 'c']) writeFileSync(join(root, `notes/${slug}.md`), note(`notes/${slug}`));
  writeFileSync(join(root, 'notes/Kept Doc.md'), note('Kept doc', 'A kept document.', 'id: kept-one\n'));
  commit(root, 'notes');
};

/** What the level hands the pass, path by path and level-wide. */
function project(level: ShadowLevel) {
  return {
    paths: level.paths.map(entry => ({ path: entry.path, slug: entry.slug, pageId: entry.pageId, revision: entry.revision, result: entry.result, state: entry.state,
      legacyPageless: entry.legacyPageless ?? null, ambiguousOrigin: entry.ambiguousOrigin ?? null })),
    reconcilable: level.reconcilable, releasableHolds: level.releasableHolds, heldRenames: level.heldRenames, rescreenDue: level.rescreenDue, kind: level.kind,
    kindBlockers: level.kindBlockers, fileRefusals: level.fileRefusals ?? null,
  };
}

type Compared = { round: number; narrow: string | undefined; same: boolean; paths: number; classes: Record<string, string>; open: string[] };
type Hook = (point: FaultPoint, detail: FaultDetail) => Promise<void>;
/**
 * A sync whose rounds after the first, when their confirm round is taken, are each compared with a cacheless full read;
 * `also` runs first at every seam, and `confirms` is each round's confirm verdict.
 *
 * The pass's narrowed read and the comparison's full read happen one after the other, so each round's open work is held
 * still from the round's start until its comparison ends: no request is claimed, a claimed request waits before it
 * prepares or publishes, a Git effect waits before it finishes, and the round starts reading once nothing else is running.
 * The effect worker walks the Git effects one pass claimed (a coalesced group, and every group it deferred) one at a time,
 * so while one waits at its seam the others it claimed stay running behind it and never reach theirs: they are held too.
 * Otherwise a write committing between the two reads makes them differ by that path's open work alone.
 */
async function compared(engine: BrainEngine, { force = false, also }: { force?: boolean; also?: Hook } = {}) {
  const rounds: Compared[] = [], mismatches: unknown[] = [], confirms: Array<{ round: number; taken: boolean | null; reason: string | null }> = [];
  const waiting = new Set<string>();
  let thaw = () => {}, thawed = Promise.resolve();
  const still = async () => {
    thawed = new Promise<void>(resolve => { thaw = resolve; });
    let unheld: unknown[] = [];
    await waitFor(async () => {
      const running = await engine.executeRaw<{ id: string }>(`SELECT 'r' || request_id::text AS id, operation AS kind, slug, intent->>'kind' AS intent, claim_phase->>'step' AS step FROM persistence_requests WHERE source_id='default' AND state='running'
        UNION ALL SELECT 'e' || id::text, kind, request_id::text, NULL, NULL FROM persistence_effects WHERE source_id='default' AND kind='git' AND state='running'`);
      const effectHeld = running.some(row => row.id.startsWith('e') && waiting.has(row.id));
      unheld = running.filter(row => !waiting.has(row.id) && !(effectHeld && row.id.startsWith('e')));
      return !unheld.length;
    }, { timeoutMs: 60_000, label: 'the open work of the source holds still' }).catch((error: Error) => {
      error.message += `; running and not held: ${JSON.stringify(unheld)}; held: ${JSON.stringify([...waiting])}`;
      throw error;
    });
  };
  installFaultHook(async (point, detail) => {
    const held = point === 'consumer:preparing' || point === 'consumer:prepared' ? `r${detail.requestId}` : point === 'effect:git:mid' ? `e${detail.effectId}` : null;
    if (held) waiting.add(held);
    try {
      await also?.(point, detail);
      if (held || point === 'consumer:claiming') await thawed;
    } finally { if (held) waiting.delete(held); }
    if (point === 'sync:level_narrow' && force) throw new Error('a refused patch');
    if (point === 'sync:round_start') await still();
    if (point === 'sync:level_read') await compare(detail).finally(() => thaw());
  });
  const compare = async (detail: FaultDetail) => {
    confirms.push({ round: detail.round!, taken: detail.level?.confirm?.taken ?? null, reason: detail.level?.confirm?.reason ?? null });
    if (!detail.level?.confirm?.taken) return;
    const input = detail.level.input as Parameters<typeof readShadowLevel>[1];
    const narrowed = project(detail.level.shadow as ShadowLevel);
    const full = project((await readShadowLevel(engine, { ...input, pass: { ...input.pass!, cache: undefined, passId: undefined } }))!);
    const same = JSON.stringify(narrowed) === JSON.stringify(full);
    if (!same) mismatches.push({ round: detail.round, narrowed, full });
    rounds.push({ round: detail.round!, narrow: detail.level.confirm.narrow, same, paths: narrowed.paths.length, classes: Object.fromEntries(narrowed.paths.map(entry => [entry.path, entry.result.cls])),
      open: narrowed.paths.filter(entry => entry.state.openWork).map(entry => entry.path) });
  };
  try {
    // These are one pass's own rounds: round 1 reads whole, as in a new process (GBRA-133 cross-pass reuse is test/sync-level-reuse-across-gbra133.test.ts).
    __resetTreeReuseForTests();
    const result = await performManagedSync(engine, OPTS);
    expect(mismatches).toEqual([]);
    return { status: result.status, rounds, confirms };
  } finally { thaw(); installFaultHook(undefined); }
}
const narrowed = (run: { rounds: Compared[] }) => run.rounds.filter(round => round.narrow === 'taken');

/**
 * A second live page recording notes/a.md (#6948), as legacy data left it, its text projection sealed as the consumer
 * seals it (a raw putPage leaves it unsealed, and the consumer's one-time seal during the pass is a foreign page write).
 */
async function liveTwin(engine: BrainEngine) {
  await dropOriginIndex(engine);
  await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
    await tx.putPage('notes/a-copy', { type: 'concept', title: 'Example', compiled_truth: 'A different body.', timeline: '', frontmatter: {}, content_hash: crypto.randomUUID() }, { sourceId: 'default' });
    await tx.executeRaw("UPDATE pages SET source_path='notes/a.md' WHERE source_id='default' AND slug='notes/a-copy'");
  }, TEST_WRITE_ATTRIBUTION));
  expect((await rebuildPendingPageProjections(engine, 100)).rebuilt).toBe(1);
}
/** Two deleted pages recording notes/twin.md (#6517). */
async function tombstoneTwins(engine: BrainEngine) {
  for (const slug of ['archive/twin-one', 'archive/twin-two']) await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
    await tx.putPage(slug, { type: 'note', title: slug, compiled_truth: `Deleted ${slug}.`, timeline: '', frontmatter: {}, content_hash: `h-${slug}` }, { sourceId: 'default' });
    await tx.executeRaw("UPDATE pages SET source_path='notes/twin.md', deleted_at=now() WHERE source_id='default' AND slug=$1", [slug]);
  }, TEST_WRITE_ATTRIBUTION));
}

/** Deleted pages recording the origins round 1 would move a page onto and create a page at: round 1 holds both, beside its edit. */
async function tombstonedTargets(engine: BrainEngine) {
  for (const [slug, path] of [['archive/old-moved', 'notes/b-moved.md'], ['archive/old-new', 'notes/new.md']]) await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
    await tx.putPage(slug!, { type: 'note', title: slug!, compiled_truth: `Deleted ${slug}.`, timeline: '', frontmatter: {}, content_hash: `h-${slug}` }, { sourceId: 'default' });
    await tx.executeRaw("UPDATE pages SET source_path=$2, deleted_at=now() WHERE source_id='default' AND slug=$1", [slug, path]);
  }, TEST_WRITE_ATTRIBUTION));
}

/** Each case's arrangement after the first sync; round 1 also edits, renames and adds a page (`roundOneWrites`). */
const CASES: Record<string, { arrange: (engine: BrainEngine, root: string) => Promise<void> }> = {
  moves: { arrange: async () => {} },
  tombstoned_targets: { arrange: engine => tombstonedTargets(engine) },
  several_live: { arrange: engine => liveTwin(engine) },
  several_tombstones: { arrange: async (engine, root) => { await tombstoneTwins(engine); writeFileSync(join(root, 'notes/twin.md'), note('notes/twin')); } },
  spelling: { arrange: async (_engine, root) => { writeFileSync(join(root, 'notes/Case.md'), note('Upper')); writeFileSync(join(root, 'notes/case.md'), note('Lower')); } },
  identity_differs: { arrange: async (_engine, root) => { git(root, 'rm', '-q', 'notes/Kept Doc.md'); writeFileSync(join(root, 'notes/kept-doc.md'), note('Another document', 'Another.', 'id: kept-two\n')); } },
};
const roundOneWrites = (root: string) => {
  writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'An edited body of notes/a.'));
  git(root, 'mv', 'notes/b.md', 'notes/b-moved.md');
  writeFileSync(join(root, 'notes/new.md'), note('notes/new'));
};

afterEach(() => installFaultHook(undefined));

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  const brain = (run: Parameters<typeof managedBrain>[0], seed: (b: { root: string }) => void = setup) => managedBrain(run, { ...(databaseUrl ? { databaseUrl } : {}), setup: seed });
  describe(`#6712 PR 4b round-2 narrowing (${backend})`, () => {
    for (const [name, { arrange }] of Object.entries(CASES)) {
      test(`${name}: a narrowed round is the level a full read gives`, () => brain(async ({ engine, root }) => {
        expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
        await arrange(engine, root);
        roundOneWrites(root);
        commit(root, name);
        const run = await compared(engine);
        expect(run.status).toBe('synced');
        expect(narrowed(run).length).toBeGreaterThan(0);
        expect(run.rounds.every(round => round.same)).toBe(true);
      }), 240_000);
    }

    test('the seeded mix: each narrowed round is the level a full read gives', () => brain(async ({ engine, ctx, root }) => {
      await seedMix({ engine, ctx, root });
      const run = await compared(engine);
      expect(narrowed(run).length).toBeGreaterThan(0);
      expect(run.rounds.every(round => round.same)).toBe(true);
    }, mixSetup), 600_000);

    // The comparison's own guard: one of the mix's open writes, held before it publishes, is let go right after the pass's
    // narrowed read of a round that saw it open. Without the hold on the round's open work it commits before the full read,
    // which then differs by that path's open work alone; with it, it commits once the comparison ended.
    test('the seeded mix: a write let go right after a narrowed read commits only after the comparison read', () => brain(async ({ engine, ctx, root }) => {
      await seedMix({ engine, ctx, root });
      const seeded = (await engine.executeRaw<{ id: string }>("SELECT request_id::text AS id FROM persistence_requests WHERE source_id='default' AND state='queued'")).map(row => row.id);
      expect(seeded).toHaveLength(2);
      const stillOpen = async () => (await engine.executeRaw("SELECT 1 FROM persistence_requests WHERE request_id=ANY($1::uuid[]) AND state IN ('queued','running','recovering')", [seeded])).length > 0;
      let release: () => void = () => {}, released = 0;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const also: Hook = async (point, detail) => {
        if (point === 'consumer:prepared' && seeded.includes(detail.requestId ?? '')) { await gate; return; }
        if (point !== 'sync:level_read' || !detail.level?.confirm?.taken || released) return;
        if (!(detail.level.shadow as ShadowLevel).paths.some(entry => entry.state.openWork)) return;
        released = detail.round!;
        release();
        // Room for the released writes to commit before the comparison reads, as they would on a busy host.
        for (const until = Date.now() + 3_000; Date.now() < until && await stillOpen();) await new Promise(resolve => setTimeout(resolve, 50));
      };
      let run: Awaited<ReturnType<typeof compared>>;
      try { run = await compared(engine, { also }); } finally { release(); }
      expect(released).toBeGreaterThan(0);
      expect(run.rounds.find(round => round.round === released)).toMatchObject({ narrow: 'taken', same: true });
      expect(run.rounds.find(round => round.round === released)!.open.length).toBeGreaterThan(0);
      await waitFor(async () => !await stillOpen(), { timeoutMs: 60_000, label: 'the mix\'s open writes commit' });
    }, mixSetup), 600_000);

    // A kept entry is re-checked against this round's open work (sync-pass.ts `keptUnread`): no patched origin names it.
    test('open work admitted between rounds on an untouched matched path: the narrowed round classifies it again, as a full read does', () => brain(async ({ engine, ctx, root }) => {
      await engine.setConfig('sync.write_through', 'false');
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      roundOneWrites(root);
      commit(root, 'open work');
      let open = null as string | null, release: () => void = () => {};
      const parked = new Promise<void>(resolve => { release = resolve; });
      const also: Hook = async (point, detail) => {
        if (point === 'sync:round_start' && detail.round === 2 && !open) {
          // An agent's write of notes/c (unchanged in Git and in the database, `matched` in round 1), admitted and unpublished.
          const current = (await engine.readPageSnapshot('notes/c', { sourceId: 'default' }))!;
          const prepared = await preparePageAdmission(ctx, { operation: 'put_page', params: { slug: 'notes/c', request_id: crypto.randomUUID(), expected_revision: current.revision, content: note('notes/c', 'An agent edit in flight.') } });
          open = (await admitWrite(engine, prepared.admission!)).request_id;
        }
        if (point === 'consumer:prepared' && detail.requestId === open) await parked;
      };
      let run: Awaited<ReturnType<typeof compared>>;
      try { run = await compared(engine, { also }); } finally { release(); }
      expect(open).not.toBeNull();
      const round2 = run.rounds.find(round => round.round === 2);
      expect(round2).toMatchObject({ narrow: 'taken', same: true });
      expect(round2!.open).toEqual(['notes/c.md']);
      await waitFor(async () => (await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [open]))[0]?.state === 'committed',
        { timeoutMs: 30_000, label: 'the agent write of notes/c commits' });
    }), 240_000);

    // A marker another writer adds between rounds is a foreign checkpoint write: the confirm round declines it, so no
    // narrowed round reads a marker the previous round did not (the pass's own markers come with the pages it deletes).
    test('a deletion marker written between rounds on an untouched origin: round 2 reads whole', () => brain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      roundOneWrites(root);
      commit(root, 'marker');
      const page = (await engine.readPageSnapshot('notes/c', { sourceId: 'default' }))!;
      let wrote = false;
      const run = await compared(engine, { also: async (point, detail) => {
        if (point !== 'sync:round_start' || detail.round !== 2 || wrote) return;
        wrote = true;
        await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => writeOriginDeletedMarker(tx, { sourceId: 'default', page: { id: Number(page.page.id), slug: 'notes/c', source_path: 'notes/c.md' } }), TEST_WRITE_ATTRIBUTION));
      } });
      expect(wrote).toBe(true);
      expect(run.confirms.find(verdict => verdict.round === 2)).toEqual({ round: 2, taken: false, reason: 'foreign_checkpoint_write' });
      expect(run.rounds).toEqual([]);
    }), 240_000);

    test('a refused patch builds the domain whole, says so in confirm, and gives the same level', () => brain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      roundOneWrites(root);
      commit(root, 'forced');
      const run = await compared(engine, { force: true });
      expect(run.status).toBe('synced');
      expect(run.rounds.length).toBeGreaterThan(0);
      expect(run.rounds.map(round => [round.narrow, round.same])).toEqual(run.rounds.map(() => ['forced', true]));
    }), 240_000);
  });
}
