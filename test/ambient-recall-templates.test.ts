/**
 * Ambient recall (v0.45.7) — shipped template pin.
 *
 * The context_pack/delta verbs only deliver value if the shipped guidance
 * points agents at them. HEARTBEAT.md.template is rendered into users'
 * workspaces, so it must carry the ambient-delta row (heartbeats pull
 * `gbrain delta`; session start / post-compaction pairs with
 * `gbrain context-pack`). The rendered template-repo copy is byte-diffed
 * against the generator by scripts/check-bootstrap-templates.sh. The guide the
 * row points at must exist.
 *
 * Assertions pin stable substrings (verb + command names), not full sentences.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
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
    expect(existsSync(join(ROOT, 'docs/guides/ambient-recall.md'))).toBe(true);
  });

});
