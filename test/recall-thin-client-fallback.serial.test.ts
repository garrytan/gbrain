/**
 * #4720 — thin-client mirror of the recall entity→text fallback.
 *
 * On a `gbrain init --mcp-only` install, `gbrain recall <term>` calls the
 * remote `recall` tool. When the entity arm comes back empty for a bare
 * positional, the CLI retries ONCE as a fact-text grep over the wire:
 *   - the second call carries `grep: <term lowercased>` and NO `entity`;
 *   - every other param — including `source_id` — is preserved;
 *   - when the first call returns rows there is no second call.
 *
 * Serial file: mock.module patches live bindings process-wide (config.ts
 * isThinClient → true; mcp-client.ts callRemoteTool → scripted), so this file
 * gets its own bun process via the *.serial.test.ts lane.
 */

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Hermetic config home: loadConfig() must not read the machine's ~/.gbrain.
const home = mkdtempSync(join(tmpdir(), 'gbrain-recall-thin-home-'));
mkdirSync(join(home, '.gbrain'), { recursive: true });
writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite' }));
process.env.GBRAIN_HOME = home;
delete process.env.GBRAIN_SOURCE;

type Call = { name: string; params: Record<string, unknown> };
const calls: Call[] = [];
// Scripted responses, consumed in order by callRemoteTool.
const scripted: Array<{ facts: Array<Record<string, unknown>>; total: number }> = [];

const realConfig = await import('../src/core/config.ts');
mock.module('../src/core/config.ts', () => ({
  ...realConfig,
  isThinClient: () => true,
}));

const realMcpClient = await import('../src/core/mcp-client.ts');
mock.module('../src/core/mcp-client.ts', () => ({
  ...realMcpClient,
  callRemoteTool: async (_cfg: unknown, name: string, params: Record<string, unknown>) => {
    calls.push({ name, params });
    const body = scripted.shift() ?? { facts: [], total: 0 };
    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
  },
}));

const { runRecall } = await import('../src/commands/recall.ts');

function fact(id: number, text: string, entity: string | null = null): Record<string, unknown> {
  return {
    id, fact: text, kind: 'fact', entity_slug: entity, visibility: 'private', notability: 'medium',
    valid_from: '2026-01-01T00:00:00.000Z', valid_until: null, expired_at: null, superseded_by: null,
    consolidated_at: null, consolidated_into: null, source: 'chat', source_session: null,
    confidence: 0.5, created_at: '2026-01-01T00:00:00.000Z',
  };
}

async function captureRecall(args: string[]): Promise<{ stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout += chunk.toString(); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += chunk.toString(); return true; }) as typeof process.stderr.write;
  try {
    // Thin client: the engine is never touched.
    await runRecall({} as never, args);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { stdout, stderr };
}

beforeEach(() => {
  calls.length = 0;
  scripted.length = 0;
});

describe('#4720 thin-client recall entity→text fallback', () => {
  test('entity miss → second call with grep set, entity dropped, source_id preserved', async () => {
    scripted.push({ facts: [], total: 0 });
    scripted.push({ facts: [fact(7, 'The style guide forbids Commas before conjunctions.', 'people/example')], total: 1 });

    const { stdout, stderr } = await captureRecall(['Commas', '--source', 'wiki', '--json']);

    expect(calls.length).toBe(2);
    expect(calls[0].name).toBe('recall');
    expect(calls[0].params.entity).toBe('Commas');
    expect(calls[0].params.grep).toBeUndefined();
    expect(calls[0].params.source_id).toBe('wiki');

    // The retry: same call shape minus `entity`, plus the lowercased grep.
    expect(calls[1].name).toBe('recall');
    expect(calls[1].params.entity).toBeUndefined();
    expect(calls[1].params.grep).toBe('commas');
    expect(calls[1].params.source_id).toBe('wiki');
    expect(calls[1].params.limit).toBe(calls[0].params.limit);
    expect(calls[1].params.include_expired).toBe(calls[0].params.include_expired);

    const payload = JSON.parse(stdout);
    expect(payload.total).toBe(1);
    expect(payload.facts[0].id).toBe(7);
    expect(stderr).toContain("no facts for entity 'Commas'");
  });

  test('entity hit → exactly one remote call, no fallback note', async () => {
    scripted.push({ facts: [fact(3, 'Prefers dark roast.', 'people/example')], total: 1 });

    const { stdout, stderr } = await captureRecall(['people/example', '--json']);

    expect(calls.length).toBe(1);
    expect(calls[0].params.entity).toBe('people/example');
    // Default source: the CLI omits source_id entirely on the wire.
    expect(calls[0].params.source_id).toBeUndefined();
    expect(JSON.parse(stdout).total).toBe(1);
    expect(stderr).not.toContain('matched');
  });

  test('explicit --grep alongside the positional suppresses the second call', async () => {
    scripted.push({ facts: [], total: 0 });

    const { stdout } = await captureRecall(['commas', '--grep', 'semicolons', '--json']);

    expect(calls.length).toBe(1);
    expect(calls[0].params.grep).toBe('semicolons');
    expect(JSON.parse(stdout).total).toBe(0);
  });
});
