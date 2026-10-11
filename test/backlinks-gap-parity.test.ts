/**
 * Backlinks gap-list parity (wave 14 P1.1, [R22]).
 *
 * Protects: the streaming two-pass `findBacklinkGaps` returns exactly what
 * the single-pass walker returned: same gaps, same order, same per-source
 * dedupe (#967), same `entityName` (the display name, not the slug) and
 * `sourceTitle`. The golden was captured from master's implementation on
 * the shared fixture; a regression reorders, drops or renames a gap.
 *
 * Both walkers visit files in readdir order, which the filesystem decides
 * (ext4 on the builder, a different order on the CI VMs), so the comparison
 * groups gaps by source page with a stable sort and pins the order within
 * each page (the ref order in its body), which is the order the walker owns.
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

type Gap = { sourcePage: string; targetPage: string; entityName: string; sourceTitle: string };
const byPage = (gaps: Gap[]) => JSON.stringify([...gaps].sort((a, b) => a.sourcePage.localeCompare(b.sourcePage)), null, 2) + '\n';
const golden = () => byPage(JSON.parse(readFileSync(GOLDEN, 'utf-8')) as Gap[]);

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-backlinks-parity-'));
  roots.push(root);
  writeBacklinksParityFixture(root);
  return root;
}

describe('findBacklinkGaps parity with the pre-streaming walker', () => {
  test('the sync walker matches the golden, page by page', () => {
    const gaps = findBacklinkGaps(fixture());
    expect(byPage(gaps)).toBe(golden());
  });

  test('the async walker returns the same list', async () => {
    const gaps = await findBacklinkGapsAsync(fixture());
    expect(byPage(gaps)).toBe(golden());
  });

  test('the golden has the shapes the fixture was built to pin', () => {
    const gaps = JSON.parse(readFileSync(GOLDEN, 'utf-8')) as Array<Record<string, string>>;
    expect(gaps.some(g => g.entityName === 'Alice again' || g.entityName === 'ACME Inc' || g.entityName === 'Bobby')).toBe(true);
    expect(gaps.filter(g => g.sourcePage === 'meetings/standup.md' && g.targetPage === 'people/alice.md')).toHaveLength(1);
    expect(gaps.some(g => g.targetPage === 'people/ghost.md')).toBe(false);
    expect(gaps.some(g => g.sourcePage.startsWith('notes/_draft') || g.sourcePage.startsWith('.hidden'))).toBe(false);
  });
});
