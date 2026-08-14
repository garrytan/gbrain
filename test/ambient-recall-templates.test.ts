/**
 * Ambient recall (v0.45.7) — template + doc content pins.
 *
 * The context_pack/delta verbs only deliver value if the shipped guidance
 * points agents at them. These pins keep the four guidance surfaces from
 * silently dropping the boundary instructions:
 *   - HEARTBEAT.md.template carries the ambient-delta row (heartbeats pull
 *     `gbrain delta`; session start / post-compaction pairs with
 *     `gbrain context-pack`)
 *   - the RENDERED template-repo HEARTBEAT.md carries the same row
 *   - docs/mcp/CODEX.md names context_pack for the session boundary (Codex
 *     has no lifecycle hooks — the pull path is the only path)
 *   - docs/guides/ambient-recall.md exists and names both verbs
 *
 * Assertions pin stable substrings (verb + command names), not full sentences.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ROOT = dirname(import.meta.dir);

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

describe('HEARTBEAT ambient-delta row', () => {
  test('source template points heartbeats at gbrain delta + context-pack', () => {
    const tpl = read('templates/bootstrap/HEARTBEAT.md.template');
    expect(tpl).toContain('ambient-delta');
    expect(tpl).toContain('gbrain delta');
    expect(tpl).toContain('gbrain context-pack');
    expect(tpl).toContain('docs/guides/ambient-recall.md');
  });

  test('rendered template-repo HEARTBEAT.md carries the same row', () => {
    const rendered = read('templates/bootstrap/template-repo/HEARTBEAT.md');
    expect(rendered).toContain('ambient-delta');
    expect(rendered).toContain('gbrain delta');
    expect(rendered).toContain('gbrain context-pack');
  });
});

describe('docs surfaces', () => {
  test('CODEX.md session-boundary instruction names both verbs (pull path)', () => {
    const codex = read('docs/mcp/CODEX.md');
    expect(codex).toContain('context_pack');
    expect(codex).toContain('delta');
    // Codex has no lifecycle hooks, so the doc must route boundary calls to
    // the guide's placement frontier.
    expect(codex).toContain('ambient-recall.md');
  });

  test('ambient-recall guide exists and names both verbs', () => {
    expect(existsSync(join(ROOT, 'docs/guides/ambient-recall.md'))).toBe(true);
    const guide = read('docs/guides/ambient-recall.md');
    expect(guide).toContain('context_pack');
    expect(guide).toContain('delta');
  });
});
