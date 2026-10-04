/**
 * Agent operator protocol page (contract v1, Lane G1) drift checks.
 *
 * - The transcripts in docs/protocol/AGENT_OPERATOR_v1.md are generated from
 *   the frozen goldens in test/fixtures/agent-contract/v1/ and the quick
 *   contract is copied verbatim into AGENTS.md; both must match a fresh
 *   render (regenerate: bun run build:agent-protocol).
 * - The quick contract stays at most 10 lines.
 * - The entry points agents read first link the protocol page.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AGENTS_PATH, PROTOCOL_PATH, TRANSCRIPTS, quickContract, renderAgentProtocolDocs,
} from '../scripts/build-agent-protocol.ts';

const ROOT = join(import.meta.dir, '..');
const REGEN = 'Regenerate: bun run build:agent-protocol';

describe('AGENT_OPERATOR_v1.md generated regions', () => {
  const protocol = readFileSync(PROTOCOL_PATH, 'utf8');
  const agents = readFileSync(AGENTS_PATH, 'utf8');

  test('transcripts match the goldens (next recomputed, never stored)', () => {
    expect(renderAgentProtocolDocs(protocol, agents).protocol, REGEN).toBe(protocol);
  });

  test('AGENTS.md carries the quick contract verbatim', () => {
    expect(renderAgentProtocolDocs(protocol, agents).agents, REGEN).toBe(agents);
    expect(agents).toContain(quickContract(protocol));
  });

  test('the quick contract is at most 10 lines', () => {
    expect(quickContract(protocol).trimEnd().split('\n').length).toBeLessThanOrEqual(10);
  });

  test('transcripts cover run, ask_user and tell_user_to_run', () => {
    expect([...new Set(TRANSCRIPTS.map(t => t.expectNext))].sort()).toEqual(['ask_user', 'run', 'tell_user_to_run']);
  });

  test('Lane H journey transcripts come from recorded journey goldens', () => {
    expect(TRANSCRIPTS.filter(t => t.golden.startsWith('journey/')).length).toBeGreaterThanOrEqual(3);
  });

  test('generated transcripts never carry an unresolved placeholder', () => {
    const region = protocol.slice(protocol.indexOf('<!-- BEGIN GENERATED agent-protocol:transcripts'), protocol.indexOf('<!-- END GENERATED agent-protocol:transcripts'));
    expect(region.length).toBeGreaterThan(1000);
    expect(region).not.toContain('{{next}}');
    expect(region).not.toContain('{{DOCS_BASE}}');
  });
});

describe('entry points link the protocol page', () => {
  const entryPoints = [
    'AGENTS.md',
    'INSTALL_FOR_AGENTS.md',
    'llms.txt',
    'docs/guides/troubleshooting.md',
    'docs/GBRAIN_VERIFY.md',
    'docs/mcp/README.md',
    'docs/guides/error-codes.md',
    'docs/guides/exit-codes.md',
  ];
  for (const rel of entryPoints) {
    test(rel, () => {
      expect(readFileSync(join(ROOT, rel), 'utf8')).toContain('AGENT_OPERATOR_v1.md');
    });
  }
});
