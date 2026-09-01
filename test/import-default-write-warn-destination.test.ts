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
