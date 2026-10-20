/**
 * LPH (a): `gbrain repair segmented-mirror` re-mirrors the canonical file of a page stored in segments that an older
 * binary's withdrawal mirror passed by.
 *
 * 1. Protects: before v0.60.299.0 a purge or forget struck the row in a segmented page's segments but skipped its file
 *    (`page_body_segmented`), so the file kept the withdrawn row. The preview lists exactly the file-backed segmented
 *    pages whose file is such an older render (the mirror's own file/database check passes and the ledger still changes
 *    the file), with each file's SHA-256 and size beside the canonical render's, and a hash. It never lists a clean
 *    segmented page or an inline page, and it holds (never rewrites) a segmented file that also differs from the
 *    database for another reason (`file_database_drift`). `--apply --expect <hash>` rewrites each listed file through
 *    a withdrawal-mirror effect of its own receipted request: the file loses the row, is byte-identical to the page's
 *    `gbrain export` render, and the Git effect commits it. A second preview lists nothing; a second apply (the new
 *    hash, or the old one replayed) writes nothing. A hash no preview saved, or one whose file changed since, refuses
 *    with `preview_changed` before anything is admitted.
 * 2. Fails when: the kind does not exist (red before), the preview misses a stale file or lists a clean, inline or
 *    drifted one, the apply writes anything other than the export render, overwrites the drifted file, or a stale hash
 *    applies.
 * 3. PGLite always; PostgreSQL when DATABASE_URL is set. The older binary's on-disk state is modelled by writing each
 *    file's pre-withdrawal bytes back after the withdrawal committed and committing them to Git, which is exactly what
 *    the skipped mirror and Git walk left behind.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { OperationError } from '../../src/core/ops/contract.ts';
import { withVerifiedLocalRegistration } from '../../src/core/persistence/identity.ts';
import { resolveRepairScope, type RepairResult } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import { durableGitRepo, git, gitAsync } from '../helpers/git-publication.ts';
import { openTwinBrain, type TwinBrain } from '../helpers/segmented-twins.ts';
import { exported, fileOf, purge, settle } from '../helpers/segmented-withdrawal.ts';
import { withEnv } from '../helpers/with-env.ts';
import { pathologicalArms } from './harness.ts';

const STALE_PURGE = 'people/stale-purge-example';
const STALE_FORGET = 'people/stale-forget-example';
const CLEAN = 'people/clean-example';
const DRIFT = 'people/drift-example';
const INLINE = 'people/inline-example';
const SEGMENTED = [STALE_PURGE, STALE_FORGET, CLEAN, DRIFT];
const CLAIM: Record<string, string> = {
  [STALE_PURGE]: 'Mirror Example locker code is 4411', [STALE_FORGET]: 'Mirror Example bike lock is 4412', [CLEAN]: 'Mirror Example vault code is 4413',
  [DRIFT]: 'Mirror Example safe code is 4414', [INLINE]: 'Mirror Example gate code is 4415',
};
const KEPT = 'Mirror Example adopted a narwhalbot';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const quiet = { info() {}, warn() {}, error() {} };

async function extract(brain: TwinBrain, slug: string, facts: string[]) {
  brain.setChatReply(JSON.stringify({ facts: facts.map(fact => ({ fact, kind: 'fact', entity: slug, confidence: 1, notability: 'high' })) }));
  expect(await brain.call('extract_facts', { turn_text: 'Synthetic meeting record. ' + facts.join('. ') + '.', visibility: 'world', valid_from: '2026-10-15T00:00:00Z' }, slug))
    .toMatchObject({ inserted: facts.length });
}

for (const { backend: kind } of pathologicalArms()) {
  describe(kind + ': gbrain repair segmented-mirror re-mirrors files an older binary left holding withdrawn rows', () => {
    let brain: TwinBrain;
    const before: Record<string, Buffer> = {};

    const run = (apply: boolean, expectHash?: string): Promise<RepairResult> => withEnv(brain.env(), () => withVerifiedLocalRegistration(brain.engine, brain.cli, async () => {
      const scope = await resolveRepairScope(brain.engine, brain.sourceId);
      const runner = await repairRunner(brain.engine, { apply, logger: quiet });
      return runner.run('segmented-mirror', scope, { explicit: true, sourceFlag: brain.sourceId, ...(expectHash ? { expect: expectHash } : {}) });
    }));
    const remirrorRequests = async () => (await brain.engine.executeRaw<{ n: number }>(
      "SELECT count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND operation='repair_segmented_mirror'", [brain.sourceId]))[0]!.n;
    const files = () => Object.fromEntries([...SEGMENTED, INLINE].map(slug => [slug, readFileSync(fileOf(brain, slug))]));

    beforeAll(async () => {
      brain = await openTwinBrain(kind, [INLINE], async seed => {
        await seed.setSwitch(false);
        await seed.put(INLINE, 1_100_000);
        await seed.setSwitch(true);
        for (const slug of SEGMENTED) await seed.put(slug, 1_100_000);
      });
      for (const slug of [...SEGMENTED, INLINE]) await extract(brain, slug, [CLAIM[slug]!, KEPT]);
      await settle(brain, kind);
      expect(await Promise.all([...SEGMENTED, INLINE].map(slug => brain.storageOf(slug)))).toEqual(['segmented', 'segmented', 'segmented', 'segmented', 'inline']);
      durableGitRepo(brain.root, [...SEGMENTED, INLINE].map(slug => slug + '.md'));

      // The older binary: each withdrawal committed in the database, and its file (and Git) kept the pre-withdrawal bytes.
      for (const slug of [...SEGMENTED, INLINE]) before[slug] = readFileSync(fileOf(brain, slug));
      for (const slug of [STALE_PURGE, CLEAN, DRIFT, INLINE]) await purge(brain, kind, slug, CLAIM[slug]!);
      const [forgotten] = await brain.engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id=$1 AND source_markdown_slug=$2 AND fact=$3',
        [brain.sourceId, STALE_FORGET, CLAIM[STALE_FORGET]]);
      expect(await brain.call('forget_fact', { id: Number(forgotten!.id), request_id: randomUUID() }, STALE_FORGET)).toMatchObject({ state: 'committed' });
      await settle(brain, kind);
      for (const slug of [STALE_PURGE, STALE_FORGET, INLINE]) writeFileSync(fileOf(brain, slug), before[slug]!);
      // The drifted file also carries a local edit the database never saw.
      writeFileSync(fileOf(brain, DRIFT), before[DRIFT]!.toString('utf8').replace('00000007 acme-example journal line', '00000007 acme-example journal LINE edited by hand'));
      git(brain.root, 'add', '-A'); git(brain.root, 'commit', '-q', '-m', 'older binary state');
    }, 900_000);

    afterAll(() => brain.close(), 120_000);

    test('the seeded files are the older binary\'s: the withdrawn rows are still on disk though the database withdrew them', async () => {
      for (const slug of [STALE_PURGE, DRIFT, INLINE]) {
        expect(readFileSync(fileOf(brain, slug), 'utf8')).toContain(CLAIM[slug]!);
        expect(await brain.engine.executeRaw('SELECT 1 FROM facts WHERE source_id=$1 AND fact=$2', [brain.sourceId, CLAIM[slug]])).toEqual([]);
      }
      expect(readFileSync(fileOf(brain, STALE_FORGET)).equals(before[STALE_FORGET]!)).toBe(true);
      for (const slug of [STALE_PURGE, STALE_FORGET]) expect(readFileSync(fileOf(brain, slug)).equals(await exported(brain, slug))).toBe(false);
      expect(readFileSync(fileOf(brain, CLEAN), 'utf8')).not.toContain(CLAIM[CLEAN]!);
      expect(readFileSync(fileOf(brain, CLEAN)).equals(await exported(brain, CLEAN))).toBe(true);
    }, 300_000);

    test('preview lists exactly the stale segmented files, holds the drifted one and refuses a stale hash', async () => {
      const preview = await run(false);
      expect(preview.mode).toBe('dry_run');
      expect(preview.listing?.map(entry => entry.item)).toEqual([STALE_FORGET, STALE_PURGE].map(slug => `${brain.sourceId}:${slug}`));
      const stale = preview.details!.stale as Array<{ slug: string; path: string; file_sha256: string; file_bytes: number; expected_sha256: string; expected_bytes: number }>;
      for (const entry of stale) {
        const file = readFileSync(fileOf(brain, entry.slug)), render = await exported(brain, entry.slug);
        expect(entry).toMatchObject({ path: entry.slug + '.md', file_sha256: sha(file), file_bytes: file.length, expected_sha256: sha(render), expected_bytes: render.length });
      }
      expect((preview.details!.held as Array<{ slug: string; reason: string }>).map(entry => [entry.slug, entry.reason])).toEqual([[DRIFT, 'file_database_drift']]);
      expect(preview.preview_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(preview.apply_command).toContain(`--apply --expect ${preview.preview_hash} --yes`);

      // A hash no preview saved refuses before anything is admitted.
      const unknown = await run(true, 'f'.repeat(64)).then(() => null, error => error);
      expect(unknown).toBeInstanceOf(OperationError);
      expect((unknown as OperationError).code).toBe('preview_changed');
      // So does the previewed hash once a listed file changed since the preview.
      const snapshot = files();
      writeFileSync(fileOf(brain, STALE_PURGE), Buffer.concat([snapshot[STALE_PURGE]!, Buffer.from('\n')]));
      const changed = await run(true, preview.preview_hash).then(() => null, error => error);
      writeFileSync(fileOf(brain, STALE_PURGE), snapshot[STALE_PURGE]!);
      expect(changed).toBeInstanceOf(OperationError);
      expect((changed as OperationError).code).toBe('preview_changed');
      expect(await remirrorRequests()).toBe(0);
      for (const [slug, bytes] of Object.entries(files())) expect({ slug, same: bytes.equals(snapshot[slug]!) }).toEqual({ slug, same: true });
    }, 600_000);

    test('apply rewrites each listed file to its export render through the mirror, commits it, and is idempotent', async () => {
      const preview = await run(false);
      const untouched = { [DRIFT]: readFileSync(fileOf(brain, DRIFT)), [INLINE]: readFileSync(fileOf(brain, INLINE)), [CLEAN]: readFileSync(fileOf(brain, CLEAN)) };
      const applied = await run(true, preview.preview_hash);
      expect(applied.outcomes).toEqual({ mirrored: 2 });
      expect(applied.applied).toBe(2);
      expect(await remirrorRequests()).toBe(2);
      await settle(brain, kind);
      for (const slug of [STALE_PURGE, STALE_FORGET]) {
        const file = readFileSync(fileOf(brain, slug));
        expect(file.equals(await exported(brain, slug))).toBe(true);
        expect(file.toString('utf8')).toContain(KEPT);
        expect((await gitAsync(brain.root, 'log', '-1', '--format=%s', '--', slug + '.md')).trim()).toBe(`gbrain: re-mirror segmented page ${slug}`);
        expect(await gitAsync(brain.root, 'status', '--porcelain', '--', slug + '.md')).toBe('');
      }
      expect(readFileSync(fileOf(brain, STALE_PURGE), 'utf8')).not.toContain(CLAIM[STALE_PURGE]!);
      for (const [slug, bytes] of Object.entries(untouched)) expect({ slug, same: readFileSync(fileOf(brain, slug)).equals(bytes) }).toEqual({ slug, same: true });

      // A second preview lists nothing; applying its hash, or replaying the first one, writes nothing.
      const again = await run(false);
      expect(again.listing).toEqual([]);
      expect((again.details!.held as Array<{ slug: string }>).map(entry => entry.slug)).toEqual([DRIFT]);
      const snapshot = files();
      const empty = await run(true, again.preview_hash);
      expect(empty.applied).toBe(0);
      const replay = await run(true, preview.preview_hash);
      expect(replay.applied).toBe(0);
      expect(replay.outcomes).toEqual({ replayed: 2 });
      expect(await remirrorRequests()).toBe(2);
      for (const [slug, bytes] of Object.entries(files())) expect({ slug, same: bytes.equals(snapshot[slug]!) }).toEqual({ slug, same: true });
    }, 600_000);
  });
  describe(kind + ': a segmented-mirror apply whose file changes before its mirror runs refuses with preview_changed', () => {
    let brain: TwinBrain;
    const PAGE = 'people/held-mirror-example';
    const HELD_CLAIM = 'Mirror Example locker code is 5511';
    const run = (apply: boolean, expectHash?: string, env: Record<string, string> = {}): Promise<RepairResult> => withEnv({ ...brain.env(), ...env }, () => withVerifiedLocalRegistration(brain.engine, brain.cli, async () => {
      const scope = await resolveRepairScope(brain.engine, brain.sourceId);
      const runner = await repairRunner(brain.engine, { apply, logger: quiet });
      return runner.run('segmented-mirror', scope, { explicit: true, sourceFlag: brain.sourceId, ...(expectHash ? { expect: expectHash } : {}) });
    }));

    beforeAll(async () => {
      brain = await openTwinBrain(kind, [], async seed => { await seed.setSwitch(true); await seed.put(PAGE, 1_100_000); });
      await extract(brain, PAGE, [HELD_CLAIM, KEPT]);
      await settle(brain, kind);
      expect(await brain.storageOf(PAGE)).toBe('segmented');
      durableGitRepo(brain.root, [PAGE + '.md']);
      const stale = readFileSync(fileOf(brain, PAGE));
      await purge(brain, kind, PAGE, HELD_CLAIM);
      writeFileSync(fileOf(brain, PAGE), stale);
      git(brain.root, 'add', '-A'); git(brain.root, 'commit', '-q', '-m', 'older binary state');
      // The owner's consumer is held: the repair's effects are inserted unclaimable until the test releases them.
      await brain.engine.executeRaw(`CREATE OR REPLACE FUNCTION lp_a_hold_remirror() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF EXISTS (SELECT 1 FROM persistence_requests r WHERE r.id=NEW.request_id AND r.operation='repair_segmented_mirror') THEN
          NEW.next_attempt_at := now() + interval '1 day'; END IF; RETURN NEW; END $$`);
      await brain.engine.executeRaw('CREATE TRIGGER lp_a_hold_remirror BEFORE INSERT ON persistence_effects FOR EACH ROW EXECUTE FUNCTION lp_a_hold_remirror()');
    }, 900_000);

    afterAll(() => brain.close(), 120_000);

    test('a formatting-only edit made while the mirror waits is refused, not overwritten', async () => {
      const preview = await run(false);
      expect(preview.listing?.map(entry => entry.item)).toEqual([`${brain.sourceId}:${PAGE}`]);
      const applied = await run(true, preview.preview_hash, { GBRAIN_WRITE_WAIT_MS: '500' });
      expect(applied.outcomes).toEqual({ mirror_queued: 1 });

      // A formatting-only edit: the quoted title parses the same, so the mirror's own drift check still passes.
      const original = readFileSync(fileOf(brain, PAGE), 'utf8');
      const edited = original.replace(/^title: Twin Example$/m, "title: 'Twin Example'");
      expect(edited).not.toBe(original);
      writeFileSync(fileOf(brain, PAGE), edited);
      const head = (await gitAsync(brain.root, 'rev-parse', 'HEAD')).trim();

      await brain.engine.executeRaw('DROP TRIGGER lp_a_hold_remirror ON persistence_effects');
      await brain.engine.executeRaw(`UPDATE persistence_effects SET next_attempt_at=now() WHERE source_id=$1 AND state='queued'`, [brain.sourceId]);
      await settle(brain, kind);

      expect(readFileSync(fileOf(brain, PAGE), 'utf8')).toBe(edited);
      expect((await gitAsync(brain.root, 'rev-parse', 'HEAD')).trim()).toBe(head);
      const [mirror] = await brain.engine.executeRaw<{ state: string; skipped: unknown }>(`SELECT e.state, e.data->'skipped' AS skipped FROM persistence_effects e
        JOIN persistence_requests r ON r.id=e.request_id WHERE r.operation='repair_segmented_mirror' AND e.kind='withdrawal-mirror'`);
      expect({ state: mirror!.state, skipped: typeof mirror!.skipped === 'string' ? JSON.parse(mirror!.skipped) : mirror!.skipped })
        .toEqual({ state: 'committed', skipped: [{ slug: PAGE, reason: 'preview_changed' }] });

      // Replaying the apply reports the typed refusal with the preview as its fix; a new preview lists the page again.
      const replay = await run(true, preview.preview_hash);
      const refused = replay.outcome_items?.find(entry => entry.item === `${brain.sourceId}:${PAGE}`);
      expect(refused).toMatchObject({ outcome: 'refused', reason: 'preview_changed' });
      expect((refused!.detail!.fix as { argv: string[] }).argv).toEqual(['gbrain', 'repair', 'segmented-mirror', '--source', brain.sourceId, '--json']);
      const again = await run(false);
      expect(again.listing?.map(entry => entry.item)).toEqual([`${brain.sourceId}:${PAGE}`]);
      expect(again.preview_hash).not.toBe(preview.preview_hash);
    }, 600_000);
  });
}
