/**
 * Unit tests for `summarizeMcpParams` — the F8/codex-C8 redactor that strips
 * raw values AND attacker-controlled key names from `mcp_request_log` + the
 * admin SSE feed.
 *
 * Three invariants pinned:
 *   1. Declared keys (the ones the operation accepts per its `params`
 *      definition) survive into `declared_keys` for debug visibility.
 *   2. Unknown keys are counted but NOT named. A caller submitting a key
 *      like `wiki/people/sensitive_name` cannot leak that string into the
 *      log via the redactor's output.
 *   3. The redactor never echoes raw values for any key. Privacy-positive
 *      default; --log-full-params is the documented escape hatch and lives
 *      in serve-http.ts, not here.
 */

import { describe, expect, test } from 'bun:test';
import { summarizeMcpParams, type ParamSummary } from '../src/mcp/dispatch.ts';

describe('summarizeMcpParams — declared-keys allow-list', () => {
  test('declared keys are preserved alphabetically', () => {
    // put_page declares params: slug, content (and a few others). The summary
    // should list both, sorted, without any value bytes.
    const summary = summarizeMcpParams('put_page', {
      slug: 'people/alice',
      content: '# Alice\n\nA private note.',
    }) as ParamSummary;

    expect(summary).not.toBeNull();
    expect(summary.redacted).toBe(true);
    expect(summary.kind).toBe('object');
    expect(summary.declared_keys).toEqual(expect.arrayContaining(['slug', 'content']));
    // Sorted property — fixed order across runs makes log diffs reviewable.
    const sorted = [...(summary.declared_keys ?? [])].sort();
    expect(summary.declared_keys).toEqual(sorted);
    expect(summary.unknown_key_count).toBe(0);
    expect(summary.approx_bytes).toBeGreaterThan(0);
  });

  test('unknown keys are counted but never named', () => {
    // Codex C8 attacker scenario: attacker controls key names and stuffs
    // sensitive data into them. Privacy posture requires we count them
    // without echoing the names anywhere in the summary.
    const sensitiveKey = 'wiki/people/SENSITIVE_TARGET_NAME';
    const summary = summarizeMcpParams('put_page', {
      slug: 'people/alice',
      [sensitiveKey]: 'attacker-controlled value',
      another_unknown: 'whatever',
    }) as ParamSummary;

    // Hard invariant: the sensitive name MUST NOT appear in any field of
    // the summary.
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('SENSITIVE_TARGET_NAME');
    expect(serialized).not.toContain('attacker-controlled value');

    // unknown_key_count counts the keys we couldn't validate.
    expect(summary.unknown_key_count).toBe(2);
    // Declared keys still surface — slug is part of put_page's allow-list.
    expect(summary.declared_keys).toContain('slug');
  });

  test('unknown op name produces all-unknown summary (zero declared keys)', () => {
    // If the operation name doesn't resolve, the allow-list is empty and
    // every submitted key is unknown. Privacy stays intact: no key names
    // surface in the output.
    const summary = summarizeMcpParams('this_op_does_not_exist', {
      foo: 'a',
      bar: 'b',
    }) as ParamSummary;
    expect(summary.declared_keys).toEqual([]);
    expect(summary.unknown_key_count).toBe(2);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('foo');
    expect(serialized).not.toContain('bar');
  });

  test('null/undefined params return null (caller writes SQL NULL)', () => {
    expect(summarizeMcpParams('put_page', null)).toBeNull();
    expect(summarizeMcpParams('put_page', undefined)).toBeNull();
  });

  test('array params summarize length without elements', () => {
    const summary = summarizeMcpParams('put_page', [1, 2, 3, 'sensitive']) as ParamSummary;
    expect(summary.kind).toBe('array');
    expect(summary.length).toBe(4);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('sensitive');
  });

  test('primitive params summarize kind without value', () => {
    const summary = summarizeMcpParams('put_page', 'a sensitive string') as ParamSummary;
    expect(summary.kind).toBe('string');
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('sensitive');
  });

  test('approx_bytes is bucketed to 1KB to defeat size-based side-channels', () => {
    // D16 / adversarial-review fix: the previous shape exposed exact byte
    // length of every request, enabling an attacker to binary-search the
    // size of secret content via repeated probes (submit put_page with a
    // known prefix, observe approx_bytes, narrow the unknown-suffix size).
    // Bucketing to 1KB resolution destroys the side-channel while keeping
    // the operator-useful "roughly how big" signal.
    const tiny = summarizeMcpParams('put_page', { slug: 'a' }) as ParamSummary;
    // Tiny payload (~14 bytes) rounds up to the first 1KB bucket.
    expect(tiny.approx_bytes).toBe(1024);

    // 2KB payload should fall in either the 2KB or 3KB bucket depending on
    // exact serialization length — the invariant is that it's a multiple of
    // 1024, NOT the literal byte count.
    const medium = summarizeMcpParams('put_page', {
      slug: 'people/test',
      content: 'x'.repeat(2000),
    }) as ParamSummary;
    expect(medium.approx_bytes).toBeDefined();
    expect(medium.approx_bytes! % 1024).toBe(0);
    // Bucket cannot be less than the actual size and must round UP, so
    // a ~2KB payload lands in the 2KB or 3KB bucket.
    expect(medium.approx_bytes!).toBeGreaterThanOrEqual(2048);
  });
});
