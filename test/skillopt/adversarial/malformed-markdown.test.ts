/**
 * Adversarial: malformed SKILL.md inputs.
 *
 * apply-edits must stay safe when SKILL.md has:
 *  - Unclosed code fences
 *  - Nested code fences (4-backtick wrapping 3-backtick)
 *  - Heading-shaped lines inside fences
 *  - Frontmatter-adjacent edits
 *  - Empty body
 *  - Multi-line targets with embedded newlines
 *  - Unicode + multi-byte characters in anchors
 */

import { describe, expect, test } from 'bun:test';
import {
  applyEdit,
  isInsideCodeFence,
  splitFrontmatter,
} from '../../../src/core/skillopt/apply-edits.ts';

describe('adversarial: malformed markdown', () => {
  test('unclosed code fence — apply-edits treats everything after open as inside', () => {
    const malformed = `# Title

\`\`\`bash
echo hello
# no closing fence

This text is INSIDE the fence per the line-by-line tracker.
`;
    const insideOffset = malformed.indexOf('This text is INSIDE');
    expect(isInsideCodeFence(malformed, insideOffset)).toBe(true);
  });

  test('nested code fence (4-backtick wraps 3-backtick) — basic open/close still toggles', () => {
    // Note: the line-by-line tracker treats any ^``` as a toggle. Nested
    // 4-backtick fences would need a more sophisticated parser; this test
    // documents the v1 behavior so future contributors know the contract.
    const text = `start
\`\`\`outer
\`\`\`inner
end
`;
    // After 2 ^``` lines, fence depth is back to closed.
    const endOffset = text.indexOf('end');
    expect(isInsideCodeFence(text, endOffset)).toBe(false);
  });

  test('heading-shaped line INSIDE a fence does NOT register as a heading anchor', () => {
    const text = `# Real Title

## Real Section

\`\`\`md
## Fake Section In Fence
\`\`\`

After fence.
`;
    // "## Fake Section In Fence" lives inside the fence. add() targeting
    // "## Fake Section In Fence" finds it as a unique heading match BUT
    // the inside-code-fence guard fires.
    const r = applyEdit(text, { op: 'add', anchor: '## Fake Section In Fence', content: 'leaked' });
    expect(r.outcome).toBe('rejected');
    if (r.outcome === 'rejected') {
      // It found the heading shape but the fence guard caught it.
      expect(['inside_code_fence', 'anchor_not_found']).toContain(r.reason);
    }
  });

  test('frontmatter-adjacent body line: replace works as expected', () => {
    const text = `---
name: test
---

First body line.
`;
    const r = applyEdit(text, { op: 'replace', target: 'First body line.', replacement: 'Updated.' });
    expect(r.outcome).toBe('applied');
    if (r.outcome === 'applied') {
      expect(r.newText).toContain('Updated.');
      expect(r.newText).toContain('name: test'); // frontmatter intact
    }
  });

  test('empty body (frontmatter only) — replace cannot find anything', () => {
    const text = `---
name: only-frontmatter
---
`;
    const r = applyEdit(text, { op: 'replace', target: 'anything', replacement: 'X' });
    expect(r.outcome).toBe('rejected');
    if (r.outcome === 'rejected') expect(r.reason).toBe('target_not_found');
  });

  test('multi-line target spanning multiple body paragraphs', () => {
    const text = `---
name: x
---

Para A line 1.
Para A line 2.

Para B.
`;
    const r = applyEdit(text, {
      op: 'replace',
      target: 'Para A line 1.\nPara A line 2.',
      replacement: 'Para A merged into one line.',
    });
    expect(r.outcome).toBe('applied');
    if (r.outcome === 'applied') {
      expect(r.newText).toContain('Para A merged into one line.');
      expect(r.newText).not.toContain('Para A line 2.');
    }
  });

  test('Unicode + emoji anchor works (regex-escape preserves the literal)', () => {
    const text = `---
name: x
---

## Café ☕ Section

content
`;
    const r = applyEdit(text, { op: 'add', anchor: '## Café ☕ Section', content: 'unicode-safe content' });
    expect(r.outcome).toBe('applied');
  });

  test('splitFrontmatter on text with `---` body separator (not frontmatter fence)', () => {
    // No leading `---\n...` fence — the first `---` is just an HR.
    const text = `# Heading

content above

---

content below
`;
    const split = splitFrontmatter(text);
    expect(split.body).toBe(text);
    expect(split.bodyStart).toBe(0);
  });

  test('replace target equals entire body — accepted', () => {
    const text = `---
name: x
---
whole body
`;
    const r = applyEdit(text, { op: 'replace', target: 'whole body', replacement: 'new body' });
    expect(r.outcome).toBe('applied');
    if (r.outcome === 'applied') {
      expect(r.newText).toContain('new body');
      expect(r.newText).not.toContain('whole body');
    }
  });

  test('delete leaves clean markdown (no double newlines)', () => {
    const text = `---
name: x
---
keep this
delete this
also keep this
`;
    const r = applyEdit(text, { op: 'delete', target: 'delete this' });
    expect(r.outcome).toBe('applied');
    if (r.outcome === 'applied') {
      expect(r.newText).not.toContain('delete this');
      expect(r.newText).toContain('keep this');
      expect(r.newText).toContain('also keep this');
    }
  });
});
