/**
 * v0.38 codex r2 P1-D regression — strict-regex blast radius.
 *
 * The codex round-2 review flagged that `utils.ts:validateSourceId` is also
 * imported by cycle reverse-write paths in:
 *   - src/core/cycle/patterns.ts:263
 *   - src/core/cycle/synthesize.ts:909
 *
 * Pre-v0.38, `utils.ts:validateSourceId` used the permissive regex
 * `^[a-z0-9_-]+$` while `sources-ops.ts:validateSourceId` used the strict
 * `^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$`. An underscore-bearing or
 * 33+ char source_id could exist in a brain (hypothetically, since
 * sources-ops always rejected them at creation) and would pass the
 * cycle reverse-write check but fail source add.
 *
 * v0.38 consolidated both paths through `src/core/source-id.ts` and chose
 * the strict regex as canonical. This test pins that change at both
 * boundaries: the re-exported validator rejects exactly what the canonical
 * one rejects, and the patterns + synthesize reverse-write helpers refuse an
 * underscore or traversal source_id BEFORE any file lands under
 * `brainDir/.sources/<id>/`.
 */
import { describe, test, expect } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { validateSourceId } from '../src/core/utils.ts';
import {
  SOURCE_ID_RE,
  assertValidSourceId,
} from '../src/core/source-id.ts';
import { __testing as patterns } from '../src/core/cycle/patterns.ts';
import { __testing as synthesize } from '../src/core/cycle/synthesize.ts';
import type { BrainEngine } from '../src/core/engine.ts';

// Every slug resolves to a page, so the only thing standing between a bad
// source_id and a file write is the validator.
const pageEngine = {
  getPage: async (slug: string) => ({
    slug, type: 'note', title: slug, compiled_truth: 'body', timeline: '', frontmatter: {},
  }),
  getTags: async () => [],
} as unknown as BrainEngine;

describe('strict-regex blast radius — patterns.ts + synthesize.ts (codex r2 P1-D)', () => {
  describe('utils.ts re-export contract', () => {
    test('validateSourceId from utils.ts IS assertValidSourceId from source-id.ts', () => {
      // Structural assertion: both should reject the same inputs.
      const REJECTED = ['snake_id', 'my_source', 'A B', '../etc', '/abs', 'Default', 'too' + '_'.repeat(33)];
      for (const bad of REJECTED) {
        expect(() => validateSourceId(bad)).toThrow();
        expect(() => assertValidSourceId(bad)).toThrow();
      }
    });

    test('validateSourceId accepts the same set as the canonical regex', () => {
      const ACCEPTED = ['a', '1', 'default', 'portfolio', 'my-source', 'alpha-beta-gamma'];
      for (const good of ACCEPTED) {
        expect(SOURCE_ID_RE.test(good)).toBe(true);
        expect(() => validateSourceId(good)).not.toThrow();
      }
    });

    test('validateSourceId rejects underscores (pre-v0.38 would have accepted)', () => {
      // This is THE blast-radius regression. Pre-v0.38, utils.ts permissive
      // regex `^[a-z0-9_-]+$` accepted 'snake_id'. patterns.ts:263 and
      // synthesize.ts:909 call validateSourceId before doing
      // `join(brainDir, '.sources', source_id, ...)`. With the permissive
      // regex, snake_id passed; with the strict regex (v0.38), it throws.
      // Codex P1-D requirement: the regex tightens at these call sites,
      // not just at source add/remove.
      expect(() => validateSourceId('snake_id')).toThrow(/snake_id/);
    });
  });

  describe('cycle reverse-write helpers reject non-canonical source ids before writing', () => {
    for (const [name, reverseWriteRefs] of [
      ['patterns', patterns.reverseWriteRefs],
      ['synthesize', synthesize.reverseWriteRefs],
    ] as const) {
      test(`${name}: snake_id and traversal ids throw and write nothing`, async () => {
        const brainDir = mkdtempSync(join(tmpdir(), `gbrain-strict-source-${name}-`));
        try {
          for (const bad of ['snake_id', '../escape']) {
            await expect(
              reverseWriteRefs(pageEngine, brainDir, [{ slug: 'wiki/x', source_id: bad }], 'default'),
            ).rejects.toThrow();
            expect(existsSync(join(brainDir, '.sources', bad, 'wiki/x.md'))).toBe(false);
          }
          expect(existsSync(join(brainDir, 'escape'))).toBe(false);
          const written = await reverseWriteRefs(pageEngine, brainDir, [{ slug: 'wiki/x', source_id: 'my-source' }], 'default');
          expect(written).toBe(1);
          expect(existsSync(join(brainDir, '.sources', 'my-source', 'wiki/x.md'))).toBe(true);
        } finally {
          rmSync(brainDir, { recursive: true, force: true });
        }
      });
    }
  });
});
