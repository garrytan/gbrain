/**
 * validateFixturePath (src/commands/extract-benchmark.ts) accepts a fixture
 * under a pack folder named `..drafts`, and still refuses a fixture that
 * leaves the pack root.
 *
 * Authoring gate:
 * 1. Protects: a pack manifest may point `extractable.fixture_corpus` at a
 *    file inside a folder whose name starts with two dots (directly, or
 *    through an in-pack symlinked folder); a manifest path that leaves the pack
 *    (a `../` segment, a symlinked folder to an outside dir, or to a sibling
 *    folder that shares the pack root's name prefix) is still refused.
 * 2. Regression that fails it: either of the two containment checks treating
 *    any relative path that starts with the two characters `..` as "outside"
 *    instead of only a `..` path component; or loosening them so an outside
 *    realpath is accepted.
 * 3. Why existing coverage misses it: test/extract/benchmark.test.ts covers a
 *    `..` segment and a symlinked file, but no folder named like `..drafts`
 *    and no symlinked intermediate folder.
 * 4. Production seam: none. validateFixturePath is already exported and is
 *    exercised directly, as the sibling test does.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateFixturePath } from '../../src/commands/extract-benchmark.ts';

let scratch: string;
let packRoot: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'gbrain-fixture-dotdot-'));
  packRoot = join(scratch, 'pack');
  mkdirSync(packRoot, { recursive: true });
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function writeFixture(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'claim.jsonl'), '{}\n');
}

describe('validateFixturePath with a folder whose name starts with two dots', () => {
  test('accepts a fixture file that does not exist yet under a ..drafts folder', () => {
    expect(validateFixturePath(packRoot, '..drafts/claim.jsonl')).toBe(join(packRoot, '..drafts', 'claim.jsonl'));
  });

  test('accepts an existing fixture file under a ..drafts folder', () => {
    writeFixture(join(packRoot, '..drafts'));
    expect(validateFixturePath(packRoot, '..drafts/claim.jsonl')).toBe(join(packRoot, '..drafts', 'claim.jsonl'));
  });

  test('accepts a fixture reached through an in-pack folder symlinked to a ..real folder', () => {
    writeFixture(join(packRoot, '..real'));
    symlinkSync('..real', join(packRoot, 'fixtures'), 'dir');
    expect(validateFixturePath(packRoot, 'fixtures/claim.jsonl')).toBe(join(packRoot, 'fixtures', 'claim.jsonl'));
  });
});

describe('validateFixturePath still refuses a fixture that leaves the pack root', () => {
  test('refuses a ../ segment', () => {
    expect(() => validateFixturePath(packRoot, '../claim.jsonl')).toThrow(/'\.\.'\s*segment/);
    expect(() => validateFixturePath(packRoot, '..drafts/../../claim.jsonl')).toThrow(/'\.\.'\s*segment/);
  });

  test('refuses a folder symlinked to an outside folder with a plain name', () => {
    const outside = join(scratch, 'outside');
    writeFixture(outside);
    symlinkSync(outside, join(packRoot, 'fixtures'), 'dir');
    expect(() => validateFixturePath(packRoot, 'fixtures/claim.jsonl')).toThrow(/realpath resolves outside the pack root/);
  });

  test('refuses a folder symlinked to an outside folder whose name starts with two dots', () => {
    const outside = join(scratch, '..outside');
    writeFixture(outside);
    symlinkSync(outside, join(packRoot, 'fixtures'), 'dir');
    expect(() => validateFixturePath(packRoot, 'fixtures/claim.jsonl')).toThrow(/realpath resolves outside the pack root/);
  });

  test('refuses a folder symlinked to a sibling folder that shares the pack root name prefix', () => {
    const sibling = join(scratch, 'pack2');
    writeFixture(sibling);
    symlinkSync(sibling, join(packRoot, 'fixtures'), 'dir');
    expect(() => validateFixturePath(packRoot, 'fixtures/claim.jsonl')).toThrow(/realpath resolves outside the pack root/);
  });
});
