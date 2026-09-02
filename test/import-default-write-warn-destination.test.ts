/**
 * #4583 review fix — the unscoped-import default-write warning must key on
 * the REAL destination, not on the resolution tier.
 *
 * runImport only ADOPTS the resolver's answer for tier `sole_non_default`;
 * for `dotfile` / `local_path` / `brain_default` the resolution is
 * deliberately ignored and the write still lands in source 'default'. The
 * original #4583 warn fired only on tier `seed_default`, so exactly those
 * non-adopted tiers wrote to 'default' on a guarded brain with NO warning —
 * the user set `sources.default` (or a dotfile) and reasonably believed the
 * import was scoped.
 *
 * Hermetic PGLite in-memory; non-git temp dir (no bookmark side effects).
 */

import { describe, test, expect, beforeAll, afterAll, spyOn } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runImport } from '../src/commands/import.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // TWO non-default sources holding all the pages → assessDefaultWriteGuard
  // fires, and sole_non_default (tier 5.5) cannot (it needs exactly one).
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path) VALUES ('dept-x', 'dept-x', '/nonexistent/dept-x') ON CONFLICT DO NOTHING`,
  );
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path) VALUES ('dept-y', 'dept-y', '/nonexistent/dept-y') ON CONFLICT DO NOTHING`,
  );
  await importFromContent(engine, 'x/one', '---\ntype: note\ntitle: one\n---\n# one\n', { noEmbed: true, sourceId: 'dept-x' });
  await importFromContent(engine, 'y/one', '---\ntype: note\ntitle: two\n---\n# two\n', { noEmbed: true, sourceId: 'dept-y' });
  // Tier 5 (brain_default) resolves to dept-x — a tier runImport does NOT
  // adopt, so the import below still writes to 'default'.
  await engine.setConfig('sources.default', 'dept-x');
});

afterAll(async () => {
  await engine.disconnect();
});

describe('unscoped import warns when the write actually lands in default (#4583 review fix)', () => {
  test('brain_default tier (not adopted) still warns because the destination is default', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-import-warn-dest-'));
    writeFileSync(join(dir, 'note.md'), '---\ntype: note\ntitle: n\n---\n# n\n\nbody\n');

    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    let errOut = '';
    try {
      await runImport(engine, [dir, '--no-embed', '--json']);
      errOut = errSpy.mock.calls.flat().filter((x) => typeof x === 'string').join('\n');
    } finally {
      errSpy.mockRestore();
    }

    // The page really landed in 'default' (runImport does not adopt the
    // brain_default resolution — pinned so a future adopt-change re-decides
    // this warn's keying consciously).
    const rows = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM pages WHERE slug = 'note' ORDER BY source_id`,
    );
    expect(rows.map((r) => r.source_id)).toContain('default');

    // ...and the operator was told about it.
    expect(errOut).toMatch(/writing to source 'default' on a multi-source brain/);
  });
});

// Ship-review gaps (#4583): the advisory's escape hatches and its pure
// seed_default arm, on the same guarded brain (2 non-default sources hold the
// bulk; assessDefaultWriteGuard fires).
describe('unscoped import advisory — escapes and the pure seed_default tier (#4583)', () => {
  const WARN = /writing to source 'default' on a multi-source brain/;

  async function importCapturingStderr(args: string[]): Promise<string> {
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runImport(engine, args);
      return errSpy.mock.calls.flat().filter((x) => typeof x === 'string').join('\n');
    } finally {
      errSpy.mockRestore();
    }
  }

  async function sourcesHolding(slug: string): Promise<string[]> {
    const rows = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM pages WHERE slug = $1 AND deleted_at IS NULL ORDER BY source_id`, [slug],
    );
    return rows.map((r) => r.source_id);
  }

  test('GBRAIN_ALLOW_DEFAULT_WRITE=1 silences the advisory (the write still lands in default)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-import-warn-allow-'));
    writeFileSync(join(dir, 'allowed.md'), '---\ntype: note\ntitle: allowed\n---\n# allowed\n\nbody\n');
    let errOut = '';
    await withEnv({ GBRAIN_SOURCE: undefined, GBRAIN_ALLOW_DEFAULT_WRITE: '1' }, async () => {
      errOut = await importCapturingStderr([dir, '--no-embed', '--json']);
    });
    expect(errOut).not.toMatch(WARN);
    expect(await sourcesHolding('allowed')).toEqual(['default']);
  });

  test('an explicit --source-id never warns and routes the write to that source', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-import-warn-explicit-'));
    writeFileSync(join(dir, 'explicit.md'), '---\ntype: note\ntitle: explicit\n---\n# explicit\n\nbody\n');
    let errOut = '';
    await withEnv({ GBRAIN_SOURCE: undefined, GBRAIN_ALLOW_DEFAULT_WRITE: undefined }, async () => {
      errOut = await importCapturingStderr([dir, '--no-embed', '--json', '--source-id', 'dept-x']);
    });
    expect(errOut).not.toMatch(WARN);
    expect(await sourcesHolding('explicit')).toEqual(['dept-x']);
  });

  test('the pure seed_default tier (no sources.default, no dotfile, 2+ sources) still warns', async () => {
    // Drop the brain_default pin the file-level beforeAll set, so the
    // resolver falls all the way through to seed_default.
    await engine.executeRaw(`DELETE FROM config WHERE key = 'sources.default'`);
    try {
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-import-warn-seed-'));
      writeFileSync(join(dir, 'seeded.md'), '---\ntype: note\ntitle: seeded\n---\n# seeded\n\nbody\n');
      let errOut = '';
      await withEnv({ GBRAIN_SOURCE: undefined, GBRAIN_ALLOW_DEFAULT_WRITE: undefined }, async () => {
        errOut = await importCapturingStderr([dir, '--no-embed', '--json']);
      });
      expect(errOut).toMatch(WARN);
      expect(errOut).toContain('--source-id');
      expect(await sourcesHolding('seeded')).toEqual(['default']);
    } finally {
      await engine.setConfig('sources.default', 'dept-x');
    }
  });
});
