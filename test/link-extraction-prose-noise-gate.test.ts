/**
 * Bare-slug pass-2 prose-noise gate (`opts.knownTopLevelDirs`).
 *
 * #2576 deliberately widened pass 2's bare-slug regex from the DIR_PATTERN
 * whitelist to ANY_DIR_SEGMENT so a brain's own custom directories (ops/,
 * notes/, a schema pack's dirs) stop being silently dropped. On a large
 * brain that same widening also matches ordinary prose that merely LOOKS
 * dir-shaped — `pass/fail`, `staging/prod`, `7/21/30/weekly` — which
 * vastly outnumbers real references (measured: 2165 real links_created vs.
 * 174485 skipped_missing_target on a 95k-page brain; sampling showed
 * 97-99% of the misses are this prose noise).
 *
 * `opts.knownTopLevelDirs` gates pass 2 to only accept a candidate whose
 * first path segment is a top-level directory that actually exists in the
 * caller's live slug set — WITHOUT reintroducing the old DIR_PATTERN
 * whitelist (a custom dir like `ops/` still matches, because it's
 * genuinely present in the live slug set; #2576's fix stays intact).
 * The gate is opt-in: omitted, pass 2 keeps its pre-existing fully
 * permissive behavior (see test/link-extraction-dir-whitelist-2576.test.ts,
 * which calls extractPageLinks WITHOUT this option and must stay green
 * unmodified).
 */

import { describe, test, expect } from 'bun:test';
import { extractPageLinks, type SlugResolver } from '../src/core/link-extraction.ts';

const nullResolver: SlugResolver = { resolve: async () => null };

describe('bare-slug pass 2 — prose-noise gate (opts.knownTopLevelDirs)', () => {
  test('prose noise ("pass/fail") produces NO candidate when knownTopLevelDirs is supplied and "pass/" does not exist', async () => {
    const knownTopLevelDirs = new Set(['people', 'ops']);
    const { candidates } = await extractPageLinks(
      'notes/index', 'The build result was pass/fail depending on the shard.',
      {}, 'concept', nullResolver,
      { skipFrontmatter: true, knownTopLevelDirs },
    );
    expect(candidates.map(c => c.targetSlug)).not.toContain('pass/fail');
  });

  test('prose noise ("staging/prod") produces NO candidate', async () => {
    const knownTopLevelDirs = new Set(['people', 'ops']);
    const { candidates } = await extractPageLinks(
      'notes/index', 'We promote staging/prod every Friday.',
      {}, 'concept', nullResolver,
      { skipFrontmatter: true, knownTopLevelDirs },
    );
    expect(candidates.map(c => c.targetSlug)).not.toContain('staging/prod');
  });

  test('a genuinely custom dir ("ops/") still matches — #2576 parity preserved', async () => {
    const knownTopLevelDirs = new Set(['people', 'ops']);
    const { candidates } = await extractPageLinks(
      'notes/index', 'see ops/services/pointer-agent for details.',
      {}, 'concept', nullResolver,
      { skipFrontmatter: true, knownTopLevelDirs },
    );
    expect(candidates.map(c => c.targetSlug)).toContain('ops/services/pointer-agent');
  });

  test('a candidate whose top-level dir is NOT known is dropped even if it looks legitimate ("archive/2019-notes")', async () => {
    const knownTopLevelDirs = new Set(['people', 'ops']);
    const { candidates } = await extractPageLinks(
      'notes/index', 'See archive/2019-notes for the old version.',
      {}, 'concept', nullResolver,
      { skipFrontmatter: true, knownTopLevelDirs },
    );
    expect(candidates.map(c => c.targetSlug)).not.toContain('archive/2019-notes');
  });

  test('omitting opts.knownTopLevelDirs keeps the pre-existing fully permissive behavior', async () => {
    const { candidates } = await extractPageLinks(
      'notes/index', 'The build result was pass/fail depending on the shard.',
      {}, 'concept', nullResolver,
      { skipFrontmatter: true },
    );
    // No gate supplied — matches ANY_DIR_SEGMENT unconditionally, same as
    // pre-fix / test/link-extraction-dir-whitelist-2576.test.ts.
    expect(candidates.map(c => c.targetSlug)).toContain('pass/fail');
  });

  test('markdown-link form (pass 1) is unaffected by knownTopLevelDirs — the gate only applies to bare-slug prose (pass 2)', async () => {
    const knownTopLevelDirs = new Set(['people']); // deliberately does NOT include "ops"
    const { candidates } = await extractPageLinks(
      'notes/index', '[Pointer](../ops/services/pointer-agent.md) runs the fleet.',
      {}, 'concept', nullResolver,
      { skipFrontmatter: true, knownTopLevelDirs },
    );
    const c = candidates.find(x => x.targetSlug === 'ops/services/pointer-agent');
    expect(c).toBeDefined();
    expect(c!.linkSource).toBe('markdown');
  });
});
