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
 * the strict regex as canonical. This test pins that change: the regex
 * used at the cycle reverse-write sites must be the strict one, and the
 * import path must be the consolidated one.
 *
 * IRON-RULE: this is a structural regression test. If a future refactor
 * splits the import path or widens the regex, this test fails first.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { validateSourceId } from '../src/core/utils.ts';
import {
  SOURCE_ID_RE,
  assertValidSourceId,
} from '../src/core/source-id.ts';

const REPO_ROOT = join(import.meta.dir, '..');

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

  describe('cycle reverse-write call sites use the consolidated path', () => {
    test('patterns.ts imports validateSourceId from utils.ts', () => {
      const src = readFileSync(join(REPO_ROOT, 'src/core/cycle/patterns.ts'), 'utf8');
      // Whichever import shape — relative path varies — must reach utils.ts
      // (which now re-exports the strict assertValidSourceId).
      expect(src).toMatch(/import\s+\{[^}]*validateSourceId[^}]*\}\s+from\s+['"]\.\.\/utils\.ts['"]/);
    });

    test('synthesize.ts imports validateSourceId from utils.ts', () => {
      const src = readFileSync(join(REPO_ROOT, 'src/core/cycle/synthesize.ts'), 'utf8');
      expect(src).toMatch(/import\s+\{[^}]*validateSourceId[^}]*\}\s+from\s+['"]\.\.\/utils\.ts['"]/);
    });

    test('patterns.ts calls validateSourceId before reverse-write join (defense ordering)', () => {
      const src = readFileSync(join(REPO_ROOT, 'src/core/cycle/patterns.ts'), 'utf8');
      // Look for the canonical reverseWriteRefs body: validateSourceId(source_id)
      // must appear inside a function that later calls join(brainDir, '.sources', source_id, ...).
      const validatePos = src.indexOf('validateSourceId(source_id)');
      const joinPos = src.indexOf(".sources', source_id");
      expect(validatePos).toBeGreaterThan(-1);
      expect(joinPos).toBeGreaterThan(-1);
      expect(validatePos).toBeLessThan(joinPos);
    });

    test('synthesize.ts calls validateSourceId before reverse-write join', () => {
      const src = readFileSync(join(REPO_ROOT, 'src/core/cycle/synthesize.ts'), 'utf8');
      const validatePos = src.indexOf('validateSourceId(source_id)');
      const joinPos = src.indexOf(".sources', source_id");
      expect(validatePos).toBeGreaterThan(-1);
      expect(joinPos).toBeGreaterThan(-1);
      expect(validatePos).toBeLessThan(joinPos);
    });
  });

  describe('utils.ts no longer carries an inline permissive regex', () => {
    test('utils.ts source text contains no `^[a-z0-9_-]+$` regex literal', () => {
      // Pre-v0.38 had this exact regex. The blast-radius fix tightened it.
      // If a future refactor reintroduces a permissive shape in utils.ts,
      // this test fails first.
      const src = readFileSync(join(REPO_ROOT, 'src/core/utils.ts'), 'utf8');
      expect(src).not.toMatch(/\/\^\[a-z0-9_-\]\+\$\//);
    });

    test('utils.ts re-exports assertValidSourceId from source-id.ts as validateSourceId', () => {
      const src = readFileSync(join(REPO_ROOT, 'src/core/utils.ts'), 'utf8');
      // Either named alias re-export or any other shape that produces the
      // same observable contract (validateSourceId === assertValidSourceId).
      expect(src).toMatch(/assertValidSourceId\s+as\s+validateSourceId.*from\s+['"]\.\/source-id\.ts['"]/);
    });
  });
});
