/**
 * Tests for src/core/skillpack/apply-hunks.ts — the pure-JS unified-diff
 * parser + clean-hunk applier (D15, TODO-3 folded).
 *
 * Pins:
 *   - parse: well-formed hunks, multi-hunk diffs, no-newline marker
 *   - apply: clean hunk applies, conflicts skip, ambiguous matches skip
 *   - round-trip: produce a diff with diff-text.ts, apply it cleanly
 *   - parse_error: malformed hunk header throws
 */

import { describe, expect, it } from 'bun:test';

import { unifiedDiff } from '../src/core/skillpack/diff-text.ts';
import {
  ApplyHunksError,
  applyHunks,
  parseUnifiedDiff,
} from '../src/core/skillpack/apply-hunks.ts';

describe('parseUnifiedDiff', () => {
  it('returns empty hunks for empty input', () => {
    expect(parseUnifiedDiff('').hunks).toEqual([]);
  });

  it('parses a single well-formed hunk', () => {
    const text = `--- a/file
+++ b/file
@@ -1,3 +1,4 @@
 line A
-line B
+line B updated
+line C added
 line D
`;
    const parsed = parseUnifiedDiff(text);
    expect(parsed.hunks).toHaveLength(1);
    expect(parsed.hunks[0].oldStart).toBe(1);
    expect(parsed.hunks[0].oldCount).toBe(3);
    expect(parsed.hunks[0].newStart).toBe(1);
    expect(parsed.hunks[0].newCount).toBe(4);
  });

  it('parses a no-newline marker', () => {
    const text = `@@ -1,1 +1,1 @@
-old
+new
\\ No newline at end of file
`;
    const parsed = parseUnifiedDiff(text);
    expect(parsed.hunks[0].newNoNewlineAtEnd).toBe(true);
  });

  it('throws on malformed hunk header', () => {
    const text = `@@ malformed header @@\n-x\n+y\n`;
    expect(() => parseUnifiedDiff(text)).toThrow(ApplyHunksError);
  });

  it('parses multi-hunk diffs', () => {
    const text = `@@ -1,3 +1,3 @@
 first
-changed-a
+changed-b
 third
@@ -10,2 +10,3 @@
 tenth
+new-line
 eleventh
`;
    const parsed = parseUnifiedDiff(text);
    expect(parsed.hunks).toHaveLength(2);
    expect(parsed.hunks[1].oldStart).toBe(10);
  });
});

describe('applyHunks — happy path', () => {
  it('applies a clean hunk when context matches exactly', () => {
    const target = 'line A\nline B\nline C\nline D\n';
    const diff = parseUnifiedDiff(`@@ -1,4 +1,5 @@
 line A
-line B
+line B updated
+line B-extra
 line C
 line D
`);
    const result = applyHunks(target, diff);
    expect(result.applied).toBe(1);
    expect(result.conflicted).toBe(0);
    expect(result.text).toBe('line A\nline B updated\nline B-extra\nline C\nline D\n');
  });

  it('applies multi-hunk diffs in order', () => {
    const target = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\n';
    const diff = parseUnifiedDiff(`@@ -1,3 +1,3 @@
 a
-b
+B
 c
@@ -9,3 +9,3 @@
 i
-j
+J
 k
`);
    const result = applyHunks(target, diff);
    expect(result.applied).toBe(2);
    expect(result.text).toBe('a\nB\nc\nd\ne\nf\ng\nh\ni\nJ\nk\nl\n');
  });
});

describe('applyHunks — conflict detection', () => {
  it('conflict_missing: pre-change block not found in target', () => {
    const target = 'completely different content\nthat does not match\n';
    const diff = parseUnifiedDiff(`@@ -1,3 +1,3 @@
 line A
-line B
+line B updated
 line C
`);
    const result = applyHunks(target, diff);
    expect(result.applied).toBe(0);
    expect(result.conflicted).toBe(1);
    expect(result.outcomes[0].status).toBe('conflict_missing');
    expect(result.text).toBe(target); // unchanged
  });

  it('conflict_ambiguous: pre-change block appears more than once', () => {
    const target = 'pattern X\nbody\npattern X\nbody\n';
    const diff = parseUnifiedDiff(`@@ -1,2 +1,2 @@
 pattern X
-body
+BODY
`);
    const result = applyHunks(target, diff);
    expect(result.applied).toBe(0);
    expect(result.conflicted).toBe(1);
    expect(result.outcomes[0].status).toBe('conflict_ambiguous');
  });

  it('mixed: clean hunk applies even when sibling hunk conflicts', () => {
    const target = 'line A\nline B\nline C\n';
    const diff = parseUnifiedDiff(`@@ -1,3 +1,3 @@
 line A
-line B
+line B updated
 line C
@@ -100,2 +100,2 @@
 not present
-also not
+nope
`);
    const result = applyHunks(target, diff);
    expect(result.applied).toBe(1);
    expect(result.conflicted).toBe(1);
    expect(result.text).toBe('line A\nline B updated\nline C\n');
  });
});

describe('round-trip: unifiedDiff produces output parseUnifiedDiff + applyHunks consume', () => {
  it('full round-trip yields the new file when applied to the old file', () => {
    const oldText = 'one\ntwo\nthree\nfour\nfive\n';
    const newText = 'one\nTWO updated\nthree\nfour\nFIVE updated\n';

    const diff = unifiedDiff(oldText, newText);
    const parsed = parseUnifiedDiff(diff);
    const result = applyHunks(oldText, parsed);

    expect(result.text).toBe(newText);
    expect(result.conflicted).toBe(0);
  });

  it('round-trip works with multi-line additions/deletions', () => {
    const oldText = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
    const newText = oldText.replace('line5', 'line5\nINSERTED\nALSO INSERTED');

    const diff = unifiedDiff(oldText, newText);
    const result = applyHunks(oldText, parseUnifiedDiff(diff));
    expect(result.text).toBe(newText);
  });

  it('user-edited file: identical diff applies clean to unrelated section', () => {
    // gbrain bundle and user file both have lines 1-20. Bundle changed
    // line 5; user changed line 15. Distance is > 2*context, so the
    // hunk's post-context never reaches the user's edit. Apply succeeds.
    const gbrainOld =
      Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n') + '\n';
    const gbrainNew = gbrainOld.replace('line5\n', 'line5 GBRAIN\n');
    const userFile = gbrainOld.replace('line15\n', 'line15 USER\n');

    const diff = unifiedDiff(gbrainOld, gbrainNew);
    const result = applyHunks(userFile, parseUnifiedDiff(diff));

    expect(result.applied).toBe(1);
    expect(result.text).toContain('line5 GBRAIN');
    expect(result.text).toContain('line15 USER');
  });
});

describe('applyHunks — trailing-newline edge cases', () => {
  it('apply-clean adds newline when diff has no `\\` marker (strict patch semantic)', () => {
    // Target lacks trailing newline; diff doesn't carry a `\ No newline`
    // marker, so the diff implies the file ends with one. Apply normalizes
    // to the diff's view of the file. Standard `patch(1)` semantic.
    const target = 'a\nb\nc'; // no final newline
    const diff = parseUnifiedDiff(`@@ -1,3 +1,3 @@
 a
-b
+B
 c
`);
    const result = applyHunks(target, diff);
    expect(result.text).toBe('a\nB\nc\n');
  });

  it('apply-clean preserves no-newline when diff carries the marker', () => {
    const target = 'a\nb\nc'; // no final newline
    const diff = parseUnifiedDiff(`@@ -1,3 +1,3 @@
 a
-b
+B
 c
\\ No newline at end of file
`);
    const result = applyHunks(target, diff);
    expect(result.text).toBe('a\nB\nc');
  });
});

describe('applyHunks — pure additions and edge cases', () => {
  it('identical files: empty diff is a no-op', () => {
    const text = 'identical\n';
    const diff = parseUnifiedDiff(unifiedDiff(text, text));
    const result = applyHunks(text, diff);
    expect(result.text).toBe(text);
    expect(result.applied).toBe(0);
  });
});
