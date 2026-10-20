/**
 * #6712 PR 4b ruling 3 (memory at 600k): a level keeps a `matched` path whose state is the converged one in a compact
 * entry and rebuilds its `SyncPathState` on read (sync-pass.ts `MatchedPath`), instead of a full state per path.
 *
 * Protects: the rebuilt state is the one the level read classified: its blob is the file's committed blob, its page
 * revision and record revision are the page's, and it classifies to the entry's result; a path whose state is not the
 * converged one (here an edited file) keeps its full state. A real PGLite managed brain and a real Git level.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifySyncPath } from '../src/core/persistence/sync-classify.ts';
import { readShadowLevel } from '../src/core/persistence/sync-pass.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (slug: string, body: string) => `---\ntype: concept\ntitle: ${slug}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setup = ({ root }: { root: string }) => {
  git(root, 'init', '-q');
  for (const name of ['a', 'b', 'c']) writeFileSync(join(root, `${name}.md`), note(name, `The committed body of ${name}.`));
  commit(root, 'notes');
};

describe('#6712 PR 4b: a compact matched entry rebuilds the state it was classified on', () => {
  test('converged paths read back their blob, page and record; an edited path keeps its own state', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    writeFileSync(join(root, 'c.md'), note('c', 'An edited body of c.'));
    commit(root, 'edit c');

    const level = (await readShadowLevel(engine, { sourceId: 'default' }))!;
    const pages = new Map((await engine.executeRaw<{ slug: string; revision: string }>("SELECT slug, knowledge_revision::text AS revision FROM pages WHERE source_id='default'"))
      .map(row => [row.slug, row.revision]));
    for (const name of ['a', 'b']) {
      const entry = level.paths.find(path => path.path === `${name}.md`)!;
      const blob = git(root, 'rev-parse', `HEAD:${name}.md`);
      expect(entry.result.cls).toBe('matched');
      // Compact: the entry stores no state of its own; the read below rebuilds it.
      expect(Object.keys(entry)).not.toContain('state');
      expect(entry.revision).toBe(pages.get(name)!);
      expect(entry.state).toEqual({ mode: 'committed', tree: blob, level: blob, present: true, dirty: 'clean', diskOid: null,
        page: { live: true, revision: pages.get(name)!, originMatches: true }, record: { blobOids: [blob, blob], revision: pages.get(name)!, parserSame: true },
        attested: null, levelSha256: null, published: false, hold: null, marker: null, baseline: null, spelling: false, episodeUnsatisfied: false,
        fullObligation: false, keepDb: false, openWork: false });
    }
    const edited = level.paths.find(path => path.path === 'c.md')!;
    expect(edited.result.cls).not.toBe('matched');
    expect(Object.keys(edited)).toContain('state');
    expect(edited.state.level).toBe(git(root, 'rev-parse', 'HEAD:c.md'));
    for (const entry of level.paths) expect(classifySyncPath(entry.state)).toEqual({ ...entry.result });
  }, { setup }));
});
