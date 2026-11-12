/**
 * GST-2515: since the file-drift screen version moved to 2 (#7199), every unknown-side file_drift hold written under version 1
 * is screened once more, and that screen reads each held path's earlier committed versions. It read them one Git process per
 * path and reported nothing while it ran, so a source with thousands of such holds sat silent past the drain's no-progress
 * window: the pass was stopped (drain_stalled) before any hold was stamped, and every later pass repeated the same reads.
 * The reads now run batched and report each path they finish; a pass stopped partway keeps the holds it re-screened.
 */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { hardenedGitStream } from '../src/core/hardened-git.ts';
import { RECOVERY_VERSION } from '../src/core/markdown.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { engineStallProbe, runDrain } from '../src/core/persistence/sync-drain.ts';
import { __setSyncGitStreamForTests } from '../src/core/persistence/sync-git-stream.ts';
import { FILE_DRIFT_VERSION, writeGitHold } from '../src/core/persistence/sync-holds.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid',
  '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const note = (slug: string, body: string) => '---\ntype: concept\ntitle: ' + slug + '\n---\n\n' + body + '\n';
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const HOLDS = 60;
const slugs = Array.from({ length: HOLDS }, (_, i) => 'notes/n' + String(i).padStart(3, '0'));

const versions = async (engine: BrainEngine) => (await engine.executeRaw<{ v: number | null }>(
  "SELECT (completed_keys->0->'meta'->>'drift_version')::int AS v FROM op_checkpoints WHERE op='sync-hold' AND completed_keys->0->>'code'='file_drift'"))
  .reduce((tally, { v }) => ({ ...tally, ['v' + (v ?? 0)]: (tally['v' + (v ?? 0)] ?? 0) + 1 }), {} as Record<string, number>);

/** Every page drifted on both sides with no import record, each held by the version-1 screen: the holds an older gbrain left. */
async function versionOneHolds(engine: BrainEngine, root: string): Promise<void> {
  await performManagedSync(engine, OPTS);
  const coordinated = (sql: string) => engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw(sql), TEST_WRITE_ATTRIBUTION));
  await coordinated("DELETE FROM op_checkpoints WHERE op='sync-import-provenance'");
  await coordinated("UPDATE pages SET compiled_truth = compiled_truth || ' Edited in the database.', knowledge_revision = gen_random_uuid(), revision_write_request_id = NULL WHERE source_id='default'");
  for (const slug of slugs) writeFileSync(join(root, slug + '.md'), note(slug, 'A Git edit of ' + slug + '.'));
  git(root, 'commit', '-qam', 'edit');
  const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation::text AS incarnation FROM sources WHERE id='default'");
  for (const slug of slugs) {
    const path = slug + '.md', page = (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!;
    await engine.transaction(tx => writeGitHold(tx, { source_id: 'default', incarnation, path, source_path: path, slug, page_id: Number(page.page.id), code: 'file_drift',
      message: path + ': page ' + slug + ' differs from its file and has no import record', upstream_version: null, observed_at: new Date().toISOString(), run_id: null,
      mode: 'managed', meta: { recovery_version: RECOVERY_VERSION, sides: 'unknown', side: 'unknown', drift_version: 1, blob_oid: git(root, 'rev-parse', 'HEAD:' + path), page_revision: page.revision } }));
  }
  expect(await versions(engine)).toEqual({ v1: HOLDS });
}

/** Each history read (a cat-file of <commit>~k:<path> specs) takes delayMs longer, as one does on a deep history; counts the paths read. */
function slowHistoryReads(delayMs: number): { paths: () => number } {
  let paths = 0;
  __setSyncGitStreamForTests(async (root, args, opts) => {
    if (args[0] !== 'cat-file' || opts.stdin === undefined || typeof opts.stdin === 'string' || Buffer.isBuffer(opts.stdin) || Symbol.asyncIterator in opts.stdin) return hardenedGitStream(root, args, opts);
    const stdin = [...opts.stdin as Iterable<Buffer | string>].map(line => line.toString());
    const specs = stdin.join('').split('\n').filter(Boolean);
    if (!specs.some(spec => /~\d+:/.test(spec))) return hardenedGitStream(root, args, { ...opts, stdin });
    paths += specs.filter(spec => /~0:/.test(spec)).length;
    await new Promise(resolve => setTimeout(resolve, delayMs));
    return hardenedGitStream(root, args, { ...opts, stdin });
  });
  return { paths: () => paths };
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const setup = ({ root }: { root: string }) => {
    mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
    for (const slug of slugs) writeFileSync(join(root, slug + '.md'), note(slug, 'The committed body of ' + slug + '.'));
    git(root, 'add', '-A'); git(root, 'commit', '-qm', 'notes');
  };

  test('[' + backend + '] the one-time re-screen of many version-1 drift holds reports progress and finishes under the no-progress window', () => managedBrain(async ({ engine, root }) => {
    await versionOneHolds(engine, root);
    const reads = slowHistoryReads(150);
    try {
      const result = await runDrain({ governMs: 25, noProgressMs: 3_000, publicationCeilingMs: 60_000, probe: engineStallProbe(engine, 'default'),
        pass: (signal, onProgress) => performManagedSync(engine, { ...OPTS, signal, onProgress }) });
      expect(result.drain?.stop_reason ?? null).toBeNull();
      expect(result.drain?.outcome).toBe('synced');
      expect(reads.paths()).toBe(HOLDS);
    } finally { __setSyncGitStreamForTests(); }
    expect(await versions(engine)).toEqual({ ['v' + FILE_DRIFT_VERSION]: HOLDS });
  }, { databaseUrl, setup }), 240_000);

  test('[' + backend + '] a re-screen stopped partway keeps the holds it stamped, and the next pass reads only the rest', () => managedBrain(async ({ engine, root }) => {
    await versionOneHolds(engine, root);
    const stop = new AbortController();
    let committed = 0;
    await performManagedSync(engine, { ...OPTS, signal: stop.signal, onProgress: (event: { phase?: string }) => {
      if (event.phase === 'managed_sync.page_committed' && ++committed === 20) stop.abort();
    } }).catch(() => undefined);
    const after = await versions(engine);
    const stamped = after['v' + FILE_DRIFT_VERSION] ?? 0;
    expect(stamped).toBeGreaterThanOrEqual(20);
    expect(stamped).toBeLessThan(HOLDS);
    expect(after.v1).toBe(HOLDS - stamped);
    const reads = slowHistoryReads(0);
    try { await performManagedSync(engine, OPTS); } finally { __setSyncGitStreamForTests(); }
    expect(reads.paths()).toBe(HOLDS - stamped);
    expect(await versions(engine)).toEqual({ ['v' + FILE_DRIFT_VERSION]: HOLDS });
  }, { databaseUrl, setup }), 240_000);
}
