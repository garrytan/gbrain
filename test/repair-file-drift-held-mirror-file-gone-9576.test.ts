/**
 * #9576: a page an import stored while its source was a read-only mirror (`mirror_read_only`, no recorded file) whose
 * file a commit later removed is held by sync as `file_gone`. liveFileDrift reads its missing file as `database_only`
 * (still_present false), which the held loop of `repair file-drift` compared against `canonical_file_missing` only, so
 * every such hold listed `side_changed` forever and no preview could resolve it.
 * Protects: the held file_gone stale-mirror page is never side_changed ("its file is present now"); it reaches the file-gone check.
 * Real PGLite, real managed syncs and real Git.
 */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { RECOVERY_VERSION } from '../src/core/markdown.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const logger = { info() {}, warn() {}, error() {} };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const SLUG = 'notes/gone-example';

const run = async (engine: BrainEngine, prefer: 'file' | 'database') => (await repairRunner(engine, { apply: false, logger }))
  .run('file-drift', await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default', held: true, side: 'deleted', state: 'file_gone', prefer });

test('a held file_gone page imported while its source was a read-only mirror is not side_changed', () => managedBrain(async ({ engine, root }) => {
  expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
  // An older mirror import: stamped mirror_read_only with no recorded file, no import record, last written before the deleting commit.
  const coordinated = (sql: string, params: unknown[]) => engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(sql, params), TEST_WRITE_ATTRIBUTION));
  await coordinated(`DELETE FROM op_checkpoints WHERE op='sync-import-provenance'
    AND completed_keys->0->>'page_id' IN (SELECT id::text FROM pages WHERE source_id='default' AND slug=$1)`, [SLUG]);
  await coordinated(`UPDATE pages SET database_only_reason='mirror_read_only', source_path=NULL, knowledge_revision=$1::uuid, revision_write_request_id=NULL,
    updated_at=now() - interval '1 hour' WHERE source_id='default' AND slug=$2`, [randomUUID(), SLUG]);
  git(root, 'rm', '-q', '--', `${SLUG}.md`); git(root, 'commit', '-qm', 'remove the note');
  // The hold sync records for such a page (its import origin): a deleted-side file_drift hold in state file_gone.
  const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
  const live = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!;
  await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation: source!.incarnation, path: `${SLUG}.md`, source_path: `${SLUG}.md`, slug: SLUG,
    page_id: Number(live.page.id), code: 'file_drift', message: 'held: file drift (deleted file_gone)', upstream_version: null, observed_at: new Date().toISOString(),
    run_id: null, mode: 'managed', meta: { recovery_version: RECOVERY_VERSION, side: 'deleted', state: 'file_gone', page_revision: live.revision } }));
  for (const prefer of ['file', 'database'] as const) {
    const preview = await run(engine, prefer);
    expect((preview.listing ?? []).map(entry => entry.class)).not.toContain('side_changed');
    expect(preview.residuals).not.toHaveProperty('side_changed');
  }
}, { setup: ({ root }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  writeFileSync(join(root, `${SLUG}.md`), '---\ntype: concept\ntitle: Gone\n---\n\nThe committed body.\n');
  writeFileSync(join(root, 'notes/kept-example.md'), '---\ntype: concept\ntitle: Kept\n---\n\nStays.\n');
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'notes');
} }), 300_000);
