/**
 * #7880: the Google connector's database-only import (sync.write_through off, or a database-only slug) calls
 * `importFromContent` in google/sweep-shared.ts `importRendered`. That call opts into `holdNoncanonicalPrivate`, so a page
 * whose frontmatter asks for `visibility: private` in a spelling page privacy does not read is refused instead of stored
 * world-readable; `visibility: private` and pages that do not ask for private still import.
 *
 * Value: protects=Google database-only importRendered refuses a non-canonical private request and stores nothing; fails_when=holdNoncanonicalPrivate is dropped from that call;
 * why_new=no test drives importRendered's databaseOnly branch with such content; seam=none;
 * no_claim=GitHub connector opt-in (its pages render fixed frontmatter, no seam) and Postgres (PGLite only).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importRendered } from '../src/core/google/sweep-shared.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
let dir: string;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await resetPgliteState(engine);
  await engine.setConfig('sync.write_through', 'false');
  dir = mkdtempSync(join(tmpdir(), 'gbrain-google-7880-'));
}, 120_000);
afterAll(async () => {
  await engine.disconnect();
  rmSync(dir, { recursive: true, force: true });
});

const page = (visibility: string) => `---\ntype: note\ntitle: Example Event\n${visibility}\n---\n# Example Event\nA synthetic event for alice-example.\n`;
const run = (relPath: string, markdown: string) => {
  const deps = { engine, sourceId: 'default', cfg: { account: 'alice@example.com', dir }, opts: {}, log() {}, tick() {} } as never;
  const summary = { pagesAffected: [], chunksCreated: 0, added: 0, modified: 0 } as never;
  return importRendered(deps, relPath, markdown, undefined as never, summary, new Set());
};

describe('google connector database-only import holds a non-canonical private request (#7880)', () => {
  for (const [label, line] of [['capitalised key', 'Visibility: private'], ['capitalised value', 'visibility: Private']] as const) {
    test(`${label}: refused and no page stored`, async () => {
      const relPath = `calendar/held-${label.replace(' ', '-')}.md`;
      await expect(run(relPath, page(line))).rejects.toThrow(/visibility/i);
      expect(await engine.getPage(relPath.replace(/\.md$/, ''), { sourceId: 'default' })).toBeNull();
    }, 120_000);
  }

  test('visibility: private stores a private page, and a page that does not ask for private stores', async () => {
    const privateSlug = await run('calendar/kept-private.md', page('visibility: private'));
    expect((await engine.getPage(privateSlug, { sourceId: 'default' }))?.frontmatter.visibility).toBe('private');
    const plainSlug = await run('calendar/plain.md', page('owner: alice-example'));
    expect((await engine.getPage(plainSlug, { sourceId: 'default' }))?.title).toBe('Example Event');
  }, 120_000);
});
