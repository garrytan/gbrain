/**
 * scripts/release-channel.ts: bring published releases in line with "stable is GitHub's Latest", or take it out.
 *
 * Protects: the backfill marks only releases newer than stable as pre-releases and makes stable Latest with rolled-up
 * notes; undo clears every pre-release and makes the newest release Latest; both write nothing without --apply; the
 * promotion preview writes nothing and shows the notes promote-stable.ts would write.
 */
import { describe, expect, test } from 'bun:test';
import { planBackfill, planUndo, run, type ReleaseDeps, type ReleaseRow } from '../../scripts/release-channel.ts';
import { renderTagMessage, rolledUpNotes } from '../../scripts/promote-stable.ts';

const REPO = 'garrytan/gbrain';
const row = (id: number, version: string, prerelease = false, draft = false): ReleaseRow => ({ id, tag_name: `v${version}`, draft, prerelease });
const RELEASES = [row(5, '1.0.5'), row(4, '1.0.4', true), row(3, '1.0.3'), row(2, '1.0.2'), row(1, '1.0.1'), row(9, '1.0.6', false, true), { id: 8, tag_name: 'nightly', draft: false, prerelease: false }];
const CHANGELOG = ['## [1.0.5] - d', 'five', '## [1.0.4] - d', 'four', '## [1.0.3] - d', 'three', '## [1.0.2] - d', 'two', '## [1.0.1] - d', 'one', ''].join('\n');

function fakeDeps(stable = '1.0.3', previous: string | null = '1.0.1', rollback = false, latest = `v${stable}`) {
  const logs: string[] = [];
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  let reads = 0;
  const messageFor = (v: string) => renderTagMessage({ version: v, commit: 'a'.repeat(40), tree: 'b'.repeat(40), soakRun: 'https://example.com/run', scoreboard: 'https://example.com/run', promotedBy: 'alice-example', promotedAt: '2026-11-14T00:00:00Z', previous, rollback, reason: rollback ? 'regression' : '' });
  const deps: ReleaseDeps = {
    repo: REPO,
    async ghApi(path) {
      if (path.endsWith('/git/ref/tags/stable')) return { object: { sha: 'c'.repeat(40), type: 'tag' } };
      if (path.includes('/git/tags/')) return { message: messageFor(reads++ === 0 ? stable : f.movedTo ?? stable) };
      if (path.endsWith('/releases/latest')) return { tag_name: latest };
      if (path.includes('/releases?')) return path.endsWith('page=1') ? RELEASES : [];
      throw new Error(`unexpected api ${path}`);
    },
    async ghApiWrite(_method, path, body) { writes.push({ path, body }); return {}; },
    async git(args) { return args[0] === 'show' ? { code: 0, stdout: CHANGELOG, stderr: '' } : { code: 0, stdout: '', stderr: '' }; },
    log: line => logs.push(line),
  };
  const f: { deps: ReleaseDeps; logs: string[]; writes: typeof writes; movedTo?: string } = { deps, logs, writes };
  return f;
}

describe('plans', () => {
  test('backfill marks only non-pre-release releases newer than stable, and makes stable Latest', () => {
    expect(planBackfill(RELEASES, '1.0.3')).toEqual({ latest: { id: 3, version: '1.0.3' }, markPrerelease: [{ id: 5, version: '1.0.5' }], olderUntouched: 2 });
    expect(planBackfill(RELEASES, '1.0.9').latest).toBeNull();
  });

  test('undo clears every pre-release and makes the newest published release Latest', () => {
    expect(planUndo(RELEASES)).toEqual({ latest: { id: 5, version: '1.0.5' }, clearPrerelease: [{ id: 4, version: '1.0.4' }] });
  });
});

describe('run', () => {
  test('backfill without --apply prints the plan and writes nothing', async () => {
    const f = fakeDeps();
    await run(f.deps, ['backfill']);
    expect(f.writes).toEqual([]);
    expect(f.logs).toContain('mark pre-release: 1 (v1.0.5)');
    expect(f.logs.some(l => l.startsWith('mark Latest: v1.0.3 (notes rolled up'))).toBe(true);
  });

  test('backfill --apply makes stable Latest with rolled-up notes first, then marks the newer releases pre-release', async () => {
    const f = fakeDeps();
    await run(f.deps, ['backfill', '--apply']);
    expect(f.writes).toEqual([
      { path: `repos/${REPO}/releases/3`, body: { prerelease: false, make_latest: 'true', body: rolledUpNotes(CHANGELOG, '1.0.1', '1.0.3', REPO) } },
      { path: `repos/${REPO}/releases/5`, body: { prerelease: true, make_latest: 'false' } },
    ]);
  });

  test('backfill refuses while GitHub\'s Latest is newer than stable, and writes nothing if stable moves mid-run', async () => {
    const ahead = fakeDeps('1.0.3', '1.0.1', false, 'v1.0.5');
    await expect(run(ahead.deps, ['backfill', '--apply'])).rejects.toThrow(/GitHub's Latest is v1\.0\.5, newer than stable v1\.0\.3\. Backfilling now would move Latest back.*Would mark pre-release: 1 \(v1\.0\.5\)/);
    expect(ahead.writes).toEqual([]);
    const moved = fakeDeps();
    moved.movedTo = '1.0.5';
    await expect(run(moved.deps, ['backfill', '--apply'])).rejects.toThrow(/stable moved while the plan was being built/);
    expect(moved.writes).toEqual([]);
  });

  test('backfill keeps a rollback stable\'s notes', async () => {
    const f = fakeDeps('1.0.3', '1.0.5', true);
    await run(f.deps, ['backfill', '--apply']);
    expect(f.writes[0]!.body).toEqual({ prerelease: false, make_latest: 'true' });
  });

  test('undo --apply clears pre-releases without making them Latest, then makes the newest Latest', async () => {
    const preview = fakeDeps();
    await run(preview.deps, ['undo']);
    expect(preview.writes).toEqual([]);
    const f = fakeDeps();
    await run(f.deps, ['undo', '--apply']);
    expect(f.writes).toEqual([
      { path: `repos/${REPO}/releases/4`, body: { prerelease: false, make_latest: 'false' } },
      { path: `repos/${REPO}/releases/5`, body: { prerelease: false, make_latest: 'true' } },
    ]);
  });

  test('preview-promotion shows the newest release\'s notes rolled up since stable and writes nothing', async () => {
    const f = fakeDeps();
    await run(f.deps, ['preview-promotion']);
    expect(f.writes).toEqual([]);
    expect(f.logs).toContain('promoting v1.0.5 would make it Latest with these notes (' + rolledUpNotes(CHANGELOG, '1.0.3', '1.0.5', REPO).length + ' characters):');
    expect(f.logs.join('\n')).toContain('Stable release v1.0.5: every change since the previous stable release, v1.0.3, newest first.');
    await expect(run(f.deps, ['preview-promotion', '--version', '1.0.2'])).rejects.toThrow(/not newer than the current stable v1\.0\.3/);
  });
});
