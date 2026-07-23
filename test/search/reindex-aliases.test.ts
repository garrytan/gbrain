/**
 * T8 — `gbrain reindex --aliases` backfill. Seeds pages with frontmatter
 * aliases (as if imported before the T3 projection landed), runs the backfill,
 * and verifies page_aliases is populated. Idempotent + --dry-run + --source.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { runReindexAliases } from '../../src/commands/reindex-aliases.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

async function seed(slug: string, aliases: unknown) {
  await engine.putPage(slug, { type: 'note' as never, title: slug, compiled_truth: 'x', frontmatter: { aliases } });
}

describe('runReindexAliases', () => {
  test('backfills page_aliases from frontmatter for existing pages', async () => {
    await seed('projects/mingtang', ['Hall of Light', '明堂']);
    await seed('notes/plain', undefined); // no aliases

    const result = await runReindexAliases(engine, ['--json']);
    expect(result.pages_with_aliases).toBe(1);
    expect(result.aliases_written).toBe(2);

    const m = await engine.resolveAliases(['hall of light', '明堂'], { sourceId: 'default' });
    expect((m.get('hall of light') ?? []).map(r => r.slug)).toEqual(['projects/mingtang']);
    expect((m.get('明堂') ?? []).map(r => r.slug)).toEqual(['projects/mingtang']);
  });

  test('--dry-run writes nothing', async () => {
    await seed('p/x', ['some alias']);
    const result = await runReindexAliases(engine, ['--dry-run', '--json']);
    expect(result.dry_run).toBe(true);
    expect(result.aliases_written).toBe(1); // would-write count
    const m = await engine.resolveAliases(['some alias'], { sourceId: 'default' });
    expect(m.size).toBe(0); // nothing actually written
  });

  test('idempotent: second run converges, no duplicates', async () => {
    await seed('p/x', ['name one', 'name two']);
    await runReindexAliases(engine, ['--json']);
    await runReindexAliases(engine, ['--json']);
    const m = await engine.resolveAliases(['name one'], { sourceId: 'default' });
    expect((m.get('name one') ?? []).map(r => r.slug)).toEqual(['p/x']);
  });

  test('handles comma-scalar frontmatter aliases', async () => {
    await seed('p/y', 'Alpha, Beta');
    const result = await runReindexAliases(engine, ['--json']);
    expect(result.aliases_written).toBe(2);
    const m = await engine.resolveAliases(['alpha', 'beta'], { sourceId: 'default' });
    expect((m.get('alpha') ?? []).map(r => r.slug)).toEqual(['p/y']);
    expect((m.get('beta') ?? []).map(r => r.slug)).toEqual(['p/y']);
  });
});
