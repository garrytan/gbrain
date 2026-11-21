/**
 * BrainEngine parity — `gbrain repair frontmatter` over held files of deleted and purged pages (LC-2, decision E1).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a managed Git source, a file held `file_drift` (side `deleted`) because its page was purged or
 *    soft-deleted is `needs_review` with its hold's own fix (the `gbrain repair file-drift --held --side deleted`
 *    preview, which asks the user first), never a `safe` "Import <path> as it is now" change; the preview selects
 *    nothing, and neither page comes back. Every engine arm returns the same holds, classes and pages.
 *  - Regression: the repair classed such holds `safe` and its apply restored the soft-deleted page and re-created the
 *    purged one (LC-2 in docs/research/gbrain-behavior-audit.md), past the file-drift consent step.
 *  - Why existing coverage misses it: test/repair-frontmatter.test.ts checks each SQL arm against fixed expectations,
 *    never one arm against another, and has no Rust arm.
 *  - Seam: none. Real managed sync, the delete intent and the repair preview, as the CLI runs them.
 *
 * Rust arm (known stop, pinned by name): managed sync, the delete intent and the repair read and write their rows
 * through `executeRaw` (the persistence journal, sync holds and deletion markers in `op_checkpoints`,
 * src/core/repair/frontmatter.ts), which the Rust engine refuses with `engine_capability_missing` naming `raw_sql`.
 * The case's first engine call is that raw SQL, so on Rust it ends on the refusal; the harness fails the arm if it
 * ever returns instead (then it must return what PGLite returns). Owner: the Rust persistence and repair members
 * (typed sync-hold, deletion-marker and page-state reads for `src/core/repair/`).
 */
import { describe, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { runPersistenceEffects } from '../../src/core/persistence/effects.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { performManagedSync } from '../../src/core/persistence/sync-run.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { readGitSourceHolds } from '../../src/core/persistence/sync-holds.ts';
import { resolveRepairScope } from '../../src/core/repair/core.ts';
import { repairRunner } from '../../src/core/repair/registry.ts';
import type { FrontmatterPreviewDetails } from '../../src/core/repair/frontmatter.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

const { parityTest } = parityArms(testBackends());

const SOURCE = 'lc2-notes';
const quiet = { info() {}, warn() {}, error() {} };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string, body: string) => `---\ntitle: ${title}\n---\n${body}\n`;

async function gitEffectsSettled(engine: BrainEngine): Promise<void> {
  for (let i = 0; i < 100; i++) {
    await runPersistenceEffects(engine, { engine: engine.kind }, { hostId: localHostId(), limit: 10 });
    if (!(await engine.executeRaw("SELECT 1 FROM persistence_effects WHERE source_id=$1 AND kind='git' AND state<>'committed'", [SOURCE])).length) return;
    await Bun.sleep(100);
  }
  throw new Error('git effects did not settle');
}

describe('engine parity: repair frontmatter over deleted-page holds', () => {
  parityTest(
    'held files of a purged and a soft-deleted page are needs_review for repair file-drift, and the preview brings neither back',
    { methods: ['executeRaw', 'readPageSnapshot'], timeout: 240_000 },
    async (engine) => {
      const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-lc2-'));
      try {
        return await withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined }, async () => {
          try {
            const root = join(home, SOURCE);
            mkdirSync(join(root, 'notes'), { recursive: true });
            git(root, 'init', '-q');
            git(root, 'config', 'user.name', 'Example'); git(root, 'config', 'user.email', 'example@example.invalid');
            writeFileSync(join(root, '.git', 'hooks', 'post-commit'), '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\n');
            chmodSync(join(root, '.git', 'hooks', 'post-commit'), 0o755);
            writeFileSync(join(root, 'notes', 'ivy.md'), note('Ivy', 'Ivy private note. Okapi keyword.'));
            writeFileSync(join(root, 'notes', 'jon.md'), note('Jon', 'Jon note.'));
            commit(root, 'fixture');
            // Rust stops here: raw_sql (see the header).
            await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
            await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [SOURCE, root]);
            await claimWorktree(engine, SOURCE, root);
            await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
            const sync = () => performManagedSync(engine, { sourceId: SOURCE, noPull: true, noEmbed: true, noExtract: true });
            await sync();
            const ctx = { engine, config: { engine: engine.kind }, logger: quiet, dryRun: false, remote: false, sourceId: SOURCE } as unknown as OperationContext;
            for (const [slug, purge] of [['notes/ivy', true], ['notes/jon', false]] as const) {
              const snapshot = (await engine.readPageSnapshot(slug, { sourceId: SOURCE, includeDeleted: true }))!;
              await submitPageMutation(ctx, { operation: 'delete_page',
                params: { slug, source_id: SOURCE, request_id: randomUUID(), expected_revision: snapshot.revision, ...(purge ? { purge: true } : {}) }, waitMs: 30_000 });
              await gitEffectsSettled(engine);
            }
            writeFileSync(join(root, 'notes', 'ivy.md'), note('Ivy', 'Ivy private note. Okapi keyword.\none more line'));
            writeFileSync(join(root, 'notes', 'jon.md'), note('Jon', 'Jon note.\none more line'));
            commit(root, 'restore with an edit');
            await sync();
            const holds = ((await readGitSourceHolds(engine, { sourceIds: [SOURCE] }))[0]?.holds ?? []).map(hold => [hold.path, hold.code, hold.meta.state ?? null]).sort();
            const runner = await repairRunner(engine, { apply: false, noEmbed: true, logger: quiet });
            const preview = await runner.run('frontmatter', await resolveRepairScope(engine, SOURCE), { explicit: true, sourceFlag: SOURCE, includeAmbiguous: true });
            const details = preview.details as unknown as FrontmatterPreviewDetails;
            const result = {
              holds,
              counts: details.counts,
              review: details.needs_review.map(entry => ({ path: entry.path, code: entry.code,
                routed: entry.resolution.includes(`gbrain repair file-drift --source ${SOURCE} --held --side deleted --state ${entry.path === 'notes/ivy.md' ? 'purged_differs' : 'tombstone_edited'} --only ${entry.path}`) })),
              ivy: await engine.readPageSnapshot('notes/ivy', { sourceId: SOURCE, includeDeleted: true }),
              jonDeleted: !!(await engine.readPageSnapshot('notes/jon', { sourceId: SOURCE, includeDeleted: true }))?.page.deleted_at,
            };
            expect(result).toEqual({
              holds: [['notes/ivy.md', 'file_drift', 'purged_differs'], ['notes/jon.md', 'file_drift', 'tombstone_edited']],
              counts: { safe: 0, interpretive: 0, interpretive_pending: 0, needs_review: 2 },
              review: [{ path: 'notes/ivy.md', code: 'file_drift', routed: true }, { path: 'notes/jon.md', code: 'file_drift', routed: true }],
              ivy: null, jonDeleted: true,
            });
            return result;
          } finally { await disposePersistenceConsumer(engine); }
        });
      } finally { rmSync(home, { recursive: true, force: true }); }
    },
  );
});
