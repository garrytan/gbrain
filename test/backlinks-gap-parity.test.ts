/**
 * Backlinks gap-list parity (wave 14 P1.1, [R22]).
 *
 * Protects: the streaming two-pass `findBacklinkGaps` returns exactly what
 * the single-pass walker returned: same gaps, same order, same per-source
 * dedupe (#967), same `entityName` (the display name, not the slug) and
 * `sourceTitle`. The golden was captured from master's implementation on
 * the shared fixture; a regression reorders, drops or renames a gap.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findBacklinkGaps, findBacklinkGapsAsync } from '../src/commands/backlinks.ts';
import { writeBacklinksParityFixture } from './helpers/backlinks-parity-fixture.ts';

const GOLDEN = new URL('./fixtures/backlinks-parity/gaps.golden.json', import.meta.url).pathname;
const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-backlinks-parity-'));
  roots.push(root);
  writeBacklinksParityFixture(root);
  return root;
}

describe('findBacklinkGaps parity with the pre-streaming walker', () => {
  test('the sync walker matches the golden byte for byte', () => {
    const gaps = findBacklinkGaps(fixture());
    expect(JSON.stringify(gaps, null, 2) + '\n').toBe(readFileSync(GOLDEN, 'utf-8'));
  });

  test('the async walker returns the same list', async () => {
    const gaps = await findBacklinkGapsAsync(fixture());
    expect(JSON.stringify(gaps, null, 2) + '\n').toBe(readFileSync(GOLDEN, 'utf-8'));
  });

  test('the golden has the shapes the fixture was built to pin', () => {
    const gaps = JSON.parse(readFileSync(GOLDEN, 'utf-8')) as Array<Record<string, string>>;
    expect(gaps.some(g => g.entityName === 'Alice again' || g.entityName === 'ACME Inc' || g.entityName === 'Bobby')).toBe(true);
    expect(gaps.filter(g => g.sourcePage === 'meetings/standup.md' && g.targetPage === 'people/alice.md')).toHaveLength(1);
    expect(gaps.some(g => g.targetPage === 'people/ghost.md')).toBe(false);
    expect(gaps.some(g => g.sourcePage.startsWith('notes/_draft') || g.sourcePage.startsWith('.hidden'))).toBe(false);
  });
});
