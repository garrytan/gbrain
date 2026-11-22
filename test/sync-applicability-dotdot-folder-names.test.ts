/**
 * `syncContentDirectory` decides that sync does not apply to a gbrain-owned content directory
 * (`<GBRAIN_HOME>/.gbrain/content/<brain>/<source>`). It treated any path whose `relative()` from the content directory
 * starts with `..` as outside it, which also matches a brain folder named `..x`, so such a directory was not recognised
 * as gbrain-owned and sync went on to treat it as a Git source.
 * Protects: a source directory under `content/..x/` is recognised (owned by the content root), while a directory outside
 * the content directory, a sibling that shares its name prefix (`content2`), `../content` spelled out, the content
 * directory itself and a symlink under it that points outside are not.
 * Authoring gate: (1) whether sync is refused as not applicable for a gbrain-owned directory; (2) a startsWith('..')
 * check that is not component-aware; (3) sync-applicability.test.ts only uses a brain folder named `brain-example`; (4) no
 * seam, the exported function on in-memory PGLite with GBRAIN_HOME set through withEnv, as that test does.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { syncContentDirectory } from '../src/core/sync-applicability.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let home: string;

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-sync-dotdot-'))); });

const inHome = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home }, fn);
const dirAt = (...parts: string[]) => { const dir = join(home, ...parts); mkdirSync(dir, { recursive: true }); return dir; };

describe('syncContentDirectory and a brain folder named ..x', () => {
  test('a source directory under content/..x is a gbrain-owned content directory', () => inHome(async () => {
    const root = dirAt('.gbrain', 'content', '..x', 'default');
    expect(await syncContentDirectory(engine, { repoPath: root })).toMatchObject({ sourceId: 'default', root, ownedBy: 'content_root' });
    const second = dirAt('.gbrain', 'content', '..drafts', 'notes');
    expect(await syncContentDirectory(engine, { repoPath: second })).toMatchObject({ root: second, ownedBy: 'content_root' });
  }));

  test('an ordinary brain folder is recognised the same way (control)', () => inHome(async () => {
    const root = dirAt('.gbrain', 'content', 'brain-example', 'default');
    expect(await syncContentDirectory(engine, { repoPath: root })).toMatchObject({ root, ownedBy: 'content_root' });
  }));

  test('directories that are not under the content directory are not owned: outside, name-prefix sibling, ../content, the content directory itself, a symlink out', () => inHome(async () => {
    dirAt('.gbrain', 'content');
    const outside = dirAt('elsewhere', 'default');
    const symlinked = join(dirAt('.gbrain', 'content', 'brain-example'), 'linked');
    symlinkSync(outside, symlinked);
    for (const root of [outside, dirAt('.gbrain', 'content2', 'default'), join(dirAt('.gbrain', 'content', 'brain-example'), '..', '..', 'content2'),
      join(home, '.gbrain', 'content'), symlinked]) {
      expect(`${root}: ${JSON.stringify(await syncContentDirectory(engine, { repoPath: root }))}`).toBe(`${root}: null`);
    }
  }));
});
