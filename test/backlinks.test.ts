import { describe, test, expect } from 'bun:test';
import {
  extractEntityRefs,
  extractPageTitle,
  hasBacklink,
  buildBacklinkEntry,
  parseBacklinksArgs,
} from '../src/commands/backlinks.ts';

describe('extractEntityRefs', () => {
  test('extracts people links', () => {
    const content = 'Met [Jane Doe](../people/jane-doe.md) at the event.';
    const refs = extractEntityRefs(content, 'meetings/2026-04-01.md');
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe('Jane Doe');
    expect(refs[0].slug).toBe('jane-doe');
    expect(refs[0].dir).toBe('people');
  });

  test('extracts company links', () => {
    const content = 'Discussed [Acme Corp](../../companies/acme-corp.md) deal.';
    const refs = extractEntityRefs(content, 'meetings/2026/q1.md');
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe('Acme Corp');
    expect(refs[0].slug).toBe('acme-corp');
    expect(refs[0].dir).toBe('companies');
  });

  test('extracts multiple refs', () => {
    const content = '[Alice](../people/alice.md) and [Bob](../people/bob.md) from [Acme](../companies/acme.md).';
    const refs = extractEntityRefs(content, 'meetings/test.md');
    expect(refs).toHaveLength(3);
  });

  test('returns empty for no entity links', () => {
    const content = 'Just a plain page with [external](https://example.com) link.';
    expect(extractEntityRefs(content, 'test.md')).toHaveLength(0);
  });

  test('ignores non-entity brain links', () => {
    const content = '[Guide](../docs/setup.md) for reference.';
    expect(extractEntityRefs(content, 'test.md')).toHaveLength(0);
  });
});

describe('extractPageTitle', () => {
  test('extracts from frontmatter', () => {
    expect(extractPageTitle('---\ntitle: "Jane Doe"\ntype: person\n---\n# Jane')).toBe('Jane Doe');
  });

  test('extracts from H1 when no frontmatter title', () => {
    expect(extractPageTitle('---\ntype: person\n---\n# Jane Doe')).toBe('Jane Doe');
  });

  test('extracts H1 without frontmatter', () => {
    expect(extractPageTitle('# Meeting Notes\n\nContent.')).toBe('Meeting Notes');
  });

  test('returns Untitled for no title', () => {
    expect(extractPageTitle('Just content, no heading.')).toBe('Untitled');
  });
});

describe('hasBacklink', () => {
  test('returns true when source filename is present', () => {
    const content = '## Timeline\n\n- Referenced in [Meeting](../../meetings/q1-review.md)';
    expect(hasBacklink(content, 'q1-review.md')).toBe(true);
  });

  test('returns false when source filename is absent', () => {
    const content = '## Timeline\n\n- Some other entry';
    expect(hasBacklink(content, 'q1-review.md')).toBe(false);
  });
});

describe('buildBacklinkEntry', () => {
  test('dir-shaped source: undated extension-less link (#1776, brain-slug convention)', () => {
    const entry = buildBacklinkEntry('Q1 Review', '../../meetings/q1-review.md');
    expect(entry).toBe('- Referenced in [Q1 Review](../../meetings/q1-review)');
    expect(entry).not.toMatch(/\*\*\d{4}-\d{2}-\d{2}\*\*/);
  });

  test('root-level source keeps .md and stays undated (only the filename substring can credit it)', () => {
    // The canonical extractor only parses `dir/name` paths, so an
    // extension-less link to a root-level page would never be credited on
    // the next check pass and the fixer would append duplicates forever.
    const entry = buildBacklinkEntry('Notes', '../notes.md');
    expect(entry).toBe('- Referenced in [Notes](../notes.md)');
    expect(entry).not.toMatch(/\*\*\d{4}-\d{2}-\d{2}\*\*/);
  });
});

// ---------------------------------------------------------------------------
// #1776: extension-less convention links must count as backlinks
// ---------------------------------------------------------------------------

describe('findBacklinkGaps — extension-less backlink credit (#1776)', () => {
  const fs = { mkdtempSync, writeFileSync, mkdirSync, rmSync };
  const os = { tmpdir };

  function makeRoot(): string {
    const root = fs.mkdtempSync(join(os.tmpdir(), 'gbrain-backlinks-1776-'));
    fs.mkdirSync(join(root, 'people'));
    fs.mkdirSync(join(root, 'companies'));
    fs.mkdirSync(join(root, 'meetings'));
    return root;
  }

  test('bidirectional extension-less pair → 0 gaps', () => {
    const root = makeRoot();
    try {
      fs.writeFileSync(join(root, 'people/alice.md'), '# Alice\n\nWorks at [Acme](../companies/acme).\n');
      fs.writeFileSync(join(root, 'companies/acme.md'), '# Acme\n\nFounded by [Alice](../people/alice).\n');
      expect(findBacklinkGaps(root)).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('one-way mention → exactly 1 gap', () => {
    const root = makeRoot();
    try {
      fs.writeFileSync(join(root, 'people/alice.md'), '# Alice\n\nWorks at [Acme](../companies/acme).\n');
      fs.writeFileSync(join(root, 'companies/acme.md'), '# Acme\n\nNo links back.\n');
      const gaps = findBacklinkGaps(root);
      expect(gaps).toHaveLength(1);
      expect(gaps[0].sourcePage).toBe('people/alice.md');
      expect(gaps[0].targetPage).toBe('companies/acme.md');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('legacy .md fixer row still credited; wikilink backlink credited too', () => {
    const root = makeRoot();
    try {
      // standup mentions both alice (who has a legacy .md fixer row) and
      // bob (who links back via a [[meetings/...]] wikilink).
      fs.writeFileSync(
        join(root, 'meetings/standup.md'),
        '# Standup\n\n[Alice](../people/alice) and [Bob](../people/bob).\n',
      );
      fs.writeFileSync(
        join(root, 'people/alice.md'),
        '# Alice\n\n## Timeline\n\n- **2026-01-01** | Referenced in [Standup](../meetings/standup.md)\n',
      );
      fs.writeFileSync(join(root, 'people/bob.md'), '# Bob\n\nSee [[meetings/standup]].\n');
      expect(findBacklinkGaps(root)).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('fix then check → 0 gaps (fixer output is credited by the next scan)', async () => {
    const root = makeRoot();
    const lockRoot = join(root, '.locks');
    try {
      fs.writeFileSync(join(root, 'meetings/standup.md'), '# Standup\n\nSaw [Alice](../people/alice).\n');
      fs.writeFileSync(join(root, 'people/alice.md'), '# Alice\n');
      const gaps = findBacklinkGaps(root);
      expect(gaps).toHaveLength(1);
      const outcome = await fixBacklinkGaps(root, gaps, false, { lockRoot });
      expect(outcome.fixed).toBe(1);
      const after = readFileSync(join(root, 'people/alice.md'), 'utf-8');
      expect(after).toContain('- Referenced in [Standup](../meetings/standup)');
      expect(after).not.toMatch(/- \*\*\d{4}-\d{2}-\d{2}\*\* \| Referenced in/);
      expect(findBacklinkGaps(root)).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('double-run: a second gap→fix→re-scan loop inserts NOTHING (byte-identical pages)', async () => {
    // The real production loop is find → fix → re-scan. Run it twice over a
    // page that has a timeline region: the second pass must find zero gaps
    // and leave every byte alone — no duplicate rows, no second
    // '## Referenced by' heading, no drift of the timeline boundary.
    const root = makeRoot();
    const lockRoot = join(root, '.locks');
    try {
      fs.writeFileSync(join(root, 'meetings/standup.md'), '# Standup\n\nSaw [Alice](../people/alice).\n');
      fs.writeFileSync(
        join(root, 'people/alice.md'),
        '# Alice\n\n## History\n\n- **2025-12-03** | meeting — Kickoff\n',
      );

      // Loop 1: one gap, fixed.
      const gaps1 = findBacklinkGaps(root);
      expect(gaps1).toHaveLength(1);
      const outcome1 = await fixBacklinkGaps(root, gaps1, false, { lockRoot });
      expect(outcome1.fixed).toBe(1);
      const afterFirst = readFileSync(join(root, 'people/alice.md'), 'utf-8');
      expect(afterFirst).toContain('- Referenced in [Standup](../meetings/standup)');
      // The section landed ABOVE the History region.
      expect(afterFirst.indexOf('## Referenced by')).toBeLessThan(afterFirst.indexOf('## History'));

      // Loop 2: the re-scan credits the fixer's own row → zero gaps, and a
      // second fix pass (even fed the ORIGINAL gap list) writes nothing new.
      const gaps2 = findBacklinkGaps(root);
      expect(gaps2).toHaveLength(0);
      await fixBacklinkGaps(root, gaps2, false, { lockRoot });
      const afterSecond = readFileSync(join(root, 'people/alice.md'), 'utf-8');
      expect(afterSecond).toBe(afterFirst);
      expect(afterSecond.match(/^## Referenced by$/gm)).toHaveLength(1);
      expect(afterSecond.match(/- Referenced in \[Standup\]/g)).toHaveLength(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('fix then check → 0 gaps for a root-level source page (.md row, legacy credit)', async () => {
    const root = makeRoot();
    const lockRoot = join(root, '.locks');
    try {
      fs.writeFileSync(join(root, 'inbox.md'), '# Inbox\n\nPing [Alice](people/alice).\n');
      fs.writeFileSync(join(root, 'people/alice.md'), '# Alice\n');
      const gaps = findBacklinkGaps(root);
      expect(gaps).toHaveLength(1);
      const outcome = await fixBacklinkGaps(root, gaps, false, { lockRoot });
      expect(outcome.fixed).toBe(1);
      const after = readFileSync(join(root, 'people/alice.md'), 'utf-8');
      expect(after).toContain('- Referenced in [Inbox](../inbox.md)');
      expect(after).not.toMatch(/- \*\*\d{4}-\d{2}-\d{2}\*\* \| Referenced in/);
      expect(findBacklinkGaps(root)).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('findBacklinkGaps dedupe (v0.36.x #967 regression)', () => {
  test('a source page mentioning the same target N times yields one gap, not N', async () => {
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const { findBacklinkGaps } = await import('../src/commands/backlinks.ts');

    const root = mkdtempSync(join(tmpdir(), 'gbrain-backlinks-dedupe-'));
    try {
      mkdirSync(join(root, 'people'));
      mkdirSync(join(root, 'meetings'));
      writeFileSync(join(root, 'people/alice.md'), '# Alice');
      // Source page mentions alice three times, no Timeline yet on alice
      writeFileSync(
        join(root, 'meetings/standup.md'),
        '# Standup\n\nWe discussed [Alice](people/alice).\nLater [Alice](people/alice) chimed in.\nFinally [[people/alice]] left.\n',
      );
      const gaps = findBacklinkGaps(root);
      const alicePairs = gaps.filter(g => g.targetPage === 'people/alice.md' && g.sourcePage === 'meetings/standup.md');
      expect(alicePairs.length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// fixBacklinkGaps safety pipeline (frontmatter corruption incident regression)
// ---------------------------------------------------------------------------

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  fixBacklinkGaps,
  insertBacklinkEntry,
  findBacklinkGaps,
  type BacklinkGap,
} from '../src/commands/backlinks.ts';
import { frontmatterBodyOffset, parseMarkdown, serializeMarkdown } from '../src/core/markdown.ts';
import { acquirePageLock } from '../src/core/page-lock.ts';

const fence = '---';

function makeFixture(): { root: string; lockRoot: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-backlinks-fix-'));
  const lockRoot = join(root, '.locks');
  mkdirSync(join(root, 'people'));
  mkdirSync(join(root, 'meetings'));
  return { root, lockRoot, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function gapFor(target: string): BacklinkGap {
  return {
    sourcePage: 'meetings/standup.md',
    targetPage: target,
    entityName: 'Alice',
    sourceTitle: 'Standup',
  };
}

describe('frontmatterBodyOffset', () => {
  test('no frontmatter → 0 (whole file is body)', () => {
    expect(frontmatterBodyOffset('# Alice\n\nBody.')).toBe(0);
  });

  test('LF frontmatter → offset just after closing fence', () => {
    const content = `${fence}\ntype: person\n${fence}\n# Alice\n`;
    const off = frontmatterBodyOffset(content);
    expect(content.slice(off)).toBe('# Alice\n');
  });

  test('CRLF fences count (trim semantics)', () => {
    const content = `${fence}\r\ntype: person\r\n${fence}\r\n# Alice\r\n`;
    const off = frontmatterBodyOffset(content);
    expect(content.slice(off)).toBe('# Alice\r\n');
  });

  test('leading blank lines before the opener are allowed', () => {
    const content = `\n\n${fence}\ntype: person\n${fence}\nBody`;
    const off = frontmatterBodyOffset(content);
    expect(content.slice(off)).toBe('Body');
  });

  test('unclosed fence → 0 (caller must pre-validate)', () => {
    expect(frontmatterBodyOffset(`${fence}\ntype: person\n# Alice`)).toBe(0);
  });

  test('closing fence as final line without trailing newline', () => {
    const content = `${fence}\ntype: person\n${fence}`;
    expect(frontmatterBodyOffset(content)).toBe(content.length);
  });
});

describe('insertBacklinkEntry', () => {
  test('never anchors on a section heading inside frontmatter', () => {
    // GUARD-DISTINGUISHING fixture (adversarial-review finding: a quoted
    // `description: "## Timeline"` is never at line start, so the ^-anchored
    // regex ignores it even WITHOUT the bodyStart slice — the old fixture
    // couldn't detect a broken guard). A line-start `## Timeline` INSIDE the
    // fence is valid YAML (a comment line) and matches the heading regex at
    // offset 0 — only the bodyStart slice keeps the insertion out of the
    // frontmatter.
    const content = `${fence}\ntype: person\n## Timeline\ntitle: Alice\n${fence}\n# Alice\n\nBody text.\n`;
    const bodyStart = frontmatterBodyOffset(content);
    expect(bodyStart).toBeGreaterThan(0);
    const out = insertBacklinkEntry(content, bodyStart, '- new entry');
    // Frontmatter bytes untouched — a broken guard would have inserted the
    // entry into the YAML block right under the comment line.
    expect(out.slice(0, bodyStart)).toBe(content.slice(0, bodyStart));
    // No real body heading exists → a fresh Referenced by section is appended.
    expect(out.slice(bodyStart)).toContain('## Referenced by');
    expect(out.trimEnd().endsWith('- new entry')).toBe(true);
    expect(out.indexOf('- new entry')).toBeGreaterThan(bodyStart);
  });

  test('creates a Referenced by section before a bare Timeline section', () => {
    const content = `# Alice\n\n## Timeline\n\n- **2025-12-03** | meeting — Kickoff\n`;
    const out = insertBacklinkEntry(content, 0, '- entry');
    expect(out).toContain('## Referenced by\n\n- entry\n\n## Timeline');
    expect(out.indexOf('- entry')).toBeLessThan(out.indexOf('## Timeline'));
  });

  test('appends to an existing Referenced by section without crossing into Timeline', () => {
    const content = `# Alice\n\n## Referenced by\n\n- old\n\n## Timeline\n\n- **2025-12-03** | meeting — Kickoff\n`;
    const out = insertBacklinkEntry(content, 0, '- new');
    expect(out).toContain('## Referenced by\n\n- old\n- new\n\n## Timeline');
    expect(out.indexOf('- new')).toBeLessThan(out.indexOf('## Timeline'));
  });

  test('places Referenced by before an explicit timeline sentinel', () => {
    const content = `# Alice\n\n<!-- timeline -->\n\n## Timeline\n\n- **2025-12-03** | meeting — Kickoff\n`;
    const out = insertBacklinkEntry(content, 0, '- new');
    expect(out).toContain('## Referenced by\n\n- new\n\n<!-- timeline -->');
    expect(out.indexOf('- new')).toBeLessThan(out.indexOf('<!-- timeline -->'));
  });

  test('CRLF Referenced by heading matches', () => {
    const content = `# Alice\r\n\r\n## Referenced by\r\n\r\n- old\r\n\r\n## Notes\r\nx\r\n`;
    const out = insertBacklinkEntry(content, 0, '- new');
    expect(out.indexOf('- new')).toBeGreaterThan(out.indexOf('- old'));
    expect(out.indexOf('- new')).toBeLessThan(out.indexOf('## Notes'));
  });

  // Near-miss heading pin (re-added on adoption — the section detector must
  // not anchor on lookalike headings): `### Timeline` and `## Timeline (2026)`
  // are NOT timeline boundaries, so the fresh Referenced by section appends at
  // EOF below them rather than splitting in front of a non-timeline section.
  test('### Timeline and ## Timeline (2026) near-misses are not timeline boundaries', () => {
    const content = `# Alice\n\n### Timeline\n\nsub\n\n## Timeline (2026)\n\nyear\n`;
    const out = insertBacklinkEntry(content, 0, '- entry');
    // near-miss sections untouched, section appended AFTER them
    expect(out).toContain('### Timeline\n\nsub');
    expect(out).toContain('## Timeline (2026)\n\nyear');
    expect(out.indexOf('## Referenced by')).toBeGreaterThan(out.indexOf('## Timeline (2026)'));
    expect(out.trimEnd().endsWith('- entry')).toBe(true);
  });

  // Determinism guard (adapted from the pre-adoption first-heading pin): with
  // two real `## Timeline` headings the section lands before the FIRST one.
  test('two real ## Timeline headings → Referenced by placed before the FIRST', () => {
    const content = `# Alice\n\n## Timeline\n\n- first section\n\n## Notes\n\nx\n\n## Timeline\n\n- second section\n`;
    const out = insertBacklinkEntry(content, 0, '- new');
    const newIdx = out.indexOf('- new');
    expect(newIdx).toBeGreaterThan(out.indexOf('# Alice'));
    expect(newIdx).toBeLessThan(out.indexOf('## Timeline'));
    expect(newIdx).toBeLessThan(out.indexOf('- first section'));
  });

  // CRLF timeline-boundary coverage (adapted from the deleted CRLF heading
  // test): the bare-heading fallback tolerates `\r` and the inserted section
  // uses the file's dominant EOL.
  test('CRLF bare Timeline heading is a boundary; inserted section uses CRLF', () => {
    const content = `# Alice\r\n\r\n## Timeline\r\n\r\n- **2025-12-03** | old\r\n`;
    const out = insertBacklinkEntry(content, 0, '- new');
    expect(out).toContain('## Referenced by\r\n\r\n- new\r\n\r\n## Timeline');
    expect(out.indexOf('- new')).toBeLessThan(out.indexOf('## Timeline'));
  });

  test('## History is a timeline-region boundary: the section lands BEFORE it', () => {
    // The bare-heading fallback matches History alongside Timeline — a page
    // that keeps its dated log under `## History` must not get backlink rows
    // appended INTO that region.
    const content = `# Alice\n\n## History\n\n- **2025-12-03** | meeting — Kickoff\n`;
    const out = insertBacklinkEntry(content, 0, '- entry');
    expect(out).toContain('## Referenced by\n\n- entry\n\n## History');
    expect(out.indexOf('- entry')).toBeLessThan(out.indexOf('## History'));
  });

  test('lowercase ## timeline matches the boundary (case-insensitive heading regex)', () => {
    const content = `# Alice\n\n## timeline\n\n- **2025-12-03** | meeting — Kickoff\n`;
    const out = insertBacklinkEntry(content, 0, '- entry');
    expect(out).toContain('## Referenced by\n\n- entry\n\n## timeline');
    expect(out.indexOf('- entry')).toBeLessThan(out.indexOf('## timeline'));
  });

  test('dashed `--- timeline ---` sentinel is a boundary: section placed before it', () => {
    // findTimelineSplitIndex's rule-2 sentinel form — takes precedence over
    // any bare heading, so the section must land ABOVE the dashes.
    const content = `# Alice\n\nBody prose.\n\n--- timeline ---\n\n- **2025-12-03** | meeting — Kickoff\n`;
    const out = insertBacklinkEntry(content, 0, '- new');
    expect(out).toContain('## Referenced by\n\n- new\n\n--- timeline ---');
    expect(out.indexOf('- new')).toBeLessThan(out.indexOf('--- timeline ---'));
  });
});

describe('fixBacklinkGaps safety pipeline', () => {
  test('valid frontmatter page: entry inserted, frontmatter byte-identical, no tmp residue', async () => {
    const { root, lockRoot, cleanup } = makeFixture();
    try {
      const original = `${fence}\ntype: person\ntitle: Alice\n${fence}\n# Alice\n\n## Timeline\n\n- old\n`;
      writeFileSync(join(root, 'people/alice.md'), original);
      const outcome = await fixBacklinkGaps(root, [gapFor('people/alice.md')], false, { lockRoot });
      expect(outcome.fixed).toBe(1);
      expect(outcome.skipped).toHaveLength(0);
      const after = readFileSync(join(root, 'people/alice.md'), 'utf-8');
      const bodyStart = frontmatterBodyOffset(original);
      expect(after.slice(0, bodyStart)).toBe(original.slice(0, bodyStart));
      // #1776: dir-shaped fixer rows are extension-less so the next check
      // pass credits them through the canonical extractor.
      expect(after).toContain('- Referenced in [Standup](../meetings/standup)');
      expect(after).not.toMatch(/- \*\*\d{4}-\d{2}-\d{2}\*\* \| Referenced in/);
      expect(readdirSync(join(root, 'people')).filter(f => f.includes('.tmp.'))).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test('frontmatter-less legacy page stays fixable (MISSING_OPEN is not a blocker)', async () => {
    const { root, lockRoot, cleanup } = makeFixture();
    try {
      writeFileSync(join(root, 'people/alice.md'), '# Alice\n');
      const outcome = await fixBacklinkGaps(root, [gapFor('people/alice.md')], false, { lockRoot });
      expect(outcome.fixed).toBe(1);
      expect(outcome.skipped).toHaveLength(0);
      const after = readFileSync(join(root, 'people/alice.md'), 'utf-8');
      expect(after.startsWith('# Alice')).toBe(true);
      expect(after).toContain('## Referenced by');
    } finally {
      cleanup();
    }
  });

  test('pre-broken YAML fence (MISSING_CLOSE) → skipped, file byte-identical', async () => {
    const { root, lockRoot, cleanup } = makeFixture();
    try {
      const broken = `${fence}\ntype: person\n# Alice heading glued into frontmatter\n`;
      writeFileSync(join(root, 'people/alice.md'), broken);
      const outcome = await fixBacklinkGaps(root, [gapFor('people/alice.md')], false, { lockRoot });
      expect(outcome.fixed).toBe(0);
      expect(outcome.skipped).toHaveLength(1);
      expect(outcome.skipped[0].reason).toContain('MISSING_CLOSE');
      expect(readFileSync(join(root, 'people/alice.md'), 'utf-8')).toBe(broken);
    } finally {
      cleanup();
    }
  });

  test('incident regression: bullet can never land above the frontmatter fence', async () => {
    const { root, lockRoot, cleanup } = makeFixture();
    try {
      // The incident shape: an entity page whose frontmatter carries a
      // LINE-START `## Timeline` (a valid YAML comment — the
      // guard-distinguishing form; a quoted mid-line mention can't detect a
      // broken bodyStart guard) and whose body has no Timeline section yet.
      const original = `${fence}\ntype: person\ntitle: Y Combinator\n## Timeline\nnotes: history below\n${fence}\n# Y Combinator\n\nBody text.\n`;
      writeFileSync(join(root, 'people/alice.md'), original);
      const outcome = await fixBacklinkGaps(root, [gapFor('people/alice.md')], false, { lockRoot });
      expect(outcome.fixed).toBe(1);
      const after = readFileSync(join(root, 'people/alice.md'), 'utf-8');
      // Byte 0 is still the opening fence; frontmatter intact.
      expect(after.startsWith(`${fence}\ntype: person`)).toBe(true);
      const bodyStart = frontmatterBodyOffset(original);
      expect(after.slice(0, bodyStart)).toBe(original.slice(0, bodyStart));
      // Entry landed in a fresh body section, below the fence.
      expect(after.indexOf('Referenced in')).toBeGreaterThan(bodyStart);
    } finally {
      cleanup();
    }
  });

  test('dryRun counts fixes but writes nothing', async () => {
    const { root, lockRoot, cleanup } = makeFixture();
    try {
      const original = `${fence}\ntype: person\n${fence}\n# Alice\n`;
      writeFileSync(join(root, 'people/alice.md'), original);
      const outcome = await fixBacklinkGaps(root, [gapFor('people/alice.md')], true, { lockRoot });
      expect(outcome.fixed).toBe(1);
      expect(readFileSync(join(root, 'people/alice.md'), 'utf-8')).toBe(original);
    } finally {
      cleanup();
    }
  });

  test('held page lock → that file skipped with a reason, others still fixed', async () => {
    const { root, lockRoot, cleanup } = makeFixture();
    try {
      writeFileSync(join(root, 'people/alice.md'), `${fence}\ntype: person\n${fence}\n# Alice\n`);
      writeFileSync(join(root, 'people/bob.md'), `${fence}\ntype: person\n${fence}\n# Bob\n`);
      const held = await acquirePageLock('people/alice', { lockRoot });
      expect(held).not.toBeNull();
      try {
        const outcome = await fixBacklinkGaps(
          root,
          [gapFor('people/alice.md'), gapFor('people/bob.md')],
          false,
          { lockRoot },
        );
        expect(outcome.fixed).toBe(1); // bob only
        expect(outcome.skipped).toHaveLength(1);
        expect(outcome.skipped[0].page).toBe('people/alice.md');
        expect(outcome.skipped[0].reason).toContain('lock');
      } finally {
        await held!.release();
      }
    } finally {
      cleanup();
    }
  }, 15_000);

  test('frontmatter-only page (empty body) gets a section appended after the fence', async () => {
    const { root, lockRoot, cleanup } = makeFixture();
    try {
      const original = `${fence}\ntype: person\ntitle: Alice\n${fence}\n`;
      writeFileSync(join(root, 'people/alice.md'), original);
      const outcome = await fixBacklinkGaps(root, [gapFor('people/alice.md')], false, { lockRoot });
      expect(outcome.fixed).toBe(1);
      const after = readFileSync(join(root, 'people/alice.md'), 'utf-8');
      const bodyStart = frontmatterBodyOffset(original);
      expect(after.slice(0, bodyStart)).toBe(original.slice(0, bodyStart));
      expect(after.slice(bodyStart)).toContain('## Referenced by');
    } finally {
      cleanup();
    }
  });

  test('sentinel-less dated timeline survives backlink repair and both backlinks stay outside it', async () => {
    const { root, lockRoot, cleanup } = makeFixture();
    try {
      const original = `${fence}\ntype: person\ntitle: Alice\n${fence}\n# Alice\n\n## Timeline\n\n- **2025-12-03** | meeting — Kickoff\n- **2026-01-14** | meeting — Follow-up\n`;
      writeFileSync(join(root, 'people/alice.md'), original);
      const gaps: BacklinkGap[] = [
        { sourcePage: 'meetings/standup.md', targetPage: 'people/alice.md', entityName: 'Alice', sourceTitle: 'Standup' },
        { sourcePage: 'meetings/retro.md', targetPage: 'people/alice.md', entityName: 'Alice', sourceTitle: 'Retro' },
      ];
      const outcome = await fixBacklinkGaps(root, gaps, false, { lockRoot });
      expect(outcome.fixed).toBe(2);
      expect(outcome.skipped).toHaveLength(0);
      const after = readFileSync(join(root, 'people/alice.md'), 'utf-8');
      // Frontmatter byte-identical.
      const bodyStart = frontmatterBodyOffset(original);
      expect(after.slice(0, bodyStart)).toBe(original.slice(0, bodyStart));
      // Both backlinks land in compiled truth, before the preserved timeline.
      const headingIdx = after.indexOf('## Timeline');
      expect(headingIdx).toBeGreaterThan(bodyStart);
      const standupIdx = after.indexOf('Referenced in [Standup](../meetings/standup)');
      const retroIdx = after.indexOf('Referenced in [Retro](../meetings/retro)');
      expect(standupIdx).toBeLessThan(headingIdx);
      expect(retroIdx).toBeLessThan(headingIdx);
      expect(after).toContain('- Referenced in [Standup](../meetings/standup)');
      expect(after).toContain('- Referenced in [Retro](../meetings/retro)');
      expect(after).not.toMatch(/- \*\*\d{4}-\d{2}-\d{2}\*\* \| Referenced in/);
      // Exactly one Timeline section — the second gap must not mint a new one.
      expect(after.match(/^## Timeline$/gm)).toHaveLength(1);
      expect(after.match(/^## Referenced by$/gm)).toHaveLength(1);
      const parsed = parseMarkdown(after, 'people/alice.md');
      expect(parsed.timeline).toContain('Kickoff');
      expect(parsed.timeline).toContain('Follow-up');
      expect(parsed.timeline).not.toContain('Referenced in');
      expect(parsed.compiled_truth).toContain('Referenced in [Standup]');
      const reserialized = serializeMarkdown({}, parsed.compiled_truth, parsed.timeline, {
        type: 'person', title: 'Alice', tags: [],
      });
      expect(reserialized.match(/^## Timeline$/gm)).toHaveLength(1);
      // No tmp residue from the atomic-write pipeline.
      expect(readdirSync(join(root, 'people')).filter(f => f.includes('.tmp.'))).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});

describe('parseBacklinksArgs', () => {
  test('uses positional dir for check and fix subcommands', () => {
    expect(parseBacklinksArgs(['check', '/tmp/brain']).brainDir).toBe('/tmp/brain');
    expect(parseBacklinksArgs(['fix', '/tmp/brain']).brainDir).toBe('/tmp/brain');
  });

  test('defaults to cwd when no dir given', () => {
    expect(parseBacklinksArgs(['check']).brainDir).toBe('.');
  });

  test('--dir overrides positional dir and preserves dry-run', () => {
    const parsed = parseBacklinksArgs(['fix', '/tmp/ignored', '--dir', '/tmp/brain', '--dry-run']);
    expect(parsed.subcommand).toBe('fix');
    expect(parsed.brainDir).toBe('/tmp/brain');
    expect(parsed.dryRun).toBe(true);
  });

  test('--dir missing its value falls back to positional dir', () => {
    expect(parseBacklinksArgs(['check', '/tmp/brain', '--dir']).brainDir).toBe('/tmp/brain');
    expect(parseBacklinksArgs(['check', '--dir', '--dry-run']).brainDir).toBe('.');
  });
});
