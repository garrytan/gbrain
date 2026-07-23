/**
 * SkillOpt apply-edits unit tests. Pure function — no fs, no engine.
 *
 * Covers D5 (frontmatter forbid), D9 (tagged result), shape-aware add/
 * replace/delete, ambiguous-match rejection, inside-code-fence guard.
 */

import { describe, expect, test } from 'bun:test';
import {
  applyEdit,
  applyEditBatch,
  isInsideCodeFence,
  splitFrontmatter,
} from '../../src/core/skillopt/apply-edits.ts';

const SAMPLE_SKILL = `---
name: example-skill
triggers:
  - "do the example"
brain_first: exempt
---

# Example Skill

When asked, run the pipeline.

## Steps

1. First, do X.
2. Then, do Y.

## Anti-patterns

Don't break the rule.
`;

describe('splitFrontmatter', () => {
  test('extracts body after closing fence', () => {
    const split = splitFrontmatter(SAMPLE_SKILL);
    expect(split.body).toContain('# Example Skill');
    expect(split.body).not.toContain('name: example-skill');
    expect(split.bodyStart).toBeGreaterThan(0);
  });

  test('text with no frontmatter returns whole text as body', () => {
    const split = splitFrontmatter('just body, no fence');
    expect(split.body).toBe('just body, no fence');
    expect(split.bodyStart).toBe(0);
  });
});

describe('applyEdit (add)', () => {
  test('inserts content after a unique heading anchor', () => {
    const r = applyEdit(SAMPLE_SKILL, {
      op: 'add',
      anchor: '## Anti-patterns',
      content: '> **Convention:** see [conventions/foo.md](../conventions/foo.md).',
    });
    expect(r.outcome).toBe('applied');
    if (r.outcome === 'applied') {
      expect(r.newText).toContain('## Anti-patterns');
      expect(r.newText).toContain('> **Convention:**');
    }
  });

  test('rejects when anchor not found', () => {
    const r = applyEdit(SAMPLE_SKILL, {
      op: 'add',
      anchor: '## Nonexistent',
      content: 'new content',
    });
    expect(r.outcome).toBe('rejected');
    if (r.outcome === 'rejected') expect(r.reason).toBe('anchor_not_found');
  });

  test('rejects when anchor is ambiguous (multiple matches)', () => {
    const dup = SAMPLE_SKILL.replace('## Anti-patterns', '## Steps');
    const r = applyEdit(dup, { op: 'add', anchor: '## Steps', content: 'X' });
    expect(r.outcome).toBe('rejected');
    if (r.outcome === 'rejected') expect(r.reason).toBe('anchor_ambiguous');
  });
});

describe('applyEdit (replace)', () => {
  test('replaces unique target', () => {
    const r = applyEdit(SAMPLE_SKILL, {
      op: 'replace',
      target: 'Don\'t break the rule.',
      replacement: 'Don\'t skip the validation step.',
    });
    expect(r.outcome).toBe('applied');
    if (r.outcome === 'applied') {
      expect(r.newText).toContain('skip the validation step');
      expect(r.newText).not.toContain('break the rule');
    }
  });

  test('rejects when target appears 0 times', () => {
    const r = applyEdit(SAMPLE_SKILL, { op: 'replace', target: 'nope', replacement: 'X' });
    expect(r.outcome).toBe('rejected');
    if (r.outcome === 'rejected') expect(r.reason).toBe('target_not_found');
  });

  test('rejects when target appears 2+ times', () => {
    const r = applyEdit(SAMPLE_SKILL, { op: 'replace', target: 'do', replacement: 'X' });
    expect(r.outcome).toBe('rejected');
    if (r.outcome === 'rejected') expect(r.reason).toBe('target_ambiguous');
  });
});

describe('applyEdit (delete)', () => {
  test('deletes unique target', () => {
    const r = applyEdit(SAMPLE_SKILL, { op: 'delete', target: 'Don\'t break the rule.' });
    expect(r.outcome).toBe('applied');
    if (r.outcome === 'applied') {
      expect(r.newText).not.toContain('break the rule');
    }
  });
});

describe('D5: frontmatter mutation forbidden', () => {
  test('replace cannot target a frontmatter line', () => {
    // The optimizer tries to mutate `brain_first: exempt`. Body slice
    // doesn't contain it, so the target is "not found" from body's view.
    const r = applyEdit(SAMPLE_SKILL, {
      op: 'replace',
      target: 'brain_first: exempt',
      replacement: 'brain_first: required',
    });
    expect(r.outcome).toBe('rejected');
    if (r.outcome === 'rejected') expect(r.reason).toBe('target_not_found');
  });

  test('add anchor on frontmatter line is invisible', () => {
    const r = applyEdit(SAMPLE_SKILL, {
      op: 'add',
      anchor: 'name: example-skill',
      content: 'evil rewrite',
    });
    expect(r.outcome).toBe('rejected');
    if (r.outcome === 'rejected') expect(r.reason).toBe('anchor_not_found');
  });
});

describe('inside-code-fence guard', () => {
  const FENCED = `# Title

Some prose.

\`\`\`bash
gbrain skillopt foo
gbrain skillopt bar
\`\`\`

After fence.
`;

  test('rejects replace inside fence', () => {
    const r = applyEdit(FENCED, {
      op: 'replace',
      target: 'gbrain skillopt foo',
      replacement: 'gbrain skillopt zzz',
    });
    expect(r.outcome).toBe('rejected');
    if (r.outcome === 'rejected') expect(r.reason).toBe('inside_code_fence');
  });

  test('allows replace outside fence', () => {
    const r = applyEdit(FENCED, { op: 'replace', target: 'After fence.', replacement: 'After.' });
    expect(r.outcome).toBe('applied');
  });
});

describe('isInsideCodeFence', () => {
  const FENCED = '# Title\n\n```\ninside\n```\noutside\n';

  test('returns true for offsets between fence markers', () => {
    const inside = FENCED.indexOf('inside');
    expect(isInsideCodeFence(FENCED, inside)).toBe(true);
  });

  test('returns false for offsets after closing fence', () => {
    const outside = FENCED.indexOf('outside');
    expect(isInsideCodeFence(FENCED, outside)).toBe(false);
  });
});

describe('applyEditBatch with LR budget', () => {
  test('respects lrBudget — only first N apply', () => {
    const text = '---\nname: x\n---\n\nA\nB\nC\nD\n';
    const edits = [
      { op: 'replace' as const, target: 'A', replacement: 'AAA' },
      { op: 'replace' as const, target: 'B', replacement: 'BBB' },
      { op: 'replace' as const, target: 'C', replacement: 'CCC' },
    ];
    const r = applyEditBatch(text, edits, /* lrBudget */ 2);
    expect(r.results.filter((x) => x.outcome === 'applied')).toHaveLength(2);
    expect(r.results.filter((x) => x.outcome === 'rejected')).toHaveLength(1);
    expect(r.newText).toContain('AAA');
    expect(r.newText).toContain('BBB');
    expect(r.newText).not.toContain('CCC'); // budget exhausted
  });
});
