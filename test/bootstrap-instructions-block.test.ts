/**
 * bootstrap-instructions-block.test.ts — the ambient-writeback managed block
 * (WP3): splice/remove discipline copied from spliceCompiledBlock (idempotent
 * replace-interior, throw on damaged markers, neutralize marker-equal body
 * lines) plus the rendered block's managed-by header (mode + serve URL,
 * [OV-A3]). Pure unit — no engine, no env, no filesystem beyond temp helpers.
 */

import { describe, expect, test } from 'bun:test';

import {
  AMBIENT_WRITEBACK_BLOCK_BEGIN,
  AMBIENT_WRITEBACK_BLOCK_END,
  ambientBlockPresent,
  removeAmbientWritebackBlock,
  renderAmbientInstructionBlock,
  spliceAmbientWritebackBlock,
} from '../src/core/bootstrap/instructions-block.ts';

const BODY = 'managed header line\nrule one\nrule two';
const URL = 'http://127.0.0.1:3131/mcp';

describe('spliceAmbientWritebackBlock', () => {
  test('no markers, empty content → fresh block only, newline-terminated, markers at column 0', () => {
    const out = spliceAmbientWritebackBlock('', BODY);
    expect(out).toBe(
      `${AMBIENT_WRITEBACK_BLOCK_BEGIN}\n${BODY}\n${AMBIENT_WRITEBACK_BLOCK_END}\n`,
    );
    const lines = out.split('\n');
    expect(lines[0]).toBe(AMBIENT_WRITEBACK_BLOCK_BEGIN);
    expect(lines[lines.length - 2]).toBe(AMBIENT_WRITEBACK_BLOCK_END);
  });

  test('no markers, existing content → block appended at EOF; unterminated head gains a newline', () => {
    expect(spliceAmbientWritebackBlock('# My CLAUDE.md\n', BODY)).toBe(
      `# My CLAUDE.md\n${AMBIENT_WRITEBACK_BLOCK_BEGIN}\n${BODY}\n${AMBIENT_WRITEBACK_BLOCK_END}\n`,
    );
    expect(spliceAmbientWritebackBlock('no trailing newline', BODY)).toBe(
      `no trailing newline\n${AMBIENT_WRITEBACK_BLOCK_BEGIN}\n${BODY}\n${AMBIENT_WRITEBACK_BLOCK_END}\n`,
    );
  });

  test('splice twice with the same body ⇒ byte-identical (idempotent)', () => {
    const once = spliceAmbientWritebackBlock('# head\n\ncontent\n', BODY);
    const twice = spliceAmbientWritebackBlock(once, BODY);
    expect(twice).toBe(once);
  });

  test('splice with a changed body ⇒ interior replaced, exactly one block, surrounding content intact', () => {
    const original = `# head\n${AMBIENT_WRITEBACK_BLOCK_BEGIN}\nold body\n${AMBIENT_WRITEBACK_BLOCK_END}\n# tail\n`;
    const out = spliceAmbientWritebackBlock(original, BODY);
    expect(out).toBe(`# head\n${AMBIENT_WRITEBACK_BLOCK_BEGIN}\n${BODY}\n${AMBIENT_WRITEBACK_BLOCK_END}\n# tail\n`);
    expect(out).not.toContain('old body');
    expect(out.split('\n').filter((l) => l === AMBIENT_WRITEBACK_BLOCK_BEGIN).length).toBe(1);
  });

  test('damaged markers throw with an actionable message: duplicate begin / orphan end / out-of-order', () => {
    const dupBegin = `${AMBIENT_WRITEBACK_BLOCK_BEGIN}\nx\n${AMBIENT_WRITEBACK_BLOCK_BEGIN}\n${AMBIENT_WRITEBACK_BLOCK_END}\n`;
    expect(() => spliceAmbientWritebackBlock(dupBegin, BODY)).toThrow(/damaged.*2 begin \/ 1 end/s);
    const orphanEnd = `content\n${AMBIENT_WRITEBACK_BLOCK_END}\n`;
    expect(() => spliceAmbientWritebackBlock(orphanEnd, BODY)).toThrow(/damaged.*0 begin \/ 1 end/s);
    const outOfOrder = `${AMBIENT_WRITEBACK_BLOCK_END}\nx\n${AMBIENT_WRITEBACK_BLOCK_BEGIN}\n`;
    expect(() => spliceAmbientWritebackBlock(outOfOrder, BODY)).toThrow(/out of order/);
    // Actionable: names the fix and the re-run.
    expect(() => spliceAmbientWritebackBlock(dupBegin, BODY)).toThrow(/gbrain bootstrap harness/);
  });

  test('marker-equal lines INSIDE the body are neutralized (leading space) and a re-splice still works', () => {
    const hostile = `before\n${AMBIENT_WRITEBACK_BLOCK_END}\nafter`;
    const out = spliceAmbientWritebackBlock('', hostile);
    // Neutralized: the marker text survives visibly but not as an exact line.
    expect(out).toContain(` ${AMBIENT_WRITEBACK_BLOCK_END}`);
    expect(out.split('\n').filter((l) => l === AMBIENT_WRITEBACK_BLOCK_END).length).toBe(1);
    // No self-wedge: the next splice sees exactly one pair and replaces.
    const again = spliceAmbientWritebackBlock(out, hostile);
    expect(again).toBe(out);
    const replaced = spliceAmbientWritebackBlock(out, 'clean body');
    expect(replaced).toContain('clean body');
    expect(replaced).not.toContain('before');
  });
});

describe('removeAmbientWritebackBlock', () => {
  test('no markers → removed:false, text unchanged', () => {
    const r = removeAmbientWritebackBlock('# untouched\ncontent\n');
    expect(r.removed).toBe(false);
    expect(r.text).toBe('# untouched\ncontent\n');
    expect(removeAmbientWritebackBlock('').removed).toBe(false);
  });

  test('remove after splice restores the non-block content exactly', () => {
    const original = '# My CLAUDE.md\n\nsome standing content\n';
    const spliced = spliceAmbientWritebackBlock(original, BODY);
    const r = removeAmbientWritebackBlock(spliced);
    expect(r.removed).toBe(true);
    expect(r.text).toBe(original);
  });

  test('block-only file removes to empty (the FILE is the caller\'s to keep)', () => {
    const spliced = spliceAmbientWritebackBlock('', BODY);
    const r = removeAmbientWritebackBlock(spliced);
    expect(r.removed).toBe(true);
    expect(r.text).toBe('');
  });

  test('at most ONE trailing blank line after the block is consumed', () => {
    const withBlank = `head\n${AMBIENT_WRITEBACK_BLOCK_BEGIN}\nbody\n${AMBIENT_WRITEBACK_BLOCK_END}\n\ntail\n`;
    expect(removeAmbientWritebackBlock(withBlank).text).toBe('head\ntail\n');
    const withTwoBlanks = `head\n${AMBIENT_WRITEBACK_BLOCK_BEGIN}\nbody\n${AMBIENT_WRITEBACK_BLOCK_END}\n\n\ntail\n`;
    expect(removeAmbientWritebackBlock(withTwoBlanks).text).toBe('head\n\ntail\n');
  });

  test('damaged markers throw the same error splice throws', () => {
    const dupEnd = `${AMBIENT_WRITEBACK_BLOCK_BEGIN}\nx\n${AMBIENT_WRITEBACK_BLOCK_END}\n${AMBIENT_WRITEBACK_BLOCK_END}\n`;
    expect(() => removeAmbientWritebackBlock(dupEnd)).toThrow(/damaged.*1 begin \/ 2 end/s);
    const orphanBegin = `${AMBIENT_WRITEBACK_BLOCK_BEGIN}\ncontent\n`;
    expect(() => removeAmbientWritebackBlock(orphanBegin)).toThrow(/damaged/);
  });
});

describe('ambientBlockPresent', () => {
  test('exact-line markers only — a neutralized (space-prefixed) marker does not count', () => {
    expect(ambientBlockPresent(spliceAmbientWritebackBlock('', BODY))).toBe(true);
    expect(ambientBlockPresent(` ${AMBIENT_WRITEBACK_BLOCK_BEGIN}\n`)).toBe(false);
    expect(ambientBlockPresent('nothing\n')).toBe(false);
    // An orphan marker still reads present — the strip path surfaces the
    // damaged-marker error instead of silently skipping.
    expect(ambientBlockPresent(`${AMBIENT_WRITEBACK_BLOCK_END}\n`)).toBe(true);
  });
});

describe('renderAmbientInstructionBlock', () => {
  test('managed-by header names the mode and the serve URL [OV-A3], body comes from the shared builder', () => {
    const block = renderAmbientInstructionBlock({
      mode: 'salient',
      transientTtl: '3d',
      visibility: 'world',
      serveUrl: URL,
    });
    const header = block.split('\n')[0];
    expect(header).toContain('managed by `gbrain bootstrap harness`');
    expect(header).toContain('mode: salient');
    expect(header).toContain(`serve: ${URL}`);
    expect(header).toContain('do not hand-edit inside markers');
    // Shared-builder body. The block cannot probe the registered serve's
    // surface (a --surface verbs serve has no extract_facts), so it carries
    // the HEDGED multi-fact line — honest on every surface (codex re-review).
    expect(block).toContain('Ambient memory writeback (enabled by this brain\'s operator — mode: salient)');
    expect(block).toContain('extract_facts when that tool is in your tool list');
    expect(block).toContain('otherwise distill them yourself');
    expect(block).toContain('ttl: "3d"');
    expect(block).toContain('visibility: "world"');
  });

  test('all-mode + private posture render through', () => {
    const block = renderAmbientInstructionBlock({
      mode: 'all',
      transientTtl: '7d',
      visibility: 'private',
      serveUrl: 'http://127.0.0.1:4242/mcp',
    });
    expect(block.split('\n')[0]).toContain('mode: all');
    expect(block).toContain('serve: http://127.0.0.1:4242/mcp');
    expect(block).toContain('ttl: "7d"');
    expect(block).toContain('visibility: "private"');
  });

  test('the rendered block splices cleanly and round-trips (render → splice → remove)', () => {
    const body = renderAmbientInstructionBlock({
      mode: 'salient',
      transientTtl: '3d',
      visibility: 'world',
      serveUrl: URL,
    });
    const original = '# AGENTS.md\n\nproject notes\n';
    const spliced = spliceAmbientWritebackBlock(original, body);
    expect(spliced).toBe(spliceAmbientWritebackBlock(spliced, body)); // idempotent
    expect(removeAmbientWritebackBlock(spliced).text).toBe(original);
  });
});
