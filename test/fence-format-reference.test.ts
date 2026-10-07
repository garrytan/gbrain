/**
 * Fence format reference and fence reason docs (#6188, D23, D24).
 *
 * Protects: docs/guides/fence-format.md's generated region equals a fresh
 * render from the parser and repair constants (columns, layouts, vocabularies,
 * holder grammar, Tier 1 synonym tables, reason tiers, gates); both of its
 * examples parse with zero warnings; every FENCE_REASONS reason has its
 * `fence-<reason>` row in docs/guides/write-refusals.md, that row states the
 * reason's tier and whether the maintenance run clears it by itself, and it
 * links a section of the format reference that exists; every local link in
 * the reference resolves.
 * Fails when: a parser or schema constant changes without regenerating the
 * reference, an example stops parsing, a reason ships without its docs row
 * (its `docs` field would point at nothing), a row's tier or auto-retry
 * drifts from the reason table, or a link points at a missing section.
 * Why new: the reference is new, and the reason-table test checks only the
 * anchor string a reason carries, not that write-refusals.md defines it.
 * Seams: none; reads the committed docs.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { FENCE_FORMAT_PATH, renderFenceFormatDoc } from '../scripts/build-fence-format.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { parseTakesFence } from '../src/core/takes-fence.ts';
import { FENCE_REASON_CODES, FENCE_REASONS } from '../src/core/fence-repair/reasons.ts';

const REGEN = 'Regenerate: bun run scripts/build-fence-format.ts';
const reference = readFileSync(join(import.meta.dir, '..', 'docs/guides/fence-format.md'), 'utf8');
const refusals = readFileSync(join(import.meta.dir, '..', 'docs/guides/write-refusals.md'), 'utf8');

function ids(markdown: string): Set<string> {
  return new Set([...markdown.matchAll(/<a id="([^"]+)"><\/a>/g)].map(m => m[1]!));
}

function markdownBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```markdown\n([\s\S]*?)```/g)].map(m => m[1]!);
}

describe('docs/guides/fence-format.md', () => {
  test('the generated region matches a fresh render from the constants', () => {
    expect(renderFenceFormatDoc(reference), REGEN).toBe(reference);
  });

  test('the facts and takes examples parse with no warnings', () => {
    const blocks = markdownBlocks(reference);
    const facts = blocks.filter(b => b.includes('gbrain:facts:begin')).map(parseFactsFence);
    const takes = blocks.filter(b => b.includes('gbrain:takes:begin')).map(parseTakesFence);
    expect(facts.map(r => ({ warnings: r.warnings, rows: r.facts.length > 0 }))).toEqual([{ warnings: [], rows: true }]);
    expect(takes.map(r => ({ warnings: r.warnings, rows: r.takes.length > 0 }))).toEqual([{ warnings: [], rows: true }]);
  });

  test('every local link in the reference resolves to an existing file and anchor', () => {
    const missing: string[] = [];
    for (const [, href] of reference.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/i.test(href!)) continue;
      const [file, fragment] = href!.split('#');
      const target = file ? resolve(dirname(FENCE_FORMAT_PATH), file) : FENCE_FORMAT_PATH;
      if (!existsSync(target)) { missing.push(href!); continue; }
      if (fragment && !ids(readFileSync(target, 'utf8')).has(fragment)) missing.push(href!);
    }
    expect(missing).toEqual([]);
  });
});

describe('write-refusals fence reason rows', () => {
  const referenceIds = ids(reference);
  const rows = new Map(refusals.split('\n')
    .map(line => [/^\| <a id="fence-([a-z_]+)"><\/a>/.exec(line)?.[1], line] as const)
    .filter((entry): entry is readonly [string, string] => entry[0] !== undefined));

  test('every reason has exactly one row, and no row names an unknown reason', () => {
    expect([...rows.keys()].sort()).toEqual([...FENCE_REASON_CODES].sort());
    for (const reason of FENCE_REASON_CODES) expect(refusals.split(`<a id="fence-${reason}"></a>`).length).toBe(2);
  });

  test('each row states the reason table\'s tier and auto-retry', () => {
    const drift = FENCE_REASON_CODES.flatMap(reason => {
      const cells = rows.get(reason)!.split(' | ');
      const spec = FENCE_REASONS[reason];
      const expected = [spec.tier === null ? '`-`' : `\`${spec.tier}\``, spec.autoRetry ? 'yes' : 'no'];
      return cells[2] === expected[0] && cells[3] === expected[1] ? [] : [`${reason}: ${cells[2]} | ${cells[3]} (want ${expected.join(' | ')})`];
    });
    expect(drift).toEqual([]);
  });

  test('each row links an existing section of the format reference', () => {
    const broken = FENCE_REASON_CODES.flatMap(reason => {
      const anchors = [...rows.get(reason)!.matchAll(/\]\(fence-format\.md#([a-z-]+)\)/g)].map(m => m[1]!);
      if (!anchors.length) return [`${reason}: no fence-format.md link`];
      return anchors.filter(a => !referenceIds.has(a)).map(a => `${reason}: #${a}`);
    });
    expect(broken).toEqual([]);
  });
});
